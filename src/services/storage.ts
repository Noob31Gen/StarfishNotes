import { get, set, keys } from 'idb-keyval';

export interface LocalFile {
    content: string;
    sha: string;
}

export async function saveLocalFile(path: string, data: LocalFile) {
    await set(`file_${path}`, data);
}

export async function getLocalFile(path: string): Promise<LocalFile | undefined> {
    return await get(`file_${path}`);
}

export async function getAllLocalFilePaths(): Promise<string[]> {
    const allKeys = await keys();
    return allKeys.filter(k => typeof k === 'string' && k.startsWith('file_')).map(k => (k as string).replace('file_', ''));
}