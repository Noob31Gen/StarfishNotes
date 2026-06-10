import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  Compass, Plus, Search, RefreshCw, Settings, FileText, Trash2, Edit3, GitBranch,
  Folder, FolderOpen, ChevronRight, ChevronDown, FolderPlus, Copy, ArrowRight, MoreHorizontal,
  PanelLeftClose, Paperclip, Image, Download, Database, X, AlertTriangle
} from 'lucide-react';
import type { VaultFile } from '../services/github';
import { cn } from '../utils/cn';
import { buildFolderTree, type TreeFolder, type TreeFile } from '../utils/folderTree';

interface FolderTreeItemProps {
  node: TreeFolder | TreeFile;
  activeFilePath: string | null;
  setActiveFilePath: (path: string | null) => void;
  setViewTab: (tab: 'workspace' | 'graph') => void;
  setIsMobileSidebarOpen: (open: boolean) => void;
  openFolders: Record<string, boolean>;
  toggleFolder: (path: string) => void;
  onCreateFile: (folderPath: string, extension: '.md' | '.canvas' | '.base') => void;
  onCreateFolder: (parentPath: string) => void;
  onDeleteFolder: (folderPath: string) => void;
  onRenameFolder: (folderPath: string) => void;
  onMoveFolder: (folderPath: string) => void;
  onCopyFolder: (folderPath: string) => void;
  onRenameFile: (path: string, name: string, sha: string) => void;
  onDeleteFile: (path: string, sha: string) => void;
  onCopyFile: (path: string, name: string) => void;
  onMoveFile: (path: string, name: string, sha: string) => void;
  onDownloadFile: (path: string, name: string, sha: string) => void;

  // Coordination states for active 3-dots dropdown popover menu
  activeMenuPath: string | null;
  setActiveMenuPath: (path: string | null) => void;
  activeFolderMenuPath: string | null;
  setActiveFolderMenuPath: (path: string | null) => void;

  // Highlighting for parent folder of active file
  highlightedPath: string | null;
  highlightColor: 'purple' | 'teal' | 'rose' | null;
  isFolderInActiveFilePath: (folderPath: string) => boolean;
}

// Helper function to count all files (including nested subfolders)
const countAllFiles = (children: (TreeFolder | TreeFile)[]): number => {
  return children.reduce((total, child) => {
    if (child.type === 'file') {
      return total + 1;
    } else {
      return total + countAllFiles(child.children);
    }
  }, 0);
};

const FolderTreeItemComponent: React.FC<FolderTreeItemProps> = ({
  node,
  activeFilePath,
  setActiveFilePath,
  setViewTab,
  setIsMobileSidebarOpen,
  openFolders,
  toggleFolder,
  onCreateFile,
  onCreateFolder,
  onDeleteFolder,
  onRenameFolder,
  onMoveFolder,
  onCopyFolder,
  onRenameFile,
  onDeleteFile,
  onCopyFile,
  onMoveFile,
  onDownloadFile,

  activeMenuPath,
  setActiveMenuPath,
  activeFolderMenuPath,
  setActiveFolderMenuPath,

  highlightedPath,
  highlightColor,
  isFolderInActiveFilePath,
}) => {
  // fileCount is 0 for files, computed for folders (hook must be called unconditionally)
  const fileCount = useMemo(() => {
    if (node.type === 'file') return 0;
    return countAllFiles((node as TreeFolder).children);
  }, [node]);

  if (node.type === 'file') {
    const isActive = node.path === activeFilePath;
    const isCanvas = node.path.endsWith('.canvas');
    const isBase = node.path.endsWith('.base');
    return (
      <div
        title={node.name}
        className={cn(
          "group flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer text-xs font-medium border border-transparent transition-all duration-150 hover:bg-white/[0.04] hover:text-foreground relative",
          isActive
            ? isCanvas
              ? "bg-teal-500/10 text-teal-300 font-semibold border-teal-500/15 shadow-xs"
              : isBase
                ? "bg-rose-500/10 text-rose-300 font-semibold border-rose-500/15 shadow-xs"
                : "bg-purple-500/10 text-purple-300 font-semibold border-purple-500/15 shadow-xs"
            : "text-muted-foreground/85"
        )}
        onClick={() => {
          setActiveFilePath(node.path);
          setViewTab('workspace');
          setIsMobileSidebarOpen(false);
        }}
      >
        {node.path.toLowerCase().endsWith('.png') ||
          node.path.toLowerCase().endsWith('.jpg') ||
          node.path.toLowerCase().endsWith('.jpeg') ||
          node.path.toLowerCase().endsWith('.gif') ||
          node.path.toLowerCase().endsWith('.webp') ||
          node.path.toLowerCase().endsWith('.svg') ? (
          <Image
            className={cn(
              "w-3.5 h-3.5 shrink-0 transition-colors",
              isActive ? "text-purple-300" : "text-muted-foreground/60"
            )}
          />
        ) : node.path.toLowerCase().endsWith('.pdf') ? (
          <Paperclip
            className={cn(
              "w-3.5 h-3.5 shrink-0 transition-colors",
              isActive ? "text-purple-300" : "text-muted-foreground/60"
            )}
          />
        ) : isBase ? (
          <Database
            className={cn(
              "w-3.5 h-3.5 shrink-0 transition-colors",
              isActive ? "text-rose-400 font-bold" : "text-rose-500/80"
            )}
          />
        ) : isCanvas ? (
          <FileText
            className={cn(
              "w-3.5 h-3.5 shrink-0 transition-colors",
              isActive ? "text-teal-400 font-bold" : "text-teal-500/80"
            )}
          />
        ) : (
          <FileText
            className={cn(
              "w-3.5 h-3.5 shrink-0 transition-colors",
              isActive ? "text-purple-400 font-bold" : "text-purple-500/80"
            )}
          />
        )}
        <span className="truncate flex-1">
          {node.name.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '').replace(/\.base$/, '')}
        </span>
        {isCanvas && (
          <span className="text-[0.55rem] bg-teal-500/15 text-teal-400 px-1 py-0.5 rounded-md font-bold tracking-wide uppercase shrink-0">
            Board
          </span>
        )}
        {isBase && (
          <span className="text-[0.55rem] bg-rose-500/15 text-rose-400 px-1 py-0.5 rounded-md font-bold tracking-wide uppercase shrink-0">
            Base
          </span>
        )}

        {/* Actions for File - 3-dots Dropdown Menu */}
        <div className="relative shrink-0 select-none">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setActiveMenuPath(activeMenuPath === node.path ? null : node.path);
            }}
            className={cn(
              "note-actions-trigger w-5.5 h-5.5 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-white/[0.06] hover:text-foreground transition-all cursor-pointer",
              activeMenuPath === node.path ? "bg-white/[0.06] text-foreground opacity-100" : "opacity-100 md:opacity-0 md:group-hover:opacity-100"
            )}
            title="Note Actions"
          >
            <MoreHorizontal size={13} />
          </button>

          {activeMenuPath === node.path && (
            /* Premium Glassmorphic Dropdown popup container */
            <div
              className="note-actions-menu absolute right-0 top-full mt-1 w-[140px] bg-[#12131a]/95 backdrop-blur-xl border border-border rounded-xl shadow-2xl p-1 flex flex-col gap-0.5 z-40 animate-in fade-in zoom-in-95 duration-100"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveMenuPath(null);
                  onCopyFile(node.path, node.name);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-pointer transition-all border border-transparent"
              >
                <Copy size={11} className="text-muted-foreground/75" />
                <span>Copy Note</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveMenuPath(null);
                  onMoveFile(node.path, node.name, node.file.sha);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-pointer transition-all border border-transparent"
              >
                <ArrowRight size={11} className="text-muted-foreground/75" />
                <span>Move Note</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveMenuPath(null);
                  onRenameFile(node.path, node.name, node.file.sha);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-pointer transition-all border border-transparent"
              >
                <Edit3 size={11} className="text-muted-foreground/75" />
                <span>Rename Note</span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveMenuPath(null);
                  onDownloadFile(node.path, node.name, node.file.sha);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-pointer transition-all border border-transparent"
              >
                <Download size={11} className="text-muted-foreground/75" />
                <span>Download</span>
              </button>

              <div className="h-[1px] bg-border my-0.5" />

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setActiveMenuPath(null);
                  onDeleteFile(node.path, node.file.sha);
                }}
                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-destructive hover:bg-destructive/10 hover:text-destructive cursor-pointer transition-all border border-transparent"
              >
                <Trash2 size={11} className="text-destructive/75" />
                <span>Delete Note</span>
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  // Render Folder Node
  const isOpen = !!openFolders[node.path];
  const isHighlighted = (node.path === highlightedPath || isFolderInActiveFilePath(node.path)) && highlightedPath !== null && !isOpen;

  const highlightClasses = isHighlighted && highlightColor ? {
    teal: 'bg-teal-500/10 text-teal-200 border border-teal-500/20',
    rose: 'bg-rose-500/10 text-rose-200 border border-rose-500/20',
    purple: 'bg-purple-500/10 text-purple-200 border border-purple-500/20',
  }[highlightColor] : '';

  return (
    <div className="flex flex-col gap-0.5">
      {/* Folder Row Header */}
      <div
        className={cn(
          "group flex items-center justify-between py-1.5 px-2.5 rounded-lg text-xs font-semibold transition-all hover:bg-white/[0.03]",
          isHighlighted ? highlightClasses : "text-muted-foreground/80 hover:text-foreground"
        )}
      >
        <div
          title={node.name}
          className="flex items-center gap-1.5 cursor-pointer flex-1 min-w-0"
          onClick={() => toggleFolder(node.path)}
        >
          {isOpen ? (
            <ChevronDown size={13} className={cn("shrink-0", isHighlighted && highlightColor ? {
              teal: 'text-teal-300',
              rose: 'text-rose-300',
              purple: 'text-purple-300',
            }[highlightColor] : "text-muted-foreground/50")} />
          ) : (
            <ChevronRight size={13} className={cn("shrink-0", isHighlighted && highlightColor ? {
              teal: 'text-teal-300',
              rose: 'text-rose-300',
              purple: 'text-purple-300',
            }[highlightColor] : "text-muted-foreground/50")} />
          )}
          {isOpen ? (
            <FolderOpen size={14} className={cn("shrink-0", isHighlighted && highlightColor ? {
              teal: 'text-teal-400',
              rose: 'text-rose-400',
              purple: 'text-purple-400',
            }[highlightColor] : "text-blue-400")} />
          ) : (
            <Folder size={14} className={cn("shrink-0", isHighlighted && highlightColor ? {
              teal: 'text-teal-500/80',
              rose: 'text-rose-500/80',
              purple: 'text-purple-500/80',
            }[highlightColor] : "text-blue-500/80")} />
          )}
          <span className="truncate">{node.name}</span>
          {fileCount > 0 && (
            <span className="text-muted-foreground/50 text-[0.7rem] shrink-0 ml-1">
              ({fileCount})
            </span>
          )}
        </div>

        {/* Actions for Folder */}
        <div className="flex gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0">
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCreateFile(node.path, '.md');
            }}
            className="w-5 h-5 flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-all cursor-pointer"
            title="New Note in Folder"
          >
            <Plus size={11.5} />
          </button>
          <button
            onClick={(e) => {
              e.stopPropagation();
              onCreateFolder(node.path);
            }}
            className="w-5 h-5 flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-all cursor-pointer"
            title="New Subfolder"
          >
            <FolderPlus size={11.5} />
          </button>

          {/* 3-dot menu for folder operations */}
          <div className="relative shrink-0 select-none">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setActiveFolderMenuPath(activeFolderMenuPath === node.path ? null : node.path);
              }}
              className={cn(
                "folder-actions-trigger w-5 h-5 flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-all cursor-pointer",
                activeFolderMenuPath === node.path ? "bg-muted text-foreground opacity-100" : "opacity-100"
              )}
              title="Folder Actions"
            >
              <MoreHorizontal size={11} />
            </button>

            {activeFolderMenuPath === node.path && (
              <div
                className="folder-actions-menu absolute right-0 top-full mt-1 w-[140px] bg-[#12131a]/95 backdrop-blur-xl border border-border rounded-xl shadow-2xl p-1 flex flex-col gap-0.5 z-40 animate-in fade-in zoom-in-95 duration-100"
                onClick={(e) => e.stopPropagation()}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveFolderMenuPath(null);
                    onCopyFolder(node.path);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-pointer transition-all border border-transparent"
                >
                  <Copy size={11} className="text-muted-foreground/75" />
                  <span>Copy Folder</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveFolderMenuPath(null);
                    onMoveFolder(node.path);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-pointer transition-all border border-transparent"
                >
                  <ArrowRight size={11} className="text-muted-foreground/75" />
                  <span>Move Folder</span>
                </button>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveFolderMenuPath(null);
                    onRenameFolder(node.path);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-pointer transition-all border border-transparent"
                >
                  <Edit3 size={11} className="text-muted-foreground/75" />
                  <span>Rename Folder</span>
                </button>

                <div className="h-[1px] bg-border my-0.5" />

                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setActiveFolderMenuPath(null);
                    onDeleteFolder(node.path);
                  }}
                  className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-destructive hover:bg-destructive/10 hover:text-destructive cursor-pointer transition-all border border-transparent"
                >
                  <Trash2 size={11} className="text-destructive/75" />
                  <span>Delete Folder</span>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Children Indented */}
      {isOpen && (
        <div className="pl-3 border-l border-border/40 ml-3.5 mt-0.5 flex flex-col gap-0.5">
          {node.children.length === 0 ? (
            <span className="text-[0.65rem] text-muted-foreground/45 italic p-1.5 select-none">
              Empty Folder
            </span>
          ) : (
            node.children.map(child => (
              <FolderTreeItem
                key={child.path}
                node={child}
                activeFilePath={activeFilePath}
                setActiveFilePath={setActiveFilePath}
                setViewTab={setViewTab}
                setIsMobileSidebarOpen={setIsMobileSidebarOpen}
                openFolders={openFolders}
                toggleFolder={toggleFolder}
                onCreateFile={onCreateFile}
                onCreateFolder={onCreateFolder}
                onDeleteFolder={onDeleteFolder}
                onRenameFolder={onRenameFolder}
                onMoveFolder={onMoveFolder}
                onCopyFolder={onCopyFolder}
                onRenameFile={onRenameFile}
                onDeleteFile={onDeleteFile}
                onCopyFile={onCopyFile}
                onMoveFile={onMoveFile}
                onDownloadFile={onDownloadFile}
                activeMenuPath={activeMenuPath}
                setActiveMenuPath={setActiveMenuPath}
                activeFolderMenuPath={activeFolderMenuPath}
                setActiveFolderMenuPath={setActiveFolderMenuPath}
                highlightedPath={highlightedPath}
                highlightColor={highlightColor}
                isFolderInActiveFilePath={isFolderInActiveFilePath}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
};

export const FolderTreeItem = React.memo(FolderTreeItemComponent);

interface SidebarProps {
  isMobileSidebarOpen: boolean;
  setIsMobileSidebarOpen: (open: boolean) => void;
  createNewFile: (extension: '.md' | '.txt' | '.canvas' | '.base', folderPath?: string) => Promise<void>;
  searchTerm: string;
  setSearchTerm: (term: string) => void;
  files: VaultFile[];
  filteredFiles: VaultFile[];
  isLoadingTree: boolean;
  activeFilePath: string | null;
  setActiveFilePath: (path: string | null) => void;
  setViewTab: (tab: 'workspace' | 'graph') => void;
  onDeleteClick: (path: string, sha: string) => void;
  onRenameClick: (path: string, name: string, sha: string) => void;
  onDownloadClick: (path: string, name: string, sha: string) => void;
  repoName: string;
  branchName: string;

  // Folder actions
  onCreateFolderClick: (parentPath: string) => void;
  onDeleteFolderClick: (folderPath: string) => void;
  onRenameFolderClick: (folderPath: string) => void;
  onMoveFolderClick: (folderPath: string) => void;
  onCopyFolderClick: (folderPath: string) => void;
  onCopyClick: (path: string, name: string) => void;
  onMoveClick: (path: string, name: string, sha: string) => void;
  onUploadAttachment: (file: File, folderPath?: string) => Promise<{ path: string; name: string }>;

  // Sidebar sizing/collapse control
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;
  isSidebarCollapsed: boolean;
  setIsSidebarCollapsed: (collapsed: boolean) => void;
  isResizingSidebar: boolean;
  setIsResizingSidebar: (resizing: boolean) => void;

  onOpenSettings: () => void;
  hasConflicts: boolean;
  onOpenConflictResolution: () => void;
  onOpenSearch: () => void;
}

const SidebarComponent: React.FC<SidebarProps> = ({
  isMobileSidebarOpen,
  setIsMobileSidebarOpen,
  createNewFile,
  searchTerm,
  setSearchTerm,
  files,
  filteredFiles,
  isLoadingTree,
  activeFilePath,
  setActiveFilePath,
  setViewTab,
  onDeleteClick,
  onRenameClick,
  onDownloadClick,
  repoName,
  branchName,

  onCreateFolderClick,
  onDeleteFolderClick,
  onRenameFolderClick,
  onMoveFolderClick,
  onCopyFolderClick,
  onCopyClick,
  onMoveClick,
  onUploadAttachment,

  sidebarWidth,
  setSidebarWidth,
  isSidebarCollapsed,
  setIsSidebarCollapsed,
  isResizingSidebar,
  setIsResizingSidebar,
  onOpenSettings,
  hasConflicts,
  onOpenConflictResolution,
  onOpenSearch,
}) => {
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [activeMenuPath, setActiveMenuPath] = useState<string | null>(null);
  const [activeFolderMenuPath, setActiveFolderMenuPath] = useState<string | null>(null);
  const [isRootFilesOpen, setIsRootFilesOpen] = useState(false);

  const toggleFolder = useCallback((path: string) => {
    setOpenFolders(prev => ({
      ...prev,
      [path]: !prev[path],
    }));
  }, []);

  const getFileTypeColor = useCallback((filePath: string): 'purple' | 'teal' | 'rose' => {
    if (filePath.endsWith('.canvas')) return 'teal';
    if (filePath.endsWith('.base')) return 'rose';
    return 'purple';
  }, []);

  const getParentFolderPath = useCallback((filePath: string): string | null => {
    const lastSlashIndex = filePath.lastIndexOf('/');
    if (lastSlashIndex === -1) return null;
    return filePath.substring(0, lastSlashIndex);
  }, []);

  const isFolderInActiveFilePath = useCallback((folderPath: string): boolean => {
    if (!activeFilePath) return false;
    return activeFilePath.startsWith(folderPath + '/');
  }, [activeFilePath]);



  // Get the path that should be highlighted based on active file
  const highlightedPath = useMemo(() => activeFilePath ? getParentFolderPath(activeFilePath) : null, [activeFilePath, getParentFolderPath]);
  const highlightColor = useMemo(() => activeFilePath ? getFileTypeColor(activeFilePath) : null, [activeFilePath, getFileTypeColor]);

  // Build folder tree structure from files
  const tree = useMemo(() => buildFolderTree(files), [files]);

  // Collapse root files when sidebar is dismissed/minimized
  const hasClosedRootFilesRef = useRef(false);
  useEffect(() => {
    if (!isMobileSidebarOpen && !hasClosedRootFilesRef.current) {
      setIsRootFilesOpen(false);
      hasClosedRootFilesRef.current = true;
    } else if (isMobileSidebarOpen) {
      hasClosedRootFilesRef.current = false;
    }
  }, [isMobileSidebarOpen]);

  // Close active 3-dots actions dropdown menu when clicking anywhere on the document
  useEffect(() => {
    const handleDocumentClick = (e: MouseEvent) => {
      if (activeMenuPath === null && activeFolderMenuPath === null) return;
      const target = e.target as HTMLElement;
      if (target.closest('.note-actions-menu') || target.closest('.note-actions-trigger')) return;
      if (target.closest('.folder-actions-menu') || target.closest('.folder-actions-trigger')) return;
      setActiveMenuPath(null);
      setActiveFolderMenuPath(null);
    };

    document.addEventListener('click', handleDocumentClick);
    return () => document.removeEventListener('click', handleDocumentClick);
  }, [activeMenuPath, activeFolderMenuPath]);

  // Mouse drag listeners for resizer handle
  const handleMouseDown = (mouseDownEvent: React.MouseEvent) => {
    mouseDownEvent.preventDefault();
    setIsResizingSidebar(true);
    const startWidth = sidebarWidth;
    const startX = mouseDownEvent.clientX;
    let lastUpdateTime = Date.now();

    const handleMouseMove = (mouseMoveEvent: MouseEvent) => {
      const now = Date.now();
      if (now - lastUpdateTime < 16) return; // Throttle to ~60fps
      lastUpdateTime = now;

      const deltaX = mouseMoveEvent.clientX - startX;
      let newWidth = startWidth + deltaX;

      if (newWidth < 140) {
        setIsSidebarCollapsed(true);
      } else {
        setIsSidebarCollapsed(false);
        if (newWidth > 480) newWidth = 480;
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizingSidebar(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const handleDoubleClick = () => {
    setSidebarWidth(260);
    setIsSidebarCollapsed(false);
  };

  const handleCreateNote = useCallback(() => {
    createNewFile('.md');
    setIsMobileSidebarOpen(false);
  }, [createNewFile, setIsMobileSidebarOpen]);

  const handleCreateCanvas = useCallback(() => {
    createNewFile('.canvas');
    setIsMobileSidebarOpen(false);
  }, [createNewFile, setIsMobileSidebarOpen]);

  const handleCreateBase = useCallback(() => {
    createNewFile('.base');
    setIsMobileSidebarOpen(false);
  }, [createNewFile, setIsMobileSidebarOpen]);

  const handleCreateFolder = useCallback(() => {
    onCreateFolderClick('/');
    setIsMobileSidebarOpen(false);
  }, [onCreateFolderClick, setIsMobileSidebarOpen]);

  return (
    <>
      {/* Mobile Sidebar overlay */}
      {isMobileSidebarOpen && (
        <div
          className="fixed inset-0 bg-black/65 backdrop-blur-xs z-[990] animate-fade-in md:hidden will-change-opacity"
          onClick={() => setIsMobileSidebarOpen(false)}
        />
      )}

      {/* Sidebar Navigation Shell */}
      <aside
        style={{
          width: isMobileSidebarOpen ? undefined : (isSidebarCollapsed ? '0px' : `${sidebarWidth}px`),
          minWidth: isMobileSidebarOpen ? undefined : (isSidebarCollapsed ? '0px' : `${sidebarWidth}px`),
          maxWidth: isMobileSidebarOpen ? undefined : (isSidebarCollapsed ? '0px' : `${sidebarWidth}px`),
        }}
        className={cn(
          "h-full bg-card/80 backdrop-blur-xl border-r border-border flex flex-col z-[1000] fixed top-0 left-0 md:relative md:top-auto md:left-auto md:translate-x-0 will-change-transform",
          isMobileSidebarOpen ? "translate-x-0 w-full min-w-full md:w-[280px] md:min-w-[280px]" : "-translate-x-full md:translate-x-0",
          isSidebarCollapsed && "overflow-hidden border-r-0 md:w-0!",
          !isResizingSidebar && "transition-transform md:transition-all duration-200 ease-out"
        )}
      >
        <div className="h-[60px] px-5 flex items-center justify-between border-b border-border select-none">
          <div className="flex items-center gap-2.5 font-heading font-bold text-lg bg-gradient-to-r from-white to-accent bg-clip-text text-transparent">
            <Compass className="w-[18px] h-[18px] text-secondary animate-pulse-soft" />
            <span>Starfish Notes</span>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={onOpenSearch}
              className="w-8 h-8 flex items-center justify-center rounded-full text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer"
              title="Global Content Search"
            >
              <Search className="w-4 h-4" />
            </button>

            {isMobileSidebarOpen ? (
              <button
                onClick={() => setIsMobileSidebarOpen(false)}
                className="w-8 h-8 flex items-center justify-center rounded-full text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer"
                title="Close Sidebar"
              >
                <X className="w-4 h-4" />
              </button>
            ) : (
              <button
                onClick={() => setIsSidebarCollapsed(true)}
                className="w-8 h-8 hidden md:flex items-center justify-center rounded-full text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer"
                title="Collapse Sidebar"
              >
                <PanelLeftClose className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          {/* Premium Grid-Based Creator */}
          <div className="flex flex-col gap-2.5">
            <span className="text-[0.65rem] font-bold text-muted-foreground/80 uppercase tracking-widest px-1 mb-1 select-none">
              New
            </span>

            <div className="grid grid-cols-2 gap-2">
              {/* Note */}
              <button
                type="button"
                onClick={handleCreateNote}
                className="group flex flex-col items-center justify-center p-3 rounded-2xl bg-muted/20 border border-border/40 hover:border-purple-500/40 hover:bg-purple-500/5 hover:shadow-xs transition-all text-center cursor-pointer"
                title="Create New Markdown Note"
              >
                <div className="w-8 h-8 rounded-xl bg-purple-500/10 text-purple-400 flex items-center justify-center group-hover:scale-110 transition-transform duration-200">
                  <FileText size={16} />
                </div>
                <span className="text-xs font-semibold text-muted-foreground group-hover:text-foreground transition-colors mt-2">Note</span>
              </button>

              {/* Canvas */}
              <button
                type="button"
                onClick={handleCreateCanvas}
                className="group flex flex-col items-center justify-center p-3 rounded-2xl bg-muted/20 border border-border/40 hover:border-teal-500/40 hover:bg-teal-500/5 hover:shadow-xs transition-all text-center cursor-pointer"
                title="Create New Canvas Board"
              >
                <div className="w-8 h-8 rounded-xl bg-teal-500/10 text-teal-400 flex items-center justify-center group-hover:scale-110 transition-transform duration-200">
                  <Compass size={16} />
                </div>
                <span className="text-xs font-semibold text-muted-foreground group-hover:text-foreground transition-colors mt-2">Canvas</span>
              </button>

              {/* Base */}
              <button
                type="button"
                onClick={handleCreateBase}
                className="group flex flex-col items-center justify-center p-3 rounded-2xl bg-muted/20 border border-border/40 hover:border-rose-500/40 hover:bg-rose-500/5 hover:shadow-xs transition-all text-center cursor-pointer"
                title="Create New Database Base"
              >
                <div className="w-8 h-8 rounded-xl bg-rose-500/10 text-rose-400 flex items-center justify-center group-hover:scale-110 transition-transform duration-200">
                  <Database size={16} />
                </div>
                <span className="text-xs font-semibold text-muted-foreground group-hover:text-foreground transition-colors mt-2">Base</span>
              </button>

              {/* Folder */}
              <button
                type="button"
                onClick={handleCreateFolder}
                className="group flex flex-col items-center justify-center p-3 rounded-2xl bg-muted/20 border border-border/40 hover:border-blue-500/40 hover:bg-blue-500/5 hover:shadow-xs transition-all text-center cursor-pointer"
                title="Create New Folder"
              >
                <div className="w-8 h-8 rounded-xl bg-blue-500/10 text-blue-400 flex items-center justify-center group-hover:scale-110 transition-transform duration-200">
                  <FolderPlus size={16} />
                </div>
                <span className="text-xs font-semibold text-muted-foreground group-hover:text-foreground transition-colors mt-2">Folder</span>
              </button>
            </div>

            {/* Attachment Button Below Grid */}
            <button
              type="button"
              onClick={() => {
                const input = document.createElement('input');
                input.type = 'file';
                input.onchange = (e) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  if (file) {
                    onUploadAttachment(file);
                  }
                };
                input.click();
                setIsMobileSidebarOpen(false);
              }}
              className="group w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-muted/30 border border-border/40 hover:border-emerald-500/40 hover:bg-emerald-500/5 hover:shadow-xs transition-all cursor-pointer text-xs font-semibold text-muted-foreground hover:text-foreground mt-1"
              title="Upload file attachment (max 5MB)"
            >
              <Paperclip className="w-3.5 h-3.5 text-emerald-400 group-hover:scale-110 transition-transform shrink-0" />
              <span>Upload Attachment</span>
            </button>
          </div>

          {/* Fuzzy Path Filter Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              type="text"
              placeholder="Search notes..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-9 pr-4 py-2 bg-muted/40 border border-border text-foreground rounded-xl text-xs w-full focus:outline-none focus:border-primary transition-all duration-200"
            />
          </div>

          {/* Scrolled note tree list */}
          <div className="flex flex-col gap-2">
            <span className="text-[0.65rem] font-bold text-muted-foreground/80 uppercase tracking-widest px-1">
              {searchTerm ? 'Search Results' : 'Vault Files'} ({files.filter(f => f.name !== '.gitkeep').length})
            </span>
            <div className="flex flex-col gap-1 pr-1">
              {isLoadingTree ? (
                <div className="flex gap-2 items-center justify-center p-6 text-muted-foreground text-xs">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Loading vault tree...</span>
                </div>
              ) : searchTerm ? (
                // SEARCH ACTIVE: Render flat paths list for speed and findability!
                filteredFiles.length === 0 ? (
                  <span className="text-xs text-muted-foreground/60 italic p-3 text-center">
                    No matching notes found.
                  </span>
                ) : (
                  filteredFiles.map((file) => {
                    const isActive = file.path === activeFilePath;
                    const isCanvas = file.path.endsWith('.canvas');
                    const isBase = file.path.endsWith('.base');
                    return (
                      <div
                        key={file.path}
                        title={file.name}
                        className={cn(
                          "group flex items-center gap-2.5 px-3 py-2 rounded-xl cursor-pointer text-xs font-medium border border-transparent transition-all duration-200 hover:bg-border/40 hover:text-foreground relative",
                          isActive
                            ? isCanvas
                              ? "bg-teal-500/10 text-teal-300 font-semibold border-teal-500/15 shadow-xs"
                              : isBase
                                ? "bg-rose-500/10 text-rose-300 font-semibold border-rose-500/15 shadow-xs"
                                : "bg-purple-500/10 text-purple-300 font-semibold border-purple-500/15 shadow-xs"
                            : "text-muted-foreground/85"
                        )}
                        onClick={() => {
                          setActiveFilePath(file.path);
                          setViewTab('workspace'); // Force workspace active
                          setIsMobileSidebarOpen(false);
                        }}
                      >
                        {file.path.toLowerCase().endsWith('.png') ||
                          file.path.toLowerCase().endsWith('.jpg') ||
                          file.path.toLowerCase().endsWith('.jpeg') ||
                          file.path.toLowerCase().endsWith('.gif') ||
                          file.path.toLowerCase().endsWith('.webp') ||
                          file.path.toLowerCase().endsWith('.svg') ? (
                          <Image
                            className={cn(
                              "w-3.5 h-3.5 shrink-0 transition-colors",
                              isActive ? "text-purple-300" : "text-muted-foreground/60"
                            )}
                          />
                        ) : file.path.toLowerCase().endsWith('.pdf') ? (
                          <Paperclip
                            className={cn(
                              "w-3.5 h-3.5 shrink-0 transition-colors",
                              isActive ? "text-purple-300" : "text-muted-foreground/60"
                            )}
                          />
                        ) : isBase ? (
                          <Database
                            className={cn(
                              "w-3.5 h-3.5 shrink-0 transition-colors",
                              isActive ? "text-rose-400 font-bold" : "text-rose-500/80"
                            )}
                          />
                        ) : isCanvas ? (
                          <FileText
                            className={cn(
                              "w-3.5 h-3.5 shrink-0 transition-colors",
                              isActive ? "text-teal-400 font-bold" : "text-teal-500/80"
                            )}
                          />
                        ) : (
                          <FileText
                            className={cn(
                              "w-3.5 h-3.5 shrink-0 transition-colors",
                              isActive ? "text-purple-400 font-bold" : "text-purple-500/80"
                            )}
                          />
                        )}
                        <div className="flex-1 flex flex-col min-w-0">
                          <span className="truncate text-foreground font-semibold">
                            {file.name.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '').replace(/\.base$/, '')}
                          </span>
                          {file.path.includes('/') && (
                            <span className="truncate text-[0.625rem] text-muted-foreground/50 font-medium">
                              {file.path.substring(0, file.path.lastIndexOf('/'))}
                            </span>
                          )}
                        </div>
                        {isCanvas && (
                          <span className="text-[0.55rem] bg-teal-500/15 text-teal-400 px-1.5 py-0.5 rounded-md font-bold tracking-wide uppercase shrink-0">
                            Board
                          </span>
                        )}
                        {isBase && (
                          <span className="text-[0.55rem] bg-rose-500/15 text-rose-400 px-1.5 py-0.5 rounded-md font-bold tracking-wide uppercase shrink-0">
                            Base
                          </span>
                        )}

                        {/* Actions for File - 3-dots actions dropdown for flat search list */}
                        <div className="relative shrink-0 select-none">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setActiveMenuPath(activeMenuPath === file.path ? null : file.path);
                            }}
                            className={cn(
                              "note-actions-trigger w-5.5 h-5.5 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-white/[0.06] hover:text-foreground transition-all cursor-pointer",
                              activeMenuPath === file.path ? "bg-white/[0.06] text-foreground opacity-100" : "opacity-100 md:opacity-0 md:group-hover:opacity-100"
                            )}
                            title="Note Actions"
                          >
                            <MoreHorizontal size={13} />
                          </button>

                          {activeMenuPath === file.path && (
                            /* Premium Glassmorphic Dropdown popup container */
                            <div
                              className="note-actions-menu absolute right-0 top-full mt-1 w-[140px] bg-[#12131a]/95 backdrop-blur-xl border border-border rounded-xl shadow-2xl p-1 flex flex-col gap-0.5 z-40 animate-in fade-in zoom-in-95 duration-100"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveMenuPath(null);
                                  onCopyClick(file.path, file.name);
                                }}
                                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-pointer transition-all border border-transparent"
                              >
                                <Copy size={11} className="text-muted-foreground/75" />
                                <span>Copy Note</span>
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveMenuPath(null);
                                  onMoveClick(file.path, file.name, file.sha);
                                }}
                                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-pointer transition-all border border-transparent"
                              >
                                <ArrowRight size={11} className="text-muted-foreground/75" />
                                <span>Move Note</span>
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveMenuPath(null);
                                  onRenameClick(file.path, file.name, file.sha);
                                }}
                                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-pointer transition-all border border-transparent"
                              >
                                <Edit3 size={11} className="text-muted-foreground/75" />
                                <span>Rename Note</span>
                              </button>
                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveMenuPath(null);
                                  onDownloadClick(file.path, file.name, file.sha);
                                }}
                                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-pointer transition-all border border-transparent"
                              >
                                <Download size={11} className="text-muted-foreground/75" />
                                <span>Download</span>
                              </button>

                              <div className="h-[1px] bg-border my-0.5" />

                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setActiveMenuPath(null);
                                  onDeleteClick(file.path, file.sha);
                                }}
                                className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-destructive hover:bg-destructive/10 hover:text-destructive cursor-pointer transition-all border border-transparent"
                              >
                                <Trash2 size={11} className="text-destructive/75" />
                                <span>Delete Note</span>
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })
                )
              ) : (
                // TREE VIEW ACTIVE: Render organized recursive folders & files tree!
                (() => {
                  if (tree.length === 0) {
                    return (
                      <span className="text-xs text-muted-foreground/60 italic p-3 text-center">
                        Vault is empty. Create a note to begin.
                      </span>
                    );
                  }

                  // Separate root files from folders
                  const rootFiles = tree.filter(node => node.type === 'file') as typeof tree;
                  const rootFolders = tree.filter(node => node.type === 'folder') as typeof tree;

                  return (
                    <>
                      {/* Folders Section */}
                      {rootFolders.length > 0 && (
                        <div className="flex flex-col gap-1">
                          {rootFolders.map(node => (
                            <FolderTreeItem
                              key={node.path}
                              node={node}
                              activeFilePath={activeFilePath}
                              setActiveFilePath={setActiveFilePath}
                              setViewTab={setViewTab}
                              setIsMobileSidebarOpen={setIsMobileSidebarOpen}
                              openFolders={openFolders}
                              toggleFolder={toggleFolder}
                              onCreateFile={(folderPath, ext) => {
                                createNewFile(ext, folderPath);
                                setIsMobileSidebarOpen(false);
                              }}
                              onCreateFolder={(parentPath) => onCreateFolderClick(parentPath)}
                              onDeleteFolder={(folderPath) => onDeleteFolderClick(folderPath)}
                              onRenameFolder={(folderPath) => onRenameFolderClick(folderPath)}
                              onMoveFolder={(folderPath) => onMoveFolderClick(folderPath)}
                              onCopyFolder={(folderPath) => onCopyFolderClick(folderPath)}
                              onRenameFile={onRenameClick}
                              onDeleteFile={onDeleteClick}
                              onCopyFile={onCopyClick}
                              onMoveFile={onMoveClick}
                              onDownloadFile={onDownloadClick}
                              activeMenuPath={activeMenuPath}
                              setActiveMenuPath={setActiveMenuPath}
                              activeFolderMenuPath={activeFolderMenuPath}
                              setActiveFolderMenuPath={setActiveFolderMenuPath}
                              highlightedPath={highlightedPath}
                              highlightColor={highlightColor}
                              isFolderInActiveFilePath={isFolderInActiveFilePath}
                            />
                          ))}
                        </div>
                      )}

                      {/* Root Files Collapsible Section */}
                      {rootFiles.length > 0 && (
                        <>
                          {rootFolders.length > 0 && (
                            <div className="h-px bg-border/30 my-0.5" />
                          )}
                          <div className="flex flex-col gap-1">
                            <div
                              onClick={() => setIsRootFilesOpen(!isRootFilesOpen)}
                              className={cn(
                                "group flex items-center justify-between py-1.5 px-2.5 rounded-lg text-xs font-semibold cursor-pointer transition-all",
                                highlightedPath === null && highlightColor && !isRootFilesOpen
                                  ? {
                                    teal: 'bg-teal-500/10 text-teal-200 border border-teal-500/20 hover:text-teal-200 hover:bg-teal-500/15',
                                    rose: 'bg-rose-500/10 text-rose-200 border border-rose-500/20 hover:text-rose-200 hover:bg-rose-500/15',
                                    purple: 'bg-purple-500/10 text-purple-200 border border-purple-500/20 hover:text-purple-200 hover:bg-purple-500/15',
                                  }[highlightColor]
                                  : 'text-muted-foreground/75 hover:text-foreground hover:bg-white/[0.03]'
                              )}
                            >
                              <div className="flex items-center gap-1.5 flex-1 min-w-0">
                                <ChevronRight
                                  size={13}
                                  className={cn(
                                    "shrink-0 transition-transform duration-200",
                                    isRootFilesOpen && "rotate-90"
                                  )}
                                />
                                <span>Files in Vault Root</span>
                                <span className="text-muted-foreground/50 ml-auto">
                                  ({rootFiles.length})
                                </span>
                              </div>
                              <div className="flex gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity shrink-0">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    createNewFile('.md', '/');
                                    setIsMobileSidebarOpen(false);
                                  }}
                                  className="w-5 h-5 flex items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground transition-all cursor-pointer"
                                  title="New Note in Root"
                                >
                                  <Plus size={11.5} />
                                </button>
                              </div>
                            </div>

                            {isRootFilesOpen && (
                              <div className="flex flex-col gap-1 pl-2">
                                {rootFiles.map((file) => {
                                  const isActive = file.path === activeFilePath;
                                  const isCanvas = file.path.endsWith('.canvas');
                                  const isBase = file.path.endsWith('.base');
                                  return (
                                    <div
                                      key={file.path}
                                      title={file.name}
                                      className={cn(
                                        "group flex items-center gap-2.5 px-2.5 py-1.5 rounded-lg cursor-pointer text-xs font-medium border border-transparent transition-all duration-150 hover:bg-white/[0.05] hover:text-foreground relative",
                                        isActive
                                          ? isCanvas
                                            ? "bg-teal-500/10 text-teal-300 font-semibold border-teal-500/15"
                                            : isBase
                                              ? "bg-rose-500/10 text-rose-300 font-semibold border-rose-500/15"
                                              : "bg-purple-500/10 text-purple-300 font-semibold border-purple-500/15"
                                          : "text-muted-foreground/80"
                                      )}
                                      onClick={() => {
                                        setActiveFilePath(file.path);
                                        setViewTab('workspace');
                                        setIsMobileSidebarOpen(false);
                                      }}
                                    >
                                      {file.path.toLowerCase().endsWith('.png') ||
                                        file.path.toLowerCase().endsWith('.jpg') ||
                                        file.path.toLowerCase().endsWith('.jpeg') ||
                                        file.path.toLowerCase().endsWith('.gif') ||
                                        file.path.toLowerCase().endsWith('.webp') ||
                                        file.path.toLowerCase().endsWith('.svg') ? (
                                        <Image
                                          className={cn(
                                            "w-3.5 h-3.5 shrink-0 transition-colors",
                                            isActive ? "text-purple-300" : "text-muted-foreground/60"
                                          )}
                                        />
                                      ) : file.path.toLowerCase().endsWith('.pdf') ? (
                                        <Paperclip
                                          className={cn(
                                            "w-3.5 h-3.5 shrink-0 transition-colors",
                                            isActive ? "text-purple-300" : "text-muted-foreground/60"
                                          )}
                                        />
                                      ) : isBase ? (
                                        <Database
                                          className={cn(
                                            "w-3.5 h-3.5 shrink-0 transition-colors",
                                            isActive ? "text-rose-400" : "text-rose-500/80"
                                          )}
                                        />
                                      ) : isCanvas ? (
                                        <Compass
                                          className={cn(
                                            "w-3.5 h-3.5 shrink-0 transition-colors",
                                            isActive ? "text-teal-400" : "text-teal-500/80"
                                          )}
                                        />
                                      ) : (
                                        <FileText
                                          className={cn(
                                            "w-3.5 h-3.5 shrink-0 transition-colors",
                                            isActive ? "text-purple-400" : "text-purple-500/80"
                                          )}
                                        />
                                      )}
                                      <span className="truncate flex-1">
                                        {file.name.replace(/\.(md|canvas|base)$/, '')}
                                      </span>
                                      {isCanvas && (
                                        <span className="text-[0.55rem] bg-teal-500/15 text-teal-400 px-1.5 py-0.5 rounded-md font-bold tracking-wide uppercase shrink-0">
                                          Board
                                        </span>
                                      )}
                                      {isBase && (
                                        <span className="text-[0.55rem] bg-rose-500/15 text-rose-400 px-1.5 py-0.5 rounded-md font-bold tracking-wide uppercase shrink-0">
                                          Base
                                        </span>
                                      )}

                                      {/* 3-dots menu for root files */}
                                      <div className="relative shrink-0 select-none">
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            setActiveMenuPath(activeMenuPath === file.path ? null : file.path);
                                          }}
                                          className={cn(
                                            "note-actions-trigger w-5 h-5 flex items-center justify-center rounded-lg text-muted-foreground hover:bg-white/[0.06] hover:text-foreground transition-all cursor-pointer",
                                            activeMenuPath === file.path ? "bg-white/[0.06] text-foreground" : "opacity-0 group-hover:opacity-100"
                                          )}
                                          title="File Actions"
                                        >
                                          <MoreHorizontal size={12} />
                                        </button>

                                        {activeMenuPath === file.path && (
                                          <div
                                            className="note-actions-menu absolute right-0 top-full mt-1 w-[140px] bg-[#12131a]/95 backdrop-blur-xl border border-border rounded-xl shadow-2xl p-1 flex flex-col gap-0.5 z-40 animate-in fade-in zoom-in-95 duration-100"
                                            onClick={(e) => e.stopPropagation()}
                                          >
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setActiveMenuPath(null);
                                                onRenameClick(file.path, file.name, (file as TreeFile).file.sha);
                                              }}
                                              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-pointer transition-all border border-transparent"
                                            >
                                              <Edit3 size={11} />
                                              <span>Rename</span>
                                            </button>
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setActiveMenuPath(null);
                                                onCopyClick(file.path, file.name);
                                              }}
                                              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-pointer transition-all border border-transparent"
                                            >
                                              <Copy size={11} />
                                              <span>Copy</span>
                                            </button>
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setActiveMenuPath(null);
                                                onMoveClick(file.path, file.name, (file as TreeFile).file.sha);
                                              }}
                                              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-pointer transition-all border border-transparent"
                                            >
                                              <ArrowRight size={11} />
                                              <span>Move</span>
                                            </button>
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setActiveMenuPath(null);
                                                onDownloadClick(file.path, file.name, (file as TreeFile).file.sha);
                                              }}
                                              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground cursor-point cursor-pointer transition-all border border-transparent"
                                            >
                                              <Download size={11} />
                                              <span>Download</span>
                                            </button>
                                            <button
                                              type="button"
                                              onClick={(e) => {
                                                e.stopPropagation();
                                                setActiveMenuPath(null);
                                                onDeleteClick(file.path, (file as TreeFile).file.sha);
                                              }}
                                              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-left text-[0.72rem] font-semibold text-destructive hover:bg-destructive/10 hover:text-destructive cursor-pointer transition-all border border-transparent"
                                            >
                                              <Trash2 size={11} className="text-destructive/75" />
                                              <span>Delete</span>
                                            </button>
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </>
                      )}
                    </>
                  );
                })()
              )}
            </div>
          </div>
        </div>

        {/* Info footer */}
        <div className="p-4 border-t border-border flex flex-col gap-2 bg-card/40 backdrop-blur-xl relative">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground/80 font-medium min-w-0 flex-1">
              <GitBranch className="w-3.5 h-3.5 text-primary shrink-0" />
              <span className="truncate" title={repoName}>
                {repoName}
              </span>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              {hasConflicts && (
                <button
                  type="button"
                  onClick={onOpenConflictResolution}
                  className="p-1.5 rounded-lg bg-amber-500/10 text-amber-500 hover:bg-amber-500/20 border border-amber-500/20 hover:border-amber-500/40 transition-all cursor-pointer flex items-center justify-center animate-pulse"
                  title="Resolve Conflicts"
                >
                  <AlertTriangle size={14.5} />
                </button>
              )}
              <button
                type="button"
                onClick={onOpenSettings}
                className="p-1.5 rounded-lg text-muted-foreground hover:bg-border/65 hover:text-foreground transition-all cursor-pointer shrink-0 hover:rotate-45 duration-300 flex items-center justify-center border border-transparent"
                title="Open Settings"
              >
                <Settings size={14.5} />
              </button>
            </div>
          </div>
          <div className="flex items-center gap-2 text-[0.7rem] text-muted-foreground/60 font-semibold px-0.5">
            <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-pulse-soft shrink-0" />
            <span className="truncate">Connected: {branchName}</span>
          </div>
        </div>

        {/* Sleek resizer drag-handle strip on desktop */}
        {!isMobileSidebarOpen && (
          <div
            onMouseDown={handleMouseDown}
            onDoubleClick={handleDoubleClick}
            className={cn(
              "absolute top-0 right-0 w-1.5 h-full cursor-col-resize z-50 transition-colors group select-none",
              isResizingSidebar ? "bg-primary" : "hover:bg-primary/45 active:bg-primary"
            )}
            title="Drag to resize, double-click to reset"
          >
            <div className={cn(
              "w-[1px] h-full mx-auto transition-colors",
              isResizingSidebar ? "bg-primary" : "bg-border group-hover:bg-primary/40 group-active:bg-primary"
            )} />
          </div>
        )}
      </aside>
    </>
  );
};
export const Sidebar = React.memo(SidebarComponent);
