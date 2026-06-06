/**
 * Starfish Notes Cryptography & Protected Storage Utilities
 * Secure client-side credentials management incorporating:
 * 1. Web Crypto API (AES-GCM-256 + PBKDF2 key derivation)
 * 2. W3C Credentials Management API (OS-Level Secure Vault/Keychain integration)
 * 3. Tab Session memory storage for reload resilience
 */

import { offlineStorage } from '../services/offlineStorage';

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
 * Retrieve or generate a non-extractable 256-bit AES-GCM key stored in IndexedDB meta store
 */
async function getOrCreateSystemKey(): Promise<CryptoKey> {
  const existingKey = await offlineStorage.getMeta<CryptoKey>('system_cryptokey');
  if (existingKey) {
    return existingKey;
  }

  const newKey = await window.crypto.subtle.generateKey(
    {
      name: 'AES-GCM',
      length: 256,
    },
    false, // extractable: false (so key cannot be exported via exportKey)
    ['encrypt', 'decrypt']
  );

  await offlineStorage.saveMeta('system_cryptokey', newKey);
  return newKey;
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
  repoName: string = 'Starfish Notes'
): Promise<void> {
  // Always clean previous values to prevent storage confusion
  localStorage.removeItem(STORAGE_KEYS.ENCRYPTED_PAT);
  localStorage.removeItem(STORAGE_KEYS.PLAINTEXT_PAT);
  sessionStorage.removeItem(STORAGE_KEYS.PLAINTEXT_PAT);

  localStorage.setItem(STORAGE_KEYS.STORAGE_MODE, mode);

  if (mode === 'session') {
    try {
      const key = await getOrCreateSystemKey();
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const ciphertextBuffer = await window.crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: iv as BufferSource
        },
        key,
        strToBuf(token) as BufferSource
      );
      const ivHex = bufToHex(iv.buffer);
      const cipherHex = bufToHex(ciphertextBuffer);
      sessionStorage.setItem(STORAGE_KEYS.PLAINTEXT_PAT, `${ivHex}:${cipherHex}`);
    } catch (e) {
      console.error('Failed to securely encrypt session token:', e);
      sessionStorage.setItem(STORAGE_KEYS.PLAINTEXT_PAT, token);
    }
  } else if (mode === 'encrypted') {
    if (!passphrase) throw new Error('Passphrase required for encrypted storage mode.');
    const encrypted = await encryptToken(token, passphrase);
    localStorage.setItem(STORAGE_KEYS.ENCRYPTED_PAT, encrypted);
  } else if (mode === 'plain') {
    try {
      const key = await getOrCreateSystemKey();
      const iv = window.crypto.getRandomValues(new Uint8Array(12));
      const ciphertextBuffer = await window.crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv: iv as BufferSource
        },
        key,
        strToBuf(token) as BufferSource
      );

      const ivHex = bufToHex(iv.buffer);
      const cipherHex = bufToHex(ciphertextBuffer);
      localStorage.setItem(STORAGE_KEYS.PLAINTEXT_PAT, `${ivHex}:${cipherHex}`);
    } catch (e) {
      console.error('Failed to securely encrypt plain token, falling back to cleartext:', e);
      localStorage.setItem(STORAGE_KEYS.PLAINTEXT_PAT, token);
    }
  } else if (mode === 'keychain') {
    // Check W3C Credentials Management API support
    if ('PasswordCredential' in window) {
      try {
        const PasswordCred = (window as unknown as { PasswordCredential: new (options: { id: string; password: string; name: string }) => Credential }).PasswordCredential;
        const credential = new PasswordCred({
          id: repoName,         // Link the credential to this vault identifier
          password: token,      // The GitHub token acts as the credential password
          name: 'Starfish Notes Synchronizer'
        });
        await navigator.credentials.store(credential);
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
export async function retrieveTokenSecurely(passphrase?: string, interactive = false): Promise<string | null> {
  const mode = (localStorage.getItem(STORAGE_KEYS.STORAGE_MODE) || 'memory') as StorageMode;

  if (mode === 'session') {
    const stored = sessionStorage.getItem(STORAGE_KEYS.PLAINTEXT_PAT);
    if (!stored) return null;

    const isEncryptedFormat = /^[\da-fA-F]+:[\da-fA-F]+$/.test(stored);
    if (isEncryptedFormat) {
      try {
        const parts = stored.split(':');
        const ivHex = parts[0];
        const cipherHex = parts[1];

        const iv = new Uint8Array(hexToBuf(ivHex));
        const cipherBuffer = hexToBuf(cipherHex);
        const key = await getOrCreateSystemKey();

        const decryptedBuffer = await window.crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: iv as BufferSource
          },
          key,
          cipherBuffer
        );

        return bufToStr(decryptedBuffer);
      } catch (e) {
        console.error('Failed to decrypt session mode token:', e);
        return null;
      }
    } else {
      return stored;
    }
  }

  if (mode === 'plain') {
    const stored = localStorage.getItem(STORAGE_KEYS.PLAINTEXT_PAT);
    if (!stored) return null;

    const isEncryptedFormat = /^[\da-fA-F]+:[\da-fA-F]+$/.test(stored);

    if (isEncryptedFormat) {
      try {
        const parts = stored.split(':');
        const ivHex = parts[0];
        const cipherHex = parts[1];

        const iv = new Uint8Array(hexToBuf(ivHex));
        const cipherBuffer = hexToBuf(cipherHex);
        const key = await getOrCreateSystemKey();

        const decryptedBuffer = await window.crypto.subtle.decrypt(
          {
            name: 'AES-GCM',
            iv: iv as BufferSource
          },
          key,
          cipherBuffer
        );

        return bufToStr(decryptedBuffer);
      } catch (e) {
        console.error('Failed to decrypt plain mode token:', e);
        return null;
      }
    } else {
      console.log('Migrating legacy plaintext token to secure IndexedDB-keyed format...');
      try {
        await saveTokenSecurely(stored, 'plain');
      } catch (e) {
        console.error('Failed to migrate plain token, returning plaintext:', e);
      }
      return stored;
    }
  }

  if (mode === 'encrypted') {
    const encrypted = localStorage.getItem(STORAGE_KEYS.ENCRYPTED_PAT);
    if (!encrypted) return null;

    if (!passphrase) {
      // Indicates we need to prompt the user for their passphrase
      return null;
    }

    const decrypted = await decryptToken(encrypted, passphrase);
    return decrypted;
  }

  if (mode === 'keychain') {
    if ('PasswordCredential' in window) {
      try {
        const credential = await navigator.credentials.get({
          password: true,
          mediation: interactive ? 'required' : 'silent'
        } as unknown as CredentialRequestOptions);
        if (credential) {
          const token = (credential as unknown as { password?: string }).password || null;
          if (token) {
            return token;
          }
        }
      } catch (e) {
        console.warn('Keychain retrieval failed', e);
        return null;
      }
    }
  }

  return null;
}

/**
 * Completely purges all stored credentials and app state (log out).
 * Iterates by prefix to catch every starfishnotes* key — current and future.
 */
export function purgeCredentials(): void {
  // Collect and remove ALL starfishnotes-prefixed keys from localStorage
  const lsKeysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('starfishnotes')) {
      lsKeysToRemove.push(key);
    }
  }
  lsKeysToRemove.forEach(key => localStorage.removeItem(key));

  // Collect and remove ALL starfishnotes-prefixed keys from sessionStorage
  const ssKeysToRemove: string[] = [];
  for (let i = 0; i < sessionStorage.length; i++) {
    const key = sessionStorage.key(i);
    if (key && key.startsWith('starfishnotes')) {
      ssKeysToRemove.push(key);
    }
  }
  ssKeysToRemove.forEach(key => sessionStorage.removeItem(key));

  if ('PasswordCredential' in window && navigator.credentials.preventSilentAccess) {
    // Prevents automatic login in future until explicitly triggered
    navigator.credentials.preventSilentAccess();
  }
}

/**
 * Encrypts a string using the browser-bound system CryptoKey
 */
export async function encryptWithSystemKey(plainText: string): Promise<string> {
  const key = await getOrCreateSystemKey();
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const ciphertextBuffer = await window.crypto.subtle.encrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource
    },
    key,
    strToBuf(plainText) as BufferSource
  );
  const ivHex = bufToHex(iv.buffer);
  const cipherHex = bufToHex(ciphertextBuffer);
  return `${ivHex}:${cipherHex}`;
}

/**
 * Decrypts a string using the browser-bound system CryptoKey
 */
export async function decryptWithSystemKey(cipherText: string): Promise<string> {
  const parts = cipherText.split(':');
  if (parts.length !== 2) {
    throw new Error('Invalid system-encrypted format.');
  }
  const [ivHex, cipherHex] = parts;
  const iv = new Uint8Array(hexToBuf(ivHex));
  const cipherBuffer = hexToBuf(cipherHex);
  const key = await getOrCreateSystemKey();
  const decryptedBuffer = await window.crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: iv as BufferSource
    },
    key,
    cipherBuffer
  );
  return bufToStr(decryptedBuffer);
}

/**
 * Retrieves or generates a system-wide passphrase for database encryption
 */
export async function getOrCreateSystemVaultPassphrase(): Promise<string> {
  const stored = localStorage.getItem('starfishnotes_sys_vault_pass');
  if (stored) {
    try {
      return await decryptWithSystemKey(stored);
    } catch (e) {
      console.error('Failed to decrypt system vault passphrase, regenerating:', e);
    }
  }

  // Generate a new random 32-character passphrase (16 bytes)
  const randomBytes = window.crypto.getRandomValues(new Uint8Array(16));
  const newPass = Array.from(randomBytes).map(b => b.toString(16).padStart(2, '0')).join('');
  const encrypted = await encryptWithSystemKey(newPass);
  localStorage.setItem('starfishnotes_sys_vault_pass', encrypted);
  return newPass;
}

