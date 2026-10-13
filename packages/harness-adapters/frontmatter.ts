// YAML frontmatter subset parser for harness markdown files (SKILL.md,
// agent and command definitions). Only the shapes those files use are
// supported: `key: scalar`, `key: [a, b]`, and `key:` followed by `- item`
// lines. Anything else is reported as a skipped line, never guessed.

export interface FrontmatterSplit {
  hasFrontmatter: boolean;
  frontmatter: string;
  body: string;
  unclosed: boolean;
}

export interface FrontmatterParse {
  values: Record<string, string | string[]>;
  // 0-based line index within the frontmatter block; file line = line + 2.
  // Warning details must carry line numbers and key names only, never text.
  badLines: { line: number; text: string }[];
}

export function splitFrontmatter(text: string): FrontmatterSplit {
  const lines = text.split('\n');
  if (lines[0]?.replace(/\r$/, '') !== '---') {
    return { hasFrontmatter: false, frontmatter: '', body: text, unclosed: false };
  }
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].replace(/\r$/, '') === '---') {
      return {
        hasFrontmatter: true,
        frontmatter: lines.slice(1, index).join('\n'),
        body: lines.slice(index + 1).join('\n'),
        unclosed: false,
      };
    }
  }
  return { hasFrontmatter: false, frontmatter: '', body: text, unclosed: true };
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed[trimmed.length - 1] === quote) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

export function parseFrontmatter(frontmatter: string): FrontmatterParse {
  const values: Record<string, string | string[]> = {};
  const badLines: { line: number; text: string }[] = [];
  const lines = frontmatter.split('\n');
  let index = 0;
  while (index < lines.length) {
    const raw = lines[index].replace(/\r$/, '');
    const lineNumber = index;
    index += 1;
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(raw);
    if (!match) {
      badLines.push({ line: lineNumber, text: raw });
      continue;
    }
    const [, key, rest] = match;
    const value = rest.trim();
    if (value === '') {
      const items: string[] = [];
      while (index < lines.length) {
        const item = /^\s+-\s+(.*)$/.exec(lines[index].replace(/\r$/, ''));
        if (!item) break;
        items.push(unquote(item[1]));
        index += 1;
      }
      values[key] = items;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      const inner = value.slice(1, -1).trim();
      values[key] = inner === '' ? [] : inner.split(',').map((entry) => unquote(entry));
    } else {
      values[key] = unquote(value);
    }
  }
  return { values, badLines };
}

// Harness frontmatter carries name lists both as YAML arrays and as
// whitespace/comma-separated scalars (`tools: Read, Write` or
// `allowed-tools: Read Grep`); accept both.
export function parseNameList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((entry) => entry.trim()).filter((entry) => entry !== '');
  return value.split(/[\s,]+/).filter((entry) => entry !== '');
}

export function scalar(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(', ') : value;
}

function renderScalar(value: string): string {
  const plain =
    value !== '' &&
    value === value.trim() &&
    !/^[-?:,[\]{}#&*!|>'"%@`]/.test(value) &&
    !value.includes(': ') &&
    !value.includes(' #') &&
    !/[\n\r\t]/.test(value);
  return plain ? value : JSON.stringify(value);
}

export function renderFrontmatterValue(value: string | string[]): string {
  if (Array.isArray(value)) return value.map(renderScalar).join(', ');
  return renderScalar(value);
}

// Canonical frontmatter for the export rewrite: one `key: value` line each,
// arrays comma-joined, scalars bare unless they need quoting.
export function serializeFrontmatter(pairs: Array<[string, string | string[]]>): string {
  return pairs.map(([key, value]) => `${key}: ${renderFrontmatterValue(value)}`).join('\n');
}
