# Starfish Notes - Architecture and Functionality Analysis

**Starfish Notes** is a fully client-side, offline-first note-taking application designed as a web-based alternative to Obsidian. It is built using React, Vite, and TypeScript, and relies on GitHub as a remote storage and synchronization backend.

Below is a detailed breakdown of the application's core systems, features, and file formats.

---

## 1. Core Core Features & Editors

### 1.1 Rich Markdown Editor (`src/components/Editor.tsx`)
*   **Preview Mode:** Offers a non-invasive live preview mode side-by-side or as a toggle.
*   **LaTeX Math Rendering:** Renders math blocks and inline formulas.
*   **Mermaid.js integration:** Displays diagrams and flowcharts dynamically from text.
*   **Asset/Attachment Previews:** Embedded images, PDFs, and binary attachments are parsed and displayed inside notes using custom card components.
*   **Wiki-link resolving:** Renders Obsidian-style `[[Note Name]]` wiki-links as internal hyperlink triggers that open target notes.

### 1.2 Interactive Whiteboard / Canvas (`src/components/CanvasView.tsx`)
*   **Obsidian Canvas Compatibility:** Fully compatible with Obsidian `.canvas` files.
*   **Node Types:** Supports `text` (markdown cards) and `file` nodes (images, PDFs, or other text notes) positioned in a virtual workspace.
*   **Interactive Connections:** Users can draw connection edges between nodes on specific connection points (`top`, `right`, `bottom`, `left`).
*   **Zoom & Pan:** Infinite canvas panning (via drag) and zooming (via scroll wheel or pinch gestures on mobile devices).
*   **Undo/Redo Stack:** Maintains a history stack up to 50 operations.
*   **Caret autocomplete:** Displays note/image search dropdown suggestions when typing double brackets `[[` inside text cards.
*   **Auto-save:** Automatically serializes node coordinates and contents to JSON and updates the underlying file.

### 1.3 Metadata Databases (`src/components/BaseEditor.tsx`)
*   **Obsidian Dataview / Notion-like Databases:** Integrates custom `.base` files to let users view, filter, and sort files in a specific folder.
*   **Properties Integration:** Automatically parses Markdown Frontmatter (YAML blocks) and extracts note properties (e.g. `tags`, `author`, `date`, `version`).
*   **Metadata Fields:** Provides automatic column options like created/modified times, backlink counts, wiki-links list, file size, word counts, and file paths.
*   **Inline Editing:** Allows users to edit frontmatter attributes directly from cells in the table view, which rewrites the frontmatter in the target note.
*   **Direct YAML Configuration:** Users can switch view tabs to edit the database configuration directly as YAML.

---

## 2. Note Relationships & Graph View (`src/components/GraphView.tsx`)

*   **Force-Directed Physics Layout:** Employs an HTML5 Canvas drawing engine utilizing Hooke's spring attraction and Coulomb's repulsion laws to lay out note networks.
*   **Dynamic Visual Connections:** Draws paths between notes that reference each other. Hovering/touching a node highlights all connected sibling paths and fades out unrelated nodes.
*   **Interactive Controls:** Users can adjust gravity, spring stiffness, and repulsion parameters via a controls panel.
*   **Virtual Node Types:**
    *   **Markdown (`.md`) / Text (`.txt`)**
    *   **Canvas (`.canvas`)**
    *   **Database (`.base`)**
    *   **Ghost Notes:** Visualizes links referencing files that do not exist yet. These are colored differently (slate/dark grey) and allow the user to click to initialize/create the note.
*   **Filters:** Options to toggle canvas nodes, ghost nodes, or orphan notes (nodes with no connections).
*   **Search Highlight:** Highlights matching nodes with an emerald glow.

---

## 3. Cryptography & Secure Storage (`src/utils/crypto.ts` & `src/services/storage.ts`)

Starfish Notes features an advanced, multi-tiered security model that guarantees user keys, credentials, and notes are never stored in plaintext within the browser.

### 3.1 Encryption Schemes
*   **Key Derivation (PBKDF2):** Derives a strong 256-bit key from user-defined master passphrases using SHA-256 PBKDF2 hashing with 600,000 iterations (falls back to 100,000 iterations for legacy compatibility).
*   **Symmetric Encryption (AES-GCM-256):** Encrypts files and credentials client-side.
*   **Self-Contained Ciphertext:** Serialized ciphertext format is stored as `saltHex:ivHex:ciphertextHex`.

### 3.2 Storage Modes (`StorageMode`)
*   **`memory`**: GitHub Personal Access Token (PAT) is stored purely in volatile React state.
*   **`session`**: PAT is encrypted with a browser-bound system key stored in IndexedDB and saved in `sessionStorage` (lost on tab close).
*   **`plain`**: PAT is encrypted with a browser-bound system key and stored in `localStorage`.
*   **`encrypted`**: PAT is encrypted with a user-supplied master passphrase and stored in `localStorage`.
*   **`keychain`**: Uses the **W3C Credentials Management API** to store the PAT directly in the operating system's native keychain (e.g. Chrome Credential Manager, macOS Keychain) as a secure password credential under HTTPS/localhost.

### 3.3 Hashed Storage Layer (`src/services/storage.ts`)
*   **Path Obfuscation:** File paths are hashed using SHA-256 (`hashPath(path)`) before being written to IndexedDB. In IndexedDB, the key is `file_hash_${hashedPath}`.
*   **Metadata Encryption:** Both the path name and content are encrypted before saving, meaning browser extensions or malicious actors reading local IndexedDB storage cannot view file paths, folder structures, or document contents.

---

## 4. Offline Capability & GitHub Sync

### 4.1 Local Storage Cache (`src/services/offlineStorage.ts` & `idb-keyval`)
*   **IndexedDB Cache:** Utilizes the lightweight `idb-keyval` wrapper to save file representations (paths, names, content blobs, sizes, and Git SHAs) locally in browser database tables.
*   **Local-Only Mode:** Users can instantiate a local vault without logging into GitHub. Notes are stored in IndexedDB and can be exported as a ZIP or published to a remote GitHub repository later.

### 4.2 Sync Mechanism & Conflict Resolution (`src/components/ConflictResolutionModal.tsx`)
*   **Dormant Tab Checks:** Detects user inactivity. Includes active file idle detection (5 seconds) and inactive tab sleep detection (5 minutes).
*   **Sync & Comparison:** When the application resumes focus, it pulls the remote Git tree from GitHub and compares Git SHAs with local versions.
*   **Conflict Resolution:** If a file has been modified locally and remotely, it displays the Conflict Resolution Modal. This modal allows users to review affected files individually or in batches:
    *   **Keep Local:** Commits local edits over the remote GitHub copy.
    *   **Keep Remote:** Overwrites the local IndexedDB copy with the updated GitHub file.
    *   **Accept All Remote / Keep All Local:** Batch resolutions to make sync quick.
*   **Rate-Limit Protections:** Tracks API calls and handles rate limit headers. Pauses synchronization if GitHub rate limits are reached.
