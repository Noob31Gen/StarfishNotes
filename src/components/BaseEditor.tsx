import React, { useState, useEffect, useMemo, useRef } from 'react';
import { 
  Database, Eye, Code, Plus, ArrowUpDown, 
  Filter, FileText, Check, X, RefreshCw, PlusCircle, Folders
} from 'lucide-react';
import { parseYaml, stringifyYaml } from '../utils/yaml';
import { parseFrontmatter, updateFrontmatter } from '../utils/frontmatter';
import type { VaultFile } from '../services/github';
import { cn } from '../utils/cn';

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
}) => {
  const [viewMode, setViewMode] = useState<'table' | 'yaml'>('table');
  const [yamlContent, setYamlContent] = useState(initialContent);
  const [sha, setSha] = useState<string | null>(initialSha);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');

  // Parsed Config state
  const [config, setConfig] = useState<BaseConfig>(() => {
    let parsed: BaseConfig | null = null;
    try {
      parsed = parseYaml(initialContent) as BaseConfig;
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
  });

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
  const folder = config.source?.folder || '';
  const folderPrefix = useMemo(() => {
    if (!folder) return '';
    return folder.endsWith('/') ? folder : `${folder}/`;
  }, [folder]);

  // Preload file contents for all notes in the database's source folder
  useEffect(() => {
    files.forEach(f => {
      if (f.path.endsWith('.md')) {
        const isMatched = folderPrefix ? f.path.startsWith(folderPrefix) : true;
        if (isMatched && fileContents[f.path] === undefined) {
          onLoadFileContent(f.path, f.sha || '').catch(err => {
            console.error('Failed to preload note content:', f.path, err);
          });
        }
      }
    });
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

      return {
        path: file.path,
        name: file.name,
        sha: file.sha || null,
        properties: {
          'file.name': cleanName,
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

  const [newColName, setNewColName] = useState('');
  const [isAddingCol, setIsAddingCol] = useState(false);

  const handleAddColumnSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanKey = newColName.trim();
    if (!cleanKey) return;

    const currentCols = activeView.columns || [];
    if (currentCols.some((c) => c.property === cleanKey)) {
      setIsAddingCol(false);
      setNewColName('');
      return;
    }

    const newCols = [...currentCols, { property: cleanKey, visible: true }];
    const updatedViews = [...config.views];
    updatedViews[0] = { ...activeView, columns: newCols };

    saveConfig({ ...config, views: updatedViews });
    setIsAddingCol(false);
    setNewColName('');
  };

  // Filter Configuration State
  const [isAddingFilter, setIsAddingFilter] = useState(false);
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
      `# ${cleanName}\n\nStart typing here...`,
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
  const handleUpdateSourceFolder = (e: React.FormEvent) => {
    e.preventDefault();
    const updatedSource = { folder: sourceFolderVal.trim() };
    saveConfig({ ...config, source: updatedSource });
  };

  return (
    <div className="flex-1 w-full h-full flex flex-col bg-background overflow-hidden relative select-text text-foreground animate-fade-in">
      {/* 1. Header Toolbar */}
      <header className="h-14 bg-card border-b border-border flex items-center justify-between px-6 shrink-0 z-10 select-none">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-indigo-500/10 text-indigo-400 flex items-center justify-center border border-indigo-500/25">
            <Database size={15} />
          </div>
          <div className="flex flex-col">
            <span className="text-xs font-bold text-foreground">
              {filePath.split('/').pop()}
            </span>
            <span className="text-[0.6rem] text-muted-foreground font-semibold">
              Obsidian Base View ({filteredAndSortedRows.length} rows matched)
            </span>
          </div>
        </div>

        {/* Action Toggle controls */}
        <div className="flex items-center gap-2">
          {/* Save Status indicators */}
          {saveStatus !== 'idle' && (
            <div className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[0.65rem] font-bold border",
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
              <span>
                {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved' : errorMessage || 'Error'}
              </span>
            </div>
          )}

          {/* Table vs Code view toggle */}
          <div className="flex items-center bg-muted/40 p-1 rounded-xl border border-border">
            <button
              onClick={() => setViewMode('table')}
              className={cn(
                "h-7 px-3 rounded-lg text-[0.68rem] font-bold flex items-center gap-1.5 transition-all cursor-pointer",
                viewMode === 'table'
                  ? "bg-card text-foreground shadow-xs border border-border/80"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Eye size={12} />
              <span>Table View</span>
            </button>
            <button
              onClick={() => setViewMode('yaml')}
              className={cn(
                "h-7 px-3 rounded-lg text-[0.68rem] font-bold flex items-center gap-1.5 transition-all cursor-pointer",
                viewMode === 'yaml'
                  ? "bg-card text-foreground shadow-xs border border-border/80"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              <Code size={12} />
              <span>Source (YAML)</span>
            </button>
          </div>
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
            
            {/* View Sub-header: Folder configuration & Filters panel */}
            <div className="p-4 bg-card/30 border-b border-border/50 flex flex-wrap items-center justify-between gap-3 shrink-0 select-none">
              <div className="flex items-center gap-4 flex-wrap">
                {/* Source Folder edit form */}
                <form onSubmit={handleUpdateSourceFolder} className="flex items-center gap-2">
                  <div className="flex items-center gap-1.5 text-[0.7rem] font-bold text-muted-foreground uppercase tracking-wider">
                    <Folders size={13} className="text-primary" />
                    <span>Source Folder:</span>
                  </div>
                  <input
                    type="text"
                    value={sourceFolderVal}
                    onChange={(e) => setSourceFolderVal(e.target.value)}
                    placeholder="e.g. Projects"
                    className="h-8 bg-muted/50 border border-border text-foreground px-3 rounded-xl text-xs focus:outline-none focus:border-primary transition-all w-40"
                  />
                  {sourceFolderVal !== folder && (
                    <button
                      type="submit"
                      className="h-8 px-2 bg-indigo-600 hover:bg-indigo-500 text-white text-[0.65rem] font-bold rounded-xl cursor-pointer transition-all"
                    >
                      Update
                    </button>
                  )}
                </form>

                {/* Filters control button */}
                <div className="relative">
                  <button
                    onClick={() => setIsAddingFilter(!isAddingFilter)}
                    className="h-8 px-3 rounded-xl border border-border bg-muted/30 text-xs font-semibold text-muted-foreground hover:text-foreground flex items-center gap-1.5 transition-all cursor-pointer"
                  >
                    <Filter size={12} className="text-primary" />
                    <span>Add Filter</span>
                  </button>

                  {isAddingFilter && (
                    <div className="absolute top-full left-0 mt-2 w-72 bg-[#12131a] border border-border rounded-xl shadow-2xl p-4 flex flex-col gap-3 z-30 animate-in fade-in zoom-in-95 duration-100">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-foreground">Create Filter</span>
                        <button onClick={() => setIsAddingFilter(false)} className="text-muted-foreground hover:text-foreground" type="button">✕</button>
                      </div>

                      <div className="flex flex-col gap-2">
                        <label className="text-[0.62rem] font-bold text-muted-foreground uppercase">Property</label>
                        <select
                          value={filterProp}
                          onChange={(e) => setFilterProp(e.target.value)}
                          className="w-full bg-muted border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground focus:outline-none"
                        >
                          {availableProperties.map(p => (
                            <option key={p} value={p}>{p}</option>
                          ))}
                        </select>
                      </div>

                      <div className="flex flex-col gap-2">
                        <label className="text-[0.62rem] font-bold text-muted-foreground uppercase">Operator</label>
                        <select
                          value={filterOp}
                          onChange={(e) => setFilterOp(e.target.value)}
                          className="w-full bg-muted border border-border rounded-lg px-2.5 py-1.5 text-xs text-foreground focus:outline-none"
                        >
                          <option value="contains">contains</option>
                          <option value="equals">equals</option>
                          <option value="not_equals">does not equal</option>
                          <option value="is_empty">is empty</option>
                          <option value="is_not_empty">is not empty</option>
                        </select>
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
              </div>

              {/* View actions: Add row / new note */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowAddRowModal(true)}
                  className="h-8 px-4 bg-gradient-to-r from-primary to-accent hover:from-primary/95 hover:to-accent/95 text-white text-xs font-semibold rounded-xl flex items-center gap-1.5 cursor-pointer transition-all shadow-md shadow-primary/10"
                >
                  <PlusCircle size={13} />
                  <span>Add Row (New Note)</span>
                </button>
              </div>
            </div>

            {/* Displaying active filter badges */}
            {(activeView.filters || []).length > 0 && (
              <div className="px-4 py-2 border-b border-border/40 bg-card/10 flex flex-wrap gap-1.5 items-center select-none">
                <span className="text-[0.6rem] font-bold text-muted-foreground uppercase tracking-widest mr-1">Active Filters:</span>
                {(activeView.filters || []).map((f, idx) => (
                  <div key={idx} className="flex items-center gap-1 bg-white/[0.04] border border-border px-2.5 py-0.5 rounded-full text-[0.68rem] text-muted-foreground">
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
                <thead className="bg-[#0b0c10] border-b border-border/80 sticky top-0 z-20 select-none">
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
                            <span>{col.property === 'file.name' ? 'Note Title' : col.property}</span>
                            <ArrowUpDown size={11} className={cn("shrink-0 transition-colors", isSorting ? "text-accent" : "text-muted-foreground/30")} />
                            {isSorting && (
                              <span className="text-[0.55rem] text-accent lowercase">({sortDir})</span>
                            )}
                          </div>

                          {/* Hide Column / dropdown operations */}
                          {col.property !== 'file.name' && (
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
                      {isAddingCol ? (
                        <form onSubmit={handleAddColumnSubmit} className="flex items-center gap-1">
                          <input
                            type="text"
                            value={newColName}
                            onChange={(e) => setNewColName(e.target.value)}
                            placeholder="Property name..."
                            autoFocus
                            className="h-7 w-28 bg-muted border border-border text-foreground px-2 rounded-lg text-[0.7rem] focus:outline-none"
                          />
                          <button type="submit" className="text-accent hover:text-accent/80 font-bold p-1">✓</button>
                          <button type="button" onClick={() => setIsAddingCol(false)} className="text-destructive hover:text-destructive/80 font-bold p-1">✕</button>
                        </form>
                      ) : (
                        <button
                          onClick={() => setIsAddingCol(true)}
                          className="h-7 px-2.5 bg-muted/40 hover:bg-muted/70 border border-dashed border-border rounded-lg text-[0.65rem] font-bold text-muted-foreground hover:text-foreground transition-all flex items-center gap-1 cursor-pointer"
                        >
                          <Plus size={11} />
                          <span>Add Property</span>
                        </button>
                      )}
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

                          if (colKey === 'file.name') {
                            // Note Link Title column
                            return (
                              <td key={colKey} className="px-4 py-3 truncate max-w-xs text-xs font-semibold">
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
                                if (!isEditing) {
                                  setEditingCell({ rowPath: row.path, colKey });
                                  setEditingValue(cellVal === undefined || cellVal === null ? '' : String(cellVal));
                                }
                              }}
                              className="px-4 py-2 text-xs text-foreground/80 truncate max-w-xs cursor-pointer hover:bg-white/[0.015]"
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
                                  {cellVal !== undefined && cellVal !== null && cellVal !== '' ? String(cellVal) : 'empty'}
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

      {/* Row Creation Modal popup */}
      {showAddRowModal && (
        <div className="fixed inset-0 z-[1100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs animate-fade-in select-none">
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
