# Starfish Notes - Performance Posture Analysis

This document evaluates the performance posture of the **Starfish Notes** application. While the client-side database cache (IndexedDB via `idb-keyval`) and GraphQL batch fetches are architectural strengths, there are several critical computational and rendering bottlenecks that will degrade performance as vault size grows.

---

## 1. Critical Performance Bottlenecks

### 1.1 Database View Backlink Scans (`src/components/BaseEditor.tsx`)
*   **The Issue:** The `.base` database editor calculates note backlinks dynamically in `calculateBacklinks` on every render for every row in the table view.
*   **The Mechanic:** To compute backlinks for a single note, the code loops through the entire vault contents (`Object.entries(fileContents)`) and performs multiple regex queries (for wiki-links and markdown links) or parses JSON (for canvas files).
*   **Complexity:** For $R$ rows in a database table and $N$ files in the vault, the algorithm performs $O(R \cdot N)$ full-text scans.
*   **Performance Impact:** Whenever *any* file is preloaded or updated (e.g. while typing a character), React state changes, forcing the database component to re-render. A medium-sized vault (e.g., 500 files, 100 table rows) will run **50,000 regex scans per key stroke**, completely freezing the browser's main thread and causing severe typing lag.
*   **Optimization Recommendation:** 
    *   Maintain a global, reactive **Link Reference Graph** that updates incrementally only when the active file is saved.
    *   Look up backlinks in $O(1)$ from this pre-computed graph rather than running full-text regex scans on render.

### 1.2 Layout Thrashing in Editor Windowing (`src/components/Editor.tsx`)
*   **The Issue:** For large documents ($>50$ KB), the editor implements a virtual windowing mode (rendering 300 lines at a time). However, to measure lines dynamically, it calls `measureLineHeights` in a `useLayoutEffect` on every scroll, caret movement, and change.
*   **The Mechanic:** `measureLineHeights` creates an invisible mirror `div`, appends it to the DOM, writes up to 300 lines of text, batch-reads `clientHeight` on each element, and then wipes it.
*   **Performance Impact:** Reading layout metrics (`clientHeight`) immediately after modifying DOM elements forces the browser to run a **forced synchronous layout (reflow)**. Triggering this repeatedly during scroll and typing events blocks the browser's rendering thread, causing laggy scrolling, visual jumps, and typing stuttering.
*   **Optimization Recommendation:**
    *   Compute and cache line heights once on note load, updating heights only for lines that are edited.
    *   Switch to a CSS-driven virtualizer with fixed-height lines or use `IntersectionObserver` to compute line visibility without DOM writes and layout thrashing.

---

## 2. High & Medium Severity Bottlenecks

### 2.1 Unthrottled State Updates on Canvas Drag/Resize (`src/components/CanvasView.tsx`)
*   **The Issue:** Dragging canvas cards or resizing nodes registers events on `mousemove` / `touchmove` and dispatches state updates (`setNodes`) directly on every mouse movement.
*   **Performance Impact:** State updates are dispatched up to 120 times per second, triggering full React render passes on the entire `CanvasView` component. Each render pass executes DOM purification and Markdown compilation (`renderCanvasMarkdown`) on all visible nodes, dropping frame rates and causing laggy dragging.
*   **Optimization Recommendation:**
    *   Decouple visual drag states from React component state: update drag offsets directly on the DOM nodes using hardware-accelerated CSS `transform: translate3d(...)`.
    *   Only dispatch the React state commit (`setNodes`) once on drag end (`mouseup` / `touchend`).
    *   Alternatively, throttle the drag state dispatcher to 60fps using `requestAnimationFrame`.

### 2.2 $O(N^2)$ Repulsion Physics in Graph View (`src/components/GraphView.tsx`)
*   **The Issue:** The force-directed graph view calculates node repulsion via a nested double loop over all nodes in the graph on every frame.
*   **Performance Impact:** As nodes ($N$) scale, calculations increase quadratically ($O(N^2)$). At $N = 500$, this results in 250,000 checks per frame. In addition, rendering visual glows (`ctx.shadowBlur`) and rendering text labels on canvas are slow GPU-bound canvas operations that can stutter animations.
*   **Optimization Recommendation:**
    *   Implement the **Barnes-Hut algorithm** ($O(N \log N)$) to group distant nodes and reduce force calculations.
    *   Disable high-overhead features like `shadowBlur` during active drag/pan events.
    *   Render node text labels as absolute-positioned DOM elements layered on top of the canvas, which allows the browser's layout engine to handle text updates efficiently.

---

## 3. Architecture Strengths (Optimized Postures)

While computational bottlenecks exist on the UI layer, the network and storage layers are highly optimized:

1.  **GraphQL Batch Fetches:**
    *   `syncVault` fetches up to 50 note contents in a single GraphQL query, avoiding HTTP request bottlenecks and protecting the user from GitHub API rate limits.
2.  **Bulk Storage Operations:**
    *   Saves database modifications in a single IndexedDB transaction using `saveLocalFilesBatch`, which significantly speeds up syncing.
3.  **Code Splitting:**
    *   Main editor modules (`Editor`, `CanvasView`, `GraphView`, `BaseEditor`) are loaded asynchronously using `React.lazy()`, reducing the application's initial bundle size and load time.
