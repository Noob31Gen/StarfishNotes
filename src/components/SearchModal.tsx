import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Search, Filter, RefreshCw, Check, X, SlidersHorizontal, ChevronDown, CornerDownLeft, FileText, Compass, Database } from 'lucide-react';
import type { VaultFile } from '../services/github';
import { cn } from '../utils/cn';
import { isTextFile } from '../services/github';

interface SearchModalProps {
  isOpen: boolean;
  onClose: () => void;
  files: VaultFile[];
  fileContents: Record<string, string>;
  onOpenNote: (path: string, lineIndex?: number) => void;
  onPrefetchAll: () => void;
  prefetchStatus: 'idle' | 'fetching' | 'success' | 'error';
  prefetchProgress: { loaded: number; total: number };
}

interface SearchFilter {
  property: string;
  operator: string;
  value: string;
}

const AVAILABLE_PROPERTIES = ['file.name', 'folder', 'file extension', 'modified time', 'created time'];

const OPERATORS = [
  { value: 'contains', label: 'contains' },
  { value: 'equals', label: 'equals' },
  { value: 'not_equals', label: 'does not equal' },
  { value: 'is_empty', label: 'is empty' },
  { value: 'is_not_empty', label: 'is not empty' }
];

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

function HighlightMatch({
  text,
  query,
  useRegex,
  caseSensitive
}: {
  text: string;
  query: string;
  useRegex: boolean;
  caseSensitive: boolean;
}) {
  if (!query) return <span>{text}</span>;
  
  let parts: string[];
  let isValid: boolean;

  try {
    let regex: RegExp;
    if (useRegex) {
      regex = new RegExp(`(${query})`, caseSensitive ? 'g' : 'gi');
    } else {
      const escaped = query.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
      regex = new RegExp(`(${escaped})`, caseSensitive ? 'g' : 'gi');
    }
    parts = text.split(regex);
    isValid = true;
  } catch {
    parts = [text];
    isValid = false;
  }

  if (!isValid) {
    return <span>{text}</span>;
  }

  return (
    <span>
      {parts.map((part, i) => {
        if (!part) return null;
        let isMatch = false;
        try {
          isMatch = useRegex
            ? new RegExp(`^(?:${query})$`, caseSensitive ? '' : 'i').test(part)
            : part.toLowerCase() === query.toLowerCase();
        } catch {
          // Ignore invalid regex matching errors during typing
        }
        return isMatch ? (
          <mark key={i} className="bg-primary/25 text-primary font-bold px-0.5 rounded border border-primary/20">
            {part}
          </mark>
        ) : (
          part
        );
      })}
    </span>
  );
}

let hasAutoPrefetchedSession = false;

export const SearchModal: React.FC<SearchModalProps> = ({
  isOpen,
  onClose,
  files,
  fileContents,
  onOpenNote,
  onPrefetchAll,
  prefetchStatus,
  prefetchProgress,
}) => {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [useRegex, setUseRegex] = useState(false);
  const [filters, setFilters] = useState<SearchFilter[]>([]);
  const [isAddingFilter, setIsAddingFilter] = useState(false);
  const [filterProp, setFilterProp] = useState('file.name');
  const [filterOp, setFilterOp] = useState('contains');
  const [filterVal, setFilterVal] = useState('');
  const [activeFilterSelect, setActiveFilterSelect] = useState<'prop' | 'op' | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const filterDropdownRef = useRef<HTMLDivElement>(null);
  const filterButtonRef = useRef<HTMLButtonElement>(null);
  const filterPropSelectRef = useRef<HTMLDivElement>(null);
  const filterOpSelectRef = useRef<HTMLDivElement>(null);

  // Close modals/popups on outside click
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Element;

      if (
        isAddingFilter &&
        filterDropdownRef.current &&
        !filterDropdownRef.current.contains(target) &&
        !target.closest?.('.filter-toggle-btn')
      ) {
        setIsAddingFilter(false);
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
  }, [isAddingFilter, activeFilterSelect]);

  // Reset search window state and focus input when modal transitions to open
  useEffect(() => {
    if (isOpen) {
      Promise.resolve().then(() => {
        setQuery('');
        setIsAddingFilter(false);
        setActiveFilterSelect(null);
      });
      setTimeout(() => {
        inputRef.current?.focus();
      }, 80);
    }
  }, [isOpen]);

  // Start prefetch automatically only on first load of the search modal in the session
  useEffect(() => {
    if (isOpen && !hasAutoPrefetchedSession) {
      if (prefetchStatus === 'idle') {
        hasAutoPrefetchedSession = true;
        onPrefetchAll();
      }
    }
  }, [isOpen, onPrefetchAll, prefetchStatus]);

  // Keyboard shortcut listener to close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    if (isOpen) {
      window.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  const handleAddFilter = () => {
    setFilters(prev => [
      ...prev,
      { property: filterProp, operator: filterOp, value: filterVal }
    ]);
    setIsAddingFilter(false);
    setFilterVal('');
  };

  const handleRemoveFilter = (index: number) => {
    setFilters(prev => prev.filter((_, i) => i !== index));
  };

  // Filter notes in vault
  const filteredFiles = useMemo(() => {
    return files.filter(file => {
      if (file.name === '.gitkeep') return false;

      for (const f of filters) {
        const props: Record<string, string> = {
          'file.name': file.name.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.base$/, '').replace(/\.txt$/, ''),
          'folder': file.path.includes('/') ? file.path.substring(0, file.path.lastIndexOf('/')) : '/',
          'file extension': file.path.split('.').pop() || '',
          'modified time': getStableDate(file.path, 3),
          'created time': getStableDate(file.path, 15)
        };

        const val = props[f.property] || '';
        const valStr = val.toLowerCase();
        const compStr = f.value.toLowerCase();

        let match: boolean;
        switch (f.operator) {
          case 'equals':
            match = valStr === compStr;
            break;
          case 'not_equals':
            match = valStr !== compStr;
            break;
          case 'contains':
            match = valStr.includes(compStr);
            break;
          case 'is_empty':
            match = valStr === '';
            break;
          case 'is_not_empty':
            match = valStr !== '';
            break;
          default:
            match = true;
        }
        if (!match) return false;
      }
      return true;
    });
  }, [files, filters]);

  // Match checker based on Case Sensitivity and Regex toggles
  const checkMatch = React.useCallback((text: string, queryStr: string) => {
    if (!queryStr) return false;
    if (useRegex) {
      try {
        const regex = new RegExp(queryStr, caseSensitive ? '' : 'i');
        return regex.test(text);
      } catch {
        return false;
      }
    } else {
      if (caseSensitive) {
        return text.includes(queryStr);
      } else {
        return text.toLowerCase().includes(queryStr.toLowerCase());
      }
    }
  }, [useRegex, caseSensitive]);

  // Execute Search Matcher
  const searchResults = useMemo(() => {
    const searchQuery = query.trim();
    if (!searchQuery) return [];

    const results: {
      file: VaultFile;
      nameMatch: boolean;
      contentMatches: { lineIndex: number; lineContent: string }[];
    }[] = [];

    filteredFiles.forEach(file => {
      const nameMatch = checkMatch(file.name, searchQuery);
      const contentMatches: { lineIndex: number; lineContent: string }[] = [];
      const content = fileContents[file.path];

      if (content !== undefined && (isTextFile(file.path) || file.path.endsWith('.canvas'))) {
        if (file.path.endsWith('.canvas')) {
          try {
            const parsed = JSON.parse(content) as { nodes?: { type?: string; text?: string; file?: string }[] };
            if (parsed.nodes && Array.isArray(parsed.nodes)) {
              parsed.nodes.forEach((node, idx: number) => {
                if (node.text && typeof node.text === 'string' && checkMatch(node.text, searchQuery)) {
                  contentMatches.push({
                    lineIndex: idx,
                    lineContent: `Card Text: ${node.text.trim()}`
                  });
                } else if (node.file && typeof node.file === 'string' && checkMatch(node.file, searchQuery)) {
                  contentMatches.push({
                    lineIndex: idx,
                    lineContent: `Reference: ${node.file}`
                  });
                }
              });
            }
          } catch {
            if (checkMatch(content, searchQuery)) {
              contentMatches.push({
                lineIndex: 0,
                lineContent: "Match found in canvas file"
              });
            }
          }
        } else {
          // regular text files
          const lines = content.split('\n');
          lines.forEach((line, idx) => {
            if (checkMatch(line, searchQuery)) {
              contentMatches.push({
                lineIndex: idx,
                lineContent: line.trim()
              });
            }
          });
        }
      }

      if (nameMatch || contentMatches.length > 0) {
        results.push({
          file,
          nameMatch,
          contentMatches: contentMatches.slice(0, 10)
        });
      }
    });

    return results;
  }, [filteredFiles, fileContents, query, checkMatch]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[1200] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fade-in select-none">
      <div className="w-full max-w-2xl bg-[#0e1017]/95 backdrop-blur-2xl border border-border/80 rounded-2xl p-6 shadow-2xl flex flex-col gap-4 animate-in fade-in zoom-in-95 duration-200 text-foreground max-h-[85vh] h-[650px]">
        
        {/* Modal Header */}
        <div className="flex items-center justify-between border-b border-border/60 pb-3">
          <div className="flex items-center gap-2.5">
            <Search className="text-primary w-5 h-5 shrink-0" />
            <h3 className="font-heading font-bold text-base sm:text-lg">Search Vault</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1 hover:bg-white/[0.04] rounded-lg cursor-pointer transition-all border border-transparent text-sm"
          >
            ✕
          </button>
        </div>

        {/* Search Input Box */}
        <div className="relative shrink-0">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
          <input
            ref={inputRef}
            type="text"
            placeholder="Search filenames and text content..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="pl-10 pr-28 py-2.5 bg-muted/40 border border-border text-foreground rounded-xl text-sm w-full focus:outline-none focus:border-primary transition-all duration-200 select-text font-medium"
          />
          <div className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5 select-none z-10">
            {/* Case Sensitive toggle */}
            <button
              onClick={() => setCaseSensitive(!caseSensitive)}
              className={cn(
                "w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold border border-transparent transition-all cursor-pointer",
                caseSensitive
                  ? "bg-primary/20 text-accent border border-primary/20 shadow-inner"
                  : "text-muted-foreground/80 hover:bg-white/[0.05] hover:text-foreground"
              )}
              title="Match Case (Aa)"
            >
              Aa
            </button>
            {/* Regex search toggle */}
            <button
              onClick={() => setUseRegex(!useRegex)}
              className={cn(
                "w-6 h-6 rounded flex items-center justify-center text-[10px] font-bold border border-transparent transition-all cursor-pointer",
                useRegex
                  ? "bg-primary/20 text-accent border border-primary/20 shadow-inner"
                  : "text-muted-foreground/80 hover:bg-white/[0.05] hover:text-foreground"
              )}
              title="Use Regular Expression (.*)"
            >
              .*
            </button>
            {query && (
              <button
                onClick={() => setQuery('')}
                className="text-muted-foreground hover:text-foreground text-xs ml-0.5 cursor-pointer"
              >
                ✕
              </button>
            )}
          </div>
        </div>

        {/* Toolbar (Filters & Prefetch) */}
        <div className="flex flex-col gap-2 shrink-0 select-none">
          <div className="flex items-center justify-between bg-muted/20 border border-border/60 rounded-xl px-3 py-1.5 flex-wrap gap-2">
            <div className="flex items-center gap-2.5">
              {/* Prefetch status & trigger */}
              <button
                type="button"
                onClick={onPrefetchAll}
                disabled={prefetchStatus === 'fetching'}
                className={cn(
                  "h-7 px-3.5 rounded-full flex items-center justify-center gap-1.5 text-xs font-semibold cursor-pointer transition-all border border-transparent",
                  prefetchStatus === 'fetching'
                    ? "bg-primary/20 text-accent border border-primary/20 animate-pulse-soft"
                    : prefetchStatus === 'success'
                      ? "bg-accent/20 text-accent border border-accent/25"
                      : prefetchStatus === 'error'
                        ? "bg-destructive/20 text-destructive border border-destructive/25"
                        : "bg-white/[0.03] text-muted-foreground hover:bg-white/[0.06] hover:text-foreground hover:border-border/60"
                )}
                title="Cache note content for in-file content search"
              >
                <RefreshCw size={11} className={cn(prefetchStatus === 'fetching' && "animate-spin")} />
                <span>
                  {prefetchStatus === 'fetching'
                    ? `Caching (${prefetchProgress.loaded}/${prefetchProgress.total})`
                    : prefetchStatus === 'success'
                      ? 'Fully Cached!'
                      : prefetchStatus === 'error'
                        ? 'Cache Error'
                        : 'Cache All Files'}
                </span>
              </button>

              <div className="w-[1px] h-4 bg-border/60" />

              {/* Filters toggle button */}
              <div className="relative">
                <button
                  ref={filterButtonRef}
                  onClick={() => setIsAddingFilter(!isAddingFilter)}
                  className={cn(
                    "filter-toggle-btn h-7 px-3 rounded-full flex items-center justify-center gap-1.5 text-xs font-semibold text-muted-foreground hover:bg-white/[0.05] hover:text-foreground border border-transparent cursor-pointer transition-all",
                    isAddingFilter && "bg-primary/10 text-accent border border-primary/20"
                  )}
                >
                  <Filter size={11} className="text-primary" />
                  <span>Filter</span>
                </button>

                {isAddingFilter && (
                  <div
                    ref={filterDropdownRef}
                    className="fixed z-[1300] top-0 bottom-0 left-0 right-0 h-fit w-[288px] mx-auto my-auto sm:absolute sm:z-30 sm:top-full sm:bottom-auto sm:left-0 sm:right-auto sm:h-auto sm:w-72 sm:mt-2 sm:mx-0 sm:my-0 bg-[#12131a]/95 backdrop-blur-xl border border-border rounded-xl shadow-2xl p-4 flex flex-col gap-3 animate-in fade-in slide-in-from-top-2 duration-100 text-foreground"
                  >
                    <div className="flex items-center justify-between border-b border-border/40 pb-1.5">
                      <span className="text-xs font-bold text-foreground">Add Filter</span>
                      <button onClick={() => setIsAddingFilter(false)} className="text-muted-foreground hover:text-foreground text-xs" type="button">✕</button>
                    </div>

                    {/* Property field */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[0.62rem] font-bold text-muted-foreground uppercase tracking-wider">Property</label>
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
                          <div className="absolute top-full left-0 mt-1 w-full bg-[#18181f] border border-border/60 rounded-xl shadow-2xl p-1 flex flex-col gap-0.5 z-50 max-h-48 overflow-y-auto no-scrollbar animate-in fade-in slide-in-from-top-1 duration-100">
                            {AVAILABLE_PROPERTIES.map(p => (
                              <button
                                key={p}
                                type="button"
                                onClick={() => {
                                  setFilterProp(p);
                                  setActiveFilterSelect(null);
                                }}
                                className={cn(
                                  "w-full text-left px-2.5 py-1.5 text-[0.72rem] font-semibold rounded-lg transition-all flex items-center justify-between cursor-pointer border border-transparent hover:border-border/10",
                                  filterProp === p ? "bg-primary/15 text-accent" : "text-foreground/90 hover:bg-white/[0.04]"
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

                    {/* Operator field */}
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[0.62rem] font-bold text-muted-foreground uppercase tracking-wider">Operator</label>
                      <div className="relative" ref={filterOpSelectRef}>
                        <button
                          type="button"
                          onClick={() => setActiveFilterSelect(prev => prev === 'op' ? null : 'op')}
                          className="filter-select-toggle w-full h-8 bg-muted/50 hover:bg-muted border border-border rounded-xl px-3 flex items-center justify-between text-xs text-foreground focus:outline-none transition-all cursor-pointer font-semibold"
                        >
                          <span className="truncate">{OPERATORS.find(o => o.value === filterOp)?.label || filterOp}</span>
                          <ChevronDown size={13} className="text-muted-foreground/60 shrink-0 ml-1" />
                        </button>
                        {activeFilterSelect === 'op' && (
                          <div className="absolute top-full left-0 mt-1 w-full bg-[#18181f] border border-border/60 rounded-xl shadow-2xl p-1 flex flex-col gap-0.5 z-50 max-h-48 overflow-y-auto no-scrollbar animate-in fade-in slide-in-from-top-1 duration-100">
                            {OPERATORS.map(o => (
                              <button
                                key={o.value}
                                type="button"
                                onClick={() => {
                                  setFilterOp(o.value);
                                  setActiveFilterSelect(null);
                                }}
                                className={cn(
                                  "w-full text-left px-2.5 py-1.5 text-[0.72rem] font-semibold rounded-lg transition-all flex items-center justify-between cursor-pointer border border-transparent hover:border-border/10",
                                  filterOp === o.value ? "bg-primary/15 text-accent" : "text-foreground/90 hover:bg-white/[0.04]"
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

                    {/* Value field */}
                    {filterOp !== 'is_empty' && filterOp !== 'is_not_empty' && (
                      <div className="flex flex-col gap-1.5">
                        <label className="text-[0.62rem] font-bold text-muted-foreground uppercase tracking-wider">Value</label>
                        <input
                          type="text"
                          value={filterVal}
                          onChange={(e) => setFilterVal(e.target.value)}
                          placeholder="Value..."
                          className="w-full bg-muted border border-border rounded-xl px-3 py-1.5 text-xs text-foreground focus:outline-none select-text font-semibold"
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

            <div className="text-[0.65rem] font-semibold text-muted-foreground">
              Scope: {filteredFiles.length} / {files.filter(f => f.name !== '.gitkeep').length} files
            </div>
          </div>

          {/* Active Filter Badges */}
          {filters.length > 0 && (
            <div className="flex flex-wrap gap-1.5 py-1 select-none">
              {filters.map((f, idx) => (
                <div key={idx} className="flex items-center gap-1 bg-white/[0.04] border border-border px-2.5 py-0.5 rounded-full text-[0.68rem] text-muted-foreground animate-fade-in">
                  <span className="font-semibold text-primary">{f.property}</span>
                  <span>{OPERATORS.find(op => op.value === f.operator)?.label || f.operator}</span>
                  {f.operator !== 'is_empty' && f.operator !== 'is_not_empty' && (
                    <span className="font-semibold text-accent">"{f.value}"</span>
                  )}
                  <button
                    onClick={() => handleRemoveFilter(idx)}
                    className="text-muted-foreground hover:text-foreground font-bold ml-1 cursor-pointer"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Scrollable Results Area */}
        <div className="flex-1 overflow-y-auto pr-1 flex flex-col gap-2.5 select-none min-h-0">
          {!query.trim() ? (
            <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground text-xs gap-3.5 my-auto">
              <div className="w-12 h-12 bg-white/[0.02] border border-border/80 rounded-2xl flex items-center justify-center">
                <SlidersHorizontal className="w-5 h-5 text-muted-foreground/60 animate-pulse-soft" />
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-semibold text-foreground text-sm">Find Anything</span>
                <span>Type to search filenames and note content instantly. Use filters to narrow down the vault scope.</span>
              </div>
            </div>
          ) : searchResults.length === 0 ? (
            <div className="flex flex-col items-center justify-center p-12 text-center text-muted-foreground text-xs gap-3.5 my-auto">
              <div className="w-12 h-12 bg-white/[0.02] border border-border/80 rounded-2xl flex items-center justify-center">
                <X className="w-5 h-5 text-destructive/80" />
              </div>
              <div className="flex flex-col gap-1">
                <span className="font-semibold text-foreground text-sm">No Results Found</span>
                <span>No files or file contents matched the query "{query}".</span>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {/* Results summary bar */}
              <div className="text-[0.68rem] font-bold text-muted-foreground/80 uppercase tracking-wider border-b border-border/40 pb-1 flex justify-between px-1">
                <span>Search Results</span>
                <span>Found {searchResults.length} files matching</span>
              </div>

              {/* List of matching files */}
              {searchResults.map((result) => {
                const isCanvas = result.file.path.endsWith('.canvas');
                const isBase = result.file.path.endsWith('.base');
                
                return (
                  <div
                    key={result.file.path}
                    className="border border-border/60 bg-white/[0.01] hover:bg-white/[0.025] rounded-xl p-3.5 flex flex-col gap-2 transition-all"
                  >
                    {/* Header Row */}
                    <div 
                      onClick={() => {
                        onOpenNote(result.file.path);
                        onClose();
                      }}
                      className="flex items-center justify-between cursor-pointer group"
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        {isCanvas ? (
                          <Compass className="w-4 h-4 text-teal-400 shrink-0" />
                        ) : isBase ? (
                          <Database className="w-4 h-4 text-rose-400 shrink-0" />
                        ) : (
                          <FileText className="w-4 h-4 text-purple-400 shrink-0" />
                        )}
                        <div className="flex flex-col min-w-0">
                          <span className="font-semibold text-foreground text-xs group-hover:text-primary transition-colors truncate">
                            <HighlightMatch text={result.file.name.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.base$/, '').replace(/\.txt$/, '')} query={query} useRegex={useRegex} caseSensitive={caseSensitive} />
                          </span>
                          <span className="text-[0.625rem] text-muted-foreground/50 font-medium truncate">
                            {result.file.path}
                          </span>
                        </div>
                      </div>

                      <div className="flex items-center gap-2 shrink-0">
                        {result.nameMatch && (
                          <span className="text-[0.55rem] font-bold uppercase tracking-wider bg-primary/10 text-primary px-2 py-0.5 rounded-md border border-primary/15">
                            Filename Match
                          </span>
                        )}
                        <div className="opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1 text-[0.65rem] text-muted-foreground">
                          <span>Open</span>
                          <CornerDownLeft size={10} />
                        </div>
                      </div>
                    </div>

                    {/* Content Matches Row */}
                    {result.contentMatches.length > 0 && (
                      <div className="pl-6 border-l border-border/40 mt-1 flex flex-col gap-1.5">
                        {result.contentMatches.map((match, mIdx) => (
                          <div
                            key={mIdx}
                            onClick={() => {
                              onOpenNote(result.file.path, match.lineIndex);
                              onClose();
                            }}
                            className="flex items-start gap-2.5 p-2 rounded-lg bg-white/[0.02] border border-border/40 hover:border-primary/30 hover:bg-primary/5 transition-all cursor-pointer text-xs font-medium select-text"
                          >
                            <span className="text-[0.65rem] text-muted-foreground/60 font-mono mt-0.5 shrink-0 bg-white/[0.04] border border-border px-1.5 py-0.5 rounded">
                              L{match.lineIndex + 1}
                            </span>
                            <span className="font-mono text-[0.72rem] text-muted-foreground/90 truncate flex-1 leading-relaxed">
                              <HighlightMatch text={match.lineContent} query={query} useRegex={useRegex} caseSensitive={caseSensitive} />
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer shortcuts helper */}
        <div className="border-t border-border/60 pt-2.5 flex items-center justify-between text-[0.68rem] text-muted-foreground shrink-0 select-none px-1">
          <span>
            {useRegex ? 'Regex search active.' : 'Standard search.'} {caseSensitive ? 'Case sensitive.' : 'Case insensitive.'}
          </span>
          <div className="flex items-center gap-2.5">
            <span className="bg-white/[0.05] border border-border px-1.5 py-0.5 rounded text-[0.625rem] font-mono">ESC</span>
            <span>to close</span>
          </div>
        </div>
      </div>
    </div>
  );
};
