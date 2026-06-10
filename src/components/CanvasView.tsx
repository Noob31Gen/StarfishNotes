import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Minus, Trash2, FileText, Type, Save, RefreshCw, Link2, ChevronDown, Compass, Eye, Edit2, Undo2, Redo2, Image, Paperclip, Search } from 'lucide-react';
import { cn } from '../utils/cn';
import { safeParseJson } from '../utils/json';
import md from '../lib/markdownEngine';
import DOMPurify from 'dompurify';
import { isTextFile } from '../services/github';


export interface CanvasNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  type: 'text' | 'file';
  text?: string;
  file?: string;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  fromSide: 'top' | 'right' | 'bottom' | 'left';
  toNode: string;
  toSide: 'top' | 'right' | 'bottom' | 'left';
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface CanvasViewProps {
  filePath: string;
  initialContent: string;
  initialSha: string | null;
  files: { path: string; name: string; sha?: string }[];
  fileContents: Record<string, string>;
  onSave: (content: string, sha: string | null) => Promise<{ sha: string }>;
  onOpenNote: (path: string) => void;
  vaultId: string;
  onLoadFileContent: (path: string, sha: string) => Promise<void>;
  vaultImages: Record<string, string>;
  onFetchBinaryFile: (path: string, sha: string) => Promise<void>;
  onUploadAttachment?: (file: File) => Promise<{ path: string; name: string }>;
}

function generateEdgeId(): string {
  return `edge_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

export const CanvasView: React.FC<CanvasViewProps> = ({
  filePath: _filePath,
  initialContent,
  initialSha,
  files,
  fileContents,
  onSave,
  onOpenNote,
  vaultId,
  onLoadFileContent,
  vaultImages,
  onFetchBinaryFile,
  onUploadAttachment,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);

  const [zoom, setZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const [nodes, setNodes] = useState<CanvasNode[]>(() => {
    const parsed = safeParseJson<CanvasData>(initialContent, { nodes: [], edges: [] });
    return parsed.nodes || [];
  });
  const [edges, setEdges] = useState<CanvasEdge[]>(() => {
    const parsed = safeParseJson<CanvasData>(initialContent, { nodes: [], edges: [] });
    return parsed.edges || [];
  });
  const [sha, setSha] = useState<string | null>(initialSha);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [savedContent, setSavedContent] = useState<string>(initialContent);
  const [errorMessage, setErrorMessage] = useState('');

  // New Custom States: Switchers, Image Caching & History Stack
  const [editingNodeIds, setEditingNodeIds] = useState<Record<string, boolean>>({});
  const [history, setHistory] = useState<CanvasData[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  const [activeDragResizeState, setActiveDragResizeState] = useState<'idle' | 'dragging' | 'resizing'>('idle');
  const [isAddImageOpen, setIsAddImageOpen] = useState(false);
  const [isAddNoteOpen, setIsAddNoteOpen] = useState(false);
  const [mediaSearchQuery, setMediaSearchQuery] = useState('');
  const [isUploadingMedia, setIsUploadingMedia] = useState(false);

  // Popups coords for dynamic W3C positioning
  const [notePopupCoords, setNotePopupCoords] = useState<{ left: number; bottom: number } | null>(null);
  const [imagePopupCoords, setImagePopupCoords] = useState<{ left: number; bottom: number } | null>(null);
  const addNoteButtonRef = useRef<HTMLButtonElement | null>(null);
  const addImageButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (isAddNoteOpen && addNoteButtonRef.current) {
      const rect = addNoteButtonRef.current.getBoundingClientRect();
      const popupWidth = 240;
      const isMobile = window.innerWidth < 640;
      const left = isMobile 
        ? (window.innerWidth - popupWidth) / 2 
        : Math.max(8, Math.min(rect.left + rect.width / 2 - popupWidth / 2, window.innerWidth - popupWidth - 8));
      setNotePopupCoords({
        left,
        bottom: window.innerHeight - rect.top + 16,
      });
    } else {
      setNotePopupCoords(null);
    }
  }, [isAddNoteOpen]);

  useEffect(() => {
    if (isAddImageOpen && addImageButtonRef.current) {
      const rect = addImageButtonRef.current.getBoundingClientRect();
      const popupWidth = 250;
      const isMobile = window.innerWidth < 640;
      const left = isMobile 
        ? (window.innerWidth - popupWidth) / 2 
        : Math.max(8, Math.min(rect.left + rect.width / 2 - popupWidth / 2, window.innerWidth - popupWidth - 8));
      setImagePopupCoords({
        left,
        bottom: window.innerHeight - rect.top + 16,
      });
    } else {
      setImagePopupCoords(null);
    }
  }, [isAddImageOpen]);

  // Autocomplete states for canvas text cards
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [suggestionQuery, setSuggestionQuery] = useState('');
  const [suggestionIndex, setSuggestionIndex] = useState(0);
  const [caretIndex, setCaretIndex] = useState(0);

  const filteredSuggestions = files
    .filter(f => {
      const lowerPath = f.path.toLowerCase();
      if (lowerPath.includes('.obsidian/') || lowerPath.startsWith('.obsidian/')) return false;
      if (f.name === '.gitkeep' || f.name === '.vault-compat.json') return false;
      const allowed = ['.md', '.txt', '.canvas', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf'];
      return allowed.some(ext => lowerPath.endsWith(ext));
    })
    .map(f => f.path)
    .filter(path => path.toLowerCase().includes(suggestionQuery.toLowerCase()));

  const handleTextareaChange = (nodeId: string, value: string, target: HTMLTextAreaElement) => {
    handleTextChange(nodeId, value);

    const selectionStart = target.selectionStart;
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
        return;
      }
    }

    setShowSuggestions(false);
  };

  const handleTextareaKeyDown = (nodeId: string, e: React.KeyboardEvent<HTMLTextAreaElement>, target: HTMLTextAreaElement) => {
    if (showSuggestions && filteredSuggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSuggestionIndex(prev => (prev + 1) % filteredSuggestions.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSuggestionIndex(prev => (prev - 1 + filteredSuggestions.length) % filteredSuggestions.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        insertSuggestion(nodeId, filteredSuggestions[suggestionIndex], target.value, target);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        setShowSuggestions(false);
      }
    }
  };

  const insertSuggestion = (nodeId: string, path: string, currentText: string, target: HTMLTextAreaElement) => {
    const cleanNoteName = path.split('/').pop()?.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '') || path;
    const startText = currentText.substring(0, caretIndex);
    const endText = currentText.substring(target.selectionStart);

    const insertedLink = `[[${cleanNoteName}]]`;
    const newContent = startText + insertedLink + endText;

    handleTextChange(nodeId, newContent);
    setShowSuggestions(false);

    // Re-focus and shift caret location past brackets
    setTimeout(() => {
      target.focus();
      const newPos = caretIndex + insertedLink.length;
      target.setSelectionRange(newPos, newPos);
    }, 50);
  };

  const pushState = useCallback((nextNodes: CanvasNode[], nextEdges: CanvasEdge[]) => {
    const newState = {
      nodes: JSON.parse(JSON.stringify(nextNodes)),
      edges: JSON.parse(JSON.stringify(nextEdges))
    };

    setHistory(prev => {
      const currentHistory = prev.slice(0, historyIndex + 1);
      if (currentHistory.length > 0) {
        const last = currentHistory[currentHistory.length - 1];
        if (JSON.stringify(last) === JSON.stringify(newState)) {
          return prev;
        }
      }
      const nextHistory = [...currentHistory, newState];
      if (nextHistory.length > 50) nextHistory.shift();
      setHistoryIndex(nextHistory.length - 1);
      return nextHistory;
    });
  }, [historyIndex]);

  const undo = useCallback(() => {
    if (historyIndex > 0) {
      const prevIndex = historyIndex - 1;
      const prevState = history[prevIndex];
      setHistoryIndex(prevIndex);
      setNodes(JSON.parse(JSON.stringify(prevState.nodes)));
      setEdges(JSON.parse(JSON.stringify(prevState.edges)));
    }
  }, [history, historyIndex]);

  const redo = useCallback(() => {
    if (historyIndex < history.length - 1) {
      const nextIndex = historyIndex + 1;
      const nextState = history[nextIndex];
      setHistoryIndex(nextIndex);
      setNodes(JSON.parse(JSON.stringify(nextState.nodes)));
      setEdges(JSON.parse(JSON.stringify(nextState.edges)));
    }
  }, [history, historyIndex]);

  // Seed initial history stack item
  useEffect(() => {
    if (nodes.length > 0 || edges.length > 0) {
      if (history.length === 0) {
        const state = {
          nodes: JSON.parse(JSON.stringify(nodes)),
          edges: JSON.parse(JSON.stringify(edges))
        };
        // Defer to avoid cascading renders warning
        Promise.resolve().then(() => {
          setHistory([state]);
          setHistoryIndex(0);
        });
      }
    }
  }, [initialContent, history.length, nodes, edges]);

  // Silent Background Preloader effect for Canvas Note files & binary attachments
  useEffect(() => {
    nodes.forEach(node => {
      if (node.type === 'file' && node.file) {
        const isBinary = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf'].some(ext => node.file!.toLowerCase().endsWith(ext));
        if (isBinary) {
          if (!vaultImages[node.file]) {
            const matchingFile = files.find(f => f.path === node.file);
            if (matchingFile && matchingFile.sha) {
              onFetchBinaryFile(node.file, matchingFile.sha);
            }
          }
        } else {
          if (fileContents[node.file] === undefined) {
            const matchingFile = files.find(f => f.path === node.file);
            if (matchingFile && matchingFile.sha) {
              onLoadFileContent(node.file, matchingFile.sha);
            }
          }
        }
      }
    });
  }, [nodes, files, fileContents, vaultImages, onLoadFileContent, onFetchBinaryFile]);

  // Scan note previews and text nodes for attachments to fetch in the background (images and other files)
  useEffect(() => {
    nodes.forEach(node => {
      let text = '';
      if (node.type === 'file' && node.file && fileContents[node.file]) {
        text = fileContents[node.file];
      } else if (node.type === 'text' && node.text) {
        text = node.text;
      }

      if (!text) return;

      const attachments: string[] = [];
      const obsRegex = /!?\[\[([^\]]+)\]\]/g;
      const mdRegex = /!?\[[^\]]*\]\(([^)]+)\)/g;
      let match;
      while ((match = obsRegex.exec(text)) !== null) {
        attachments.push(match[1].trim());
      }
      while ((match = mdRegex.exec(text)) !== null) {
        attachments.push(match[1].trim());
      }

      attachments.forEach(attachmentName => {
        const matchedFile = files.find(f => f.name.toLowerCase() === attachmentName.toLowerCase() || f.path.toLowerCase().endsWith(attachmentName.toLowerCase()));
        if (matchedFile && !isTextFile(matchedFile.path) && matchedFile.sha && !vaultImages[matchedFile.path]) {
          onFetchBinaryFile(matchedFile.path, matchedFile.sha);
        }
      });
    });
  }, [nodes, fileContents, files, vaultImages, onFetchBinaryFile]);

  const renderCanvasMarkdown = useCallback((text: string): string => {
    try {
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
      let html = md.render(processedText);

      // 3. Resolve local vault image paths to base64 Data URLs, or custom iframe for PDFs / attachment cards
      html = html.replace(/<img src="([^"]+)"([^>]*)>/g, (_match, src, rest) => {
        const altMatch = rest.match(/alt="([^"]+)"/);
        const alt = altMatch ? altMatch[1] : '';

        const srcClean = src.trim();
        const extIndex = srcClean.lastIndexOf('.');
        const ext = extIndex !== -1 ? srcClean.substring(extIndex).toLowerCase() : '';
        const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];

        // Normalize relative path: strip leading "./" to resolve root files correctly
        const cleanSrc = srcClean.startsWith('./') ? srcClean.substring(2) : srcClean;

        if (imageExtensions.includes(ext) || srcClean.startsWith('data:image/')) {
          const cached = vaultImages[cleanSrc] || Object.entries(vaultImages).find(([k]) => k.endsWith(cleanSrc))?.[1];
          return `<img src="${cached || cleanSrc}"${rest}>`;
        } else if (ext === '.pdf') {
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
          // Render a custom embed card instead of image!
          const filename = alt || srcClean.split('/').pop() || srcClean;
          const displayExt = ext ? ext.substring(1).toUpperCase() : 'FILE';
          return `
            <div class="attachment-embed-card border border-border bg-muted/30 rounded-xl p-3 my-2 flex items-center gap-3 animate-fade-in" data-attachment="${cleanSrc}">
              <div class="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary shrink-0">
                <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-paperclip"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>
              </div>
              <div class="flex-1 min-w-0">
                <span class="text-xs font-bold text-foreground truncate block">${filename}</span>
                <span class="text-[0.6rem] text-muted-foreground uppercase font-semibold block">${displayExt} Attachment</span>
              </div>
              <button class="download-attachment-btn w-8 h-8 rounded-full bg-border/40 hover:bg-border/80 flex items-center justify-center text-foreground transition-all cursor-pointer border border-transparent" data-path="${cleanSrc}" title="Download attachment">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-download"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" x2="12" y1="15" y2="3"/></svg>
              </button>
            </div>
          `;
        }
      });

      // 3b. Resolve standard markdown links to binary/pdf files in <a> tags
      html = html.replace(/<a href="([^"]+)"([^>]*)>(.*?)<\/a>/g, (match, href, _rest, innerText) => {
        const hrefClean = href.trim();
        const extIndex = hrefClean.lastIndexOf('.');
        const hrefExt = extIndex !== -1 ? hrefClean.substring(extIndex).toLowerCase() : '';
        const cleanHref = hrefClean.startsWith('./') ? hrefClean.substring(2) : hrefClean;

        const isBinaryExt = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico', '.pdf'].includes(hrefExt) || !isTextFile(cleanHref);
        if (isBinaryExt) {
          const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];
          if (imageExtensions.includes(hrefExt) || hrefClean.startsWith('data:image/')) {
            const cached = vaultImages[cleanHref] || Object.entries(vaultImages).find(([k]) => k.endsWith(cleanHref))?.[1];
            return `<img src="${cached || cleanHref}" alt="${innerText || cleanHref}" style="max-width: 100%; border-radius: 8px;" />`;
          } else if (hrefExt === '.pdf') {
            const cached = vaultImages[cleanHref] || Object.entries(vaultImages).find(([k]) => k.endsWith(cleanHref))?.[1];
            const filename = cleanHref.split('/').pop() || cleanHref;
            const pdfUrl = cached || cleanHref;
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

      // 4. Resolve Graphview links: [[Note Name]]
      const graphviewLinkRegex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
      html = html.replace(graphviewLinkRegex, (_, target, label) => {
        const targetClean = target.trim();
        const displayLabel = label ? label.trim() : targetClean;
        return `<a class="graphview-link" data-note="${targetClean}" title="Open note: ${targetClean}">${displayLabel}</a>`;
      });

      return DOMPurify.sanitize(html, {
        USE_PROFILES: { html: true, mathMl: true, svg: true },
        ADD_ATTR: ['data-note', 'data-attachment', 'data-path', 'title', 'src', 'type', 'class', 'target', 'rel', 'width', 'height', 'border', 'sandbox'],
        ADD_TAGS: ['iframe', 'svg', 'line'],
        ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|ftp|tel|file|sms|blob|data):|[^&:/?#]*(?:[/?#]|$))/i
      });
    } catch {
      return `<span class="text-destructive font-medium">Error parsing Markdown.</span>`;
    }
  }, [vaultImages]);

  const handlePreviewClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const graphviewLink = target.closest('.graphview-link');
    if (graphviewLink) {
      const noteName = graphviewLink.getAttribute('data-note');
      if (noteName) {
        const fullFileName = noteName.endsWith('.md') ? noteName : `${noteName}.md`;
        const matched = files.find(f => f.name.toLowerCase() === fullFileName.toLowerCase() || f.path.toLowerCase().endsWith(fullFileName.toLowerCase()));
        if (matched) {
          onOpenNote(matched.path);
        } else {
          onOpenNote(fullFileName);
        }
      }
      return;
    }

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
        }
      }
    }
  };

  const dragNodeId = useRef<string | null>(null);
  const dragResizeNodeId = useRef<string | null>(null);
  const resizeStartCoords = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const resizeStartDims = useRef<{ width: number; height: number }>({ width: 0, height: 0 });

  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const shaRef = useRef(sha);
  const initialContentRef = useRef(initialContent);
  const onSaveRef = useRef(onSave);
  const isMounted = useRef(true);
  const isSavingRef = useRef(false);

  // Render-phase prop synchronization
  const [prevProps, setPrevProps] = useState({ initialContent, initialSha });
  if (initialContent !== prevProps.initialContent || initialSha !== prevProps.initialSha) {
    setPrevProps({ initialContent, initialSha });
    setSha(initialSha);
    if (initialContent !== savedContent) {
      setSavedContent(initialContent);
      try {
        if (initialContent.trim()) {
          const parsed = safeParseJson<CanvasData>(initialContent, { nodes: [], edges: [] });
          const incomingNodes = parsed.nodes || [];
          const incomingEdges = parsed.edges || [];
          const nodesChanged = JSON.stringify(incomingNodes) !== JSON.stringify(nodes);
          const edgesChanged = JSON.stringify(incomingEdges) !== JSON.stringify(edges);

          if (nodesChanged) setNodes(incomingNodes);
          if (edgesChanged) setEdges(incomingEdges);

          setSaveStatus('idle');
          setSelectedNodeId(null);
        } else {
          if (nodes.length > 0 || edges.length > 0) {
            setNodes([]);
            setEdges([]);
          }
        }
      } catch {
        if (nodes.length > 0 || edges.length > 0) {
          setNodes([]);
          setEdges([]);
        }
      }
    }
  }
  const dragStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const isTouchPanning = useRef(false);
  const touchStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const touchDragNodeId = useRef<string | null>(null);
  const isTouchRef = useRef(false);

  const initialPinchDistance = useRef<number | null>(null);
  const initialPinchZoom = useRef<number>(1);

  const connectionStartClient = useRef<{ x: number; y: number } | null>(null);
  const isTouchConnecting = useRef(false);
  const touchConnectStart = useRef<{ x: number; y: number }>({ x: 0, y: 0 });

  const [activeConnection, setActiveConnection] = useState<{
    fromNode: string;
    fromSide: 'top' | 'right' | 'bottom' | 'left';
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
  } | null>(null);



  const [activeLinkSelectorCardId, setActiveLinkSelectorCardId] = useState<string | null>(null);
  const [noteSearchQuery, setNoteSearchQuery] = useState('');

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  useEffect(() => {
    shaRef.current = sha;
  }, [sha]);

  useEffect(() => {
    initialContentRef.current = initialContent;
  }, [initialContent]);

  useEffect(() => {
    onSaveRef.current = onSave;
  }, [onSave]);

  const performAutoSave = useCallback(async () => {
    // Prevent concurrent saves
    if (isSavingRef.current) return;

    const currentNodes = nodesRef.current;
    const currentEdges = edgesRef.current;
    const currentSha = shaRef.current;
    const origVal = initialContentRef.current;

    const canvasData: CanvasData = { nodes: currentNodes, edges: currentEdges };
    const serialized = JSON.stringify(canvasData, null, 2);

    if (serialized === origVal) return;

    // Safety guard: If original content had items, but our current state is completely empty,
    // do not overwrite the file to prevent accidental deletion due to initialization delays or race conditions.
    try {
      if (origVal && origVal.trim()) {
        const parsedOrig = safeParseJson<CanvasData>(origVal, { nodes: [], edges: [] });
        const origNodesCount = parsedOrig.nodes?.length || 0;
        const origEdgesCount = parsedOrig.edges?.length || 0;
        if ((origNodesCount > 0 || origEdgesCount > 0) && currentNodes.length === 0 && currentEdges.length === 0) {
          console.warn("Auto-save blocked: Attempted to overwrite populated canvas with empty state.");
          return;
        }
      }
    } catch {
      // Ignore parse errors of original content
    }

    isSavingRef.current = true;
    if (isMounted.current) {
      setSaveStatus('saving');
    }

    try {
      const result = await onSaveRef.current(serialized, currentSha);
      if (isMounted.current) {
        setSha(result.sha);
        shaRef.current = result.sha;
        initialContentRef.current = serialized;
        setSavedContent(serialized);
        setSaveStatus('saved');
        setTimeout(() => {
          if (isMounted.current) setSaveStatus('idle');
        }, 3000);
      }
    } catch {
      if (isMounted.current) {
        setSaveStatus('error');
        setTimeout(() => {
          if (isMounted.current) setSaveStatus('idle');
        }, 4000);
      }
    } finally {
      isSavingRef.current = false;
    }
  }, []);

  const zoomRef = useRef(zoom);
  const panXRef = useRef(panX);
  const panYRef = useRef(panY);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    panXRef.current = panX;
  }, [panX]);

  useEffect(() => {
    panYRef.current = panY;
  }, [panY]);

  // Global window listeners for drag & resize to prevent event interception by iframe/pdf embeds
  useEffect(() => {
    if (activeDragResizeState === 'idle') return;

    const handleGlobalMove = (clientX: number, clientY: number) => {
      // 1. Handle Node Dragging
      if (dragNodeId.current || touchDragNodeId.current) {
        const activeId = dragNodeId.current || touchDragNodeId.current;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        const x = (clientX - rect.left - panXRef.current) / zoomRef.current;
        const y = (clientY - rect.top - panYRef.current) / zoomRef.current;

        const dx = x - dragStart.current.x;
        const dy = y - dragStart.current.y;

        setNodes(prev => prev.map(node => {
          if (node.id === activeId) {
            return {
              ...node,
              x: Math.round(node.x + dx),
              y: Math.round(node.y + dy),
            };
          }
          return node;
        }));
        dragStart.current = { x, y };
      }

      // 2. Handle Node Resizing
      if (dragResizeNodeId.current) {
        const dx = (clientX - resizeStartCoords.current.x) / zoomRef.current;
        const dy = (clientY - resizeStartCoords.current.y) / zoomRef.current;

        setNodes(prev => prev.map(node => {
          if (node.id === dragResizeNodeId.current) {
            return {
              ...node,
              width: Math.max(160, Math.round(resizeStartDims.current.width + dx)),
              height: Math.max(100, Math.round(resizeStartDims.current.height + dy)),
            };
          }
          return node;
        }));
      }
    };

    const handleMouseMove = (e: MouseEvent) => {
      handleGlobalMove(e.clientX, e.clientY);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      handleGlobalMove(e.touches[0].clientX, e.touches[0].clientY);
    };

    const handleGlobalUp = () => {
      if (dragNodeId.current || touchDragNodeId.current) {
        pushState(nodesRef.current, edgesRef.current);
      }
      if (dragResizeNodeId.current) {
        pushState(nodesRef.current, edgesRef.current);
        performAutoSave();
      }

      dragNodeId.current = null;
      touchDragNodeId.current = null;
      dragResizeNodeId.current = null;
      setActiveDragResizeState('idle');
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('mouseup', handleGlobalUp);
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    window.addEventListener('touchend', handleGlobalUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleGlobalUp);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleGlobalUp);
    };
  }, [activeDragResizeState, pushState, performAutoSave]);

  useEffect(() => {
    isMounted.current = true;
    return () => {
      isMounted.current = false;
    };
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      performAutoSave();
    }, 2000);

    return () => clearTimeout(timer);
  }, [nodes, edges, performAutoSave]);

  useEffect(() => {
    const handleWindowBlur = () => {
      performAutoSave();
    };

    window.addEventListener('blur', handleWindowBlur);
    return () => {
      window.removeEventListener('blur', handleWindowBlur);
      performAutoSave();
    };
  }, [vaultId, _filePath, performAutoSave]);

  // Prop synchronization migrated to render-phase block to prevent cascading render warnings

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleWheelEvent = (e: WheelEvent) => {
      const target = e.target as HTMLElement;
      // Allow scrolling naturally inside text areas or scrollable canvas card panels
      if (
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'INPUT' ||
        target.closest('.overflow-y-auto') ||
        target.closest('.overflow-auto')
      ) {
        return;
      }

      e.preventDefault();
      const zoomFactor = 1.06;

      const rect = container.getBoundingClientRect();
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const currentZoom = zoomRef.current;
      const currentPanX = panXRef.current;
      const currentPanY = panYRef.current;

      const worldX = (mouseX - currentPanX) / currentZoom;
      const worldY = (mouseY - currentPanY) / currentZoom;

      let newZoom = e.deltaY < 0 ? currentZoom * zoomFactor : currentZoom / zoomFactor;
      newZoom = Math.max(0.2, Math.min(newZoom, 1.8));

      const nextPanX = mouseX - worldX * newZoom;
      const nextPanY = mouseY - worldY * newZoom;

      zoomRef.current = newZoom;
      panXRef.current = nextPanX;
      panYRef.current = nextPanY;

      setZoom(newZoom);
      setPanX(nextPanX);
      setPanY(nextPanY);
    };

    container.addEventListener('wheel', handleWheelEvent, { passive: false });
    return () => {
      container.removeEventListener('wheel', handleWheelEvent);
    };
  }, []);

  // Global keydown handler to delete selected nodes or connections & trigger Undo/Redo
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return;
      }

      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedNodeId) {
          e.preventDefault();
          const nextNodes = nodesRef.current.filter(n => n.id !== selectedNodeId);
          const nextEdges = edgesRef.current.filter(e => e.fromNode !== selectedNodeId && e.toNode !== selectedNodeId);
          setNodes(nextNodes);
          setEdges(nextEdges);
          setSelectedNodeId(null);
          pushState(nextNodes, nextEdges);
        } else if (selectedEdgeId) {
          e.preventDefault();
          const nextEdges = edgesRef.current.filter(e => e.id !== selectedEdgeId);
          setEdges(nextEdges);
          setSelectedEdgeId(null);
          pushState(nodesRef.current, nextEdges);
        }
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
      } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [selectedNodeId, selectedEdgeId, undo, redo, pushState]);

  const getCanvasCoords = useCallback((clientX: number, clientY: number) => {
    if (!containerRef.current) return { x: 0, y: 0 };
    const rect = containerRef.current.getBoundingClientRect();
    const x = (clientX - rect.left - panXRef.current) / zoomRef.current;
    const y = (clientY - rect.top - panYRef.current) / zoomRef.current;
    return { x, y };
  }, []);

  const handleCanvasPaste = async (e: React.ClipboardEvent) => {
    const activeEl = document.activeElement;
    if (activeEl && (activeEl.tagName === 'TEXTAREA' || activeEl.tagName === 'INPUT' || activeEl.hasAttribute('contenteditable'))) {
      return;
    }

    const items = e.clipboardData?.items;
    if (!items || !onUploadAttachment) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) {
          e.preventDefault();
          setIsUploadingMedia(true);
          try {
            const result = await onUploadAttachment(file);
            if (result && result.path) {
              const centerWorld = getCanvasCoords(
                (containerRef.current?.clientWidth || 800) / 2,
                (containerRef.current?.clientHeight || 600) / 2
              );

              let finalX = Math.round(centerWorld.x - 160);
              let finalY = Math.round(centerWorld.y - 130);
              const offsetStep = 30;
              while (nodesRef.current.some(n => n.x === finalX && n.y === finalY)) {
                finalX += offsetStep;
                finalY += offsetStep;
              }

              const newNode: CanvasNode = {
                id: `card_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
                x: finalX,
                y: finalY,
                width: 320,
                height: 260,
                type: 'file',
                file: result.path
              };

              setNodes(prev => {
                const nextNodes = [...prev, newNode];
                pushState(nextNodes, edgesRef.current);
                return nextNodes;
              });
              setSelectedNodeId(newNode.id);
              performAutoSave();
            }
          } catch (err) {
            console.error("Failed to upload and add pasted image to canvas:", err);
          } finally {
            setIsUploadingMedia(false);
          }
        }
      }
    }
  };

  const zoomCentered = (zoomIn: boolean) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const centerX = rect.width / 2;
    const centerY = rect.height / 2;

    const currentZoom = zoomRef.current;
    const currentPanX = panXRef.current;
    const currentPanY = panYRef.current;

    const worldX = (centerX - currentPanX) / currentZoom;
    const worldY = (centerY - currentPanY) / currentZoom;

    const zoomFactor = 1.08;
    let newZoom = zoomIn ? currentZoom * zoomFactor : currentZoom / zoomFactor;
    newZoom = Math.max(0.2, Math.min(newZoom, 1.8));

    const nextPanX = centerX - worldX * newZoom;
    const nextPanY = centerY - worldY * newZoom;

    zoomRef.current = newZoom;
    panXRef.current = nextPanX;
    panYRef.current = nextPanY;

    setZoom(newZoom);
    setPanX(nextPanX);
    setPanY(nextPanY);
  };

  // Global mousemove/touchmove and mouseup/touchend listeners to ensure the active connection tip follows the cursor perfectly
  useEffect(() => {
    if (!activeConnection) return;

    const handleGlobalMove = (clientX: number, clientY: number) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = clientX - rect.left;
      const y = clientY - rect.top;
      setActiveConnection(prev => prev ? {
        ...prev,
        currentX: x,
        currentY: y,
      } : null);
    };

    const handleMouseMove = (e: MouseEvent) => {
      handleGlobalMove(e.clientX, e.clientY);
    };

    const handleTouchMove = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      handleGlobalMove(e.touches[0].clientX, e.touches[0].clientY);
    };

    const handleGlobalUp = (e: MouseEvent | TouchEvent) => {
      setIsPanning(false);
      dragNodeId.current = null;

      let clientX = 0;
      let clientY = 0;
      if (e instanceof MouseEvent) {
        clientX = e.clientX;
        clientY = e.clientY;
      } else if (e instanceof TouchEvent) {
        if (e.changedTouches.length > 0) {
          clientX = e.changedTouches[0].clientX;
          clientY = e.changedTouches[0].clientY;
        }
      }

      let hasDragged = false;
      if (connectionStartClient.current) {
        const dx = clientX - connectionStartClient.current.x;
        const dy = clientY - connectionStartClient.current.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 6) {
          hasDragged = true;
        }
      } else {
        hasDragged = true;
      }

      if (hasDragged) {
        // Robust drag-to-connect detection via elementFromPoint
        const element = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
        const targetHandle = element?.closest('.canvas-card-handle') as HTMLElement | null;

        if (targetHandle) {
          const toNodeId = targetHandle.getAttribute('data-node-id');
          const toSide = targetHandle.getAttribute('data-side') as 'top' | 'right' | 'bottom' | 'left' | null;

          if (toNodeId && toSide && activeConnection.fromNode !== toNodeId) {
            const newEdge: CanvasEdge = {
              id: generateEdgeId(),
              fromNode: activeConnection.fromNode,
              fromSide: activeConnection.fromSide,
              toNode: toNodeId,
              toSide: toSide,
            };

            setEdges(prev => {
              const exists = prev.some(
                edge => edge.fromNode === newEdge.fromNode && edge.toNode === newEdge.toNode
              );
              const nextEdges = exists ? prev : [...prev, newEdge];
              if (!exists) {
                pushState(nodesRef.current, nextEdges);
              }
              return nextEdges;
            });
          }
        }
        setActiveConnection(null);
        connectionStartClient.current = null;
      }
    };

    window.addEventListener('mousemove', handleMouseMove, { passive: true });
    window.addEventListener('mouseup', handleGlobalUp);
    window.addEventListener('touchmove', handleTouchMove, { passive: true });
    window.addEventListener('touchend', handleGlobalUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleGlobalUp);
      window.removeEventListener('touchmove', handleTouchMove);
      window.removeEventListener('touchend', handleGlobalUp);
    };
  }, [activeConnection, getCanvasCoords, pushState]);

  const handleMouseDown = (e: React.MouseEvent) => {
    // Ignore mouse events when in touch mode (prevent synthetic mouse events from interfering)
    if (isTouchRef.current) return;

    const target = e.target as HTMLElement;
    // Allow panning if clicking on background container, viewport grid, or utilizing middle mouse click
    if (
      target === containerRef.current ||
      target.classList.contains('canvas-viewport') ||
      target.classList.contains('canvas-grid') ||
      e.button === 1
    ) {
      if (activeConnection) {
        setActiveConnection(null);
      }
      setIsPanning(true);
      panStart.current = { x: e.clientX - panX, y: e.clientY - panY };
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
      e.preventDefault();
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    // Ignore mouse events when in touch mode (prevent synthetic mouse events from interfering)
    if (isTouchRef.current) return;

    if (isPanning) {
      setPanX(e.clientX - panStart.current.x);
      setPanY(e.clientY - panStart.current.y);
      return;
    }

    if (activeConnection) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      setActiveConnection(prev => prev ? {
        ...prev,
        currentX: x,
        currentY: y,
      } : null);
    }
  };

  const handleMouseUp = (e: React.MouseEvent) => {
    // Ignore mouse events when in touch mode (prevent synthetic mouse events from interfering)
    if (isTouchRef.current) return;

    setIsPanning(false);

    if (activeConnection) {
      let hasDragged = false;
      if (connectionStartClient.current) {
        const dx = e.clientX - connectionStartClient.current.x;
        const dy = e.clientY - connectionStartClient.current.y;
        const dist = Math.hypot(dx, dy);
        if (dist > 6) {
          hasDragged = true;
        }
      } else {
        hasDragged = true;
      }

      if (hasDragged) {
        // Robust drag-to-connect detection via elementFromPoint
        const element = document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null;
        const targetHandle = element?.closest('.canvas-card-handle') as HTMLElement | null;

        if (targetHandle) {
          const toNodeId = targetHandle.getAttribute('data-node-id');
          const toSide = targetHandle.getAttribute('data-side') as 'top' | 'right' | 'bottom' | 'left' | null;

          if (toNodeId && toSide && activeConnection.fromNode !== toNodeId) {
            const newEdge: CanvasEdge = {
              id: `edge_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
              fromNode: activeConnection.fromNode,
              fromSide: activeConnection.fromSide,
              toNode: toNodeId,
              toSide: toSide,
            };

            setEdges(prev => {
              const exists = prev.some(
                edge => edge.fromNode === newEdge.fromNode && edge.toNode === newEdge.toNode
              );
              return exists ? prev : [...prev, newEdge];
            });
          }
        }
        setActiveConnection(null);
        connectionStartClient.current = null;
      }
    }
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    isTouchRef.current = true;
    if (e.touches.length === 2) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      initialPinchDistance.current = Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);
      initialPinchZoom.current = zoom;
      return;
    }

    if (e.touches.length !== 1) return;
    const touch = e.touches[0];
    const target = e.target as HTMLElement;

    if (
      target === containerRef.current ||
      target.classList.contains('canvas-viewport') ||
      target.classList.contains('canvas-grid')
    ) {
      if (activeConnection) {
        setActiveConnection(null);
      }
      isTouchPanning.current = true;
      touchStart.current = { x: touch.clientX - panX, y: touch.clientY - panY };
      setSelectedNodeId(null);
      setSelectedEdgeId(null);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && initialPinchDistance.current !== null) {
      const touch1 = e.touches[0];
      const touch2 = e.touches[1];
      const dist = Math.hypot(touch1.clientX - touch2.clientX, touch1.clientY - touch2.clientY);
      const scale = dist / initialPinchDistance.current;
      const newZoom = initialPinchZoom.current * scale;
      setZoom(Math.max(0.2, Math.min(newZoom, 1.8)));
      return;
    }

    if (e.touches.length !== 1) return;
    const touch = e.touches[0];

    if (isTouchConnecting.current && activeConnection) {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const x = touch.clientX - rect.left;
      const y = touch.clientY - rect.top;
      setActiveConnection(prev => prev ? {
        ...prev,
        currentX: x,
        currentY: y,
      } : null);
      return;
    }

    if (isTouchPanning.current) {
      setPanX(touch.clientX - touchStart.current.x);
      setPanY(touch.clientY - touchStart.current.y);
      return;
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    initialPinchDistance.current = null;
    isTouchPanning.current = false;

    // Reset touch flag after a short delay to allow synthetic mouse events to be ignored
    setTimeout(() => {
      isTouchRef.current = false;
    }, 50);

    if (isTouchConnecting.current && activeConnection) {
      isTouchConnecting.current = false;
      const touch = e.changedTouches[0];
      if (touch) {
        const dx = touch.clientX - touchConnectStart.current.x;
        const dy = touch.clientY - touchConnectStart.current.y;
        const dist = Math.hypot(dx, dy);

        if (dist > 10) {
          // This was a drag-to-connect!
          const element = document.elementFromPoint(touch.clientX, touch.clientY) as HTMLElement | null;
          const targetHandle = element?.closest('.canvas-card-handle') as HTMLElement | null;

          if (targetHandle) {
            const toNodeId = targetHandle.getAttribute('data-node-id');
            const toSide = targetHandle.getAttribute('data-side') as 'top' | 'right' | 'bottom' | 'left' | null;

            if (toNodeId && toSide && activeConnection.fromNode !== toNodeId) {
              const newEdge: CanvasEdge = {
                id: `edge_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
                fromNode: activeConnection.fromNode,
                fromSide: activeConnection.fromSide,
                toNode: toNodeId,
                toSide: toSide,
              };

              setEdges(prev => {
                const exists = prev.some(
                  edge => edge.fromNode === newEdge.fromNode && edge.toNode === newEdge.toNode
                );
                return exists ? prev : [...prev, newEdge];
              });
            }
          }
          setActiveConnection(null);
        } else {
          // Simple touch tap! Keep activeConnection alive for tap-to-link mode.
        }
      }
    }
  };

  const centerToNodes = () => {
    if (nodesRef.current.length === 0) return;

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;

    for (const node of nodesRef.current) {
      minX = Math.min(minX, node.x);
      maxX = Math.max(maxX, node.x + node.width);
      minY = Math.min(minY, node.y);
      maxY = Math.max(maxY, node.y + node.height);
    }

    if (minX === Infinity) return;

    const padding = 60;
    const boundingWidth = maxX - minX + padding * 2;
    const boundingHeight = maxY - minY + padding * 2;

    if (!containerRef.current) return;
    const viewportWidth = containerRef.current.clientWidth;
    const viewportHeight = containerRef.current.clientHeight;
    const zoomFitX = viewportWidth / boundingWidth;
    const zoomFitY = viewportHeight / boundingHeight;
    const newZoom = Math.min(zoomFitX, zoomFitY, 1);

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;

    const newPanX = viewportWidth / 2 - centerX * newZoom;
    const newPanY = viewportHeight / 2 - centerY * newZoom;

    setZoom(newZoom);
    setPanX(newPanX);
    setPanY(newPanY);
  };

  const addNewCard = (type: 'text' | 'file', linkedFilePath?: string) => {
    const centerWorld = getCanvasCoords(
      (containerRef.current?.clientWidth || 800) / 2,
      (containerRef.current?.clientHeight || 600) / 2
    );

    let finalX = Math.round(centerWorld.x - 160);
    let finalY = Math.round(centerWorld.y - 100);
    const offsetStep = 30;
    while (nodes.some(n => n.x === finalX && n.y === finalY)) {
      finalX += offsetStep;
      finalY += offsetStep;
    }

    const newNode: CanvasNode = {
      id: `card_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
      x: finalX,
      y: finalY,
      width: 320,
      height: type === 'text' ? 160 : 260,
      type,
      text: type === 'text' ? '### New Card\nDouble click to edit card text.' : undefined,
      file: type === 'file' ? linkedFilePath || '' : undefined,
    };

    const nextNodes = [...nodes, newNode];
    setNodes(nextNodes);
    setSelectedNodeId(newNode.id);
    pushState(nextNodes, edges);
  };

  const handleDeleteSelected = () => {
    if (selectedNodeId) {
      const nextNodes = nodes.filter(n => n.id !== selectedNodeId);
      const nextEdges = edges.filter(e => e.fromNode !== selectedNodeId && e.toNode !== selectedNodeId);
      setNodes(nextNodes);
      setEdges(nextEdges);
      setSelectedNodeId(null);
      pushState(nextNodes, nextEdges);
    } else if (selectedEdgeId) {
      const nextEdges = edges.filter(e => e.id !== selectedEdgeId);
      setEdges(nextEdges);
      setSelectedEdgeId(null);
      pushState(nodes, nextEdges);
    }
  };

  const handleCardHeaderMouseDown = (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (activeConnection) {
      setActiveConnection(null);
    }
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
    dragNodeId.current = nodeId;
    const { x, y } = getCanvasCoords(e.clientX, e.clientY);
    dragStart.current = { x, y };
    setActiveDragResizeState('dragging');
  };

  const handleCardHeaderTouchStart = (nodeId: string, e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    e.stopPropagation();
    if (activeConnection) {
      setActiveConnection(null);
    }
    setSelectedNodeId(nodeId);
    setSelectedEdgeId(null);
    touchDragNodeId.current = nodeId;
    const touch = e.touches[0];
    const { x, y } = getCanvasCoords(touch.clientX, touch.clientY);
    dragStart.current = { x, y };
    setActiveDragResizeState('dragging');
  };

  const handleResizeMouseDown = (nodeId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    dragResizeNodeId.current = nodeId;
    resizeStartCoords.current = { x: e.clientX, y: e.clientY };
    resizeStartDims.current = { width: node.width, height: node.height };
    setActiveDragResizeState('resizing');
  };

  const handleResizeTouchStart = (nodeId: string, e: React.TouchEvent) => {
    if (e.touches.length !== 1) return;
    e.stopPropagation();
    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    dragResizeNodeId.current = nodeId;
    const touch = e.touches[0];
    resizeStartCoords.current = { x: touch.clientX, y: touch.clientY };
    resizeStartDims.current = { width: node.width, height: node.height };
    setActiveDragResizeState('resizing');
  };

  const handleTextChange = (nodeId: string, text: string) => {
    setNodes(prev => prev.map(node => {
      if (node.id === nodeId) {
        return { ...node, text };
      }
      return node;
    }));
  };

  const handleHandleMouseDown = (
    nodeId: string,
    side: 'top' | 'right' | 'bottom' | 'left',
    e: React.MouseEvent
  ) => {
    e.stopPropagation();
    e.preventDefault();
    setSelectedEdgeId(null);

    if (activeConnection) {
      if (activeConnection.fromNode !== nodeId || activeConnection.fromSide !== side) {
        const newEdge: CanvasEdge = {
          id: generateEdgeId(),
          fromNode: activeConnection.fromNode,
          fromSide: activeConnection.fromSide,
          toNode: nodeId,
          toSide: side,
        };

        setEdges(prev => {
          const exists = prev.some(
            edge => edge.fromNode === newEdge.fromNode && edge.toNode === newEdge.toNode
          );
          const nextEdges = exists ? prev : [...prev, newEdge];
          if (!exists) {
            pushState(nodes, nextEdges);
          }
          return nextEdges;
        });
      }
      setActiveConnection(null);
      return;
    }

    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    let startX = node.x;
    let startY = node.y;

    if (side === 'top') { startX += node.width / 2; }
    else if (side === 'right') { startX += node.width; startY += node.height / 2; }
    else if (side === 'bottom') { startX += node.width / 2; startY += node.height; }
    else if (side === 'left') { startY += node.height / 2; }

    setActiveConnection({
      fromNode: nodeId,
      fromSide: side,
      startX,
      startY,
      currentX: panX + startX * zoom,
      currentY: panY + startY * zoom,
    });
    connectionStartClient.current = { x: e.clientX, y: e.clientY };
  };

  const handleHandleTouchStart = (
    nodeId: string,
    side: 'top' | 'right' | 'bottom' | 'left',
    e: React.TouchEvent
  ) => {
    e.stopPropagation();

    if (activeConnection) {
      if (activeConnection.fromNode !== nodeId || activeConnection.fromSide !== side) {
        const newEdge: CanvasEdge = {
          id: generateEdgeId(),
          fromNode: activeConnection.fromNode,
          fromSide: activeConnection.fromSide,
          toNode: nodeId,
          toSide: side,
        };

        setEdges(prev => {
          const exists = prev.some(
            edge => edge.fromNode === newEdge.fromNode && edge.toNode === newEdge.toNode
          );
          const nextEdges = exists ? prev : [...prev, newEdge];
          if (!exists) {
            pushState(nodes, nextEdges);
          }
          return nextEdges;
        });
      }
      setActiveConnection(null);
      return;
    }

    const node = nodes.find(n => n.id === nodeId);
    if (!node) return;

    let startX = node.x;
    let startY = node.y;

    if (side === 'top') { startX += node.width / 2; }
    else if (side === 'right') { startX += node.width; startY += node.height / 2; }
    else if (side === 'bottom') { startX += node.width / 2; startY += node.height; }
    else if (side === 'left') { startY += node.height / 2; }

    setActiveConnection({
      fromNode: nodeId,
      fromSide: side,
      startX,
      startY,
      currentX: panX + startX * zoom,
      currentY: panY + startY * zoom,
    });

    isTouchConnecting.current = true;
    touchConnectStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
  };

  const handleHandleMouseUp = (
    toNodeId: string,
    toSide: 'top' | 'right' | 'bottom' | 'left',
    e: React.MouseEvent
  ) => {
    e.stopPropagation();
    if (!activeConnection) return;

    if (activeConnection.fromNode === toNodeId) return;

    const newEdge: CanvasEdge = {
      id: generateEdgeId(),
      fromNode: activeConnection.fromNode,
      fromSide: activeConnection.fromSide,
      toNode: toNodeId,
      toSide: toSide,
    };

    setEdges(prev => {
      const exists = prev.some(
        e => e.fromNode === newEdge.fromNode && e.toNode === newEdge.toNode
      );
      const nextEdges = exists ? prev : [...prev, newEdge];
      if (!exists) {
        pushState(nodes, nextEdges);
      }
      return nextEdges;
    });

    setActiveConnection(null);
  };

  const handleSaveCanvas = async () => {
    performAutoSave();
  };

  const calculatePath = (edge: CanvasEdge) => {
    const fromNode = nodes.find(n => n.id === edge.fromNode);
    const toNode = nodes.find(n => n.id === edge.toNode);
    if (!fromNode || !toNode) return '';

    const getSideCoords = (
      node: CanvasNode,
      side: 'top' | 'right' | 'bottom' | 'left'
    ) => {
      let x = node.x;
      let y = node.y;
      if (side === 'top') { x += node.width / 2; }
      else if (side === 'right') { x += node.width; y += node.height / 2; }
      else if (side === 'bottom') { x += node.width / 2; y += node.height; }
      else if (side === 'left') { y += node.height / 2; }
      return { x, y };
    };

    const start = getSideCoords(fromNode, edge.fromSide);
    const end = getSideCoords(toNode, edge.toSide);

    const controlOffset = 80;
    let cp1x = start.x;
    let cp1y = start.y;
    let cp2x = end.x;
    let cp2y = end.y;

    if (edge.fromSide === 'top') cp1y -= controlOffset;
    else if (edge.fromSide === 'right') cp1x += controlOffset;
    else if (edge.fromSide === 'bottom') cp1y += controlOffset;
    else if (edge.fromSide === 'left') cp1x -= controlOffset;

    if (edge.toSide === 'top') cp2y -= controlOffset;
    else if (edge.toSide === 'right') cp2x += controlOffset;
    else if (edge.toSide === 'bottom') cp2y += controlOffset;
    else if (edge.toSide === 'left') cp2x -= controlOffset;

    return `M ${start.x} ${start.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${end.x} ${end.y}`;
  };

  const hasUnsavedChanges = (() => {
    const currentSerialized = JSON.stringify({ nodes, edges }, null, 2);
    if (!savedContent && nodes.length === 0 && edges.length === 0) {
      return false;
    }
    return currentSerialized !== savedContent;
  })();

  const activePathString = () => {
    if (!activeConnection) return '';
    const start = {
      x: panX + activeConnection.startX * zoom,
      y: panY + activeConnection.startY * zoom
    };
    const end = {
      x: activeConnection.currentX,
      y: activeConnection.currentY
    };

    const controlOffset = 80 * zoom;
    let cp1x = start.x;
    let cp1y = start.y;

    if (activeConnection.fromSide === 'top') cp1y -= controlOffset;
    else if (activeConnection.fromSide === 'right') cp1x += controlOffset;
    else if (activeConnection.fromSide === 'bottom') cp1y += controlOffset;
    else if (activeConnection.fromSide === 'left') cp1x -= controlOffset;

    return `M ${start.x} ${start.y} C ${cp1x} ${cp1y}, ${end.x} ${end.y}, ${end.x} ${end.y}`;
  };

  return (
    <div
      className={cn(
        "w-full h-full relative bg-[oklch(0.06_0.01_260)] overflow-hidden select-none touch-none animate-fade-in",
        (activeDragResizeState !== 'idle' || activeConnection !== null) && "pointer-events-hijack-active"
      )}
      ref={containerRef}
      style={{ touchAction: 'none' }}
      onMouseDown={handleMouseDown}
      onPaste={handleCanvasPaste}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      <style>{`
        .pointer-events-hijack-active embed,
        .pointer-events-hijack-active iframe,
        .pointer-events-hijack-active textarea,
        .pointer-events-hijack-active img,
        .pointer-events-hijack-active .markdown-preview {
          pointer-events: none !important;
        }
      `}</style>
      <div
        className="canvas-viewport w-full h-full absolute top-0 left-0 cursor-grab active:cursor-grabbing origin-top-left"
        style={{
          transform: `translate(${panX}px, ${panY}px) scale(${zoom})`,
          transformOrigin: 'top left',
        }}
      >
        <div
          className="canvas-grid absolute w-[100000px] h-[100000px] top-[-50000px] left-[-50000px] pointer-events-none z-0"
          style={{
            backgroundImage: `radial-gradient(rgba(255, 255, 255, 0.045) 1px, transparent 1px)`,
            backgroundSize: '24px 24px'
          }}
        />

        <svg
          className="canvas-svg-overlay"
          width="100%"
          height="100%"
          style={{ overflow: 'visible' }}
        >
          <defs>
            <marker
              id="arrow"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="rgba(255,255,255,0.3)" />
            </marker>
            <marker
              id="arrow-active"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="var(--primary)" />
            </marker>
            <marker
              id="arrow-selected"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="oklch(0.60 0.22 25)" />
            </marker>
          </defs>

          {edges.map(edge => {
            const isEdgeSelected = selectedEdgeId === edge.id;
            const isNodeSelected = selectedNodeId === edge.fromNode || selectedNodeId === edge.toNode;
            return (
              <path
                key={edge.id}
                d={calculatePath(edge)}
                className={cn(
                  "canvas-connection-line",
                  (isEdgeSelected || isNodeSelected) && "active",
                  isEdgeSelected && "selected"
                )}
                markerEnd={`url(#${isEdgeSelected ? 'arrow-selected' : (isNodeSelected ? 'arrow-active' : 'arrow')})`}
                onClick={(e) => {
                  e.stopPropagation();
                  setSelectedEdgeId(edge.id);
                  setSelectedNodeId(null);
                }}
              />
            );
          })}


        </svg>

        {nodes.map(node => {
          const isSelected = selectedNodeId === node.id;
          return (
            <div
              key={node.id}
              className={cn(
                "absolute bg-card border-[2px] rounded-xl flex flex-col z-10 transition-colors duration-250 cursor-default shadow-2xl",
                isSelected
                  ? "border-primary shadow-[0_0_20px_rgba(139,92,246,0.3)] z-20"
                  : "border-border/80 hover:border-muted-foreground/40"
              )}
              style={{
                left: `${node.x}px`,
                top: `${node.y}px`,
                width: `${node.width}px`,
                height: `${node.height}px`,
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (activeConnection) setActiveConnection(null);
                setSelectedNodeId(node.id);
                setSelectedEdgeId(null);
              }}
            >
              <div
                className={cn(
                  "px-3 flex items-center justify-between rounded-t-xl cursor-move select-none transition-all duration-200",
                  node.type === 'text'
                    ? "h-8 bg-transparent border-none"
                    : "h-10 bg-muted/40 border-b border-border/80"
                )}
                onMouseDown={(e) => handleCardHeaderMouseDown(node.id, e)}
                onTouchStart={(e) => handleCardHeaderTouchStart(node.id, e)}
                onDragStart={(e) => e.preventDefault()}
              >
                <div className="flex items-center gap-2 text-xs font-semibold text-muted-foreground">
                  {node.type === 'text' ? <Type size={12} className="text-primary" /> : <FileText size={13} />}
                  <span className={cn(
                    "truncate max-w-[190px]",
                    node.type === 'text' ? "uppercase tracking-widest text-muted-foreground/60 text-[0.6rem]" : "text-xs text-muted-foreground"
                  )}>
                    {node.type === 'text'
                      ? 'Independent Text'
                      : node.file?.split('/').pop()?.replace(/\.md$/, '') || 'Unlinked Note'}
                  </span>
                </div>

                {node.type === 'text' && (
                  <button
                    className="w-6 h-6 rounded-full flex items-center justify-center text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditingNodeIds(prev => ({
                        ...prev,
                        [node.id]: !prev[node.id]
                      }));
                    }}
                    title={editingNodeIds[node.id] ? "View Markdown Preview" : "Edit Markdown"}
                  >
                    {editingNodeIds[node.id] ? <Eye size={12} /> : <Edit2 size={12} />}
                  </button>
                )}

                {node.type === 'file' && node.file && (
                  <button
                    className="w-6 h-6 rounded-full flex items-center justify-center text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (node.file) onOpenNote(node.file);
                    }}
                    title="Open linked note"
                  >
                    <Link2 size={12} />
                  </button>
                )}
              </div>

              <div className="flex-1 overflow-y-auto p-4 select-text">
                {node.type === 'text' ? (
                  editingNodeIds[node.id] ? (
                    <textarea
                      autoFocus
                      className="w-full h-full min-h-[80px] bg-transparent border-none resize-none p-0 text-foreground text-sm leading-relaxed outline-none focus:ring-0 select-text font-mono"
                      value={node.text || ''}
                      onChange={(e) => handleTextareaChange(node.id, e.target.value, e.target as HTMLTextAreaElement)}
                      onKeyDown={(e) => handleTextareaKeyDown(node.id, e, e.target as HTMLTextAreaElement)}
                      onBlur={() => {
                        // Defer blur slightly so mouse down on autocomplete dropdown can be processed first
                        setTimeout(() => {
                          setEditingNodeIds(prev => ({ ...prev, [node.id]: false }));
                          setShowSuggestions(false);
                          pushState(nodes, edges);
                          performAutoSave();
                        }, 150);
                      }}
                      placeholder="Enter markdown text..."
                    />
                  ) : (
                    <div
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        setEditingNodeIds(prev => ({ ...prev, [node.id]: true }));
                      }}
                      onClick={handlePreviewClick}
                      className="markdown-preview text-sm text-foreground/90 h-full overflow-y-auto cursor-pointer"
                      dangerouslySetInnerHTML={{ __html: renderCanvasMarkdown(node.text || '') }}
                      title="Double click to edit"
                    />
                  )
                ) : (
                  <div className="text-xs text-muted-foreground leading-relaxed h-full overflow-y-auto" onClick={handlePreviewClick}>
                    {node.file ? (
                      (() => {
                        const fileKey = node.file!;
                        const lowerPath = fileKey.toLowerCase();
                        const isImage = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].some(ext => lowerPath.endsWith(ext));
                        const isPdf = lowerPath.endsWith('.pdf');

                        if (isImage) {
                          return (
                            <div className="w-full h-full flex items-center justify-center bg-background/50 rounded-b-xl overflow-hidden p-2">
                              {vaultImages[fileKey] ? (
                                <img
                                  src={vaultImages[fileKey]}
                                  alt={fileKey.split('/').pop()}
                                  className="max-w-full max-h-full object-contain rounded-lg shadow-lg select-none"
                                />
                              ) : (
                                <div className="flex flex-col gap-1.5 items-center justify-center text-muted-foreground text-[0.65rem]">
                                  <RefreshCw className="w-4 h-4 animate-spin text-primary" />
                                  <span>Loading Image...</span>
                                </div>
                              )}
                            </div>
                          );
                        }

                        if (isPdf) {
                          return (
                            <div className="w-full h-full flex flex-col items-center justify-center bg-background/50 rounded-b-xl overflow-hidden p-4 text-center">
                              <div className="w-10 h-10 rounded-xl bg-red-500/10 text-red-500 flex items-center justify-center mb-2 border border-red-500/20">
                                <Paperclip className="w-5 h-5" />
                              </div>
                              <span className="text-[0.7rem] font-bold text-foreground truncate max-w-full block px-2 mb-1">
                                {fileKey.split('/').pop()}
                              </span>
                              <span className="text-[0.55rem] text-muted-foreground block mb-3">
                                PDF Document
                              </span>
                              {vaultImages[fileKey] ? (
                                <div className="flex gap-1.5 justify-center w-full">
                                  <a
                                    href={vaultImages[fileKey]}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="px-2.5 py-1 bg-primary hover:bg-primary/90 text-primary-foreground text-[0.6rem] font-semibold rounded-md transition-all cursor-pointer shadow-sm shadow-primary/10"
                                  >
                                    Open PDF
                                  </a>
                                  <button
                                    onClick={() => {
                                      const link = document.createElement('a');
                                      link.href = vaultImages[fileKey]!;
                                      link.download = fileKey.split('/').pop() || 'document.pdf';
                                      document.body.appendChild(link);
                                      link.click();
                                      document.body.removeChild(link);
                                    }}
                                    className="px-2.5 py-1 bg-muted hover:bg-muted/80 text-foreground text-[0.6rem] font-semibold rounded-md transition-all cursor-pointer border border-border"
                                  >
                                    Download
                                  </button>
                                </div>
                              ) : (
                                <div className="flex items-center gap-1.5 text-[0.65rem] text-muted-foreground">
                                  <RefreshCw className="w-3.5 h-3.5 animate-spin text-primary" />
                                  <span>Loading...</span>
                                </div>
                              )}
                            </div>
                          );
                        }

                        return (
                          <div
                            className="markdown-preview text-foreground/80 h-full overflow-y-auto"
                            dangerouslySetInnerHTML={{
                              __html: fileContents[node.file]
                                ? renderCanvasMarkdown(fileContents[node.file].substring(0, 480) + (fileContents[node.file].length > 480 ? '...' : ''))
                                : `<span class="text-muted-foreground/50 italic">Note is empty. Double-click text cards to edit.</span>`
                            }}
                          />
                        );
                      })()
                    ) : (
                      <div className="text-destructive flex flex-col gap-2 p-1 relative select-none">
                        <span className="font-semibold">No note linked!</span>

                        <div className="relative">
                          {activeLinkSelectorCardId === node.id && (
                            <div
                              className="fixed inset-0 z-40 bg-transparent cursor-default"
                              onClick={() => {
                                setActiveLinkSelectorCardId(null);
                                setNoteSearchQuery('');
                              }}
                            />
                          )}

                          <button
                            type="button"
                            onClick={() => {
                              setActiveLinkSelectorCardId(activeLinkSelectorCardId === node.id ? null : node.id);
                              setNoteSearchQuery('');
                            }}
                            className="w-full bg-muted/60 border border-border text-foreground hover:bg-white/[0.04] px-2.5 py-1.5 rounded-lg text-xs focus:outline-none focus:border-primary transition-all duration-200 cursor-pointer flex items-center justify-between text-left relative z-50 font-medium"
                          >
                            <span className="truncate flex items-center gap-1.5">
                              <FileText className="w-3.5 h-3.5 text-muted-foreground/80 shrink-0" />
                              <span>Select note...</span>
                            </span>
                            <ChevronDown className={cn("w-3.5 h-3.5 text-muted-foreground transition-transform shrink-0 ml-1.5", activeLinkSelectorCardId === node.id && "transform rotate-180")} />
                          </button>

                          {activeLinkSelectorCardId === node.id && (
                            <div className="absolute top-full left-0 w-full mt-1 bg-[#18181f]/95 backdrop-blur-xl border border-border/60 rounded-2xl shadow-2xl p-2.5 flex flex-col gap-2 z-50 animate-in fade-in slide-in-from-top-2 duration-100 min-w-[180px]">

                              <div className="relative flex items-center shrink-0">
                                <Search size={11} className="absolute left-2.5 text-muted-foreground" />
                                <input
                                  type="text"
                                  value={noteSearchQuery}
                                  onChange={(e) => setNoteSearchQuery(e.target.value)}
                                  placeholder="Search notes..."
                                  className="w-full bg-[#0e0f14] border border-border/80 text-foreground pl-7 pr-2.5 py-1 rounded-xl text-[0.68rem] focus:outline-none focus:border-indigo-500 transition-all font-medium"
                                  onClick={(e) => e.stopPropagation()}
                                />
                              </div>

                              <div className="max-h-[140px] overflow-y-auto flex flex-col gap-0.5 pr-0.5">
                                {files
                                  .filter(f => {
                                    const lower = f.path.toLowerCase();
                                    if (lower.includes('.obsidian/') || lower.startsWith('.obsidian/')) return false;
                                    if (f.name === '.gitkeep' || f.name === '.vault-compat.json') return false;
                                    const allowed = ['.md', '.txt', '.canvas', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf'];
                                    return allowed.some(ext => lower.endsWith(ext)) && f.name.toLowerCase().includes(noteSearchQuery.toLowerCase());
                                  })
                                  .map(f => {
                                    const cleanName = f.name.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '');
                                    const isImg = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].some(ext => f.path.toLowerCase().endsWith(ext));
                                    const isPdf = f.path.toLowerCase().endsWith('.pdf');
                                    return (
                                      <button
                                        key={f.path}
                                        type="button"
                                        onClick={() => {
                                          setNodes(prev => prev.map(n => n.id === node.id ? { ...n, file: f.path } : n));
                                          setActiveLinkSelectorCardId(null);
                                          setNoteSearchQuery('');
                                        }}
                                        className="w-full text-left px-2 py-1.5 rounded-xl text-[0.7rem] font-semibold text-foreground/90 hover:bg-white/[0.04] cursor-pointer transition-colors duration-100 flex items-center gap-1.5 border border-transparent hover:border-border/10"
                                      >
                                        {isImg ? (
                                          <Image className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                                        ) : isPdf ? (
                                          <Paperclip className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                                        ) : (
                                          <FileText className="w-3 h-3 text-muted-foreground/60 shrink-0" />
                                        )}
                                        <span className="truncate" title={f.name}>{cleanName}</span>
                                      </button>
                                    );
                                  })}
                                {files.filter(f => {
                                  const lower = f.path.toLowerCase();
                                  if (lower.includes('.obsidian/') || lower.startsWith('.obsidian/')) return false;
                                  if (f.name === '.gitkeep' || f.name === '.vault-compat.json') return false;
                                  const allowed = ['.md', '.txt', '.canvas', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf'];
                                  return allowed.some(ext => lower.endsWith(ext)) && f.name.toLowerCase().includes(noteSearchQuery.toLowerCase());
                                }).length === 0 && (
                                    <span className="text-center py-3 text-[0.65rem] text-muted-foreground italic select-none">
                                      No notes found
                                    </span>
                                  )}
                              </div>
                            </div>
                          )}
                        </div>
                      </div>
                    )
                    }
                  </div>
                )}
              </div>

              {(['top', 'right', 'bottom', 'left'] as const).map(side => (
                <div
                  key={side}
                  className={`canvas-card-handle handle-${side}`}
                  data-node-id={node.id}
                  data-side={side}
                  onMouseDown={(e) => handleHandleMouseDown(node.id, side, e)}
                  onMouseUp={(e) => handleHandleMouseUp(node.id, side, e)}
                  onTouchStart={(e) => handleHandleTouchStart(node.id, side, e)}
                  onDragStart={(e) => e.preventDefault()}
                  onClick={(e) => e.stopPropagation()}
                />
              ))}
              {isSelected && (
                <div
                  className="absolute bottom-0 right-0 w-7 h-7 cursor-se-resize z-[100] flex items-end justify-end select-none active:scale-95 transition-all p-1 hover:scale-110"
                  onMouseDown={(e) => handleResizeMouseDown(node.id, e)}
                  onTouchStart={(e) => handleResizeTouchStart(node.id, e)}
                  title="Drag to resize card"
                >
                  <div className="bg-primary/80 hover:bg-primary text-white w-5 h-5 rounded-md flex items-center justify-center shadow-lg border border-primary-foreground/20 transition-colors pointer-events-none">
                    <svg width="10" height="10" viewBox="0 0 10 10" className="text-white">
                      <path d="M 10 2 L 2 10 M 10 5 L 5 10 M 10 8 L 8 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                    </svg>
                  </div>
                </div>
              )}

              {showSuggestions && editingNodeIds[node.id] && (
                <div className="absolute top-[100%] left-0 w-[240px] mt-1 bg-[#18181f]/95 backdrop-blur-xl border border-border/60 rounded-2xl shadow-2xl p-2.5 flex flex-col gap-1.5 z-[1000] max-h-[160px] overflow-y-auto select-none animate-in fade-in slide-in-from-top-1 duration-100">
                  <div className="text-[0.65rem] font-bold text-muted-foreground/80 uppercase tracking-widest px-1 pb-1.5 select-none border-b border-border/40 flex justify-between items-center">
                    <span>Suggestions</span>
                    <span className="text-[0.55rem] lowercase tracking-normal font-semibold font-sans text-muted-foreground/55">enter to link</span>
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {filteredSuggestions.map((path, idx) => {
                      const isSelectedSug = suggestionIndex === idx;
                      const name = path.split('/').pop()?.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '') || '';
                      const dir = path.includes('/') ? path.substring(0, path.lastIndexOf('/')) : null;
                      return (
                        <button
                          key={path}
                          type="button"
                          onMouseDown={(e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            const targetTextarea = document.querySelector(`textarea[placeholder="Enter markdown text..."]`) as HTMLTextAreaElement | null;
                            if (targetTextarea) {
                              insertSuggestion(node.id, path, node.text || '', targetTextarea);
                            }
                          }}
                          onMouseEnter={() => setSuggestionIndex(idx)}
                          className={cn(
                            "w-full text-left px-2 py-1.5 rounded-xl text-[0.7rem] transition-colors duration-100 cursor-pointer font-semibold flex items-center justify-between border border-transparent hover:border-border/10",
                            isSelectedSug
                              ? "bg-indigo-600/15 text-accent font-semibold"
                              : "text-muted-foreground hover:bg-white/[0.04] hover:text-foreground"
                          )}
                        >
                          <span className="flex items-center gap-2 truncate">
                            <FileText className="w-3.5 h-3.5 shrink-0" />
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
                      <span className="text-center py-3 text-[0.65rem] text-muted-foreground italic select-none">
                        No matching notes
                      </span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="fixed bottom-[calc(1rem+env(safe-area-inset-bottom))] right-4 sm:bottom-6 sm:right-6 flex items-center gap-1.5 bg-card/60 backdrop-blur-xl border border-border px-3 py-2 rounded-full shadow-2xl z-50 select-none max-w-[calc(100%-2rem)] overflow-x-auto flex-nowrap no-scrollbar">
        <button
          type="button"
          onClick={() => addNewCard('text')}
          className="h-8 px-2.5 lg:px-3.5 rounded-full flex items-center gap-1.5 text-xs font-semibold text-white bg-gradient-to-r from-primary to-accent hover:from-primary/95 hover:to-accent/95 focus:outline-none transition-all cursor-pointer shadow-md shadow-primary/10 shrink-0"
          title="Add Independent Text Box"
        >
          <Type size={13} />
          <span className="hidden lg:inline">Add Text</span>
        </button>

        <div className="relative shrink-0">
          <button
            ref={addNoteButtonRef}
            type="button"
            onClick={() => {
              setIsAddNoteOpen(!isAddNoteOpen);
              setIsAddImageOpen(false);
            }}
            className={cn(
              "h-8 px-2.5 lg:px-3.5 rounded-full text-xs font-semibold text-muted-foreground hover:bg-border/60 hover:text-foreground border border-transparent focus:outline-none transition-all cursor-pointer flex items-center gap-1.5 justify-center shrink-0",
              isAddNoteOpen && "bg-primary/10 text-accent border-primary/20"
            )}
            title="Add Linked Note"
          >
            <FileText size={13} className="text-blue-400 shrink-0" />
            <span className="hidden lg:inline truncate">Add Note</span>
          </button>
        </div>

        <div className="relative shrink-0">
          <button
            ref={addImageButtonRef}
            type="button"
            onClick={() => {
              setIsAddImageOpen(!isAddImageOpen);
              setIsAddNoteOpen(false);
            }}
            className={cn(
              "h-8 px-2.5 lg:px-3.5 rounded-full text-xs font-semibold text-muted-foreground hover:bg-border/60 hover:text-foreground border border-transparent focus:outline-none transition-all cursor-pointer flex items-center gap-1.5 justify-center shrink-0",
              isAddImageOpen && "bg-primary/10 text-accent border-primary/20"
            )}
            title="Add Media / Attachment Card"
          >
            <Image size={13} className="text-blue-400 shrink-0" />
            <span className="hidden lg:inline truncate">Add Image/PDF</span>
          </button>
        </div>

        <div className="w-[1px] h-5 bg-border mx-1 shrink-0" />

        <button
          onClick={undo}
          disabled={historyIndex <= 0}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center transition-all border border-transparent shrink-0",
            historyIndex > 0
              ? "text-muted-foreground hover:bg-border/60 hover:text-foreground cursor-pointer"
              : "text-muted-foreground/30 pointer-events-none"
          )}
          title="Undo (Ctrl+Z)"
        >
          <Undo2 size={14.5} />
        </button>

        <button
          onClick={redo}
          disabled={historyIndex >= history.length - 1}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center transition-all border border-transparent shrink-0",
            historyIndex < history.length - 1
              ? "text-muted-foreground hover:bg-border/60 hover:text-foreground cursor-pointer"
              : "text-muted-foreground/30 pointer-events-none"
          )}
          title="Redo (Ctrl+Y)"
        >
          <Redo2 size={14.5} />
        </button>

        <div className="w-[1px] h-5 bg-border mx-1 shrink-0" />

        <button
          onClick={handleDeleteSelected}
          disabled={!selectedNodeId && !selectedEdgeId}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center transition-all border border-transparent shrink-0",
            (selectedNodeId || selectedEdgeId)
              ? "text-destructive hover:bg-destructive/15 hover:border-destructive/30 cursor-pointer"
              : "text-muted-foreground/45 pointer-events-none"
          )}
          title={selectedNodeId ? "Delete Selected Node" : selectedEdgeId ? "Delete Selected Connection" : "Delete Selected"}
        >
          <Trash2 size={14.5} />
        </button>

        <div className="w-[1px] h-5 bg-border mx-1 shrink-0" />

        <button
          onClick={() => zoomCentered(false)}
          className="w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer border border-transparent shrink-0"
          title="Zoom Out"
        >
          <Minus size={14.5} />
        </button>

        <span className="text-[0.75rem] font-bold text-muted-foreground px-1 select-none shrink-0 hidden lg:inline">
          {Math.round(zoom * 100)}%
        </span>

        <button
          onClick={() => zoomCentered(true)}
          className="w-8 h-8 rounded-full flex items-center justify-center text-muted-foreground hover:bg-border/60 hover:text-foreground transition-all cursor-pointer border border-transparent shrink-0"
          title="Zoom In"
        >
          <Plus size={14.5} />
        </button>

        <button
          onClick={centerToNodes}
          disabled={nodes.length === 0}
          className={cn(
            "w-8 h-8 rounded-full flex items-center justify-center transition-all cursor-pointer border border-transparent shrink-0",
            nodes.length > 0
              ? "text-muted-foreground hover:bg-border/60 hover:text-foreground"
              : "text-muted-foreground/45 pointer-events-none"
          )}
          title="Center to All Nodes"
        >
          <Compass size={14.5} />
        </button>

        <div className="w-[1px] h-5 bg-border mx-1 shrink-0" />

        <button
          onClick={handleSaveCanvas}
          disabled={saveStatus === 'saving'}
          title="Save Canvas"
          className={cn(
            "flex items-center justify-center gap-1.5 h-8 w-8 lg:w-auto px-0 lg:px-4 rounded-full font-semibold text-xs transition-all duration-200 transform shrink-0 cursor-pointer border border-transparent",
            hasUnsavedChanges
              ? "bg-gradient-to-r from-primary to-accent text-white shadow-md shadow-primary/20 hover:-translate-y-0.5"
              : "bg-transparent text-muted-foreground hover:bg-border/60 hover:text-foreground"
          )}
        >
          {saveStatus === 'saving' ? (
            <RefreshCw className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Save className="w-3.5 h-3.5" />
          )}
          <span className="hidden lg:inline">
            {saveStatus === 'saving' ? 'Saving...' : saveStatus === 'saved' ? 'Saved!' : 'Save'}
          </span>
        </button>
      </div>

      {isAddNoteOpen && notePopupCoords && (
        <>
          <div
            className="fixed inset-0 z-40 bg-transparent cursor-default"
            onClick={() => {
              setIsAddNoteOpen(false);
              setNoteSearchQuery('');
            }}
          />
          <div
            style={{ 
              left: window.innerWidth < 640 ? undefined : `${notePopupCoords.left}px`, 
              bottom: `${notePopupCoords.bottom}px` 
            }}
            className="fixed left-4 right-4 sm:left-auto sm:right-auto sm:w-72 bg-[#18181f]/95 backdrop-blur-xl border border-border/60 rounded-2xl shadow-2xl p-3 flex flex-col gap-2.5 z-50 text-foreground text-left normal-case font-normal duration-100 select-none animate-in fade-in slide-in-from-bottom-2 max-h-[300px] overflow-hidden"
          >
            <div className="flex items-center justify-between">
              <span className="text-[0.72rem] font-bold text-foreground/90">Select Note</span>
              <button 
                onClick={() => {
                  setIsAddNoteOpen(false);
                  setNoteSearchQuery('');
                }} 
                className="text-muted-foreground/60 hover:text-foreground transition-colors" 
                type="button"
              >
                ✕
              </button>
            </div>

            <div className="relative flex items-center shrink-0">
              <Search size={12} className="absolute left-3 text-muted-foreground" />
              <input
                type="text"
                value={noteSearchQuery}
                onChange={(e) => setNoteSearchQuery(e.target.value)}
                placeholder="Search notes..."
                className="w-full bg-[#0e0f14] border border-border/80 text-foreground pl-8 pr-3 py-1.5 rounded-xl text-[0.72rem] focus:outline-none focus:border-indigo-500 transition-all font-medium"
                onClick={(e) => e.stopPropagation()}
              />
            </div>

            <div className="flex flex-col gap-0.5 max-h-[160px] overflow-y-auto pr-0.5">
              {files.filter(f => {
                const lower = f.path.toLowerCase();
                if (lower.includes('.obsidian/') || lower.startsWith('.obsidian/')) return false;
                if (f.name === '.gitkeep' || f.name === '.vault-compat.json') return false;
                const allowed = ['.md', '.txt', '.canvas'];
                return allowed.some(ext => lower.endsWith(ext)) && f.name.toLowerCase().includes(noteSearchQuery.toLowerCase());
              }).length === 0 ? (
                <span className="text-center py-4 text-[0.68rem] text-muted-foreground italic select-none">
                  No notes found
                </span>
              ) : (
                files.filter(f => {
                  const lower = f.path.toLowerCase();
                  if (lower.includes('.obsidian/') || lower.startsWith('.obsidian/')) return false;
                  if (f.name === '.gitkeep' || f.name === '.vault-compat.json') return false;
                  const allowed = ['.md', '.txt', '.canvas'];
                  return allowed.some(ext => lower.endsWith(ext)) && f.name.toLowerCase().includes(noteSearchQuery.toLowerCase());
                }).map(f => (
                  <button
                    key={f.path}
                    type="button"
                    onClick={() => {
                      addNewCard('file', f.path);
                      setIsAddNoteOpen(false);
                      setNoteSearchQuery('');
                    }}
                    className="w-full text-left px-2 py-1.5 hover:bg-white/[0.04] text-[0.72rem] font-semibold text-foreground/90 rounded-xl transition-all duration-100 flex items-center gap-2 cursor-pointer border border-transparent hover:border-border/10"
                    title={f.name}
                  >
                    <FileText className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
                    <span className="truncate">{f.name.replace(/\.md$/, '').replace(/\.canvas$/, '').replace(/\.txt$/, '')}</span>
                  </button>
                ))
              )}
            </div>
          </div>
        </>
      )}

      {isAddImageOpen && imagePopupCoords && (
        <>
          <div
            className="fixed inset-0 z-40 bg-transparent cursor-default"
            onClick={() => setIsAddImageOpen(false)}
          />
          <div
            style={{ 
              left: window.innerWidth < 640 ? undefined : `${imagePopupCoords.left}px`, 
              bottom: `${imagePopupCoords.bottom}px` 
            }}
            className="fixed left-4 right-4 sm:left-auto sm:right-auto sm:w-72 bg-[#18181f]/95 backdrop-blur-xl border border-border/60 rounded-2xl shadow-2xl p-3 flex flex-col gap-2.5 z-50 text-foreground text-left normal-case font-normal duration-100 select-none animate-in fade-in slide-in-from-bottom-2 max-h-[300px] overflow-hidden"
          >
            <div className="flex items-center justify-between">
              <span className="text-[0.72rem] font-bold text-foreground/90">Add Media Card</span>
              <button 
                onClick={() => setIsAddImageOpen(false)} 
                className="text-muted-foreground/60 hover:text-foreground transition-colors" 
                type="button"
              >
                ✕
              </button>
            </div>

            {onUploadAttachment && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    const input = document.createElement('input');
                    input.type = 'file';
                    input.accept = 'image/*,application/pdf';
                    input.onchange = async (e) => {
                      const file = (e.target as HTMLInputElement).files?.[0];
                      if (!file) return;
                      setIsAddImageOpen(false);
                      setIsUploadingMedia(true);
                      try {
                        const result = await onUploadAttachment(file);
                        addNewCard('file', result.path);
                      } catch (err: unknown) {
                        const errMsg = err instanceof Error ? err.message : 'Failed to upload image.';
                        setErrorMessage(errMsg);
                      } finally {
                        setIsUploadingMedia(false);
                      }
                    };
                    input.click();
                  }}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-primary/10 hover:bg-primary/20 text-primary border border-primary/20 hover:border-primary/30 rounded-xl text-xs font-semibold cursor-pointer transition-all duration-150 shrink-0"
                >
                  {isUploadingMedia ? (
                    <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Paperclip className="w-3.5 h-3.5" />
                  )}
                  <span>Upload from computer</span>
                </button>
                <div className="text-[0.6rem] text-muted-foreground/40 text-center font-bold uppercase select-none my-0.5">
                  — or select from vault —
                </div>
              </>
            )}

            <div className="relative flex items-center shrink-0">
              <Search size={12} className="absolute left-3 text-muted-foreground" />
              <input
                type="text"
                value={mediaSearchQuery}
                onChange={(e) => setMediaSearchQuery(e.target.value)}
                placeholder="Search images/PDFs..."
                className="w-full bg-[#0e0f14] border border-border/80 text-foreground pl-8 pr-3 py-1.5 rounded-xl text-[0.72rem] focus:outline-none focus:border-indigo-500 transition-all font-medium"
                onClick={(e) => e.stopPropagation()}
              />
            </div>

            <div className="flex flex-col gap-0.5 max-h-[140px] overflow-y-auto pr-0.5">
              {files.filter(f => {
                const lower = f.path.toLowerCase();
                if (lower.includes('.obsidian/') || lower.startsWith('.obsidian/')) return false;
                if (f.name === '.gitkeep' || f.name === '.vault-compat.json') return false;
                const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf'];
                return allowed.some(ext => lower.endsWith(ext)) && f.name.toLowerCase().includes(mediaSearchQuery.toLowerCase());
              }).length === 0 ? (
                <span className="text-center py-4 text-[0.68rem] text-muted-foreground italic select-none">
                  No media files found
                </span>
              ) : (
                files.filter(f => {
                  const lower = f.path.toLowerCase();
                  if (lower.includes('.obsidian/') || lower.startsWith('.obsidian/')) return false;
                  if (f.name === '.gitkeep' || f.name === '.vault-compat.json') return false;
                  const allowed = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf'];
                  return allowed.some(ext => lower.endsWith(ext)) && f.name.toLowerCase().includes(mediaSearchQuery.toLowerCase());
                }).map(f => {
                  const cleanName = f.name;
                  const isImg = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg'].some(ext => f.path.toLowerCase().endsWith(ext));
                  return (
                    <button
                      key={f.path}
                      type="button"
                      onClick={() => {
                        addNewCard('file', f.path);
                        setIsAddImageOpen(false);
                        setMediaSearchQuery('');
                      }}
                      className="w-full text-left px-2.5 py-1.5 hover:bg-white/[0.04] text-[0.72rem] font-semibold text-foreground/90 rounded-xl transition-all duration-100 flex items-center gap-2 cursor-pointer border border-transparent hover:border-border/10 truncate"
                      title={f.name}
                    >
                      {isImg ? (
                        <Image className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
                      ) : (
                        <Paperclip className="w-3.5 h-3.5 text-muted-foreground/60 shrink-0" />
                      )}
                      <span className="truncate">{cleanName}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}

      {activeDragResizeState !== 'idle' && (
        <div
          className={cn(
            "fixed inset-0 z-[1000] bg-transparent select-none",
            activeDragResizeState === 'dragging' ? "cursor-grabbing" : "cursor-se-resize"
          )}
        />
      )}

      {activeConnection && (
        <svg
          className="absolute top-0 left-0 w-full h-full pointer-events-none z-[1000]"
          style={{ overflow: 'visible' }}
        >
          <defs>
            <marker
              id="arrow-active-screen"
              viewBox="0 0 10 10"
              refX="8"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1.5 L 8 5 L 0 8.5 z" fill="var(--primary)" />
            </marker>
          </defs>
          <path
            d={activePathString()}
            className="canvas-connection-line active"
            style={{ strokeDasharray: '4,4', pointerEvents: 'none' }}
            markerEnd="url(#arrow-active-screen)"
          />
        </svg>
      )}

      {errorMessage && (
        <div className="absolute top-6 left-1/2 -translate-x-1/2 z-[2000] bg-[#1e1515] border border-destructive/40 text-destructive text-xs font-semibold px-4 py-2.5 rounded-xl shadow-2xl flex items-center gap-2 animate-fade-in select-text">
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage('')}
            className="text-muted-foreground hover:text-foreground text-[0.7rem] ml-2 select-none cursor-pointer border border-transparent hover:bg-white/[0.04] w-5 h-5 flex items-center justify-center rounded-full"
          >
            ✕
          </button>
        </div>
      )}
    </div>
  );
};