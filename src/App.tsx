import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Compass, RefreshCw, Menu, Edit3, Network, Folder, Trash2, FolderPlus, Copy, ArrowRight, ChevronDown, PanelLeft, Settings, Download, Paperclip, AlertTriangle } from 'lucide-react';
import JSZip from 'jszip';
import {
  validateRepository, checkVaultCompatibility, initializeVault,
  fetchRepositoryTree, fetchFileContent, commitFileContent, deleteFile, syncVault,
  commitAttachment, fetchBinaryFileContent, isTextFile, isBinaryBytes, registerDetectedTextFile, safeB64Decode, checkApiRateLimit
} from './services/github';
import type { VaultFile } from './services/github';
import {
  saveTokenSecurely, retrieveTokenSecurely, purgeCredentials, STORAGE_KEYS,
  encryptToken, decryptToken, getOrCreateSystemVaultPassphrase
} from './utils/crypto';
import type { StorageMode } from './utils/crypto';
import { Editor } from './components/Editor';
import { textExtensions } from './utils/textExtensions';
import { GraphView } from './components/GraphView';
import { CanvasView } from './components/CanvasView';
import { BaseEditor } from './components/BaseEditor';
import { offlineStorage } from './services/offlineStorage';
import { ConflictResolutionModal } from './components/ConflictResolutionModal';
import { SearchModal } from './components/SearchModal';

// Split modular components
import { AuthScreen } from './components/AuthScreen';
import { LockScreen } from './components/LockScreen';
import { InitVaultScreen } from './components/InitVaultScreen';
import { Sidebar } from './components/Sidebar';
import { cn } from './utils/cn';
import { resolveVaultFilePath } from './utils/pathResolver';
import { buildFolderTree, type TreeFolder, type TreeFile } from './utils/folderTree';
import { getLocalFile, saveLocalFile, deleteLocalFile, getAllLocalFilePaths, initStorageCrypto, setStoragePassphrase, clearStoragePassphrase, clearAllLocalFiles, clearStorageCrypto } from './services/storage';

// Initialize offline storage crypto callbacks to avoid circular dependencies
offlineStorage.initCrypto(encryptToken, decryptToken);
initStorageCrypto(encryptToken, decryptToken);

export interface StarfishSettings {
  attachmentsFolder: string;
  maxAttachmentSize: number; // MB
  graphNodeGravity: number;
  graphRepulsionStrength: number;
  graphSpringLength: number;
}

const DEFAULT_SETTINGS: StarfishSettings = {
  attachmentsFolder: 'attachments',
  maxAttachmentSize: 5, // MB
  graphNodeGravity: 0.02,
  graphRepulsionStrength: 180,
  graphSpringLength: 120
};

function base64ToBlob(base64: string, mimeType: string = 'application/octet-stream'): Blob {
  const byteCharacters = atob(base64.replace(/\s/g, ''));
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimeType });
}

const getUnsyncedFiles = (): string[] => {
  try {
    const saved = localStorage.getItem('starfishnotes_unsynced_files');
    return saved ? JSON.parse(saved) : [];
  } catch {
    return [];
  }
};

const addUnsyncedFile = (path: string) => {
  const list = getUnsyncedFiles();
  if (!list.includes(path)) {
    list.push(path);
    localStorage.setItem('starfishnotes_unsynced_files', JSON.stringify(list));
  }
};

const removeUnsyncedFile = (path: string) => {
  const list = getUnsyncedFiles().filter(p => p !== path);
  localStorage.setItem('starfishnotes_unsynced_files', JSON.stringify(list));
};

export default function App() {
  // Connection and Authentication State
  const [isOffline, setIsOffline] = useState<boolean>(() => {
    return localStorage.getItem('starfishnotes-is-offline') === 'true';
  });
  const [isNetworkOffline, setIsNetworkOffline] = useState<boolean>(!navigator.onLine);
  const [showConflictModal, setShowConflictModal] = useState<boolean>(false);
  const [conflictingFiles, setConflictingFiles] = useState<VaultFile[]>([]);
  const [activeFileHasRemoteUpdate, setActiveFileHasRemoteUpdate] = useState<boolean>(false);
  const [apiLimitReached, setApiLimitReached] = useState<boolean>(false);
  const [apiLimitResetTime, setApiLimitResetTime] = useState<Date | null>(null);
  const [isSyncPaused, setIsSyncPaused] = useState<boolean>(false);
  const lastActiveTimeRef = useRef<number>(0);
  const [authMode, setAuthMode] = useState<'github' | 'local'>(() => {
    return localStorage.getItem('starfishnotes-is-offline') === 'true' ? 'local' : 'github';
  });
  const [isPersistentStorage, setIsPersistentStorage] = useState(false);

  useEffect(() => {
    if (navigator.storage && navigator.storage.persisted) {
      navigator.storage.persisted().then(persisted => {
        setIsPersistentStorage(persisted);
      });
    }
  }, []);

  const requestPersistentStorage = async (): Promise<boolean> => {
    if (navigator.storage && navigator.storage.persist) {
      try {
        const persisted = await navigator.storage.persist();
        setIsPersistentStorage(persisted);
        return persisted;
      } catch (e) {
        console.error('Failed to request persistent storage:', e);
        return false;
      }
    }
    return false;
  };
  const [githubToken, setGithubToken] = useState('');
  const [repoName, setRepoName] = useState('');
  const [branchName, setBranchName] = useState('main');
  const [storageMode, setStorageMode] = useState<StorageMode>('session');
  const [masterPassphrase, setMasterPassphrase] = useState('');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [authError, setAuthError] = useState('');

  // Lockscreen (for encrypted storage upon fresh session)
  const [showLockScreen, setShowLockScreen] = useState(false);
  const [unlockPassphrase, setUnlockPassphrase] = useState('');
  const [unlockError, setUnlockError] = useState('');

  // Global settings modal state
  const [showSettingsModal, setShowSettingsModal] = useState(false);

  // Synchronize masterPassphrase with storage encryption passphrase
  useEffect(() => {
    if (masterPassphrase) {
      setStoragePassphrase(masterPassphrase);
    } else {
      clearStoragePassphrase();
    }
  }, [masterPassphrase]);

  // Keep track of ghost note paths that failed to be created to prevent infinite request loops
  const failedGhostNotesRef = React.useRef<Set<string>>(new Set());

  // Global premium toast error notification system (replaces blocking alerts)
  const [globalError, setGlobalError] = useState('');

  // Settings State & Storage sync
  const [settings, setSettings] = useState<StarfishSettings>(() => {
    try {
      const saved = localStorage.getItem('starfishnotes-settings');
      if (saved) {
        const parsed = JSON.parse(saved);
        return {
          attachmentsFolder: parsed.attachmentsFolder ?? 'attachments',
          maxAttachmentSize: Math.min(parsed.maxAttachmentSize ?? 5, 25),
          graphNodeGravity: parsed.graphNodeGravity ?? 0.02,
          graphRepulsionStrength: parsed.graphRepulsionStrength ?? 180,
          graphSpringLength: parsed.graphSpringLength ?? 120
        };
      }
    } catch (e) {
      console.error('Failed to load settings:', e);
    }
    return DEFAULT_SETTINGS;
  });

  const updateSettings = useCallback((newSettings: Partial<StarfishSettings>) => {
    setSettings(prev => {
      const updated = { ...prev, ...newSettings };
      if (updated.maxAttachmentSize > 25) {
        updated.maxAttachmentSize = 25;
      }
      localStorage.setItem('starfishnotes-settings', JSON.stringify(updated));
      return updated;
    });
  }, []);

  // Vault Compatibility State
  const [isVaultChecked, setIsVaultChecked] = useState(false);
  const [isVaultCompatible, setIsVaultCompatible] = useState(false);
  const [isInitializing, setIsInitializing] = useState(false);
  const [isRepoEmpty, setIsRepoEmpty] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);

  // Sidebar Resizing & Collapse States
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    const saved = localStorage.getItem('starfishnotes-sidebar-width');
    return saved ? parseInt(saved, 10) : 260;
  });
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState<boolean>(() => {
    const saved = localStorage.getItem('starfishnotes-sidebar-collapsed');
    return saved === 'true';
  });
  const [isResizingSidebar, setIsResizingSidebar] = useState<boolean>(false);

  const handleSetSidebarWidth = (w: number) => {
    setSidebarWidth(w);
    localStorage.setItem('starfishnotes-sidebar-width', w.toString());
  };

  const handleSetSidebarCollapsed = (collapsed: boolean) => {
    setIsSidebarCollapsed(collapsed);
    localStorage.setItem('starfishnotes-sidebar-collapsed', collapsed.toString());
  };

  // Folder, Move, and Copy States
  const [showCreateFolderModal, setShowCreateFolderModal] = useState(false);
  const [parentFolderPathForNewFolder, setParentFolderPathForNewFolder] = useState<string | null>(null);
  const [newFolderName, setNewFolderName] = useState('');
  const [folderCreationError, setFolderCreationError] = useState('');

  const [pendingMoveCopyFile, setPendingMoveCopyFile] = useState<VaultFile | null>(null);
  const [moveCopyAction, setMoveCopyAction] = useState<'move' | 'copy'>('copy');
  const [moveCopyNameInput, setMoveCopyNameInput] = useState('');
  const [moveCopyFolderSelect, setMoveCopyFolderSelect] = useState('/');
  const [isMoveCopyFolderDropdownOpen, setIsMoveCopyFolderDropdownOpen] = useState(false);
  const [moveCopyFolderSearch, setMoveCopyFolderSearch] = useState('');
  const [moveCopyError, setMoveCopyError] = useState('');
  const [pendingDeleteFolder, setPendingDeleteFolder] = useState<string | null>(null);
  
  // Folder operation states for rename/move/copy
  const [pendingRenameFolder, setPendingRenameFolder] = useState<string | null>(null);
  const [folderRenameInputValue, setFolderRenameInputValue] = useState('');
  const [folderRenameError, setFolderRenameError] = useState('');
  const [pendingMoveCopyFolder, setPendingMoveCopyFolder] = useState<string | null>(null);
  const [folderMoveCopyAction, setFolderMoveCopyAction] = useState<'move' | 'copy'>('copy');
  const [folderMoveCopyNameInput, setFolderMoveCopyNameInput] = useState('');
  const [folderMoveCopyDestFolder, setFolderMoveCopyDestFolder] = useState('/');
  const [isFolderMoveCopyDestDropdownOpen, setIsFolderMoveCopyDestDropdownOpen] = useState(false);
  const [folderMoveCopyDestSearch, setFolderMoveCopyDestSearch] = useState('');
  const [folderMoveCopyError, setFolderMoveCopyError] = useState('');

  // File system State
  const [files, setFilesRaw] = useState<VaultFile[]>([]);
  const setFiles = useCallback((val: VaultFile[] | ((prev: VaultFile[]) => VaultFile[])) => {
    setFilesRaw(prev => {
      const resolved = typeof val === 'function' ? val(prev) : val;
      const seen = new Set<string>();
      return resolved.filter(f => {
        if (!f || !f.path) return false;
        if (seen.has(f.path)) return false;
        seen.add(f.path);
        return true;
      });
    });
  }, []);
  const [fileContents, setFileContents] = useState<Record<string, string>>({}); // path -> text
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [activeFileTargetLine, setActiveFileTargetLine] = useState<number | undefined>(undefined);
  const [detectedTextFiles, setDetectedTextFiles] = useState<Record<string, boolean>>({}); // path -> isText

  const handleOpenNote = useCallback((path: string | null) => {
    setActiveFileTargetLine(undefined); // Reset target line on normal open
    if (!path) {
      setActiveFilePath(null);
      setActiveFileHasRemoteUpdate(false);
      return;
    }
    const resolvedPath = resolveVaultFilePath(files, path);
    setActiveFilePath(resolvedPath);

    // Check if this newly opened file has remote updates
    (async () => {
      const remoteFile = files.find(f => f.path === resolvedPath);
      const localFile = await getLocalFile(resolvedPath);
      if (remoteFile && localFile && localFile.sha !== remoteFile.sha) {
        setActiveFileHasRemoteUpdate(true);
      } else {
        setActiveFileHasRemoteUpdate(false);
      }
    })();
  }, [files, setActiveFileHasRemoteUpdate]);

  const handleOpenNoteWithLine = useCallback((path: string | null, lineIndex?: number) => {
    handleOpenNote(path);
    setActiveFileTargetLine(lineIndex);
  }, [handleOpenNote]);
  const [isLoadingTree, setIsLoadingTree] = useState(false);
  const [isLoadingFile, setIsLoadingFile] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [vaultImages, setVaultImages] = useState<Record<string, string>>({});

  // View state switcher: 'workspace' | 'graph'
  const [viewTab, setViewTab] = useState<'workspace' | 'graph'>('workspace');

  // Prefetching States
  const [prefetchStatus, setPrefetchStatus] = useState<'idle' | 'fetching' | 'success' | 'error'>('idle');
  const [prefetchProgress, setPrefetchProgress] = useState({ loaded: 0, total: 0 });

  // Publish to GitHub (Offline mode) States
  const [publishToken, setPublishToken] = useState('');
  const [publishRepo, setPublishRepo] = useState('');
  const [publishBranch, setPublishBranch] = useState('main');
  const [publishStatus, setPublishStatus] = useState<string | null>(null);
  const [publishError, setPublishError] = useState<string | null>(null);

  // Modal States
  const [pendingDeleteFile, setPendingDeleteFile] = useState<{ path: string, sha: string } | null>(null);
  const [pendingRenameFile, setPendingRenameFile] = useState<{ path: string, name: string, sha: string } | null>(null);
  const [renameInputValue, setRenameInputValue] = useState('');
  const [renameError, setRenameError] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);

  // Stable handlers declared before checkSession mount hook to prevent Temporal Dead Zone (TDZ)

  const preloadAllFilesContents = useCallback(async (vaultFiles: VaultFile[]) => {
    try {
      const contents: Record<string, string> = {};
      await Promise.all(vaultFiles.map(async (file) => {
        if (isTextFile(file.path) || file.path.endsWith('.canvas')) {
          if (isOffline) {
            const stored = await offlineStorage.getFile(file.path);
            if (stored) {
              let text = stored.content;
              if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
                const activeKey = masterPassphrase;
                if (activeKey) {
                  try {
                    text = await decryptToken(stored.content, activeKey);
                  } catch {
                    // ignore decryption errors for incomplete lockscreen transitions
                  }
                }
              }
              if (stored.type === 'blob') {
                try {
                  text = safeB64Decode(text);
                } catch {
                  // fallback
                }
              }
              contents[file.path] = text;
            }
          } else {
            const cached = await getLocalFile(file.path);
            if (cached) {
              contents[file.path] = cached.content;
            }
          }
        }
      }));
      setFileContents(prev => ({ ...prev, ...contents }));
    } catch (e) {
      console.error('Failed to background preload files contents:', e);
    }
  }, [isOffline, storageMode, masterPassphrase]);

  const preloadAllVaultFiles = useCallback(async () => {
    // Only prefetch text and canvas files
    const targets = files.filter(f => isTextFile(f.path) || f.path.endsWith('.canvas'));
    const toFetch = targets.filter(f => fileContents[f.path] === undefined);

    if (toFetch.length === 0) {
      setPrefetchStatus('success');
      setPrefetchProgress({ loaded: targets.length, total: targets.length });
      setTimeout(() => {
        // Only reset to idle if still in success state (not if user started another prefetch)
        setPrefetchStatus(prevStatus => prevStatus === 'success' ? 'idle' : prevStatus);
      }, 3000);
      return;
    }

    setPrefetchStatus('fetching');
    setPrefetchProgress({ loaded: targets.length - toFetch.length, total: targets.length });

    let loadedCount = targets.length - toFetch.length;
    let hasError = false;

    // Concurrency queue
    let index = 0;
    const concurrency = 5;

    const worker = async () => {
      while (index < toFetch.length) {
        const currentIdx = index++;
        if (currentIdx >= toFetch.length) break;
        const file = toFetch[currentIdx];
        try {
          if (isOffline) {
            const stored = await offlineStorage.getFile(file.path);
            if (stored) {
              let text = stored.content;
              if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
                const activeKey = masterPassphrase;
                if (activeKey) {
                  try {
                    text = await decryptToken(stored.content, activeKey);
                  } catch {
                    // Ignore decryption error - use stored content as-is
                  }
                }
              }
              setFileContents(prev => ({ ...prev, [file.path]: text }));
            }
          } else {
            const content = await fetchFileContent(githubToken, repoName, file.path, file.sha);
            setFileContents(prev => ({ ...prev, [file.path]: content }));
          }
        } catch (err) {
          console.error(`Failed to background prefetch ${file.path}:`, err);
          hasError = true;
        } finally {
          loadedCount++;
          setPrefetchProgress({ loaded: loadedCount, total: targets.length });
        }
      }
    };

    try {
      const workers = [];
      for (let i = 0; i < Math.min(concurrency, toFetch.length); i++) {
        workers.push(worker());
      }
      await Promise.all(workers);

      // Check if status is still 'fetching' before updating (user might have started another fetch)
      setPrefetchStatus(prevStatus => {
        if (prevStatus !== 'fetching') return prevStatus;
        return hasError ? 'error' : 'success';
      });

      setTimeout(() => {
        setPrefetchStatus(prevStatus => {
          // Only reset to idle if still in success/error state
          return (prevStatus === 'success' || prevStatus === 'error') ? 'idle' : prevStatus;
        });
      }, 3000);
    } catch (e) {
      console.error('Prefetch all failed:', e);
      setPrefetchStatus(prevStatus => prevStatus === 'fetching' ? 'error' : prevStatus);
    }
  }, [files, fileContents, isOffline, storageMode, masterPassphrase, githubToken, repoName]);

  const refreshFilesOffline = useCallback(async () => {
    setIsLoadingTree(true);
    try {
      const offlineFiles = await offlineStorage.getFilesList();

      const mappedFiles: VaultFile[] = offlineFiles.map(f => ({
        path: f.path,
        name: f.name,
        type: 'blob',
        sha: f.sha,
        size: f.size
      }));

      setFiles(mappedFiles);
      preloadAllFilesContents(mappedFiles);

      if (mappedFiles.length > 0 && !activeFilePath) {
        const defaultNote = mappedFiles.find(f => f.name === 'Welcome.md') || mappedFiles[0];
        setActiveFilePath(defaultNote.path);
      }
    } catch (e) {
      console.error('Failed to load local offline files tree:', e);
    } finally {
      setIsLoadingTree(false);
    }
  }, [activeFilePath, preloadAllFilesContents, setFiles]);

  const loadFileContentOffline = useCallback(async (path: string, providedKey?: string) => {
    if (fileContents[path] !== undefined) return;
    setIsLoadingFile(true);
    try {
      const file = await offlineStorage.getFile(path);
      if (file) {
        let text = file.content;
        const mode = storageMode;
        if (mode === 'encrypted' || mode === 'keychain' || mode === 'plain') {
          const decryptionKey = providedKey || masterPassphrase;
          if (decryptionKey) {
            text = await decryptToken(file.content, decryptionKey);
          }
        }
        if (file.type === 'blob') {
          try {
            text = safeB64Decode(text);
          } catch {
            // fallback
          }
        }
        setFileContents(prev => ({
          ...prev,
          [path]: text
        }));
      }
    } catch (e) {
      console.error('Failed to load offline file content:', e);
    } finally {
      setIsLoadingFile(false);
    }
  }, [fileContents, storageMode, masterPassphrase]);

  const preloadFileContentOffline = useCallback(async (path: string, providedKey?: string) => {
    if (!path || fileContents[path] !== undefined) return;
    try {
      const file = await offlineStorage.getFile(path);
      if (file) {
        let text = file.content;
        const mode = storageMode;
        if (mode === 'encrypted' || mode === 'keychain' || mode === 'plain') {
          const decryptionKey = providedKey || masterPassphrase;
          if (decryptionKey) {
            text = await decryptToken(file.content, decryptionKey);
          }
        }
        if (file.type === 'blob') {
          try {
            text = safeB64Decode(text);
          } catch {
            // fallback
          }
        }
        setFileContents(prev => ({
          ...prev,
          [path]: text
        }));
      }
    } catch (e) {
      console.error('Failed to preload offline file content:', e);
    }
  }, [fileContents, storageMode, masterPassphrase]);

  const loadBinaryFileOffline = useCallback(async (path: string, providedKey?: string) => {
    if (!path || vaultImages[path]) return;
    try {
      const file = await offlineStorage.getFile(path);
      if (file) {
        let base64 = file.content;
        const mode = storageMode;
        if (mode === 'encrypted' || mode === 'keychain' || mode === 'plain') {
          const decryptionKey = providedKey || masterPassphrase;
          if (decryptionKey) {
            base64 = await decryptToken(file.content, decryptionKey);
          }
        }

        const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
        let mime = 'application/octet-stream';
        if (ext === '.png') mime = 'image/png';
        else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
        else if (ext === '.webp') mime = 'image/webp';
        else if (ext === '.gif') mime = 'image/gif';
        else if (ext === '.svg') mime = 'image/svg+xml';
        else if (ext === '.pdf') mime = 'application/pdf';

        const fileUrl = ext === '.pdf'
          ? URL.createObjectURL(base64ToBlob(base64, mime))
          : `data:${mime};base64,${base64}`;
        setVaultImages(prev => ({
          ...prev,
          [path]: fileUrl
        }));
      }
    } catch (e) {
      console.error('Failed to load binary offline file:', e);
    }
  }, [vaultImages, storageMode, masterPassphrase]);

  const uploadAttachmentOffline = async (file: File, folderPath?: string, shouldNavigate: boolean = true): Promise<{ path: string; name: string }> => {
    const maxOfflineSize = 10 * 1024 * 1024;
    if (file.size > maxOfflineSize) {
      const errorMsg = 'Attachment exceeds the strict 10MB size limit for offline vault uploads.';
      setGlobalError(errorMsg);
      throw new Error(errorMsg);
    }

    const finalFolder = folderPath !== undefined ? folderPath : settings.attachmentsFolder;
    const parentPath = finalFolder && finalFolder !== '/'
      ? (finalFolder.endsWith('/') ? finalFolder : `${finalFolder}/`)
      : '';

    const finalPath = `${parentPath}${file.name}`;

    let finalPathResolved = finalPath;
    let counter = 1;
    const dotIndex = file.name.lastIndexOf('.');
    const baseName = dotIndex !== -1 ? file.name.substring(0, dotIndex) : file.name;
    const ext = dotIndex !== -1 ? file.name.substring(dotIndex) : '';

    while (files.some(f => f.path === finalPathResolved)) {
      finalPathResolved = `${parentPath}${baseName}-${counter}${ext}`;
      counter++;
    }

    try {
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const res = reader.result as string;
          resolve(res.split(',')[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const isText = isTextFile(finalPathResolved);
      let contentToSave = base64;
      let fileType: 'text' | 'blob' = 'blob';

      if (isText) {
        try {
          contentToSave = safeB64Decode(base64);
          fileType = 'text';
        } catch {
          // fallback
        }
      }

      let savedContent = contentToSave;
      const mode = storageMode;
      if (mode === 'encrypted' || mode === 'keychain' || mode === 'plain') {
        if (masterPassphrase) {
          savedContent = await encryptToken(contentToSave, masterPassphrase);
        }
      }

      const sha = 'offline-sha-' + Date.now();
      await offlineStorage.saveFile({
        path: finalPathResolved,
        name: finalPathResolved.split('/').pop() || file.name,
        type: fileType,
        content: savedContent,
        size: file.size,
        sha
      });

      if (isText) {
        setFileContents(prev => ({
          ...prev,
          [finalPathResolved]: contentToSave
        }));
      } else {
        const mime = file.type || 'application/octet-stream';
        const dataUrl = `data:${mime};base64,${base64}`;
        setVaultImages(prev => ({
          ...prev,
          [finalPathResolved]: dataUrl
        }));
      }

      const newFile: VaultFile = {
        path: finalPathResolved,
        name: finalPathResolved.split('/').pop() || file.name,
        type: 'blob',
        sha,
        size: file.size
      };

      setFiles(prev => [newFile, ...prev]);
      if (shouldNavigate) {
        setActiveFilePath(finalPathResolved);
      }
      return { path: finalPathResolved, name: newFile.name };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to upload attachment offline.';
      setGlobalError(msg);
      throw e;
    }
  };

  const handleSaveFileOffline = useCallback(async (path: string, content: string) => {
    let savedContent = content;
    const mode = storageMode;
    if (mode === 'encrypted' || mode === 'keychain' || mode === 'plain') {
      if (masterPassphrase) {
        savedContent = await encryptToken(content, masterPassphrase);
      }
    }

    const sha = 'offline-sha-' + Date.now();
    await offlineStorage.saveFile({
      path,
      name: path.split('/').pop() || path,
      type: 'text',
      content: savedContent,
      size: content.length,
      sha
    });

    setFileContents(prev => ({
      ...prev,
      [path]: content
    }));

    setFiles(prev => prev.map(f => {
      if (f.path === path) {
        return { ...f, sha };
      }
      return f;
    }));

    return { sha };
  }, [storageMode, masterPassphrase, setFileContents, setFiles]);

  const createNewFileOffline = async (extension: '.md' | '.txt' | '.canvas' | '.base', folderPath?: string) => {
    if (isLoadingFile) return;

    const isText = extension === '.md' || extension === '.txt';
    const baseName = extension === '.canvas' ? 'Untitled Board' : extension === '.base' ? 'Untitled Base' : 'Untitled Note';

    const parentPath = folderPath && folderPath !== '/'
      ? (folderPath.endsWith('/') ? folderPath : `${folderPath}/`)
      : '';

    let finalPath = `${parentPath}${baseName}${extension}`;
    let counter = 1;

    while (files.some(f => f.path === finalPath)) {
      finalPath = `${parentPath}${baseName} ${counter}${extension}`;
      counter++;
    }

    setIsLoadingFile(true);
    try {
      const cleanFileName = finalPath.split('/').pop() || finalPath;
      const initialText = isText
        ? ''
        : extension === '.canvas'
          ? JSON.stringify({ nodes: [], edges: [] }, null, 2)
          : `version: 1\nsource:\n  folder: ""\nviews:\n  - id: view_table_1\n    name: "All Active Projects"\n    type: table\n    columns:\n      - property: file.name\n        visible: true\n        width: 200\n`;

      let savedContent = initialText;
      const mode = storageMode;
      if (mode === 'encrypted' || mode === 'keychain' || mode === 'plain') {
        if (masterPassphrase) {
          savedContent = await encryptToken(initialText, masterPassphrase);
        }
      }

      const sha = 'offline-sha-' + Date.now();
      await offlineStorage.saveFile({
        path: finalPath,
        name: cleanFileName,
        type: 'text',
        content: savedContent,
        size: initialText.length,
        sha
      });

      const newFile: VaultFile = {
        path: finalPath,
        name: cleanFileName,
        type: 'blob',
        sha,
        size: initialText.length
      };

      setFiles(prev => [newFile, ...prev]);
      setFileContents(prev => ({ ...prev, [finalPath]: initialText }));
      setActiveFilePath(finalPath);
      setViewTab('workspace');
    } catch (e) {
      console.error('Failed to create file offline:', e);
    } finally {
      setIsLoadingFile(false);
    }
  };

  const handleConfirmDeleteOffline = async () => {
    if (!pendingDeleteFile) return;
    const { path } = pendingDeleteFile;
    setPendingDeleteFile(null);
    setIsLoadingFile(true);
    try {
      await offlineStorage.deleteFile(path);
      const gitkeepFile = await ensureGitkeepForEmptyParent(path, files);
      setFiles(prev => {
        const filtered = prev.filter(f => f.path !== path);
        return gitkeepFile ? [gitkeepFile, ...filtered] : filtered;
      });
      setFileContents(prev => {
        const updated = { ...prev };
        delete updated[path];
        return updated;
      });
      if (activeFilePath === path) {
        setActiveFilePath(null);
      }
    } catch (e) {
      console.error('Failed to delete file offline:', e);
    } finally {
      setIsLoadingFile(false);
    }
  };

  const handleConnectOffline = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsConnecting(true);
    setAuthError('');

    try {
      let activeKey = '';
      if (storageMode === 'encrypted') {
        if (!masterPassphrase) {
          throw new Error('An encryption passphrase is required for Encrypted Storage mode.');
        }
        activeKey = masterPassphrase;
      } else if (storageMode === 'keychain') {
        const id = masterPassphrase || 'vault_local';
        if (!('PasswordCredential' in window)) {
          throw new Error('OS Protected Storage is not supported by this browser.');
        }
        let seed = '';
        try {
          const credential = await navigator.credentials.get({
            password: true,
            unmediated: false
          } as unknown as CredentialRequestOptions);
          if (credential) {
            seed = (credential as unknown as { password?: string }).password || '';
          }
        } catch (err) {
          console.warn('Silent credentials fetch failed', err);
        }

        if (!seed) {
          const hasVerification = await offlineStorage.getMeta<string>('vault_verification');
          if (hasVerification) {
            const credential = await navigator.credentials.get({
              password: true,
              mediation: 'required'
            } as unknown as CredentialRequestOptions);
            if (credential) {
              seed = (credential as unknown as { password?: string }).password || '';
            }
            if (!seed) {
              throw new Error('Keychain retrieval failed or cancelled. Authentication is required to unlock.');
            }
          } else {
            const randomBytes = window.crypto.getRandomValues(new Uint8Array(32));
            seed = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
            const PasswordCred = (window as unknown as { PasswordCredential: new (options: { id: string; password: string; name: string }) => Credential }).PasswordCredential;
            const credential = new PasswordCred({
              id,
              password: seed,
              name: 'Starfish Notes Local Offline Vault'
            });
            await navigator.credentials.store(credential);
          }
        }
        activeKey = seed;
      } else if (storageMode === 'plain') {
        activeKey = await getOrCreateSystemVaultPassphrase();
      }

      const verification = await offlineStorage.getMeta<string>('vault_verification');
      if (verification) {
        if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
          try {
            const dec = await decryptToken(verification, activeKey);
            if (dec !== 'Welcome') {
              throw new Error('Invalid passphrase');
            }
          } catch {
            throw new Error('Incorrect passphrase or keychain seed. Vault verification failed.');
          }
        }
      } else {
        if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
          const enc = await encryptToken('Welcome', activeKey);
          await offlineStorage.saveMeta('vault_verification', enc);
        }
        const offlineFiles = await offlineStorage.getFilesList();
        if (offlineFiles.length === 0) {
          const welcomeContent = '';
          let welcomeContentToSave = welcomeContent;
          if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
            welcomeContentToSave = await encryptToken(welcomeContent, activeKey);
          }

          await offlineStorage.saveFile({
            path: 'Welcome.md',
            name: 'Welcome.md',
            type: 'text',
            content: welcomeContentToSave,
            size: welcomeContent.length,
            sha: 'offline-init-sha'
          });
        }
      }

      localStorage.setItem('starfishnotes-is-offline', 'true');
      localStorage.setItem(STORAGE_KEYS.STORAGE_MODE, storageMode);
      if (storageMode === 'session') {
        sessionStorage.setItem('starfishnotes_session_active', 'true');
      }
      setMasterPassphrase(activeKey);
      offlineStorage.setPassphrase(activeKey);
      setStoragePassphrase(activeKey);
      setIsOffline(true);
      setIsAuthenticated(true);
      setRepoName('Local Vault');
      setBranchName('offline');

      await refreshFilesOffline();

    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to unlock offline vault.';
      setAuthError(msg);
      setIsAuthenticated(false);
    } finally {
      setIsConnecting(false);
    }
  };

  const loadFilesFromLocalCache = useCallback(async () => {
    try {
      const localPaths = await getAllLocalFilePaths();
      const localTree: VaultFile[] = [];
      for (const p of localPaths) {
        const fileData = await getLocalFile(p);
        if (fileData) {
          localTree.push({
            path: p,
            name: p.split('/').pop() || p,
            type: 'blob',
            sha: fileData.sha
          });
        }
      }
      setFiles(localTree);
      await preloadAllFilesContents(localTree);

      if (localTree.length > 0 && !activeFilePath) {
        const defaultNote = localTree.find(f => f.name === 'Welcome.md') || localTree[0];
        setActiveFilePath(defaultNote.path);
      }
    } catch (e) {
      console.error('Failed to load local files from cache:', e);
    }
  }, [activeFilePath, preloadAllFilesContents, setFiles]);

  const refreshFiles = useCallback(async (
    token: string = githubToken,
    repo: string = repoName,
    branch: string = branchName,
    isIdleCheck: boolean = false
  ) => {
    if (isOffline) {
      await refreshFilesOffline();
      return;
    }
    setIsLoadingTree(true);
    try {
      let tree = await fetchRepositoryTree(token, repo, branch);
      setIsNetworkOffline(false);

      // Check and push unsynced files first, while detecting parallel edits conflicts
      const unsynced = getUnsyncedFiles();
      const transitionConflicts: VaultFile[] = [];
      const safeToPush: string[] = [];

      if (unsynced.length > 0) {
        console.log(`Checking ${unsynced.length} unsynced offline files for remote conflicts...`);
        for (const path of unsynced) {
          const cachedFile = await getLocalFile(path);
          if (cachedFile) {
            const fileInTree = tree.find(f => f.path === path);
            if (fileInTree) {
              // File exists on remote - check if remote SHA matches our local pre-edit SHA
              if (cachedFile.sha === 'offline-pending' || cachedFile.sha !== fileInTree.sha) {
                // Parallel edit conflict!
                transitionConflicts.push(fileInTree);
              } else {
                // No conflict, safe to auto-push
                safeToPush.push(path);
              }
            } else {
              // File does not exist on remote
              if (cachedFile.sha === 'offline-pending' || cachedFile.sha === 'offline-init-sha' || cachedFile.sha === '') {
                // Locally created new file, safe to push
                safeToPush.push(path);
              } else {
                // File deleted on remote in the interim - conflict
                const dummyFile: VaultFile = {
                  path,
                  name: path.split('/').pop() || path,
                  type: 'blob',
                  sha: 'remote-deleted'
                };
                transitionConflicts.push(dummyFile);
              }
            }
          }
        }

        // Push non-conflicting offline edits in the background
        if (safeToPush.length > 0) {
          console.log(`Auto-pushing ${safeToPush.length} non-conflicting offline edits...`);
          for (const path of safeToPush) {
            try {
              const cachedFile = await getLocalFile(path);
              if (cachedFile) {
                const fileInTree = tree.find(f => f.path === path);
                const shaToUse = fileInTree ? fileInTree.sha : null;
                const pushRes = await commitFileContent(
                  token,
                  repo,
                  branch,
                  path,
                  cachedFile.content,
                  shaToUse,
                  `sync offline edits for ${path}`
                );
                await saveLocalFile(path, { content: cachedFile.content, sha: pushRes.sha });
                removeUnsyncedFile(path);
                console.log(`Successfully auto-pushed ${path}`);
              }
            } catch (pushErr) {
              console.error(`Failed to auto-push ${path}:`, pushErr);
            }
          }
          // Refetch tree after pushing
          try {
            tree = await fetchRepositoryTree(token, repo, branch);
          } catch (treeErr) {
            console.error('Failed to refetch tree after auto-pushing offline edits:', treeErr);
          }
        }
      }

      // Process transition conflicts
      if (transitionConflicts.length > 0) {
        setConflictingFiles(prev => {
          const combined = [...prev];
          for (const f of transitionConflicts) {
            if (!combined.some(existing => existing.path === f.path)) {
              combined.push(f);
            }
          }
          return combined;
        });
        setShowConflictModal(true);
        setIsLoadingTree(false);
        return;
      }

      // Handle Idle Check Conflicts
      if (isIdleCheck) {
        const idleConflicts: VaultFile[] = [];
        for (const remoteFile of tree) {
          if (!isTextFile(remoteFile.path) && !remoteFile.path.endsWith('.canvas')) continue;

          const localFile = await getLocalFile(remoteFile.path);
          if (!localFile) {
            // Missing locally, remote has it
            idleConflicts.push(remoteFile);
          } else if (localFile.sha !== remoteFile.sha) {
            // Mismatching SHA (remote updated)
            idleConflicts.push(remoteFile);
          }
        }

        if (idleConflicts.length > 0) {
          console.log(`Idle check: found ${idleConflicts.length} conflicting remote updates.`);
          setConflictingFiles(prev => {
            const combined = [...prev];
            for (const f of idleConflicts) {
              if (!combined.some(existing => existing.path === f.path)) {
                combined.push(f);
              }
            }
            return combined;
          });
          setShowConflictModal(true);
          setIsLoadingTree(false);
          return;
        }
      }

      setFiles(tree);
      preloadAllFilesContents(tree);

      if (tree.length > 0 && !activeFilePath) {
        const defaultNote = tree.find(f => f.name === 'Welcome.md') || tree[0];
        setActiveFilePath(defaultNote.path);
      }

      // Check active file remote update status
      let activeHasRemoteUpdate = false;
      if (activeFilePath) {
        const activeFileInTree = tree.find(f => f.path === activeFilePath);
        const localActiveFile = await getLocalFile(activeFilePath);
        if (activeFileInTree && localActiveFile && localActiveFile.sha !== activeFileInTree.sha) {
          activeHasRemoteUpdate = true;
        }
      }
      setActiveFileHasRemoteUpdate(activeHasRemoteUpdate);

      // Collect skipped paths to prevent silent overwriting of active/unsynced files
      const skippedPaths = [...getUnsyncedFiles()];
      if (activeFilePath && !skippedPaths.includes(activeFilePath)) {
        skippedPaths.push(activeFilePath);
      }

      // Only sync if API limit hasn't been reached
      if (!isSyncPaused) {
        syncVault(token, repo, branch, tree, skippedPaths).then(() => {
          console.log("Vault sync complete!");
          preloadAllFilesContents(tree);
        }).catch(console.error);
      } else {
        console.log("GitHub API rate limit reached. Sync paused.");
      }
    } catch (err: unknown) {
      console.warn("Tree retrieval failed, checking if it is a network error...", err);
      const errMsg = err instanceof Error ? err.message : '';
      const isNetworkError = err instanceof TypeError || errMsg.includes('fetch') || errMsg.includes('Network') || errMsg.includes('Failed to fetch');

      if (isNetworkError) {
        setIsNetworkOffline(true);
        console.log("Network error detected. Falling back to local offline cache...");
        await loadFilesFromLocalCache();
      } else {
        console.error("Non-network error in refreshFiles:", err);
      }
    } finally {
      setIsLoadingTree(false);
    }
  }, [githubToken, repoName, branchName, isOffline, refreshFilesOffline, preloadAllFilesContents, loadFilesFromLocalCache, setFiles, activeFilePath, isSyncPaused]);

  const checkAndLoadVault = useCallback(async (token: string, repo: string, branch: string) => {
    try {
      const compat = await checkVaultCompatibility(token, repo, branch);
      setIsVaultChecked(true);

      if (compat.exists && compat.compatible) {
        setIsVaultCompatible(true);
        await refreshFiles(token, repo, branch);
      } else {
        setIsVaultCompatible(false);
      }
    } catch {
      setIsVaultCompatible(false);
    }
  }, [refreshFiles]);

  const autoConnect = useCallback(async (token: string, repo: string, branch: string) => {
    setIsConnecting(true);
    setAuthError('');
    try {
      const result = await validateRepository(token, repo, branch);
      setIsAuthenticated(true);
      if (result.isEmpty) {
        setIsRepoEmpty(true);
        setIsVaultChecked(true);
        setIsVaultCompatible(false);
      } else {
        setIsRepoEmpty(false);
        await checkAndLoadVault(token, repo, branch);
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? e.message : '';
      const isNetworkError = e instanceof TypeError || errMsg.includes('fetch') || errMsg.includes('Network') || errMsg.includes('Failed to fetch');

      if (isNetworkError) {
        console.log("Network error on auto-connect. Loading cached notes...");
        setIsNetworkOffline(true);
        setIsAuthenticated(true);
        setIsRepoEmpty(false);
        setIsVaultChecked(true);
        setIsVaultCompatible(true);
        await loadFilesFromLocalCache();
      } else {
        const msg = errMsg || 'Auto-connect failed. Please re-enter connection details.';
        setAuthError(msg);
        setIsAuthenticated(false);
        purgeCredentials();
      }
    } finally {
      setIsConnecting(false);
    }
  }, [checkAndLoadVault, loadFilesFromLocalCache]);

  const loadFileContent = useCallback(async (path: string, sha: string) => {
    if (isOffline) {
      await loadFileContentOffline(path);
      return;
    }
    if (fileContents[path] !== undefined) return;

    setIsLoadingFile(true);
    try {
      const content = await fetchFileContent(githubToken, repoName, path, sha);
      setFileContents(prev => ({
        ...prev,
        [path]: content,
      }));
    } catch {
      // Failed loading file content
    } finally {
      setIsLoadingFile(false);
    }
  }, [fileContents, githubToken, repoName, isOffline, loadFileContentOffline]);

  const preloadFileContent = useCallback(async (path: string, sha: string) => {
    if (isOffline) {
      await preloadFileContentOffline(path);
      return;
    }
    if (!path || fileContents[path] !== undefined) return;
    try {
      const content = await fetchFileContent(githubToken, repoName, path, sha);
      setFileContents(prev => ({
        ...prev,
        [path]: content,
      }));
    } catch (e) {
      console.error('Failed to preload file content:', e);
    }
  }, [fileContents, githubToken, repoName, isOffline, preloadFileContentOffline]);

  const loadBinaryFile = useCallback(async (path: string, sha: string) => {
    if (isOffline) {
      await loadBinaryFileOffline(path);
      return;
    }
    if (!path || !sha || vaultImages[path]) return;
    try {
      const base64 = await fetchBinaryFileContent(githubToken, repoName, sha);
      const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
      let mime = 'application/octet-stream';
      if (ext === '.png') mime = 'image/png';
      else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
      else if (ext === '.webp') mime = 'image/webp';
      else if (ext === '.gif') mime = 'image/gif';
      else if (ext === '.svg') mime = 'image/svg+xml';
      else if (ext === '.pdf') mime = 'application/pdf';

      const fileUrl = ext === '.pdf'
        ? URL.createObjectURL(base64ToBlob(base64, mime))
        : `data:${mime};base64,${base64}`;
      setVaultImages(prev => ({
        ...prev,
        [path]: fileUrl
      }));
    } catch (e) {
      console.error('Failed to load binary file:', e);
    }
  }, [vaultImages, githubToken, repoName, isOffline, loadBinaryFileOffline]);

  const loadUnknownFile = useCallback(async (path: string, sha: string) => {
    setIsLoadingFile(true);
    try {
      let base64 = '';
      if (isOffline) {
        const file = await offlineStorage.getFile(path);
        if (file) {
          base64 = file.content;
          const mode = storageMode;
          if (mode === 'encrypted' || mode === 'keychain' || mode === 'plain') {
            const decryptionKey = masterPassphrase;
            if (decryptionKey) {
              base64 = await decryptToken(file.content, decryptionKey);
            }
          }
        }
      } else {
        base64 = await fetchBinaryFileContent(githubToken, repoName, sha);
      }

      if (!base64) {
        setIsLoadingFile(false);
        return;
      }

      let isBinary = false;
      let isBase64 = true;
      try {
        const byteCharacters = atob(base64);
        const len = Math.min(byteCharacters.length, 1024);
        const bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) {
          bytes[i] = byteCharacters.charCodeAt(i);
        }
        isBinary = isBinaryBytes(bytes);
      } catch {
        // If atob fails, it means the content is not valid base64 (e.g. plain text).
        // Since binary files are always base64-encoded, this must be a text file.
        isBinary = false;
        isBase64 = false;
      }

      if (isBinary) {
        registerDetectedTextFile(path, false);
        setDetectedTextFiles(prev => ({ ...prev, [path]: false }));

        const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
        let mime = 'application/octet-stream';
        if (ext === '.png') mime = 'image/png';
        else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
        else if (ext === '.webp') mime = 'image/webp';
        else if (ext === '.gif') mime = 'image/gif';
        else if (ext === '.svg') mime = 'image/svg+xml';
        else if (ext === '.pdf') mime = 'application/pdf';

        const fileUrl = ext === '.pdf'
          ? URL.createObjectURL(base64ToBlob(base64, mime))
          : `data:${mime};base64,${base64}`;

        setVaultImages(prev => ({
          ...prev,
          [path]: fileUrl
        }));
      } else {
        registerDetectedTextFile(path, true);
        setDetectedTextFiles(prev => ({ ...prev, [path]: true }));

        const text = isBase64 ? safeB64Decode(base64) : base64;
        setFileContents(prev => ({
          ...prev,
          [path]: text
        }));
      }
    } catch (e) {
      console.error('Failed to load and classify unknown file:', e);
    } finally {
      setIsLoadingFile(false);
    }
  }, [githubToken, repoName, isOffline, storageMode, masterPassphrase]);

  const uploadAttachment = async (file: File, folderPath?: string, shouldNavigate: boolean = true): Promise<{ path: string; name: string }> => {
    if (isOffline) {
      return uploadAttachmentOffline(file, folderPath, shouldNavigate);
    }
    const maxSizeInBytes = settings.maxAttachmentSize * 1024 * 1024;
    if (file.size > maxSizeInBytes) {
      const errorMsg = `Attachment exceeds the ${settings.maxAttachmentSize}MB size limit set in settings.`;
      setGlobalError(errorMsg);
      throw new Error(errorMsg);
    }

    const finalFolder = folderPath !== undefined ? folderPath : settings.attachmentsFolder;
    const parentPath = finalFolder && finalFolder !== '/'
      ? (finalFolder.endsWith('/') ? finalFolder : `${finalFolder}/`)
      : '';

    const finalPath = `${parentPath}${file.name}`;

    // Resolve name collision locally
    let finalPathResolved = finalPath;
    let counter = 1;
    const dotIndex = file.name.lastIndexOf('.');
    const baseName = dotIndex !== -1 ? file.name.substring(0, dotIndex) : file.name;
    const ext = dotIndex !== -1 ? file.name.substring(dotIndex) : '';

    while (files.some(f => f.path === finalPathResolved)) {
      finalPathResolved = `${parentPath}${baseName}-${counter}${ext}`;
      counter++;
    }

    try {
      // Read file as base64
      const base64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const res = reader.result as string;
          resolve(res.split(',')[1]);
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      const commitResult = await commitAttachment(
        githubToken,
        repoName,
        branchName,
        finalPathResolved,
        base64,
        null,
        `upload attachment ${finalPathResolved}`
      );

      const isText = isTextFile(finalPathResolved);
      if (isText) {
        try {
          const decodedText = safeB64Decode(base64);
          await saveLocalFile(finalPathResolved, { content: decodedText, sha: commitResult.sha });
          setFileContents(prev => ({
            ...prev,
            [finalPathResolved]: decodedText
          }));
        } catch {
          // fallback
        }
      } else {
        const mime = file.type || 'application/octet-stream';
        const dataUrl = `data:${mime};base64,${base64}`;
        setVaultImages(prev => ({
          ...prev,
          [finalPathResolved]: dataUrl
        }));
      }

      const newFile: VaultFile = {
        path: finalPathResolved,
        name: finalPathResolved.split('/').pop() || file.name,
        type: 'blob',
        sha: commitResult.sha,
        size: file.size
      };

      setFiles(prev => [newFile, ...prev]);
      if (shouldNavigate) {
        setActiveFilePath(finalPathResolved);
      }
      // Refresh tree from server to ensure consistency
      refreshFiles(githubToken, repoName, branchName);
      return { path: finalPathResolved, name: newFile.name };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to upload attachment.';
      setGlobalError(msg);
      throw e;
    }
  };

  const getFileContentAndType = async (path: string, sha: string): Promise<{ data: Blob; isBinary: boolean }> => {
    const isBinary = !isTextFile(path) && !path.toLowerCase().endsWith('.canvas');

    let mime = 'application/octet-stream';
    const ext = path.substring(path.lastIndexOf('.')).toLowerCase();
    if (ext === '.md' || ext === '.txt') mime = 'text/plain;charset=utf-8';
    else if (ext === '.canvas' || ext === '.json') mime = 'application/json;charset=utf-8';
    else if (ext === '.png') mime = 'image/png';
    else if (ext === '.jpg' || ext === '.jpeg') mime = 'image/jpeg';
    else if (ext === '.webp') mime = 'image/webp';
    else if (ext === '.gif') mime = 'image/gif';
    else if (ext === '.svg') mime = 'image/svg+xml';
    else if (ext === '.pdf') mime = 'application/pdf';

    if (isOffline) {
      const file = await offlineStorage.getFile(path);
      if (!file) throw new Error(`File not found in offline storage: ${path}`);
      let content = file.content;
      if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
        if (masterPassphrase) {
          content = await decryptToken(file.content, masterPassphrase);
        }
      }
      if (isBinary) {
        return { data: base64ToBlob(content, mime), isBinary: true };
      } else {
        return { data: new Blob([content], { type: mime }), isBinary: false };
      }
    } else {
      // Remote
      if (isBinary) {
        const cachedDataUrl = vaultImages[path];
        const base64 = (cachedDataUrl && cachedDataUrl.startsWith('data:'))
          ? cachedDataUrl.split(',')[1]
          : await fetchBinaryFileContent(githubToken, repoName, sha);
        return { data: base64ToBlob(base64, mime), isBinary: true };
      } else {
        let content = fileContents[path];
        if (content === undefined) {
          content = await fetchFileContent(githubToken, repoName, path, sha);
        }
        return { data: new Blob([content], { type: mime }), isBinary: false };
      }
    }
  };

  const handleDownloadFile = async (path: string, name: string, sha: string) => {
    try {
      setGlobalError('');
      const finalSha = sha || files.find(f => f.path === path)?.sha || '';
      const { data } = await getFileContentAndType(path, finalSha);
      const url = URL.createObjectURL(data);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to download file.';
      setGlobalError(msg);
    }
  };

  const [bulkDownloadStatus, setBulkDownloadStatus] = useState<string | null>(null);

  const handleBulkDownload = async () => {
    setBulkDownloadStatus('Preparing files...');
    try {
      const zip = new JSZip();
      const filesToZip = files.filter(f => f.name !== '.gitkeep' && f.name !== '.vault-compat.json');

      for (let i = 0; i < filesToZip.length; i++) {
        const file = filesToZip[i];
        setBulkDownloadStatus(`Packing (${i + 1}/${filesToZip.length}): ${file.name}...`);

        try {
          const { data } = await getFileContentAndType(file.path, file.sha);
          const buffer = await data.arrayBuffer();
          zip.file(file.path, buffer);
        } catch (fileErr) {
          console.error(`Failed to pack file ${file.path}:`, fileErr);
        }
      }

      setBulkDownloadStatus('Generating ZIP...');
      const content = await zip.generateAsync({ type: 'blob' });

      const zipName = `${(repoName || 'local_vault').replace(new RegExp('[\\\\/:*?"<>|]', 'g'), '_')}_vault.zip`;
      const url = URL.createObjectURL(content);
      const a = document.createElement('a');
      a.href = url;
      a.download = zipName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setBulkDownloadStatus(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to generate bulk ZIP download.';
      setGlobalError(msg);
      setBulkDownloadStatus(null);
    }
  };

  const handlePublishOfflineVaultToGitHub = async (e: React.FormEvent) => {
    e.preventDefault();
    setPublishError(null);
    setPublishStatus('Validating repository...');

    if (!publishToken.trim() || !publishRepo.trim() || !publishBranch.trim()) {
      setPublishError('All fields (Token, Repository Name, Branch) are required.');
      setPublishStatus(null);
      return;
    }

    try {
      // 1. Validate connection credentials (token, repo)
      const validation = await validateRepository(publishToken.trim(), publishRepo.trim(), publishBranch.trim());
      if (!validation.exists) {
        throw new Error('Repository not found or unauthorized.');
      }
      if (!validation.isEmpty) {
        throw new Error('MANDATORY: The target repository must be completely empty to publish offline vault.');
      }

      // 2. Initialize repository with .vault-compat.json marker
      setPublishStatus('Initializing vault metadata on GitHub...');
      await initializeVault(publishToken.trim(), publishRepo.trim(), publishBranch.trim());

      // 3. Load all local files list from IndexedDB
      setPublishStatus('Loading local vault files...');
      const localFilesList = await offlineStorage.getFilesList();

      // 4. Upload loop
      for (let i = 0; i < localFilesList.length; i++) {
        const fileRecord = localFilesList[i];
        setPublishStatus(`Uploading (${i + 1}/${localFilesList.length}): ${fileRecord.name}...`);

        // Load content from IndexedDB
        const fileData = await offlineStorage.getFile(fileRecord.path);
        if (!fileData) continue;

        let contentToUpload = fileData.content;
        // Decrypt if storage is encrypted
        if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
          if (masterPassphrase) {
            contentToUpload = await decryptToken(fileData.content, masterPassphrase);
          }
        }

        const isBinaryFileNode = !isTextFile(fileRecord.path) && !fileRecord.path.toLowerCase().endsWith('.canvas');

        if (fileData.type === 'blob' && !isBinaryFileNode) {
          try {
            contentToUpload = safeB64Decode(contentToUpload);
          } catch {
            // fallback
          }
        }

        let resultSha = '';
        if (isBinaryFileNode) {
          // contentToUpload is base64 encoded for binary files
          const res = await commitAttachment(publishToken.trim(), publishRepo.trim(), publishBranch.trim(), fileRecord.path, contentToUpload, null, `upload local attachment "${fileRecord.path}" via Starfish Notes`);
          resultSha = res.sha;
        } else {
          // contentToUpload is plaintext for text/canvas files
          const res = await commitFileContent(publishToken.trim(), publishRepo.trim(), publishBranch.trim(), fileRecord.path, contentToUpload, null, `publish local note "${fileRecord.path}" via Starfish Notes`);
          resultSha = res.sha;
        }

        // Update IndexedDB SHA and type so local database matches GitHub
        await offlineStorage.saveFile({
          ...fileData,
          sha: resultSha
        });
      }

      // 5. Transition mode to online/github
      setPublishStatus('Finalizing transition to GitHub mode...');

      // Save credentials secure or in localstorage based on storageMode
      await saveTokenSecurely(publishToken.trim(), storageMode, masterPassphrase);
      localStorage.setItem(STORAGE_KEYS.REPO_NAME, publishRepo.trim());
      localStorage.setItem(STORAGE_KEYS.BRANCH_NAME, publishBranch.trim());
      localStorage.setItem('starfishnotes-is-offline', 'false');
      localStorage.setItem(STORAGE_KEYS.STORAGE_MODE, storageMode);

      // Update state to render online UI immediately
      setGithubToken(publishToken.trim());
      setRepoName(publishRepo.trim());
      setBranchName(publishBranch.trim());
      setIsOffline(false);
      setAuthMode('github');

      // Fetch the updated files tree from GitHub to complete initialization
      const tree = await fetchRepositoryTree(publishToken.trim(), publishRepo.trim(), publishBranch.trim());
      setFiles(tree);
      preloadAllFilesContents(tree);

      if (tree.length > 0) {
        const defaultNote = tree.find(f => f.name === 'Welcome.md') || tree[0];
        setActiveFilePath(defaultNote.path);
      }

      setPublishStatus(null);
      setShowSettingsModal(false);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Sync failed. Please verify credentials.';
      setPublishError(msg);
      setPublishStatus(null);
    }
  };

  // 1. Session Restoration on Mount
  const autoConnectRef = useRef(autoConnect);
  const refreshFilesOfflineRef = useRef(refreshFilesOffline);

  useEffect(() => {
    autoConnectRef.current = autoConnect;
    refreshFilesOfflineRef.current = refreshFilesOffline;
  }, [autoConnect, refreshFilesOffline]);

  useEffect(() => {
    const checkSession = async () => {
      const offlineFlag = localStorage.getItem('starfishnotes-is-offline') === 'true';
      const mode = (localStorage.getItem(STORAGE_KEYS.STORAGE_MODE) || 'memory') as StorageMode;
      setStorageMode(mode);

      // 1. If mode is memory, we never restore session on mount (volatile React state lost on F5/close).
      // Purge all credentials, local files, and offline vault to guarantee a clean state.
      if (mode === 'memory') {
        purgeCredentials();
        localStorage.setItem(STORAGE_KEYS.STORAGE_MODE, 'memory');
        clearStorageCrypto();
        clearStoragePassphrase();
        try {
          await clearAllLocalFiles();
          await offlineStorage.purgeVault();
        } catch (e) {
          console.error('Failed to purge memory-mode storage on mount:', e);
        }
        setIsOffline(false);
        setAuthMode('github');
        setIsAuthenticated(false);
        return;
      }

      // 2. If mode is session:
      if (mode === 'session') {
        const isSessionActive = offlineFlag
          ? sessionStorage.getItem('starfishnotes_session_active') === 'true'
          : !!sessionStorage.getItem(STORAGE_KEYS.PLAINTEXT_PAT);

        if (!isSessionActive) {
          // No active session in sessionStorage -> tab was closed or new session.
          // Purge everything to guarantee confidentiality.
          purgeCredentials();
          localStorage.setItem(STORAGE_KEYS.STORAGE_MODE, 'session');
          clearStorageCrypto();
          clearStoragePassphrase();
          try {
            await clearAllLocalFiles();
            await offlineStorage.purgeVault();
          } catch (e) {
            console.error('Failed to purge session-mode storage on mount:', e);
          }
          setIsOffline(false);
          setAuthMode('github');
          setIsAuthenticated(false);
          return;
        }
      }

      // 3. Normal session restoration for plain, encrypted, keychain, or active session
      if (offlineFlag) {
        setIsOffline(true);
        setAuthMode('local');
        setRepoName('Local Vault');
        setBranchName('offline');

        if (mode === 'encrypted' || mode === 'keychain') {
          setShowLockScreen(true);
        } else {
          if (mode === 'plain') {
            try {
              const activeKey = await getOrCreateSystemVaultPassphrase();
              offlineStorage.setPassphrase(activeKey);
              setStoragePassphrase(activeKey);
              setMasterPassphrase(activeKey);
            } catch (e) {
              console.error('Failed to initialize system vault key:', e);
            }
          }
          setIsAuthenticated(true);
          setTimeout(() => {
            refreshFilesOfflineRef.current();
          }, 0);
        }
        return;
      }

      const cachedRepo = localStorage.getItem(STORAGE_KEYS.REPO_NAME) || '';
      const cachedBranch = localStorage.getItem(STORAGE_KEYS.BRANCH_NAME) || 'main';

      if (cachedRepo) {
        setRepoName(cachedRepo);
        setBranchName(cachedBranch);
      }

      try {
        const token = await retrieveTokenSecurely(undefined, false);
        if (token) {
          if (mode === 'plain') {
            try {
              const activeKey = await getOrCreateSystemVaultPassphrase();
              setMasterPassphrase(activeKey);
            } catch (e) {
              console.error('Failed to load system key on session restore:', e);
            }
          }
          setGithubToken(token);
          setIsAuthenticated(true);
          // Direct auto-connect since token is readily decrypted in session memory
          autoConnectRef.current(token, cachedRepo, cachedBranch);
        } else if (mode === 'encrypted' && localStorage.getItem(STORAGE_KEYS.ENCRYPTED_PAT)) {
          // Encrypted token exists in localStorage, but decryption key is missing in sessionStorage
          // Prompt user to enter passphrase to unlock the app!
          setShowLockScreen(true);
        } else if (mode === 'keychain') {
          // Native keychain mode stored, but silent retrieval failed on page load.
          // Show Lock Screen to prompt user interaction under user gesture!
          setShowLockScreen(true);
        }
      } catch (e) {
        // Stale/corrupted data caused a decryption error — auto-purge everything
        // so the user gets a clean auth screen instead of a broken state.
        console.error('Session restore failed due to stale data, auto-purging:', e);
        purgeCredentials();
        clearStorageCrypto();
        clearStoragePassphrase();
        clearAllLocalFiles().catch(err => console.error('Failed to clear stale file cache:', err));
        offlineStorage.purgeVault().catch(err => console.error('Failed to purge stale vault:', err));
      }
    };
    checkSession();
  }, [autoConnectRef, refreshFilesOfflineRef]);

  // Listen to browser network changes
  useEffect(() => {
    const handleOnline = () => {
      console.log('Browser online. Triggering network status restoration...');
      setIsNetworkOffline(false);
      refreshFiles();
    };
    const handleOffline = () => {
      console.log('Browser offline. Switching to offline-cached mode...');
      setIsNetworkOffline(true);
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [refreshFiles]);

  // Activity monitor for idle detection
  useEffect(() => {
    const updateActivity = () => {
      lastActiveTimeRef.current = Date.now();
    };

    updateActivity();

    window.addEventListener('mousemove', updateActivity, { passive: true });
    window.addEventListener('mousedown', updateActivity, { passive: true });
    window.addEventListener('keydown', updateActivity, { passive: true });
    window.addEventListener('scroll', updateActivity, { passive: true });
    window.addEventListener('touchstart', updateActivity, { passive: true });

    return () => {
      window.removeEventListener('mousemove', updateActivity);
      window.removeEventListener('mousedown', updateActivity);
      window.removeEventListener('keydown', updateActivity);
      window.removeEventListener('scroll', updateActivity);
      window.removeEventListener('touchstart', updateActivity);
    };
  }, []);

  // Periodic idle check timer
  useEffect(() => {
    const interval = setInterval(() => {
      const idleTime = Date.now() - lastActiveTimeRef.current;
      if (idleTime > 5 * 60 * 1000 && document.visibilityState === 'visible' && !isOffline && githubToken) {
        console.log("Tab has been idle for more than 5 minutes. Checking remote updates...");
        refreshFiles(githubToken, repoName, branchName, true); // Trigger idle check
      }
    }, 60 * 1000); // Check every minute

    return () => clearInterval(interval);
  }, [refreshFiles, isOffline, githubToken, repoName, branchName]);

  // Tab visibility (focus return) idle check
  useEffect(() => {
    if (isOffline || !githubToken) return;

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const idleTime = Date.now() - lastActiveTimeRef.current;
        if (idleTime > 5 * 60 * 1000) {
          console.log('Tab focused after being idle for > 5 minutes. Verifying conflicts...');
          refreshFiles(githubToken, repoName, branchName, true); // Idle check
        } else {
          console.log('Tab focused. Standard refresh...');
          refreshFiles();
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [githubToken, isOffline, refreshFiles, repoName, branchName]);

  // Periodic API rate limit check
  useEffect(() => {
    if (isOffline || !githubToken) return;

    const checkRateLimit = async () => {
      try {
        console.log('[API Check] Checking GitHub API rate limit status...');
        const status = await checkApiRateLimit(githubToken);
        console.log(`[API Status] Remaining: ${status.remaining}/${status.limit} requests`);
        console.log(`[API Reset] Reset time: ${status.reset.toLocaleString()}`);

        if (status.isLimited) {
          console.warn('[API Limit] GitHub API rate limit reached! Pausing sync operations...');
          setApiLimitReached(true);
          setApiLimitResetTime(status.reset);
          setIsSyncPaused(true);
        } else {
          // If limit was previously reached but now it's reset, resume syncing
          if (apiLimitReached && status.reset <= new Date()) {
            console.log('[API Resume] API rate limit has been reset. Resuming sync...');
            setApiLimitReached(false);
            setApiLimitResetTime(null);
            setIsSyncPaused(false);
          }
        }
      } catch (error) {
        console.error('[API Error] Failed to check API rate limit:', error);
      }
    };

    // Check rate limit every 30 seconds
    const interval = setInterval(checkRateLimit, 180 * 1000);
    // Also check immediately on mount
    checkRateLimit();

    return () => clearInterval(interval);
  }, [isOffline, githubToken, apiLimitReached]);

  // Cleanup handler: purge volatile caches when tab is closed or navigated away
  useEffect(() => {
    const handlePageHide = () => {
      const mode = (localStorage.getItem(STORAGE_KEYS.STORAGE_MODE) || 'memory') as StorageMode;

      if (mode === 'memory') {
        // Memory mode promises "wiped on F5" — purge everything on page hide
        purgeCredentials();
        // Note: async operations in pagehide are best-effort (browser may not wait)
        // but idb-keyval clear() and purgeVault() use microtask-based promises
        // that typically complete before the page is discarded.
        clearAllLocalFiles().catch(() => { });
        offlineStorage.purgeVault().catch(() => { });
      } else if (mode === 'session') {
        // Session mode: browser clears sessionStorage on tab close,
        // but idb-keyval file cache persists — clean it up.
        clearAllLocalFiles().catch(() => { });
      }
    };

    window.addEventListener('pagehide', handlePageHide);
    return () => window.removeEventListener('pagehide', handlePageHide);
  }, []);

  // autoConnect function declaration migrated to stable top position

  // 2. Initializing connection via Manual Submit
  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!githubToken.trim() || !repoName.trim() || !branchName.trim()) {
      setAuthError('All connection parameters are required.');
      return;
    }

    if (storageMode === 'encrypted' && !masterPassphrase) {
      setAuthError('An encryption passphrase is required for Encrypted Storage mode.');
      return;
    }

    setIsConnecting(true);
    setAuthError('');

    try {
      // A. Verify credentials against GitHub API
      const result = await validateRepository(githubToken.trim(), repoName.trim(), branchName.trim());

      let activeKey = masterPassphrase;
      if (storageMode === 'plain') {
        activeKey = await getOrCreateSystemVaultPassphrase();
        setMasterPassphrase(activeKey);
      }

      // B. Save credentials securely to tiered storage
      await saveTokenSecurely(githubToken.trim(), storageMode, activeKey, repoName.trim());
      localStorage.setItem(STORAGE_KEYS.REPO_NAME, repoName.trim());
      localStorage.setItem(STORAGE_KEYS.BRANCH_NAME, branchName.trim());

      setIsAuthenticated(true);

      // C. Perform vault integrity checking
      if (result.isEmpty) {
        setIsRepoEmpty(true);
        setIsVaultChecked(true);
        setIsVaultCompatible(false);
      } else {
        setIsRepoEmpty(false);
        await checkAndLoadVault(githubToken.trim(), repoName.trim(), branchName.trim());
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Verification failed. Please review your token and repository parameters.';
      setAuthError(msg);
      setIsAuthenticated(false);
      purgeCredentials();
    } finally {
      setIsConnecting(false);
    }
  };

  // 3. Unlock screen for returning encrypted sessions
  const handleUnlock = async (e: React.FormEvent) => {
    e.preventDefault();
    const mode = (localStorage.getItem(STORAGE_KEYS.STORAGE_MODE) || 'memory') as StorageMode;

    if (mode === 'encrypted' && !unlockPassphrase) {
      setUnlockError('Passphrase required.');
      return;
    }

    setIsConnecting(true);
    setUnlockError('');

    try {
      if (isOffline) {
        let activeKey = '';
        if (mode === 'encrypted') {
          activeKey = unlockPassphrase;
        } else if (mode === 'keychain') {
          if (!('PasswordCredential' in window)) {
            throw new Error('OS Protected Storage not supported.');
          }
          const credential = await navigator.credentials.get({
            password: true,
            mediation: 'required'
          } as unknown as CredentialRequestOptions);
          if (credential) {
            activeKey = (credential as unknown as { password?: string }).password || '';
          }
          if (!activeKey) {
            throw new Error('Keychain verification failed.');
          }
        }

        const verification = await offlineStorage.getMeta<string>('vault_verification');
        if (verification) {
          try {
            const dec = await decryptToken(verification, activeKey);
            if (dec !== 'Welcome') {
              throw new Error('Invalid passphrase');
            }
          } catch {
            throw new Error('Incorrect master lock passphrase.');
          }
        }

        setMasterPassphrase(activeKey);
        offlineStorage.setPassphrase(activeKey);
        setIsAuthenticated(true);
        setShowLockScreen(false);
        await refreshFilesOffline();
      } else {
        const decrypted = await retrieveTokenSecurely(unlockPassphrase, true);
        if (decrypted) {
          if (mode === 'encrypted') {
            setMasterPassphrase(unlockPassphrase);
          } else if (mode === 'plain') {
            const activeKey = await getOrCreateSystemVaultPassphrase();
            setMasterPassphrase(activeKey);
          }
          setGithubToken(decrypted);
          setIsAuthenticated(true);
          setShowLockScreen(false);
          await autoConnect(decrypted, repoName, branchName);
        } else {
          if (mode === 'keychain') {
            setUnlockError('Verification failed or cancelled.');
          } else {
            setUnlockError('Incorrect passphrase.');
          }
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : (mode === 'keychain' ? 'Failed to unlock via Browser Keychain.' : 'Failed to decrypt token. Check passphrase.');
      setUnlockError(msg);
    } finally {
      setIsConnecting(false);
    }
  };

  // 4. Log out manager — comprehensive purge of ALL storage layers
  const handleLogout = () => {
    // 1. Nuke all starfishnotes* keys from localStorage + sessionStorage
    purgeCredentials();
    // 2. Wipe IndexedDB offline vault (files + meta stores including system_cryptokey & vault_verification)
    offlineStorage.purgeVault().catch(e => console.error('Failed to purge offline vault:', e));
    offlineStorage.clearPassphrase();
    // 3. Wipe idb-keyval file cache (file_* and file_hash_* entries)
    clearAllLocalFiles().catch(e => console.error('Failed to clear local file cache:', e));
    // 4. Reset module-level crypto state to prevent stale handles
    clearStorageCrypto();
    clearStoragePassphrase();
    // 5. Reset all React state
    setIsOffline(false);
    setAuthMode('github');
    setIsAuthenticated(false);
    setShowLockScreen(false);
    setGithubToken('');
    setMasterPassphrase('');
    setFiles([]);
    setFileContents({});
    setActiveFilePath(null);
    setIsVaultChecked(false);
  };

  // checkAndLoadVault function migrated to stable top position

  const handleInitializeVault = async () => {
    setIsInitializing(true);
    try {
      await initializeVault(githubToken, repoName, branchName);

      // Create initial Welcome note in vault
      const welcomeContent = '';

      await commitFileContent(githubToken, repoName, branchName, 'Welcome.md', welcomeContent, null, 'chore: create initial Welcome.md note');

      setIsVaultCompatible(true);
      await refreshFiles(githubToken, repoName, branchName);
      setActiveFilePath('Welcome.md');
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to initialize vault metadata.';
      setAuthError(msg);
    } finally {
      setIsInitializing(false);
    }
  };

  // refreshFiles function migrated to stable top position

  // preloadFilesBackground function migrated to stable top position

  // loadFileContent function migrated to stable top position

  const resolveKeepLocal = useCallback(async (file: VaultFile) => {
    try {
      const cachedFile = await getLocalFile(file.path);
      if (cachedFile) {
        const isNewFile = file.sha === 'offline-pending' || file.sha === 'remote-deleted';
        const shaToUse = isNewFile ? null : file.sha;
        const pushRes = await commitFileContent(
          githubToken,
          repoName,
          branchName,
          file.path,
          cachedFile.content,
          shaToUse,
          `resolve conflict: keep local changes for ${file.path}`
        );
        await saveLocalFile(file.path, { content: cachedFile.content, sha: pushRes.sha });
        removeUnsyncedFile(file.path);
        setFiles(prev => prev.map(f => f.path === file.path ? { ...f, sha: pushRes.sha } : f));
        setConflictingFiles(prev => prev.filter(f => f.path !== file.path));
        console.log(`Conflict resolved: Kept local copy of ${file.path}`);
      }
    } catch (e) {
      console.error(`Failed to push local conflict resolution for ${file.path}:`, e);
      throw e;
    }
  }, [githubToken, repoName, branchName, setFiles, setConflictingFiles]);

  const resolveKeepRemote = useCallback(async (file: VaultFile) => {
    try {
      if (file.sha === 'remote-deleted') {
        await deleteLocalFile(file.path);
        removeUnsyncedFile(file.path);
        setFileContents(prev => {
          const updated = { ...prev };
          delete updated[file.path];
          return updated;
        });
        setFiles(prev => prev.filter(f => f.path !== file.path));
        setConflictingFiles(prev => prev.filter(f => f.path !== file.path));
        if (activeFilePath === file.path) {
          setActiveFilePath(null);
        }
        console.log(`Conflict resolved: Kept remote delete of ${file.path}`);
        return;
      }

      const content = await fetchFileContent(githubToken, repoName, file.path, file.sha);
      await saveLocalFile(file.path, { content, sha: file.sha });
      removeUnsyncedFile(file.path);
      setFileContents(prev => ({ ...prev, [file.path]: content }));
      setFiles(prev => {
        const exists = prev.some(f => f.path === file.path);
        if (exists) {
          return prev.map(f => f.path === file.path ? { ...f, sha: file.sha } : f);
        } else {
          return [...prev, file];
        }
      });
      setConflictingFiles(prev => prev.filter(f => f.path !== file.path));
      console.log(`Conflict resolved: Kept remote copy of ${file.path}`);
    } catch (e) {
      console.error(`Failed to pull remote conflict resolution for ${file.path}:`, e);
      throw e;
    }
  }, [githubToken, repoName, activeFilePath, setFileContents, setFiles, setConflictingFiles, setActiveFilePath]);

  const resolveAllLocal = useCallback(async () => {
    console.log("Resolving all conflicts: Keeping local versions...");
    for (const file of conflictingFiles) {
      try {
        await resolveKeepLocal(file);
      } catch (err) {
        console.error(`Failed resolving all local for ${file.path}`, err);
      }
    }
  }, [conflictingFiles, resolveKeepLocal]);

  const resolveAllRemote = useCallback(async () => {
    console.log("Resolving all conflicts: Keeping remote versions...");
    for (const file of conflictingFiles) {
      try {
        await resolveKeepRemote(file);
      } catch (err) {
        console.error(`Failed resolving all remote for ${file.path}`, err);
      }
    }
  }, [conflictingFiles, resolveKeepRemote]);

  const handleSaveFile = useCallback(async (path: string, content: string, fileSha: string | null) => {
    if (isOffline) {
      return handleSaveFileOffline(path, content);
    }
    try {
      const result = await commitFileContent(githubToken, repoName, branchName, path, content, fileSha);

      // Update in-memory file structure
      setFileContents(prev => ({
        ...prev,
        [path]: content,
      }));

      setFiles(prev => prev.map(f => {
        if (f.path === path) {
          return { ...f, sha: result.sha };
        }
        return f;
      }));

      await saveLocalFile(path, { content: content, sha: result.sha });

      setActiveFileHasRemoteUpdate(false);
      return result;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : '';
      const isNetworkError = err instanceof TypeError || errMsg.includes('fetch') || errMsg.includes('Network') || errMsg.includes('Failed to fetch');

      if (isNetworkError) {
        console.warn("Network offline during save. Caching note locally...", path);
        setIsNetworkOffline(true);

        // 1. Save content locally
        await saveLocalFile(path, { content, sha: fileSha || 'offline-pending' });

        // 2. Mark as unsynced
        addUnsyncedFile(path);

        // 3. Update in-memory file contents
        setFileContents(prev => ({
          ...prev,
          [path]: content,
        }));

        // 4. Update files tree in state
        setFiles(prev => {
          const exists = prev.some(f => f.path === path);
          if (exists) {
            return prev.map(f => f.path === path ? { ...f, sha: f.sha || 'offline-pending' } : f);
          } else {
            const newFile: VaultFile = {
              path,
              name: path.split('/').pop() || path,
              type: 'blob',
              sha: 'offline-pending'
            };
            return [newFile, ...prev];
          }
        });

        return { sha: fileSha || 'offline-pending' };
      } else {
        throw err;
      }
    }
  }, [isOffline, githubToken, repoName, branchName, handleSaveFileOffline, setFileContents, setFiles, setActiveFileHasRemoteUpdate]);

  const resolveActiveKeepLocal = useCallback(async () => {
    if (!activeFilePath) return;
    const content = fileContents[activeFilePath] || '';
    const activeFile = files.find(f => f.path === activeFilePath);
    try {
      await handleSaveFile(activeFilePath, content, activeFile?.sha || null);
      setActiveFileHasRemoteUpdate(false);
      console.log(`Resolved active conflict: kept local version for ${activeFilePath}`);
    } catch (err) {
      console.error(`Failed to resolve active conflict (keep local) for ${activeFilePath}:`, err);
    }
  }, [activeFilePath, fileContents, files, handleSaveFile]);

  const resolveActiveKeepRemote = useCallback(async () => {
    if (!activeFilePath) return;
    const activeFile = files.find(f => f.path === activeFilePath);
    if (!activeFile) return;
    setIsLoadingFile(true);
    try {
      const content = await fetchFileContent(githubToken, repoName, activeFilePath, activeFile.sha);
      await saveLocalFile(activeFilePath, { content, sha: activeFile.sha });
      setFileContents(prev => ({ ...prev, [activeFilePath]: content }));
      setActiveFileHasRemoteUpdate(false);
      console.log(`Resolved active conflict: pulled remote version for ${activeFilePath}`);
    } catch (err) {
      console.error(`Failed to resolve active conflict (keep remote) for ${activeFilePath}:`, err);
    } finally {
      setIsLoadingFile(false);
    }
  }, [activeFilePath, files, githubToken, repoName]);

  const retryApiLimitCheck = useCallback(async () => {
    try {
      console.log('[Manual Retry] Manually checking API rate limit status...');
      const status = await checkApiRateLimit(githubToken);
      console.log(`[API Status] Remaining: ${status.remaining}/${status.limit} requests`);
      console.log(`[API Reset] Reset time: ${status.reset.toLocaleString()}`);

      if (status.isLimited) {
        console.log('[API Limit] API rate limit still active. Sync remains paused.');
        setApiLimitResetTime(status.reset);
      } else {
        console.log('[API Resume] API rate limit has been reset. Resuming sync...');
        setApiLimitReached(false);
        setApiLimitResetTime(null);
        setIsSyncPaused(false);
        // Trigger an immediate sync
        await refreshFiles(githubToken, repoName, branchName);
      }
    } catch (error) {
      console.error('[API Error] Failed to check API rate limit during retry:', error);
    }
  }, [githubToken, refreshFiles, repoName, branchName]);

  const createNewFile = async (extension: '.md' | '.txt' | '.canvas' | '.base', folderPath?: string) => {
    if (isOffline) {
      await createNewFileOffline(extension, folderPath);
      return;
    }
    if (isLoadingFile) return;

    const isText = extension === '.md' || extension === '.txt';
    const baseName = extension === '.canvas' ? 'Untitled Board' : extension === '.base' ? 'Untitled Base' : 'Untitled Note';

    // Resolve parent directory path
    const parentPath = folderPath && folderPath !== '/'
      ? (folderPath.endsWith('/') ? folderPath : `${folderPath}/`)
      : '';

    let finalPath = `${parentPath}${baseName}${extension}`;
    let counter = 1;

    // Resolve name collision locally
    while (files.some(f => f.path === finalPath)) {
      finalPath = `${parentPath}${baseName} ${counter}${extension}`;
      counter++;
    }

    setIsLoadingFile(true);
    try {
      const cleanFileName = finalPath.split('/').pop() || finalPath;
      const initialText = isText
        ? ''
        : extension === '.canvas'
          ? JSON.stringify({ nodes: [], edges: [] }, null, 2)
          : `version: 1\nsource:\n  folder: ""\nviews:\n  - id: view_table_1\n    name: "All Active Projects"\n    type: table\n    columns:\n      - property: file.name\n        visible: true\n        width: 200\n`;

      let resultSha: string;
      try {
        const result = await commitFileContent(githubToken, repoName, branchName, finalPath, initialText, null, `create ${finalPath} note`);
        resultSha = result.sha;
        // Also save to local cache for offline access
        await saveLocalFile(finalPath, { content: initialText, sha: resultSha });
      } catch (commitErr: unknown) {
        const errMsg = commitErr instanceof Error ? commitErr.message : '';
        const isNetworkError = commitErr instanceof TypeError || errMsg.includes('fetch') || errMsg.includes('Network') || errMsg.includes('Failed to fetch');

        if (isNetworkError) {
          // Network is down — create file locally and mark as unsynced
          console.warn('Network offline during file creation. Saving locally...', finalPath);
          setIsNetworkOffline(true);
          resultSha = 'offline-pending';
          await saveLocalFile(finalPath, { content: initialText, sha: resultSha });
          addUnsyncedFile(finalPath);
        } else {
          throw commitErr;
        }
      }

      const newFile: VaultFile = {
        path: finalPath,
        name: cleanFileName,
        type: 'blob',
        sha: resultSha,
      };

      setFiles(prev => [newFile, ...prev]);
      setFileContents(prev => ({ ...prev, [finalPath]: initialText }));
      setActiveFilePath(finalPath);
      setViewTab('workspace'); // Toggle workspace active
      // Refresh tree from server to ensure consistency
      refreshFiles(githubToken, repoName, branchName);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to create new file.';
      setAuthError(msg);
    } finally {
      setIsLoadingFile(false);
    }
  };

  const ensureGitkeepForEmptyParent = async (deletedFilePath: string, currentFiles: VaultFile[]): Promise<VaultFile | null> => {
    if (!deletedFilePath.includes('/')) return null;
    const parentFolder = deletedFilePath.substring(0, deletedFilePath.lastIndexOf('/'));
    const prefix = `${parentFolder}/`;

    // Check if there are any files remaining in this folder (excluding .gitkeep)
    const remainingFiles = currentFiles.filter(f =>
      f.path.startsWith(prefix) &&
      f.path !== deletedFilePath &&
      f.name !== '.gitkeep'
    );

    if (remainingFiles.length === 0) {
      const gitkeepPath = `${prefix}.gitkeep`;
      const hasGitkeep = currentFiles.some(f => f.path === gitkeepPath);

      if (!hasGitkeep) {
        console.log(`Folder "${parentFolder}" became empty. Creating .gitkeep placeholder...`);
        try {
          if (isOffline) {
            const sha = 'offline-sha-' + Date.now();
            let content = '';
            if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
              if (masterPassphrase) {
                content = await encryptToken('', masterPassphrase);
              }
            }
            await offlineStorage.saveFile({
              path: gitkeepPath,
              name: '.gitkeep',
              type: 'text',
              content,
              size: 0,
              sha
            });
            return {
              path: gitkeepPath,
              name: '.gitkeep',
              type: 'blob',
              sha
            };
          } else {
            const commitMessage = `create folder placeholder at "${gitkeepPath}" via Starfish Notes`;
            const result = await commitFileContent(githubToken, repoName, branchName, gitkeepPath, "", null, commitMessage);
            return {
              path: gitkeepPath,
              name: '.gitkeep',
              type: 'blob',
              sha: result.sha
            };
          }
        } catch (e) {
          console.error(`Failed to automatically create .gitkeep in ${parentFolder}:`, e);
        }
      }
    }
    return null;
  };

  const handleConfirmDelete = async () => {
    if (isOffline) {
      await handleConfirmDeleteOffline();
      return;
    }
    if (!pendingDeleteFile) return;
    const { path, sha } = pendingDeleteFile;
    setPendingDeleteFile(null); // Close modal
    setIsLoadingFile(true);
    try {
      await deleteFile(githubToken, repoName, branchName, path, sha);

      const gitkeepFile = await ensureGitkeepForEmptyParent(path, files);
      setFiles(prev => {
        const filtered = prev.filter(f => f.path !== path);
        return gitkeepFile ? [gitkeepFile, ...filtered] : filtered;
      });

      // Clear contents cache
      setFileContents(prev => {
        const updated = { ...prev };
        delete updated[path];
        return updated;
      });

      if (activeFilePath === path) {
        setActiveFilePath(null);
      }
      // Refresh tree from server to ensure consistency
      refreshFiles(githubToken, repoName, branchName);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to delete file.';
      setAuthError(msg);
    } finally {
      setIsLoadingFile(false);
    }
  };

  const handleRenameFile = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!pendingRenameFile) return;
    const { path: oldPath, sha: oldSha } = pendingRenameFile;
    const cleanNewName = renameInputValue.trim();
    if (!cleanNewName) {
      setRenameError('Note name cannot be empty.');
      return;
    }

    if (/[/\\:*?"<>|]/.test(cleanNewName)) {
      setRenameError('Note name contains invalid characters.');
      return;
    }

    const extension = oldPath.substring(oldPath.lastIndexOf('.'));
    const newPath = oldPath.includes('/')
      ? oldPath.substring(0, oldPath.lastIndexOf('/') + 1) + cleanNewName + extension
      : cleanNewName + extension;

    if (newPath === oldPath) {
      setPendingRenameFile(null);
      return;
    }

    const newPathLower = newPath.toLowerCase();
    if (files.some(f => f.path.toLowerCase() === newPathLower)) {
      setRenameError(`A note named "${cleanNewName}${extension}" already exists.`);
      return;
    }

    setIsLoadingFile(true);
    setPendingRenameFile(null); // Close modal
    try {
      // 1. Get current content
      let content = fileContents[oldPath];
      if (content === undefined) {
        if (isOffline) {
          const file = await offlineStorage.getFile(oldPath);
          if (file) {
            content = file.content;
            if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
              if (masterPassphrase) {
                content = await decryptToken(file.content, masterPassphrase);
              }
            }
          } else {
            content = "";
          }
        } else {
          content = await fetchFileContent(githubToken, repoName, oldPath, oldSha);
        }
      }

      // 2. Commit to new path & 3. Delete old path
      let sha = '';
      if (isOffline) {
        sha = 'offline-sha-' + Date.now();
        let savedContent = content;
        if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
          if (masterPassphrase) {
            savedContent = await encryptToken(content, masterPassphrase);
          }
        }
        const isBinary = !isTextFile(oldPath) && !oldPath.toLowerCase().endsWith('.canvas');

        await offlineStorage.saveFile({
          path: newPath,
          name: cleanNewName + extension,
          type: isBinary ? 'blob' : 'text',
          content: savedContent,
          size: content.length,
          sha
        });
        await offlineStorage.deleteFile(oldPath);
      } else {
        const commitMessage = `rename note "${oldPath}" to "${newPath}" via Starfish Notes`;
        const result = await commitFileContent(githubToken, repoName, branchName, newPath, content, null, commitMessage);
        sha = result.sha;
        await deleteFile(githubToken, repoName, branchName, oldPath, oldSha);
      }

      // 4. Update states
      const newFile: VaultFile = {
        path: newPath,
        name: cleanNewName + extension,
        type: 'blob',
        sha,
      };

      setFiles(prev => [newFile, ...prev.filter(f => f.path !== oldPath)]);
      setFileContents(prev => {
        const updated = { ...prev };
        updated[newPath] = content;
        delete updated[oldPath];
        return updated;
      });

      if (activeFilePath === oldPath) {
        setActiveFilePath(newPath);
      }
      // Refresh tree from server to ensure consistency
      refreshFiles(githubToken, repoName, branchName);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to rename note.';
      setAuthError(msg);
    } finally {
      setIsLoadingFile(false);
    }
  };

  const handleCreateFolder = async (folderPath: string) => {
    try {
      setIsLoadingTree(true);
      const targetPath = `${folderPath}/.gitkeep`;
      if (isOffline) {
        const sha = 'offline-sha-' + Date.now();
        let content = '';
        if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
          if (masterPassphrase) {
            content = await encryptToken('', masterPassphrase);
          }
        }
        await offlineStorage.saveFile({
          path: targetPath,
          name: '.gitkeep',
          type: 'text',
          content,
          size: 0,
          sha
        });
        await refreshFilesOffline();
      } else {
        const commitMessage = `create folder placeholder at "${targetPath}" via Starfish Notes`;
        await commitFileContent(githubToken, repoName, branchName, targetPath, "", null, commitMessage);
        await refreshFiles();
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to create folder.';
      setAuthError(msg);
    } finally {
      setIsLoadingTree(false);
    }
  };

  const handleCopyFile = async (oldPath: string, newPath: string) => {
    try {
      setIsLoadingFile(true);
      let content = fileContents[oldPath];
      if (content === undefined) {
        const matching = files.find(f => f.path === oldPath);
        if (matching) {
          if (isOffline) {
            const file = await offlineStorage.getFile(oldPath);
            if (file) {
              content = file.content;
              if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
                if (masterPassphrase) {
                  content = await decryptToken(file.content, masterPassphrase);
                }
              }
            } else {
              content = "";
            }
          } else {
            const contentStr = await fetchFileContent(githubToken, repoName, oldPath, matching.sha);
            content = contentStr;
          }
        } else {
          content = "";
        }
      }

      let sha = '';
      if (isOffline) {
        sha = 'offline-sha-' + Date.now();
        let savedContent = content;
        if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
          if (masterPassphrase) {
            savedContent = await encryptToken(content, masterPassphrase);
          }
        }
        const isBinary = !isTextFile(oldPath) && !oldPath.toLowerCase().endsWith('.canvas');

        await offlineStorage.saveFile({
          path: newPath,
          name: newPath.split('/').pop() || '',
          type: isBinary ? 'blob' : 'text',
          content: savedContent,
          size: content.length,
          sha
        });
      } else {
        const commitMessage = `copy note "${oldPath}" to "${newPath}" via Starfish Notes`;
        const result = await commitFileContent(githubToken, repoName, branchName, newPath, content, null, commitMessage);
        sha = result.sha;
      }

      const newFile: VaultFile = {
        path: newPath,
        name: newPath.split('/').pop() || '',
        type: 'blob',
        sha
      };

      setFiles(prev => [newFile, ...prev]);
      setFileContents(prev => ({
        ...prev,
        [newPath]: content
      }));
      setActiveFilePath(newPath);
      // Refresh tree from server to ensure consistency
      refreshFiles(githubToken, repoName, branchName);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to copy note.';
      setAuthError(msg);
    } finally {
      setIsLoadingFile(false);
    }
  };

  const handleMoveFile = async (oldPath: string, newPath: string, oldSha: string) => {
    try {
      setIsLoadingFile(true);
      let content = fileContents[oldPath];
      if (content === undefined) {
        const matching = files.find(f => f.path === oldPath);
        if (matching) {
          if (isOffline) {
            const file = await offlineStorage.getFile(oldPath);
            if (file) {
              content = file.content;
              if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
                if (masterPassphrase) {
                  content = await decryptToken(file.content, masterPassphrase);
                }
              }
            } else {
              content = "";
            }
          } else {
            const contentStr = await fetchFileContent(githubToken, repoName, oldPath, matching.sha);
            content = contentStr;
          }
        } else {
          content = "";
        }
      }

      let sha = '';
      if (isOffline) {
        sha = 'offline-sha-' + Date.now();
        let savedContent = content;
        if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
          if (masterPassphrase) {
            savedContent = await encryptToken(content, masterPassphrase);
          }
        }
        const isBinary = !isTextFile(oldPath) && !oldPath.toLowerCase().endsWith('.canvas');

        await offlineStorage.saveFile({
          path: newPath,
          name: newPath.split('/').pop() || '',
          type: isBinary ? 'blob' : 'text',
          content: savedContent,
          size: content.length,
          sha
        });
        await offlineStorage.deleteFile(oldPath);
      } else {
        const commitMessage = `move note "${oldPath}" to "${newPath}" via Starfish Notes`;
        const result = await commitFileContent(githubToken, repoName, branchName, newPath, content, null, commitMessage);
        sha = result.sha;
        await deleteFile(githubToken, repoName, branchName, oldPath, oldSha);
      }

      let gitkeepFile: VaultFile | null = null;
      const oldFolder = oldPath.includes('/') ? oldPath.substring(0, oldPath.lastIndexOf('/')) : '';
      const newFolder = newPath.includes('/') ? newPath.substring(0, newPath.lastIndexOf('/')) : '';
      if (oldFolder !== newFolder) {
        gitkeepFile = await ensureGitkeepForEmptyParent(oldPath, files);
      }

      const newFile: VaultFile = {
        path: newPath,
        name: newPath.split('/').pop() || '',
        type: 'blob',
        sha
      };

      setFiles(prev => {
        const filtered = prev.filter(f => f.path !== oldPath);
        const listWithNew = [newFile, ...filtered];
        return gitkeepFile ? [gitkeepFile, ...listWithNew] : listWithNew;
      });
      setFileContents(prev => {
        const updated = { ...prev };
        updated[newPath] = content;
        delete updated[oldPath];
        return updated;
      });

      if (activeFilePath === oldPath) {
        setActiveFilePath(newPath);
      }
      // Refresh tree from server to ensure consistency
      refreshFiles(githubToken, repoName, branchName);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to move note.';
      setAuthError(msg);
    } finally {
      setIsLoadingFile(false);
    }
  };

  const handleRenameFolder = async (oldFolderPath: string, newFolderName: string) => {
    try {
      setIsLoadingTree(true);
      const newFolderPath = oldFolderPath.includes('/')
        ? oldFolderPath.substring(0, oldFolderPath.lastIndexOf('/')) + '/' + newFolderName
        : newFolderName;

      if (newFolderPath === oldFolderPath) {
        setPendingRenameFolder(null);
        return;
      }

      // Get all files in this folder
      const prefix = `${oldFolderPath}/`;
      const filesInFolder = files.filter(f => f.path.startsWith(prefix));

      // Move each file to the new folder path
      for (const file of filesInFolder) {
        const newPath = file.path.replace(prefix, `${newFolderPath}/`);
        let content = fileContents[file.path];
        if (content === undefined) {
          if (isOffline) {
            const stored = await offlineStorage.getFile(file.path);
            content = stored ? stored.content : '';
          } else {
            content = await fetchFileContent(githubToken, repoName, file.path, file.sha);
          }
        }

        if (isOffline) {
          const sha = 'offline-sha-' + Date.now();
          let savedContent = content;
          if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
            if (masterPassphrase) {
              savedContent = await encryptToken(content, masterPassphrase);
            }
          }
          const isBinary = !isTextFile(file.path) && !file.path.toLowerCase().endsWith('.canvas');
          await offlineStorage.saveFile({
            path: newPath,
            name: newPath.split('/').pop() || '',
            type: isBinary ? 'blob' : 'text',
            content: savedContent,
            size: content.length,
            sha
          });
          await offlineStorage.deleteFile(file.path);
        } else {
          const commitMessage = `rename folder "${oldFolderPath}" to "${newFolderPath}" via Starfish Notes`;
          await commitFileContent(githubToken, repoName, branchName, newPath, content, null, commitMessage);
          await deleteFile(githubToken, repoName, branchName, file.path, file.sha);
        }
      }

      // Update state with renamed files
      setFiles(prev => {
        const updated = prev.map(f => {
          if (f.path.startsWith(prefix)) {
            return {
              ...f,
              path: f.path.replace(prefix, `${newFolderPath}/`),
              name: f.path.split('/').pop() || ''
            };
          }
          return f;
        });
        return updated;
      });

      setFileContents(prev => {
        const updated = { ...prev };
        for (const file of filesInFolder) {
          const newPath = file.path.replace(prefix, `${newFolderPath}/`);
          updated[newPath] = updated[file.path];
          delete updated[file.path];
        }
        return updated;
      });

      setPendingRenameFolder(null);
      refreshFiles(githubToken, repoName, branchName);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to rename folder.';
      setFolderRenameError(msg);
    } finally {
      setIsLoadingTree(false);
    }
  };

  const handleMoveFolder = async (oldFolderPath: string, newFolderPath: string) => {
    try {
      setIsLoadingTree(true);
      const folderName = oldFolderPath.split('/').pop() || '';
      const finalNewPath = newFolderPath && newFolderPath !== '/'
        ? `${newFolderPath}/${folderName}`
        : folderName;

      if (finalNewPath === oldFolderPath) {
        setPendingMoveCopyFolder(null);
        return;
      }

      // Get all files in this folder
      const prefix = `${oldFolderPath}/`;
      const filesInFolder = files.filter(f => f.path.startsWith(prefix));

      // Move each file to the new location
      for (const file of filesInFolder) {
        const newPath = file.path.replace(prefix, `${finalNewPath}/`);
        let content = fileContents[file.path];
        if (content === undefined) {
          if (isOffline) {
            const stored = await offlineStorage.getFile(file.path);
            content = stored ? stored.content : '';
          } else {
            content = await fetchFileContent(githubToken, repoName, file.path, file.sha);
          }
        }

        if (isOffline) {
          const sha = 'offline-sha-' + Date.now();
          let savedContent = content;
          if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
            if (masterPassphrase) {
              savedContent = await encryptToken(content, masterPassphrase);
            }
          }
          const isBinary = !isTextFile(file.path) && !file.path.toLowerCase().endsWith('.canvas');
          await offlineStorage.saveFile({
            path: newPath,
            name: newPath.split('/').pop() || '',
            type: isBinary ? 'blob' : 'text',
            content: savedContent,
            size: content.length,
            sha
          });
          await offlineStorage.deleteFile(file.path);
        } else {
          const commitMessage = `move folder "${oldFolderPath}" to "${finalNewPath}" via Starfish Notes`;
          await commitFileContent(githubToken, repoName, branchName, newPath, content, null, commitMessage);
          await deleteFile(githubToken, repoName, branchName, file.path, file.sha);
        }
      }

      // Update state
      setFiles(prev => {
        const updated = prev.map(f => {
          if (f.path.startsWith(prefix)) {
            return {
              ...f,
              path: f.path.replace(prefix, `${finalNewPath}/`),
              name: f.path.split('/').pop() || ''
            };
          }
          return f;
        });
        return updated;
      });

      setFileContents(prev => {
        const updated = { ...prev };
        for (const file of filesInFolder) {
          const newPath = file.path.replace(prefix, `${finalNewPath}/`);
          updated[newPath] = updated[file.path];
          delete updated[file.path];
        }
        return updated;
      });

      setPendingMoveCopyFolder(null);
      refreshFiles(githubToken, repoName, branchName);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to move folder.';
      setFolderMoveCopyError(msg);
    } finally {
      setIsLoadingTree(false);
    }
  };

  const handleCopyFolder = async (sourceFolderPath: string, destFolderPath: string, newFolderName: string) => {
    try {
      setIsLoadingTree(true);
      const finalDestPath = destFolderPath && destFolderPath !== '/'
        ? `${destFolderPath}/${newFolderName}`
        : newFolderName;

      const prefix = `${sourceFolderPath}/`;
      const filesInFolder = files.filter(f => f.path.startsWith(prefix));

      // Copy each file to the new location
      for (const file of filesInFolder) {
        const newPath = file.path.replace(prefix, `${finalDestPath}/`);
        let content = fileContents[file.path];
        if (content === undefined) {
          if (isOffline) {
            const stored = await offlineStorage.getFile(file.path);
            content = stored ? stored.content : '';
          } else {
            content = await fetchFileContent(githubToken, repoName, file.path, file.sha);
          }
        }

        if (isOffline) {
          const sha = 'offline-sha-' + Date.now();
          let savedContent = content;
          if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
            if (masterPassphrase) {
              savedContent = await encryptToken(content, masterPassphrase);
            }
          }
          const isBinary = !isTextFile(file.path) && !file.path.toLowerCase().endsWith('.canvas');
          await offlineStorage.saveFile({
            path: newPath,
            name: newPath.split('/').pop() || '',
            type: isBinary ? 'blob' : 'text',
            content: savedContent,
            size: content.length,
            sha
          });
        } else {
          const commitMessage = `copy folder "${sourceFolderPath}" to "${finalDestPath}" via Starfish Notes`;
          await commitFileContent(githubToken, repoName, branchName, newPath, content, null, commitMessage);
        }

        // Add to file contents cache
        setFileContents(prev => ({
          ...prev,
          [newPath]: content
        }));
      }

      setPendingMoveCopyFolder(null);
      refreshFiles(githubToken, repoName, branchName);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to copy folder.';
      setFolderMoveCopyError(msg);
    } finally {
      setIsLoadingTree(false);
    }
  };

  const handleConfirmDeleteFolder = async (folderPath: string) => {
    try {
      setIsLoadingTree(true);
      const prefix = `${folderPath}/`;
      const filesToDelete = files.filter(f => f.path === folderPath || f.path.startsWith(prefix));

      for (const file of filesToDelete) {
        if (isOffline) {
          await offlineStorage.deleteFile(file.path);
        } else {
          await deleteFile(githubToken, repoName, branchName, file.path, file.sha);
        }
      }

      setFiles(prev => prev.filter(f => f.path !== folderPath && !f.path.startsWith(prefix)));
      setFileContents(prev => {
        const updated = { ...prev };
        for (const key of Object.keys(updated)) {
          if (key === folderPath || key.startsWith(prefix)) {
            delete updated[key];
          }
        }
        return updated;
      });

      if (activeFilePath && (activeFilePath === folderPath || activeFilePath.startsWith(prefix))) {
        setActiveFilePath(null);
      }
      // Refresh tree from server to ensure consistency
      refreshFiles(githubToken, repoName, branchName);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Failed to delete folder.';
      setAuthError(msg);
    } finally {
      setIsLoadingTree(false);
    }
  };

  useEffect(() => {
    if (activeFilePath) {
      const matchingFile = files.find(f => f.path === activeFilePath);
      if (matchingFile) {
        const lastDot = matchingFile.path.lastIndexOf('.');
        const ext = lastDot !== -1 ? matchingFile.path.substring(lastDot).toLowerCase() : '';
        const extName = ext.startsWith('.') ? ext.substring(1) : ext;
        const binaryExtensions = [
          '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tar', '.gz', '.mp3', '.mp4', '.mov', '.avi', '.ttf', '.woff', '.woff2', '.eot'
        ];
        const isKnownBinary = binaryExtensions.includes(ext);
        const isCanvas = ext === '.canvas';
        const isKnownText = textExtensions.has(extName);
        const isUnrecognized = !isKnownBinary && !isCanvas && !isKnownText;

        if (isUnrecognized) {
          const isDetectedText = detectedTextFiles[matchingFile.path];
          if (isDetectedText === undefined) {
            Promise.resolve().then(() => {
              loadUnknownFile(matchingFile.path, matchingFile.sha);
            });
          } else if (isDetectedText === true) {
            Promise.resolve().then(() => {
              loadFileContent(matchingFile.path, matchingFile.sha);
            });
          } else {
            Promise.resolve().then(() => {
              loadBinaryFile(matchingFile.path, matchingFile.sha);
            });
          }
        } else {
          const isBinary = isKnownBinary;
          if (isBinary) {
            Promise.resolve().then(() => {
              loadBinaryFile(matchingFile.path, matchingFile.sha);
            });
          } else {
            Promise.resolve().then(() => {
              loadFileContent(matchingFile.path, matchingFile.sha);
            });
          }
        }
      } else {
        const isGhostMd = isTextFile(activeFilePath);
        if (isGhostMd && !isLoadingFile && !failedGhostNotesRef.current.has(activeFilePath)) {
          // Wrap in microtask to defer setState and avoid cascading renders lint warning
          Promise.resolve().then(() => {
            setIsLoadingFile(true);
            const cleanFileName = activeFilePath.split('/').pop() || activeFilePath;
            const ext = activeFilePath.substring(activeFilePath.lastIndexOf('.')).toLowerCase();
            let initialText = '';
            if (ext === '.md' || ext === '.txt') {
              initialText = '';
            } else if (ext === '.csv') {
              initialText = `Header1,Header2,Header3\nValue1,Value2,Value3`;
            } else if (ext === '.tsv') {
              initialText = `Header1\tHeader2\tHeader3\nValue1\tValue2\tValue3`;
            } else {
              initialText = '';
            }

            if (isOffline) {
              const sha = 'offline-sha-' + Date.now();
              (async () => {
                let savedContent = initialText;
                if (storageMode === 'encrypted' || storageMode === 'keychain' || storageMode === 'plain') {
                  if (masterPassphrase) {
                    savedContent = await encryptToken(initialText, masterPassphrase);
                  }
                }
                await offlineStorage.saveFile({
                  path: activeFilePath,
                  name: cleanFileName,
                  type: 'text',
                  content: savedContent,
                  size: initialText.length,
                  sha
                });
                const newFile: VaultFile = {
                  path: activeFilePath,
                  name: cleanFileName,
                  type: 'blob',
                  sha,
                  size: initialText.length
                };
                setFiles(prev => [newFile, ...prev]);
                setFileContents(prev => ({ ...prev, [activeFilePath]: initialText }));
                setIsLoadingFile(false);
              })().catch((e) => {
                console.error(e);
                setIsLoadingFile(false);
              });
            } else {
              commitFileContent(githubToken, repoName, branchName, activeFilePath, initialText, null, `create ghost note "${activeFilePath}" via Starfish Notes`)
                .then((result) => {
                  const newFile: VaultFile = {
                    path: activeFilePath,
                    name: cleanFileName,
                    type: 'blob',
                    sha: result.sha,
                  };
                  setFiles(prev => [newFile, ...prev]);
                  setFileContents(prev => ({ ...prev, [activeFilePath]: initialText }));
                  setIsLoadingFile(false);
                })
                .catch((e: unknown) => {
                  const msg = e instanceof Error ? e.message : 'Failed to create ghost note on GitHub.';
                  console.error(msg);
                  failedGhostNotesRef.current.add(activeFilePath);
                  setIsLoadingFile(false);
                });
            }
          });
        }
      }
    }
  }, [activeFilePath, files, loadFileContent, loadBinaryFile, loadUnknownFile, detectedTextFiles, githubToken, repoName, branchName, isLoadingFile, isOffline, storageMode, masterPassphrase, setFiles, setFileContents, setIsLoadingFile]);

  // Sidebar note rendering filters
  const filteredFiles = files.filter(
    f => f.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
      f.path.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const activeFile = files.find(f => f.path === activeFilePath);

  // ----------------------------------------------------
  // UNLOCK SCREEN RENDER (MODULARIZED)
  // ----------------------------------------------------
  if (showLockScreen) {
    return (
      <LockScreen
        unlockPassphrase={unlockPassphrase}
        setUnlockPassphrase={setUnlockPassphrase}
        unlockError={unlockError}
        isConnecting={isConnecting}
        handleUnlock={handleUnlock}
        handleLogout={handleLogout}
        storageMode={storageMode}
      />
    );
  }

  // ----------------------------------------------------
  // ONBOARDING/LOGIN VIEW RENDER (MODULARIZED)
  // ----------------------------------------------------
  if (!isAuthenticated) {
    return (
      <AuthScreen
        githubToken={githubToken}
        setGithubToken={setGithubToken}
        repoName={repoName}
        setRepoName={setRepoName}
        branchName={branchName}
        setBranchName={setBranchName}
        storageMode={storageMode}
        setStorageMode={setStorageMode}
        masterPassphrase={masterPassphrase}
        setMasterPassphrase={setMasterPassphrase}
        authError={authError}
        isConnecting={isConnecting}
        handleConnect={handleConnect}
        authMode={authMode}
        setAuthMode={setAuthMode}
        isPersistentStorage={isPersistentStorage}
        requestPersistentStorage={requestPersistentStorage}
        handleConnectOffline={handleConnectOffline}
      />
    );
  }

  // ----------------------------------------------------
  // UNINITIALIZED VAULT VIEW RENDER (MODULARIZED)
  // ----------------------------------------------------
  if (!isOffline && isVaultChecked && !isVaultCompatible) {
    return (
      <InitVaultScreen
        repoName={repoName}
        branchName={branchName}
        isRepoEmpty={isRepoEmpty}
        isInitializing={isInitializing}
        handleInitializeVault={handleInitializeVault}
        handleLogout={handleLogout}
      />
    );
  }

  // ----------------------------------------------------
  // MAIN WORKSPACE INTERFACE RENDER
  // ----------------------------------------------------
  return (
    <div className="flex h-screen w-screen bg-background relative overflow-hidden select-none animate-fade-in">
      {globalError && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[2000] bg-[#1e1515] border border-destructive/40 text-destructive text-xs font-semibold px-4 py-2.5 rounded-xl shadow-2xl flex items-center gap-2 animate-fade-in select-text max-w-[calc(100vw-48px)] sm:max-w-md w-max">
          <span>{globalError}</span>
          <button
            type="button"
            onClick={() => setGlobalError('')}
            className="text-muted-foreground hover:text-foreground text-[0.7rem] ml-2 select-none cursor-pointer border border-transparent hover:bg-white/[0.04] w-5 h-5 flex items-center justify-center rounded-full"
          >
            ✕
          </button>
        </div>
      )}

      {isNetworkOffline && (
        <div className="fixed bottom-6 left-6 right-6 sm:right-auto z-[2000] bg-[#1c1d24]/95 border border-amber-500/30 text-amber-500 text-xs font-semibold px-4 py-3 rounded-xl shadow-2xl flex items-center gap-2.5 animate-fade-in backdrop-blur-xl select-text max-w-[calc(100vw-48px)] sm:max-w-md">
          <span className="w-2 h-2 bg-amber-500 rounded-full animate-ping shrink-0" />
          <span>Offline Mode: Working with cached notes. Edits will sync when connection is restored.</span>
        </div>
      )}

      {/* 1. Left Side Navigation Drawer */}
      <Sidebar
        isMobileSidebarOpen={isMobileSidebarOpen}
        setIsMobileSidebarOpen={setIsMobileSidebarOpen}
        createNewFile={createNewFile}
        onUploadAttachment={uploadAttachment}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        files={files}
        filteredFiles={filteredFiles}
        isLoadingTree={isLoadingTree}
        onOpenSettings={() => setShowSettingsModal(true)}
        hasConflicts={conflictingFiles.length > 0}
        onOpenConflictResolution={() => setShowConflictModal(true)}
        activeFilePath={activeFilePath}
        setActiveFilePath={handleOpenNote}
        setViewTab={setViewTab}
        onOpenSearch={() => setShowSearchModal(true)}
        onDeleteClick={(path, sha) => setPendingDeleteFile({ path, sha })}
        onRenameClick={(path, name, sha) => {
          setPendingRenameFile({ path, name, sha });
          const cleanName = name.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '');
          setRenameInputValue(cleanName);
          setRenameError('');
        }}
        repoName={repoName}
        branchName={branchName}
        onDownloadClick={handleDownloadFile}

        // Resize and collapse control props
        sidebarWidth={sidebarWidth}
        setSidebarWidth={handleSetSidebarWidth}
        isSidebarCollapsed={isSidebarCollapsed}
        setIsSidebarCollapsed={handleSetSidebarCollapsed}
        isResizingSidebar={isResizingSidebar}
        setIsResizingSidebar={setIsResizingSidebar}

        // Folder/Relocation props
        onCreateFolderClick={(parentPath) => {
          setParentFolderPathForNewFolder(parentPath);
          setShowCreateFolderModal(true);
        }}
        onDeleteFolderClick={(folderPath) => {
          setPendingDeleteFolder(folderPath);
        }}
        onCopyClick={async (path, name) => {
          const matched = files.find(f => f.path === path);
          if (matched) {
            setPendingMoveCopyFile(matched);
            setMoveCopyAction('copy');
            const cleanName = name.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '');
            setMoveCopyNameInput(`${cleanName} - Copy`);
            const parentDir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '/';
            setMoveCopyFolderSelect(parentDir);
          }
          setIsLoadingTree(true);
          try {
            await refreshFiles();
          } finally {
            setIsLoadingTree(false);
          }
        }}
        onMoveClick={async (path, name) => {
          const matched = files.find(f => f.path === path);
          if (matched) {
            setPendingMoveCopyFile(matched);
            setMoveCopyAction('move');
            const cleanName = name.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '');
            setMoveCopyNameInput(cleanName);
            const parentDir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : '/';
            setMoveCopyFolderSelect(parentDir);
          }
          setIsLoadingTree(true);
          try {
            await refreshFiles();
          } finally {
            setIsLoadingTree(false);
          }
        }}
        onRenameFolderClick={(folderPath) => {
          setPendingRenameFolder(folderPath);
          setFolderRenameInputValue(folderPath.split('/').pop() || '');
          setFolderRenameError('');
        }}
        onMoveFolderClick={(folderPath) => {
          setPendingMoveCopyFolder(folderPath);
          setFolderMoveCopyAction('move');
          const folderName = folderPath.split('/').pop() || '';
          setFolderMoveCopyNameInput(folderName);
          const parentDir = folderPath.includes('/') ? folderPath.substring(0, folderPath.lastIndexOf('/')) : '/';
          setFolderMoveCopyDestFolder(parentDir);
          setFolderMoveCopyError('');
        }}
        onCopyFolderClick={(folderPath) => {
          setPendingMoveCopyFolder(folderPath);
          setFolderMoveCopyAction('copy');
          const folderName = folderPath.split('/').pop() || '';
          setFolderMoveCopyNameInput(`${folderName} - Copy`);
          const parentDir = folderPath.includes('/') ? folderPath.substring(0, folderPath.lastIndexOf('/')) : '/';
          setFolderMoveCopyDestFolder(parentDir);
          setFolderMoveCopyError('');
        }}
      />

      {/* 2. Main Workspace & Views */}
      <main className="flex-1 h-full flex flex-col overflow-hidden relative">
        {/* Workspace Nav Tabs Header */}
        <header className="h-[60px] bg-card/80 backdrop-blur-xl border-b border-border flex items-center justify-between px-6 z-[5] shrink-0">
          <div className="flex items-center gap-3 font-heading font-semibold text-[0.975rem] max-w-[45%] truncate text-foreground">
            <button
              onClick={() => setIsMobileSidebarOpen(true)}
              className="md:hidden w-8 h-8 shrink-0 flex items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-all cursor-pointer"
              title="Open Sidebar"
            >
              <Menu size={15} />
            </button>
            {isSidebarCollapsed && (
              <button
                onClick={() => handleSetSidebarCollapsed(false)}
                className="hidden md:flex w-8 h-8 items-center justify-center rounded-xl border border-border text-muted-foreground hover:bg-muted hover:text-foreground transition-all cursor-pointer mr-1"
                title="Expand Sidebar"
              >
                <PanelLeft size={15} />
              </button>
            )}
            <Compass className="w-[18px] h-[18px] text-primary shrink-0 hidden md:block" />
            <span className="truncate">
              {activeFile ? activeFile.name.replace(/\.md$/, '').replace(/\.canvas$/, '') : 'No active file'}
            </span>
          </div>

          {/* Tab switches */}
          <div className="flex items-center gap-1.5 bg-muted/40 p-1.5 rounded-2xl border border-border">
            <button
              onClick={() => setViewTab('workspace')}
              className={cn(
                "h-8 px-4 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer",
                viewTab === 'workspace'
                  ? "bg-card text-foreground shadow-xs border border-border/80"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Edit3 size={13.5} />
              <span className="hidden sm:inline">Workspace View</span>
            </button>
            <button
              onClick={() => setViewTab('graph')}
              className={cn(
                "h-8 px-4 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all cursor-pointer",
                viewTab === 'graph'
                  ? "bg-card text-foreground shadow-xs border border-border/80"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Network size={13.5} />
              <span className="hidden sm:inline">Link Map (Graph)</span>
            </button>

            <div className="w-[1px] h-4.5 bg-border mx-1" />

            <button
              onClick={async () => {
                setIsRefreshing(true);
                try {
                  await refreshFiles();
                } finally {
                  setIsRefreshing(false);
                }
              }}
              disabled={isRefreshing}
              className="w-8 h-8 rounded-xl flex items-center justify-center text-muted-foreground hover:text-foreground hover:bg-card border border-transparent hover:border-border transition-all cursor-pointer disabled:opacity-50"
              title="Refresh Tree"
            >
              <RefreshCw size={13.5} className={cn(isRefreshing && 'animate-spin')} />
            </button>
          </div>
        </header>

        {activeFileHasRemoteUpdate && (
          <div className="bg-amber-500/10 border-b border-amber-500/20 text-amber-200/90 text-xs px-5 py-3 sm:px-6 sm:py-2.5 flex flex-col sm:flex-row sm:items-center justify-between shrink-0 gap-3 select-none animate-fade-in">
            <div className="flex items-start gap-2.5">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-amber-400 shrink-0 animate-pulse mt-0.5 sm:mt-0" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span className="font-semibold leading-relaxed">
                Warning: A newer version of "{activeFilePath?.split('/').pop() || 'this file'}" exists on GitHub. Saving will overwrite the remote version.
              </span>
            </div>
            <div className="flex items-center gap-2 self-end sm:self-auto shrink-0 w-full sm:w-auto justify-end">
              <button
                type="button"
                onClick={resolveActiveKeepRemote}
                className="px-3 py-1.5 bg-sky-500/20 border border-sky-500/30 hover:bg-sky-500/30 text-sky-300 text-[0.68rem] font-bold uppercase tracking-wider rounded-lg transition-all cursor-pointer"
              >
                Pull Remote
              </button>
              <button
                type="button"
                onClick={resolveActiveKeepLocal}
                className="px-3 py-1.5 bg-purple-500/20 border border-purple-500/30 hover:bg-purple-500/30 text-purple-300 text-[0.68rem] font-bold uppercase tracking-wider rounded-lg transition-all cursor-pointer"
              >
                Overwrite Remote
              </button>
            </div>
          </div>
        )}

        {apiLimitReached && (
          <div className="bg-red-500/10 border-b border-red-500/20 text-red-200/90 text-xs px-5 py-3 sm:px-6 sm:py-2.5 flex flex-col sm:flex-row sm:items-center justify-between shrink-0 gap-3 select-none animate-fade-in">
            <div className="flex items-start gap-2.5">
              <svg viewBox="0 0 24 24" className="w-4 h-4 text-red-400 shrink-0 animate-pulse mt-0.5 sm:mt-0" fill="none" stroke="currentColor" strokeWidth="2.5">
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <div className="flex flex-col gap-1">
                <span className="font-semibold leading-relaxed">
                  GitHub API rate limit reached. Sync is paused.
                </span>
                {apiLimitResetTime && (
                  <span className="text-red-300/80 text-[0.75rem]">
                    Limit resets at {apiLimitResetTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                )}
              </div>
            </div>
            <button
              type="button"
              onClick={retryApiLimitCheck}
              className="px-3 py-1.5 bg-red-500/20 border border-red-500/30 hover:bg-red-500/30 text-red-300 text-[0.68rem] font-bold uppercase tracking-wider rounded-lg transition-all cursor-pointer shrink-0 w-full sm:w-auto justify-center"
            >
              Retry
            </button>
          </div>
        )}

        {/* Primary Content Paneling */}
        <div className="flex-1 w-full relative overflow-hidden bg-background">
          {viewTab === 'graph' ? (
            <GraphView
              files={files}
              fileContents={fileContents}
              onOpenNote={(path) => {
                handleOpenNote(path);
                setViewTab('workspace'); // Open inside editor tab
              }}
              activeFilePath={activeFilePath || undefined}
              nodeGravity={settings.graphNodeGravity}
              repulsionStrength={settings.graphRepulsionStrength}
              springLength={settings.graphSpringLength}
              onPrefetchAll={preloadAllVaultFiles}
              prefetchStatus={prefetchStatus}
              prefetchProgress={prefetchProgress}
            />
          ) : isLoadingFile ? (
            <div className="flex flex-col gap-3.5 items-center justify-center h-full w-full text-muted-foreground text-sm">
              <RefreshCw className="w-6 h-6 animate-spin text-primary" />
              <span>Fetching file content from GitHub...</span>
            </div>
          ) : activeFilePath && activeFilePath.endsWith('.canvas') && fileContents[activeFilePath] !== undefined ? (
            <CanvasView
              key={activeFilePath}
              filePath={activeFilePath}
              initialContent={fileContents[activeFilePath]}
              initialSha={activeFile?.sha || null}
              files={files}
              fileContents={fileContents}
              onSave={(content, sha) => handleSaveFile(activeFilePath, content, sha)}
              onOpenNote={(path) => {
                handleOpenNote(path);
                setViewTab('workspace');
              }}
              vaultId={repoName}
              onLoadFileContent={preloadFileContent}
              vaultImages={vaultImages}
              onFetchBinaryFile={loadBinaryFile}
              onUploadAttachment={(file) => uploadAttachment(file, undefined, false)}
            />
          ) : activeFilePath && activeFilePath.endsWith('.base') && fileContents[activeFilePath] !== undefined ? (
            <BaseEditor
              key={activeFilePath}
              filePath={activeFilePath}
              initialContent={fileContents[activeFilePath]}
              initialSha={activeFile?.sha || null}
              files={files}
              fileContents={fileContents}
              onSave={(content, sha) => handleSaveFile(activeFilePath, content, sha)}
              onSaveFile={handleSaveFile}
              onOpenNote={(path) => {
                handleOpenNote(path);
                setViewTab('workspace');
              }}
              onLoadFileContent={preloadFileContent}
              onCreateFile={(ext, folderPath) => createNewFile(ext, folderPath)}
              onPrefetchAll={preloadAllVaultFiles}
              prefetchStatus={prefetchStatus}
              prefetchProgress={prefetchProgress}
            />
          ) : activeFilePath && isTextFile(activeFilePath) && fileContents[activeFilePath] !== undefined ? (
            <Editor
              key={activeFilePath}
              filePath={activeFilePath}
              initialContent={fileContents[activeFilePath]}
              initialSha={activeFile?.sha || null}
              files={files}
              onSave={(content, sha) => handleSaveFile(activeFilePath, content, sha)}
              onOpenNote={(path) => {
                handleOpenNote(path);
                setViewTab('workspace');
              }}
              vaultId={repoName}
              vaultImages={vaultImages}
              onFetchBinaryFile={loadBinaryFile}
              onUploadAttachment={(file, folderPath) => uploadAttachment(file, folderPath, false)}
              initialSearchLineIndex={activeFileTargetLine}
              onClearTargetLine={() => setActiveFileTargetLine(undefined)}
            />
          ) : activeFilePath ? (
            <div className="flex-1 w-full h-full flex flex-col bg-background select-text overflow-y-auto items-center p-8">
              <div className="max-w-3xl w-full bg-card/40 border border-border rounded-2xl p-6 shadow-xl flex flex-col gap-6 items-center">
                <div className="w-full flex items-center justify-between border-b border-border/80 pb-4">
                  <div className="flex flex-col">
                    <span className="text-sm font-bold text-foreground">
                      {activeFilePath.split('/').pop()}
                    </span>
                    <span className="text-[0.7rem] text-muted-foreground mt-0.5">
                      Path: {activeFilePath}
                    </span>
                  </div>
                  {activeFile && activeFile.size && (
                    <span className="text-[0.7rem] font-semibold bg-muted text-muted-foreground px-2 py-1 rounded-md">
                      {(activeFile.size / 1024).toFixed(1)} KB
                    </span>
                  )}
                </div>

                <div className="w-full flex items-center justify-center min-h-[300px] border border-dashed border-border/80 rounded-xl bg-background/50 overflow-hidden relative p-4">
                  {[
                    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf'
                  ].some(ext => activeFilePath.toLowerCase().endsWith(ext)) ? (
                    vaultImages[activeFilePath] ? (
                      activeFilePath.toLowerCase().endsWith('.pdf') ? (
                        <div className="flex flex-col items-center justify-center max-w-md w-full mx-auto text-center animate-fade-in">
                          <div className="w-16 h-16 rounded-2xl bg-red-500/10 text-red-500 flex items-center justify-center mb-4 border border-red-500/20">
                            <Paperclip className="w-8 h-8" />
                          </div>
                          <h3 className="text-base font-bold text-foreground mb-1">{activeFilePath.split('/').pop()}</h3>
                          <p className="text-xs text-muted-foreground mb-6 max-w-xs leading-relaxed">
                            PDF embedding is restricted by modern browser security. Open it in a new tab to view, or download it.
                          </p>
                          <div className="flex flex-col sm:flex-row gap-3 w-full justify-center">
                            <a
                              href={vaultImages[activeFilePath]}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center justify-center gap-2 px-4 py-2 bg-primary hover:bg-primary/90 text-primary-foreground text-xs font-semibold rounded-lg transition-all cursor-pointer shadow-md shadow-primary/20"
                            >
                              Open PDF in New Tab
                            </a>
                            <button
                              onClick={() => {
                                const link = document.createElement('a');
                                link.href = vaultImages[activeFilePath];
                                link.download = activeFilePath.split('/').pop() || 'document.pdf';
                                document.body.appendChild(link);
                                link.click();
                                document.body.removeChild(link);
                              }}
                              className="flex items-center justify-center gap-2 px-4 py-2 bg-muted hover:bg-muted/80 text-foreground text-xs font-semibold rounded-lg transition-all cursor-pointer border border-border"
                            >
                              Download PDF
                            </button>
                          </div>
                        </div>
                      ) : (
                        <img
                          src={vaultImages[activeFilePath]}
                          alt={activeFilePath.split('/').pop()}
                          className="max-h-[500px] max-w-full object-contain rounded-lg shadow-lg select-none animate-fade-in"
                        />
                      )
                    ) : (
                      <div className="flex flex-col gap-2 items-center justify-center text-muted-foreground text-xs">
                        <RefreshCw className="w-5 h-5 animate-spin text-primary" />
                        <span>Loading attachment...</span>
                        {activeFile && (
                          <button
                            onClick={() => loadBinaryFile(activeFilePath, activeFile.sha)}
                            className="mt-2 text-primary font-semibold hover:underline"
                          >
                            Click to retry loading
                          </button>
                        )}
                      </div>
                    )
                  ) : (
                    <div className="flex flex-col gap-3 items-center justify-center text-muted-foreground p-6 text-center select-none animate-fade-in">
                      <div className="w-12 h-12 rounded-2xl bg-muted border border-border flex items-center justify-center text-muted-foreground">
                        <Paperclip className="w-6 h-6 text-primary animate-pulse-soft" />
                      </div>
                      <span className="text-xs font-bold text-foreground">
                        No Preview Available
                      </span>
                      <span className="text-[0.7rem] text-muted-foreground max-w-[280px] leading-relaxed">
                        This attachment type ({activeFilePath.substring(activeFilePath.lastIndexOf('.'))}) cannot be previewed directly in the browser.
                      </span>
                      {activeFile && (
                        <button
                          onClick={() => handleDownloadFile(activeFilePath, activeFile.name, activeFile.sha)}
                          className="mt-2 bg-primary hover:bg-primary/90 text-white text-xs font-semibold py-1.5 px-4 rounded-xl transition-all cursor-pointer shadow-lg shadow-primary/10 flex items-center gap-1.5"
                        >
                          <Download size={12} />
                          Download Attachment
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full w-full p-10 text-center text-muted-foreground bg-background">
              <Folder className="w-10 h-10 text-muted-foreground/30 mb-3 animate-float" />
              <span className="font-semibold text-sm text-foreground/80">No Note Selected</span>
              <span className="text-xs text-muted-foreground/75 mt-1 max-w-[280px] leading-relaxed">
                Select an existing file in the sidebar or click "New Note" to begin journaling.
              </span>
            </div>
          )}
        </div>
      </main>

      {/* 3. Premium Glassmorphic Confirmation Dialogs */}
      {/* Delete Confirmation Modal */}
      {pendingDeleteFile && (
        <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-sm bg-card/95 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-destructive/15 flex items-center justify-center text-destructive shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div className="flex flex-col">
                <h3 className="font-heading font-bold text-base text-foreground">
                  Delete Note
                </h3>
                <span className="text-[0.7rem] text-muted-foreground font-medium">
                  This action is permanent and cannot be undone.
                </span>
              </div>
            </div>

            <p className="text-xs text-foreground/80 leading-relaxed font-medium bg-white/[0.02] border border-border/50 rounded-xl p-3">
              Are you sure you want to delete <span className="text-destructive font-semibold">"{pendingDeleteFile.path.split('/').pop()}"</span> from your vault?
            </p>

            <div className="flex gap-2.5 mt-2">
              <button
                type="button"
                onClick={() => setPendingDeleteFile(null)}
                className="flex-1 h-10 rounded-xl border border-border text-xs font-semibold hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                className="flex-1 h-10 rounded-xl bg-destructive hover:bg-destructive/90 text-white text-xs font-semibold transition-all cursor-pointer shadow-lg shadow-destructive/20"
              >
                Delete Note
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Prompt Modal */}
      {pendingRenameFile && (
        <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={() => setPendingRenameFile(null)}>
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={handleRenameFile}
            className="w-full max-w-sm bg-card/95 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center text-primary shrink-0">
                <Edit3 className="w-5 h-5" />
              </div>
              <div className="flex flex-col">
                <h3 className="font-heading font-bold text-base text-foreground">
                  Rename Note
                </h3>
                <span className="text-[0.7rem] text-muted-foreground font-medium">
                  Change the name of your file in the repository.
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[0.7rem] font-bold text-muted-foreground uppercase tracking-widest px-1">
                New Filename
              </span>
              <div className="relative flex items-center">
                <input
                  type="text"
                  value={renameInputValue}
                  onChange={(e) => {
                    setRenameInputValue(e.target.value);
                    setRenameError('');
                  }}
                  placeholder="Enter name..."
                  autoFocus
                  className="w-full bg-muted/50 border border-border text-foreground pl-4 pr-16 py-2.5 rounded-xl text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200"
                />
                <span className="absolute right-4 text-xs font-bold text-muted-foreground uppercase select-none pointer-events-none">
                  {pendingRenameFile.path.substring(pendingRenameFile.path.lastIndexOf('.'))}
                </span>
              </div>
              {renameError && (
                <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 flex items-start gap-2.5 mt-1.5">
                  <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                  <span className="text-[0.7rem] font-semibold text-destructive">
                    {renameError}
                  </span>
                </div>
              )}
            </div>

            <div className="flex gap-2.5 mt-2">
              <button
                type="button"
                onClick={() => setPendingRenameFile(null)}
                className="flex-1 h-10 rounded-xl border border-border text-xs font-semibold hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 h-10 rounded-xl bg-gradient-to-r from-primary to-accent hover:from-primary/90 hover:to-accent/90 text-white text-xs font-semibold transition-all cursor-pointer shadow-lg shadow-primary/20"
              >
                Rename
              </button>
            </div>
          </form>
        </div>
      )}
      {/* Create Folder Modal */}
      {showCreateFolderModal && (
        <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              const cleanName = newFolderName.trim();

              // Validation 1: Empty name
              if (!cleanName) {
                setFolderCreationError('Folder name cannot be empty.');
                return;
              }

              // Validation 2: Invalid characters
              if (/[/\\:*?"<>|]/.test(cleanName)) {
                setFolderCreationError('Folder name contains invalid characters.');
                return;
              }

              // Validation 3: Check for duplicate folder
              const targetPath = parentFolderPathForNewFolder && parentFolderPathForNewFolder !== '/'
                ? `${parentFolderPathForNewFolder}/${cleanName}`
                : cleanName;
              const gitkeepPath = `${targetPath}/.gitkeep`;
              const targetPathLower = targetPath.toLowerCase();

              if (files.some(f => f.path.toLowerCase() === gitkeepPath.toLowerCase() || f.path.toLowerCase().startsWith(targetPathLower + '/'))) {
                setFolderCreationError(`A folder named "${cleanName}" already exists.`);
                return;
              }

              setFolderCreationError('');
              handleCreateFolder(targetPath);
              setShowCreateFolderModal(false);
              setNewFolderName('');
            }}
            className="w-full max-w-sm bg-card/95 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center text-primary shrink-0">
                <FolderPlus className="w-5 h-5" />
              </div>
              <div className="flex flex-col">
                <h3 className="font-heading font-bold text-base text-foreground">
                  Create Folder
                </h3>
                <span className="text-[0.7rem] text-muted-foreground font-medium">
                  {parentFolderPathForNewFolder && parentFolderPathForNewFolder !== '/'
                    ? `Creating inside: ${parentFolderPathForNewFolder}`
                    : 'Creating at vault root'}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[0.7rem] font-bold text-muted-foreground uppercase tracking-widest px-1">
                Folder Name
              </span>
              <input
                type="text"
                value={newFolderName}
                onChange={(e) => {
                  setNewFolderName(e.target.value);
                  setFolderCreationError('');
                }}
                placeholder="Enter folder name..."
                autoFocus
                required
                className="w-full bg-muted/50 border border-border text-foreground px-4 py-2.5 rounded-xl text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200"
              />
              {folderCreationError && (
                <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                  <span className="text-[0.7rem] font-semibold text-destructive">
                    {folderCreationError}
                  </span>
                </div>
              )}
            </div>

            <div className="flex gap-2.5 mt-2">
              <button
                type="button"
                onClick={() => {
                  setShowCreateFolderModal(false);
                  setNewFolderName('');
                  setFolderCreationError('');
                }}
                className="flex-1 h-10 rounded-xl border border-border text-xs font-semibold hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!newFolderName.trim()}
                className="flex-1 h-10 rounded-xl bg-gradient-to-r from-primary to-accent hover:from-primary/90 hover:to-accent/90 text-white text-xs font-semibold transition-all cursor-pointer shadow-lg shadow-primary/20 disabled:opacity-50 disabled:pointer-events-none"
              >
                Create Folder
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Move/Copy Selection Modal */}
      {pendingMoveCopyFile && (
        <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={() => setPendingMoveCopyFile(null)}>
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (!moveCopyNameInput.trim()) return;
              const ext = pendingMoveCopyFile.path.substring(pendingMoveCopyFile.path.lastIndexOf('.'));
              const cleanName = moveCopyNameInput.trim() + ext;
              const targetPath = moveCopyFolderSelect && moveCopyFolderSelect !== '/'
                ? `${moveCopyFolderSelect}/${cleanName}`
                : cleanName;

              // Check if target file already exists (only for move/copy, not rename)
              const targetPathLower = targetPath.toLowerCase();
              if (files.some(f => f.path.toLowerCase() === targetPathLower)) {
                setMoveCopyError(`A file named "${cleanName}" already exists at the destination.`);
                return;
              }

              setMoveCopyError('');
              if (moveCopyAction === 'copy') {
                handleCopyFile(pendingMoveCopyFile.path, targetPath);
              } else {
                handleMoveFile(pendingMoveCopyFile.path, targetPath, pendingMoveCopyFile.sha);
              }
              setPendingMoveCopyFile(null);
            }}
            className="w-full max-w-md bg-card/95 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center text-primary shrink-0">
                {moveCopyAction === 'copy' ? <Copy className="w-5 h-5" /> : <ArrowRight className="w-5 h-5" />}
              </div>
              <div className="flex flex-col">
                <h3 className="font-heading font-bold text-base text-foreground">
                  {moveCopyAction === 'copy' ? 'Copy Note' : 'Move Note'}
                </h3>
                <span className="text-[0.7rem] text-muted-foreground font-medium">
                  Specify a new folder location and note name.
                </span>
              </div>
            </div>

            {moveCopyError && (
              <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 flex items-start gap-2.5 mt-1.5">
                <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                <span className="text-[0.7rem] font-semibold text-destructive">
                  {moveCopyError}
                </span>
              </div>
            )}

            {/* File name input */}
            <div className="flex flex-col gap-1.5">
              <span className="text-[0.7rem] font-bold text-muted-foreground uppercase tracking-widest px-1">
                Note Name
              </span>
              <div className="relative flex items-center">
                <input
                  type="text"
                  value={moveCopyNameInput}
                  onChange={(e) => {
                    setMoveCopyNameInput(e.target.value);
                    setMoveCopyError('');
                  }}
                  placeholder="Enter name..."
                  required
                  className="w-full bg-muted/50 border border-border text-foreground pl-4 pr-16 py-2.5 rounded-xl text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200"
                />
                <span className="absolute right-4 text-xs font-bold text-muted-foreground uppercase select-none pointer-events-none">
                  {pendingMoveCopyFile.path.substring(pendingMoveCopyFile.path.lastIndexOf('.'))}
                </span>
              </div>
            </div>

            {/* Destination folder custom dropdown popover */}
            <div className="flex flex-col gap-1.5 relative select-none">
              <span className="text-[0.7rem] font-bold text-muted-foreground uppercase tracking-widest px-1">
                Destination Folder
              </span>

              <div className="relative">
                {isMoveCopyFolderDropdownOpen && (
                  <div
                    className="fixed inset-0 z-10 bg-transparent cursor-default"
                    onClick={() => {
                      setIsMoveCopyFolderDropdownOpen(false);
                      setMoveCopyFolderSearch('');
                    }}
                  />
                )}

                <button
                  type="button"
                  onClick={() => setIsMoveCopyFolderDropdownOpen(!isMoveCopyFolderDropdownOpen)}
                  className="w-full bg-muted/50 border border-border text-foreground px-4 py-2.5 rounded-xl text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200 cursor-pointer flex items-center justify-between text-left relative z-20"
                >
                  <span className="flex items-center gap-2">
                    {moveCopyFolderSelect === '/' ? (
                      <>
                        <Compass className="w-3.5 h-3.5 text-accent" />
                        <span>Vault Root ( / )</span>
                      </>
                    ) : (
                      <>
                        <Folder className="w-3.5 h-3.5 text-primary" />
                        <span>{moveCopyFolderSelect}</span>
                      </>
                    )}
                  </span>
                  <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform shrink-0 ml-2", isMoveCopyFolderDropdownOpen && "transform rotate-180")} />
                </button>

                {isMoveCopyFolderDropdownOpen && (
                  <div className="absolute top-full left-0 w-full mt-1.5 bg-[#12131a]/95 backdrop-blur-xl border border-border rounded-xl shadow-2xl p-1.5 flex flex-col gap-1 z-30 animate-in fade-in zoom-in-95 duration-100">

                    {/* Inline Filter Search Input */}
                    <div className="relative flex items-center px-1 py-1 border-b border-border/40 pb-1.5">
                      <Compass className="absolute left-2.5 w-3.5 h-3.5 text-muted-foreground/60" />
                      <input
                        type="text"
                        value={moveCopyFolderSearch}
                        onChange={(e) => setMoveCopyFolderSearch(e.target.value)}
                        placeholder="Search folders..."
                        className="w-full bg-muted/30 border border-border/40 text-foreground pl-7 pr-3 py-1.5 rounded-lg text-xs focus:outline-none focus:border-primary/60 transition-all duration-150"
                        onClick={(e) => e.stopPropagation()}
                      />
                    </div>

                    <div className="max-h-[160px] overflow-y-auto flex flex-col gap-0.5 mt-1 pr-0.5">
                      {/* Root Option */}
                      {('/'.toLowerCase().includes(moveCopyFolderSearch.toLowerCase()) || 'vault root'.includes(moveCopyFolderSearch.toLowerCase())) && (
                        <button
                          key="root-opt"
                          type="button"
                          onClick={() => {
                            setMoveCopyFolderSelect('/');
                            setIsMoveCopyFolderDropdownOpen(false);
                            setMoveCopyFolderSearch('');
                          }}
                          className={cn(
                            "w-full text-left px-3 py-2 rounded-lg text-xs transition-premium cursor-pointer font-semibold border border-transparent flex items-center justify-between",
                            moveCopyFolderSelect === '/'
                              ? "bg-gradient-to-r from-primary/15 to-accent/10 text-accent"
                              : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                          )}
                        >
                          <span className="flex items-center gap-2">
                            <Compass className="w-3.5 h-3.5 shrink-0" />
                            <span>Vault Root ( / )</span>
                          </span>
                          {moveCopyFolderSelect === '/' && (
                            <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft shrink-0 ml-2" />
                          )}
                        </button>
                      )}

                      {/* All Other Folders */}
                      {Array.from(new Set(
                        files
                          .map(f => f.path.substring(0, f.path.lastIndexOf('/')))
                          .filter(folder => folder !== '')
                      ))
                        .sort()
                        .filter(folder => folder.toLowerCase().includes(moveCopyFolderSearch.toLowerCase()))
                        .map(folder => {
                          const isSelected = moveCopyFolderSelect === folder;
                          const depth = folder.split('/').length;
                          return (
                            <button
                              key={folder}
                              type="button"
                              onClick={() => {
                                setMoveCopyFolderSelect(folder);
                                setIsMoveCopyFolderDropdownOpen(false);
                                setMoveCopyFolderSearch('');
                              }}
                              style={{ paddingLeft: `${depth * 8 + 8}px` }}
                              className={cn(
                                "w-full text-left pr-3 py-2 rounded-lg text-xs transition-premium cursor-pointer font-semibold border border-transparent flex items-center justify-between",
                                isSelected
                                  ? "bg-gradient-to-r from-primary/15 to-accent/10 text-accent"
                                  : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                              )}
                            >
                              <span className="flex items-center gap-2">
                                <Folder className="w-3.5 h-3.5 text-primary/70 shrink-0" />
                                <span>{folder}</span>
                              </span>
                              {isSelected && (
                                <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft shrink-0 ml-2" />
                              )}
                            </button>
                          );
                        })}
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="flex gap-2.5 mt-4">
              <button
                type="button"
                onClick={() => {
                  setPendingMoveCopyFile(null);
                  setMoveCopyError('');
                }}
                className="flex-1 h-10 rounded-xl border border-border text-xs font-semibold hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 h-10 rounded-xl bg-gradient-to-r from-primary to-accent hover:from-primary/90 hover:to-accent/90 text-white text-xs font-semibold transition-all cursor-pointer shadow-lg shadow-primary/20"
              >
                Confirm {moveCopyAction === 'copy' ? 'Copy' : 'Move'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Delete Folder Modal */}
      {pendingDeleteFolder && (
        <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={() => setPendingDeleteFolder(null)}>
          <div className="w-full max-w-sm bg-card/95 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-destructive/15 flex items-center justify-center text-destructive shrink-0">
                <Trash2 className="w-5 h-5" />
              </div>
              <div className="flex flex-col">
                <h3 className="font-heading font-bold text-base text-foreground">
                  Delete Folder
                </h3>
                <span className="text-[0.7rem] text-muted-foreground font-medium">
                  This will delete the folder and all its contents!
                </span>
              </div>
            </div>

            <p className="text-xs text-foreground/80 leading-relaxed font-medium bg-white/[0.02] border border-border/50 rounded-xl p-3">
              Are you sure you want to delete <span className="text-destructive font-semibold">"{pendingDeleteFolder}"</span> and all notes/subfolders inside it? This action is permanent and cannot be undone.
            </p>

            <div className="flex gap-2.5 mt-2">
              <button
                type="button"
                onClick={() => setPendingDeleteFolder(null)}
                className="flex-1 h-10 rounded-xl border border-border text-xs font-semibold hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  handleConfirmDeleteFolder(pendingDeleteFolder);
                  setPendingDeleteFolder(null);
                }}
                className="flex-1 h-10 rounded-xl bg-destructive hover:bg-destructive/90 text-white text-xs font-semibold transition-all cursor-pointer shadow-lg shadow-destructive/20"
              >
                Delete Folder
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Folder Modal */}
      {pendingRenameFolder && (
        <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={() => setPendingRenameFolder(null)}>
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              const cleanName = folderRenameInputValue.trim();
              
              if (!cleanName) {
                setFolderRenameError('Folder name cannot be empty.');
                return;
              }
              
              if (/[/\\:*?"<>|]/.test(cleanName)) {
                setFolderRenameError('Folder name contains invalid characters.');
                return;
              }
              
              const oldName = pendingRenameFolder.split('/').pop() || '';
              if (cleanName === oldName) {
                setPendingRenameFolder(null);
                return;
              }
              
              const parentPath = pendingRenameFolder.includes('/') ? pendingRenameFolder.substring(0, pendingRenameFolder.lastIndexOf('/')) : '';
              const newFolderPath = parentPath ? `${parentPath}/${cleanName}` : cleanName;
              
              // Check if folder already exists (case-insensitive)
              const gitkeepPath = `${newFolderPath}/.gitkeep`;
              const newFolderPathLower = newFolderPath.toLowerCase();
              if (files.some(f => f.path.toLowerCase() === gitkeepPath.toLowerCase() || f.path.toLowerCase().startsWith(newFolderPathLower + '/'))) {
                setFolderRenameError(`A folder named "${cleanName}" already exists.`);
                return;
              }
              
              setFolderRenameError('');
              handleRenameFolder(pendingRenameFolder, cleanName);
              setPendingRenameFolder(null);
              setFolderRenameInputValue('');
            }}
            className="w-full max-w-sm bg-card/95 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center text-primary shrink-0">
                <Edit3 className="w-5 h-5" />
              </div>
              <div className="flex flex-col">
                <h3 className="font-heading font-bold text-base text-foreground">
                  Rename Folder
                </h3>
                <span className="text-[0.7rem] text-muted-foreground font-medium">
                  Change the folder name in the repository.
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[0.7rem] font-bold text-muted-foreground uppercase tracking-widest px-1">
                New Folder Name
              </span>
              <input
                type="text"
                value={folderRenameInputValue}
                onChange={(e) => {
                  setFolderRenameInputValue(e.target.value);
                  setFolderRenameError('');
                }}
                placeholder="Enter folder name..."
                autoFocus
                className="w-full bg-muted/50 border border-border text-foreground pl-4 py-2.5 rounded-xl text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200"
              />
              {folderRenameError && (
                <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 flex items-start gap-2.5">
                  <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                  <span className="text-[0.7rem] font-semibold text-destructive">
                    {folderRenameError}
                  </span>
                </div>
              )}
            </div>

            <div className="flex gap-2.5 mt-2">
              <button
                type="button"
                onClick={() => {
                  setPendingRenameFolder(null);
                  setFolderRenameInputValue('');
                  setFolderRenameError('');
                }}
                className="flex-1 h-10 rounded-xl border border-border text-xs font-semibold hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 h-10 rounded-xl bg-gradient-to-r from-primary to-accent hover:from-primary/90 hover:to-accent/90 text-white text-xs font-semibold transition-all cursor-pointer shadow-lg shadow-primary/20"
              >
                Rename
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Move/Copy Folder Modal */}
      {pendingMoveCopyFolder && (
        <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in" onClick={() => setPendingMoveCopyFolder(null)}>
          <form
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              if (!folderMoveCopyNameInput.trim()) return;

              const targetFolderPath = folderMoveCopyDestFolder && folderMoveCopyDestFolder !== '/'
                ? `${folderMoveCopyDestFolder}/${folderMoveCopyNameInput}`
                : folderMoveCopyNameInput;

              // Check if target folder already exists (case-insensitive)
              const gitkeepPath = `${targetFolderPath}/.gitkeep`;
              const targetFolderPathLower = targetFolderPath.toLowerCase();
              if (files.some(f => f.path.toLowerCase() === gitkeepPath.toLowerCase() || f.path.toLowerCase().startsWith(targetFolderPathLower + '/'))) {
                setFolderMoveCopyError(`A folder named "${folderMoveCopyNameInput}" already exists at the destination.`);
                return;
              }

              setFolderMoveCopyError('');
              if (folderMoveCopyAction === 'copy') {
                handleCopyFolder(pendingMoveCopyFolder, folderMoveCopyDestFolder, folderMoveCopyNameInput);
              } else {
                handleMoveFolder(pendingMoveCopyFolder, folderMoveCopyDestFolder);
              }
              setPendingMoveCopyFolder(null);
            }}
            className="w-full max-w-md bg-card/95 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-primary/15 flex items-center justify-center text-primary shrink-0">
                {folderMoveCopyAction === 'copy' ? <Copy className="w-5 h-5" /> : <ArrowRight className="w-5 h-5" />}
              </div>
              <div className="flex flex-col">
                <h3 className="font-heading font-bold text-base text-foreground">
                  {folderMoveCopyAction === 'copy' ? 'Copy Folder' : 'Move Folder'}
                </h3>
                <span className="text-[0.7rem] text-muted-foreground font-medium">
                  Specify a new folder location and name.
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-2.5">
              <div className="flex flex-col gap-1.5">
                <span className="text-[0.7rem] font-bold text-muted-foreground uppercase tracking-widest px-1">
                  {folderMoveCopyAction === 'copy' ? 'New Folder Name' : 'Folder Name'}
                </span>
                <input
                  type="text"
                  value={folderMoveCopyNameInput}
                  onChange={(e) => {
                    setFolderMoveCopyNameInput(e.target.value);
                    setFolderMoveCopyError('');
                  }}
                  placeholder="Enter folder name..."
                  autoFocus
                  className="w-full bg-muted/50 border border-border text-foreground px-4 py-2.5 rounded-xl text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200"
                />
              </div>

              <div className="flex flex-col gap-1.5">
                <span className="text-[0.7rem] font-bold text-muted-foreground uppercase tracking-widest px-1">
                  Destination Folder
                </span>

                {folderMoveCopyError && (
                  <div className="bg-destructive/10 border border-destructive/30 rounded-lg p-3 flex items-start gap-2.5">
                    <AlertTriangle className="w-4 h-4 text-destructive shrink-0 mt-0.5" />
                    <span className="text-[0.7rem] font-semibold text-destructive">
                      {folderMoveCopyError}
                    </span>
                  </div>
                )}

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setIsFolderMoveCopyDestDropdownOpen(!isFolderMoveCopyDestDropdownOpen)}
                    className="w-full bg-muted/50 border border-border text-foreground px-4 py-2.5 rounded-xl text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200 cursor-pointer flex items-center justify-between text-left relative z-20"
                  >
                    <span className="flex items-center gap-2">
                      {folderMoveCopyDestFolder === '/' ? (
                        <>
                          <Compass className="w-3.5 h-3.5 text-accent" />
                          <span>Vault Root ( / )</span>
                        </>
                      ) : (
                        <>
                          <Folder className="w-3.5 h-3.5 text-primary" />
                          <span>{folderMoveCopyDestFolder}</span>
                        </>
                      )}
                    </span>
                    <ChevronDown className={cn("w-4 h-4 text-muted-foreground transition-transform shrink-0 ml-2", isFolderMoveCopyDestDropdownOpen && "transform rotate-180")} />
                  </button>

                  {isFolderMoveCopyDestDropdownOpen && (
                    <div className="absolute top-full left-0 w-full mt-1.5 bg-[#12131a]/95 backdrop-blur-xl border border-border rounded-xl shadow-2xl p-1.5 flex flex-col gap-1 z-30 animate-in fade-in zoom-in-95 duration-100">
                      <div className="relative flex items-center px-1 py-1 border-b border-border/40 pb-1.5">
                        <Compass className="absolute left-2.5 w-3.5 h-3.5 text-muted-foreground/60" />
                        <input
                          type="text"
                          value={folderMoveCopyDestSearch}
                          onChange={(e) => setFolderMoveCopyDestSearch(e.target.value)}
                          placeholder="Search folders..."
                          className="w-full bg-muted/30 border border-border/40 text-foreground pl-7 pr-3 py-1.5 rounded-lg text-xs focus:outline-none focus:border-primary/60 transition-all duration-150"
                          onClick={(e) => e.stopPropagation()}
                        />
                      </div>

                      <div className="max-h-[160px] overflow-y-auto flex flex-col gap-0.5 mt-1 pr-0.5">
                        {('/'.toLowerCase().includes(folderMoveCopyDestSearch.toLowerCase()) || 'vault root'.includes(folderMoveCopyDestSearch.toLowerCase())) && (
                          <button
                            key="root-opt"
                            type="button"
                            onClick={() => {
                              setFolderMoveCopyDestFolder('/');
                              setIsFolderMoveCopyDestDropdownOpen(false);
                              setFolderMoveCopyDestSearch('');
                            }}
                            className="w-full text-left px-3 py-1.5 hover:bg-primary/20 rounded-lg text-xs font-medium text-foreground flex items-center gap-2.5 transition-all cursor-pointer"
                          >
                            <Compass className="w-3.5 h-3.5 text-accent" />
                            <span>Vault Root ( / )</span>
                            {folderMoveCopyDestFolder === '/' && (
                              <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft shrink-0 ml-2" />
                            )}
                          </button>
                        )}
                        {buildFolderTree(files).map((node) => {
                          const renderFolderOption = (folder: TreeFolder | TreeFile, depth: number): React.ReactNode[] => {
                            if (folder.type !== 'folder') return [];
                            if (folder.path === pendingMoveCopyFolder) return [];
                            if (!folder.path.toLowerCase().includes(folderMoveCopyDestSearch.toLowerCase())) {
                              if (!(folder as TreeFolder).children?.some((c) => c.type === 'folder' && c.path.toLowerCase().includes(folderMoveCopyDestSearch.toLowerCase()))) {
                                return [];
                              }
                            }

                            const isSelected = folderMoveCopyDestFolder === folder.path;
                            const nodes: React.ReactNode[] = [];

                            if (folder.path.toLowerCase().includes(folderMoveCopyDestSearch.toLowerCase())) {
                              nodes.push(
                                <button
                                  key={`folder-${folder.path}`}
                                  type="button"
                                  onClick={() => {
                                    setFolderMoveCopyDestFolder(folder.path);
                                    setIsFolderMoveCopyDestDropdownOpen(false);
                                    setFolderMoveCopyDestSearch('');
                                  }}
                                  style={{ paddingLeft: `${(depth + 1) * 12}px` }}
                                  className="w-full text-left px-3 py-1.5 hover:bg-primary/20 rounded-lg text-xs font-medium text-foreground flex items-center gap-2.5 transition-all cursor-pointer"
                                >
                                  <Folder className="w-3.5 h-3.5 text-primary shrink-0" />
                                  <span>{folder.name}</span>
                                  {isSelected && (
                                    <div className="w-1.5 h-1.5 rounded-full bg-accent animate-pulse-soft shrink-0 ml-2" />
                                  )}
                                </button>
                              );
                            }

                            if (folder.children) {
                              for (const child of folder.children) {
                                nodes.push(...renderFolderOption(child, depth + 1));
                              }
                            }

                            return nodes;
                          };

                          return renderFolderOption(node, 0);
                        })}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div className="flex gap-2.5 mt-4">
              <button
                type="button"
                onClick={() => {
                  setPendingMoveCopyFolder(null);
                  setFolderMoveCopyError('');
                }}
                className="flex-1 h-10 rounded-xl border border-border text-xs font-semibold hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="flex-1 h-10 rounded-xl bg-gradient-to-r from-primary to-accent hover:from-primary/90 hover:to-accent/90 text-white text-xs font-semibold transition-all cursor-pointer shadow-lg shadow-primary/20"
              >
                Confirm {folderMoveCopyAction === 'copy' ? 'Copy' : 'Move'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Conflict Resolution Modal */}
      <ConflictResolutionModal
        isOpen={showConflictModal}
        onClose={() => setShowConflictModal(false)}
        conflictingFiles={conflictingFiles}
        unsyncedPaths={getUnsyncedFiles()}
        onKeepLocal={resolveKeepLocal}
        onKeepRemote={resolveKeepRemote}
        onKeepAllLocal={resolveAllLocal}
        onKeepAllRemote={resolveAllRemote}
      />

      {/* Global Vault Search Modal */}
      <SearchModal
        isOpen={showSearchModal}
        onClose={() => setShowSearchModal(false)}
        files={files}
        fileContents={fileContents}
        onOpenNote={handleOpenNoteWithLine}
        onPrefetchAll={preloadAllVaultFiles}
        prefetchStatus={prefetchStatus}
        prefetchProgress={prefetchProgress}
      />

      {/* Settings Modal */}
      {showSettingsModal && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-fade-in">
          <div className="w-full max-w-lg bg-card/95 backdrop-blur-2xl border border-border rounded-2xl p-6 shadow-2xl flex flex-col gap-5 animate-in fade-in zoom-in-95 duration-200 text-foreground">

            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-border/60 pb-3 select-none">
              <div className="flex items-center gap-2">
                <Settings size={18} className="text-primary animate-spin-slow" />
                <h3 className="font-heading font-bold text-lg">Starfish Settings</h3>
              </div>
              <button
                type="button"
                onClick={() => setShowSettingsModal(false)}
                className="text-muted-foreground hover:text-foreground p-1 hover:bg-white/[0.04] rounded-lg cursor-pointer transition-all border border-transparent"
              >
                ✕
              </button>
            </div>

            {/* Scrollable Content */}
            <div className="flex flex-col gap-5 max-h-[420px] overflow-y-auto pr-1 no-scrollbar select-text">

              {/* Category 1: Attachment Storage */}
              <div className="flex flex-col gap-3.5 bg-white/[0.015] border border-border/40 p-4 rounded-xl">
                <h4 className="text-[0.72rem] font-bold text-primary uppercase tracking-widest flex items-center gap-1.5 select-none">
                  <Folder size={11.5} />
                  Attachment Settings
                </h4>

                {/* Folder Path */}
                <div className="flex flex-col gap-1.5">
                  <label className="text-[0.7rem] font-bold text-muted-foreground uppercase tracking-wider">
                    Attachments Folder
                  </label>
                  <input
                    type="text"
                    value={settings.attachmentsFolder}
                    onChange={(e) => updateSettings({ attachmentsFolder: e.target.value })}
                    placeholder="attachments"
                    className="w-full bg-muted/40 border border-border text-foreground px-3 py-2 rounded-xl text-xs focus:outline-none focus:border-primary transition-all duration-200"
                  />
                  <span className="text-[0.62rem] text-muted-foreground/60 leading-normal">
                    Target folder path inside repository where files uploaded via Editor paperclip will be stored.
                  </span>
                </div>

                {/* File size ceiling */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center">
                    <label className="text-[0.7rem] font-bold text-muted-foreground uppercase tracking-wider">
                      Max Upload Size Limit
                    </label>
                    <span className="text-[0.75rem] font-bold text-accent">
                      {settings.maxAttachmentSize} MB
                    </span>
                  </div>
                  <input
                    type="range"
                    min="1"
                    max="25"
                    value={settings.maxAttachmentSize}
                    onChange={(e) => updateSettings({ maxAttachmentSize: parseInt(e.target.value, 10) })}
                    className="w-full h-1 bg-muted rounded-lg appearance-none cursor-pointer accent-primary animate-pulse-soft"
                  />
                  <span className="text-[0.62rem] text-muted-foreground/60 leading-normal">
                    Ceiling upload capability to prevent huge payloads (max 25MB).
                  </span>
                </div>
              </div>

              {/* Category 2: Link Map Graph settings */}
              <div className="flex flex-col gap-3.5 bg-white/[0.015] border border-border/40 p-4 rounded-xl">
                <h4 className="text-[0.72rem] font-bold text-primary uppercase tracking-widest flex items-center gap-1.5 select-none">
                  <Network size={11.5} />
                  Graph Physics Tuning
                </h4>

                {/* Node Gravity */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center">
                    <label className="text-[0.7rem] font-bold text-muted-foreground uppercase tracking-wider">
                      Center Gravity (Force)
                    </label>
                    <span className="text-[0.75rem] font-bold text-accent">
                      {settings.graphNodeGravity.toFixed(3)}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="0.001"
                    max="0.100"
                    step="0.001"
                    value={settings.graphNodeGravity}
                    onChange={(e) => updateSettings({ graphNodeGravity: parseFloat(e.target.value) })}
                    className="w-full h-1 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                  />
                </div>

                {/* Repulsion */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center">
                    <label className="text-[0.7rem] font-bold text-muted-foreground uppercase tracking-wider">
                      Node Repulsion (Charge)
                    </label>
                    <span className="text-[0.75rem] font-bold text-accent">
                      {settings.graphRepulsionStrength}
                    </span>
                  </div>
                  <input
                    type="range"
                    min="50"
                    max="500"
                    value={settings.graphRepulsionStrength}
                    onChange={(e) => updateSettings({ graphRepulsionStrength: parseInt(e.target.value, 10) })}
                    className="w-full h-1 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                  />
                </div>

                {/* Spring Length */}
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center">
                    <label className="text-[0.7rem] font-bold text-muted-foreground uppercase tracking-wider">
                      Spring Link Length
                    </label>
                    <span className="text-[0.75rem] font-bold text-accent">
                      {settings.graphSpringLength}px
                    </span>
                  </div>
                  <input
                    type="range"
                    min="40"
                    max="300"
                    value={settings.graphSpringLength}
                    onChange={(e) => updateSettings({ graphSpringLength: parseInt(e.target.value, 10) })}
                    className="w-full h-1 bg-muted rounded-lg appearance-none cursor-pointer accent-primary"
                  />
                </div>
              </div>

              {/* Category 3: Repo Connections & Authentication */}
              <div className="flex flex-col gap-3.5 bg-white/[0.015] border border-border/40 p-4 rounded-xl">
                <h4 className="text-[0.72rem] font-bold text-primary uppercase tracking-widest flex items-center gap-1.5 select-none">
                  <Compass size={11.5} />
                  Repository Settings
                </h4>

                <div className="flex items-center justify-between">
                  <div className="flex flex-col min-w-0 flex-1 pr-4">
                    <span className="text-[0.72rem] font-bold text-foreground truncate block" title={repoName}>
                      {repoName}
                    </span>
                    <span className="text-[0.62rem] text-muted-foreground mt-0.5 block font-semibold">
                      Branch: {branchName}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setShowSettingsModal(false);
                      handleLogout();
                    }}
                    className="bg-destructive/15 text-destructive border border-destructive/20 hover:bg-destructive hover:text-white transition-all text-xs font-semibold px-3 py-1.5 rounded-xl cursor-pointer shrink-0"
                  >
                    Logout & Purge Local Data
                  </button>
                </div>
              </div>

              {/* Category 4: Backup & Export */}
              <div className="flex flex-col gap-3.5 bg-white/[0.015] border border-border/40 p-4 rounded-xl">
                <h4 className="text-[0.72rem] font-bold text-primary uppercase tracking-widest flex items-center gap-1.5 select-none">
                  <Download size={11.5} />
                  Backup & Export
                </h4>
                <div className="flex flex-col gap-2">
                  <span className="text-[0.62rem] text-muted-foreground/60 leading-normal mb-1">
                    Download all notes, canvas boards, and attachments in your vault packed as a single ZIP archive. Works in both online and offline storage modes.
                  </span>
                  {bulkDownloadStatus ? (
                    <div className="flex items-center gap-2 text-xs font-semibold text-accent animate-pulse-soft bg-muted/40 border border-border px-3 py-2 rounded-xl">
                      <RefreshCw size={13} className="animate-spin text-primary shrink-0" />
                      <span className="truncate">{bulkDownloadStatus}</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={handleBulkDownload}
                      className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-primary to-accent hover:from-primary/90 hover:to-accent/90 text-white text-xs font-semibold py-2.5 px-4 rounded-xl transition-all cursor-pointer shadow-lg shadow-primary/10"
                    >
                      <Download size={13.5} />
                      <span>Export Vault as ZIP</span>
                    </button>
                  )}
                </div>
              </div>

              {/* Category 5: Publish to GitHub Cloud (Only visible in offline mode) */}
              {isOffline && (
                <div className="flex flex-col gap-3.5 bg-white/[0.015] border border-border/40 p-4 rounded-xl">
                  <h4 className="text-[0.72rem] font-bold text-primary uppercase tracking-widest flex items-center gap-1.5 select-none">
                    <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-primary animate-pulse-soft" stroke="currentColor" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
                      <path d="M9 18c-4.51 2-5-2-7-2" />
                    </svg>
                    Publish to GitHub Cloud
                  </h4>
                  <div className="flex flex-col gap-3 select-text text-foreground">
                    <span className="text-[0.62rem] text-muted-foreground/60 leading-normal mb-1 block select-none">
                      Connect a newly created <strong className="text-foreground font-bold underline decoration-primary/40 underline-offset-2">empty repository</strong> on GitHub. All your local notes, canvases, and attachments will be decrypted and uploaded to it, enabling seamless cloud syncing.
                    </span>

                    <div className="flex flex-col gap-1.5">
                      <div className="flex justify-between items-center select-none">
                        <label className="text-[0.65rem] font-bold text-muted-foreground uppercase tracking-wider">
                          GitHub Token (PAT)
                        </label>
                        <a
                          href="https://github.com/settings/tokens?type=beta"
                          target="_blank"
                          rel="noreferrer"
                          className="text-[0.65rem] text-secondary hover:text-secondary/80 font-semibold transition-colors hover:underline"
                        >
                          Create fine-grained token ↗
                        </a>
                      </div>
                      <input
                        type="password"
                        value={publishToken}
                        onChange={(e) => setPublishToken(e.target.value)}
                        placeholder="github_pat_..."
                        className="w-full bg-muted/40 border border-border text-foreground px-3 py-2 rounded-xl text-xs focus:outline-none focus:border-primary transition-all duration-200"
                      />
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-[2fr_1fr] gap-3">
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[0.65rem] font-bold text-muted-foreground uppercase tracking-wider select-none">
                          Repository Name
                        </label>
                        <input
                          type="text"
                          value={publishRepo}
                          onChange={(e) => setPublishRepo(e.target.value)}
                          placeholder="username/notes-vault"
                          className="w-full bg-muted/40 border border-border text-foreground px-3 py-2 rounded-xl text-xs focus:outline-none focus:border-primary transition-all duration-200"
                        />
                      </div>
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[0.65rem] font-bold text-muted-foreground uppercase tracking-wider select-none">
                          Branch
                        </label>
                        <input
                          type="text"
                          value={publishBranch}
                          onChange={(e) => setPublishBranch(e.target.value)}
                          placeholder="main"
                          className="w-full bg-muted/40 border border-border text-foreground px-3 py-2 rounded-xl text-xs focus:outline-none focus:border-primary transition-all duration-200"
                        />
                      </div>
                    </div>

                    {publishError && (
                      <div className="p-3 bg-destructive/10 border-l-2 border-destructive text-destructive text-xs font-semibold rounded-lg select-none">
                        {publishError}
                      </div>
                    )}

                    {publishStatus ? (
                      <div className="flex items-center justify-center gap-2 text-xs font-semibold text-accent animate-pulse-soft bg-muted/40 border border-border px-3 py-2 rounded-xl select-none">
                        <RefreshCw size={13} className="animate-spin text-primary shrink-0" />
                        <span className="truncate">{publishStatus}</span>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={handlePublishOfflineVaultToGitHub}
                        className="w-full flex items-center justify-center gap-2 bg-gradient-to-r from-primary to-accent hover:from-primary/90 hover:to-accent/90 text-white text-xs font-semibold py-2.5 px-4 rounded-xl transition-all cursor-pointer shadow-lg shadow-primary/10 select-none"
                      >
                        <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                          <polyline points="17 8 12 3 7 8" />
                          <line x1="12" y1="3" x2="12" y2="15" />
                        </svg>
                        <span>Publish Vault to GitHub</span>
                      </button>
                    )}
                  </div>
                </div>
              )}

            </div>

            {/* Modal Footer */}
            <div className="flex justify-between items-center border-t border-border/60 pt-3 select-none">
              <a
                href="https://github.com/Noob31Gen/StarfishNotes"
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 text-[0.7rem] text-muted-foreground/60 hover:text-primary transition-all duration-200 font-semibold hover:underline"
              >
                <svg viewBox="0 0 24 24" className="w-3.5 h-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
                </svg>
                Source Code
              </a>
              <button
                type="button"
                onClick={() => setShowSettingsModal(false)}
                className="bg-primary hover:bg-primary/90 text-white text-xs font-semibold px-4 py-2 rounded-xl transition-all cursor-pointer shadow-md shadow-primary/10"
              >
                Close Settings
              </button>
            </div>

          </div>
        </div>
      )}
    </div>
  );
}
