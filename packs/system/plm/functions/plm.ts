// Read functions of the PLM query service system pack (pure, run in the Hub sandbox). Every answer is HTTP 200 with an
// envelope {code, msg, data}; reads use GET and POST, so the profile lists every read route one by one and no write route.
// Ids are numbers in some answers and strings in others, and steps and specs are HTML: the projection of a bug or a story
// gives content {id, kind, title, fields, html_fields} with every HTML field as plain text (the original keeps the answer);
// bugs additionally echo the configured fix_field, without guessing or checking its presence in the record,
// and meta {id, kind, title, status}. An id the service does not know is a failed read (shown to callers as unavailable).

import type { Resolution } from '../../../../contracts/generated/vocabulary.ts';

type Planned = { key: string; route: string; body?: unknown; query?: Record<string, string> };
type PlanOutput = { requests: Planned[]; done: boolean; original?: string };
type Response = { ok?: boolean; json?: unknown };

const ID = /^[1-9][0-9]{0,14}$/;
export const MAX_BUGS_BATCH = 50;

/** Parses and normalises a bugs key (ids separated by '+'): sorted numerically and deduplicated, at most 50. */
export function parseBugsKey(key: string): string[] | null {
  if (typeof key !== 'string' || key.trim() === '') return null;
  const parts = key.split('+');
  if (parts.length === 0 || parts.length > MAX_BUGS_BATCH) return null;
  for (const part of parts) {
    if (!ID.test(part)) return null;
  }
  const unique = [...new Set(parts)].sort((a, b) => Number(a) - Number(b));
  if (unique.length === 0 || unique.length > MAX_BUGS_BATCH) return null;
  return unique;
}

const KINDS = { bug: { route: 'bug-detail', member: 'bug_ids', label: '缺陷' }, story: { route: 'story-detail', member: 'story_ids', label: '需求' } } as const;
type Kind = keyof typeof KINDS;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function partsOf(input: unknown): { type: string; key: string; responses: Record<string, Response>; original: string } {
  const record = isRecord(input) ? input : {};
  const external = isRecord(record.external) ? record.external : {};
  return {
    type: typeof external.type === 'string' ? external.type : '',
    key: typeof external.key === 'string' ? external.key : '',
    responses: (isRecord(record.responses) ? record.responses : {}) as Record<string, Response>,
    original: typeof record.original === 'string' ? record.original : '',
  };
}

const kindOf = (type: string): Kind | null => (type === 'bug' || type === 'story' ? type : null);

/** Plan of plm:bug:<id> and plm:story:<id>: one detail request for the one id. */
export function detailPlan(input: unknown): PlanOutput {
  const { type, key } = partsOf(input);
  const kind = kindOf(type);
  if (kind === null || !ID.test(key)) return { requests: [], done: true };
  return { requests: [{ key: 'detail', route: KINDS[kind].route, body: { [KINDS[kind].member]: [Number(key)] } }], done: true };
}

/** Plan of plm:bugs:<id>+<id>+...: one detail request for all ids (at most 50, sorted numerically, deduplicated). */
export function bugsPlan(input: unknown): PlanOutput {
  const { type, key } = partsOf(input);
  if (type !== 'bugs') return { requests: [], done: true };
  const ids = parseBugsKey(key);
  if (ids === null) return { requests: [], done: true };
  return { requests: [{ key: 'detail', route: 'bug-detail', body: { bug_ids: ids.map(Number) } }], done: true };
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z]{2,8});/g, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : whole;
    }
    return Object.hasOwn(ENTITIES, body) ? ENTITIES[body] : whole;
  });
}

const BLOCK = /^(?:p|div|br|li|tr|h[1-6]|ul|ol|table|blockquote|pre|section|article)$/i;

/** Whether a text is HTML markup (a start or end tag of a letter name). */
export function isHtml(text: string): boolean {
  return /<\/?[A-Za-z][A-Za-z0-9]*(?:\s[^<>]*)?\/?>/.test(text);
}

/** Plain text of an HTML fragment: block tags end lines, list items start with "- ", entities decoded, white space collapsed per line. */
export function htmlText(html: string): string {
  const marked = html.replace(/<(\/?)([A-Za-z][A-Za-z0-9]*)[^<>]*>/g, (_tag, close: string, name: string) => {
    if (name.toLowerCase() === 'li' && close === '') return '\n- ';
    return BLOCK.test(name) ? '\n' : '';
  });
  return decodeEntities(marked.replace(/<[^<>]*>/g, ''))
    .split('\n')
    .map((line) => line.replace(/[\s ]+/g, ' ').trim())
    .filter((line) => line !== '')
    .join('\n');
}

const idText = (value: unknown): string | null => (typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : typeof value === 'string' && value.trim() !== '' ? value.trim() : null);

/** Projection of a bug or a story: the one record of the id from the array in the envelope. */
export function detailProject(input: unknown): unknown {
  const { type, key, responses, original } = partsOf(input);
  const kind = kindOf(type);
  const data = isRecord(responses[original]?.json) ? (responses[original].json as Record<string, unknown>).data : undefined;
  if (kind === null || !Array.isArray(data)) return { error: { code: 'plm.no_records', message: '详情应答的 data 不是数组' } };
  const record = data.find((item) => isRecord(item) && idText(item.id) === key);
  if (!isRecord(record)) return { error: { code: 'plm.absent', message: `没有编号为 ${key} 的${KINDS[kind].label}` } };
  const fields: Record<string, unknown> = {};
  const html: string[] = [];
  for (const [name, value] of Object.entries(record)) {
    if (typeof value === 'string' && isHtml(value)) {
      fields[name] = htmlText(value);
      html.push(name);
    } else fields[name] = name === 'id' ? key : value;
  }
  const title = typeof record.title === 'string' ? record.title : typeof record.name === 'string' ? record.name : null;
  const settings = isRecord(input) && isRecord(input.settings) ? input.settings : {};
  const fixField = typeof settings.bug_fix_field === 'string' && settings.bug_fix_field.trim() !== '' ? settings.bug_fix_field : null;
  const status = typeof record.status === 'string' ? record.status : typeof record.stage === 'string' ? record.stage : null;
  return {
    artifacts: [
      { name: 'content', media_type: 'application/json', json: { id: key, kind, title, fields, html_fields: html, ...(kind === 'bug' ? { fix_field: fixField } : {}) } },
      { name: 'meta', media_type: 'application/json', json: { id: key, kind, title: title === null ? `${KINDS[kind].label} ${key}` : `${KINDS[kind].label} ${key} ${title}`, status } },
    ],
  };
}

/** Projection of batch bugs: each id's {id, status, title}, unreturned ids listed as unread. */
export function bugsProject(input: unknown): unknown {
  const { type, key, responses, original } = partsOf(input);
  if (type !== 'bugs') return { error: { code: 'plm.invalid_type', message: '类型不是 bugs' } };
  const ids = parseBugsKey(key);
  if (ids === null) return { error: { code: 'plm.invalid_key', message: '缺陷编号标识无效（最多 50 个正整数编号用 + 连接）' } };
  const data = isRecord(responses[original]?.json) ? (responses[original].json as Record<string, unknown>).data : undefined;
  if (!Array.isArray(data)) return { error: { code: 'plm.no_records', message: '详情应答的 data 不是数组' } };

  const bugs: Array<{ id: string; status: string | null; title: string | null }> = [];
  const unread: string[] = [];
  for (const id of ids) {
    const record = data.find((item) => isRecord(item) && idText(item.id) === id);
    if (isRecord(record)) {
      const status = typeof record.status === 'string' ? record.status : null;
      const title = typeof record.title === 'string' ? record.title : null;
      bugs.push({ id, status, title });
    } else {
      unread.push(id);
    }
  }

  return {
    artifacts: [
      {
        name: 'content',
        media_type: 'application/json',
        json: { bugs, unread },
      },
      {
        name: 'meta',
        media_type: 'application/json',
        json: { count: bugs.length, unread: unread.length },
      },
    ],
  };
}

/** Batch requirements use the same read-only detail route as a single story. */
export function storiesPlan(input: unknown): PlanOutput {
  const { type, key } = partsOf(input);
  const ids = type === 'stories' ? parseBugsKey(key) : null;
  return { requests: ids === null ? [] : [{ key: 'detail', route: 'story-detail', body: { story_ids: ids.map(Number) } }], done: true };
}

/** Status and stage are separate raw fields; no delivery semantics are inferred. */
export function storiesProject(input: unknown): unknown {
  const { type, key, responses, original } = partsOf(input);
  const ids = type === 'stories' ? parseBugsKey(key) : null;
  if (ids === null) return { error: { code: 'plm.invalid_key', message: '需求编号标识无效（最多 50 个正整数编号用 + 连接）' } };
  const data = isRecord(responses[original]?.json) ? (responses[original].json as Record<string, unknown>).data : undefined;
  if (!Array.isArray(data)) return { error: { code: 'plm.no_records', message: '详情应答的 data 不是数组' } };
  const stories = [];
  const unread = [];
  for (const id of ids) {
    const record = data.find((item) => isRecord(item) && idText(item.id) === id);
    if (!isRecord(record)) { unread.push(id); continue; }
    const scalar = (value: unknown) => value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value);
    if (['status', 'stage'].some(key => Object.hasOwn(record, key) && record[key] !== undefined && !scalar(record[key]))) return { error: { code: 'plm.no_records', message: '需求状态或阶段不是 JSON 标量' } };
    stories.push({ id, status: record.status ?? null, stage: record.stage ?? null,
      title: typeof record.title === 'string' ? record.title : null,
      fields_absent: ['status', 'stage'].filter(key => !Object.hasOwn(record, key) || record[key] === undefined) });
  }
  return { artifacts: [
    { name: 'content', media_type: 'application/json', json: { stories, unread } },
    { name: 'meta', media_type: 'application/json', json: { count: stories.length, unread: unread.length } },
  ] };
}

type Product = { id: string; name: string | null };
type BuildKey = { id: string } | { names: string[] };
const PRODUCT_ID = /^[0-9]{1,9}$/;
const nameKey = (value: string): string => value.normalize('NFKC').trim().toLowerCase();

/** Split before decoding: a percent-encoded plus belongs to one name. */
function buildKey(key: string): BuildKey | null {
  if (/^[0-9]+$/.test(key)) return PRODUCT_ID.test(key) ? { id: key } : null;
  if (!key || key.length > 4096) return null;
  try {
    const names = [...new Set(key.split('+').map((part) => nameKey(decodeURIComponent(part))))];
    return names.length && names.every((name) => name !== '') ? { names } : null;
  } catch { return null; }
}

type ProductChoice = { product: Product | null; resolution: Resolution };
/** The caller's numeric identity is explicit; names need exactly one matching product row. */
function chooseProduct(key: BuildKey, responses: Record<string, Response>): ProductChoice | null {
  if ('id' in key) return { product: { id: key.id, name: null }, resolution: 'resolved' };
  const response = responses.products;
  const data = isRecord(response?.json) ? response.json.data : undefined;
  if (response?.ok === false || !Array.isArray(data) || data.some((item) => !isRecord(item) || typeof item.name !== 'string')) return null;
  const matches = data.filter((item) => isRecord(item) && typeof item.name === 'string' &&
    key.names.every((name) => (item.name as string).normalize('NFKC').split('/').map(nameKey).includes(name)));
  if (matches.length !== 1) return { product: null, resolution: matches.length ? 'ambiguous' : 'unresolved' };
  const id = idText(matches[0].id);
  if (id === null || !PRODUCT_ID.test(id)) return null;
  return { product: { id, name: matches[0].name as string }, resolution: 'resolved' };
}

/** Numeric keys read one build list; name keys first resolve the product, with at most two requests. */
export function buildsPlan(input: unknown): PlanOutput {
  const { type, key: raw, responses } = partsOf(input);
  const key = type === 'builds' ? buildKey(raw) : null;
  if (key === null) return { requests: [], done: true };
  if ('names' in key && !Object.hasOwn(responses, 'products')) return { requests: [{ key: 'products', route: 'products' }], done: false };
  const choice = chooseProduct(key, responses);
  if (!choice?.product) return { requests: [], original: 'products', done: true };
  return { requests: Object.hasOwn(responses, 'builds') ? [] : [{ key: 'builds', route: 'builds', query: { product: choice.product.id } }], original: 'builds', done: true };
}

/** Build scope is deployment configuration, never a guessed field or free-text parsing. */
export function buildsProject(input: unknown): unknown {
  const { type, key: rawKey, responses, original } = partsOf(input);
  const key = type === 'builds' ? buildKey(rawKey) : null;
  if (key === null) return { error: { code: 'plm.invalid_key', message: '构建列表标识无效：提供产品编号，或逐个 URI 编码后以 + 连接的产品名字' } };
  const choice = chooseProduct(key, responses);
  if (choice === null) return { error: { code: 'plm.no_products', message: '产品列表不能证明产品身份；重新读取产品列表并核实 id 和 name 字段' } };
  if (choice.product === null) return { artifacts: [{ name: 'content', media_type: 'application/json', json: { product: null, product_resolution: choice.resolution, builds: [] } }] };
  const data = responses[original]?.json;
  if (responses[original]?.ok === false || !Array.isArray(data)) return { error: { code: 'plm.no_records', message: '构建列表不是数组；重新读取该产品的构建原件' } };
  const settings = isRecord(input) && isRecord(input.settings) ? input.settings : {};
  const field = typeof settings.build_story_field === 'string' && settings.build_story_field !== '' ? settings.build_story_field : null;
  const builds = data.filter(isRecord).map(record => {
    const raw = field !== null && Object.hasOwn(record, field) ? record[field] : undefined;
    const valid = Array.isArray(raw) && raw.every(id => {
      const text = idText(id); return text !== null && ID.test(text.replace(/^0+/, '') || '0');
    });
    const stories = valid ? [...new Set((raw as unknown[]).map(id => String(id).replace(/^0+/, '') || '0'))].sort((a, b) => Number(a) - Number(b)) : null;
    return { id: idText(record.id), name: typeof record.name === 'string' ? record.name : null, stories, scope_note: valid ? '需求范围取自构建记录' : `构建记录里没有需求字段，请给出需求编号；${field === null ? '缺少设置 settings.build_story_field' : `字段 ${field} 缺失或不是需求编号数组`}` };
  });
  return { artifacts: [{ name: 'content', media_type: 'application/json', json: { product: choice.product, product_resolution: choice.resolution, builds } }] };
}
