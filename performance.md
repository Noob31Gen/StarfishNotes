# Starfish Notes - Performance Audit & Recommendations

This document contains a detailed analysis of performance bottlenecks and resource utilization in Starfish Notes, along with practical recommendations to optimize load times, rendering performance, and database sync speeds. All improvements can be completed without altering the visuals or functional features of the application.

---

## 1. High Impact Optimizations

### A. Implement Code Splitting & Lazy Loading (Bundle Size Reduction)
* **Location:** [App.tsx](file:///d:/Programs/code-stuff/notes/src/App.tsx#L1-L22)
* **Finding:** The entry point component `App.tsx` is exceptionally large (**212 KB**). It statically imports and bundles heavy libraries (`mermaid`, `katex`, `highlight.js`, `jszip`) and large subcomponents (`Editor.tsx` [82 KB], `CanvasView.tsx` [113 KB], and `GraphView.tsx` [47 KB]).
  This creates a single large JavaScript bundle, leading to slow Initial Page Load (FCP) and high Time to Interactive (TTI), particularly on mobile networks or weaker CPUs.
* **Remediation:**
  * **Dynamic Imports (`React.lazy` / `Suspense`):** Load visual modes asynchronously. Since users can only view one tab at a time (e.g., Workspace, Canvas, or Graph), lazy load the heavier subcomponents:
    ```typescript
    const Editor = React.lazy(() => import('./components/Editor').then(m => ({ default: m.Editor })));
    const CanvasView = React.lazy(() => import('./components/CanvasView').then(m => ({ default: m.CanvasView })));
    const GraphView = React.lazy(() => import('./components/GraphView').then(m => ({ default: m.GraphView })));
    ```
  * **On-Demand Library Loading:** 
    * `jszip` is only needed when exporting a vault backup. Move the import inside the click handler:
      ```typescript
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();
      ```
    * `mermaid` is only needed when renderable flowchart blocks are parsed. Dynamically load the library and render diagrams asynchronously only when mermaid structures are encountered in notes.

### B. Eliminate Forced Synchronous Layouts (Reflows) in Editor Virtualization
* **Location:** [Editor.tsx](file:///d:/Programs/code-stuff/notes/src/components/Editor.tsx#L237-L271)
* **Finding:** The custom virtual windowing mode measures rendering height by dynamically appending content to a hidden mirror element and reading `clientHeight` inside a loop:
  ```typescript
  for (let i = windowStartLine; i < windowEndLine; i++) {
    mirror.textContent = cleanLine || ' ';
    heights.push(mirror.clientHeight || 24); // <-- Causes Reflow/Layout Thrashing
  }
  ```
  Calling `clientHeight` inside a write/read loop forces the browser to recalculate the layout on every iteration. This is a severe rendering bottleneck for medium to large notes, causing visible typing lag or scrolling stutters.
* **Remediation:**
  * **Batch Measurements:** Create all temporary line containers in the mirror DOM at once in a single write operation, then measure all heights in a single read operation. This allows the browser to perform layout calculations only once.
  * **Lighter Editor Components:** For massive files, consider migrating the core editing canvas to **CodeMirror 6**. CodeMirror is lightweight, natively handles layout virtualization, handles cursors perfectly, runs with high performance, and eliminates the need for manual line measuring hooks.

### C. Implement IndexedDB Batching (Bulk Storage Operations)
* **Location:** [github.ts](file:///d:/Programs/code-stuff/notes/src/services/github.ts#L605-L649) and [storage.ts](file:///d:/Programs/code-stuff/notes/src/services/storage.ts#L37-L60)
* **Finding:** During vault sync (`syncVault`), the GraphQL response is unpacked, and records are written to IndexedDB sequentially:
  ```typescript
  for (const [filePath, content] of graphqlContents.entries()) {
    await saveLocalFile(filePath, { content, sha: targetFile.sha });
  }
  ```
  `saveLocalFile` calls `set` from `idb-keyval` internally. This opens, executes, and closes a separate IndexedDB database transaction for *every single file*. Doing this sequentially is extremely slow due to the high setup/commit overhead of transactions in browsers.
* **Remediation:**
  * **Implement bulk operations:** Expose a batch writing helper in `storage.ts` that opens a single `readwrite` transaction and writes all records in one go. This can speed up synchronization from minutes to seconds for repositories with hundreds of files.

---

## 2. Medium Impact Optimizations

### A. Prevent Global Render Cascades (App State Isolation)
* **Location:** [App.tsx](file:///d:/Programs/code-stuff/notes/src/App.tsx)
* **Finding:** Root state variables (e.g., sidebar collapse, search triggers, active line highlights, modal indicators) reside directly in `App.tsx`. Because `App` wraps the entire layout, minor state changes (like typing a query in the search modal or expanding a folder node) cause the entire tree to re-evaluate.
* **Remediation:**
  * **Memoize Major Views:** Wrap large components like `Sidebar`, `Editor`, and `CanvasView` in `React.memo` to skip rendering cycles if their respective input props have not changed.
  * **Localized State:** Push local UI indicators (e.g., `newFolderName` input text or `renameInputValue`) down into the modal components rather than managing them at the root level.

### B. Host Fonts Locally (Offline Readiness & Round-trip Savings)
* **Location:** [index.html](file:///d:/Programs/code-stuff/notes/index.html#L38-L43) and [sw.js](file:///d:/Programs/code-stuff/notes/public/sw.js#L44-L47)
* **Finding:** Google Fonts are loaded from the external `fonts.googleapis.com` stylesheet link. Because the Service Worker only handles same-origin requests, these remote stylesheets and font files are skipped from SW pre-caching:
  ```javascript
  if (requestUrl.origin !== self.location.origin) { return; }
  ```
  This creates external dependency lookups, delaying the text rendering (FOUT) on load, and leaves fonts un-cached if the browser cache is cleared offline.
* **Remediation:**
  * Self-host fonts inside the project folder. Download `Inter` and `Outfit` fonts into `/public/fonts` or utilize `@fontsource/inter` / `@fontsource/outfit` NPM bundles.
  * Update `index.html` to load fonts locally, enabling the Service Worker to fetch and cache them under `STATIC_ASSETS` for true offline-first performance.

---

## 3. Low Impact & Code Hygiene

### A. Refine Language Registrations in Highlight.js
* **Location:** [markdownEngine.ts](file:///d:/Programs/code-stuff/notes/src/lib/markdownEngine.ts#L13-L52)
* **Finding:** Although importing specific language modules is better than registering the entire package, importing 15+ complex language modules statically still adds parsing overhead during load.
* **Remediation:**
  * Only load the top 4-5 most commonly used note-taking formats (e.g., `markdown`, `bash`, `javascript`, `json`) statically.
  * Load more specialized definitions dynamically on-demand when code blocks of that language type are parsed in the viewport.

### B. Increase Concurrency on Fallback Individual Fetches
* **Location:** [github.ts](file:///d:/Programs/code-stuff/notes/src/services/github.ts#L627-L648)
* **Finding:** When GraphQL bulk fetching fails, the application falls back to fetching files individually in parallel using a concurrency limit of 5.
* **Remediation:**
  * For vaults containing many small files (less than 10KB), the concurrency limit can be safely bumped to `8` or `10`. This maximizes parallel network requests and reduces fallback sync times without hitting standard browser request throttling limits.
