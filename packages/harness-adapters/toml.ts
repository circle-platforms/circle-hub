// TOML subset parser/emitter for harness config (Codex `.codex/config.toml`,
// Gemini commands/*.toml), written without new dependencies. Supported:
// comments, `[a.b]` sections with bare or quoted segments, `key = value` with
// basic strings ("..."), multiline basic strings ("""..."""), literal strings
// ('...'), integers, floats, booleans, and single-line arrays of scalars.
// Unsupported (reported as bad lines, never guessed): multiline literal
// strings, inline tables, arrays of tables, dates, nested arrays.

export interface TomlParse {
  values: Record<string, unknown>;
  badLines: { line: number; text: string }[];
}

function stripComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote === '"') {
      if (char === '\\') index += 1;
      else if (char === '"') quote = undefined;
    } else if (quote === "'") {
      if (char === "'") quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '#') {
      return line.slice(0, index);
    }
  }
  return line;
}

function parseBasicString(value: string): string | undefined {
  if (!value.startsWith('"') || value.length < 2 || !value.endsWith('"')) return undefined;
  const inner = value.slice(1, -1);
  let result = '';
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (char !== '\\') {
      result += char;
      continue;
    }
    index += 1;
    const escaped = inner[index];
    if (escaped === 'n') result += '\n';
    else if (escaped === 't') result += '\t';
    else if (escaped === 'r') result += '\r';
    else if (escaped === '"' || escaped === '\\') result += escaped;
    else return undefined;
  }
  return result;
}

function splitArray(inner: string): string[] | undefined {
  const parts: string[] = [];
  let quote: string | undefined;
  let start = 0;
  for (let index = 0; index < inner.length; index += 1) {
    const char = inner[index];
    if (quote === '"') {
      if (char === '\\') index += 1;
      else if (char === '"') quote = undefined;
    } else if (quote === "'") {
      if (char === "'") quote = undefined;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ',') {
      parts.push(inner.slice(start, index));
      start = index + 1;
    } else if (char === '[' || char === ']' || char === '{') {
      return undefined;
    }
  }
  if (quote !== undefined) return undefined;
  parts.push(inner.slice(start));
  return parts;
}

function parseValue(raw: string): { ok: true; value: unknown } | { ok: false } {
  const value = raw.trim();
  if (value.startsWith('"""') || value.startsWith("'''")) return { ok: false };
  if (value.startsWith('"')) {
    const parsed = parseBasicString(value);
    return parsed === undefined ? { ok: false } : { ok: true, value: parsed };
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) return { ok: false };
    return { ok: true, value: value.slice(1, -1) };
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) return { ok: false };
    const parts = splitArray(value.slice(1, -1));
    if (parts === undefined) return { ok: false };
    const items: unknown[] = [];
    for (const part of parts) {
      if (part.trim() === '') continue;
      const item = parseValue(part);
      if (!item.ok) return { ok: false };
      items.push(item.value);
    }
    return { ok: true, value: items };
  }
  if (value === 'true') return { ok: true, value: true };
  if (value === 'false') return { ok: true, value: false };
  if (/^[+-]?\d+$/.test(value)) return { ok: true, value: Number.parseInt(value, 10) };
  if (/^[+-]?\d+\.\d+$/.test(value)) return { ok: true, value: Number.parseFloat(value) };
  return { ok: false };
}

function parseSectionPath(raw: string): string[] | undefined {
  const segments: string[] = [];
  let rest = raw;
  while (rest.length > 0) {
    const bare = /^([A-Za-z0-9_-]+)\s*(?:\.(.*))?$/.exec(rest);
    if (bare) {
      segments.push(bare[1]);
      rest = (bare[2] ?? '').trim();
      continue;
    }
    const quoted = /^"((?:[^"\\]|\\.)*)"\s*(?:\.(.*))?$/.exec(rest);
    if (quoted) {
      const parsed = parseBasicString(`"${quoted[1]}"`);
      if (parsed === undefined) return undefined;
      segments.push(parsed);
      rest = (quoted[2] ?? '').trim();
      continue;
    }
    return undefined;
  }
  return segments.length > 0 ? segments : undefined;
}

function parseMultilineBasic(text: string): string | undefined {
  // text starts at the opening """
  let index = 3;
  if (text[index] === '\n') index += 1;
  let content = '';
  while (index < text.length) {
    if (text.startsWith('"""', index)) {
      const rest = stripComment(text.slice(index + 3)).trim();
      return rest === '' ? content : undefined;
    }
    const char = text[index];
    if (char === '\\') {
      const escaped = text[index + 1];
      if (escaped === 'n') content += '\n';
      else if (escaped === 't') content += '\t';
      else if (escaped === 'r') content += '\r';
      else if (escaped === '"' || escaped === '\\') content += escaped;
      else if (escaped === '\n' || escaped === undefined) {
        // line-ending backslash: skip the newline and following whitespace
        index += 2;
        while (index < text.length && /[ \t\n]/.test(text[index])) index += 1;
        continue;
      } else return undefined;
      index += 2;
      continue;
    }
    content += char;
    index += 1;
  }
  return undefined;
}

function multilineClosed(text: string): boolean {
  let index = 3;
  while (index < text.length) {
    if (text[index] === '\\') {
      index += 2;
      continue;
    }
    if (text.startsWith('"""', index)) return true;
    index += 1;
  }
  return false;
}

export function parseToml(text: string): TomlParse {
  const values: Record<string, unknown> = {};
  const badLines: { line: number; text: string }[] = [];
  let current: Record<string, unknown> = values;
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index].replace(/\r$/, '');
    const line = stripComment(rawLine).trim();
    if (line === '') continue;
    if (line.startsWith('[')) {
      const section = /^\[(.+)\]$/.exec(line);
      const segments = section ? parseSectionPath(section[1].trim()) : undefined;
      if (segments === undefined) {
        badLines.push({ line: index + 1, text: rawLine });
        current = values;
        continue;
      }
      current = values;
      let broken = false;
      for (const segment of segments) {
        const next = current[segment];
        if (next === undefined) {
          const created: Record<string, unknown> = {};
          current[segment] = created;
          current = created;
        } else if (typeof next === 'object' && next !== null && !Array.isArray(next)) {
          current = next as Record<string, unknown>;
        } else {
          badLines.push({ line: index + 1, text: rawLine });
          broken = true;
          break;
        }
      }
      if (broken) current = values;
      continue;
    }
    const assignment = /^([A-Za-z0-9_-]+|"([^"]*)"|'([^']*)')\s*=\s*(.+)$/.exec(line);
    if (!assignment) {
      badLines.push({ line: index + 1, text: rawLine });
      continue;
    }
    const key = assignment[2] ?? assignment[3] ?? assignment[1];
    // Multiline basic strings accumulate raw lines until the closing """.
    const rawAssignment = /^([A-Za-z0-9_-]+|"([^"]*)"|'([^']*)')\s*=\s*(.+)$/.exec(rawLine.trim());
    if (rawAssignment && rawAssignment[4].trimStart().startsWith('"""')) {
      let full = rawAssignment[4].trimStart();
      while (!multilineClosed(full) && index + 1 < lines.length) {
        index += 1;
        full += `\n${lines[index].replace(/\r$/, '')}`;
      }
      const multiline = parseMultilineBasic(full);
      if (multiline === undefined) {
        badLines.push({ line: index + 1, text: rawLine });
        continue;
      }
      current[key] = multiline;
      continue;
    }
    const parsed = parseValue(assignment[4]);
    if (!parsed.ok) {
      badLines.push({ line: index + 1, text: rawLine });
      continue;
    }
    current[key] = parsed.value;
  }
  return { values, badLines };
}

function quoteKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

// 1-based line numbers of lines carrying a comment (full-line or trailing).
export function commentLines(text: string): number[] {
  const lines: number[] = [];
  text.split('\n').forEach((raw, index) => {
    const line = raw.replace(/\r$/, '');
    if (stripComment(line).length !== line.length) lines.push(index + 1);
  });
  return lines;
}

function emitValue(value: unknown): string | undefined {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) {
    const items = value.map(emitValue);
    if (items.some((item) => item === undefined)) return undefined;
    return `[${items.join(', ')}]`;
  }
  return undefined;
}

// Canonical TOML for the supported subset: scalars of a table first (in
// insertion order), then sub-tables, one blank line before each section
// header, trailing newline at the end. A table header is written only when
// the table has own scalar entries — a table holding only sub-tables (like
// `mcp_servers`) never gets a bare header, and empty tables vanish entirely.
export function emitToml(values: Record<string, unknown>): string {
  const lines: string[] = [];
  const emitTable = (path: string[], table: Record<string, unknown>): void => {
    const scalars = Object.entries(table).filter(
      ([, value]) => !(value && typeof value === 'object' && !Array.isArray(value)) && emitValue(value) !== undefined,
    );
    const subtables = Object.entries(table).filter(
      ([, value]) => value && typeof value === 'object' && !Array.isArray(value),
    ) as Array<[string, Record<string, unknown>]>;
    if (path.length > 0 && scalars.length > 0) {
      if (lines.length > 0) lines.push('');
      lines.push(`[${path.map(quoteKey).join('.')}]`);
      for (const [key, value] of scalars) lines.push(`${quoteKey(key)} = ${emitValue(value)}`);
    } else if (path.length === 0) {
      for (const [key, value] of scalars) lines.push(`${quoteKey(key)} = ${emitValue(value)}`);
    }
    for (const [key, value] of subtables) emitTable([...path, key], value);
  };
  emitTable([], values);
  if (lines.length === 0) return '';
  return `${lines.join('\n')}\n`;
}
