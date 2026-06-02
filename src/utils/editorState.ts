/**
 * Editor State Persistence Utility
 * Manages saving and restoring cursor position, scroll position, and canvas viewport state
 */

export interface EditorState {
  cursorPos: number;
  scrollPos: number;
}

const STORAGE_PREFIX = 'starfishnotes-editor-state';

/**
 * Generate a unique key for storing editor state based on vault and file path
 */
function getStateKey(vaultId: string, filePath: string): string {
  return `${STORAGE_PREFIX}:${vaultId}:${filePath}`;
}

/**
 * Save editor state (cursor position, scroll position) for a file
 */
export function saveEditorState(
  vaultId: string,
  filePath: string,
  state: Partial<EditorState>
): void {
  const key = getStateKey(vaultId, filePath);
  try {
    const existing = JSON.parse(localStorage.getItem(key) || '{}') as Partial<EditorState>;
    const merged = { ...existing, ...state };
    localStorage.setItem(key, JSON.stringify(merged));
  } catch (e) {
    console.error('Failed to save editor state:', e);
  }
}

/**
 * Restore editor state for a file
 */
export function restoreEditorState(vaultId: string, filePath: string): Partial<EditorState> {
  const key = getStateKey(vaultId, filePath);
  try {
    return JSON.parse(localStorage.getItem(key) || '{}') as Partial<EditorState>;
  } catch (e) {
    console.error('Failed to restore editor state:', e);
    return {};
  }
}

/**
 * Clear editor state for a file
 */
export function clearEditorState(vaultId: string, filePath: string): void {
  const key = getStateKey(vaultId, filePath);
  try {
    localStorage.removeItem(key);
  } catch (e) {
    console.error('Failed to clear editor state:', e);
  }
}
