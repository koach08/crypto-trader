/**
 * Robust JSON parsing for AI-generated responses.
 * Handles common issues: code fences, trailing commas, BOM, comments.
 */

function cleanJsonString(text: string): string {
  let s = text;
  s = s.replace(/^\uFEFF/, "");
  s = s.replace(/^```(?:json)?\s*\n?/i, "");
  s = s.replace(/\n?```\s*$/i, "");
  s = s.trim();
  s = removeJsonComments(s);
  s = s.replace(/,\s*([\]}])/g, "$1");
  return s;
}

function removeJsonComments(s: string): string {
  const out: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '"') {
      out.push(s[i++]);
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          out.push(s[i++]);
        }
        out.push(s[i++]);
      }
      if (i < s.length) out.push(s[i++]);
    } else if (s[i] === '/' && i + 1 < s.length && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
    } else {
      out.push(s[i++]);
    }
  }
  return out.join('');
}

export function robustJsonParse<T = unknown>(text: string): T | null {
  const cleaned = cleanJsonString(text);

  try {
    return JSON.parse(cleaned) as T;
  } catch { /* continue */ }

  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start !== -1 && end > start) {
    const candidate = cleaned.slice(start, end + 1);
    try {
      return JSON.parse(candidate) as T;
    } catch { /* continue */ }

    const reCleaned = cleanJsonString(candidate);
    try {
      return JSON.parse(reCleaned) as T;
    } catch { /* continue */ }
  }

  const arrStart = cleaned.indexOf("[");
  const arrEnd = cleaned.lastIndexOf("]");
  if (arrStart !== -1 && arrEnd > arrStart) {
    const candidate = cleaned.slice(arrStart, arrEnd + 1);
    try {
      return JSON.parse(candidate) as T;
    } catch { /* continue */ }
  }

  return null;
}

export function parseAiJson<T>(
  text: string,
  validator?: (obj: T) => boolean
): T | null {
  const parsed = robustJsonParse<T>(text);
  if (parsed === null) return null;
  if (validator && !validator(parsed)) return null;
  return parsed;
}
