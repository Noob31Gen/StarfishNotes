import { get, set, keys, del, clear } from 'idb-keyval';

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
    
    await set(`file_${path}`, data);
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
    const paths: string[] = [];

    for (const key of allKeys) {
        if (typeof key !== 'string') continue;
        
        if (key.startsWith('file_hash_')) {
            if (passphrase && decryptFn) {
                try {
                    const record = await get<LocalFile>(key);
                    if (record && record.isEncrypted && record.encryptedPath) {
                        const decryptedPath = await decryptFn(record.encryptedPath, passphrase);
                        paths.push(decryptedPath);
                    }
                } catch (e) {
                    console.error('Failed to decrypt local file path:', e);
                }
            }
        } else if (key.startsWith('file_')) {
            paths.push(key.substring(5)); // Legacy plaintext path
        }
    }

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