import React, { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react';
import md from '../lib/markdownEngine';
import DOMPurify from 'dompurify';
import { Eye, Edit2, Columns, Save, AlertCircle, RefreshCw, FileText, Paperclip, Undo2, Redo2, Image, Copy, Check } from 'lucide-react';
import { GitConflictError, isTextFile } from '../services/github';
import type { VaultFile } from '../services/github';
import { cn } from '../utils/cn';
import { saveEditorState, restoreEditorState } from '../utils/editorState';

interface EditorProps {
  filePath: string;
  initialContent: string;
  initialSha: string | null;
  files: VaultFile[];
  onSave: (content: string, sha: string | null) => Promise<{ sha: string }>;
  onOpenNote: (fileName: string) => void;
  vaultId: string;
  vaultImages: Record<string, string>;
  onFetchBinaryFile: (path: string, sha: string) => Promise<void>;
  onUploadAttachment: (file: File, folderPath?: string) => Promise<{ path: string; name: string }>;
  initialSearchLineIndex?: number;
  onClearTargetLine?: () => void;
}

function parseCSV(text: string, delimiter: string = ','): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentVal = '';
  let inQuotes = false;

  const cleanText = text.replace(/\r\n/g, '\n');

  for (let i = 0; i < cleanText.length; i++) {
    const char = cleanText[i];
    const nextChar = cleanText[i + 1];

    if (inQuotes) {
      if (char === '"') {
        if (nextChar === '"') {
          currentVal += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        currentVal += char;
      }
    } else {
      if (char === '"') {
        inQuotes = true;
      } else if (char === delimiter) {
        currentRow.push(currentVal);
        currentVal = '';
      } else if (char === '\n') {
        currentRow.push(currentVal);
        rows.push(currentRow);
        currentRow = [];
        currentVal = '';
      } else {
        currentVal += char;
      }
    }
  }

  if (currentVal || currentRow.length > 0) {
    currentRow.push(currentVal);
    rows.push(currentRow);
  }

  if (rows.length === 0) {
    rows.push(['']);
  }

  return rows;
}

function stringifyCSV(rows: string[][], delimiter: string = ','): string {
  const formulaTriggers = ['=', '+', '-', '@', '\t', '\r'];
  return rows
    .map(row =>
      row
        .map(cell => {
          let escapedCell = cell;
          if (escapedCell && formulaTriggers.includes(escapedCell.charAt(0))) {
            escapedCell = `'${escapedCell}`;
          }
          const needsQuotes =
            escapedCell.includes(delimiter) ||
            escapedCell.includes('"') ||
            escapedCell.includes('\n') ||
            escapedCell.includes('\r');
          if (needsQuotes) {
            return `"${escapedCell.replace(/"/g, '""')}"`;
          }
          return escapedCell;
        })
        .join(delimiter)
    )
    .join('\n');
}

function getColLabel(index: number): string {
  let label = '';
  let temp = index;
  while (temp >= 0) {
    label = String.fromCharCode((temp % 26) + 65) + label;
    temp = Math.floor(temp / 26) - 1;
  }
  return label;
}

function splitLongLines(text: string): string[] {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');
  const virtualLines: string[] = [];
  for (const line of lines) {
    if (line.length <= 1000) {
      virtualLines.push(line);
    } else {
      let start = 0;
      while (start < line.length) {
        const chunk = line.slice(start, start + 1000);
        start += 1000;
        if (start < line.length) {
          virtualLines.push(chunk + '\r');
        } else {
          virtualLines.push(chunk);
        }
      }
    }
  }
  return virtualLines;
}

function mergeVirtualLines(virtualLines: string[]): string {
  let result = '';
  for (let i = 0; i < virtualLines.length; i++) {
    const line = virtualLines[i];
    if (line.endsWith('\r')) {
      result += line.slice(0, -1);
    } else {
      result += line;
      if (i < virtualLines.length - 1) {
        result += '\n';
      }
    }
  }
  return result;
}

const EditorComponent: React.FC<EditorProps> = ({
  filePath,
  initialContent,
  initialSha,
  files,
  onSave,
  onOpenNote,
  vaultId,
  vaultImages,
  onFetchBinaryFile,
  onUploadAttachment,
  initialSearchLineIndex,
  onClearTargetLine,
}) => {
  const isWindowingMode = initialContent.length > 50000;

  const [virtualLines, setVirtualLines] = useState<string[]>(() => {
    if (isWindowingMode) {
      return splitLongLines(initialContent);
    }
    return [];
  });

  const virtualLinesRef = useRef<string[]>(virtualLines);
  useEffect(() => {
    virtualLinesRef.current = virtualLines;
  }, [virtualLines]);

  const [windowStartLine, setWindowStartLine] = useState(0);
  const [windowEndLine, setWindowEndLine] = useState(() => {
    if (isWindowingMode) {
      return Math.min(300, virtualLines.length);
    }
    return 0;
  });

  const [content, setContent] = useState(() => {
    if (isWindowingMode) {
      return virtualLines.slice(0, Math.min(300, virtualLines.length)).join('\n');
    }
    return initialContent;
  });

  const [fullContent, setFullContent] = useState(initialContent);
  const fullContentRef = useRef(initialContent);
  useEffect(() => {
    fullContentRef.current = fullContent;
  }, [fullContent]);

  const [sha, setSha] = useState(initialSha);
  const [savedContent, setSavedContent] = useState(initialContent);
  const [viewMode, setViewMode] = useState<'edit' | 'preview' | 'split'>(() => {
    return typeof window !== 'undefined' && window.innerWidth < 768 ? 'edit' : 'split';
  });
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [copied, setCopied] = useState(false);

  const viewportRef = useRef<HTMLDivElement | null>(null);
  const previewScrollContainerRef = useRef<HTMLDivElement | null>(null);
  const pendingCursorRef = useRef<{ start: number; end: number } | null>(null);
  const isSavingRef = useRef(false);

  const activeCsvEditRef = useRef<{ row: number; col: number; val: string } | null>(null);
  const csvDebounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isEditingFromPreviewRef = useRef(false);
  const historyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markdownRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mermaidRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRenderedPathRef = useRef<string>('');

  const markdownCacheRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    markdownCacheRef.current.clear();
  }, [vaultImages]);

  const commitCsvChanges = useCallback(() => {
    if (csvDebounceTimerRef.current) {
      clearTimeout(csvDebounceTimerRef.current);
      csvDebounceTimerRef.current = null;
    }
    if (!activeCsvEditRef.current) return;
    const { row, col, val } = activeCsvEditRef.current;
    activeCsvEditRef.current = null;

    const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
    const delimiter = ext === '.csv' ? ',' : '\t';
    const rows = parseCSV(fullContentRef.current, delimiter);

    while (rows.length <= row) {
      rows.push([]);
    }
    const maxCols = Math.max(...rows.map(r => r.length), 1);
    rows.forEach(r => {
      while (r.length < maxCols) {
        r.push('');
      }
    });

    if (rows[row][col] === val) return;

    rows[row][col] = val;
    const newContent = stringifyCSV(rows, delimiter);
    isEditingFromPreviewRef.current = true;
    if (isWindowingMode) {
      const vLines = splitLongLines(newContent);
      virtualLinesRef.current = vLines;
      const start = Math.min(windowStartLine, Math.max(0, vLines.length - 300));
      const end = Math.min(start + 300, vLines.length);
      setWindowStartLine(start);
      setWindowEndLine(end);
      setContent(vLines.slice(start, end).join('\n'));
      setFullContent(newContent);
      fullContentRef.current = newContent;
    } else {
      setContent(newContent);
      setFullContent(newContent);
      fullContentRef.current = newContent;
    }
  }, [filePath, isWindowingMode, windowStartLine]);

  useEffect(() => {
    return () => {
      if (csvDebounceTimerRef.current) {
        clearTimeout(csvDebounceTimerRef.current);
      }
      if (historyTimerRef.current) {
        clearTimeout(historyTimerRef.current);
      }
    };
  }, []);

  const getGlobalIndex = useCallback((localIndex: number, startLine: number) => {
    let globalIndex = 0;
    const vLines = virtualLinesRef.current;
    for (let i = 0; i < Math.min(startLine, vLines.length); i++) {
      globalIndex += vLines[i].length + 1;
    }
    return globalIndex + localIndex;
  }, []);

  const getLocalIndex = useCallback((globalIndex: number, targetStartLine: number) => {
    let offset = 0;
    const vLines = virtualLinesRef.current;
    for (let i = 0; i < Math.min(targetStartLine, vLines.length); i++) {
      offset += vLines[i].length + 1;
    }
    return Math.max(0, globalIndex - offset);
  }, []);

  const [windowLineHeights, setWindowLineHeights] = useState<number[]>(() => {
    if (isWindowingMode) {
      const size = Math.min(300, virtualLines.length);
      return Array(size).fill(24);
    }
    return [];
  });
  const lastMeasuredHeightsRef = useRef<number[] | null>(null);
  const lineHeightsCacheRef = useRef<Map<string, number>>(new Map());
  const lastMeasureWidthRef = useRef<string>('');

  const measureLineHeights = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    let mirror = document.getElementById('textarea-mirror-div') as HTMLDivElement;
    if (!mirror) {
      mirror = document.createElement('div');
      mirror.id = 'textarea-mirror-div';
      mirror.style.position = 'absolute';
      mirror.style.visibility = 'hidden';
      mirror.style.whiteSpace = 'pre-wrap';
      mirror.style.wordBreak = 'break-all';
      mirror.style.boxSizing = 'border-box';
      mirror.style.fontFamily = 'monospace';
      mirror.style.fontSize = '14.8px';
      mirror.style.lineHeight = '24px';
      mirror.style.padding = '0 24px';
      document.body.appendChild(mirror);
    }

    const style = window.getComputedStyle(textarea);
    const currentWidth = style.width;
    if (currentWidth !== lastMeasureWidthRef.current) {
      lineHeightsCacheRef.current.clear();
      lastMeasureWidthRef.current = currentWidth;
    }
    mirror.style.width = currentWidth;

    const vLines = virtualLinesRef.current;
    const lineElements: { index: number; el: HTMLDivElement; cleanText: string }[] = [];
    const fragment = document.createDocumentFragment();
    const heights: number[] = Array(windowEndLine - windowStartLine).fill(24);
    const cache = lineHeightsCacheRef.current;

    for (let i = windowStartLine; i < windowEndLine; i++) {
      const lineText = vLines[i] || '';
      const cleanLine = lineText.endsWith('\r') ? lineText.slice(0, -1) : lineText;

      // Fast path: if empty/whitespace, height is always 24px
      if (!cleanLine.trim()) {
        heights[i - windowStartLine] = 24;
        continue;
      }

      // Fast path: check string cache
      if (cache.has(cleanLine)) {
        heights[i - windowStartLine] = cache.get(cleanLine)!;
        continue;
      }

      const el = document.createElement('div');
      el.textContent = cleanLine || ' ';
      el.style.whiteSpace = 'pre-wrap';
      el.style.wordBreak = 'break-all';
      el.style.boxSizing = 'border-box';
      el.style.fontFamily = 'monospace';
      el.style.fontSize = '14.8px';
      el.style.lineHeight = '24px';
      el.style.width = '100%';
      fragment.appendChild(el);
      lineElements.push({ index: i - windowStartLine, el, cleanText: cleanLine });
    }

    if (lineElements.length > 0) {
      mirror.textContent = ''; // Clear prior content
      mirror.appendChild(fragment);

      // Batch read client heights to avoid forced sync layouts
      lineElements.forEach(item => {
        const h = item.el.clientHeight || 24;
        heights[item.index] = h;
        cache.set(item.cleanText, h);
      });

      mirror.textContent = ''; // Clean up
    }

    return heights;
  }, [windowStartLine, windowEndLine]);

  useLayoutEffect(() => {
    if (isWindowingMode) {
      const heights = measureLineHeights();
      if (heights && (lastMeasuredHeightsRef.current === null || JSON.stringify(heights) !== JSON.stringify(lastMeasuredHeightsRef.current))) {
        lastMeasuredHeightsRef.current = heights;
        setWindowLineHeights(heights);
      }
    }
  }, [content, isWindowingMode, windowStartLine, windowEndLine, measureLineHeights]);

  useEffect(() => {
    if (!isWindowingMode) return;
    const handleResize = () => {
      const heights = measureLineHeights();
      if (heights) {
        setWindowLineHeights(heights);
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [isWindowingMode, content, measureLineHeights]);

  // Undo / Redo history state stack
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const historyRef = useRef<string[]>([]);
  const historyIndexRef = useRef(-1);

  // Sync state to refs
  useEffect(() => {
    historyRef.current = history;
    historyIndexRef.current = historyIndex;
  }, [history, historyIndex]);

  const pushEditorState = useCallback((val: string) => {
    const currentIndex = historyIndexRef.current;
    
    setHistory(prev => {
      const sliced = prev.slice(0, currentIndex + 1);
      if (sliced.length > 0 && sliced[sliced.length - 1] === val) {
        return prev;
      }
      const nextHistory = [...sliced, val];
      if (nextHistory.length > 50) nextHistory.shift();
      
      const nextIndex = nextHistory.length - 1;
      setHistoryIndex(nextIndex);
      historyIndexRef.current = nextIndex;
      historyRef.current = nextHistory;
      return nextHistory;
    });
  }, []);

  const undo = useCallback(() => {
    const currentIndex = historyIndexRef.current;
    const currentHist = historyRef.current;
    if (currentIndex > 0) {
      const prevIndex = currentIndex - 1;
      const prevText = currentHist[prevIndex];
      setHistoryIndex(prevIndex);
      historyIndexRef.current = prevIndex;
      if (isWindowingMode) {
        setFullContent(prevText);
        fullContentRef.current = prevText;
        const vLines = splitLongLines(prevText);
        virtualLinesRef.current = vLines;
        const newStart = Math.min(windowStartLine, Math.max(0, vLines.length - 300));
        const newEnd = Math.min(newStart + 300, vLines.length);
        setWindowStartLine(newStart);
        setWindowEndLine(newEnd);
        setContent(vLines.slice(newStart, newEnd).join('\n'));
      } else {
        setContent(prevText);
        setFullContent(prevText);
        fullContentRef.current = prevText;
      }
    }
  }, [isWindowingMode, windowStartLine]);

  const redo = useCallback(() => {
    const currentIndex = historyIndexRef.current;
    const currentHist = historyRef.current;
    if (currentIndex < currentHist.length - 1) {
      const nextIndex = currentIndex + 1;
      const nextText = currentHist[nextIndex];
      setHistoryIndex(nextIndex);
      historyIndexRef.current = nextIndex;
      if (isWindowingMode) {
        setFullContent(nextText);
        fullContentRef.current = nextText;
        const vLines = splitLongLines(nextText);
        virtualLinesRef.current = vLines;
        const newStart = Math.min(windowStartLine, Math.max(0, vLines.length - 300));
        const newEnd = Math.min(newStart + 300, vLines.length);
        setWindowStartLine(newStart);
        setWindowEndLine(newEnd);
        setContent(vLines.slice(newStart, newEnd).join('\n'));
      } else {
        setContent(nextText);
        setFullContent(nextText);
        fullContentRef.current = nextText;
      }
    }
  }, [isWindowingMode, windowStartLine]);

  const initialContentRef = useRef(initialContent);
  useEffect(() => {
    initialContentRef.current = initialContent;
  }, [initialContent]);

  // Seed initial content into history stack when note is loaded
  useEffect(() => {
    const init = initialContentRef.current;
    if (init) {
      Promise.resolve().then(() => {
        setHistory([init]);
        setHistoryIndex(0);
        historyRef.current = [init];
        historyIndexRef.current = 0;
      });
    }
  }, [filePath]);

  const handleCopyAll = async () => {
    try {
      const fullTxt = isWindowingMode ? fullContentRef.current : content;
      await navigator.clipboard.writeText(fullTxt);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy text: ', err);
    }
  };

  const handleContentEdit = useCallback((newVisibleContent: string, shouldPushHistory = false) => {
    setContent(newVisibleContent);
    if (isWindowingMode) {
      const newChunkLines = newVisibleContent.split('\n');
      const updatedVirtualLines = [...virtualLinesRef.current];
      updatedVirtualLines.splice(windowStartLine, windowEndLine - windowStartLine, ...newChunkLines);
      virtualLinesRef.current = updatedVirtualLines;

      const newFullContent = mergeVirtualLines(updatedVirtualLines);
      setFullContent(newFullContent);
      fullContentRef.current = newFullContent;
      if (shouldPushHistory) {
        pushEditorState(newFullContent);
      }
    } else {
      setFullContent(newVisibleContent);
      fullContentRef.current = newVisibleContent;
      if (shouldPushHistory) {
        pushEditorState(newVisibleContent);
      }
    }
  }, [isWindowingMode, windowStartLine, windowEndLine, pushEditorState]);

  const handleEditorScroll = (e: React.UIEvent<HTMLDivElement | HTMLTextAreaElement>) => {
    const editorViewport = e.currentTarget;
    if (!editorViewport) return;

    if (isWindowingMode) {
      const scrollTop = editorViewport.scrollTop;
      const clientHeight = editorViewport.clientHeight;

      let accumulatedHeight = 0;
      let centerLine = windowStartLine;
      const targetMiddle = scrollTop + clientHeight / 2;
      const relativeMiddle = targetMiddle - (windowStartLine * 24);

      if (relativeMiddle > 0) {
        for (let i = 0; i < windowLineHeights.length; i++) {
          accumulatedHeight += windowLineHeights[i];
          if (accumulatedHeight > relativeMiddle) {
            centerLine = windowStartLine + i;
            break;
          }
        }
      } else {
        centerLine = Math.floor((scrollTop + clientHeight / 2) / 24);
      }

      if (centerLine - windowStartLine < 75 || windowEndLine - centerLine < 75) {
        let newStart = Math.floor(centerLine - 150);
        newStart = Math.max(0, Math.min(newStart, Math.max(0, virtualLinesRef.current.length - 300)));
        const newEnd = Math.min(newStart + 300, virtualLinesRef.current.length);

        if (newStart !== windowStartLine) {
          const activeTextarea = textareaRef.current;
          if (activeTextarea && document.activeElement === activeTextarea) {
            const curStart = activeTextarea.selectionStart;
            const curEnd = activeTextarea.selectionEnd;
            pendingCursorRef.current = {
              start: getGlobalIndex(curStart, windowStartLine),
              end: getGlobalIndex(curEnd, windowStartLine)
            };
          }

          setWindowStartLine(newStart);
          setWindowEndLine(newEnd);
          const newChunk = virtualLinesRef.current.slice(newStart, newEnd).join('\n');
          setContent(newChunk);
        }
      }
    }
  };

  useLayoutEffect(() => {
    if (pendingCursorRef.current && textareaRef.current) {
      const { start, end } = pendingCursorRef.current;
      pendingCursorRef.current = null;
      const localStart = getLocalIndex(start, windowStartLine);
      const localEnd = getLocalIndex(end, windowStartLine);
      textareaRef.current.setSelectionRange(localStart, localEnd);
    }
  }, [content, windowStartLine, getLocalIndex]);

  // Custom renderer or post-processor for graphviewlinks [[Note Name]] and vault images
  const renderMarkdown = useCallback((text: string, startLineOffset: number = 0): string => {
    const cacheKey = `${text}::${startLineOffset}`;
    const cachedResult = markdownCacheRef.current.get(cacheKey);
    if (cachedResult !== undefined) {
      return cachedResult;
    }
    try {
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      let html = '';

      // A. Spreadsheet Files (.csv, .tsv)
      if (ext === '.csv' || ext === '.tsv') {
        const delimiter = ext === '.csv' ? ',' : '\t';
        const rows = parseCSV(text, delimiter);
        const maxCols = Math.max(...rows.map(r => r.length), 1);

        let tableHtml = `<div class="overflow-x-auto w-full border border-border rounded-xl shadow-sm bg-card/20 my-4 select-text">`;
        tableHtml += `<table class="csv-table w-full border-collapse text-left text-xs text-foreground" style="min-width: 600px;">`;

        tableHtml += `<thead><tr class="border-b border-border bg-muted/40">`;
        tableHtml += `<th class="p-2 text-center font-semibold text-muted-foreground border-r border-border bg-muted/60 w-12 select-none"></th>`;
        for (let c = 0; c < maxCols; c++) {
          tableHtml += `<th class="p-2 font-semibold text-muted-foreground border-r border-border text-center select-none">${getColLabel(c)}</th>`;
        }
        tableHtml += `</tr></thead>`;

        tableHtml += `<tbody>`;
        rows.forEach((row, rIdx) => {
          tableHtml += `<tr class="border-b border-border/80 hover:bg-muted/10">`;
          tableHtml += `<td class="p-2 text-center font-semibold text-muted-foreground border-r border-border bg-muted/30 select-none w-12">${startLineOffset + rIdx + 1}</td>`;
          for (let cIdx = 0; cIdx < maxCols; cIdx++) {
            const val = row[cIdx] || '';
            tableHtml += `<td contenteditable="true" data-row="${rIdx}" data-col="${cIdx}" class="p-2 border-r border-border outline-none focus:bg-primary/5 focus:ring-1 focus:ring-primary/20 transition-all font-mono text-xs whitespace-pre-wrap">${val}</td>`;
          }
          tableHtml += `</tr>`;
        });
        tableHtml += `</tbody></table></div>`;

        tableHtml += `
          <div class="flex items-center gap-2 mt-4 select-none flex-wrap">
            <button class="add-row-btn flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary text-xs font-semibold rounded-lg transition-all cursor-pointer">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              Add Row
            </button>
            <button class="add-col-btn flex items-center gap-1.5 px-3 py-1.5 bg-primary/10 hover:bg-primary/20 text-primary text-xs font-semibold rounded-lg transition-all cursor-pointer">
              <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
              Add Column
            </button>
            <button class="delete-row-btn flex items-center gap-1.5 px-3 py-1.5 bg-destructive/10 hover:bg-destructive/20 text-destructive text-xs font-semibold rounded-lg transition-all cursor-pointer sm:ml-auto">
              Delete Last Row
            </button>
            <button class="delete-col-btn flex items-center gap-1.5 px-3 py-1.5 bg-destructive/10 hover:bg-destructive/20 text-destructive text-xs font-semibold rounded-lg transition-all cursor-pointer">
              Delete Last Column
            </button>
          </div>
        `;
        html = tableHtml;
      }
      // B. Code/Configuration / Plain Text / Custom Files (Any non-markdown, non-canvas text files)
      else if (ext !== '.md' && ext !== '.canvas' && isTextFile(filePath)) {
        const lang = ext.substring(1) || 'text';
        const lines = text.split('\n');
        const codeLines = lines.map((line, idx) => {
          const globalLine = startLineOffset + idx;
          return `<div class="preview-line" data-line="${globalLine}" style="line-height: 26px; min-height: 26px; white-space: pre; word-break: normal;">${line || ' '}</div>`;
        }).join('');

        html = `<pre class="bg-card/30 border border-border rounded-xl p-4 overflow-x-auto my-4 select-text font-mono text-[0.85rem] leading-[1.6]"><code class="language-${lang}" style="display: block; white-space: pre; word-break: normal;">${codeLines}</code></pre>`;
      }
      // C. Markdown / Plaintext
      else {
        // 1. Parse Wiki-links and wiki-embeds (render binary/pdf/images as image tags for subsequent resolving)
        const wikiRegex = /(!)?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
        const processedText = text.replace(wikiRegex, (match, isEmbed, target, width) => {
          if (isEmbed) {
            const targetClean = target.trim();
            const style = width ? `width: ${width.trim()}px; max-width: 100%;` : `max-width: 100%;`;
            return `<img src="${targetClean}" alt="${targetClean}" style="${style} border-radius: 8px;" />`;
          }
          return match;
        });

        // 2. Compile standard Markdown to HTML
        html = md.render(processedText);

        // 3. Resolve local vault image paths to base64 Data URLs, or custom iframe for PDFs / attachment cards
        //    Only process local vault paths (from wiki-embeds ![[file]]). Skip external URLs from standard markdown ![alt](url).
        html = html.replace(/<img src="([^"]+)"([^>]*)>/g, (_match, src, rest) => {
          const srcClean = src.trim();

          // Skip external URLs — they're standard markdown images, not vault embeds
          if (/^(?:https?|data):/.test(srcClean)) {
            return _match;
          }

          const altMatch = rest.match(/alt="([^"]+)"/);
          const alt = altMatch ? altMatch[1] : '';

          const extIndex = srcClean.lastIndexOf('.');
          const srcExt = extIndex !== -1 ? srcClean.substring(extIndex).toLowerCase() : '';
          const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];

          // Normalize relative path: strip leading "./" to resolve root files correctly
          const cleanSrc = srcClean.startsWith('./') ? srcClean.substring(2) : srcClean;

          if (imageExtensions.includes(srcExt)) {
            const cached = vaultImages[cleanSrc] || Object.entries(vaultImages).find(([k]) => k.endsWith(cleanSrc))?.[1];
            return `<img src="${cached || srcClean}"${rest}>`;
          } else if (srcExt === '.pdf') {
            const cached = vaultImages[cleanSrc] || Object.entries(vaultImages).find(([k]) => k.endsWith(cleanSrc))?.[1];
            const filename = cleanSrc.split('/').pop() || cleanSrc;
            const pdfUrl = cached || cleanSrc;
            return `
              <div class="pdf-embed-card border border-border bg-card/30 rounded-xl p-4 my-4 flex flex-col sm:flex-row items-center gap-4 max-w-xl mx-auto shadow-sm animate-fade-in" data-attachment="${cleanSrc}">
                <div class="w-12 h-12 rounded-xl bg-red-500/10 text-red-500 flex items-center justify-center shrink-0 border border-red-500/20">
                  <svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-paperclip"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                </div>
                <div class="flex-1 min-w-0 text-center sm:text-left">
                  <span class="text-sm font-bold text-foreground truncate block">${filename}</span>
                  <span class="text-[0.65rem] text-muted-foreground block mt-0.5">PDF attachment (embedding restricted by browser security)</span>
                </div>
                <div class="flex gap-2 shrink-0">
                  <a href="${pdfUrl}" target="_blank" rel="noopener noreferrer" class="px-3 py-1.5 bg-primary text-primary-foreground hover:bg-primary/95 text-xs font-semibold rounded-lg transition-all cursor-pointer shadow-sm shadow-primary/10 flex items-center justify-center">
                    Open PDF
                  </a>
                  <button class="download-attachment-btn w-8 h-8 rounded-full bg-border/40 hover:bg-border/80 flex items-center justify-center text-foreground transition-all cursor-pointer border border-transparent" data-path="${cleanSrc}" title="Download PDF">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-download"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                  </button>
                </div>
              </div>
            `;
          } else {
            // Non-image, non-PDF local vault file — render as attachment card
            const filename = alt || srcClean.split('/').pop() || srcClean;
            const displayExt = srcExt ? srcExt.substring(1).toUpperCase() : 'FILE';
            return `
              <div class="attachment-embed-card border border-border bg-muted/30 rounded-xl p-3 my-2 flex items-center gap-3 animate-fade-in" data-attachment="${srcClean}">
                <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                  <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-paperclip"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                </div>
                <div class="flex-1 min-w-0">
                  <span class="text-xs font-bold text-foreground truncate block">${filename}</span>
                  <span class="text-[0.6rem] text-muted-foreground uppercase font-semibold block">${displayExt} Attachment</span>
                </div>
                <button class="download-attachment-btn w-8 h-8 rounded-full bg-border/40 hover:bg-border/80 flex items-center justify-center text-foreground transition-all cursor-pointer border border-transparent" data-path="${srcClean}" title="Download attachment">
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-download"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                </button>
              </div>
            `;
          }
        });


        // 4. Parse Graphview-links: [[Another Note]] or [[Another Note|Display Name]]
        const graphviewLinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
        html = html.replace(graphviewLinkRegex, (_, target, label) => {
          const targetClean = target.trim();
          const displayLabel = label ? label.trim() : targetClean;
          return `<a class="graphview-link" data-note="${targetClean}" title="Open note: ${targetClean}">${displayLabel}</a>`;
        });
      }

      // 5. Bulletproof sanitize through DOMPurify to eliminate any script injection vectors
      const sanitizedResult = DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true, mathMl: true, svg: true },
        ADD_ATTR: ['data-note', 'data-attachment', 'data-path', 'title', 'contenteditable', 'data-row', 'data-col', 'src', 'type', 'class', 'target', 'rel', 'width', 'height', 'border', 'sandbox'],
        ADD_TAGS: ['iframe', 'svg', 'line'],
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|sms|blob):|[^&:/?#]*(?:[/?#]|$))/i
      });

      markdownCacheRef.current.set(cacheKey, sanitizedResult);
      return sanitizedResult;
    } catch {
      return `<p class="text-destructive font-medium">Error parsing content.</p>`;
    }
  }, [filePath, vaultImages]);



  // Background Scraper scanning note text for local vault attachments (images and other files)
  useEffect(() => {
    const attachments: string[] = [];
    const obsRegex = /!?\[\[([^\]]+)\]\]/g;
    const mdRegex = /!?\[[^\]]*\]\(([^)]+)\)/g;
    let match;
    while ((match = obsRegex.exec(fullContent)) !== null) {
      attachments.push(match[1].split('|')[0].trim());
    }
    while ((match = mdRegex.exec(fullContent)) !== null) {
      attachments.push(match[1].trim());
    }

    attachments.forEach(attachmentName => {
      const matchedFile = files.find(f => f.name.toLowerCase() === attachmentName.toLowerCase() || f.path.toLowerCase().endsWith(attachmentName.toLowerCase()));
      if (matchedFile && !isTextFile(matchedFile.path) && matchedFile.sha && !vaultImages[matchedFile.path]) {
        onFetchBinaryFile(matchedFile.path, matchedFile.sha);
      }
    });
  }, [fullContent, files, vaultImages, onFetchBinaryFile]);

  // Autocomplete suggestions states
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionQuery, setSuggestionQuery] = useState('');
  const [suggestionSearchQuery, setSuggestionSearchQuery] = useState('');
  const [suggestionPosition, setSuggestionPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [caretIndex, setCaretIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const hasRestoredRef = useRef(false);

  // Track original content to see if there are unsaved changes
  const originalContent = useRef(initialContent);

  // Robust refs to prevent stale closures and unsafe unmount state sets
  const contentRef = useRef(content);
  const shaRef = useRef(sha);
  const onSaveRef = useRef(onSave);
  const isMounted = useRef(true);

  // Render-phase prop synchronization
  // Add this effect to handle file switching
  // Render-phase prop synchronization (Strictly tied to filePath & external content updates)
  // 1. Render-phase prop synchronization for STATE
  const [prevFilePath, setPrevFilePath] = useState(filePath);
  const [prevInitialContent, setPrevInitialContent] = useState(initialContent);

  if (filePath !== prevFilePath) {
    setPrevFilePath(filePath);
    setPrevInitialContent(initialContent);
    setSha(initialSha);
    setSavedContent(initialContent);
    setSaveStatus('idle');
    setErrorMessage('');

    const newIsWindowing = initialContent.length > 50000;
    if (newIsWindowing) {
      const vLines = splitLongLines(initialContent);
      setVirtualLines(vLines);
      const start = 0;
      const end = Math.min(300, vLines.length);
      setWindowStartLine(start);
      setWindowEndLine(end);
      const chunkText = vLines.slice(start, end).join('\n');
      setContent(chunkText);
      setFullContent(initialContent);
    } else {
      setVirtualLines([]);
      setContent(initialContent);
      setFullContent(initialContent);
    }
  } else if (initialContent !== prevInitialContent) {
    setPrevInitialContent(initialContent);
    setSha(initialSha);
    // Only update active content if the change is external (does not match what we last saved/have in memory)
    if (initialContent !== savedContent) {
      const isDirty = isWindowingMode ? (fullContent !== savedContent) : (content !== savedContent);
      if (isDirty) {
        setSavedContent(initialContent);
      } else {
        const newIsWindowing = initialContent.length > 50000;
        if (newIsWindowing) {
          const vLines = splitLongLines(initialContent);
          setVirtualLines(vLines);
          const start = 0;
          const end = Math.min(300, vLines.length);
          setWindowStartLine(start);
          setWindowEndLine(end);
          const chunkText = vLines.slice(start, end).join('\n');
          setContent(chunkText);
          setFullContent(initialContent);
        } else {
          setVirtualLines([]);
          setContent(initialContent);
          setFullContent(initialContent);
        }
        setSavedContent(initialContent);
      }
    }
  }

  // Reset cursor restoration tracker when active file changes
  useEffect(() => {
    hasRestoredRef.current = false;
  }, [filePath]);

  // 2. Commit-phase synchronization for REFS
  useEffect(() => {
    originalContent.current = initialContent;
  }, [filePath, initialContent]);

  // Filter notes suggestions in real-time
  const filteredSuggestions = files
    .filter(f => {
      const lowerPath = f.path.toLowerCase();
      // Exclude files from .obsidian folder
      if (lowerPath.includes('.obsidian/') || lowerPath.startsWith('.obsidian/')) {
        return false;
      }
      // Exclude files created by this application for validation (.gitkeep, .vault-compat.json)
      const name = f.name.toLowerCase();
      if (name === '.gitkeep' || name === '.vault-compat.json') {
        return false;
      }
      // Whitelist allowed extensions for note linking (notes + attachments)
      const allowed = ['.md', '.txt', '.canvas', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf'];
      return allowed.some(ext => lowerPath.endsWith(ext));
    })
    .map(f => f.path)
    .filter(path => {
      const q = suggestionQuery.toLowerCase();
      const s = suggestionSearchQuery.toLowerCase();
      const lower = path.toLowerCase();
      return lower.includes(q) && lower.includes(s);
    });

  const calculateCaretPosition = (textarea: HTMLTextAreaElement, caretIdx: number) => {
    const mirror = document.createElement('div');
    const style = window.getComputedStyle(textarea);

    // Exact matching copy style
    mirror.style.position = 'absolute';
    mirror.style.visibility = 'hidden';
    mirror.style.whiteSpace = 'pre-wrap';
    mirror.style.wordBreak = 'break-word';
    mirror.style.fontFamily = style.fontFamily;
    mirror.style.fontSize = style.fontSize;
    mirror.style.lineHeight = style.lineHeight;
    mirror.style.padding = style.padding;
    mirror.style.border = style.border;
    mirror.style.boxSizing = style.boxSizing;
    mirror.style.width = `${textarea.clientWidth}px`;
    mirror.style.height = `${textarea.clientHeight}px`;
    mirror.style.overflow = 'hidden';

    const textBefore = textarea.value.substring(0, caretIdx);
    mirror.textContent = textBefore;

    const marker = document.createElement('span');
    marker.textContent = '|';
    mirror.appendChild(marker);

    document.body.appendChild(mirror);

    // Add offset limits to avoid clipping near borders
    const relativeTop = isWindowingMode
      ? marker.offsetTop + (windowStartLine * 24) - (viewportRef.current?.scrollTop || 0) + 22
      : marker.offsetTop - textarea.scrollTop + 22;
    const relativeLeft = isWindowingMode
      ? Math.min(marker.offsetLeft + 48 - (viewportRef.current?.scrollLeft || 0), (viewportRef.current?.clientWidth || textarea.clientWidth) - 250)
      : Math.min(marker.offsetLeft, textarea.clientWidth - 250);

    setSuggestionPosition({
      top: relativeTop,
      left: relativeLeft
    });

    document.body.removeChild(mirror);
  };

  const insertSuggestion = (noteName: string) => {
    if (!textareaRef.current) return;

    const cleanNoteName = noteName.replace(/\.md$/, '');
    const textarea = textareaRef.current;

    // Use fullContent for windowing mode, content for normal mode
    const sourceContent = isWindowingMode ? fullContentRef.current : content;

    // Convert textarea positions to global positions if in windowing mode
    const globalCaretIndex = isWindowingMode
      ? getGlobalIndex(caretIndex, windowStartLine)
      : caretIndex;
    const globalSelectionStart = isWindowingMode
      ? getGlobalIndex(textarea.selectionStart, windowStartLine)
      : textarea.selectionStart;

    const startText = sourceContent.substring(0, globalCaretIndex);
    const endText = sourceContent.substring(globalSelectionStart);

    const insertedLink = `[[${cleanNoteName}]]`;
    const newContent = startText + insertedLink + endText;

    if (isWindowingMode) {
      // Update full content and recalculate visible window
      setFullContent(newContent);
      fullContentRef.current = newContent;
      const vLines = splitLongLines(newContent);
      virtualLinesRef.current = vLines;
      const newStart = Math.min(windowStartLine, Math.max(0, vLines.length - 300));
      const newEnd = Math.min(newStart + 300, vLines.length);
      setWindowStartLine(newStart);
      setWindowEndLine(newEnd);
      setContent(vLines.slice(newStart, newEnd).join('\n'));
      pushEditorState(newContent);
    } else {
      setContent(newContent);
      setFullContent(newContent);
      fullContentRef.current = newContent;
      pushEditorState(newContent);
    }
    setShowSuggestions(false);
    setSuggestionSearchQuery('');

    // Re-focus and shift caret location past brackets
    setTimeout(() => {
      textarea.focus();
      const newPos = globalCaretIndex + insertedLink.length;
      const localNewPos = isWindowingMode ? getLocalIndex(newPos, windowStartLine) : newPos;
      textarea.setSelectionRange(localNewPos, localNewPos);
    }, 50);
  };

  const handleTextareaKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showSuggestions && filteredSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSuggestionIndex(prev => (prev + 1) % filteredSuggestions.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSuggestionIndex(prev => (prev - 1 + filteredSuggestions.length) % filteredSuggestions.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        insertSuggestion(filteredSuggestions[suggestionIndex]);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowSuggestions(false);
        setSuggestionSearchQuery('');
      }
    }
  };

  const handleSearchInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      setShowSuggestions(false);
      setSuggestionSearchQuery('');
    } else if (filteredSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSuggestionIndex(prev => (prev + 1) % filteredSuggestions.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSuggestionIndex(prev => (prev - 1 + filteredSuggestions.length) % filteredSuggestions.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        insertSuggestion(filteredSuggestions[suggestionIndex]);
      }
    }
  };

  const handleTextareaPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          setIsUploading(true);
          try {
            const result = await onUploadAttachment(file);
            if (result && result.name) {
              const textarea = textareaRef.current;
              if (textarea) {
                const sourceContent = isWindowingMode ? fullContentRef.current : content;
                const globalStartPos = isWindowingMode ? getGlobalIndex(textarea.selectionStart, windowStartLine) : textarea.selectionStart;
                const globalEndPos = isWindowingMode ? getGlobalIndex(textarea.selectionEnd, windowStartLine) : textarea.selectionEnd;
                const textToInsert = `![[${result.name}]]`;
                const newContent = sourceContent.substring(0, globalStartPos) + textToInsert + sourceContent.substring(globalEndPos);

                if (isWindowingMode) {
                  setFullContent(newContent);
                  fullContentRef.current = newContent;
                  const vLines = splitLongLines(newContent);
                  virtualLinesRef.current = vLines;
                  const newStart = Math.min(windowStartLine, Math.max(0, vLines.length - 300));
                  const newEnd = Math.min(newStart + 300, vLines.length);
                  setWindowStartLine(newStart);
                  setWindowEndLine(newEnd);
                  setContent(vLines.slice(newStart, newEnd).join('\n'));
                  pushEditorState(newContent);
                } else {
                  setContent(newContent);
                  setFullContent(newContent);
                  fullContentRef.current = newContent;
                  pushEditorState(newContent);
                }

                // Move cursor past the inserted link
                setTimeout(() => {
                  textarea.focus();
                  const newCursorPos = globalStartPos + textToInsert.length;
                  const localNewPos = isWindowingMode ? getLocalIndex(newCursorPos, windowStartLine) : newCursorPos;
                  textarea.setSelectionRange(localNewPos, localNewPos);
                }, 50);
              }
            }
          } catch (err) {
            console.error("Failed to upload pasted image:", err);
          } finally {
            setIsUploading(false);
          }
        }
      }
    }
  };

  // Refs migrated to top of component to prevent Temporal Dead Zone (TDZ) issues during render-phase synchronization

  useEffect(() => {
    contentRef.current = content;
  }, [content]);

  useEffect(() => {
    fullContentRef.current = fullContent;
  }, [fullContent]);

  useEffect(() => {
    shaRef.current = sha;
  }, [sha]);

  useEffect(() => {
    originalContent.current = initialContent;
  }, [initialContent]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    const previewContainer = previewContainerRef.current;
    if (!previewContainer) return;

    if (isEditingFromPreviewRef.current) {
      isEditingFromPreviewRef.current = false;
      return;
    }

    const runRender = () => {
      if (isWindowingMode) {
        const topSpacer = `<div style="height: ${windowStartLine * 26}px; width: 100%;"></div>`;
        const bottomSpacer = `<div style="height: ${Math.max(0, virtualLines.length - windowEndLine) * 26}px; width: 100%;"></div>`;
        previewContainer.innerHTML = topSpacer + renderMarkdown(content, windowStartLine) + bottomSpacer;
      } else {
        previewContainer.innerHTML = renderMarkdown(content, 0);
      }
      triggerMermaidRender();
    };

    const triggerMermaidRender = () => {
      const mermaidNodes = previewContainer.querySelectorAll('.mermaid');
      if (mermaidNodes.length === 0) return;

      if (mermaidRenderTimerRef.current) {
        clearTimeout(mermaidRenderTimerRef.current);
      }

      const pathChanged = lastRenderedPathRef.current !== filePath;
      const delay = pathChanged ? 0 : 800;

      mermaidRenderTimerRef.current = setTimeout(() => {
        import('mermaid').then((mermaidLib) => {
          const m = mermaidLib.default;
          m.initialize({
            startOnLoad: false,
            theme: 'dark',
            securityLevel: 'strict',
            fontFamily: 'Inter, sans-serif',
          });
          m.run({ nodes: mermaidNodes as NodeListOf<HTMLElement> }).catch(() => {});
        }).catch(() => {});
      }, delay);
    };

    const pathChanged = lastRenderedPathRef.current !== filePath;
    lastRenderedPathRef.current = filePath;

    if (pathChanged) {
      if (markdownRenderTimerRef.current) {
        clearTimeout(markdownRenderTimerRef.current);
      }
      runRender();
    } else {
      if (markdownRenderTimerRef.current) {
        clearTimeout(markdownRenderTimerRef.current);
      }
      markdownRenderTimerRef.current = setTimeout(() => {
        runRender();
      }, 120);
    }

    return () => {
      if (markdownRenderTimerRef.current) {
        clearTimeout(markdownRenderTimerRef.current);
      }
      if (mermaidRenderTimerRef.current) {
        clearTimeout(mermaidRenderTimerRef.current);
      }
    };
  }, [content, filePath, viewMode, renderMarkdown, isWindowingMode, windowStartLine, windowEndLine, virtualLines.length]);

  // Unified save orchestration
  const performAutoSave = useCallback(async () => {
    // Prevent concurrent saves - skip if already saving
    if (isSavingRef.current) return;

    const currentVal = fullContentRef.current;
    const currentSha = shaRef.current;
    const origVal = originalContent.current;

    if (currentVal === origVal) return;

    isSavingRef.current = true;

    // Save cursor position before saving
    if (textareaRef.current) {
      saveEditorState(vaultId, filePath, {
        cursorPos: isWindowingMode
          ? getGlobalIndex(textareaRef.current.selectionStart, windowStartLine)
          : textareaRef.current.selectionStart,
        scrollPos: isWindowingMode
          ? (viewportRef.current ? viewportRef.current.scrollTop : 0)
          : textareaRef.current.scrollTop,
      });
    }

    if (isMounted.current) {
      setSaveStatus('saving');
      setErrorMessage('');
    }

    try {
      const result = await onSaveRef.current(currentVal, currentSha);
      if (isMounted.current) {
        setSha(result.sha);
        shaRef.current = result.sha;
        originalContent.current = currentVal;
        setSavedContent(currentVal);
        setSaveStatus('saved');
        setTimeout(() => {
          if (isMounted.current) setSaveStatus('idle');
        }, 3000);
      }
    } catch (error: unknown) {
      if (isMounted.current) {
        setSaveStatus('error');
        if (error instanceof GitConflictError) {
          setErrorMessage(error.message);
        } else {
          const errMsg = error instanceof Error ? error.message : 'Failed to save note to GitHub.';
          setErrorMessage(errMsg);
        }
      }
    } finally {
      isSavingRef.current = false;
    }
  }, [vaultId, filePath, isWindowingMode, windowStartLine, getGlobalIndex]);

  // Debounced auto-save effect for editor content while typing
  useEffect(() => {
    const timer = setTimeout(() => {
      performAutoSave();
      pushEditorState(fullContentRef.current);
    }, 5000); // 5 second debounce (increased from 3s to reduce conflicts)

    return () => clearTimeout(timer);
  }, [content, performAutoSave, pushEditorState]);

  // Window defocus (click-away) & unmount listener
  useEffect(() => {
    const currentTextarea = textareaRef.current;

    const handleWindowBlur = () => {
      // Save cursor position on blur
      if (currentTextarea) {
        saveEditorState(vaultId, filePath, {
          cursorPos: isWindowingMode
            ? getGlobalIndex(currentTextarea.selectionStart, windowStartLine)
            : currentTextarea.selectionStart,
          scrollPos: isWindowingMode
            ? (viewportRef.current ? viewportRef.current.scrollTop : 0)
            : currentTextarea.scrollTop,
        });
      }
      performAutoSave();
      pushEditorState(fullContentRef.current);
    };

    const currentViewport = viewportRef.current;
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      if (currentTextarea) {
        saveEditorState(vaultId, filePath, {
          cursorPos: isWindowingMode
            ? getGlobalIndex(currentTextarea.selectionStart, windowStartLine)
            : currentTextarea.selectionStart,
          scrollPos: isWindowingMode
            ? (currentViewport ? currentViewport.scrollTop : 0)
            : currentTextarea.scrollTop,
        });
      }
      performAutoSave(); // Final save on unmount!
      pushEditorState(fullContentRef.current);
    };
  }, [vaultId, filePath, performAutoSave, pushEditorState, isWindowingMode, windowStartLine, getGlobalIndex]);

  useEffect(() => {
    // Restore cursor position after content is loaded
    const timer = setTimeout(() => {
      if (initialSearchLineIndex !== undefined) {
        if (isWindowingMode) {
          const vLines = virtualLinesRef.current;
          const targetLine = initialSearchLineIndex;
          let newStart = Math.max(0, targetLine - 150);
          newStart = Math.min(newStart, Math.max(0, vLines.length - 300));
          const newEnd = Math.min(newStart + 300, vLines.length);

          setWindowStartLine(newStart);
          setWindowEndLine(newEnd);
          setContent(vLines.slice(newStart, newEnd).join('\n'));

          let localCharIndex = 0;
          for (let i = newStart; i < Math.min(targetLine, vLines.length); i++) {
            localCharIndex += vLines[i].length + 1;
          }

          setTimeout(() => {
            const viewport = viewportRef.current;
            if (viewport) {
              const targetScroll = Math.max(0, targetLine * 24 - (viewport.clientHeight / 2));
              viewport.scrollTop = targetScroll;
            }
            if (textareaRef.current) {
              textareaRef.current.setSelectionRange(localCharIndex, localCharIndex);
              textareaRef.current.focus();
            }
          }, 50);
        } else {
          if (textareaRef.current) {
            const textarea = textareaRef.current;
            const lines = initialContent.split('\n');
            let charIndex = 0;
            for (let i = 0; i < Math.min(initialSearchLineIndex, lines.length); i++) {
              charIndex += lines[i].length + 1;
            }
            textarea.setSelectionRange(charIndex, charIndex);
            textarea.focus();

            const linePercentage = initialSearchLineIndex / Math.max(1, lines.length);
            const targetScroll = Math.max(0, textarea.scrollHeight * linePercentage - (textarea.clientHeight / 2));
            textarea.scrollTop = targetScroll;
          }
        }

        hasRestoredRef.current = true;
        if (onClearTargetLine) {
          onClearTargetLine();
        }
      } else if (!hasRestoredRef.current) {
        hasRestoredRef.current = true;
        const savedState = restoreEditorState(vaultId, filePath);
        if (savedState.cursorPos !== undefined) {
          if (isWindowingMode) {
            const globalPos = savedState.cursorPos;
            let charCount = 0;
            let targetLine = 0;
            const vLines = virtualLinesRef.current;
            for (let i = 0; i < vLines.length; i++) {
              const lineLen = vLines[i].length + 1;
              if (charCount + lineLen > globalPos) {
                targetLine = i;
                break;
              }
              charCount += lineLen;
            }

            let newStart = Math.max(0, targetLine - 150);
            newStart = Math.min(newStart, Math.max(0, vLines.length - 300));
            const newEnd = Math.min(newStart + 300, vLines.length);

            setWindowStartLine(newStart);
            setWindowEndLine(newEnd);
            setContent(vLines.slice(newStart, newEnd).join('\n'));

            const localPos = Math.max(0, globalPos - charCount);

            setTimeout(() => {
              const viewport = viewportRef.current;
              if (viewport && savedState.scrollPos !== undefined) {
                viewport.scrollTop = savedState.scrollPos;
              } else if (viewport) {
                viewport.scrollTop = Math.max(0, targetLine * 24 - (viewport.clientHeight / 2));
              }
              if (textareaRef.current) {
                textareaRef.current.setSelectionRange(localPos, localPos);
                textareaRef.current.focus();
              }
            }, 50);
          } else {
            if (textareaRef.current) {
              textareaRef.current.setSelectionRange(savedState.cursorPos, savedState.cursorPos);
              textareaRef.current.focus();
            }
            if (textareaRef.current && savedState.scrollPos !== undefined) {
              textareaRef.current.scrollTop = savedState.scrollPos;
            }
          }
        }
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [filePath, vaultId, initialSearchLineIndex, onClearTargetLine, initialContent, isWindowingMode]);




  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    handleContentEdit(value);

    const selectionStart = e.target.selectionStart;

    // Debounce pushing history state
    if (historyTimerRef.current) {
      clearTimeout(historyTimerRef.current);
    }
    const lastChar = value[selectionStart - 1];
    const shouldPushImmediately = lastChar === ' ' || lastChar === '\n';
    if (shouldPushImmediately) {
      const latestFullContent = isWindowingMode ? fullContentRef.current : value;
      pushEditorState(latestFullContent);
    } else {
      historyTimerRef.current = setTimeout(() => {
        const latestFullContent = isWindowingMode ? fullContentRef.current : value;
        pushEditorState(latestFullContent);
      }, 1000);
    }

    const textBeforeCaret = value.substring(0, selectionStart);

    // Find last double bracket index
    const lastBracketIndex = textBeforeCaret.lastIndexOf('[[');

    if (lastBracketIndex !== -1 && lastBracketIndex >= textBeforeCaret.lastIndexOf(']]')) {
      const query = textBeforeCaret.substring(lastBracketIndex + 2);

      // Make sure the query is on the current typing line
      if (!query.includes('\n')) {
        setShowSuggestions(true);
        setSuggestionQuery(query);
        setCaretIndex(lastBracketIndex);
        setSuggestionIndex(0);

        calculateCaretPosition(e.target, lastBracketIndex);
        return;
      }
    }

    setShowSuggestions(false);
  };

  const handleSave = () => {
    performAutoSave();
  };

  const handleAutoSave = () => {
    performAutoSave();
  };

  // Capture clicks inside the preview panel to handle custom interactive graphview-links and downloads
  const handlePreviewClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;

    // Capture spreadsheet row/col modification buttons
    const addRowBtn = target.closest('.add-row-btn');
    if (addRowBtn) {
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      const delimiter = ext === '.csv' ? ',' : '\t';
      const rows = parseCSV(fullContent, delimiter);
      const maxCols = Math.max(...rows.map(r => r.length), 1);
      rows.push(Array(maxCols).fill(''));
      const newContent = stringifyCSV(rows, delimiter);
      if (isWindowingMode) {
        const vLines = splitLongLines(newContent);
        virtualLinesRef.current = vLines;
        const start = Math.min(windowStartLine, Math.max(0, vLines.length - 300));
        const end = Math.min(start + 300, vLines.length);
        setWindowStartLine(start);
        setWindowEndLine(end);
        setContent(vLines.slice(start, end).join('\n'));
        setFullContent(newContent);
        fullContentRef.current = newContent;
        pushEditorState(newContent);
      } else {
        setContent(newContent);
        setFullContent(newContent);
        fullContentRef.current = newContent;
        pushEditorState(newContent);
      }
      return;
    }

    const addColBtn = target.closest('.add-col-btn');
    if (addColBtn) {
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      const delimiter = ext === '.csv' ? ',' : '\t';
      const rows = parseCSV(fullContent, delimiter);
      const updatedRows = rows.map(row => [...row, '']);
      const newContent = stringifyCSV(updatedRows, delimiter);
      if (isWindowingMode) {
        const vLines = splitLongLines(newContent);
        virtualLinesRef.current = vLines;
        const start = Math.min(windowStartLine, Math.max(0, vLines.length - 300));
        const end = Math.min(start + 300, vLines.length);
        setWindowStartLine(start);
        setWindowEndLine(end);
        setContent(vLines.slice(start, end).join('\n'));
        setFullContent(newContent);
        fullContentRef.current = newContent;
        pushEditorState(newContent);
      } else {
        setContent(newContent);
        setFullContent(newContent);
        fullContentRef.current = newContent;
        pushEditorState(newContent);
      }
      return;
    }

    const deleteRowBtn = target.closest('.delete-row-btn');
    if (deleteRowBtn) {
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      const delimiter = ext === '.csv' ? ',' : '\t';
      const rows = parseCSV(fullContent, delimiter);
      if (rows.length > 1) {
        rows.pop();
        const newContent = stringifyCSV(rows, delimiter);
        if (isWindowingMode) {
          const vLines = splitLongLines(newContent);
          virtualLinesRef.current = vLines;
          const start = Math.min(windowStartLine, Math.max(0, vLines.length - 300));
          const end = Math.min(start + 300, vLines.length);
          setWindowStartLine(start);
          setWindowEndLine(end);
          setContent(vLines.slice(start, end).join('\n'));
          setFullContent(newContent);
          fullContentRef.current = newContent;
          pushEditorState(newContent);
        } else {
          setContent(newContent);
          setFullContent(newContent);
          fullContentRef.current = newContent;
          pushEditorState(newContent);
        }
      }
      return;
    }

    const deleteColBtn = target.closest('.delete-col-btn');
    if (deleteColBtn) {
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      const delimiter = ext === '.csv' ? ',' : '\t';
      const rows = parseCSV(fullContent, delimiter);
      const maxCols = Math.max(...rows.map(r => r.length), 1);
      if (maxCols > 1) {
        const updatedRows = rows.map(row => row.slice(0, -1));
        const newContent = stringifyCSV(updatedRows, delimiter);
        if (isWindowingMode) {
          const vLines = splitLongLines(newContent);
          virtualLinesRef.current = vLines;
          const start = Math.min(windowStartLine, Math.max(0, vLines.length - 300));
          const end = Math.min(start + 300, vLines.length);
          setWindowStartLine(start);
          setWindowEndLine(end);
          setContent(vLines.slice(start, end).join('\n'));
          setFullContent(newContent);
          fullContentRef.current = newContent;
          pushEditorState(newContent);
        } else {
          setContent(newContent);
          setFullContent(newContent);
          fullContentRef.current = newContent;
          pushEditorState(newContent);
        }
      }
      return;
    }

    // Check if clicked element or parent has graphview-link class
    const graphviewLink = target.closest('.graphview-link');
    if (graphviewLink) {
      const noteName = graphviewLink.getAttribute('data-note');
      if (noteName) {
        // Appends .md extension if missing to facilitate correct lookups
        const fullFileName = noteName.endsWith('.md') ? noteName : `${noteName}.md`;
        onOpenNote(fullFileName);
      }
      return;
    }

    // Capture clicks on the download button in attachment cards
    const downloadBtn = target.closest('.download-attachment-btn');
    if (downloadBtn) {
      const filePath = downloadBtn.getAttribute('data-path');
      if (filePath) {
        const cleanPath = filePath.startsWith('./') ? filePath.substring(2) : filePath;
        const matched = files.find(f => f.name.toLowerCase() === cleanPath.toLowerCase() || f.path.toLowerCase().endsWith(cleanPath.toLowerCase()));
        const fullPath = matched ? matched.path : cleanPath;
        const base64Data = vaultImages[fullPath] || Object.entries(vaultImages).find(([k]) => k.endsWith(cleanPath))?.[1];
        if (base64Data) {
          const link = document.createElement('a');
          link.href = base64Data;
          link.download = filePath.split('/').pop() || filePath;
          document.body.appendChild(link);
          link.click();
          document.body.removeChild(link);
        } else {
          setErrorMessage(`Attachment is still loading from GitHub or not found in vault. Path: ${filePath}`);
          setSaveStatus('error');
        }
      }
    }
  };

  const handlePreviewInput = (e: React.FormEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'TD' && target.hasAttribute('data-row') && target.hasAttribute('data-col')) {
      const rowIdx = parseInt(target.getAttribute('data-row') || '0', 10);
      const colIdx = parseInt(target.getAttribute('data-col') || '0', 10);
      const newVal = target.innerText;

      activeCsvEditRef.current = { row: rowIdx, col: colIdx, val: newVal };

      if (csvDebounceTimerRef.current) {
        clearTimeout(csvDebounceTimerRef.current);
      }
      csvDebounceTimerRef.current = setTimeout(() => {
        commitCsvChanges();
      }, 1000); // 1 second debounce
    }
  };

  const handlePreviewBlur = (e: React.FocusEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'TD' && target.hasAttribute('data-row') && target.hasAttribute('data-col')) {
      commitCsvChanges();
    }
  };

  const hasUnsavedChanges = (isWindowingMode ? fullContent : content) !== savedContent;

  return (
    <div className="flex flex-col w-full h-full bg-background relative select-none animate-fade-in">
      {/* Error banner */}
      {saveStatus === 'error' && (
        <div className="bg-red-500/10 border-b border-red-500/20 text-red-200/90 text-xs px-5 py-3 sm:px-6 sm:py-2.5 flex flex-col sm:flex-row sm:items-center justify-between shrink-0 gap-3 select-none animate-fade-in">
          <div className="flex items-start gap-2.5 min-w-0">
            <AlertCircle className="w-4 h-4 text-red-400 shrink-0 animate-pulse mt-0.5 sm:mt-0" />
            <span className="font-semibold leading-relaxed truncate">{errorMessage}</span>
          </div>
          <div className="flex items-center gap-2 self-end sm:self-auto shrink-0 w-full sm:w-auto justify-end">
            <button
              onClick={() => setSaveStatus('idle')}
              className="px-3 py-1.5 bg-red-500/20 border border-red-500/30 hover:bg-red-500/30 text-red-300 text-[0.68rem] font-bold uppercase tracking-wider rounded-lg transition-all cursor-pointer"
            >
              Dismiss
            </button>
            <button
              onClick={handleSave}
              className="px-3 py-1.5 bg-amber-500/20 border border-amber-500/30 hover:bg-amber-500/30 text-amber-300 text-[0.68rem] font-bold uppercase tracking-wider rounded-lg transition-all cursor-pointer"
            >
              Retry
            </button>
          </div>
        </div>
      )}

      {/* Main editor/preview flex container */}
      <div className="flex flex-col md:flex-row w-full h-full flex-1 bg-background relative">

        {/* Editor Pane */}
        <div
          className={cn(
            "flex-col min-w-0 border-b md:border-b-0 md:border-r border-border bg-background transition-all duration-300 relative",
            viewMode === 'preview' ? "hidden w-0 h-0" : "flex flex-1",
            viewMode === 'edit' ? "w-full h-full" : "w-full md:w-1/2 h-[45%] md:h-full"
          )}
        >
          <div className="h-10 bg-card/80 backdrop-blur-xl border-b border-border flex items-center justify-between px-4 shrink-0 text-muted-foreground text-[0.7rem] font-bold uppercase tracking-wider select-none">
            <span>Editor: {filePath.split('/').pop()}</span>
            <div className="flex items-center gap-3">
              {hasUnsavedChanges && (
                <span className="text-amber-500 flex items-center gap-1.5 normal-case font-semibold animate-pulse-soft">
                  <span className="w-1.5 h-1.5 bg-amber-500 rounded-full shrink-0" />
                  Unsaved Edits
                </span>
              )}
              <button
                onClick={handleCopyAll}
                className="flex items-center gap-1 px-2.5 py-1 bg-border/40 hover:bg-border/80 text-foreground rounded-lg text-[0.6rem] font-bold transition-all cursor-pointer normal-case shrink-0"
                title="Copy all file contents"
              >
                {copied ? (
                  <>
                    <Check size={11} className="text-emerald-500" />
                    <span className="text-emerald-500">Copied!</span>
                  </>
                ) : (
                  <>
                    <Copy size={11} />
                    <span>Copy Content</span>
                  </>
                )}
              </button>
            </div>
          </div>

          <div
            ref={viewportRef}
            onScroll={isWindowingMode ? handleEditorScroll : undefined}
            className={cn(
              "flex-1 w-full h-[calc(100%-40px)] relative select-text",
              isWindowingMode ? "overflow-y-auto overflow-x-hidden" : ""
            )}
            style={isWindowingMode ? {
              position: 'relative',
              width: '100%',
              height: '100%',
              overflowY: 'auto',
              overflowX: 'hidden',
            } : undefined}
          >
            {isWindowingMode ? (
              <div
                style={{
                  boxSizing: 'border-box',
                  paddingTop: `${windowStartLine * 24}px`,
                  paddingBottom: `${Math.max(0, virtualLines.length - windowEndLine) * 24 + 128}px`,
                  width: '100%',
                  display: 'flex',
                  flexDirection: 'row',
                  alignItems: 'stretch',
                }}
              >
                {/* Line Counter */}
                <div
                  style={{
                    width: '48px',
                    backgroundColor: 'rgba(255, 255, 255, 0.02)',
                    color: 'rgba(255, 255, 255, 0.3)',
                    fontFamily: 'monospace',
                    fontSize: '14.8px',
                    lineHeight: '24px',
                    textAlign: 'right',
                    paddingRight: '12px',
                    paddingLeft: '6px',
                    userSelect: 'none',
                    borderRight: '1px solid rgba(255, 255, 255, 0.08)',
                    boxSizing: 'border-box',
                    display: 'flex',
                    flexDirection: 'column',
                    height: `${windowLineHeights.reduce((a, b) => a + b, 0)}px`,
                  }}
                >
                  {Array.from({ length: windowEndLine - windowStartLine }, (_, idx) => windowStartLine + idx + 1).map((num, idx) => (
                    <div key={num} style={{ height: `${windowLineHeights[idx] || 24}px` }}>{num}</div>
                  ))}
                </div>

                {/* Textarea */}
                <textarea
                  ref={textareaRef}
                  value={content}
                  onChange={handleTextareaChange}
                  onKeyDown={handleTextareaKeyDown}
                  onPaste={handleTextareaPaste}
                  onBlur={handleAutoSave}
                  wrap="soft"
                  style={{
                    width: '100%',
                    minWidth: '100%',
                    height: `${windowLineHeights.reduce((a, b) => a + b, 0)}px`,
                    lineHeight: '24px',
                    fontSize: '14.8px',
                    fontFamily: 'monospace',
                    padding: '0 24px',
                    margin: 0,
                    border: 'none',
                    outline: 'none',
                    resize: 'none',
                    overflow: 'hidden',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-all',
                    boxSizing: 'border-box',
                    background: 'transparent',
                  }}
                  placeholder={`# ${filePath.split('/').pop()?.replace(/\.md$/, '').replace(/\.txt$/, '') || 'Untitled Note'}\n\nStart typing notes in Markdown... Use [[Links]] to connect notes!`}
                  className="border-none bg-background text-foreground font-mono text-[0.925rem] leading-[1.7] resize-none outline-none focus:ring-0 select-text flex-1"
                />
              </div>
            ) : (
              <textarea
                ref={textareaRef}
                value={content}
                onChange={handleTextareaChange}
                onKeyDown={handleTextareaKeyDown}
                onPaste={handleTextareaPaste}
                onBlur={handleAutoSave}
                onScroll={handleEditorScroll}
                placeholder={`# ${filePath.split('/').pop()?.replace(/\.md$/, '').replace(/\.txt$/, '') || 'Untitled Note'}\n\nStart typing notes in Markdown... Use [[Links]] to connect notes!`}
                className="w-full h-full border-none bg-background text-foreground font-mono text-[0.925rem] leading-[1.7] p-6 pb-32 resize-none outline-none focus:ring-0 select-text overflow-y-auto"
              />
            )}

            {/* Autocomplete suggestions overlay box */}
            {showSuggestions && (
              <>
                {/* Click-away backdrop overlay */}
                <div
                  className="fixed inset-0 z-30 bg-transparent cursor-default"
                  onClick={() => {
                    setShowSuggestions(false);
                    setSuggestionQuery('');
                    setSuggestionSearchQuery('');
                  }}
                />

                {/* Premium Glassmorphic Popover suggestions box */}
                <div
                  style={{
                    top: `${suggestionPosition.top}px`,
                    left: `${suggestionPosition.left}px`
                  }}
                  className="absolute w-[240px] bg-[#12131a]/95 backdrop-blur-xl border border-border rounded-xl shadow-2xl p-2.5 flex flex-col gap-1.5 z-40 animate-in fade-in zoom-in-95 duration-100 max-h-[300px] overflow-hidden select-none animate-fade-in"
                >
                  <div className="text-[0.6rem] font-bold text-muted-foreground/80 uppercase tracking-widest px-1 py-0.5 select-none flex justify-between items-center">
                    <span>Select Link Target</span>
                    <span className="text-[0.5rem] lowercase tracking-normal font-semibold font-sans text-muted-foreground/45">enter to link</span>
                  </div>
                  <div className="h-[1px] bg-border/60 my-0.5 select-none" />

                  <div className="relative flex items-center px-1 py-1 border-b border-border/40 pb-1.5 shrink-0">
                    <input
                      type="text"
                      value={suggestionSearchQuery}
                      onChange={(e) => {
                        setSuggestionSearchQuery(e.target.value);
                        setSuggestionIndex(0);
                      }}
                      onKeyDown={handleSearchInputKeyDown}
                      placeholder="Search notes/attachments..."
                      className="w-full bg-muted/30 border border-border/40 text-foreground px-2 py-1 rounded-md text-[0.7rem] focus:outline-none focus:border-primary/60 transition-all duration-150"
                      onClick={(e) => e.stopPropagation()}
                    />
                  </div>

                  <div className="flex-1 overflow-y-auto flex flex-col gap-0.5 pr-0.5 max-h-[160px]">
                    {filteredSuggestions.map((path, idx) => {
                      const isSelected = suggestionIndex === idx;
                      const name = path.split('/').pop()?.replace(/\.md$/, '') || '';
                      const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : null;
                      return (
                        <button
                          key={path}
                          type="button"
                          onClick={() => insertSuggestion(path)}
                          onMouseEnter={() => setSuggestionIndex(idx)}
                          className={cn(
                            "w-full text-left px-2 py-1.5 rounded-md text-[0.7rem] font-semibold transition-premium cursor-pointer flex items-center justify-between border border-transparent font-medium",
                            isSelected
                              ? "bg-gradient-to-r from-primary/15 to-accent/10 text-accent font-semibold border-primary/20"
                              : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                          )}
                        >
                          <span className="flex items-center gap-1.5 truncate">
                            {path.toLowerCase().endsWith('.png') ||
                              path.toLowerCase().endsWith('.jpg') ||
                              path.toLowerCase().endsWith('.jpeg') ||
                              path.toLowerCase().endsWith('.gif') ||
                              path.toLowerCase().endsWith('.webp') ||
                              path.toLowerCase().endsWith('.svg') ? (
                              <Image className="w-3.5 h-3.5 shrink-0 text-muted-foreground/60" />
                            ) : path.toLowerCase().endsWith('.pdf') ? (
                              <Paperclip className="w-3.5 h-3.5 shrink-0 text-muted-foreground/60" />
                            ) : (
                              <FileText className="w-3.5 h-3.5 shrink-0 text-muted-foreground/60" />
                            )}
                            <span className="truncate">{name}</span>
                          </span>
                          {dir && (
                            <span className="text-[0.55rem] font-semibold font-sans text-muted-foreground/45 shrink-0 select-none ml-2">
                              {dir}
                            </span>
                          )}
                        </button>
                      );
                    })}

                    {filteredSuggestions.length === 0 && (
                      <span className="text-[0.65rem] text-muted-foreground/50 italic p-2 text-center select-none">
                        No matching notes.
                      </span>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        </div>

        {/* Preview Pane */}
        <div
          className={cn(
            "flex-col min-w-0 bg-background transition-all duration-300",
            viewMode === 'edit' ? "hidden w-0 h-0" : "flex flex-1",
            viewMode === 'preview' ? "w-full h-full" : "w-full md:w-1/2 h-[55%] md:h-full"
          )}
        >
          <div className="h-10 bg-card/80 backdrop-blur-xl border-b border-border flex items-center justify-between px-4 shrink-0 text-muted-foreground text-[0.7rem] font-bold uppercase tracking-wider select-none">
            <span>Preview</span>
            <span className="text-[0.65rem] text-muted-foreground/60 tracking-normal font-semibold normal-case">
              DOMPurify Sanitized
            </span>
          </div>
          <div
            ref={previewScrollContainerRef}
            className="flex-1 p-6 pb-32 sm:p-8 sm:pb-32 overflow-y-auto bg-background"
            onClick={handlePreviewClick}
            onInput={handlePreviewInput}
            onBlur={handlePreviewBlur}
          >
            <div
              ref={previewContainerRef}
              className="markdown-preview"
            />
          </div>
        </div>
      </div>

      {/* Floating Panel Controls */}
      <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 sm:bottom-6 sm:right-6 flex items-center gap-1.5 z-50 bg-card/60 backdrop-blur-xl border border-border px-3 py-2 rounded-full shadow-2xl animate-fade-in select-none max-w-[calc(100%-2rem)] overflow-x-auto flex-nowrap no-scrollbar">
        <button
          onClick={() => {
            const input = document.createElement('input');
            input.type = 'file';
            input.onchange = async (e) => {
              const file = (e.target as HTMLInputElement).files?.[0];
              if (file) {
                setIsUploading(true);
                try {
                  const result = await onUploadAttachment(file);
                  if (result && result.name) {
                    const textarea = textareaRef.current;
                    if (textarea) {
                      const startPos = textarea.selectionStart;
                      const endPos = textarea.selectionEnd;
                      const textToInsert = `![[${result.name}]]`;
                      const newContent = content.substring(0, startPos) + textToInsert + content.substring(endPos);
                      setContent(newContent);
                      pushEditorState(newContent);

                      // Move cursor past the inserted link
                      setTimeout(() => {
                        textarea.focus();
                        const newCursorPos = startPos + textToInsert.length;
                        textarea.setSelectionRange(newCursorPos, newCursorPos);
                      }, 50);
                    }
                  }
                } catch (err) {
                  console.error("Failed to upload and link attachment:", err);
                } finally {
                  setIsUploading(false);
                }
              }
            };
            input.click();
          }}
          disabled={isUploading}
          className="w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer shrink-0 disabled:opacity-50 disabled:pointer-events-none"
          title="Upload & Insert Attachment"
        >
          {isUploading ? (
            <RefreshCw size={14.5} className="animate-spin text-emerald-500" />
          ) : (
            <Paperclip size={14.5} className="text-emerald-500" />
          )}
        </button>

        <div className="w-[1px] h-6 bg-border mx-1 shrink-0" />

        <button
          onClick={undo}
          disabled={historyIndex <= 0}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center transition-all shrink-0",
            historyIndex > 0
              ? "text-muted-foreground hover:bg-border/60 hover:text-foreground cursor-pointer"
              : "text-muted-foreground/30 pointer-events-none"
          )}
          title="Undo"
        >
          <Undo2 size={14.5} />
        </button>

        <button
          onClick={redo}
          disabled={historyIndex >= history.length - 1}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center transition-all shrink-0",
            historyIndex < history.length - 1
              ? "text-muted-foreground hover:bg-border/60 hover:text-foreground cursor-pointer"
              : "text-muted-foreground/30 pointer-events-none"
          )}
          title="Redo"
        >
          <Redo2 size={14.5} />
        </button>

        <div className="w-[1px] h-6 bg-border mx-1 shrink-0" />

        <button
          onClick={() => setViewMode('edit')}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer shrink-0",
            viewMode === 'edit' && "bg-primary/10 text-accent border border-primary/20"
          )}
          title="Editor Only"
        >
          <Edit2 size={14.5} />
        </button>
        <button
          onClick={() => setViewMode('preview')}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer shrink-0",
            viewMode === 'preview' && "bg-primary/10 text-accent border border-primary/20"
          )}
          title="Preview Only"
        >
          <Eye size={14.5} />
        </button>
        <button
          onClick={() => setViewMode('split')}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer hidden md:flex shrink-0",
            viewMode === 'split' && "bg-primary/10 text-accent border border-primary/20"
          )}
          title="Split View"
        >
          <Columns size={14.5} />
        </button>

        <div className="w-[1px] h-6 bg-border mx-1 shrink-0" />

        <button
          onClick={handleSave}
          disabled={saveStatus === 'saving'}
          title="Save Changes"
          className={cn(
            "flex items-center justify-center gap-1.5 h-8 w-8 md:w-auto px-0 md:px-4 rounded-full font-semibold text-xs transition-all duration-200 transform cursor-pointer shrink-0",
            hasUnsavedChanges
              ? "bg-gradient-to-r from-primary to-accent text-white shadow-md shadow-primary/20 hover:-translate-y-0.5"
              : "bg-muted border border-border text-foreground hover:bg-border/60"
          )}
        >
          {saveStatus === 'saving' ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Save className="w-3.5 h-3.5" />
          )}
          <span className="hidden md:inline">
            {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : 'Save'}
          </span>
        </button>
      </div>
    </div>
  );
};
export const Editor = React.memo(EditorComponent);
