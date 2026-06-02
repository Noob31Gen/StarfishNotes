export interface OfflineFile {
  path: string;
  name: string;
  type: 'blob' | 'text';
  content: string; // Plaintext or ciphertext representation
  size: number;
  sha: string;
}

class OfflineStorageService {
  private dbName = 'starfish_local_vault';
  private dbVersion = 1;
  private db: IDBDatabase | null = null;

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

  public async getFilesList(): Promise<OfflineFile[]> {
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

  public async getFile(path: string): Promise<OfflineFile | null> {
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

  public async saveFile(file: OfflineFile): Promise<void> {
    const db = await this.initDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('files', 'readwrite');
      const store = transaction.objectStore('files');
      const request = store.put(file);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(transaction.error);
      };
    });
  }

  public async deleteFile(path: string): Promise<void> {
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

  public async getMeta(key: string): Promise<string | null> {
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

  public async saveMeta(key: string, value: string): Promise<void> {
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
