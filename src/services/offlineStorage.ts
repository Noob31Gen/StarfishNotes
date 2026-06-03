export interface OfflineFile {
  path: string;
  name: string;
  type: 'blob' | 'text';
  content: string; // Plaintext or ciphertext representation
  size: number;
  sha: string;
}

interface IndexedDBFileRecord {
  path: string; // Plaintext path or SHA-256 hashed path
  name: string;
  type: 'blob' | 'text';
  content: string;
  size: number;
  sha: string;
  encryptedPath?: string;
  encryptedName?: string;
  isMetadataEncrypted?: boolean;
}

async function hashPath(path: string): Promise<string> {
  const msgUint8 = new TextEncoder().encode(path);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

class OfflineStorageService {
  private dbName = 'starfish_local_vault';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;

  private encryptFn: ((plainText: string, key: string) => Promise<string>) | null = null;
  private decryptFn: ((cipherText: string, key: string) => Promise<string>) | null = null;
  private passphrase: string | null = null;

  public initCrypto(
    encrypt: (plainText: string, key: string) => Promise<string>,
    decrypt: (cipherText: string, key: string) => Promise<string>
  ): void {
    this.encryptFn = encrypt;
    this.decryptFn = decrypt;
  }

  public setPassphrase(passphrase: string): void {
    this.passphrase = passphrase;
  }

  public clearPassphrase(): void {
    this.passphrase = null;
  }

  private initDB(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('files')) {
          db.createObjectStore('files', { keyPath: 'path' });
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        resolve(this.db);
      };

      request.onerror = (event) => {
        reject(new Error('Failed to open local vault database: ' + (event.target as IDBOpenDBRequest).error?.message));
      };
    });
  }

  private async getRawRecord(path: string): Promise<IndexedDBFileRecord | null> {
    const db = await this.initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('files', 'readonly');
      const store = transaction.objectStore('files');
      const request = store.get(path);

      request.onsuccess = () => {
        resolve(request.result || null);
      };

      request.onerror = () => {
        reject(transaction.error);
      };
    });
  }

  private async getAllRawRecords(): Promise<IndexedDBFileRecord[]> {
    const db = await this.initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('files', 'readonly');
      const store = transaction.objectStore('files');
      const request = store.getAll();

      request.onsuccess = () => {
        resolve(request.result || []);
      };

      request.onerror = () => {
        reject(transaction.error);
      };
    });
  }

  private async deleteRawRecord(path: string): Promise<void> {
    const db = await this.initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite');
      const store = transaction.objectStore('files');
      const request = store.delete(path);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(transaction.error);
      };
    });
  }

  public async getFilesList(): Promise<OfflineFile[]> {
    try {
      const records = await this.getAllRawRecords();
      const filesList: OfflineFile[] = [];

      for (const record of records) {
        if (record.isMetadataEncrypted) {
          if (this.passphrase && this.decryptFn) {
            try {
              const decryptedPath = await this.decryptFn(record.encryptedPath!, this.passphrase);
              const decryptedName = await this.decryptFn(record.encryptedName!, this.passphrase);
              filesList.push({
                path: decryptedPath,
                name: decryptedName,
                type: record.type,
                content: record.content,
                size: record.size,
                sha: record.sha
              });
            } catch (e) {
              console.error('Failed to decrypt record in list:', e);
            }
          } else {
            // Do not expose encrypted files in metadata list if the vault is locked/key is missing
          }
        } else {
          filesList.push({
            path: record.path,
            name: record.name,
            type: record.type,
            content: record.content,
            size: record.size,
            sha: record.sha
          });
        }
      }
      return filesList;
    } catch (e) {
      console.error('Failed to retrieve local offline files list:', e);
      return [];
    }
  }

  public async getFile(path: string): Promise<OfflineFile | null> {
    try {
      const lookupKey = this.passphrase ? await hashPath(path) : path;
      let record = await this.getRawRecord(lookupKey);

      if (!record && this.passphrase) {
        // Fallback for legacy plaintext key lookup (migration path)
        record = await this.getRawRecord(path);
      }

      if (!record) return null;

      if (record.isMetadataEncrypted && this.passphrase && this.decryptFn) {
        try {
          const decryptedPath = await this.decryptFn(record.encryptedPath!, this.passphrase);
          const decryptedName = await this.decryptFn(record.encryptedName!, this.passphrase);
          return {
            path: decryptedPath,
            name: decryptedName,
            type: record.type,
            content: record.content,
            size: record.size,
            sha: record.sha
          };
        } catch (e) {
          console.error('Failed to decrypt offline file metadata:', e);
          return null;
        }
      }

      return {
        path: record.path,
        name: record.name,
        type: record.type,
        content: record.content,
        size: record.size,
        sha: record.sha
      };
    } catch (e) {
      console.error('Failed to load file from offline storage:', e);
      return null;
    }
  }

  public async saveFile(file: OfflineFile): Promise<void> {
    const db = await this.initDB();
    
    let recordToSave: IndexedDBFileRecord;

    if (this.passphrase && this.encryptFn) {
      const hashedPath = await hashPath(file.path);
      const encryptedPath = await this.encryptFn(file.path, this.passphrase);
      const encryptedName = await this.encryptFn(file.name, this.passphrase);
      recordToSave = {
        path: hashedPath,
        name: '', // Empty placeholder in primary key record to hide leakage
        type: file.type,
        content: file.content,
        size: file.size,
        sha: file.sha,
        encryptedPath,
        encryptedName,
        isMetadataEncrypted: true
      };
    } else {
      recordToSave = {
        path: file.path,
        name: file.name,
        type: file.type,
        content: file.content,
        size: file.size,
        sha: file.sha
      };
    }

    return new Promise((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite');
      const store = transaction.objectStore('files');
      const request = store.put(recordToSave);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(transaction.error);
      };
    });
  }

  public async deleteFile(path: string): Promise<void> {
    const key = this.passphrase ? await hashPath(path) : path;
    await this.deleteRawRecord(key);
    if (this.passphrase) {
      // Delete legacy plaintext key record if it exists
      await this.deleteRawRecord(path);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async getMeta(key: string): Promise<any | null> {
    const db = await this.initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('meta', 'readonly');
      const store = transaction.objectStore('meta');
      const request = store.get(key);

      request.onsuccess = () => {
        resolve(request.result ? request.result.value : null);
      };

      request.onerror = () => {
        reject(transaction.error);
      };
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  public async saveMeta(key: string, value: any): Promise<void> {
    const db = await this.initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('meta', 'readwrite');
      const store = transaction.objectStore('meta');
      const request = store.put({ key, value });

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(transaction.error);
      };
    });
  }

  public async purgeVault(): Promise<void> {
    const db = await this.initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(['files', 'meta'], 'readwrite');
      const filesStore = transaction.objectStore('files');
      const metaStore = transaction.objectStore('meta');
      
      filesStore.clear();
      metaStore.clear();

      transaction.oncomplete = () => {
        resolve();
      };

      transaction.onerror = () => {
        reject(transaction.error);
      };
    });
  }
}

export const offlineStorage = new OfflineStorageService();
