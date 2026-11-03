import {technicalCode,stat,facts} from './presentation.ts';
// Search for the console (the interface doc's GET /search?q): matches among the tasks, task packs, knowledge (product
// lines, their builds and version lines, a tree path in the current roots), records (call-log lines) and, for
// administrators, members, each with the visibility of its own page. Bounded: the query is at most SEARCH_MAX_QUERY
// characters; each kind gives at most SEARCH_MAX_HITS matches; tasks are looked for among the latest RUNS_SCANNED runs
// the reader may see, records among the latest CALLS_SCANNED call-log lines (or exactly, by a run id, a tool or a
// member's name), knowledge in at most MAX_LINES product lines. When a bound stopped a kind before its end, the answer
// says that kind is partial: more matches may exist.
import { uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { code, html, link, page, table } from './html.ts';
import { byId, shownVersion } from './packs.ts';
import { spaceSearch } from './spaces.ts';
import { readableLines, type PageContext, type PageResult } from './pages.ts';
import { TOOL_LABELS, packTitles, taskTitle } from './tasks.ts';
import { card, sectionHead, when } from './ui.ts';

export const SEARCH_MAX_QUERY = 100;
export const SEARCH_MAX_HITS = 10;
const RUNS_SCANNED = 300;
const RUN_PAGE = 100;
const CALLS_SCANNED = 300;
const MAX_LINES = 20;
const MAX_ROOTS = 20;
const RUN_ID = /^run_[0-9a-z]{26}$/;
const USER_ID = /^usr_[0-9a-z]{26}$/;

export interface TaskHit { run: string; title: string; pack: string; product: string | null; started_at: string; runner: string | null }
export interface PackHit { space?:string;id: string; title: string; kind: string; kind_label: string }
export type KnowledgeHit =
  | { kind: 'line'; product: string; title: string; names: string[] }
  | { kind: 'build'; product: string; build: string; line: string; root: string | null }
  | { kind: 'path'; product: string; line: string; root: string; path: string; name: string };
export interface RecordHit { at: string; tool: string; tool_label: string; run: string | null; user: string | null; digest: string }
export interface MemberHit { id: string; name: string; role: string; role_label: string }

export interface SearchResults {
  q: string;
  tasks: TaskHit[];
  packs: PackHit[];
  knowledge: KnowledgeHit[];
  records: RecordHit[];
  /** Administrators only; empty for members. */
  members: MemberHit[];
  /** A bound stopped the search of this kind before its end: more matches may exist. */
  partial: { tasks: boolean; knowledge: boolean; records: boolean };
}

/** The query as matched: trimmed, at most SEARCH_MAX_QUERY characters. */
export function searchQuery(raw: string): string {
  return [...raw.trim()].slice(0, SEARCH_MAX_QUERY).join('');
}

const matches = (needle: string, ...values: (string | null | undefined)[]): boolean =>
  values.some((value) => typeof value === 'string' && value.toLowerCase().includes(needle));

export async function searchHub(ctx: PageContext, raw: string): Promise<SearchResults> {
  const q = searchQuery(raw);
  const results: SearchResults = { q, tasks: [], packs: [], knowledge: [], records: [], members: [], partial: { tasks: false, knowledge: false, records: false } };
  if (q === '') return results;
  const needle = q.toLowerCase();
  const titles = await packTitles(ctx);

  // Tasks: the latest runs the reader may see.
  let cursor: string | null = null;
  let scanned = 0;
  scan: do {
    const listing = await ctx.deps.runs.listRuns(ctx.principal, { limit: RUN_PAGE, cursor });
    for (const run of listing.items) {
      scanned += 1;
      const runner = run.runner === undefined ? null : await ctx.userName(run.runner);
      if (matches(needle, run.run, run.pack, taskTitle(run, titles), run.product, run.version, run.build, runner)) {
        if (results.tasks.length === SEARCH_MAX_HITS) {
          results.partial.tasks = true;
          break scan;
        }
        results.tasks.push({ run: run.run, title: taskTitle(run, titles), pack: run.pack, product: run.product ?? null, started_at: run.started_at, runner });
      }
    }
    cursor = listing.next;
    if (cursor !== null && scanned >= RUNS_SCANNED) results.partial.tasks = true;
  } while (cursor !== null && scanned < RUNS_SCANNED);

  // Task packs the reader may list, by id and title.
  for (const versions of byId(await ctx.deps.packs.list(ctx.principal)).values()) {
    const pack = shownVersion(versions);
    if (results.packs.length < SEARCH_MAX_HITS && matches(needle, pack.id, pack.title)) {
      results.packs.push({ ...(pack.space?{space:pack.space}:{}),id: pack.id, title: pack.title, kind: pack.kind, kind_label: uiLabelOf('pack_kind', pack.kind) });
    }
  }

  // Knowledge: the readable product lines, their builds and version lines, and a tree path in their current roots.
  const lines = await readableLines(ctx);
  if (lines.length > MAX_LINES) results.partial.knowledge = true;
  const roots: { product: string; line: string; root: string }[] = [];
  for (const line of lines.slice(0, MAX_LINES)) {
    if (matches(needle, line.id, line.title, ...line.names)) results.knowledge.push({ kind: 'line', product: line.id, title: line.title, names: line.names });
    const builds = await ctx.deps.knowledge.builds(line.id);
    for (const build of builds) {
      if (matches(needle, build.name, build.line)) results.knowledge.push({ kind: 'build', product: line.id, build: build.name, line: build.line, root: build.root });
    }
    if (q.startsWith('/')) {
      for (const versionLine of new Set(builds.map((build) => build.line))) {
        if (roots.length === MAX_ROOTS) {
          results.partial.knowledge = true;
          break;
        }
        const current = await ctx.deps.knowledge.currentRoot(line.id, versionLine);
        if (current !== null) roots.push({ product: line.id, line: versionLine, root: current.root });
      }
    }
  }
  for (const where of roots) {
    const found = await ctx.deps.knowledge.getNodes({ root: where.root, paths: [q], depth: 0 }, ctx.principal);
    const node = found?.nodes.find((candidate) => candidate.path === q);
    if (node !== undefined) results.knowledge.push({ kind: 'path', ...where, path: node.path, name: node.name });
  }
  if (results.knowledge.length > SEARCH_MAX_HITS) {
    results.knowledge = results.knowledge.slice(0, SEARCH_MAX_HITS);
    results.partial.knowledge = true;
  }

  // Records: the call-log lines the reader may see; exactly by a run, a tool or (administrators) a member, else the latest.
  const tool = [...TOOL_LABELS].find(([name, label]) => name === q || label === q)?.[0];
  const member = ctx.admin ? await memberNamed(ctx, q) : null;
  const filter = RUN_ID.test(q) ? { runId: q } : tool !== undefined ? { tool } : member !== null ? { userId: member } : null;
  const lines_ = await ctx.deps.records.callLog.query(ctx.principal, { ...(filter ?? {}), limit: filter === null ? CALLS_SCANNED : SEARCH_MAX_HITS });
  for (const line of lines_.items) {
    const user = line.user === null ? null : await ctx.userName(line.user);
    if (filter !== null || matches(needle, line.tool, TOOL_LABELS.get(line.tool), line.run, line.trace_id, ctx.admin ? user : null)) {
      if (results.records.length === SEARCH_MAX_HITS) {
        results.partial.records = true;
        break;
      }
      results.records.push({ at: line.at, tool: line.tool, tool_label: TOOL_LABELS.get(line.tool) ?? line.tool, run: line.run, user, digest: line.digest });
    }
  }
  if (lines_.next !== null) results.partial.records = true;

  // Members: administrators only.
  if (ctx.admin) {
    for (const user of await ctx.deps.records.principals.list()) {
      if (results.members.length < SEARCH_MAX_HITS && matches(needle, user.name, user.id)) {
        results.members.push({ id: user.id, name: user.name, role: user.role, role_label: uiLabelOf('permission_role', user.role) });
      }
    }
  }
  return results;
}

async function memberNamed(ctx: PageContext, q: string): Promise<string | null> {
  if (USER_ID.test(q)) return (await ctx.deps.records.principals.get(q))?.id ?? null;
  return (await ctx.deps.records.principals.findByName(q))?.id ?? null;
}

/** The search page: /console/search?q=…, server-rendered; the sidebar's search box submits to it. */
export async function searchPage(ctx: PageContext): Promise<PageResult> {
  const raw = ctx.url.searchParams.get('q') ?? '';
  const spaceKnowledge=await spaceSearch(ctx);
  const results = await searchHub(ctx, raw);
  const chrome = ctx.chrome('搜索', results.q === '' ? { hint: '在任务、工作流、知识库与记录中查找' } : { sub: `“${results.q}”的查找结果` });
  const form = html`<form class="ch-actions" data-filters method="get" action="/console/search"><label>关键词 <input name="q" value="${results.q}" maxlength="${SEARCH_MAX_QUERY}" required></label><button class="ch-btn ch-btn--secondary" type="submit">搜索</button></form>`;
  if (results.q === '') return { status: 200, body: page(chrome, html`${spaceKnowledge}${card(null, html`${form}`)}`) };
  const partial = (yes: boolean, what: string) => (yes ? html`<p class="ch-meta">${what}</p>` : '');
  const knowledgeRow = (hit: KnowledgeHit) => {
    if (hit.kind === 'line') return ['产品线', link('/console/knowledge/product', hit.title, { id: hit.product }), hit.names.join('、')];
    if (hit.kind === 'build') return ['构建', link('/console/knowledge/product', hit.build, { id: hit.product, line: hit.line }), `${hit.product} · 版本线 ${hit.line}`];
    return ['条目', link('/console/knowledge/tree', hit.path, { root: hit.root, path: hit.path }), `${hit.product} · 版本线 ${hit.line} 的当前版本`];
  };
  const records = ctx.admin ? '/console/admin/calls' : '/console/records';
  const body = html`${spaceKnowledge}${card(null, form)}
${sectionHead('任务', `${results.tasks.length} 个`)}
${card(null, html`${table(['任务', uiLabelOf('pack_kind', 'workflow'), '执行人', '开始'], results.tasks.map((hit) => [link(`/console/runs/${hit.run}`, hit.title), technicalCode(hit.pack), hit.runner ?? '—', when(hit.started_at)]), '没有匹配的任务')}${partial(results.partial.tasks, `仅查找了最近的 ${RUNS_SCANNED} 个任务，或匹配多于 ${SEARCH_MAX_HITS} 个；可能还有其他匹配。`)}`)}
${sectionHead('发布内容', `${results.packs.length} 个`)}
${card(null, table(['标识', '名称', '类型'], results.packs.map((hit) => [link(`/console/packs/${hit.id}`, hit.title,hit.space?{space:hit.space}:{}), hit.title, hit.kind_label]), '没有匹配的发布内容'))}
${ctx.deps.knowledge.spaces ? '' : html`${sectionHead('知识库', `${results.knowledge.length} 项`)}
${card(null, html`${table(['类型', '名称', '所在'], results.knowledge.map(knowledgeRow), '没有匹配的知识')}${partial(results.partial.knowledge, `仅查找了前 ${MAX_LINES} 条产品线或前 ${MAX_ROOTS} 个当前版本，或匹配多于 ${SEARCH_MAX_HITS} 项；可能还有其他匹配。`)}`)}`}
${sectionHead('记录', `${results.records.length} 条`)}
${card(null, html`${table(['时间', '工具', '运行', ...(ctx.admin ? ['成员'] : [])], results.records.map((hit) => [when(hit.at), hit.tool_label, hit.run === null ? '—' : link(records, '查看任务记录', { run: hit.run }), ...(ctx.admin ? [hit.user ?? '—'] : [])]), '没有匹配的记录')}${partial(results.partial.records, `仅查找了最近的 ${CALLS_SCANNED} 条调用记录，或匹配多于 ${SEARCH_MAX_HITS} 条；可能还有其他匹配。`)}`)}
${ctx.admin ? html`${sectionHead('成员', `${results.members.length} 人`)}${card(null, table(['姓名', '角色', '编号'], results.members.map((hit) => [link(`/console/team/${hit.id}`, hit.name), hit.role_label, technicalCode(hit.id)]), '没有匹配的成员'))}` : ''}`;
  return { status: 200, body: page(chrome, body) };
}
