// Recount the exported index, not the pack's compact buckets. Expected-result equality cannot be reconstructed from these entries.
import { readFileSync } from 'node:fs';
import { VERDICT, REASON,labelOf } from '../../../contracts/generated/vocabulary.ts';
import { locatedDrafts, object, parsedDraftCommands, decodeCommandXml } from './command-domains.ts';
import { normalizeHead } from './regression-doc.ts';
const [SUPPORT,REFUTE,UNKNOWN] = VERDICT;
const INTEGRITY = REASON.find(v => v === 'integrity_unproven')!;
const normTitle = (s: string) => s.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const head = (s: string) => normalizeHead(s.startsWith('/commands/') ? s.slice(10).split('/').join(' ') : s);
const setKey = (s: string[]) => JSON.stringify([...new Set(s.map(head).filter(Boolean))].sort());
const pair = (document: unknown, node: unknown) => JSON.stringify([String(document), String(node)]);
const canonical = (v: any): string => Array.isArray(v) ? '['+v.map(canonical).join(',')+']' : object(v) ? '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}' : JSON.stringify(v);
export function recountDuplicates(views: unknown[], submission: unknown, xml: string, result: unknown) {
  if (views.length === 0) throw new Error('missing index');
  const entries = new Map<string, any>();
  let identity: string | undefined;
  for (const [viewPosition,v] of views.entries()) {
    if (!object(v) || v.schema !== 'index-view@1' || v.kind !== 'case' || v.key !== 'commands' || !object(v.build) || typeof v.product !== 'string' || v.product.trim() === '' || typeof v.build.build !== 'string' || v.build.build.trim() === '' || !/^[a-f0-9]{64}$/.test(v.build.root ?? '') || !object(v.keys) || !object(v.entries)
      || typeof v.truncated !== 'boolean' || !Number.isInteger(v.skipped) || v.skipped < 0 || !Number.isInteger(v.total_keys) || !Number.isInteger(v.total_entries) || v.total_keys < 0 || v.total_entries < Object.keys(v.entries).length
      || (v.only !== undefined && (!Array.isArray(v.only) || v.only.some((x: unknown)=>typeof x !== 'string'))) || (v.cut_keys !== undefined && (!Array.isArray(v.cut_keys) || v.cut_keys.some((x: unknown)=>typeof x !== 'string')))) throw new Error('invalid index');
    const own = JSON.stringify([v.product,v.build.build,v.build.root]);
    if (identity !== undefined && identity !== own) throw new Error(`mixed index identity at view ${viewPosition+1}`); identity = own;
    for (const refs of Object.values(v.keys)) if (!Array.isArray(refs) || refs.some(d=>!Object.hasOwn(v.entries,d))) throw new Error('incomplete index bytes');
    for (const [digest,e] of Object.entries(v.entries)) {
      if (!/^[a-f0-9]{64}$/.test(digest) || !object(e) || e.kind !== 'case' || e.entry !== digest || !object(e.data) || !Array.isArray(e.data.commands) || e.data.commands.some((c:unknown)=>typeof c !== 'string') || typeof e.data.document !== 'string' || typeof e.data.node !== 'string' || typeof e.data.title !== 'string' || typeof e.data.negative !== 'boolean') throw new Error('invalid case entry');
      if (entries.has(digest) && canonical(entries.get(digest)) !== canonical(e)) throw new Error('conflicting entry'); entries.set(digest,e);
    }
  }
  const cases = new Map<string,{commands:string[];title:string;negative:boolean}>();
  for (const e of entries.values()) {
    const key=pair(e.data.document,e.data.node), before=cases.get(key);
    if (before && (before.title !== e.data.title || before.negative !== e.data.negative)) throw new Error('conflicting case identity');
    cases.set(key,{ commands:[...new Set([...(before?.commands ?? []),...e.data.commands.map(head)])],title:e.data.title,negative:e.data.negative });
  }
  const drafts=locatedDrafts(submission), buckets=object(result)&&object(result.partitions)?Object.values(result.partitions).flatMap(v=>Array.isArray(v)?v:[]):[];
  const details=drafts.map(d=>{
    const parsed=parsedDraftCommands(d,xml), heads=[...new Set(parsed.commands.map(c=>normalizeHead(c.head)))];
    const covered=heads.length>0&&parsed.unrecognized.length===0&&views.some((v:any)=>v.truncated===false&&heads.some(h=>(v.only===undefined||v.only.some((k:string)=>head(k)===h))&&!(v.cut_keys??[]).some((k:string)=>head(k)===h)));
    const candidates=[...cases].filter(([,v])=>setKey(v.commands)===setKey(heads));
    const sameNegative=candidates.filter(([,v])=>v.negative===(d.data.negative===true));
    const sameTitle=sameNegative.filter(([,v])=>normTitle(v.title)===normTitle(d.data.title??''));
    const own=buckets.filter(b=>b.item===d.item), requirements=own.flatMap(b=>b.requirements??[]).filter(r=>r.requirement==='not_duplicate');
    const claims=requirements.flatMap(r=>r.claims??[]).filter(c=>c.statement?.code==='defect-to-case.duplicate_case'&&c.statement?.verdict===REFUTE);
    const matching=claims.filter(c=>typeof c.statement?.text==='string'&&c.statement.text.startsWith(`起草用例“${d.data.title??''}”与已索引用例重复`));
    const hub=new Set<string>();let known=requirements.length===1&&drafts.filter(x=>x.item===d.item&&x.data.title===d.data.title).length===1;
    for(const c of matching){const target=c.statement?.data?.duplicate_of??c.data?.duplicate_of; if(!object(target)||typeof target.document!=='string'||typeof target.node!=='string') known=false; else hub.add(pair(target.document,target.node));}
    if(claims.some(c=>!drafts.some(x=>x.item===d.item&&typeof c.statement?.text==='string'&&c.statement.text.startsWith(`起草用例“${x.data.title??''}”与已索引用例重复`)))) known=false;
    const hubOutputMissing=!known||requirements.some(r=>!['satisfied','unsatisfied'].includes(r.status)||(r.claims??[]).some((c:any)=>(c.statement?.verdict===UNKNOWN||c.statement?.reason==='missing_input'||c.reason==='missing_input')&&(!c.statement?.text||c.statement.text.startsWith(`起草用例“${d.data.title??''}”`))));
    const expected=new Set(sameTitle.map(([key])=>key));
    const expectedPending = covered && sameNegative.length > sameTitle.length;
    const titleEqual=covered?!hubOutputMissing&&expected.size===hub.size&&[...expected].every(k=>hub.has(k)):null;
    const unread = views.some((v:any)=>v.skipped>0);
    const equal=unread?null:titleEqual;
    const gap = !covered ? { fact: 'complete_command_index', action: 'request_complete_index_export', owner: 'Claude' }
      : unread ? { fact: 'unread_indexed_documents', action: 'retry_source_sync_and_export_complete_index', owner: 'Claude' } : undefined;
    return { draft:d.draft, sameCommands:covered?candidates.length:null, sameNegative:covered?sameNegative.length:null, sameTitle:covered?sameTitle.length:null,
      verdict:gap?UNKNOWN:(sameTitle.length>0?REFUTE:SUPPORT), reason:gap?INTEGRITY:undefined, equal, titleEqual, hubOutputMissing, expectedAffected:expectedPending, gap };
  });
  return { commandOwnership:'hub_index_input', drafts:details.length, details, skipped:Math.max(...views.map((v:any)=>v.skipped)), expectedBranch:'not_reconstructible',expectedBranchAffected:details.filter(d=>d.expectedAffected).length,
    equal:details.filter(d=>d.equal===true).length,different:details.filter(d=>d.equal===false).length,unknown:details.filter(d=>d.equal===null).length,
    passed:details.length>0&&details.every(d=>d.equal===true) };
}
export function renderRecount(report: ReturnType<typeof recountDuplicates>): string {
  return [...report.details.map(d=>`草稿 ${d.draft}：同命令集合 ${d.sameCommands??'待补证'}；同反向标记 ${d.sameNegative??'待补证'}；同标题 ${d.sameTitle??'待补证'}；比对 ${d.equal===null?labelOf('reason',d.reason??INTEGRITY):d.equal?'通过':'不通过'}`),
    ...report.details.filter(d=>d.gap).map(d=>`草稿 ${d.draft}：${labelOf('reason',d.reason??INTEGRITY)}；缺事实 ${d.gap!.fact}；下一步 ${d.gap!.action}；责任人 ${d.gap!.owner}`),
    '输入边界：用例的命令归属取自 Hub 导出的 index-view@1；这里独立重算查重，原件到命令归属的核验由回归范围用例验收另行负责',
    `跳过文档 ${report.skipped}；不重复结论只覆盖读到的文档`, `期望结果相同分支：没法重算；影响草稿 ${report.expectedBranchAffected}；索引没有期望文字，包只比标题；包待修项 requirements.json:70`, `查重：${report.passed?'通过':'不通过'}`].join('\n');
}
export function main(argv=process.argv.slice(2)):number{
  const get=(name:string)=>{const i=argv.indexOf('--'+name);return i<0?undefined:argv[i+1];};
  const indexes=argv.flatMap((v,i)=>v==='--index'&&argv[i+1]?[argv[i+1]]:[]);
  if(!indexes.length||!get('drafts')||!get('commands')||!get('result')){process.stderr.write('用法：--index <文件> [--index …] --drafts <文件> --commands <文件> --result <文件>\n');return 2;}
  let field='--index';
  try{
    const views=indexes.map((path,position)=>{field=`--index 文件 ${position+1}`;return JSON.parse(readFileSync(path,'utf8'));});
    field='--drafts';const drafts=JSON.parse(readFileSync(get('drafts')!,'utf8'));
    field='--commands';const xml=decodeCommandXml(readFileSync(get('commands')!));
    field='--result';const result=JSON.parse(readFileSync(get('result')!,'utf8'));
    field='--index';const report=recountDuplicates(views,drafts,xml,result);process.stdout.write(renderRecount(report)+'\n');return report.passed?0:1;
  }catch(error){
    const mixed=error instanceof Error?/^mixed index identity at view (\d+)$/.exec(error.message):null;
    process.stderr.write(`查重输入不通过：${mixed?`index view ${mixed[1]}: mixed identity`:`${field} 读取、解析或完整性失败`}\n`);return 2;
  }

}
if(import.meta.main)process.exitCode=main();
