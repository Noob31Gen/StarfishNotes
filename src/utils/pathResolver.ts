/**
 * Obsidian-compatible Vault Path Resolver
 * Performs case-insensitive matching, subfolder-aware search, and automatic extension mapping
 */
export function resolveVaultFilePath(
  files: { path: string; name: string }[],
  targetPath: string
): string {
  if (!targetPath) return targetPath;

  // Normalize slashes and trim
  const normalizedTarget = targetPath.replace(/\\/g, '/').replace(/^\.?\//, '').trim().toLowerCase();
  
  // Try exact match first (case-insensitive)
  const exactMatch = files.find(f => f.path.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase() === normalizedTarget);
  if (exactMatch) return exactMatch.path;

  // Try exact match with extension appended if not present
  const hasAllowedExt = normalizedTarget.endsWith('.md') || normalizedTarget.endsWith('.canvas') || normalizedTarget.endsWith('.txt');
  const targetWithMd = hasAllowedExt
    ? normalizedTarget
    : normalizedTarget + '.md';
  
  const exactMatchWithExt = files.find(f => f.path.replace(/\\/g, '/').replace(/^\.?\//, '').toLowerCase() === targetWithMd);
  if (exactMatchWithExt) return exactMatchWithExt.path;

  // Try matching just the filename if no folder was specified (Obsidian standard behavior)
  const targetFilename = normalizedTarget.includes('/') ? normalizedTarget.split('/').pop()! : normalizedTarget;
  const targetFilenameWithExt = targetFilename.endsWith('.md') || targetFilename.endsWith('.canvas') || targetFilename.endsWith('.txt')
    ? targetFilename
    : targetFilename + '.md';

  const filenameMatch = files.find(f => f.name.toLowerCase() === targetFilenameWithExt);
  if (filenameMatch) return filenameMatch.path;

  // If no match is found, return the original target path with .md extension if it is a note
  return targetPath.endsWith('.md') || targetPath.endsWith('.canvas') || targetPath.endsWith('.txt')
    ? targetPath
    : targetPath + '.md';
}
