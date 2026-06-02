/**
 * StarfishNotes Cryptography & Protected Storage Utilities
 * Secure client-side credentials management incorporating:
 * 1. Web Crypto API (AES-GCM-256 + PBKDF2 key derivation)
 * 2. W3C Credentials Management API (OS-Level Secure Vault/Keychain integration)
 * 3. Tab Session memory storage for reload resilience
 */

// Helper: Convert ArrayBuffer to Hex string
function bufToHex(buffer: ArrayBuffer): string {
  const byteArray = new Uint8Array(buffer);
  return Array.from(byteArray)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

// Helper: Convert Hex string to ArrayBuffer
function hexToBuf(hexString: string): ArrayBuffer {
  const matches = hexString.match(/[\da-f]{2}/gi) || [];
  const typedArray = new Uint8Array(matches.map(h => parseInt(h, 16)));
  return typedArray.buffer;
}

// Helper: Convert string to Uint8Array UTF-8
function strToBuf(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

// Helper: Convert ArrayBuffer to string UTF-8
function bufToStr(buf: ArrayBuffer): string {
  return new TextDecoder().decode(buf);
}

/**
 * Derives a cryptographic key from a user passphrase and salt using PBKDF2
 */
async function deriveKey(passphrase: string, salt: Uint8Array): Promise<CryptoKey> {
  const baseKey = await window.crypto.subtle.importKey(
    'raw',
    strToBuf(passphrase) as BufferSource, // Cast to BufferSource to satisfy browser subtle crypto API constraints
    { name: 'PBKDF2' },
    false,
    ['deriveBits', 'deriveKey']
  );

  return window.crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt: salt as BufferSource, // Cast to BufferSource to satisfy browser subtle crypto API constraints
      iterations: 100000,
      hash: 'SHA-256'
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Encrypts a plain-text token using a passphrase
 * Returns a self-contained string format: "salt_hex:iv_hex:ciphertext_hex"
 * @preserve-caught-error
 */
export async function encryptToken(plainText: string, passphrase: string): Promise<string> {
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));

  const key = await deriveKey(passphrase, salt);

  const cipherBuffer = await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource // Cast to BufferSource to satisfy browser subtle crypto API constraints
    },
    key,
    strToBuf(plainText) as BufferSource
  );

  const saltHex = bufToHex(salt.buffer);
  const ivHex = bufToHex(iv.buffer);
  const cipherHex = bufToHex(cipherBuffer);

  return `${saltHex}:${ivHex}:${cipherHex}`;
}

/**
 * Decrypts a formatted ciphertext string using a passphrase
 * Throws an error if decryption fails (e.g. wrong passphrase)
 * @preserve-caught-error
 */
export async function decryptToken(encryptedData: string, passphrase: string): Promise<string> {
  const parts = encryptedData.split(':');
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format.');
  }

  const [saltHex, ivHex, cipherHex] = parts;
  const salt = new Uint8Array(hexToBuf(saltHex));
  const iv = new Uint8Array(hexToBuf(ivHex));
  const cipherBuffer = hexToBuf(cipherHex);

  const key = await deriveKey(passphrase, salt);

  try {
    const plainBuffer = await window.crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: iv as BufferSource // Cast to BufferSource to satisfy browser subtle crypto API constraints
      },
      key,
      cipherBuffer
    );
    return bufToStr(plainBuffer);
  } catch (error: unknown) {
    throw new Error('Incorrect master passphrase or corrupted token.', { cause: error });
  }
}

/**
 * Storage Keys configuration
 */
export const STORAGE_KEYS = {
  ENCRYPTED_PAT: 'starfishnotes_enc_pat',
  PLAINTEXT_PAT: 'starfishnotes_plain_pat',
  STORAGE_MODE: 'starfishnotes_storage_mode',
  REPO_NAME: 'starfishnotes_repo',
  BRANCH_NAME: 'starfishnotes_branch',
};

export type StorageMode = 'memory' | 'session' | 'encrypted' | 'plain' | 'keychain';

/**
 * Save token securely based on active StorageMode
 * @preserve-caught-error
 */
export async function saveTokenSecurely(
  token: string,
  mode: StorageMode,
  passphrase?: string,
  repoName: string = 'StarfishNotes'
): Promise<void> {
  // Always clean previous values to prevent storage confusion
  localStorage.removeItem(STORAGE_KEYS.ENCRYPTED_PAT);
  localStorage.removeItem(STORAGE_KEYS.PLAINTEXT_PAT);
  sessionStorage.removeItem(STORAGE_KEYS.PLAINTEXT_PAT);

  localStorage.setItem(STORAGE_KEYS.STORAGE_MODE, mode);

  if (mode === 'session') {
    sessionStorage.setItem(STORAGE_KEYS.PLAINTEXT_PAT, token);
  } else if (mode === 'encrypted') {
    if (!passphrase) throw new Error('Passphrase required for encrypted storage mode.');
    const encrypted = await encryptToken(token, passphrase);
    localStorage.setItem(STORAGE_KEYS.ENCRYPTED_PAT, encrypted);

    // Cache the decrypted token in sessionStorage for page reload resilience
    sessionStorage.setItem(STORAGE_KEYS.PLAINTEXT_PAT, token);
  } else if (mode === 'plain') {
    localStorage.setItem(STORAGE_KEYS.PLAINTEXT_PAT, token);
  } else if (mode === 'keychain') {
    // Check W3C Credentials Management API support
    if ('PasswordCredential' in window) {
      try {
        const PasswordCred = (window as unknown as { PasswordCredential: new (options: { id: string; password: string; name: string }) => Credential }).PasswordCredential;
        const credential = new PasswordCred({
          id: repoName,         // Link the credential to this vault identifier
          password: token,      // The GitHub token acts as the credential password
          name: 'StarfishNotes Synchronizer'
        });
        await navigator.credentials.store(credential);

        // Cache in sessionStorage to satisfy standard reload resilience
        sessionStorage.setItem(STORAGE_KEYS.PLAINTEXT_PAT, token);
      } catch (err: unknown) {
        throw new Error('OS Vault rejected saving token. Make sure page is loaded over HTTPS/localhost.', { cause: err });
      }
    } else {
      throw new Error('Native Protected Storage (Credentials Management API) is not supported by this browser.');
    }
  }
}

/**
 * Retrieve token based on storage mode
 * If keychain is selected, retrieves from the OS secure manager.
 */
export async function retrieveTokenSecurely(passphrase?: string): Promise<string | null> {
  const mode = (localStorage.getItem(STORAGE_KEYS.STORAGE_MODE) || 'memory') as StorageMode;

  // 1. Session and Cached tokens reside in sessionStorage.
  // This automatically satisfies the F5 page reload requirement!
  const cached = sessionStorage.getItem(STORAGE_KEYS.PLAINTEXT_PAT);
  if (cached) {
    return cached;
  }

  if (mode === 'plain') {
    return localStorage.getItem(STORAGE_KEYS.PLAINTEXT_PAT);
  }

  if (mode === 'encrypted') {
    const encrypted = localStorage.getItem(STORAGE_KEYS.ENCRYPTED_PAT);
    if (!encrypted) return null;

    if (!passphrase) {
      // Indicates we need to prompt the user for their passphrase
      return null;
    }

    const decrypted = await decryptToken(encrypted, passphrase);

    // Cache the decrypted token in sessionStorage to protect future reloads
    sessionStorage.setItem(STORAGE_KEYS.PLAINTEXT_PAT, decrypted);
    return decrypted;
  }

  if (mode === 'keychain') {
    if ('PasswordCredential' in window) {
      try {
        const credential = await navigator.credentials.get({
          password: true,
          mediation: 'required'
        } as unknown as CredentialRequestOptions);
        if (credential) {
          const token = (credential as unknown as { password?: string }).password || null;
          if (token) {
            // Cache in sessionStorage for friction-free reload persistence
            sessionStorage.setItem(STORAGE_KEYS.PLAINTEXT_PAT, token);
            return token;
          }
        }
      } catch {
        // Retrieval failed or user cancelled OS Hello prompt
        return null;
      }
    }
  }

  return null;
}

/**
 * Completely purges all stored credentials (log out)
 */
export function purgeCredentials(): void {
  localStorage.removeItem(STORAGE_KEYS.ENCRYPTED_PAT);
  localStorage.removeItem(STORAGE_KEYS.PLAINTEXT_PAT);
  localStorage.removeItem(STORAGE_KEYS.STORAGE_MODE);
  localStorage.removeItem(STORAGE_KEYS.REPO_NAME);
  localStorage.removeItem(STORAGE_KEYS.BRANCH_NAME);
  sessionStorage.removeItem(STORAGE_KEYS.PLAINTEXT_PAT);

  if ('PasswordCredential' in window && navigator.credentials.preventSilentAccess) {
    // Prevents automatic login in future until explicitly triggered
    navigator.credentials.preventSilentAccess();
  }
}
