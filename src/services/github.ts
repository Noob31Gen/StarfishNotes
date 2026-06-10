/**
 * Starfish Notes - GitHub Sync Engine
 * Performs 100% client-side REST API synchronization with the user's notes repository.
 * Implements robust tree traversal, UTF-8 base64 encoding/decoding, and conflict resolution (SHA checking).
 */
import { getLocalFile, saveLocalFile, saveLocalFilesBatch, type LocalFile } from './storage';
import { textExtensions } from '../utils/textExtensions';

export interface VaultFile {
  path: string;
  name: string;
  type: 'blob' | 'tree';
  sha: string;
  size?: number;
}

export interface VaultCompatibility {
  compatible: boolean;
  exists: boolean;
  metadata?: {
    appName: string;
    version: string;
    initializedAt: string;
  };
}

export function isBinaryBytes(bytes: Uint8Array): boolean {
  const len = Math.min(bytes.length, 1024);
  for (let i = 0; i < len; i++) {
    if (bytes[i] === 0) {
      return true; // Contains null byte -> binary
    }
  }
  return false; // No null bytes -> text
}

const runtimeDetectedTextFiles: Record<string, boolean> = (() => {
  try {
    const saved = localStorage.getItem('starfishnotes_detected_text_files');
    return saved ? JSON.parse(saved) : {};
  } catch {
    return {};
  }
})();

export function registerDetectedTextFile(path: string, isText: boolean): void {
  runtimeDetectedTextFiles[path] = isText;
  try {
    localStorage.setItem('starfishnotes_detected_text_files', JSON.stringify(runtimeDetectedTextFiles));
  } catch (e) {
    console.error('Failed to save detected text files registry:', e);
  }
}

export function isTextFile(path: string): boolean {
  if (runtimeDetectedTextFiles[path] !== undefined) {
    return runtimeDetectedTextFiles[path];
  }

  const binaryExtensions = [
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf', '.zip', '.tar', '.gz', '.mp3', '.mp4', '.mov', '.avi', '.ttf', '.woff', '.woff2', '.eot'
  ];

  const lastDot = path.lastIndexOf('.');
  if (lastDot === -1) {
    return true; // No extension -> default to text-like (compatibility fallback)
  }

  const ext = path.substring(lastDot).toLowerCase();
  if (binaryExtensions.includes(ext)) {
    return false;
  }
  if (ext === '.canvas') {
    return false;
  }

  const extName = ext.substring(1);
  if (textExtensions.has(extName)) {
    return true;
  }

  // Unrecognized extensions default to false synchronously.
  // They will be scanned dynamically on-demand when loaded.
  return false;
}

/**
 * Custom error handler for conflict resolution
 */
export class GitConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitConflictError';
  }
}

/**
 * Base GitHub Request helper
 */
async function githubRequest(
  token: string,
  endpoint: string,
  options: RequestInit = {}
): Promise<Response> {
  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `token ${token}`);
  headers.set('Accept', 'application/vnd.github.v3+json');
  headers.set('Content-Type', 'application/json');

  const response = await fetch(`https://api.github.com${endpoint}`, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    throw new Error('Unauthorized: Invalid GitHub token.');
  }

  return response;
}

/**
 * GraphQL Query helper
 */
async function graphqlRequest(
  token: string,
  query: string,
  variables: Record<string, string> = {}
): Promise<unknown> {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Authorization: `bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });

  if (res.status === 401) {
    throw new Error('Unauthorized: Invalid GitHub token.');
  }

  if (!res.ok) {
    throw new Error(`GraphQL request failed: HTTP ${res.status}`);
  }

  const result = (await res.json()) as {
    data?: unknown;
    errors?: Array<{ message: string }>;
  };

  if (result.errors) {
    throw new Error(`GraphQL errors: ${result.errors.map((e) => e.message).join(', ')}`);
  }

  return result.data;
}

/**
 * Batch fetch text files from GitHub using GraphQL in batches.
 * Returns a Map of filePath -> content.
 */
async function fetchFilesGraphQL(
  token: string,
  repo: string,
  branch: string,
  files: VaultFile[],
  batchSize = 50
): Promise<Map<string, string>> {
  const fileContentsMap = new Map<string, string>();
  const [owner, name] = repo.split('/');

  if (!owner || !name) {
    throw new Error(`Invalid repository format: ${repo}`);
  }

  // Process files in batches
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);

    // Build query variables and definitions
    const varDefinitions: string[] = [];
    const selectionFields: string[] = [];
    const variables: Record<string, string> = { owner, name };

    batch.forEach((file, index) => {
      const varName = `expr_${index}`;
      varDefinitions.push(`$${varName}: String!`);
      variables[varName] = `${branch}:${file.path}`;
      selectionFields.push(`
        file_${index}: object(expression: $${varName}) {
          ... on Blob {
            text
          }
        }
      `);
    });

    const query = `
      query GetBatchFiles($owner: String!, $name: String!, ${varDefinitions.join(', ')}) {
        repository(owner: $owner, name: $name) {
          ${selectionFields.join('\n')}
        }
      }
    `;

    try {
      const data = (await graphqlRequest(token, query, variables)) as {
        repository?: Record<string, { text?: string } | null>;
      } | null;
      const repoData = data?.repository;
      if (repoData) {
        batch.forEach((file, index) => {
          const fileObj = repoData[`file_${index}`];
          if (fileObj && typeof fileObj.text === 'string') {
            fileContentsMap.set(file.path, fileObj.text);
          }
        });
      }
    } catch (err) {
      console.warn(`GraphQL batch fetch failed for batch starting at index ${i}:`, err);
    }
  }

  return fileContentsMap;
}

/**
 * Safe UTF-8 Base64 Decoding (Prevents issues with emojis/multi-byte chars)
 */
export function safeB64Decode(str: string): string {
  const binaryString = atob(str.replace(/\s/g, ''));
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Safe UTF-8 Base64 Encoding
 */
export function safeB64Encode(str: string): string {
  const utf8Bytes = new TextEncoder().encode(str);
  let binaryString = '';
  for (let i = 0; i < utf8Bytes.length; i++) {
    binaryString += String.fromCharCode(utf8Bytes[i]);
  }
  return btoa(binaryString);
}

/**
 * 1. Validate connection credentials (token, repo)
 * Checks if the repository exists and is accessible.
 */
export async function validateRepository(
  token: string,
  repo: string,
  branch: string
): Promise<{ exists: boolean; defaultBranch: string; isEmpty: boolean }> {
  try {
    const res = await githubRequest(token, `/repos/${repo}`);
    if (res.status === 404) {
      throw new Error(`Repository "${repo}" not found or unauthorized.`);
    }
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.message || 'Failed to connect to repository.');
    }
    const repoInfo = await res.json();

    // Verify branch
    const branchRes = await githubRequest(token, `/repos/${repo}/branches/${branch}`);

    let isEmpty = false;
    if (branchRes.status === 404) {
      // If the branch doesn't exist, check if the repo is completely empty (no branches at all)
      const branchesListRes = await githubRequest(token, `/repos/${repo}/branches`);
      if (branchesListRes.ok) {
        const branches = (await branchesListRes.json()) as { name: string }[];
        if (branches.length === 0) {
          isEmpty = true;
        } else {
          throw new Error(`Branch "${branch}" does not exist in repository "${repo}". Available branches: ${branches.map((b) => b.name).join(', ')}`);
        }
      } else {
        throw new Error(`Branch "${branch}" does not exist in repository "${repo}".`);
      }
    } else if (!branchRes.ok) {
      const err = await branchRes.json();
      throw new Error(err.message || 'Failed to verify branch.');
    }

    return {
      exists: true,
      defaultBranch: repoInfo.default_branch || 'main',
      isEmpty,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Network error verifying repository.';
    throw new Error(msg, { cause: error });
  }
}

/**
 * 2. Check compatibility of repository (.vault-compat.json)
 */
export async function checkVaultCompatibility(
  token: string,
  repo: string,
  branch: string
): Promise<VaultCompatibility> {
  try {
    const res = await githubRequest(
      token,
      `/repos/${repo}/contents/.vault-compat.json?ref=${branch}`
    );

    if (res.status === 404) {
      return { compatible: false, exists: false };
    }

    if (!res.ok) {
      return { compatible: false, exists: false };
    }

    const data = await res.json();
    const content = safeB64Decode(data.content);
    const metadata = JSON.parse(content);

    return {
      compatible: metadata.appName === 'StarfishNotes',
      exists: true,
      metadata,
    };
  } catch {
    return { compatible: false, exists: false };
  }
}

/**
 * 3. Initialize repository with .vault-compat.json marker
 */
export async function initializeVault(
  token: string,
  repo: string,
  branch: string
): Promise<void> {
  const metadata = {
    appName: 'StarfishNotes',
    version: '1.0.0',
    initializedAt: new Date().toISOString(),
  };

  const payload = {
    message: 'chore: initialize Starfish Notes compatibility metadata',
    content: safeB64Encode(JSON.stringify(metadata, null, 2)),
    branch,
  };

  const res = await githubRequest(token, `/repos/${repo}/contents/.vault-compat.json`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || 'Failed to initialize compatibility metadata.');
  }
}

/**
 * 4. Fetch entire file structure tree from Git recursive API
 */
export async function fetchRepositoryTree(
  token: string,
  repo: string,
  branch: string
): Promise<VaultFile[]> {
  const res = await githubRequest(token, `/repos/${repo}/git/trees/${branch}?recursive=1`);

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || 'Failed to fetch repository tree.');
  }

  interface GitTreeNode {
    path: string;
    type: string;
    sha: string;
    size?: number;
  }

  const data = await res.json();
  if (!data.tree || !Array.isArray(data.tree)) {
    return [];
  }

  const treeNodes = data.tree as GitTreeNode[];

  return treeNodes
    .filter((node) => {
      if (node.type !== 'blob') return false;
      const lowerPath = node.path.toLowerCase();
      if (lowerPath.includes('.git/') || lowerPath.startsWith('.git/')) return false;
      if (lowerPath.includes('.obsidian/') || lowerPath.startsWith('.obsidian/')) return false;
      if (lowerPath.includes('.gitignore') || lowerPath.startsWith('.gitignore')) return false;
      if (lowerPath.includes('.vault-compat.json') || lowerPath.startsWith('.vault-compat.json')) return false;
      return true;
    })
    .map((node) => ({
      path: node.path,
      name: node.path.split('/').pop() || '',
      type: 'blob' as const,
      sha: node.sha,
      size: node.size,
    }));
}

/**
 * 5. Fetch a single file's text contents
 */
export async function fetchFileContent(
  token: string,
  repo: string,
  path: string,
  sha: string
): Promise<string> {
  // Use Git Blobs API to fetch by immutable blob SHA directly, bypassing contents API cache issues
  const res = await githubRequest(token, `/repos/${repo}/git/blobs/${sha}`);

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || `Failed to fetch file: ${path}`);
  }

  const data = await res.json();
  return safeB64Decode(data.content);
}

/**
 * 6. Commit/Save a file to the repository
 * Implements strict optimistic locking using SHA parameters.
 */
export async function commitFileContent(
  token: string,
  repo: string,
  branch: string,
  path: string,
  content: string,
  sha: string | null, // null indicates new file
  commitMessage: string = 'update note via Starfish Notes'
): Promise<{ sha: string }> {
  const payload: { message: string; content: string; branch: string; sha?: string } = {
    message: commitMessage,
    content: safeB64Encode(content),
    branch,
  };

  if (sha) {
    payload.sha = sha;
  }

  const res = await githubRequest(token, `/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });

  if (res.status === 409 || res.status === 422) {
    // Conflict detected - local-first resolution takes full priority
    // Directly fetch the latest metadata to get the fresh remote SHA
    try {
      const getRes = await githubRequest(
        token,
        `/repos/${repo}/contents/${path}?ref=${branch}`
      );

      if (getRes.ok) {
        const remoteData = await getRes.json();
        const remoteSha = remoteData.sha;

        // Retry with the fresh remote SHA to force overwrite the remote file
        const retryPayload: { message: string; content: string; branch: string; sha: string } = {
          message: `${commitMessage} (force overwrite conflict resolution)`,
          content: safeB64Encode(content),
          branch,
          sha: remoteSha as string,
        };

        const retryRes = await githubRequest(token, `/repos/${repo}/contents/${path}`, {
          method: 'PUT',
          body: JSON.stringify(retryPayload),
        });

        if (retryRes.ok) {
          const retryData = await retryRes.json();
          return {
            sha: retryData.content.sha,
          };
        }

        const err = await retryRes.json();
        throw new Error(err.message || `Failed to save file during conflict overwrite: ${path}`);
      } else if (getRes.status === 404) {
        // File does not exist on remote (deleted in interim); commit as new file
        const recreatePayload: { message: string; content: string; branch: string } = {
          message: `${commitMessage} (recreate deleted file)`,
          content: safeB64Encode(content),
          branch,
        };
        const recreateRes = await githubRequest(token, `/repos/${repo}/contents/${path}`, {
          method: 'PUT',
          body: JSON.stringify(recreatePayload),
        });
        if (recreateRes.ok) {
          const recreateData = await recreateRes.json();
          return {
            sha: recreateData.content.sha,
          };
        }
        const err = await recreateRes.json();
        throw new Error(err.message || `Failed to recreate deleted file: ${path}`);
      } else {
        const err = await getRes.json();
        throw new Error(err.message || `Failed to retrieve remote file metadata for conflict resolution.`);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : `Failed to force overwrite conflict resolution for: ${path}`;
      throw new Error(msg, { cause: error });
    }
  }

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || `Failed to save file: ${path}`);
  }

  const data = await res.json();
  return {
    sha: data.content.sha,
  };
}

/**
 * 7. Delete a file from the repository
 */
export async function deleteFile(
  token: string,
  repo: string,
  branch: string,
  path: string,
  sha: string
): Promise<void> {
  const payload = {
    message: `delete note "${path}" via Starfish Notes`,
    sha,
    branch,
  };

  const res = await githubRequest(token, `/repos/${repo}/contents/${path}`, {
    method: 'DELETE',
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || `Failed to delete file: ${path}`);
  }
}

export async function syncVault(
  token: string,
  repo: string,
  branch: string,
  remoteTree: VaultFile[],
  skippedPaths: string[] = []
) {
  console.log("Checking for updates...");

  // 1. Identify which files are missing or have different SHAs
  const changedFiles: VaultFile[] = [];
  for (const remoteFile of remoteTree) {
    if (!isTextFile(remoteFile.path) && !remoteFile.path.endsWith('.canvas')) continue;
    if (skippedPaths.includes(remoteFile.path)) {
      console.log(`syncVault: Skipping sync check for protected path: ${remoteFile.path}`);
      continue;
    }

    const localFile = await getLocalFile(remoteFile.path);
    if (!localFile || localFile.sha !== remoteFile.sha) {
      changedFiles.push(remoteFile);
    }
  }

  if (changedFiles.length === 0) {
    console.log("All files are up-to-date.");
    return;
  }

  console.log(`Found ${changedFiles.length} new or changed files. Syncing...`);

  const updatedPaths = new Set<string>();

  try {
    console.log("Fetching changed files in bulk via GraphQL...");
    const graphqlContents = await fetchFilesGraphQL(token, repo, branch, changedFiles);
    
    // Batch save files cache in a single IndexedDB transaction
    const batchData: { path: string; data: LocalFile }[] = [];
    for (const [filePath, content] of graphqlContents.entries()) {
      const targetFile = changedFiles.find(f => f.path === filePath);
      if (targetFile) {
        batchData.push({
          path: filePath,
          data: { content, sha: targetFile.sha }
        });
        updatedPaths.add(filePath);
      }
    }
    
    if (batchData.length > 0) {
      console.log(`Saving ${batchData.length} files to cache in batch...`);
      await saveLocalFilesBatch(batchData);
    }
    
    console.log(`GraphQL bulk sync complete. Updated ${updatedPaths.size} out of ${changedFiles.length} files.`);
  } catch (error) {
    console.error("GraphQL bulk sync failed, falling back to individual file fetches...", error);
  }

  // 2. Fallback / Cleanup for files not updated by GraphQL bulk sync
  // This handles both:
  // - The entire GraphQL bulk sync failing
  // - Specific files that failed to fetch or return null via GraphQL
  const remainingFiles = changedFiles.filter(f => !updatedPaths.has(f.path));
  if (remainingFiles.length > 0) {
    console.log(`Fetching ${remainingFiles.length} remaining/failed files in parallel (concurrency: 10)...`);
    const concurrencyLimit = 10;
    const queue = [...remainingFiles];

    const runWorker = async () => {
      while (queue.length > 0) {
        const remoteFile = queue.shift();
        if (!remoteFile) break;
        try {
          console.log(`Updating ${remoteFile.path}...`);
          const content = await fetchFileContent(token, repo, remoteFile.path, remoteFile.sha);
          await saveLocalFile(remoteFile.path, { content, sha: remoteFile.sha });
          updatedPaths.add(remoteFile.path);
        } catch (fetchErr) {
          console.error(`Failed to fetch file ${remoteFile.path} individually:`, fetchErr);
        }
      }
    };

    const workers = Array.from({ length: Math.min(concurrencyLimit, remainingFiles.length) }, runWorker);
    await Promise.all(workers);
  }
}

/**
 * 9. Check GitHub API rate limit status
 */
export interface RateLimitStatus {
  limit: number;
  remaining: number;
  reset: Date;
  isLimited: boolean;
}

export async function checkApiRateLimit(token: string): Promise<RateLimitStatus> {
  try {
    const res = await githubRequest(token, '/rate_limit');

    if (!res.ok) {
      throw new Error(`Failed to fetch rate limit: HTTP ${res.status}`);
    }

    const data = (await res.json()) as {
      resources?: {
        core?: {
          limit: number;
          remaining: number;
          reset: number;
        };
      };
    };

    const coreLimit = data.resources?.core;
    if (!coreLimit) {
      throw new Error('No core rate limit data in response');
    }

    const remaining = coreLimit.remaining;
    const limit = coreLimit.limit;
    const resetTime = new Date(coreLimit.reset * 1000); // Convert Unix epoch to milliseconds

    return {
      limit,
      remaining,
      reset: resetTime,
      isLimited: remaining === 0,
    };
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Failed to check API rate limit.';
    console.error('Rate limit check error:', msg);
    throw new Error(msg, { cause: error });
  }
}

/**
 * 8. Commit/Save an attachment to the repository
 */
export async function commitAttachment(
  token: string,
  repo: string,
  branch: string,
  path: string,
  base64Content: string,
  sha: string | null, // null indicates new file
  commitMessage: string = 'upload attachment via Starfish Notes'
): Promise<{ sha: string }> {
  const payload: { message: string; content: string; branch: string; sha?: string } = {
    message: commitMessage,
    content: base64Content,
    branch,
  };

  if (sha) {
    payload.sha = sha;
  }

  const res = await githubRequest(token, `/repos/${repo}/contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  });

  if (res.status === 409 || res.status === 422) {
    try {
      const getRes = await githubRequest(
        token,
        `/repos/${repo}/contents/${path}?ref=${branch}`
      );

      if (getRes.ok) {
        const remoteData = await getRes.json();
        const remoteSha = remoteData.sha;

        const retryPayload = {
          message: `${commitMessage} (force overwrite conflict resolution)`,
          content: base64Content,
          branch,
          sha: remoteSha,
        };

        const retryRes = await githubRequest(token, `/repos/${repo}/contents/${path}`, {
          method: 'PUT',
          body: JSON.stringify(retryPayload),
        });

        if (retryRes.ok) {
          const retryData = await retryRes.json();
          return {
            sha: retryData.content.sha,
          };
        }
      }
    } catch (e) {
      console.error('Attachment overwrite resolution failed:', e);
    }
  }

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || `Failed to save attachment: ${path}`);
  }

  const data = await res.json();
  return {
    sha: data.content.sha,
  };
}

/**
 * 9. Fetch raw binary file contents (returns base64 encoded string directly)
 */
export async function fetchBinaryFileContent(
  token: string,
  repo: string,
  sha: string
): Promise<string> {
  const res = await githubRequest(token, `/repos/${repo}/git/blobs/${sha}`);

  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.message || 'Failed to fetch binary file.');
  }

  const data = await res.json();
  return data.content.replace(/\s/g, '');
}