// Synthetic system pack (tests only): manual:spec-search:<terms> lists /spec/ by PROPFIND (Depth 1, D: namespace, parsed by
// the Hub with xml@1), fetches the Markdown files whose name or path holds one of the terms (terms joined by +), and
// projects a listing of the matches; the matched files are named artifacts that are the stored responses themselves.
type XmlElement = { name: string; attributes: Record<string, string>; children: (XmlElement | string)[] };
type Response = { ok: boolean; sha256: string | null; path: string; model?: { root?: XmlElement } };
type Input = { round: number; external: { key: string }; responses: Record<string, Response> };

function textOf(element: XmlElement): string {
  return element.children.map((child) => (typeof child === 'string' ? child : textOf(child))).join('');
}

function hrefs(element: XmlElement | undefined, out: string[] = [], depth = 0): string[] {
  if (element === undefined || depth > 32) return out;
  if (element.name === 'D:href') out.push(textOf(element).trim());
  for (const child of element.children) if (typeof child !== 'string') hrefs(child, out, depth + 1);
  return out;
}

function terms(key: string): string[] {
  return key
    .split('+')
    .map((term) => {
      try {
        return decodeURIComponent(term).toLowerCase();
      } catch {
        return term.toLowerCase();
      }
    })
    .filter((term) => term !== '');
}

export function searchPlan(input: unknown): unknown {
  const { round, external, responses } = input as Input;
  if (round === 1) return { requests: [{ key: 'list', route: 'list', params: { path: 'spec' } }], done: false };
  const wanted = terms(external.key);
  const matches = hrefs(responses.list?.model?.root)
    .filter((href) => href.endsWith('.md'))
    .filter((href) => {
      let name = href;
      try {
        name = decodeURIComponent(href);
      } catch {
        // keep the raw link
      }
      return wanted.some((term) => name.toLowerCase().includes(term));
    })
    .slice(0, 10);
  return { requests: matches.map((href, i) => ({ key: `file-${i + 1}`, route: 'file', href, against: 'list' })), done: true };
}

export function searchProject(input: unknown): unknown {
  const { responses } = input as Input;
  const files = Object.entries(responses).filter(([key, response]) => key.startsWith('file-') && response.ok);
  return {
    artifacts: [
      { name: 'content', media_type: 'application/json', json: { matches: files.map(([key, response]) => ({ key, path: response.path, sha256: response.sha256 })) } },
      ...files.map(([key]) => ({ name: key, media_type: 'text/markdown', response: key })),
    ],
  };
}

export function climb(): unknown {
  return { requests: [{ key: 'up', route: 'file', params: { path: 'spec/../../etc/passwd' } }], done: true };
}

export function projectThrows(): unknown {
  throw new Error('projection failed on purpose');
}

export function fixedRevision(): unknown {
  return { revision: 'r1', artifacts: [] };
}

export function badRevision(): unknown {
  return { revision: 'has space', artifacts: [] };
}

export function badMediaType(): unknown {
  return { artifacts: [{ name: 'content', media_type: 'not a media type', text: 'x' }] };
}

export function manyRequests(): unknown {
  return { requests: Array.from({ length: 60 }, (_, i) => ({ key: `f${i}`, route: 'file', params: { path: `spec/f${i}.md` } })), done: true };
}

/** The rows of the Markdown tables of a manual as JSON (a projection a CLI-manual pack plausibly makes). */
export function tableRows(input: unknown): unknown {
  const { responses, original } = input as { responses: Record<string, { text?: string }>; original: string };
  const text = responses[original]?.text;
  if (typeof text !== 'string') return { error: { code: 'docstore-test.no_text', message: '原件没有文本' } };
  const rows = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('|') && line.endsWith('|') && !/^\|\s*-/.test(line))
    .map((line) => line.slice(1, -1).split('|').map((cell) => cell.trim()));
  return { artifacts: [{ name: 'content', media_type: 'application/json', json: { rows } }] };
}

/** A link with `..;` segments, which a servlet container would normalize to a path outside the template. */
export function climbSemicolon(input: unknown): unknown {
  const { round } = input as { round: number };
  if (round === 1) return { requests: [{ key: 'list', route: 'list', params: { path: 'spec' } }], done: false };
  return { requests: [{ key: 'up', route: 'file', href: '..;/..;/admin/deleteAll', against: 'list' }], done: true };
}

/** A path parameter that percent-encodes to far more than a path may have. */
export function longPath(): unknown {
  return { requests: [{ key: 'long', route: 'file', params: { path: '中'.repeat(4000) } }], done: true };
}

/** A path taken from the read's arguments as given. */
export function echoPath(input: unknown): unknown {
  const { args } = input as { args: { path?: unknown } };
  return { requests: [{ key: 'file', route: 'file', params: { path: String(args.path ?? 'x') } }], done: true };
}
