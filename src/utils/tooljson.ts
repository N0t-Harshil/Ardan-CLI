// Tool-call parsing fallback for models that emit tool calls as text
// instead of native tool_calls (common with small/local models).
//
// NOTE: the fenced-block marker (U+0060 x3) and the tool pseudo-tag are
// built via String.fromCharCode on purpose - the raw sequences are never
// written as literals in this source file.
import type { ToolCall } from '../types.ts';

const BK = String.fromCharCode(96);
const TRI = `${BK}${BK}${BK}`;

export interface ScanResult {
  calls: ToolCall[];
  cleanedText: string;
}

// ```(json|tool_call)?\n ... ```
const FENCE_RE = new RegExp(`${TRI}(?:json|tool_call)?\\s*\\n([\\s\\S]*?)${TRI}`, 'g');
// ```tool ... ```/tool```
const TAG_RE = new RegExp(
  `${TRI}\\s*tool\\s*([\\s\\S]*?)\\s*${TRI}\\s*/\\s*tool\\s*${TRI}`,
  'g',
);

function asArgs(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      /* fall through */
    }
  }
  return raw === undefined ? {} : { _raw: raw };
}

function parseCallObject(
  candidate: unknown,
  allowedNames: Set<string> | null,
): ToolCall | null {
  if (!candidate || typeof candidate !== 'object') return null;
  let obj = candidate as Record<string, unknown>;
  if (!('name' in obj) && obj.tool_call && typeof obj.tool_call === 'object') {
    obj = obj.tool_call as Record<string, unknown>;
  }
  const name = typeof obj.name === 'string' ? obj.name : undefined;
  if (!name) return null;
  if (allowedNames && !allowedNames.has(name)) return null;
  const rawArgs =
    obj.arguments !== undefined ? obj.arguments
    : obj.parameters !== undefined ? obj.parameters
    : obj.input;
  return { id: `call_${name}`, name, args: asArgs(rawArgs) };
}

export function parseSingleCall(
  jsonText: string,
  allowedNames: Set<string> | null,
): ToolCall | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      const call = parseCallObject(entry, allowedNames);
      if (call) return call;
    }
    return null;
  }
  return parseCallObject(parsed, allowedNames);
}

/**
 * Extract tool calls embedded in assistant text. Recognized shapes:
 *  1. ```json {"name": "Bash", "arguments": {...}} ``` fences
 *  2. ```tool ... ```/tool``` pseudo-tags
 *  3. bare tail-style {"name": "...", "arguments": {...}} objects
 * Returns the calls plus the text with those blocks removed.
 */
export function scanToolJson(text: string, allowedNames?: string[]): ScanResult {
  const allow =
    allowedNames && allowedNames.length ? new Set(allowedNames) : null;
  const calls: ToolCall[] = [];
  const accepted: Array<[number, number]> = [];

  // Tool pseudo-tags first, then json fences (skipping accepted ranges).
  const tagMatches = [...text.matchAll(TAG_RE)];
  for (const match of tagMatches) {
    const viaTag = parseSingleCall(String(match[1]).trim(), allow);
    if (viaTag) {
      calls.push(viaTag);
      accepted.push([match.index ?? 0, (match.index ?? 0) + match[0].length]);
    }
  }

  const fenceMatches = [...text.matchAll(FENCE_RE)];
  for (const match of fenceMatches) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    if (accepted.some(([s, e]) => start >= s && end <= e)) continue;
    const viaFence = parseSingleCall(String(match[1]).trim(), allow);
    if (viaFence) {
      calls.push(viaFence);
      accepted.push([start, end]);
    }
  }

  let cleaned = cutRanges(text, accepted);

  // Bare single objects: {"name": "...", "arguments": {...}}
  if (!calls.length) {
    let searchFrom = 0;
    while (searchFrom < cleaned.length) {
      const open = cleaned.indexOf('{', searchFrom);
      if (open === -1) break;
      if (cleaned.slice(open, open + 8) !== '"name": ' && cleaned.slice(open, open + 8) !== '{"name":') {
        searchFrom = open + 1;
        continue;
      }
      const balanced = balancedJson(cleaned, open);
      if (!balanced) break;
      const call = parseSingleCall(balanced.json, allow);
      if (call) {
        calls.push(call);
        cleaned = cleaned.slice(0, open) + cleaned.slice(balanced.end);
        searchFrom = open;
      } else {
        searchFrom = balanced.end;
      }
    }
  }

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();
  return { calls, cleanedText: cleaned };
}

/** Remove accepted [start, end) ranges, adjusting for earlier cuts. */
function cutRanges(text: string, ranges: Array<[number, number]>): string {
  if (!ranges.length) return text;
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  let out = '';
  let cursor = 0;
  for (const [start, end] of sorted) {
    if (start < cursor) continue;
    out += `${text.slice(cursor, start)}`;
    cursor = end;
  }
  out += text.slice(cursor);
  return out;
}

/** Find the balanced JSON object starting at `start`. */
function balancedJson(source: string, start: number): { json: string; end: number } | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return { json: source.slice(start, i + 1), end: i + 1 };
    }
  }
  return null;
}
