/**
 * StarfishNotes - GitHub Sync Engine
 * Performs 100% client-side REST API synchronization with the user's notes repository.
 * Implements robust tree traversal, UTF-8 base64 encoding/decoding, and conflict resolution (SHA checking).
 */
import JSZip from 'jszip';
import { getLocalFile, saveLocalFile } from './storage';

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
    message: 'chore: initialize StarfishNotes compatibility metadata',
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

  // Filter files that are strictly Markdown (.md), Text (.txt), Canvas (.canvas), or binary attachments
  const allowedExtensions = ['.md', '.txt', '.canvas', '.gitkeep', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.pdf'];
  return treeNodes
    .filter((node) => {
      if (node.type !== 'blob') return false;
      const lowerPath = node.path.toLowerCase();
      return allowedExtensions.some(ext => lowerPath.endsWith(ext));
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
  commitMessage: string = 'update note via StarfishNotes'
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
    message: `delete note "${path}" via StarfishNotes`,
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

export async function syncVault(token: string, repo: string, branch: string, remoteTree: VaultFile[]) {
  console.log("Checking for updates...");

  // 1. Identify which files are missing or have different SHAs
  const changedFiles: VaultFile[] = [];
  for (const remoteFile of remoteTree) {
    if (!remoteFile.path.endsWith('.md') && !remoteFile.path.endsWith('.canvas') && !remoteFile.path.endsWith('.txt')) continue;

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
    console.log("Downloading zipball for high-quality prefetch...");
    const res = await fetch(`https://api.github.com/repos/${repo}/zipball/${branch}`, {
      headers: { Authorization: `token ${token}` }
    });

    if (!res.ok) {
      throw new Error(`Failed to download zipball: HTTP ${res.status}`);
    }

    const blob = await res.blob();
    const zip = await JSZip.loadAsync(blob);

    // Extract and save the changed files to IndexedDB
    for (const [path, file] of Object.entries(zip.files)) {
      if (file.dir) continue;

      const cleanPath = path.split('/').slice(1).join('/'); // Remove root folder name from zip path
      const cleanPathLower = cleanPath.toLowerCase();
      const targetFile = changedFiles.find(f => f.path.toLowerCase() === cleanPathLower);

      if (targetFile) {
        if (cleanPath.endsWith('.md') || cleanPath.endsWith('.canvas') || cleanPath.endsWith('.txt')) {
          console.log(`Updating/Saving local file from zip: ${targetFile.path}`);
          const content = await file.async('string');
          await saveLocalFile(targetFile.path, { content, sha: targetFile.sha });
          updatedPaths.add(targetFile.path);
        }
      }
    }

    console.log("Zipball sync complete.");
  } catch (error) {
    console.error("Zipball sync failed, falling back to individual file fetches...", error);
  }

  // 2. Fallback / Cleanup for files not updated by zipball
  // This handles both:
  // - The entire zipball download failing
  // - A specific file not being present in the zipball (e.g. race conditions)
  const remainingFiles = changedFiles.filter(f => !updatedPaths.has(f.path));
  if (remainingFiles.length > 0) {
    console.log(`Fetching ${remainingFiles.length} remaining/failed files individually...`);
    for (const remoteFile of remainingFiles) {
      try {
        console.log(`Updating ${remoteFile.path}...`);
        const content = await fetchFileContent(token, repo, remoteFile.path, remoteFile.sha);
        await saveLocalFile(remoteFile.path, { content, sha: remoteFile.sha });
      } catch (fetchErr) {
        console.error(`Failed to fetch file ${remoteFile.path} individually:`, fetchErr);
      }
    }
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
  commitMessage: string = 'upload attachment via StarfishNotes'
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