// Read functions of the PLM query service system pack (pure, run in the Hub sandbox). Every answer is HTTP 200 with an
// envelope {code, msg, data}; reads use GET and POST, so the profile lists every read route one by one and no write route.
// Ids are numbers in some answers and strings in others, and steps and specs are HTML: the projection of a bug or a story
// gives content {id, kind, title, fields, html_fields} with every HTML field as plain text (the original keeps the answer);
// bugs additionally echo the configured fix_field, without guessing or checking its presence in the record,
// and fix_notes: comments of actions whose code is exactly a member of settings.bug_fix_actions.
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

/** The closed set settings.bug_fix_actions, a JSON array of action codes. Anything else is not configured. */
function declaredActions(settings: Record<string, unknown>): { codes: ReadonlySet<string> } | { note: string } {
  if (!Object.hasOwn(settings, 'bug_fix_actions') || settings.bug_fix_actions == null || settings.bug_fix_actions === '') return { note: '缺少设置 settings.bug_fix_actions' };
  let value: unknown = settings.bug_fix_actions;
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return { note: '设置 settings.bug_fix_actions 不是 JSON 字符串数组' }; }
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || item === '')) return { note: '设置 settings.bug_fix_actions 不是 JSON 字符串数组' };
  return { codes: new Set(value) };
}

/** Comments whose action code equals a declared code, in the original order. HTML comments use the pack's plain text; the original answer is unchanged. */
function fixNotesOf(record: Record<string, unknown>, declared: { codes: ReadonlySet<string> } | { note: string }): { fix_notes: Array<{ action: string; date: string | null; actor: string | null; comment: string; index: number }> | null; fix_notes_note?: string } {
  if ('note' in declared) return { fix_notes: null, fix_notes_note: declared.note };
  const actions = Array.isArray(record.actions) ? record.actions : [];
  const fix_notes = [];
  for (let index = 0; index < actions.length; index++) {
    const row = actions[index];
    if (!isRecord(row) || typeof row.action !== 'string' || !declared.codes.has(row.action) || typeof row.comment !== 'string' || row.comment === '') continue;
    const comment = isHtml(row.comment) ? htmlText(row.comment) : row.comment;
    if (comment === '') continue;
    fix_notes.push({ action: row.action, date: typeof row.date === 'string' ? row.date : null, actor: typeof row.actor === 'string' ? row.actor : null, comment, index });
  }
  return { fix_notes };
}

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
  const notes = kind === 'bug' ? fixNotesOf(record, declaredActions(settings)) : null;
  const status = typeof record.status === 'string' ? record.status : typeof record.stage === 'string' ? record.stage : null;
  return {
    ...(notes?.fix_notes_note ? { note: notes.fix_notes_note } : {}),
    artifacts: [
      { name: 'content', media_type: 'application/json', json: { id: key, kind, title, fields, html_fields: html, ...(kind === 'bug' ? { fix_field: fixField, ...notes } : {}) } },
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
    const fieldsNonscalar = ['status', 'stage'].filter(key => Object.hasOwn(record, key) && record[key] !== undefined && !scalar(record[key]));
    stories.push({ id, status: scalar(record.status) ? record.status : null, stage: scalar(record.stage) ? record.stage : null,
      fields_nonscalar: fieldsNonscalar,
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
function buildKey(key: string): { key: BuildKey } | { error: string } {
  if (!key) return { error: '构建读取键为空；给出产品编号，或每族名字单独编码后用 + 连接' };
  if (Buffer.byteLength('plm:builds:' + key) > 900) return { error: '外部对象标识超过 900 字节上限；缩短名字集合或使用 plm:builds:<产品编号>' };
  if (/^[0-9]+$/.test(key)) return PRODUCT_ID.test(key) ? { key: { id: key } } : { error: '产品编号超过 9 位；请核对编号或按产品名字读取' };
  const names: string[] = [];
  for (const [index, part] of key.split('+').entries()) {
    let name: string;
    try { name = nameKey(decodeURIComponent(part)); }
    catch { return { error: '第 ' + (index + 1) + ' 个名字的百分号编码无效；每族名字用 URI 编码后以 + 连接' }; }
    if (!name) return { error: '第 ' + (index + 1) + ' 个名字为空；补齐该族名字或删除多余的 + 分隔符' };
    if (name.includes('/')) return { error: '第 ' + (index + 1) + ' 个名字里不能有 /；每族名字单独编码后用 + 连接' };
    if (!names.includes(name)) names.push(name);
  }
  return { key: { names } };
}

type ProductChoice = { product: Product | null; resolution: Resolution; candidates?: Product[] };
/** The caller's numeric identity is explicit; names need exactly one matching product row. */
function chooseProduct(key: BuildKey, responses: Record<string, Response>): ProductChoice | { error: string } {
  if ('id' in key) return { product: { id: key.id, name: null }, resolution: 'resolved' };
  const response = responses.products;
  const data = isRecord(response?.json) ? response.json.data : undefined;
  const fallback = '；下一步核对该行原件，或改用 plm:builds:<产品编号>';
  if (response?.ok === false) return { error: '产品列表请求未成功；核对读取记录和访问，或改用 plm:builds:<产品编号>' };
  if (!Array.isArray(data)) return { error: '产品列表的 data 不是数组；核对原始应答，或改用 plm:builds:<产品编号>' };
  for (const [index, row] of data.entries()) {
    if (!isRecord(row)) return { error: '产品列表第 ' + (index + 1) + ' 行不是对象' + fallback };
    if (typeof row.name !== 'string') return { error: '产品列表第 ' + (index + 1) + ' 行（id=' + String(row.id ?? '未给出').slice(0, 40) + '）的 name 不是字符串' + fallback };
  }
  const matches = data.filter((item) => isRecord(item) && typeof item.name === 'string' &&
    key.names.every((name) => (item.name as string).normalize('NFKC').split('/').map((alias) => alias.trim().toLowerCase()).includes(name)));
  const distinct = new Map<string, Product>();
  for (const row of matches) {
    const id = idText(row.id);
    if (id === null || !PRODUCT_ID.test(id)) return { error: '匹配产品列表第 ' + (data.indexOf(row) + 1) + ' 行的 id 不是 1 到 9 位数字' + fallback };
    if (!distinct.has(id)) distinct.set(id, { id, name: row.name as string });
  }
  const candidates = [...distinct.values()];
  if (candidates.length !== 1) return { product: null, resolution: candidates.length ? 'ambiguous' : 'unresolved', candidates };
  return { product: candidates[0], resolution: 'resolved' };
}

/** Numeric keys read one build list; name keys first resolve the product, with at most two requests. */
export function buildsPlan(input: unknown): PlanOutput {
  const { type, key: raw, responses } = partsOf(input);
  const parsed = type === 'builds' ? buildKey(raw) : { error: '读取类型不是 builds' };
  if ('error' in parsed) return { requests: [], done: true };
  const key = parsed.key;
  if ('names' in key && !Object.hasOwn(responses, 'products')) return { requests: [{ key: 'products', route: 'products' }], done: false };
  const choice = chooseProduct(key, responses);
  if ('error' in choice || !choice.product) return { requests: [], original: 'products', done: true };
  return { requests: Object.hasOwn(responses, 'builds') ? [] : [{ key: 'builds', route: 'builds', query: { product: choice.product.id } }], original: 'builds', done: true };
}

/** Build scope is deployment configuration, never a guessed field or free-text parsing. */
export function buildsProject(input: unknown): unknown {
  const { type, key: rawKey, responses, original } = partsOf(input);
  const parsed = type === 'builds' ? buildKey(rawKey) : { error: '读取类型不是 builds' };
  if ('error' in parsed) return { error: { code: 'plm.invalid_key', message: parsed.error } };
  const key = parsed.key;
  const choice = chooseProduct(key, responses);
  if ('error' in choice) return { error: { code: 'plm.no_products', message: choice.error } };
  if (choice.product === null) {
    const cause = choice.resolution === 'ambiguous' ? '多个不同产品编号同时匹配请求名字' : '没有产品同时包含全部请求名字';
    const note = ('下一步：核对名字，或明确使用 plm:builds:<产品编号> 重新读取（由集成者核实编号后配置）；尚未读取构建列表。原因：' + cause).slice(0, 500);
    return { complete: false, note, artifacts: [{ name: 'content', media_type: 'application/json', json: { product: null, product_resolution: choice.resolution, builds: null, candidates: choice.candidates ?? [], requested_names: 'names' in key ? key.names : [], note } }] };
  }
  const data = responses[original]?.json;
  if (responses[original]?.ok === false || !Array.isArray(data)) return { error: { code: 'plm.no_records', message: '构建列表不是数组；重新读取该产品的构建原件' } };
  const settings = isRecord(input) && isRecord(input.settings) ? input.settings : {};
  const field = typeof settings.build_story_field === 'string' && settings.build_story_field !== '' ? settings.build_story_field : null;
  const builds = data.filter(isRecord).map(record => {
    const raw = field !== null && Object.hasOwn(record, field) ? record[field] : undefined;
    const valid = Array.isArray(raw) && raw.every(id => {
      const text = idText(id); return text !== null && ID.test(text.replace(/^0+/, '') || '0');
    });
    const stories = valid ? [...new Set((raw as unknown[]).map(id => idText(id)!.replace(/^0+/, '') || '0'))].sort((a, b) => Number(a) - Number(b)) : null;
    const fields = Object.fromEntries(Object.entries(record).filter(([, value]) => value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)));
    return { id: idText(record.id), name: typeof record.name === 'string' ? record.name : null, fields, stories, scope_note: valid ? '需求范围取自构建记录' : `构建记录里没有需求字段，请给出需求编号；${field === null ? '缺少设置 settings.build_story_field' : `字段 ${field} 缺失或不是需求编号数组`}` };
  });
  const note = 'id' in key ? '产品编号取自读取键，没有对照产品列表核对；构建列表为空不证明产品存在。下一步如需核实产品身份，请对照产品列表或按名字读取' : undefined;
  return { ...(note ? { note } : {}), artifacts: [{ name: 'content', media_type: 'application/json', json: { product: choice.product, product_resolution: choice.resolution, builds, ...(note ? { note } : {}) } }] };
}
