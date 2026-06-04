import React, { useState, useEffect, useRef, useCallback } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { Eye, Edit2, Columns, Save, AlertCircle, RefreshCw, FileText, Paperclip, Undo2, Redo2, Image } from 'lucide-react';
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
  return rows
    .map(row =>
      row
        .map(cell => {
          const needsQuotes =
            cell.includes(delimiter) ||
            cell.includes('"') ||
            cell.includes('\n') ||
            cell.includes('\r');
          if (needsQuotes) {
            return `"${cell.replace(/"/g, '""')}"`;
          }
          return cell;
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

export const Editor: React.FC<EditorProps> = ({
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
  const [content, setContent] = useState(initialContent);
  const [sha, setSha] = useState(initialSha);
  const [savedContent, setSavedContent] = useState(initialContent);
  const [viewMode, setViewMode] = useState<'edit' | 'preview' | 'split'>(() => {
    return typeof window !== 'undefined' && window.innerWidth < 768 ? 'edit' : 'split';
  });
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [errorMessage, setErrorMessage] = useState('');
  const [isUploading, setIsUploading] = useState(false);

  // Custom renderer or post-processor for graphviewlinks [[Note Name]] and vault images
  const renderMarkdown = useCallback((text: string): string => {
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
          tableHtml += `<td class="p-2 text-center font-semibold text-muted-foreground border-r border-border bg-muted/30 select-none w-12">${rIdx + 1}</td>`;
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
      // B. Code/Configuration Files
      else if (ext !== '.md' && ext !== '.txt' && ext !== '.canvas' && isTextFile(filePath)) {
        const lang = ext.substring(1);
        html = `<pre class="bg-card/30 border border-border rounded-xl p-4 overflow-x-auto my-4 select-text font-mono text-[0.85rem] leading-[1.6]"><code class="language-${lang}">${text}</code></pre>`;
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
        html = marked.parse(processedText) as string;

        // 3. Resolve local vault image paths to base64 Data URLs, or custom iframe for PDFs / attachment cards
        html = html.replace(/<img src="([^"]+)"([^>]*)>/g, (_match, src, rest) => {
          const altMatch = rest.match(/alt="([^"]+)"/);
          const alt = altMatch ? altMatch[1] : '';

          const srcClean = src.trim();
          const extIndex = srcClean.lastIndexOf('.');
          const srcExt = extIndex !== -1 ? srcClean.substring(extIndex).toLowerCase() : '';
          const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];

          // Normalize relative path: strip leading "./" to resolve root files correctly
          const cleanSrc = srcClean.startsWith('./') ? srcClean.substring(2) : srcClean;

          if (imageExtensions.includes(srcExt) || srcClean.startsWith('data:image/')) {
            const cached = vaultImages[cleanSrc] || Object.entries(vaultImages).find(([k]) => k.endsWith(cleanSrc))?.[1];
            return `<img src="${cached || srcClean}"${rest}>`;
          } else if (srcExt === '.pdf') {
            const cached = vaultImages[cleanSrc] || Object.entries(vaultImages).find(([k]) => k.endsWith(cleanSrc))?.[1];
            const filename = cleanSrc.split('/').pop() || cleanSrc;
            const pdfUrl = cached || srcClean;
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
            // Render a custom embed card instead of image!
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

        // 3a. Resolve standard markdown links to binary/pdf files in <a> tags
        html = html.replace(/<a href="([^"]+)"([^>]*)>(.*?)<\/a>/g, (match, href, _rest, innerText) => {
          const hrefClean = href.trim();
          const extIndex = hrefClean.lastIndexOf('.');
          const hrefExt = extIndex !== -1 ? hrefClean.substring(extIndex).toLowerCase() : '';
          const cleanHref = hrefClean.startsWith('./') ? hrefClean.substring(2) : hrefClean;

          // If the link points to a binary/PDF file (i.e. not a text file)
          if (!isTextFile(cleanHref)) {
            const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
            if (imageExtensions.includes(hrefExt) || hrefClean.startsWith('data:image/')) {
              const cached = vaultImages[cleanHref] || Object.entries(vaultImages).find(([k]) => k.endsWith(cleanHref))?.[1];
              return `<img src="${cached || cleanHref}" alt="${innerText || cleanHref}" style="max-width: 100%; border-radius: 8px;" />`;
            } else if (hrefExt === '.pdf') {
              const cached = vaultImages[cleanHref] || Object.entries(vaultImages).find(([k]) => k.endsWith(cleanHref))?.[1];
              const filename = cleanHref.split('/').pop() || cleanHref;
              const pdfUrl = cached || hrefClean;
              return `
                <div class="pdf-embed-card border border-border bg-card/30 rounded-xl p-4 my-4 flex flex-col sm:flex-row items-center gap-4 max-w-xl mx-auto shadow-sm animate-fade-in" data-attachment="${cleanHref}">
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
                    <button class="download-attachment-btn w-8 h-8 rounded-full bg-border/40 hover:bg-border/80 flex items-center justify-center text-foreground transition-all cursor-pointer border border-transparent" data-path="${cleanHref}" title="Download PDF">
                      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-download"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                    </button>
                  </div>
                </div>
              `;
            } else {
              const filename = innerText || cleanHref.split('/').pop() || cleanHref;
              const displayExt = hrefExt ? hrefExt.substring(1).toUpperCase() : 'FILE';
              return `
                <div class="attachment-embed-card border border-border bg-muted/30 rounded-xl p-3 my-2 flex items-center gap-3 animate-fade-in" data-attachment="${cleanHref}">
                  <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-paperclip"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
                  </div>
                  <div class="flex-1 min-w-0">
                    <span class="text-xs font-bold text-foreground truncate block">${filename}</span>
                    <span class="text-[0.6rem] text-muted-foreground uppercase font-semibold block">${displayExt} Attachment</span>
                  </div>
                  <button class="download-attachment-btn w-8 h-8 rounded-full bg-border/40 hover:bg-border/80 flex items-center justify-center text-foreground transition-all cursor-pointer border border-transparent" data-path="${cleanHref}" title="Download attachment">
                    <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-download"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
                  </button>
                </div>
              `;
            }
          }
          return match;
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
      return DOMPurify.sanitize(html, {
        ADD_ATTR: ['data-note', 'data-attachment', 'data-path', 'title', 'contenteditable', 'data-row', 'data-col', 'src', 'type', 'class'],
        ADD_TAGS: ['embed', 'iframe', 'svg', 'line'],
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|ftp|tel|file|sms|blob|data):|[^&:/?#]*(?:[/?#]|$))/i
      });
    } catch {
      return `<p class="text-destructive font-medium">Error parsing content.</p>`;
    }
  }, [filePath, vaultImages]);

  // Undo / Redo history state stack
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const pushEditorState = useCallback((val: string) => {
    setHistory(prev => {
      const currentHistory = prev.slice(0, historyIndex + 1);
      if (currentHistory.length > 0 && currentHistory[currentHistory.length - 1] === val) {
        return prev;
      }
      const nextHistory = [...currentHistory, val];
      if (nextHistory.length > 50) nextHistory.shift();
      setHistoryIndex(nextHistory.length - 1);
      return nextHistory;
    });
  }, [historyIndex]);

  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const prevIndex = historyIndex - 1;
      const prevText = history[prevIndex];
      setHistoryIndex(prevIndex);
      setContent(prevText);
    }
  }, [history, historyIndex]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const nextIndex = historyIndex + 1;
      const nextText = history[nextIndex];
      setHistoryIndex(nextIndex);
      setContent(nextText);
    }
  }, [history, historyIndex]);

  // Seed initial content into history stack when note is loaded
  useEffect(() => {
    if (initialContent) {
      Promise.resolve().then(() => {
        setHistory([initialContent]);
        setHistoryIndex(0);
      });
    }
  }, [filePath, initialContent]);

  // Background Scraper scanning note text for local vault attachments (images and other files)
  useEffect(() => {
    const attachments: string[] = [];
    const obsRegex = /!?\[\[([^\]]+)\]\]/g;
    const mdRegex = /!?\[[^\]]*\]\(([^)]+)\)/g;
    let match;
    while ((match = obsRegex.exec(content)) !== null) {
      attachments.push(match[1].split('|')[0].trim());
    }
    while ((match = mdRegex.exec(content)) !== null) {
      attachments.push(match[1].trim());
    }

    attachments.forEach(attachmentName => {
      const matchedFile = files.find(f => f.name.toLowerCase() === attachmentName.toLowerCase() || f.path.toLowerCase().endsWith(attachmentName.toLowerCase()));
      if (matchedFile && !isTextFile(matchedFile.path) && matchedFile.sha && !vaultImages[matchedFile.path]) {
        onFetchBinaryFile(matchedFile.path, matchedFile.sha);
      }
    });
  }, [content, files, vaultImages, onFetchBinaryFile]);

  // Autocomplete suggestions states
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionQuery, setSuggestionQuery] = useState('');
  const [suggestionSearchQuery, setSuggestionSearchQuery] = useState('');
  const [suggestionPosition, setSuggestionPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [caretIndex, setCaretIndex] = useState(0);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const previewContainerRef = useRef<HTMLDivElement | null>(null);
  const isEditingFromPreviewRef = useRef(false);
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
    setContent(initialContent);
    setSha(initialSha);
    setSavedContent(initialContent);
    setSaveStatus('idle');
    setErrorMessage('');
  } else if (initialContent !== prevInitialContent) {
    setPrevInitialContent(initialContent);
    setSha(initialSha);
    // Only update active content if the change is external (does not match what we last saved/have in memory)
    if (initialContent !== savedContent) {
      setContent(initialContent);
      setSavedContent(initialContent);
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
    const relativeTop = marker.offsetTop - textarea.scrollTop + 22;
    const relativeLeft = Math.min(marker.offsetLeft, textarea.clientWidth - 250);

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

    const startText = content.substring(0, caretIndex);
    const endText = content.substring(textarea.selectionStart);

    const insertedLink = `[[${cleanNoteName}]]`;
    const newContent = startText + insertedLink + endText;

    setContent(newContent);
    pushEditorState(newContent);
    setShowSuggestions(false);
    setSuggestionSearchQuery('');

    // Re-focus and shift caret location past brackets
    setTimeout(() => {
      textarea.focus();
      const newPos = caretIndex + insertedLink.length;
      textarea.setSelectionRange(newPos, newPos);
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
    if (previewContainerRef.current) {
      if (isEditingFromPreviewRef.current) {
        isEditingFromPreviewRef.current = false;
        return;
      }
      previewContainerRef.current.innerHTML = renderMarkdown(content);
    }
  }, [content, filePath, viewMode, renderMarkdown]);

  // Unified save orchestration
  const performAutoSave = useCallback(async () => {
    const currentVal = contentRef.current;
    const currentSha = shaRef.current;
    const origVal = originalContent.current;

    if (currentVal === origVal) return;

    // Save cursor position before saving
    if (textareaRef.current) {
      saveEditorState(vaultId, filePath, {
        cursorPos: textareaRef.current.selectionStart,
        scrollPos: textareaRef.current.scrollTop,
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
    }
  }, [vaultId, filePath]);

  // Debounced auto-save effect for editor content while typing
  useEffect(() => {
    const timer = setTimeout(() => {
      performAutoSave();
      pushEditorState(contentRef.current);
    }, 3000); // 3 second debounce while typing

    return () => clearTimeout(timer);
  }, [content, performAutoSave, pushEditorState]);

  // Window defocus (click-away) & unmount listener
  useEffect(() => {
    const currentTextarea = textareaRef.current;

    const handleWindowBlur = () => {
      // Save cursor position on blur
      if (currentTextarea) {
        saveEditorState(vaultId, filePath, {
          cursorPos: currentTextarea.selectionStart,
          scrollPos: currentTextarea.scrollTop,
        });
      }
      performAutoSave();
      pushEditorState(contentRef.current);
    };

    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      if (currentTextarea) {
        saveEditorState(vaultId, filePath, {
          cursorPos: currentTextarea.selectionStart,
          scrollPos: currentTextarea.scrollTop,
        });
      }
      performAutoSave(); // Final save on unmount!
      pushEditorState(contentRef.current);
    };
  }, [vaultId, filePath, performAutoSave, pushEditorState]);

  useEffect(() => {
    // Restore cursor position after content is loaded
    const timer = setTimeout(() => {
      if (initialSearchLineIndex !== undefined && textareaRef.current) {
        const textarea = textareaRef.current;
        const lines = initialContent.split('\n');
        let charIndex = 0;
        for (let i = 0; i < Math.min(initialSearchLineIndex, lines.length); i++) {
          charIndex += lines[i].length + 1; // +1 for the newline character
        }
        
        textarea.setSelectionRange(charIndex, charIndex);
        textarea.focus();
        
        // Scroll to approximate line position
        const linePercentage = initialSearchLineIndex / Math.max(1, lines.length);
        const targetScroll = Math.max(0, textarea.scrollHeight * linePercentage - (textarea.clientHeight / 2));
        textarea.scrollTop = targetScroll;
        
        hasRestoredRef.current = true; // Mark as restored since we jump to search match
        if (onClearTargetLine) {
          onClearTargetLine();
        }
      } else if (!hasRestoredRef.current) {
        hasRestoredRef.current = true; // Mark as restored
        const savedState = restoreEditorState(vaultId, filePath);
        if (textareaRef.current && savedState.cursorPos !== undefined) {
          textareaRef.current.setSelectionRange(savedState.cursorPos, savedState.cursorPos);
          textareaRef.current.focus();
        }
        if (textareaRef.current && savedState.scrollPos !== undefined) {
          textareaRef.current.scrollTop = savedState.scrollPos;
        }
      }
    }, 0);
    return () => clearTimeout(timer);
  }, [filePath, vaultId, initialSearchLineIndex, onClearTargetLine, initialContent]);

  // Configure marked with custom options
  useEffect(() => {
    marked.setOptions({
      breaks: true,
      gfm: true,
    });
  }, []);



  const handleTextareaChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setContent(value);

    const selectionStart = e.target.selectionStart;
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
      const rows = parseCSV(content, delimiter);
      const maxCols = Math.max(...rows.map(r => r.length), 1);
      rows.push(Array(maxCols).fill(''));
      const newContent = stringifyCSV(rows, delimiter);
      setContent(newContent);
      pushEditorState(newContent);
      return;
    }

    const addColBtn = target.closest('.add-col-btn');
    if (addColBtn) {
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      const delimiter = ext === '.csv' ? ',' : '\t';
      const rows = parseCSV(content, delimiter);
      const updatedRows = rows.map(row => [...row, '']);
      const newContent = stringifyCSV(updatedRows, delimiter);
      setContent(newContent);
      pushEditorState(newContent);
      return;
    }

    const deleteRowBtn = target.closest('.delete-row-btn');
    if (deleteRowBtn) {
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      const delimiter = ext === '.csv' ? ',' : '\t';
      const rows = parseCSV(content, delimiter);
      if (rows.length > 1) {
        rows.pop();
        const newContent = stringifyCSV(rows, delimiter);
        setContent(newContent);
        pushEditorState(newContent);
      }
      return;
    }

    const deleteColBtn = target.closest('.delete-col-btn');
    if (deleteColBtn) {
      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      const delimiter = ext === '.csv' ? ',' : '\t';
      const rows = parseCSV(content, delimiter);
      const maxCols = Math.max(...rows.map(r => r.length), 1);
      if (maxCols > 1) {
        const updatedRows = rows.map(row => row.slice(0, -1));
        const newContent = stringifyCSV(updatedRows, delimiter);
        setContent(newContent);
        pushEditorState(newContent);
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

      const ext = filePath.substring(filePath.lastIndexOf('.')).toLowerCase();
      const delimiter = ext === '.csv' ? ',' : '\t';
      const rows = parseCSV(content, delimiter);

      // Make sure row/col exists in our array
      while (rows.length <= rowIdx) {
        rows.push([]);
      }
      const maxCols = Math.max(...rows.map(r => r.length), 1);
      rows.forEach(r => {
        while (r.length < maxCols) {
          r.push('');
        }
      });
      rows[rowIdx][colIdx] = newVal;

      const newContent = stringifyCSV(rows, delimiter);
      isEditingFromPreviewRef.current = true;
      setContent(newContent);
    }
  };

  const hasUnsavedChanges = content !== savedContent;

  return (
    <div className="flex flex-col md:flex-row w-full h-full bg-background relative select-none animate-fade-in">

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
          <div className="flex gap-2">
            {hasUnsavedChanges && (
              <span className="text-amber-500 flex items-center gap-1.5 normal-case font-semibold animate-pulse-soft">
                <span className="w-1.5 h-1.5 bg-amber-500 rounded-full shrink-0" />
                Unsaved Edits
              </span>
            )}
          </div>
        </div>

        <div className="flex-1 w-full h-[calc(100%-40px)] relative select-text">
          <textarea
            ref={textareaRef}
            value={content}
            onChange={handleTextareaChange}
            onKeyDown={handleTextareaKeyDown}
            onPaste={handleTextareaPaste}
            onBlur={handleAutoSave}
            placeholder={`# ${filePath.split('/').pop()?.replace(/\.md$/, '').replace(/\.txt$/, '') || 'Untitled Note'}\n\nStart typing notes in Markdown... Use [[Links]] to connect notes!`}
            className="w-full h-full border-none bg-background text-foreground font-mono text-[0.925rem] leading-[1.7] p-6 pb-32 resize-none outline-none focus:ring-0 select-text overflow-y-auto"
          />

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
          className="flex-1 p-6 pb-32 sm:p-8 sm:pb-32 overflow-y-auto bg-background"
          onClick={handlePreviewClick}
          onBlur={handlePreviewInput}
        >
          <div
            ref={previewContainerRef}
            className="markdown-preview"
          />
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

      {/* Error modal/alert banner */}
      {saveStatus === 'error' && (
        <div className="bg-card/75 backdrop-blur-xl border border-border rounded-xl p-5 shadow-2xl flex gap-3 max-w-[480px] absolute top-6 left-1/2 -translate-x-1/2 z-50 border-l-4 border-l-destructive animate-fade-in select-none">
          <AlertCircle className="w-5 h-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex flex-col gap-1.5 flex-1 min-w-0">
            <span className="fontWeight-700 text-sm text-foreground">Save Failed</span>
            <span className="text-xs text-muted-foreground leading-relaxed break-words">{errorMessage}</span>
            <div className="flex gap-2 mt-2">
              <button
                onClick={() => setSaveStatus('idle')}
                className="bg-muted hover:bg-border/60 border border-border text-foreground text-xs font-semibold px-3 py-1.5 rounded-xl cursor-pointer transition-all"
              >
                Dismiss
              </button>
              <button
                onClick={handleSave}
                className="bg-primary hover:bg-primary/90 text-white text-xs font-semibold px-3 py-1.5 rounded-xl cursor-pointer transition-all hover:shadow-md hover:shadow-primary/10"
              >
                Retry Save
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
