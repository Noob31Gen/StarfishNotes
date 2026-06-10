/**
 * Shared Markdown-it engine with full plugin ecosystem.
 * Used by both Editor.tsx and CanvasView.tsx for consistent rendering.
 */
import MarkdownIt from 'markdown-it';
import markdownItFootnote from 'markdown-it-footnote';
import markdownItMark from 'markdown-it-mark';
import markdownItSub from 'markdown-it-sub';
import markdownItSup from 'markdown-it-sup';
import markdownItTaskLists from 'markdown-it-task-lists';
import texmath from 'markdown-it-texmath';
import katex from 'katex';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import css from 'highlight.js/lib/languages/css';
import xml from 'highlight.js/lib/languages/xml';
import python from 'highlight.js/lib/languages/python';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import bash from 'highlight.js/lib/languages/bash';

// Register common languages for syntax highlighting
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('js', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('ts', typescript);
hljs.registerLanguage('css', css);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('python', python);
hljs.registerLanguage('py', python);
hljs.registerLanguage('json', json);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('sh', bash);


// Create and configure the markdown-it instance
const md: MarkdownIt = new MarkdownIt({
  html: true,        // Allow inline HTML
  breaks: true,      // Convert \n to <br>
  linkify: true,     // Auto-link URLs
  typographer: true, // Smart quotes, dashes, etc.
  highlight: (str: string, lang: string): string => {
    if (lang === 'mermaid') {
      // Don't highlight mermaid blocks — they'll be rendered as diagrams
      return '';
    }
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(str, { language: lang, ignoreIllegals: true }).value;
      } catch {
        // Fall through to default
      }
    }
    // Auto-detect for blocks without a language tag
    try {
      return hljs.highlightAuto(str).value;
    } catch {
      return '';
    }
  }
});

// Plugin chain
md.use(markdownItFootnote)
  .use(markdownItMark)
  .use(markdownItSub)
  .use(markdownItSup)
  .use(markdownItTaskLists, { enabled: true, label: true, labelAfter: true })
  .use(texmath, {
    engine: katex,
    delimiters: 'dollars',
    katexOptions: { throwOnError: false, strict: false }
  });

// Custom rule: render ```mermaid blocks as <div class="mermaid"> instead of <pre><code>
const defaultFence = md.renderer.rules.fence!.bind(md.renderer.rules);
md.renderer.rules.fence = (tokens, idx, options, env, self) => {
  const token = tokens[idx];
  if (token.info.trim().toLowerCase() === 'mermaid') {
    return `<div class="mermaid">${md.utils.escapeHtml(token.content)}</div>`;
  }
  return defaultFence(tokens, idx, options, env, self);
};

export default md;
