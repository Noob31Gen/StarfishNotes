import { get, set, setMany, keys, del, delMany, clear } from 'idb-keyval';
import { getOrCreateSystemKey } from '../utils/crypto';

export interface LocalFile {
    content: string;
    sha: string;
    encryptedPath?: string;
    isEncrypted?: boolean;
}

async function hashPath(path: string): Promise<string> {
    const msgUint8 = new TextEncoder().encode(path);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

let encryptFn: ((plainText: string, key: string) => Promise<string>) | null = null;
let decryptFn: ((cipherText: string, key: string) => Promise<string>) | null = null;
let passphrase: string | null = null;

// --- System-key helpers (fast AES-GCM, no PBKDF2) ---

async function getSystemKey(): Promise<CryptoKey> {
    return getOrCreateSystemKey();
}

function bufToHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function hexToBuf(hexString: string): ArrayBuffer {
    const matches = hexString.match(/[\da-f]{2}/gi) || [];
    return new Uint8Array(matches.map(h => parseInt(h, 16))).buffer;
}

async function systemKeyEncrypt(plainText: string): Promise<string> {
    const key = await getSystemKey();
    const iv = window.crypto.getRandomValues(new Uint8Array(12));
    const encoded = new TextEncoder().encode(plainText);
    const cipherBuffer = await window.crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        encoded as BufferSource
    );
    return `${bufToHex(iv.buffer)}:${bufToHex(cipherBuffer)}`;
}

async function systemKeyDecrypt(cipherText: string): Promise<string> {
    const parts = cipherText.split(':');
    if (parts.length !== 2) throw new Error('Invalid system-encrypted format.');
    const [ivHex, cipherHex] = parts;
    const iv = new Uint8Array(hexToBuf(ivHex));
    const cipherBuffer = hexToBuf(cipherHex);
    const key = await getSystemKey();
    const decryptedBuffer = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: iv as BufferSource },
        key,
        cipherBuffer
    );
    return new TextDecoder().decode(decryptedBuffer);
}

// --- Public API ---

export function initStorageCrypto(
    encrypt: (plainText: string, key: string) => Promise<string>,
    decrypt: (cipherText: string, key: string) => Promise<string>
) {
    encryptFn = encrypt;
    decryptFn = decrypt;
}

export function setStoragePassphrase(key: string) {
    passphrase = key;
}

export function clearStoragePassphrase() {
    passphrase = null;
}

export async function saveLocalFile(path: string, data: LocalFile) {
    if (passphrase && encryptFn) {
        try {
            const hashedPath = await hashPath(path);
            const key = `file_hash_${hashedPath}`;
            const encryptedContent = await encryptFn(data.content, passphrase);
            const encryptedPath = await encryptFn(path, passphrase);
            
            await set(key, {
                content: encryptedContent,
                sha: data.sha,
                encryptedPath,
                isEncrypted: true
            });
            // Proactively delete legacy plaintext file if exists
            await del(`file_${path}`);
            return;
        } catch (e) {
            console.error('Failed to save local file with encryption:', e);
        }
    }
    
    // System-key encryption fallback (replaces plaintext storage)
    try {
        const hashedPath = await hashPath(path);
        const key = `file_hash_${hashedPath}`;
        const encryptedContent = await systemKeyEncrypt(data.content);
        const encryptedPath = await systemKeyEncrypt(path);
        
        await set(key, {
            content: encryptedContent,
            sha: data.sha,
            encryptedPath,
            isEncrypted: true
        });
        await del(`file_${path}`);
        return;
    } catch (e) {
        console.error('System-key encryption unavailable, saving in plaintext:', e);
    }

    await set(`file_${path}`, data);
}

export async function saveLocalFilesBatch(batch: { path: string; data: LocalFile }[]): Promise<void> {
    if (batch.length === 0) return;
    
    if (passphrase && encryptFn) {
        try {
            const entries: [string, LocalFile][] = [];
            const legacyKeysToDelete: string[] = [];
            
            await Promise.all(batch.map(async ({ path, data }) => {
                const hashedPath = await hashPath(path);
                const key = `file_hash_${hashedPath}`;
                const encryptedContent = await encryptFn!(data.content, passphrase!);
                const encryptedPath = await encryptFn!(path, passphrase!);
                
                entries.push([key, {
                    content: encryptedContent,
                    sha: data.sha,
                    encryptedPath,
                    isEncrypted: true
                }]);
                legacyKeysToDelete.push(`file_${path}`);
            }));
            
            await setMany(entries);
            await delMany(legacyKeysToDelete);
            return;
        } catch (e) {
            console.error('Failed to save local files batch with encryption:', e);
        }
    }
    
    // System-key encryption fallback (replaces plaintext batch storage)
    try {
        const entries: [string, LocalFile][] = [];
        const legacyKeysToDelete: string[] = [];
        
        await Promise.all(batch.map(async ({ path, data }) => {
            const hashedPath = await hashPath(path);
            const key = `file_hash_${hashedPath}`;
            const encryptedContent = await systemKeyEncrypt(data.content);
            const encryptedPath = await systemKeyEncrypt(path);
            
            entries.push([key, {
                content: encryptedContent,
                sha: data.sha,
                encryptedPath,
                isEncrypted: true
            }]);
            legacyKeysToDelete.push(`file_${path}`);
        }));
        
        await setMany(entries);
        await delMany(legacyKeysToDelete);
        return;
    } catch (e) {
        console.error('System-key batch encryption unavailable, saving in plaintext:', e);
    }

    // Final plaintext fallback (only if crypto.subtle is completely unavailable)
    const entries: [string, LocalFile][] = batch.map(({ path, data }) => [`file_${path}`, data]);
    await setMany(entries);
}


export async function getLocalFile(path: string): Promise<LocalFile | undefined> {
    if (passphrase && decryptFn) {
        try {
            const hashedPath = await hashPath(path);
            const key = `file_hash_${hashedPath}`;
            const record = await get<LocalFile>(key);
            if (record) {
                if (record.isEncrypted && record.encryptedPath) {
                    const decryptedContent = await decryptFn(record.content, passphrase);
                    return {
                        content: decryptedContent,
                        sha: record.sha,
                        encryptedPath: record.encryptedPath,
                        isEncrypted: true
                    };
                }
            }
        } catch (e) {
            console.error('Failed to get local file with encryption:', e);
        }
    }
    
    // Try system-key encrypted record
    try {
        const hashedPath = await hashPath(path);
        const key = `file_hash_${hashedPath}`;
        const record = await get<LocalFile>(key);
        if (record && record.isEncrypted && record.encryptedPath) {
            try {
                const decryptedContent = await systemKeyDecrypt(record.content);
                return {
                    content: decryptedContent,
                    sha: record.sha,
                    encryptedPath: record.encryptedPath,
                    isEncrypted: true
                };
            } catch (decryptErr) {
                console.warn(`System-key decryption failed for ${path}, clearing corrupted cache:`, decryptErr);
                await del(key);
            }
        }
    } catch (e) {
        console.error('Failed to get system-key encrypted file:', e);
    }

    // Fallback for legacy plaintext lookup
    const plaintextRecord = await get<LocalFile>(`file_${path}`);
    if (plaintextRecord) {
        return plaintextRecord;
    }
    return undefined;
}

export async function deleteLocalFile(path: string): Promise<void> {
    const hashedPath = await hashPath(path);
    await del(`file_hash_${hashedPath}`);
    await del(`file_${path}`);
}

export async function getAllLocalFilePaths(): Promise<string[]> {
    const allKeys = await keys();
    
    const hashKeys = allKeys.filter((k): k is string => typeof k === 'string' && k.startsWith('file_hash_'));
    const legacyKeys = allKeys.filter((k): k is string => typeof k === 'string' && k.startsWith('file_'));

    // Fetch all records concurrently
    const records = await Promise.all(hashKeys.map(key => get<LocalFile>(key)));

    // Decrypt all paths concurrently
    const decryptedPaths = await Promise.all(
        records.map(async (record, index) => {
            if (record && record.isEncrypted && record.encryptedPath) {
                if (passphrase && decryptFn) {
                    try {
                        return await decryptFn(record.encryptedPath, passphrase);
                    } catch (e) {
                        console.error('Failed to decrypt local file path:', e);
                    }
                } else {
                    try {
                        return await systemKeyDecrypt(record.encryptedPath);
                    } catch (e) {
                        console.warn('Failed to decrypt system-key encrypted path, clearing corrupted cache:', e);
                        const key = hashKeys[index];
                        await del(key);
                    }
                }
            }
            return null;
        })
    );

    const paths = decryptedPaths.filter((p): p is string => p !== null);
    legacyKeys.forEach(key => paths.push(key.substring(5)));

    return paths;
}

/**
 * Clears all cached files from the idb-keyval store.
 * Wipes every file_* and file_hash_* entry in one shot.
 */
export async function clearAllLocalFiles(): Promise<void> {
    await clear();
}

/**
 * Resets module-level crypto state (encrypt/decrypt fns + passphrase).
 * Call on logout to prevent stale crypto handles from lingering.
 */
export function clearStorageCrypto(): void {
    encryptFn = null;
    decryptFn = null;
    passphrase = null;
}