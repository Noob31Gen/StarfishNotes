# Starfish Notes - Security Audit & Recommendations

This document contains a detailed analysis of the security posture of Starfish Notes, along with actionable recommendations to harden the application. All proposed changes can be implemented without affecting the current visual design or core user functionality (or only moderately affecting functionality).

---

## 1. High Priority Improvements

### A. Harden Content Security Policy (CSP)
* **Location:** [index.html](file:///d:/Programs/code-stuff/notes/index.html#L11-L12)
* **Finding:** The current CSP includes `'unsafe-inline'` and `'unsafe-eval'` in `script-src`:
  ```html
  content="default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' ...;"
  ```
  This effectively negates the primary benefit of a CSP against Cross-Site Scripting (XSS). If an attacker finds a bypass in the Markdown parser, Mermaid renderer, or Canvas parser, they can execute arbitrary inline scripts.
* **Remediation:**
  * Remove `'unsafe-inline'` and `'unsafe-eval'` from `script-src` in production.
  * Vite automatically bundles and hashes scripts, so inline scripts should not be required. If inline scripts are absolutely necessary, use a CSP cryptographic nonce or SHA-256 hashes for those specific blocks.

### B. Restrict Allowed Protocols in DOMPurify
* **Location:** [Editor.tsx](file:///d:/Programs/code-stuff/notes/src/components/Editor.tsx#L625) and [CanvasView.tsx](file:///d:/Programs/code-stuff/notes/src/components/CanvasView.tsx#L480)
* **Finding:** The `ALLOWED_URI_REGEXP` configuration for DOMPurify explicitly allows `data:` and `file:` URI schemes:
  ```typescript
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|ftp|tel|file|sms|blob|data):|[^&:/?#]*(?:[/?#]|$))/i
  ```
  * `data:` URIs are highly dangerous as they can contain inline HTML or scripts (e.g., `data:text/html;base64,...`), providing an easy vector for XSS if links are clicked or parsed dynamically.
  * `file:` URIs can leak local file system details if loaded or linked, especially in containerized or desktop environments.
* **Remediation:**
  * Tighten the regular expression to disallow `data:` and `file:` protocols in general user-generated markdown links.
  * If base64 image previews are required, allow `data:` URIs strictly in `img-src` contexts, but strip them from standard anchor hrefs.
  ```typescript
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|sms|blob):|[^&:/?#]*(?:[/?#]|$))/i
  ```

### C. Secure Iframe Sandboxing & Source Control
* **Location:** [main.tsx](file:///d:/Programs/code-stuff/notes/src/main.tsx#L8-L12)
* **Finding:** The application allows the rendering of iframes in markdown and dynamically adds a sandbox attribute:
  ```typescript
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'IFRAME') {
      node.setAttribute('sandbox', 'allow-scripts allow-popups');
    }
  });
  ```
  While omitting `allow-same-origin` correctly isolates the iframe's cookie and storage context, allowing `allow-scripts` on arbitrary third-party domains introduces risks of background cryptomining, clickjacking, or aggressive redirects/popups. Additionally, DOMPurify does not restrict the domains that iframes can point to.
* **Remediation:**
  * Implement an iframe source domain whitelist. Only allow embedding from recognized, safe domains (e.g., YouTube, Vimeo, PDF viewers, or specific user-defined domains).
  * Block unknown iframe sources in the markdown renderer before they reach the DOM.

---

## 2. Medium Priority Improvements

### A. Increase Cryptographic PBKDF2 Iteration Count
* **Location:** [crypto.ts](file:///d:/Programs/code-stuff/notes/src/utils/crypto.ts#L74)
* **Finding:** The key derivation function uses 100,000 iterations for PBKDF2-HMAC-SHA256:
  ```typescript
  name: 'PBKDF2',
  salt: salt,
  iterations: 100000,
  hash: 'SHA-256'
  ```
  While 100,000 iterations is a reasonable baseline, OWASP currently recommends a minimum of **600,000 iterations** for PBKDF2-HMAC-SHA256 to provide robust resistance against modern offline brute-force attacks on user passphrases.
* **Remediation:**
  * Increase the iteration count to `600000`. Because this happens client-side using the native Web Crypto API, the performance hit is negligible on modern devices (taking only a fraction of a second during unlocking) but increases security significantly.
  * *Note: Changing this will invalidate existing encrypted local storage vaults. A migration pathway (attempting decryption with 100k, then upgrading to 600k on re-save) should be implemented to ensure users do not lose access.*

### B. Mitigate Shared-Origin Vulnerabilities (Keychain Storage Mode)
* **Location:** [crypto.ts](file:///d:/Programs/code-stuff/notes/src/utils/crypto.ts#L217-L234)
* **Finding:** The "Keychain" storage mode uses the W3C Credentials Management API (`PasswordCredential`) to store GitHub Personal Access Tokens (PATs) under the browser's credential store.
  If the application is hosted on a shared platform domain (e.g., `*.github.io`, `*.netlify.app`, `*.vercel.app`) rather than a dedicated custom domain (like `notes.noob31.com`), other applications running on the same domain could fetch those credentials using `navigator.credentials.get()`.
* **Remediation:**
  * Add a warning in the UI or documentation alerting users that the "Keychain" storage mode should only be used when hosted on a dedicated custom domain (where same-origin constraints isolate storage).
  * Automatically disable or flag Keychain storage mode if `window.location.hostname` matches known shared-hosting suffixes.

### C. Clarify IndexedDB System Key Threat Model
* **Location:** [crypto.ts](file:///d:/Programs/code-stuff/notes/src/utils/crypto.ts#L39-L56)
* **Finding:** The "Browser-bound System-key" mode (`plain`) generates an AES-GCM key with `extractable: false` and stores it in IndexedDB.
  While setting `extractable: false` prevents an attacker from extracting the raw cryptographic key bytes, the `CryptoKey` reference object remains in IndexedDB. Any script executing on the same origin (such as during XSS) can load the key reference and call `window.crypto.subtle.decrypt` to read notes or cached GitHub credentials.
* **Remediation:**
  * Document that "System-key" mode only protects data from device theft/unauthorized local file access, not from running XSS exploits.
  * Encourage users to use the "Master Passphrase" mode (`encrypted`) for high-security note vaults, as it derives the decryption key on-demand in memory from user input and does not persist keys on disk.

---

## 3. Low Priority & Best Practices

### A. CSV / TSV Formula Injection (CSV Injection) Prevention
* **Location:** [Editor.tsx](file:///d:/Programs/code-stuff/notes/src/components/Editor.tsx#L25-L95)
* **Finding:** The spreadsheet parser converts and allows editing of CSV/TSV data directly in tables. If a user pastes spreadsheet cells starting with formula trigger characters (`=`, `+`, `-`, `@`), and subsequently exports the note to a CSV file to open in Excel or Google Sheets, the spreadsheet software will execute those cells as commands, leading to client-side formula execution attacks.
* **Remediation:**
  * When writing or exporting CSV content, sanitize cells starting with formula characters. A standard practice is to prefix such values with a single quote `'` or double quotes to force Excel/Sheets to treat them as literal text.

### B. Enforce Mermaid Secure Rendering Mode
* **Location:** [markdownEngine.ts](file:///d:/Programs/code-stuff/notes/src/lib/markdownEngine.ts#L94-L102) and [CanvasView.tsx](file:///d:/Programs/code-stuff/notes/src/components/CanvasView.tsx#L348)
* **Finding:** Mermaid diagrams are parsed and rendered inline. Historically, Mermaid has suffered from multiple XSS bugs within its internal diagram parsers (e.g., in node labels or tooltips).
* **Remediation:**
  * Configure Mermaid's initialization parameters to use `securityLevel: 'strict'`. This forces Mermaid to render all tags within sandboxed iframes or sanitizes input characters, preventing script injection inside complex charts.

### C. Scan and Lock Dependencies
* **Location:** [package.json](file:///d:/Programs/code-stuff/notes/package.json)
* **Finding:** Several dependencies carry security implications (e.g., `jszip` has historical path traversal vulnerabilities, and `mermaid` has script injection risks).
* **Remediation:**
  * Run `npm audit` regularly to patch nested dependencies.
  * Ensure `jszip` is locked to version `3.10.2` or later to fix known compression format parser issues.
