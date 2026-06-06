// Self-contained light YAML parser and stringifier for Starfish Notes (.base and note frontmatter)

export function parseYaml(yaml: string): unknown {
  const lines = yaml.split(/\r?\n/).map(line => {
    let inDoubleQuotes = false;
    let inSingleQuotes = false;
    let commentIndex = -1;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"' && !inSingleQuotes) inDoubleQuotes = !inDoubleQuotes;
      else if (char === "'" && !inDoubleQuotes) inSingleQuotes = !inSingleQuotes;
      else if (char === '#' && !inDoubleQuotes && !inSingleQuotes) {
        commentIndex = i;
        break;
      }
    }
    if (commentIndex !== -1) {
      line = line.substring(0, commentIndex);
    }
    return line;
  });

  let lineIdx = 0;

  function getIndent(line: string): number {
    const match = line.match(/^(\s*)/);
    return match ? match[1].length : 0;
  }

  function parseValue(val: string): unknown {
    val = val.trim();
    if (!val) return null;
    if (val === 'true') return true;
    if (val === 'false') return false;
    if (val === 'null') return null;
    if (!isNaN(Number(val)) && val !== '') return Number(val);

    // Remove surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      return val.slice(1, -1);
    }

    // Handle inline lists e.g. [a, b, c]
    if (val.startsWith('[') && val.endsWith(']')) {
      try {
        const cleanVal = val.replace(/'/g, '"');
        return JSON.parse(cleanVal);
      } catch {
        return val.slice(1, -1).split(',').map(s => parseValue(s.trim()));
      }
    }

    return val;
  }

  function parseBlock(parentIndent: number): unknown {
    let currentObj: Record<string, unknown> | null = null;
    const currentArray: unknown[] = [];
    let isArray = false;

    while (lineIdx < lines.length) {
      const line = lines[lineIdx];
      const trimmed = line.trim();

      if (!trimmed) {
        lineIdx++;
        continue;
      }

      const indent = getIndent(line);
      if (indent < parentIndent) {
        break;
      }

      if (trimmed.startsWith('-')) {
        isArray = true;
        const afterDash = trimmed.substring(1).trim();
        if (afterDash === '') {
          lineIdx++;
          let nextIndent = indent + 2;
          for (let i = lineIdx; i < lines.length; i++) {
            if (lines[i].trim() !== '') {
              nextIndent = getIndent(lines[i]);
              break;
            }
          }
          const nested = parseBlock(nextIndent);
          currentArray.push(nested);
        } else if (afterDash.includes(':')) {
          const spaceCount = line.indexOf('-');
          const fakeLine = ' '.repeat(spaceCount + 2) + afterDash;
          lines[lineIdx] = fakeLine;
          const nested = parseBlock(indent + 2);
          currentArray.push(nested);
        } else {
          currentArray.push(parseValue(afterDash));
          lineIdx++;
        }
      } else if (trimmed.includes(':')) {
        if (isArray) {
          break;
        }
        if (!currentObj) {
          currentObj = {};
        }

        const colonIdx = trimmed.indexOf(':');
        const key = trimmed.substring(0, colonIdx).trim();
        const valueStr = trimmed.substring(colonIdx + 1).trim();

        let cleanKey = key;
        if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
          cleanKey = key.slice(1, -1);
        }

        if (valueStr === '') {
          lineIdx++;
          let nextIndent = indent + 2;
          for (let i = lineIdx; i < lines.length; i++) {
            if (lines[i].trim() !== '') {
              nextIndent = getIndent(lines[i]);
              break;
            }
          }
          const val = parseBlock(nextIndent);
          currentObj[cleanKey] = val;
        } else {
          currentObj[cleanKey] = parseValue(valueStr);
          lineIdx++;
        }
      } else {
        if (isArray) {
          currentArray.push(parseValue(trimmed));
        } else {
          return parseValue(trimmed);
        }
        lineIdx++;
      }
    }

    if (isArray) return currentArray;
    return currentObj;
  }

  return parseBlock(0) || {};
}

export function stringifyYaml(obj: unknown, indent = 0): string {
  const spaces = ' '.repeat(indent);
  if (obj === null) return 'null';
  if (typeof obj === 'boolean') return obj ? 'true' : 'false';
  if (typeof obj === 'number') return String(obj);
  if (typeof obj === 'string') {
    const specialChars = [' ', ':', '#', '-', '[', ']', '{', '}', ',', '"', "'"];
    if (specialChars.some(char => obj.includes(char)) || obj === 'true' || obj === 'false' || obj === 'null') {
      return `"${obj.replace(/"/g, '\\"')}"`;
    }
    return obj;
  }
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return obj.map(item => {
      if (typeof item === 'object' && item !== null) {
        const inner = stringifyYaml(item, indent + 2).trimStart();
        const firstNewLineIdx = inner.indexOf('\n');
        if (firstNewLineIdx === -1) {
          return `${spaces}- ${inner}`;
        } else {
          const firstLine = inner.substring(0, firstNewLineIdx);
          const rest = inner.substring(firstNewLineIdx + 1);
          return `${spaces}- ${firstLine}\n${rest}`;
        }
      }
      return `${spaces}- ${stringifyYaml(item, indent + 2).trimStart()}`;
    }).join('\n');
  }
  if (typeof obj === 'object' && obj !== null) {
    return Object.entries(obj as Record<string, unknown>).map(([key, val]) => {
      if (val === null || val === undefined) {
        return `${spaces}${key}: null`;
      }
      if (typeof val === 'object') {
        const inner = stringifyYaml(val, indent + 2);
        if (Array.isArray(val)) {
          if (val.length === 0) return `${spaces}${key}: []`;
          return `${spaces}${key}:\n${inner}`;
        }
        return `${spaces}${key}:\n${inner}`;
      }
      return `${spaces}${key}: ${stringifyYaml(val)}`;
    }).join('\n');
  }
  return '';
}
