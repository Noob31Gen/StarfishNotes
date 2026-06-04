/**
 * Safely parse a JSON string, handling leading/trailing whitespace,
 * null bytes, and PKCS7 trailing padding/junk characters from decryption.
 */
export function safeParseJson<T>(content: string, defaultValue: T): T {
  if (!content || !content.trim()) {
    return defaultValue;
  }

  const trimmed = content.trim().replace(/\0/g, '');
  
  // Try standard parse first
  try {
    return JSON.parse(trimmed) as T;
  } catch (e) {
    // If it's an object, extract between first '{' and last '}'
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      try {
        const substring = trimmed.substring(firstBrace, lastBrace + 1);
        return JSON.parse(substring) as T;
      } catch (innerError) {
        console.error('Failed to parse extracted JSON object:', innerError);
      }
    }

    // If it's an array, extract between first '[' and last ']'
    const firstBracket = trimmed.indexOf('[');
    const lastBracket = trimmed.lastIndexOf(']');
    if (firstBracket !== -1 && lastBracket !== -1 && lastBracket > firstBracket) {
      try {
        const substring = trimmed.substring(firstBracket, lastBracket + 1);
        return JSON.parse(substring) as T;
      } catch (innerError) {
        console.error('Failed to parse extracted JSON array:', innerError);
      }
    }

    console.error('safeParseJson failed to parse content:', e);
    return defaultValue;
  }
}
