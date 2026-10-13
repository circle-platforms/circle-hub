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
  badLines: string[];
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
  const badLines: string[] = [];
  const lines = frontmatter.split('\n');
  let index = 0;
  while (index < lines.length) {
    const raw = lines[index].replace(/\r$/, '');
    index += 1;
    if (raw.trim() === '' || raw.trim().startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+):(.*)$/.exec(raw);
    if (!match) {
      badLines.push(raw);
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

// Harness frontmatter carries tool lists both as YAML arrays and as
// comma-separated scalars (`tools: Read, Write`); accept both.
export function parseNameList(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value.map((entry) => entry.trim()).filter((entry) => entry !== '');
  return value.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
}

export function scalar(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value.join(', ') : value;
}
