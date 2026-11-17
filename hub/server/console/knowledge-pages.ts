import {panel as knowledgePanel,facts as knowledgeFacts,section as knowledgeSection,areaPage as knowledgeShell,technicalCode,stat} from './presentation.ts';
import { digestOf } from '../../records/api.ts';
import { isEntryKind, isNodeLevel, uiLabelOf } from '../../../contracts/generated/vocabulary.ts';
import { packPurpose } from './pack-display.ts';
import { knowledgeContext, knowledgeTabs, spaceLayout } from './space-layout.ts';
import { coverageText } from '../claims.ts';
import { html, link, liveModule, page, pageLayout, pre, table, type Html } from './html.ts';
import { button, sectionHead } from './ui.ts';
import { citationsLine, countText, nodeCitations } from './citations.ts';
import { loadKnowledgeNodes } from './knowledge-reads.ts';
import { packSources } from './pack-sources.ts';
import {knowledgeHome} from './knowledge-home.ts';
import {sourceArchivePage} from './source-archive.ts';
import {memoryPage} from './memory.ts';
import { neutralPage, type PageContext, type PageResult } from './context.ts';
import { filterForm, nextPage, selectControl } from './components.ts';
import {
  knowledgeDiffPath,
  knowledgePath,
  knowledgeProductPath,
  knowledgeRootPath,
  knowledgeTreePath,
  operationsKnowledgePath,
  operationsPackPath,
} from './routes.ts';
import { SHA256, param } from './params.ts';
import { timestamp } from './knowledge-display.ts';

export interface ProductLine {
  id: string;
  title: string;
  names: string[];
}

export async function readableLines(ctx: PageContext): Promise<ProductLine[]> {
  const products = ctx.deps.products;
  if (products !== undefined) {
    const all = await products.products();
    const readable = ctx.admin ? null : await products.readableProducts(ctx.principal);
    const seen = new Map<string, ProductLine>();
    for (const handle of all) {
      const product = handle.product;
      if (readable !== null && !readable.has(product.id)) continue;
      if (!seen.has(product.id)) seen.set(product.id, { id: product.id, title: product.title, names: [...product.names] });
    }
    return [...seen.values()];
  }
  if (!ctx.admin) return [];
  const listing = await ctx.deps.packs.list(ctx.principal);
  return listing.filter((p) => p.kind === 'product' && !p.withdrawn).map((p) => ({ id: p.id, title: p.title, names: [] }));
}

async function productReadable(ctx: PageContext, product: string): Promise<ProductLine | null> {
  return (await readableLines(ctx)).find((line) => line.id === product) ?? null;
}

/** A root is readable when one of its compositions belongs to a product line the reader may read. */
export async function rootReadable(ctx: PageContext, root: string): Promise<boolean> {
  if (!SHA256.test(root)) return false;
  const infos = await ctx.deps.knowledge.rootInfo(root);
  if (infos.length === 0) return false;
  const lines = new Set((await readableLines(ctx)).map((line) => line.id));
  return infos.some((info) => lines.has(info.product));
}

/** The pending intake of the knowledge feeding for this reader; empty when there is none. */
async function intakePending(ctx: PageContext): Promise<Html> {
  const todos = await ctx.deps.knowledge.feeding?.todos(ctx.principal) ?? [];
  return todos.length === 0 ? html`` : knowledgeSection('知识入库待处理', table(['来源', '待补充内容', '后续处理', '检查脚本出错详情'], todos.map(row => [technicalCode(JSON.stringify(row.source)), row.missing, row.next_action, row.detail ? technicalCode(JSON.stringify(row.detail)) : '无'])));
}

/** The fourth tab of the knowledge place: the product knowledge sources the reader may see, and what waits for intake. */
export async function productSourcesPage(ctx: PageContext): Promise<PageResult> {
  const content = html`${knowledgeTabs(ctx)}${knowledgeContext(ctx, uiLabelOf('pack_kind', 'product'), undefined, uiLabelOf('knowledge_search_scope', 'team'))}${await packSources(ctx, 'product', [], { bare: true })}${await intakePending(ctx)}`;
  return { status: 200, body: page(ctx.chrome('知识库', { active: 'knowledge', hint: packPurpose('product') }), await spaceLayout(ctx, pageLayout(content, { inspector: null }))) };
}

export async function knowledgePage(ctx: PageContext): Promise<PageResult> {
  if(ctx.url.searchParams.get('view')==='sources')return sourceArchivePage(ctx);
  if(ctx.url.searchParams.get('view')==='memory')return memoryPage(ctx);
  // Decision 151: the home is the list of entries; the product knowledge sources and what waits for intake are the fourth tab.
  if(ctx.deps.knowledge.spaces)return {status:200,body:knowledgeShell(ctx.chrome('知识库',{active:'knowledge',hint:'同步到 Hub 的私人内容保存在 Hub 数据库和服务器备份中，仅本人及当前获分享权限者可读；记忆仅作会话偏好，不作为任务的来源'}),await knowledgeHome(ctx))};
  // Dynamic import: spaces imports treePage from pages/knowledge-pages; a static edge here would re-form the cycle.
  const { spaceOverview } = await import('./spaces.ts');
  const spaces = await spaceOverview(ctx);
  const sources = await packSources(ctx, 'product');
  const lines = await readableLines(ctx);
  const pending = await intakePending(ctx);
  const blocks: Html[] = [];
  for (const line of lines) {
    const builds = await ctx.deps.knowledge.builds(line.id);
    const byLine = new Map<string, { total: number; released: number; produced: number; families: Set<string> }>();
    for (const build of builds) {
      const entry = byLine.get(build.line) ?? { total: 0, released: 0, produced: 0, families: new Set<string>() };
      entry.total += 1;
      if (build.released_at !== null) entry.released += 1;
      if (build.root !== null) entry.produced += 1;
      entry.families.add(build.family);
      byLine.set(build.line, entry);
    }
    const rows = [];
    for (const [version, entry] of byLine) {
      const current = await ctx.deps.knowledge.currentRoot(line.id, version);
      rows.push([
        link('/console/knowledge/product', version, { id: line.id, line: version }),
        [...entry.families].join('、'),
        entry.total,
        entry.released,
        entry.produced,
        // N7: each version line shows its current root and produced_at.
        current === null ? '尚未产出' : html`${link(knowledgeTreePath(), current.build.name, { root: current.root, path: '/' })}`,
        current === null ? '—' : html`${link(knowledgeRootPath(), technicalCode(current.root.slice(0, 12)), { root: current.root })}`,
        current === null ? '—' : timestamp(current.produced_at),
      ]);
    }
    const unversioned = await ctx.deps.knowledge.unversionedRoot?.(line.id) ?? null;
    rows.push(['不分版本', '不适用', '构建未声明', '不适用', unversioned === null ? '尚未产出' : `1（来源 ${unversioned.source_count} 个）`,
      unversioned === null ? '尚未产出' : link(knowledgeRootPath(), '查看知识版本', {root:unversioned.root}),
      unversioned === null ? '—' : technicalCode(unversioned.root.slice(0, 12)),
      unversioned === null ? '—' : timestamp(unversioned.produced_at)]);
    const versions = builds.filter(build => build.root !== null).map(build => ({root: build.root!, label: `${build.line} / ${build.name}`}));
    if (unversioned !== null) versions.push({root: unversioned.root, label: '不分版本'});
    const options = versions;
    const diff = options.length === 0 ? html`` : filterForm(
      knowledgeDiffPath(),
      html`<h3 title="两个版本之间新增、删除与修改的条目">产品版本差异</h3><label>从 ${selectControl('from', options.map((version, i) => ({ value: version.root, label: version.label, selected: i === Math.min(1, options.length - 1) })))}</label><label>到 ${selectControl('to', options.map((version, i) => ({ value: version.root, label: version.label, selected: i === 0 })))}</label>`,
      '比较',
      `${line.title}版本差异`,
    );
    blocks.push(
      knowledgePanel(
        { title: line.title, meta: html`名称：${line.names.length > 0 ? line.names.join('、') : '未声明'}`, hint: '当前版本为该版本线最新产出的知识；内容变化后内容哈希随之改变。' },
        html`${table(['产品版本', '名称族', '构建', '已发布', '已产出版本', '当前知识版本', '根', '产出时间'], rows, '还没有构建')}<div class="ch-actions">${link(knowledgeProductPath(), '全部构建', { id: line.id })}</div>${diff}`,
      ),
    );
  }
  const flow = html``;
  const actions = ctx.admin ? html`${button(operationsPackPath(),`发布${uiLabelOf('pack_kind','product')}`,{params:{kind:'product'},icon:'upload'})}${button(operationsKnowledgePath(), '导入公共知识', { primary: true, icon: 'upload', hint: '从所选产品已配置的知识来源导入到公共知识库；产品文件夹沿用产品线的读取权限，仅管理员可用' })}` : undefined;
  return {
    status: 200,
    body: knowledgeShell(ctx.chrome('知识库', { active: 'knowledge', hint: ctx.deps.knowledge.spaces?'我的、团队与与本账户共享的知识；已验证与待验证内容分别标示':'统一的知识库：每条知识均附来源，按产品线与版本组织', ...(actions === undefined ? {} : { actions }) }), html`${ctx.deps.knowledge.spaces?spaces:flow}${sources}${pending}
${liveModule('lines', ['knowledge.published'], lines.length === 0 ? knowledgePanel({ title: ctx.deps.knowledge.spaces?'产品文件夹':'公共知识' }, html`<p class="empty">${ctx.deps.knowledge.spaces?'没有可读的产品文件夹':ctx.admin ? '还没有公共知识；公共知识按产品线组织，发布产品知识来源后可在此浏览和导入' : '没有可读的公共知识；成员可读分配给自己的工作流所绑定的产品线'}</p>`) : html`${sectionHead('按产品线浏览', undefined, undefined, undefined, '可读的产品线及其版本')}<div class="ch-section">${blocks}</div>`)}`,html`<section class="ch-section"><h2 class="ch-panel-title">公共知识</h2></section>${stat('可读产品线',lines.length)}${lines.length?knowledgePanel({title:'产品线'},html`<ul class="ch-feed">${lines.map(line=>html`<li>${link(knowledgeProductPath(),line.title,{id:line.id})}</li>`)}</ul>`):''}`),  };
}

function pagedArray<T>(ctx:PageContext,values:readonly T[],size:number,key:string,scope:string):{items:readonly T[];next:string|null;start:number}|null {
  const hash=digestOf({scope,values});
  const cursor=param(ctx,key);
  let start=0;
  if(cursor!==undefined){
    if(cursor.length>128)return null;
    const decoded=Buffer.from(cursor,'base64url').toString('utf8');
    const match=/^([0-9a-f]{64}):([0-9]+)$/.exec(decoded);
    if(!match||match[1]!==hash||Buffer.from(decoded).toString('base64url')!==cursor)return null;
    start=Number(match[2]);
    if(!Number.isSafeInteger(start)||start<0||start>values.length||start%size!==0)return null;
  }
  return {items:values.slice(start,start+size),start,next:start+size<values.length?Buffer.from(`${hash}:${start+size}`).toString('base64url'):null};
}
function invalidArrayCursor(ctx:PageContext):PageResult{return{status:400,body:knowledgeShell(ctx.chrome('分页参数无效'),html`<p>列表已变化或游标无效，请从第一页重新打开。</p>`) };}

export async function productPage(ctx: PageContext): Promise<PageResult> {
  const id = param(ctx, 'id');
  const versionLine = param(ctx, 'line');
  const line = id === undefined ? null : await productReadable(ctx, id);
  if (line === null) return neutralPage(ctx);
  const builds = await ctx.deps.knowledge.builds(line.id, versionLine === undefined ? undefined : { line: versionLine });
  const listing=pagedArray(ctx,builds,500,'cursor',`builds:${line.id}:${versionLine??''}`);
  if(listing===null)return invalidArrayCursor(ctx);
  const shown = listing.items;
  const rows = shown.map((b) => [
    b.name,
    b.family,
    b.line,
    b.base === b.name ? '不是别名' : `别名，基于 ${b.base}`,
    b.platform ?? '主平台',
    b.built_at ?? '未记录',
    b.released_at ?? '未发布',
    b.root === null ? '尚未产出' : link(knowledgeRootPath(), '查看知识版本', { root: b.root }),
  ]);
  const more = html`<p>分页：本页 ${shown.length?listing.start+1:0} 至 ${listing.start+shown.length}，共 ${builds.length} 个${listing.next?html`；${link(knowledgeProductPath(),'下一页',{id:line.id,line:versionLine,cursor:listing.next})}`:''}</p>`;
  return {
    status: 200,
    body: knowledgeShell(
      ctx.chrome(`${line.title}${versionLine ? ` ${versionLine}` : ''}`, { active: 'knowledge', sub: html`${link(knowledgePath(), '知识库')} · 构建` }),
      html`<p>名称：${line.names.join('、') || '未声明'}</p>${table(['构建', '名称族', '版本线', '别名', '平台', '构建时间', '发布时间', '根'], rows, '没有构建')}${more}`,
    ),
  };
}

export async function rootPage(ctx: PageContext): Promise<PageResult> {
  const root = param(ctx, 'root') ?? '';
  if (!(await rootReadable(ctx, root))) return neutralPage(ctx);
  const infos = await ctx.deps.knowledge.rootInfo(root);
  return {
    status: 200,
    body: knowledgeShell(
      ctx.chrome('知识版本', { active: 'knowledge', crumbs: [link(knowledgePath(),'知识库')] }),
      html`<p>${link(knowledgeTreePath(), '浏览条目', { root, path: '/' })}</p>${technicalCode(root)}
${table(
  ['组成记录', '产品线', '构建', '名称族', '版本线', '产出时间'],
  infos.map((info) => [technicalCode(info.composition), info.product, info.build?.name ?? '构建未声明', info.build?.family ?? '未声明', info.build?.line ?? '不分版本', info.produced_at]),
)}`,
    ),
  };
}

export async function treePage(ctx: PageContext): Promise<PageResult> {
  const root = param(ctx, 'root') ?? '';
  const path = param(ctx, 'path') ?? '/';
  const cursor = param(ctx, 'cursor');
  if (!SHA256.test(root)) return neutralPage(ctx);
  const nodes = await loadKnowledgeNodes(ctx, root, path, cursor ?? null);
  if (nodes === null) return neutralPage(ctx);
  // The node asked for gets its citations and its entries' provenance; the nodes below it are listed as before.
  const main = nodes.nodes.find((node) => node.path === path);
  const citations = main === undefined ? null : await nodeCitations(ctx, root, main);
  const parts = nodes.nodes.map((node) => {
    const cited = node === main ? citations : null;
    const byEntry = new Map((cited?.entries ?? []).map((entry) => [entry.entry, entry]));
    const grounds = (entry: string) => {
      const found = byEntry.get(entry);
      if (found === undefined || found.grounds === null) return '未记录';
      if (found.grounds.length === 0) return '未记录来源';
      return html`${found.grounds.map((ground) => html`<div>${technicalCode(ground)}</div>`)}${found.grounds_truncated ? html`<div class="ch-meta">仅列出前 ${found.grounds.length} 条</div>` : ''}`;
    };
    return knowledgeSection(
      `${node.path}（${isNodeLevel(node.level) ? uiLabelOf('node_level', node.level) : node.level}）`,
      html`${knowledgeFacts([
        ['名称', node.name],
        ['引用', technicalCode(node.reference)],
        ['内容哈希', technicalCode(node.digest)],
        ...(cited === null ? [] : [['被引用', citationsLine(cited)] as [string, string]]),
      ])}
${table(['下级', '路径'], node.children.map((child) => [link(knowledgeTreePath(), child.name, { root, path: child.path }), technicalCode(child.path)]), '没有下级')}
${cited === null
  ? table(
    ['类型', '陈述', '适用', '引用', '数据'],
    node.entries.map((entry) => [isEntryKind(entry.kind)?uiLabelOf('entry_kind',entry.kind):entry.kind, entry.statement, entry.applicability, technicalCode(entry.reference), entry.data === undefined ? '' : pre(JSON.stringify(entry.data, null, 2))]),
    '没有条目',
  )
  : table(
    ['类型', '陈述', '适用', '引用', '来源', `近 ${cited.days} 天被引用`, '数据'],
    node.entries.map((entry) => {
      const counted = byEntry.get(entry.entry);
      return [isEntryKind(entry.kind)?uiLabelOf('entry_kind',entry.kind):entry.kind, entry.statement, entry.applicability, technicalCode(entry.reference), grounds(entry.entry), counted === undefined ? '暂无数据' : countText(cited, counted.count, counted.capped), entry.data === undefined ? '' : pre(JSON.stringify(entry.data, null, 2))];
    }),
    '没有条目',
  )}${cited?.entries_truncated ? html`<p class="ch-meta">条目较多，仅前 ${cited.entries.length} 条给出来源与被引用次数。</p>` : ''}`,
    );
  });
  const parent = path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
  const next = nodes.next === null ? html`` : nextPage(knowledgeTreePath(), { root, path, cursor: nodes.next });
  return {
    status: 200,
    body: knowledgeShell(
      ctx.chrome('知识条目', { active: 'knowledge', sub: html`${link(knowledgePath(), '知识库')} · ${path}` }),
      html`<div class="ch-actions">知识版本 ${technicalCode(root)}${parent === null ? '' : html` · ${link(knowledgeTreePath(), '上一级', { root, path: parent })}`}</div>
<p>覆盖：${coverageText(nodes.coverage) ?? '未记录'}</p>${parts}${next}`,
    ),
  };
}

export async function diffPage(ctx: PageContext): Promise<PageResult> {
  const from = param(ctx, 'from') ?? '';
  const to = param(ctx, 'to') ?? '';
  if (!(await rootReadable(ctx, from)) || !(await rootReadable(ctx, to))) return neutralPage(ctx);
  const diff = await ctx.deps.knowledge.diffRoots(from, to);
  if (diff === null) return neutralPage(ctx);
  const lists=[['added',diff.added,to],['removed',diff.removed,from],['modified',diff.modified,to]] as const;
  const pages=lists.map(([key,paths])=>pagedArray(ctx,paths,1000,`${key}_cursor`,`${from}:${to}:${key}`));
  if(pages.some(p=>p===null))return invalidArrayCursor(ctx);
  const listOf = (index:number) => {
    const [key,paths,root]=lists[index], listing=pages[index]!;
    const parameters:Record<string,string>={from,to};
    for(const [name] of lists){const value=param(ctx,`${name}_cursor`);if(value!==undefined)parameters[`${name}_cursor`]=value;}
    if(listing.next)parameters[`${key}_cursor`]=listing.next;
    return html`${table(['路径'],listing.items.map(p=>[link(knowledgeTreePath(),p,{root,path:p})]),'没有')}<p>分页：本页 ${listing.items.length} 条，共 ${paths.length} 条${listing.next?html`；${link(knowledgeDiffPath(),'下一页',parameters)}`:''}</p>`;
  };
  return {
    status: 200,
    body: knowledgeShell(
      ctx.chrome('版本差异', { active: 'knowledge', sub: html`${link(knowledgePath(), '知识库')}` }),
      html`<div class="ch-actions">从 ${technicalCode(from)} 到 ${technicalCode(to)}</div>
${knowledgeSection(`只在新根里（${diff.added.length}）`, listOf(0))}
${knowledgeSection(`只在旧根里（${diff.removed.length}）`, listOf(1))}
${knowledgeSection(`内容变了（${diff.modified.length}）`, listOf(2))}`,
    ),
  };
}
