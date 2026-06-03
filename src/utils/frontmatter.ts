import { parseYaml, stringifyYaml } from './yaml';

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Parses frontmatter (YAML) block at the beginning of a markdown file.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('---')) {
    const nextDash = trimmed.indexOf('---', 3);
    if (nextDash !== -1) {
      const yamlPart = trimmed.substring(3, nextDash).trim();
      const bodyPart = trimmed.substring(nextDash + 3);
      const isNewLine = /^\r?\n/.test(bodyPart);
      if (isNewLine) {
        try {
          const parsed = parseYaml(yamlPart);
          const frontmatter = (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
            ? (parsed as Record<string, unknown>)
            : {};
          return { frontmatter, body: bodyPart.replace(/^\r?\n/, '') };
        } catch {
          // ignore parsing error and return empty
        }
      }
    }
  }
  return { frontmatter: {}, body: content };
}

/**
 * Serializes frontmatter and raw body back to a Markdown string.
 */
export function stringifyFrontmatter(frontmatter: Record<string, unknown>, body: string): string {
  if (!frontmatter || Object.keys(frontmatter).length === 0) {
    return body;
  }
  const yamlPart = stringifyYaml(frontmatter).trim();
  if (!yamlPart) {
    return body;
  }
  return `---\n${yamlPart}\n---\n${body.startsWith('\n') ? body.substring(1) : body}`;
}

/**
 * Updates a markdown file's frontmatter properties and returns the updated file contents.
 */
export function updateFrontmatter(content: string, updates: Record<string, unknown>): string {
  const { frontmatter, body } = parseFrontmatter(content);
  const newFrontmatter = { ...frontmatter };
  
  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined || value === null) {
      delete newFrontmatter[key];
    } else {
      newFrontmatter[key] = value;
    }
  }
  
  return stringifyFrontmatter(newFrontmatter, body);
}
