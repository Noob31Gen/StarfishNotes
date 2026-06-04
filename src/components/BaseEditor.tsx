import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Database, Eye, Code, Plus, ArrowUpDown, 
  Filter, FileText, Check, X, RefreshCw, PlusCircle, Folders,
  SlidersHorizontal, Search, Info, Calendar, Tag, AlignLeft, EyeOff,
  ChevronDown
} from 'lucide-react';
import { parseYaml, stringifyYaml } from '../utils/yaml';
import { parseFrontmatter, updateFrontmatter } from '../utils/frontmatter';
import type { VaultFile } from '../services/github';
import { cn } from '../utils/cn';
import { safeParseJson } from '../utils/json';

interface InbuiltPropertyDef {
  key: string;
  label: string;
  icon: 'info' | 'text' | 'calendar' | 'tag';
}

const INBUILT_PROPERTIES: InbuiltPropertyDef[] = [
  { key: 'file name', label: 'file name', icon: 'info' },
  { key: 'file backlinks', label: 'file backlinks', icon: 'info' },
  { key: 'created time', label: 'created time', icon: 'info' },
  { key: 'file extension', label: 'file extension', icon: 'info' },
  { key: 'modified time', label: 'modified time', icon: 'info' },
  { key: 'file base name', label: 'file base name', icon: 'info' },
  { key: 'file embeds', label: 'file embeds', icon: 'info' },
  { key: 'folder', label: 'folder', icon: 'info' },
  { key: 'file full name', label: 'file full name', icon: 'info' },
  { key: 'file links', label: 'file links', icon: 'info' },
  { key: 'file path', label: 'file path', icon: 'info' },
  { key: 'file size', label: 'file size', icon: 'info' },
  { key: 'file tags', label: 'file tags', icon: 'info' },
  { key: 'author', label: 'author', icon: 'text' },
  { key: 'date', label: 'date', icon: 'calendar' },
  { key: 'tags', label: 'tags', icon: 'tag' },
  { key: 'title', label: 'title', icon: 'text' },
  { key: 'version', label: 'version', icon: 'text' },
];

const formatBytes = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const getStableDate = (seed: string, offsetDays: number = 0): string => {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = seed.charCodeAt(i) + ((hash << 5) - hash);
  }
  const daysAgo = (Math.abs(hash) % 180) + offsetDays;
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const hours = String(Math.abs(hash) % 24).padStart(2, '0');
  const minutes = String(Math.abs(hash) % 60).padStart(2, '0');
  return `${date.toISOString().split('T')[0]} ${hours}:${minutes}`;
};

const extractTags = (content: string, frontmatter?: Record<string, unknown>): Set<string> => {
  const tags = new Set<string>();
  if (frontmatter) {
    const fmTags = frontmatter.tags || frontmatter.tag;
    if (typeof fmTags === 'string') {
      fmTags.split(',').forEach(t => {
        const clean = t.trim().replace(/^#/, '');
        if (clean) tags.add(clean);
      });
    } else if (Array.isArray(fmTags)) {
      fmTags.forEach(t => {
        const clean = String(t).trim().replace(/^#/, '');
        if (clean) tags.add(clean);
      });
    }
  }
  const tagRegex = /#([a-zA-Z0-9_/-]+)/g;
  let match;
  while ((match = tagRegex.exec(content)) !== null) {
    const tag = match[1];
    if (tag && !/^[0-9a-fA-F]{3,6}$/.test(tag) && !/^\d+$/.test(tag)) {
      tags.add(tag);
    }
  }
  return tags;
};

const extractLinks = (content: string): Set<string> => {
  const links = new Set<string>();
  const wikiRegex = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let match;
  while ((match = wikiRegex.exec(content)) !== null) {
    const link = match[1].trim();
    if (link) links.add(link);
  }
  const mdRegex = /\[[^\]]*\]\(([^)]+\.md)\)/g;
  while ((match = mdRegex.exec(content)) !== null) {
    const path = match[1];
    const fileName = path.split('/').pop() || path;
    const baseName = fileName.replace(/\.md$/, '');
    if (baseName) links.add(decodeURIComponent(baseName));
  }
  return links;
};

const extractEmbeds = (content: string): Set<string> => {
  const embeds = new Set<string>();
  const wikiRegex = /!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;
  let match;
  while ((match = wikiRegex.exec(content)) !== null) {
    const embed = match[1].trim();
    if (embed) embeds.add(embed);
  }
  const mdRegex = /!\[[^\]]*\]\(([^)]+)\)/g;
  while ((match = mdRegex.exec(content)) !== null) {
    const path = match[1];
    const fileName = path.split('/').pop() || path;
    if (fileName) embeds.add(decodeURIComponent(fileName));
  }
  return embeds;
};

const calculateBacklinks = (
  currentPath: string, 
  currentName: string, 
  fileContents: Record<string, string>
): Set<string> => {
  const backlinks = new Set<string>();

  const cleanBName = currentName.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '').toLowerCase();
  const cleanBPath = currentPath.replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '').toLowerCase();

  Object.entries(fileContents).forEach(([path, content]) => {
    if (path === currentPath) return;

    let isLinked = false;

    if (path.endsWith('.canvas')) {
      try {
        const canvasData = safeParseJson<{ nodes?: { type?: string; file?: string; text?: string }[] }>(content, {});
        if (canvasData.nodes && Array.isArray(canvasData.nodes)) {
          for (const node of canvasData.nodes) {
            if (node.type === 'file' && node.file) {
              let cleanTarget = node.file.replace(/\\/g, '/').replace(/^\.?\//, '').trim().toLowerCase();
              cleanTarget = cleanTarget.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '');

              const targetFilename = cleanTarget.includes('/') ? cleanTarget.split('/').pop()! : cleanTarget;

              if (cleanBName === cleanTarget || cleanBPath === cleanTarget || cleanBPath.endsWith('/' + cleanTarget) || cleanBName === targetFilename) {
                isLinked = true;
                break;
              }
            } else if (node.type === 'text' && typeof node.text === 'string') {
              const textContent = node.text;
              const wikiRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
              let match;
              while ((match = wikiRegex.exec(textContent)) !== null) {
                const rawTargetName = match[1].trim();
                let cleanTarget = rawTargetName.replace(/\\/g, '/').replace(/^\.?\//, '').trim().toLowerCase();
                cleanTarget = cleanTarget.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '');

                const targetFilename = cleanTarget.includes('/') ? cleanTarget.split('/').pop()! : cleanTarget;

                if (cleanBName === cleanTarget || cleanBPath === cleanTarget || cleanBPath.endsWith('/' + cleanTarget) || cleanBName === targetFilename) {
                  isLinked = true;
                  break;
                }
              }
              if (isLinked) break;

              const mdLinkRegex = /\[[^\]]*\]\(([^)]+)\)/g;
              let mdMatch;
              while ((mdMatch = mdLinkRegex.exec(textContent)) !== null) {
                let targetPath = mdMatch[1].trim();
                if (targetPath.startsWith('http://') || targetPath.startsWith('https://')) continue;

                try { targetPath = decodeURIComponent(targetPath); } catch { /* ignore decode errors */ }

                let cleanTarget = targetPath.replace(/\\/g, '/').replace(/^\.?\//, '').trim().toLowerCase();
                cleanTarget = cleanTarget.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '');

                const targetFilename = cleanTarget.includes('/') ? cleanTarget.split('/').pop()! : cleanTarget;

                if (cleanBName === cleanTarget || cleanBPath === cleanTarget || cleanBPath.endsWith('/' + cleanTarget) || cleanBName === targetFilename) {
                  isLinked = true;
                  break;
                }
              }
              if (isLinked) break;
            }
          }
        }
      } catch {
        // ignore canvas parse errors
      }
    } else {
      // Wiki links in markdown/text files
      const wikiRegex = /\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g;
      let match;
      while ((match = wikiRegex.exec(content)) !== null) {
        const rawTargetName = match[1].trim();
        let cleanTarget = rawTargetName.replace(/\\/g, '/').replace(/^\.?\//, '').trim().toLowerCase();
        cleanTarget = cleanTarget.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '');

        const targetFilename = cleanTarget.includes('/') ? cleanTarget.split('/').pop()! : cleanTarget;

        if (cleanBName === cleanTarget || cleanBPath === cleanTarget || cleanBPath.endsWith('/' + cleanTarget) || cleanBName === targetFilename) {
          isLinked = true;
          break;
        }
      }

      if (!isLinked) {
        // Markdown links
        const mdLinkRegex = /\[[^\]]*\]\(([^)]+)\)/g;
        let mdMatch;
        while ((mdMatch = mdLinkRegex.exec(content)) !== null) {
          let targetPath = mdMatch[1].trim();
          if (targetPath.startsWith('http://') || targetPath.startsWith('https://')) continue;

          try { targetPath = decodeURIComponent(targetPath); } catch { /* ignore decode errors */ }

          let cleanTarget = targetPath.replace(/\\/g, '/').replace(/^\.?\//, '').trim().toLowerCase();
          cleanTarget = cleanTarget.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '');

          const targetFilename = cleanTarget.includes('/') ? cleanTarget.split('/').pop()! : cleanTarget;

          if (cleanBName === cleanTarget || cleanBPath === cleanTarget || cleanBPath.endsWith('/' + cleanTarget) || cleanBName === targetFilename) {
            isLinked = true;
            break;
          }
        }
      }
    }

    if (isLinked) {
      const otherFileName = path.split('/').pop() || path;
      const otherBaseName = otherFileName.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.base$/, '');
      backlinks.add(otherBaseName);
    }
  });

  return backlinks;
};

const countWords = (content: string): number => {
  const bodyText = content.replace(/^---[\s\S]*?---/, '');
  const clean = bodyText.replace(/[#*`[\]()_-]/g, ' ');
  const words = clean.trim().split(/\s+/).filter(w => w.length > 0);
  return words.length;
};

const formatCellVal = (val: unknown): string => {
  if (val === undefined || val === null) return '';
  if (Array.isArray(val)) {
    return val.join(', ');
  }
  if (typeof val === 'object') {
    return JSON.stringify(val);
  }
  return String(val);
};

interface BaseSource {
  folder: string;
}

interface BaseColumn {
  property: string;
  visible?: boolean;
  width?: number;
}

interface BaseSort {
  property: string;
  direction: 'asc' | 'desc';
}

interface BaseFilter {
  property: string;
  operator: string;
  value: string;
}

interface BaseView {
  id: string;
  name: string;
  type: string;
  columns?: BaseColumn[];
  sort?: BaseSort[];
  filters?: BaseFilter[];
}

interface BaseConfig {
  version: number;
  source: BaseSource;
  views: BaseView[];
}

interface BaseRow {
  path: string;
  name: string;
  sha: string | null;
  properties: Record<string, unknown>;
}

interface BaseEditorProps {
  filePath: string;
  initialContent: string;
  initialSha: string | null;
  files: VaultFile[];
  fileContents: Record<string, string>;
  onSave: (content: string, sha: string | null) => Promise<{ sha: string }>;
  onSaveFile: (path: string, content: string, sha: string | null) => Promise<{ sha: string }>;
  onOpenNote: (path: string) => void;
  onLoadFileContent: (path: string, sha: string) => Promise<void>;
  onCreateFile: (extension: '.md' | '.txt' | '.canvas' | '.base', folderPath?: string) => Promise<void>;
  onPrefetchAll?: () => void;
  prefetchStatus?: 'idle' | 'fetching' | 'success' | 'error';
  prefetchProgress?: { loaded: number; total: number };
}

function parseBaseConfig(content: string): BaseConfig {
  let parsed: BaseConfig | null = null;
  try {
    parsed = parseYaml(content) as BaseConfig;
  } catch (e) {
    console.error('Failed to parse base file config:', e);
  }
  if (!parsed || typeof parsed !== 'object') {
    parsed = { version: 1, source: { folder: '' }, views: [] };
  }
  if (!parsed.views || parsed.views.length === 0) {
    parsed.views = [{
      id: 'view_1',
      name: 'Default View',
      type: 'table',
      columns: [{ property: 'file.name', visible: true, width: 200 }],
      sort: [],
      filters: []
    }];
  }
  return parsed;
}

export const BaseEditor: React.FC<BaseEditorProps> = ({
  filePath,
  initialContent,
  initialSha,
  files,
  fileContents,
  onSave,
  onSaveFile,
  onOpenNote,
  onLoadFileContent,
  onCreateFile,
  onPrefetchAll,
  prefetchStatus = 'idle',
  prefetchProgress = { loaded: 0, total: 0 },
}) => {
  const [viewMode, setViewMode] = useState<'table' | 'yaml'>('table');
  const [yamlContent, setYamlContent] = useState(initialContent);
  const [sha, setSha] = useState<string | null>(initialSha);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  // Parsed Config state
  const [config, setConfig] = useState<BaseConfig>(() => parseBaseConfig(initialContent));

  // Render-phase prop synchronization (Strictly tied to filePath & external content updates)
  const [prevFilePath, setPrevFilePath] = useState(filePath);
  const [prevInitialContent, setPrevInitialContent] = useState(initialContent);

  if (filePath !== prevFilePath) {
    setPrevFilePath(filePath);
    setPrevInitialContent(initialContent);
    setYamlContent(initialContent);
    setSha(initialSha);
    setConfig(parseBaseConfig(initialContent));
    setSaveStatus('idle');
    setErrorMessage('');
  } else if (initialContent !== prevInitialContent) {
    setPrevInitialContent(initialContent);
    setSha(initialSha);
    // Only update active content if the change is external (does not match what we last saved/have in memory)
    if (initialContent !== yamlContent) {
      setYamlContent(initialContent);
      setConfig(parseBaseConfig(initialContent));
    }
  }

  // Dropdown / UI states & refs
  const [propertiesMenuOpen, setPropertiesMenuOpen] = useState<'header' | 'floating' | null>(null);
  const [propertySearchQuery, setPropertySearchQuery] = useState('');
  const [isAddingFilter, setIsAddingFilter] = useState(false);
  const [isFolderSuggestionsOpen, setIsFolderSuggestionsOpen] = useState(false);

  const propertiesDropdownRef = useRef<HTMLDivElement>(null);
  const filterDropdownRef = useRef<HTMLDivElement>(null);
  const propertiesButtonRef = useRef<HTMLButtonElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const folderDropdownRef = useRef<HTMLDivElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  
  const [activeFilterSelect, setActiveFilterSelect] = useState<'prop' | 'op' | null>(null);
  const filterPropSelectRef = useRef<HTMLDivElement>(null);
  const filterOpSelectRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      
      const isPropertiesToggle = (target as Element).closest?.('.properties-toggle-btn');
      if (
        propertiesMenuOpen &&
        propertiesDropdownRef.current &&
        !propertiesDropdownRef.current.contains(target) &&
        !isPropertiesToggle
      ) {
        setPropertiesMenuOpen(null);
      }
      
      const isFilterToggle = (target as Element).closest?.('.filter-toggle-btn');
      if (
        isAddingFilter &&
        filterDropdownRef.current &&
        !filterDropdownRef.current.contains(target) &&
        !isFilterToggle
      ) {
        setIsAddingFilter(false);
      }

      const isFolderInputClick = folderInputRef.current?.contains(target);
      if (
        isFolderSuggestionsOpen &&
        folderDropdownRef.current &&
        !folderDropdownRef.current.contains(target) &&
        !isFolderInputClick
      ) {
        setIsFolderSuggestionsOpen(false);
      }

      if (
        activeFilterSelect &&
        !(event.target as Element).closest?.('.filter-select-toggle') &&
        !filterPropSelectRef.current?.contains(target) &&
        !filterOpSelectRef.current?.contains(target)
      ) {
        setActiveFilterSelect(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [propertiesMenuOpen, isAddingFilter, isFolderSuggestionsOpen, activeFilterSelect]);

  // Config state migrated to top of component to prevent TDZ issues during render-phase synchronization

  const activeView = useMemo<BaseView>(() => {
    return config.views?.[0] || {
      id: 'view_1',
      name: 'Default View',
      type: 'table',
      columns: [{ property: 'file.name', visible: true, width: 200 }],
      sort: [],
      filters: []
    };
  }, [config.views]);

  // Sync YAML text editor changes when config object changes
  const saveConfig = async (newConfig: BaseConfig) => {
    setConfig(newConfig);
    const newYaml = stringifyYaml(newConfig);
    setYamlContent(newYaml);
    setSaveStatus('saving');
    try {
      const result = await onSave(newYaml, sha);
      setSha(result.sha);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (e) {
      setSaveStatus('error');
      setErrorMessage(e instanceof Error ? e.message : 'Failed to save base config');
    }
  };

  // Handle direct YAML code editor saves
  const handleYamlSave = async () => {
    setSaveStatus('saving');
    try {
      const parsed = parseYaml(yamlContent) as BaseConfig;
      setConfig(parsed);
      const result = await onSave(yamlContent, sha);
      setSha(result.sha);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (e) {
      setSaveStatus('error');
      setErrorMessage(e instanceof Error ? e.message : 'Failed to save base YAML content');
    }
  };

  // Source Folder path prefixing
  const folder = typeof config.source?.folder === 'string' ? config.source.folder : '';
  const folderPrefix = useMemo(() => {
    if (!folder) return '';
    return folder.endsWith('/') ? folder : `${folder}/`;
  }, [folder]);

  // Extract all unique folder paths from files to provide suggestions
  const allFolders = useMemo(() => {
    const folders = new Set<string>();
    folders.add(''); // Root folder option
    files.forEach(f => {
      const parts = f.path.split('/');
      if (parts.length > 1) {
        let current = '';
        for (let i = 0; i < parts.length - 1; i++) {
          current = current ? `${current}/${parts[i]}` : parts[i];
          folders.add(current);
        }
      }
    });
    return Array.from(folders).sort();
  }, [files]);



  // Track in-flight and completed preloads to prevent duplicate requests
  const preloadedRef = useRef<Set<string>>(new Set());

  // Preload file contents for all notes in the database's source folder
  useEffect(() => {
    // Collect all matched files that need loading and aren't already loading
    const matchedFiles = files.filter(f => {
      if (!f.path.endsWith('.md')) return false;
      const isMatched = folderPrefix ? f.path.startsWith(folderPrefix) : true;
      return isMatched && fileContents[f.path] === undefined && !preloadedRef.current.has(f.path);
    });

    if (matchedFiles.length === 0) return;

    // Add them to the in-flight ref first to avoid triggering duplicate fetches on sub-renders
    matchedFiles.forEach(f => {
      preloadedRef.current.add(f.path);
    });

    // Process queue with a maximum concurrency limit of 5 concurrent fetches
    let nextIdx = 0;
    const next = () => {
      if (nextIdx >= matchedFiles.length) return;
      const file = matchedFiles[nextIdx++];
      onLoadFileContent(file.path, file.sha || '')
        .catch(err => {
          console.error('Failed to preload note content:', file.path, err);
          preloadedRef.current.delete(file.path); // Allow retry on failure
        })
        .finally(() => {
          next();
        });
    };

    // Kick off up to 5 concurrent requests
    for (let i = 0; i < Math.min(5, matchedFiles.length); i++) {
      next();
    }
  }, [folderPrefix, files, fileContents, onLoadFileContent]);

  // Extract all rows (notes) and their properties
  const allRows = useMemo<BaseRow[]>(() => {
    const matchedFiles = files.filter(f => {
      if (!f.path.endsWith('.md')) return false;
      return folderPrefix ? f.path.startsWith(folderPrefix) : true;
    });

    return matchedFiles.map(file => {
      const content = fileContents[file.path] || '';
      const { frontmatter } = parseFrontmatter(content);
      const cleanName = file.name.replace(/\.md$/, '');

      const oLinks = extractLinks(content);
      const embeds = extractEmbeds(content);
      const tags = extractTags(content, frontmatter);
      const bLinks = calculateBacklinks(file.path, file.name, fileContents);

      return {
        path: file.path,
        name: file.name,
        sha: file.sha || null,
        properties: {
          'file.name': cleanName,
          'file name': file.name,
          'file backlinks': Array.from(bLinks).join(', '),
          'created time': getStableDate(file.path, 15),
          'file extension': file.path.split('.').pop() || 'md',
          'modified time': getStableDate(file.path, 3),
          'file base name': cleanName,
          'file embeds': Array.from(embeds).join(', '),
          'folder': file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '/',
          'file full name': file.path,
          'file links': Array.from(oLinks).join(', '),
          'file path': file.path,
          'file size': file.size !== undefined ? formatBytes(file.size) : formatBytes(content.length),
          'file tags': Array.from(tags).join(', '),
          'formula': `${countWords(content)} words | ${bLinks.size} backlinks`,
          ...frontmatter
        }
      };
    });
  }, [files, folderPrefix, fileContents]);

  // Gather all unique property keys present in the frontmatter of any note in this folder
  const availableProperties = useMemo(() => {
    const keys = new Set<string>();
    keys.add('file.name');
    allRows.forEach(row => {
      Object.keys(row.properties).forEach(k => {
        if (k !== 'file.name') keys.add(k);
      });
    });
    return Array.from(keys);
  }, [allRows]);

  // Cells inline-edit state
  const [editingCell, setEditingCell] = useState<{ rowPath: string; colKey: string } | null>(null);
  const [editingValue, setEditingValue] = useState('');
  const editInputRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);

  useEffect(() => {
    if (editingCell && editInputRef.current) {
      editInputRef.current.focus();
    }
  }, [editingCell]);

  // Gather existing unique values for a column to populate select dropdowns
  const getUniqueColumnValues = (colKey: string) => {
    const vals = new Set<string>();
    allRows.forEach(row => {
      const v = row.properties[colKey];
      if (v && typeof v !== 'object') {
        vals.add(String(v));
      }
    });
    return Array.from(vals);
  };

  // Handle cell edit save
  const handleCellSave = async (rowPath: string, colKey: string, newValue: string) => {
    setEditingCell(null);
    if (colKey === 'file.name') return; // Cannot edit file.name this way (use rename)

    const row = allRows.find(r => r.path === rowPath);
    if (!row) return;

    const currentVal = row.properties[colKey];
    if (String(currentVal ?? '') === newValue) return; // No change

    const currentContent = fileContents[rowPath] || '';
    const updatedContent = updateFrontmatter(currentContent, { [colKey]: newValue });

    setSaveStatus('saving');
    try {
      await onSaveFile(rowPath, updatedContent, row.sha);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (e) {
      setSaveStatus('error');
      setErrorMessage(e instanceof Error ? e.message : 'Failed to update note property');
    }
  };

  // Add/Remove/Toggle Column config
  const toggleColumnVisibility = (colKey: string) => {
    const currentCols = activeView.columns || [];
    const matchedIdx = currentCols.findIndex((c) => c.property === colKey);
    const newCols = [...currentCols];

    if (matchedIdx !== -1) {
      newCols[matchedIdx] = {
        ...newCols[matchedIdx],
        visible: !newCols[matchedIdx].visible
      };
    } else {
      newCols.push({ property: colKey, visible: true });
    }

    const updatedViews = [...config.views];
    updatedViews[0] = { ...activeView, columns: newCols };
    saveConfig({ ...config, views: updatedViews });
  };

  const dropdownPropertiesList = useMemo(() => {
    const customKeys = availableProperties.filter(p => 
      p !== 'file.name' && p !== 'formula' && !INBUILT_PROPERTIES.some(ip => ip.key === p)
    );

    const allProps = INBUILT_PROPERTIES.map(ip => {
      const col = activeView.columns?.find(c => c.property === ip.key || (ip.key === 'file name' && c.property === 'file.name'));
      const checked = col ? col.visible !== false : false;
      return {
        ...ip,
        checked
      };
    });

    customKeys.forEach(ck => {
      const col = activeView.columns?.find(c => c.property === ck);
      const checked = col ? col.visible !== false : false;
      allProps.push({
        key: ck,
        label: ck,
        icon: 'text' as const,
        checked
      });
    });

    return allProps;
  }, [availableProperties, activeView.columns]);

  const filteredDropdownProperties = useMemo(() => {
    const query = propertySearchQuery.trim().toLowerCase();
    if (!query) return dropdownPropertiesList;
    return dropdownPropertiesList.filter(p => p.label.toLowerCase().includes(query));
  }, [dropdownPropertiesList, propertySearchQuery]);

  const showCreateOption = useMemo(() => {
    const query = propertySearchQuery.trim();
    if (!query) return false;
    return !dropdownPropertiesList.some(p => p.key.toLowerCase() === query.toLowerCase());
  }, [dropdownPropertiesList, propertySearchQuery]);

  const handleCreateCustomProperty = (name: string) => {
    const cleanName = name.trim();
    if (!cleanName) return;
    toggleColumnVisibility(cleanName);
    setPropertySearchQuery('');
  };

  const handleHideAllColumns = () => {
    const currentCols = activeView.columns || [];
    const newCols = currentCols.map(c => {
      if (c.property === 'file.name' || c.property === 'file name') {
        return { ...c, visible: true };
      }
      return { ...c, visible: false };
    });
    if (!newCols.some(c => c.property === 'file.name' || c.property === 'file name')) {
      newCols.push({ property: 'file name', visible: true, width: 200 });
    }
    const updatedViews = [...config.views];
    updatedViews[0] = { ...activeView, columns: newCols };
    saveConfig({ ...config, views: updatedViews });
  };

  const handleAddFormulaColumn = () => {
    const currentCols = activeView.columns || [];
    if (currentCols.some(c => c.property === 'formula')) {
      const newCols = currentCols.map(c => c.property === 'formula' ? { ...c, visible: true } : c);
      const updatedViews = [...config.views];
      updatedViews[0] = { ...activeView, columns: newCols };
      saveConfig({ ...config, views: updatedViews });
      return;
    }
    const newCols = [...currentCols, { property: 'formula', visible: true, width: 180 }];
    const updatedViews = [...config.views];
    updatedViews[0] = { ...activeView, columns: newCols };
    saveConfig({ ...config, views: updatedViews });
  };

  // Filter Configuration State
  const [filterProp, setFilterProp] = useState('file.name');
  const [filterOp, setFilterOp] = useState('contains');
  const [filterVal, setFilterVal] = useState('');

  const handleAddFilter = () => {
    const currentFilters = activeView.filters || [];
    const newFilters = [
      ...currentFilters,
      { property: filterProp, operator: filterOp, value: filterVal }
    ];

    const updatedViews = [...config.views];
    updatedViews[0] = { ...activeView, filters: newFilters };
    saveConfig({ ...config, views: updatedViews });

    setIsAddingFilter(false);
    setFilterVal('');
  };

  const handleRemoveFilter = (index: number) => {
    const currentFilters = activeView.filters || [];
    const newFilters = currentFilters.filter((_, i) => i !== index);

    const updatedViews = [...config.views];
    updatedViews[0] = { ...activeView, filters: newFilters };
    saveConfig({ ...config, views: updatedViews });
  };

  // Sorting Config
  const handleSortCycle = (colKey: string) => {
    const currentSort = activeView.sort || [];
    const matchIdx = currentSort.findIndex((s) => s.property === colKey);
    let newSort = [...currentSort];

    if (matchIdx !== -1) {
      const currentDir = currentSort[matchIdx].direction;
      if (currentDir === 'asc') {
        newSort[matchIdx] = { property: colKey, direction: 'desc' };
      } else {
        newSort = newSort.filter((_, i) => i !== matchIdx);
      }
    } else {
      newSort.push({ property: colKey, direction: 'asc' });
    }

    const updatedViews = [...config.views];
    updatedViews[0] = { ...activeView, sort: newSort };
    saveConfig({ ...config, views: updatedViews });
  };

  // Filtered & Sorted Rows computation
  const filteredAndSortedRows = useMemo(() => {
    let rows = [...allRows];

    // Apply Filters
    const filters = activeView.filters || [];
    filters.forEach((f) => {
      rows = rows.filter(row => {
        const val = row.properties[f.property];
        const valStr = val === undefined || val === null ? '' : String(val).toLowerCase();
        const compStr = String(f.value).toLowerCase();

        switch (f.operator) {
          case 'equals':
            return valStr === compStr;
          case 'not_equals':
            return valStr !== compStr;
          case 'contains':
            return valStr.includes(compStr);
          case 'is_empty':
            return valStr === '';
          case 'is_not_empty':
            return valStr !== '';
          default:
            return true;
        }
      });
    });

    // Apply Sorting
    const sort = activeView.sort || [];
    if (sort.length > 0) {
      rows.sort((a, b) => {
        for (const s of sort) {
          const valA = a.properties[s.property];
          const valB = b.properties[s.property];

          if (valA === valB) continue;
          if (valA === undefined || valA === null) return 1;
          if (valB === undefined || valB === null) return -1;

          const isNum = typeof valA === 'number' && typeof valB === 'number';
          const multiplier = s.direction === 'desc' ? -1 : 1;

          if (isNum) {
            return ((valA as number) - (valB as number)) * multiplier;
          } else {
            return String(valA).localeCompare(String(valB)) * multiplier;
          }
        }
        return 0;
      });
    }

    return rows;
  }, [allRows, activeView]);

  // Columns to show
  const visibleColumns = useMemo(() => {
    const configCols = activeView.columns || [];
    return configCols.filter((c) => c.visible !== false);
  }, [activeView]);

  // Row creation handlers
  const [showAddRowModal, setShowAddRowModal] = useState(false);
  const [newRowName, setNewRowName] = useState('');

  const handleCreateRowSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const cleanName = newRowName.trim();
    if (!cleanName) return;

    // Check collision
    const extension = '.md';
    const targetPath = folderPrefix ? `${folderPrefix}${cleanName}${extension}` : `${cleanName}${extension}`;
    if (files.some(f => f.path === targetPath)) {
      alert(`A file named "${cleanName}.md" already exists in the folder.`);
      return;
    }

    const initialProps: Record<string, unknown> = {};
    activeView.columns?.forEach((col) => {
      if (col.property !== 'file.name') {
        initialProps[col.property] = '';
      }
    });

    const initialContent = updateFrontmatter(
      "",
      initialProps
    );

    setSaveStatus('saving');
    try {
      await onCreateFile('.md', folder || undefined);
      await onSaveFile(targetPath, initialContent, null);
      
      setSaveStatus('saved');
      setShowAddRowModal(false);
      setNewRowName('');
      setTimeout(() => setSaveStatus('idle'), 2000);
    } catch (e) {
      setSaveStatus('error');
      setErrorMessage(e instanceof Error ? e.message : 'Failed to create database row');
    }
  };

  // Change Source Folder
  const [sourceFolderVal, setSourceFolderVal] = useState(folder);
  const [prevFolder, setPrevFolder] = useState(folder);

  if (folder !== prevFolder) {
    setPrevFolder(folder);
    setSourceFolderVal(folder);
  }

  // Filter folder suggestions based on search query
  const filteredFolders = useMemo(() => {
    const query = sourceFolderVal.trim().toLowerCase();
    if (!query) return allFolders;
    return allFolders.filter(f => f.toLowerCase().includes(query));
  }, [allFolders, sourceFolderVal]);

  const handleUpdateSourceFolder = (e: React.FormEvent) => {
    e.preventDefault();
    const updatedSource = { folder: sourceFolderVal.trim() };
    saveConfig({ ...config, source: updatedSource });
    setIsFolderSuggestionsOpen(false);
  };

  const renderPropertiesDropdown = (position: 'header' | 'floating') => {
    return (
      <div 
        ref={propertiesDropdownRef}
        className={cn(
          "w-auto sm:w-72 bg-[#18181f]/95 backdrop-blur-xl border border-border/60 rounded-2xl shadow-2xl p-3 flex flex-col gap-2.5 z-30 duration-100 text-foreground text-left normal-case font-normal",
          position === 'header' 
            ? "fixed top-32 left-4 right-4 sm:absolute sm:top-full sm:right-0 sm:left-auto sm:w-72 sm:mt-2 animate-in fade-in slide-in-from-top-2" 
            : "fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] left-4 right-4 sm:absolute sm:bottom-full sm:left-1/2 sm:-translate-x-1/2 sm:right-auto sm:mb-3 animate-in fade-in slide-in-from-bottom-2"
        )}
      >
        {/* Search Bar */}
        <div className="relative flex items-center">
          <Search size={12} className="absolute left-3 text-muted-foreground" />
          <input
            type="text"
            value={propertySearchQuery}
            onChange={(e) => setPropertySearchQuery(e.target.value)}
            placeholder="Find or create..."
            className="w-full bg-[#0e0f14] border border-border/80 text-foreground pl-8 pr-3 py-1.5 rounded-xl text-[0.72rem] focus:outline-none focus:border-indigo-500 transition-all font-medium"
            autoFocus
          />
        </div>

        {/* Create Option */}
        {showCreateOption && (
          <button
            onClick={() => handleCreateCustomProperty(propertySearchQuery)}
            className="w-full text-left px-2 py-1.5 rounded-xl hover:bg-white/[0.04] text-xs font-bold text-accent transition-colors flex items-center gap-1.5 cursor-pointer"
          >
            <Plus size={12} />
            <span>Create "{propertySearchQuery.trim()}"</span>
          </button>
        )}

        {/* Properties List */}
        <div className="flex flex-col gap-0.5 max-h-64 overflow-y-auto pr-0.5">
          {filteredDropdownProperties.map((prop) => {
            return (
              <div
                key={prop.key}
                onClick={() => toggleColumnVisibility(prop.key)}
                className="group px-2 py-1.5 hover:bg-white/[0.04] rounded-xl flex items-center justify-between cursor-pointer transition-colors"
              >
                <div className="flex items-center gap-2.5">
                  {/* Checkbox */}
                  <div className={cn(
                    "w-4 h-4 rounded-md border flex items-center justify-center transition-all shrink-0",
                    prop.checked 
                      ? "bg-indigo-600 border-indigo-600 text-white" 
                      : "border-border group-hover:border-muted-foreground/60"
                  )}>
                    {prop.checked && <Check size={11} className="stroke-[3]" />}
                  </div>

                  {/* Property Type Icon */}
                  <div className="text-muted-foreground/75">
                    {prop.icon === 'info' && <Info size={13} />}
                    {prop.icon === 'calendar' && <Calendar size={13} />}
                    {prop.icon === 'tag' && <Tag size={13} />}
                    {prop.icon === 'text' && <AlignLeft size={13} />}
                  </div>

                  {/* Property Label */}
                  <span className="text-[0.72rem] font-semibold text-foreground/90 select-none">
                    {prop.label}
                  </span>
                </div>

                {/* Right arrow */}
                <span className="text-muted-foreground/35 group-hover:text-muted-foreground/60 transition-colors text-[0.65rem] font-bold pr-1 select-none">
                  ❯
                </span>
              </div>
            );
          })}
          {filteredDropdownProperties.length === 0 && !showCreateOption && (
            <span className="text-center py-4 text-[0.68rem] text-muted-foreground italic select-none">
              No properties found
            </span>
          )}
        </div>

        {/* Divider */}
        <div className="h-px bg-border/60 my-0.5" />

        {/* Bottom Options */}
        <div className="flex flex-col gap-1">
          <button
            onClick={handleAddFormulaColumn}
            className="w-full text-left px-2 py-1.5 rounded-xl hover:bg-white/[0.04] text-[0.72rem] font-bold text-foreground/90 transition-colors flex items-center gap-2.5 cursor-pointer"
          >
            <div className="w-5 h-5 rounded-md bg-indigo-500/10 text-indigo-400 flex items-center justify-center border border-indigo-500/25 shrink-0 text-[0.65rem] font-mono font-bold">
              f
            </div>
            <span>Add formula</span>
          </button>
          
          <button
            onClick={handleHideAllColumns}
            className="w-full text-left px-2 py-1.5 rounded-xl hover:bg-white/[0.04] text-[0.72rem] font-bold text-foreground/90 transition-colors flex items-center gap-2.5 cursor-pointer"
          >
            <div className="w-5 h-5 rounded-md bg-muted text-muted-foreground flex items-center justify-center shrink-0">
              <EyeOff size={11} />
            </div>
            <span>Hide all</span>
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="flex-1 w-full h-full flex flex-col bg-background overflow-hidden relative select-text text-foreground animate-fade-in animate-duration-200">
      {/* 1. Header Toolbar */}
      <header className="h-14 bg-card/80 backdrop-blur-xl border-b border-border flex items-center justify-between px-4 sm:px-6 shrink-0 z-30 select-none gap-4">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center border border-indigo-500/25 shrink-0">
            <Database size={15} />
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-xs font-bold text-foreground truncate">
              {filePath.split('/').pop()}
            </span>
            <span className="text-[0.6rem] text-muted-foreground font-semibold truncate">
              Obsidian Base View ({filteredAndSortedRows.length} rows matched)
            </span>
          </div>
        </div>

        {/* Center/Right controls: Folder input & Save status */}
        <div className="flex items-center gap-3 shrink-0">
          {/* Source Folder edit form */}
          <form onSubmit={handleUpdateSourceFolder} className="flex items-center gap-1.5 relative">
            <Folders size={12} className="text-primary shrink-0" />
            <input
              ref={folderInputRef}
              type="text"
              value={sourceFolderVal}
              onChange={(e) => setSourceFolderVal(e.target.value)}
              onFocus={() => setIsFolderSuggestionsOpen(true)}
              placeholder="Source folder..."
              className="h-7.5 bg-muted/50 border border-border text-foreground px-2.5 rounded-xl text-[0.72rem] focus:outline-none focus:border-primary transition-all w-24 sm:w-36 font-semibold"
            />
            {isFolderSuggestionsOpen && filteredFolders.length > 0 && (
              <div 
                ref={folderDropdownRef}
                className="absolute top-full left-0 mt-1.5 w-48 bg-[#18181f]/95 backdrop-blur-xl border border-border/60 rounded-xl shadow-2xl p-1 flex flex-col gap-0.5 z-40 max-h-56 overflow-y-auto no-scrollbar animate-in fade-in slide-in-from-top-1 duration-100"
              >
                {filteredFolders.map((fPath) => (
                  <button
                    key={fPath}
                    type="button"
                    onClick={() => {
                      setSourceFolderVal(fPath);
                      setIsFolderSuggestionsOpen(false);
                    }}
                    className="w-full text-left px-2.5 py-1.5 hover:bg-white/[0.04] text-[0.72rem] font-semibold text-foreground/95 rounded-lg transition-all duration-100 flex items-center gap-2 cursor-pointer border border-transparent hover:border-border/10"
                  >
                    <Folders size={11} className="text-primary/70 shrink-0" />
                    <span className="truncate">{fPath === '' ? '/ (root)' : fPath}</span>
                  </button>
                ))}
              </div>
            )}
            {sourceFolderVal !== folder && (
              <button
                type="submit"
                className="h-7.5 px-2 bg-indigo-600 hover:bg-indigo-500 text-white text-[0.65rem] font-bold rounded-xl cursor-pointer transition-all shrink-0"
              >
                Update
              </button>
            )}
          </form>

          {/* Save Status indicators */}
          {saveStatus !== 'idle' && (
            <div className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[0.65rem] font-bold border shrink-0",
              saveStatus === 'saving' && "bg-primary/10 border-primary/20 text-primary animate-pulse-soft",
              saveStatus === 'saved' && "bg-accent/10 border-accent/20 text-accent",
              saveStatus === 'error' && "bg-destructive/10 border-destructive/20 text-destructive"
            )}>
              {saveStatus === 'saving' ? (
                <RefreshCw size={10} className="animate-spin" />
              ) : saveStatus === 'saved' ? (
                <Check size={10} />
              ) : (
                <X size={10} />
              )}
              <span className="hidden sm:inline">
                {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : errorMessage || 'Error'}
              </span>
            </div>
          )}
        </div>
      </header>

      {/* 2. Primary Workspace Body */}
      <div className="flex-1 w-full overflow-hidden relative">
        {viewMode === 'yaml' ? (
          /* YAML Code View Editor */
          <div className="w-full h-full flex flex-col p-6 bg-background relative overflow-hidden">
            <div className="flex-1 w-full border border-border bg-[#0d0e12]/80 backdrop-blur-md rounded-2xl overflow-hidden flex flex-col">
              <div className="h-10 bg-card/65 border-b border-border/80 flex items-center justify-between px-4 shrink-0 select-none">
                <span className="text-[0.65rem] font-bold text-muted-foreground uppercase tracking-widest">
                  Direct Configuration Editor
                </span>
                <button
                  onClick={handleYamlSave}
                  className="h-6.5 px-3 bg-indigo-600 hover:bg-indigo-500 text-white text-[0.65rem] font-bold rounded-lg cursor-pointer transition-all shadow-md shadow-indigo-600/10 flex items-center gap-1"
                >
                  Save Config
                </button>
              </div>
              <textarea
                value={yamlContent}
                onChange={(e) => setYamlContent(e.target.value)}
                placeholder="# YAML Configuration here"
                className="flex-1 w-full bg-transparent text-foreground p-5 font-mono text-[0.72rem] leading-relaxed resize-none focus:outline-none overflow-y-auto"
              />
            </div>
          </div>
        ) : (
          /* Visual Table Database View */
          <div className="w-full h-full flex flex-col overflow-hidden bg-background">
            
            {/* Displaying active filter badges */}
            {(activeView.filters || []).length > 0 && (
              <div className="px-6 py-2 border-b border-border/40 bg-card/10 flex flex-wrap gap-1.5 items-center select-none shrink-0">
                <span className="text-[0.6rem] font-bold text-muted-foreground uppercase tracking-widest mr-1">Active Filters:</span>
                {(activeView.filters || []).map((f, idx) => (
                  <div key={idx} className="flex items-center gap-1 bg-white/[0.04] border border-border px-2.5 py-0.5 rounded-full text-[0.68rem] text-muted-foreground animate-fade-in">
                    <span className="font-semibold text-primary">{f.property}</span>
                    <span>{f.operator}</span>
                    {f.operator !== 'is_empty' && f.operator !== 'is_not_empty' && (
                      <span className="font-semibold text-accent">"{f.value}"</span>
                    )}
                    <button
                      onClick={() => handleRemoveFilter(idx)}
                      className="text-muted-foreground/60 hover:text-foreground font-bold ml-1 cursor-pointer"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* 3. The Interactive Grid Table Container */}
            <div className="flex-1 w-full overflow-auto">
              <table className="w-full text-left border-collapse table-fixed min-w-[700px]">
                {/* Table Header */}
                <thead className="bg-[#0b0c10]/90 backdrop-blur-md border-b border-border/80 sticky top-0 z-20 select-none">
                  <tr>
                    {/* Header Columns */}
                    {visibleColumns.map((col) => {
                      const isSorting = (activeView.sort || []).some((s) => s.property === col.property);
                      const sortDir = (activeView.sort || []).find((s) => s.property === col.property)?.direction;

                      return (
                        <th
                          key={col.property}
                          style={{ width: col.width || 180 }}
                          className="px-4 py-3 text-[0.68rem] font-bold text-muted-foreground uppercase tracking-wider relative group"
                        >
                          <div 
                            className="flex items-center gap-1.5 cursor-pointer hover:text-foreground transition-all"
                            onClick={() => handleSortCycle(col.property)}
                          >
                            <span>{col.property === 'file.name' || col.property === 'file name' ? 'Note Title' : col.property}</span>
                            <ArrowUpDown size={11} className={cn("shrink-0 transition-colors", isSorting ? "text-accent" : "text-muted-foreground/30")} />
                            {isSorting && (
                              <span className="text-[0.55rem] text-accent lowercase">({sortDir})</span>
                            )}
                          </div>

                          {/* Hide Column / dropdown operations */}
                          {col.property !== 'file.name' && col.property !== 'file name' && (
                            <button
                              onClick={() => toggleColumnVisibility(col.property)}
                              title="Hide Column"
                              className="absolute right-2.5 top-1/2 -translate-y-1/2 w-5 h-5 rounded-md hover:bg-white/[0.05] hover:text-foreground text-muted-foreground/45 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all cursor-pointer"
                            >
                              ✕
                            </button>
                          )}
                        </th>
                      );
                    })}

                    {/* Action header cell for adding new columns */}
                    <th className="px-4 py-2 w-44">
                      <div className="relative inline-block">
                        <button
                          onClick={() => {
                            setIsAddingFilter(false);
                            setPropertiesMenuOpen(prev => prev === 'header' ? null : 'header');
                          }}
                          className="properties-toggle-btn h-7 px-2.5 bg-muted/40 hover:bg-muted/70 border border-dashed border-border rounded-lg text-[0.65rem] font-bold text-muted-foreground hover:text-foreground transition-all flex items-center gap-1 cursor-pointer"
                        >
                          <Plus size={11} />
                          <span>Add Property</span>
                        </button>
                        {propertiesMenuOpen === 'header' && renderPropertiesDropdown('header')}
                      </div>
                    </th>
                  </tr>
                </thead>

                {/* Table Body */}
                <tbody className="divide-y divide-border/40 bg-card/5">
                  {filteredAndSortedRows.map((row) => {
                    return (
                      <tr 
                        key={row.path}
                        className="hover:bg-white/[0.02] transition-colors"
                      >
                        {visibleColumns.map((col) => {
                          const colKey = col.property;
                          const cellVal = row.properties[colKey];
                          const isEditing = editingCell?.rowPath === row.path && editingCell?.colKey === colKey;

                          if (colKey === 'file.name' || colKey === 'file name') {
                            // Note Link Title column
                            return (
                              <td 
                                key={colKey} 
                                className="px-4 py-3 truncate max-w-xs text-xs font-semibold"
                                title={cellVal as string}
                              >
                                <button
                                  onClick={() => onOpenNote(row.path)}
                                  className="text-primary hover:text-accent font-bold text-left truncate transition-colors hover:underline flex items-center gap-2 cursor-pointer w-full"
                                >
                                  <FileText size={13} className="text-primary/70 shrink-0" />
                                  <span className="truncate">{cellVal as string}</span>
                                </button>
                              </td>
                            );
                          }

                          return (
                            <td 
                              key={colKey}
                              onClick={() => {
                                const isReadOnly = [
                                  'file name', 'file backlinks', 'created time', 'file extension', 
                                  'modified time', 'file base name', 'file embeds', 'folder', 
                                  'file full name', 'file links', 'file path', 'file size', 'file tags',
                                  'formula'
                                ].includes(colKey);
                                if (!isEditing && !isReadOnly && colKey !== 'file.name') {
                                  setEditingCell({ rowPath: row.path, colKey });
                                  setEditingValue(cellVal === undefined || cellVal === null ? '' : formatCellVal(cellVal));
                                }
                              }}
                              className="px-4 py-2 text-xs text-foreground/80 truncate max-w-xs cursor-pointer hover:bg-white/[0.015]"
                              title={cellVal !== undefined && cellVal !== null && cellVal !== '' ? formatCellVal(cellVal) : ''}
                            >
                              {isEditing ? (
                                <div className="flex items-center gap-1.5">
                                  {/* Smart select dropdown if unique values already exist, otherwise text input */}
                                  {getUniqueColumnValues(colKey).length > 0 ? (
                                    <select
                                      ref={(el) => {
                                        editInputRef.current = el;
                                      }}
                                      value={editingValue}
                                      onChange={(e) => setEditingValue(e.target.value)}
                                      onBlur={() => handleCellSave(row.path, colKey, editingValue)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleCellSave(row.path, colKey, editingValue);
                                        if (e.key === 'Escape') setEditingCell(null);
                                      }}
                                      className="w-full bg-[#12131a] border border-primary/50 text-foreground px-2 py-0.5 rounded-md text-xs focus:outline-none"
                                    >
                                      <option value="">-- select or type below --</option>
                                      {getUniqueColumnValues(colKey).map(val => (
                                        <option key={val} value={val}>{val}</option>
                                      ))}
                                    </select>
                                  ) : null}
                                  
                                  {/* Text input for direct entry */}
                                  {getUniqueColumnValues(colKey).length === 0 || editingValue === '' ? (
                                    <input
                                      ref={(el) => {
                                        editInputRef.current = el;
                                      }}
                                      type="text"
                                      value={editingValue}
                                      onChange={(e) => setEditingValue(e.target.value)}
                                      onBlur={() => handleCellSave(row.path, colKey, editingValue)}
                                      onKeyDown={(e) => {
                                        if (e.key === 'Enter') handleCellSave(row.path, colKey, editingValue);
                                        if (e.key === 'Escape') setEditingCell(null);
                                      }}
                                      className="w-full bg-[#12131a] border border-primary/50 text-foreground px-2 py-0.5 rounded-md text-xs focus:outline-none"
                                    />
                                  ) : null}
                                </div>
                              ) : (
                                <span className={cn(
                                  "truncate select-all",
                                  (!cellVal || cellVal === '') && "text-muted-foreground/35 italic"
                                )}>
                                  {cellVal !== undefined && cellVal !== null && cellVal !== '' ? formatCellVal(cellVal) : 'empty'}
                                </span>
                              )}
                            </td>
                          );
                        })}

                        {/* Actions row cell */}
                        <td className="px-4 py-2 w-44">
                          {/* We don't render content here, just padding alignment */}
                        </td>
                      </tr>
                    );
                  })}

                  {filteredAndSortedRows.length === 0 && (
                    <tr>
                      <td 
                        colSpan={visibleColumns.length + 1}
                        className="px-6 py-12 text-center text-xs text-muted-foreground italic select-none"
                      >
                        No matching notes found. Try adding a row or modifying your filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

          </div>
        )}
      </div>

      {/* Floating Panel Controls */}
      <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 sm:bottom-6 sm:right-6 flex items-center gap-1.5 z-50 bg-card/65 backdrop-blur-xl border border-border px-3 py-2 rounded-full shadow-2xl animate-fade-in select-none max-w-[calc(100%-2rem)]">
        {viewMode === 'table' && (
          <>
            <button
              onClick={() => setShowAddRowModal(true)}
              className="h-8 px-3 rounded-full bg-gradient-to-r from-primary to-accent hover:from-primary/95 hover:to-accent/95 text-white text-xs font-semibold flex items-center gap-1.5 cursor-pointer transition-all shadow-md shadow-primary/10 shrink-0"
              title="Add Row (New Note)"
            >
              <PlusCircle size={14.5} />
              <span className="hidden sm:inline">Add Row</span>
            </button>

            <div className="w-[1px] h-6 bg-border mx-1 shrink-0" />

            {/* Filters control button */}
            <div className="relative">
              <button
                ref={filterButtonRef}
                onClick={() => {
                  setPropertiesMenuOpen(null);
                  setIsAddingFilter(!isAddingFilter);
                }}
                className={cn(
                  "filter-toggle-btn w-8 h-8 sm:w-auto sm:px-3 rounded-full flex items-center justify-center gap-1.5 text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer shrink-0",
                  isAddingFilter && "bg-primary/10 text-accent border border-primary/20"
                )}
                title="Filters"
              >
                <Filter size={14.5} className="text-primary" />
                <span className="hidden sm:inline text-xs font-semibold">Filter</span>
              </button>
              {isAddingFilter && (
                <div 
                  ref={filterDropdownRef}
                  className="fixed bottom-[calc(4.75rem+env(safe-area-inset-bottom))] left-4 right-4 sm:absolute sm:bottom-full sm:left-1/2 sm:-translate-x-1/2 sm:right-auto sm:mb-3 w-auto sm:w-72 bg-[#12131a]/95 backdrop-blur-xl border border-border rounded-xl shadow-2xl p-4 flex flex-col gap-3 z-30 animate-in fade-in slide-in-from-bottom-2 duration-100 text-foreground"
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-foreground">Create Filter</span>
                    <button onClick={() => setIsAddingFilter(false)} className="text-muted-foreground hover:text-foreground" type="button">✕</button>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="text-[0.62rem] font-bold text-muted-foreground uppercase">Property</label>
                    <div className="relative" ref={filterPropSelectRef}>
                      <button
                        type="button"
                        onClick={() => setActiveFilterSelect(prev => prev === 'prop' ? null : 'prop')}
                        className="filter-select-toggle w-full h-8 bg-muted/50 hover:bg-muted border border-border rounded-xl px-3 flex items-center justify-between text-xs text-foreground focus:outline-none transition-all cursor-pointer font-semibold"
                      >
                        <span className="truncate">{filterProp}</span>
                        <ChevronDown size={13} className="text-muted-foreground/60 shrink-0 ml-1" />
                      </button>
                      {activeFilterSelect === 'prop' && (
                        <div className="absolute bottom-full left-0 mb-1.5 w-full bg-[#18181f] border border-border/60 rounded-xl shadow-2xl p-1 flex flex-col gap-0.5 z-50 max-h-48 overflow-y-auto no-scrollbar animate-in fade-in slide-in-from-bottom-1 duration-100">
                          {availableProperties.map(p => (
                            <button
                              key={p}
                              type="button"
                              onClick={() => {
                                setFilterProp(p);
                                setActiveFilterSelect(null);
                              }}
                              className={cn(
                                "w-full text-left px-2.5 py-1.5 text-[0.72rem] font-semibold rounded-lg transition-all flex items-center justify-between cursor-pointer border border-transparent hover:border-border/10",
                                filterProp === p 
                                  ? "bg-primary/15 text-accent" 
                                  : "text-foreground/90 hover:bg-white/[0.04]"
                              )}
                            >
                              <span className="truncate">{p}</span>
                              {filterProp === p && <Check size={11} className="text-accent stroke-[3] shrink-0" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col gap-2">
                    <label className="text-[0.62rem] font-bold text-muted-foreground uppercase">Operator</label>
                    <div className="relative" ref={filterOpSelectRef}>
                      <button
                        type="button"
                        onClick={() => setActiveFilterSelect(prev => prev === 'op' ? null : 'op')}
                        className="filter-select-toggle w-full h-8 bg-muted/50 hover:bg-muted border border-border rounded-xl px-3 flex items-center justify-between text-xs text-foreground focus:outline-none transition-all cursor-pointer font-semibold"
                      >
                        <span className="truncate">{
                          filterOp === 'contains' ? 'contains' :
                          filterOp === 'equals' ? 'equals' :
                          filterOp === 'not_equals' ? 'does not equal' :
                          filterOp === 'is_empty' ? 'is empty' :
                          filterOp === 'is_not_empty' ? 'is not empty' : filterOp
                        }</span>
                        <ChevronDown size={13} className="text-muted-foreground/60 shrink-0 ml-1" />
                      </button>
                      {activeFilterSelect === 'op' && (
                        <div className="absolute bottom-full left-0 mb-1.5 w-full bg-[#18181f] border border-border/60 rounded-xl shadow-2xl p-1 flex flex-col gap-0.5 z-50 max-h-48 overflow-y-auto no-scrollbar animate-in fade-in slide-in-from-bottom-1 duration-100">
                          {[
                            { value: 'contains', label: 'contains' },
                            { value: 'equals', label: 'equals' },
                            { value: 'not_equals', label: 'does not equal' },
                            { value: 'is_empty', label: 'is empty' },
                            { value: 'is_not_empty', label: 'is not empty' },
                          ].map(o => (
                            <button
                              key={o.value}
                              type="button"
                              onClick={() => {
                                setFilterOp(o.value);
                                setActiveFilterSelect(null);
                              }}
                              className={cn(
                                "w-full text-left px-2.5 py-1.5 text-[0.72rem] font-semibold rounded-lg transition-all flex items-center justify-between cursor-pointer border border-transparent hover:border-border/10",
                                filterOp === o.value 
                                  ? "bg-primary/15 text-accent" 
                                  : "text-foreground/90 hover:bg-white/[0.04]"
                              )}
                            >
                              <span className="truncate">{o.label}</span>
                              {filterOp === o.value && <Check size={11} className="text-accent stroke-[3] shrink-0" />}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>

                  {filterOp !== 'is_empty' && filterOp !== 'is_not_empty' && (
                    <div className="flex flex-col gap-2">
                      <label className="text-[0.62rem] font-bold text-muted-foreground uppercase">Value</label>
                      <input
                        type="text"
                        value={filterVal}
                        onChange={(e) => setFilterVal(e.target.value)}
                        placeholder="Value..."
                        className="w-full bg-muted border border-border rounded-lg px-3 py-1.5 text-xs text-foreground focus:outline-none"
                      />
                    </div>
                  )}

                  <button
                    onClick={handleAddFilter}
                    type="button"
                    className="w-full h-8 bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold rounded-lg mt-1 cursor-pointer transition-all"
                  >
                    Apply Filter
                  </button>
                </div>
              )}
            </div>

            {/* Properties control button */}
            <div className="relative">
              <button
                ref={propertiesButtonRef}
                onClick={() => {
                  setIsAddingFilter(false);
                  setPropertiesMenuOpen(prev => prev === 'floating' ? null : 'floating');
                }}
                className={cn(
                  "properties-toggle-btn w-8 h-8 sm:w-auto sm:px-3 rounded-full flex items-center justify-center gap-1.5 text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer shrink-0",
                  propertiesMenuOpen === 'floating' && "bg-primary/10 text-accent border border-primary/20"
                )}
                title="Properties"
              >
                <SlidersHorizontal size={14.5} className="text-primary" />
                <span className="hidden sm:inline text-xs font-semibold">Properties</span>
              </button>
              {propertiesMenuOpen === 'floating' && renderPropertiesDropdown('floating')}
            </div>

            <div className="w-[1px] h-6 bg-border mx-1 shrink-0" />
          </>
        )}

        {/* View Mode Toggle Buttons */}
        <button
          onClick={() => setViewMode('table')}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer shrink-0",
            viewMode === 'table' && "bg-primary/10 text-accent border border-primary/20"
          )}
          title="Table View"
        >
          <Eye size={14.5} />
        </button>
        <button
          onClick={() => setViewMode('yaml')}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer shrink-0",
            viewMode === 'yaml' && "bg-primary/10 text-accent border border-primary/20"
          )}
          title="Source (YAML)"
        >
          <Code size={14.5} />
        </button>
        {onPrefetchAll && (
          <>
            <div className="w-[1px] h-6 bg-border mx-1 shrink-0" />
            <button
              onClick={onPrefetchAll}
              disabled={prefetchStatus === 'fetching'}
              className={cn(
                "h-8 px-3 rounded-full flex items-center justify-center gap-1.5 text-xs font-semibold cursor-pointer transition-all shrink-0 border border-transparent hover:border-border/10",
                prefetchStatus === 'fetching' 
                  ? "bg-primary/20 text-accent border border-primary/20 animate-pulse-soft" 
                  : prefetchStatus === 'success'
                    ? "bg-accent/20 text-accent border border-accent/25"
                    : prefetchStatus === 'error'
                      ? "bg-destructive/20 text-destructive border border-destructive/25"
                      : "text-muted-foreground hover:bg-border/60 hover:text-foreground"
              )}
              title="Prefetch all vault files & backlinks"
            >
              <RefreshCw size={12} className={cn(prefetchStatus === 'fetching' && "animate-spin")} />
              <span className="hidden sm:inline">
                {prefetchStatus === 'fetching' 
                  ? `Prefetching (${prefetchProgress.loaded}/${prefetchProgress.total})` 
                  : prefetchStatus === 'success'
                    ? 'Prefetched!'
                    : prefetchStatus === 'error'
                      ? 'Prefetch Error'
                      : 'Prefetch All'}
              </span>
            </button>
          </>
        )}
      </div>



      {/* Row Creation Modal popup */}
      {showAddRowModal && (
        <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in select-none">
          <form
            onSubmit={handleCreateRowSubmit}
            className="w-full max-w-sm bg-card/95 backdrop-blur-xl border border-border rounded-2xl p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200"
          >
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-indigo-500/15 flex items-center justify-center text-indigo-400 shrink-0">
                <FileText className="w-5 h-5" />
              </div>
              <div className="flex flex-col">
                <h3 className="font-heading font-bold text-base text-foreground">
                  New Note Row
                </h3>
                <span className="text-[0.7rem] text-muted-foreground font-medium">
                  {folder ? `Create inside source: ${folder}` : 'Create at vault root'}
                </span>
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <span className="text-[0.7rem] font-bold text-muted-foreground uppercase tracking-widest px-1">
                Note Name / Title
              </span>
              <input
                type="text"
                value={newRowName}
                onChange={(e) => setNewRowName(e.target.value)}
                placeholder="Enter note title..."
                autoFocus
                required
                className="w-full bg-muted/50 border border-border text-foreground px-4 py-2.5 rounded-xl text-sm focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 transition-all duration-200"
              />
            </div>

            <div className="flex gap-2.5 mt-2">
              <button
                type="button"
                onClick={() => {
                  setShowAddRowModal(false);
                  setNewRowName('');
                }}
                className="flex-1 h-10 rounded-xl border border-border text-xs font-semibold hover:bg-muted text-muted-foreground hover:text-foreground transition-all cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!newRowName.trim()}
                className="flex-1 h-10 rounded-xl bg-gradient-to-r from-primary to-accent hover:from-primary/90 hover:to-accent/90 text-white text-xs font-semibold transition-all cursor-pointer shadow-lg shadow-primary/20 disabled:opacity-50 disabled:pointer-events-none"
              >
                Create Note Row
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
};
