// Submitted model claims stay judgments. This boundary checks schema, declared ids, original bytes and case ownership.
import { fromJSONSchema } from 'zod';
import SCHEMA from '../tables/category-judgment.schema.json' with { type: 'json' };
import type { CategoryJudgment } from '../../../../contracts/generated/shared-interfaces.ts';
import type { ClassificationStatus } from '../../../../contracts/generated/vocabulary.ts';
import type { CaseRecord } from './types.ts';
import type { DocumentCases } from './cases.ts';
import { casesOf } from './cases.ts';
import { authoredCategories, type Template } from './template.ts';
import { isRecord, warningSink } from './common.ts';
import { originalQuoteVerifier, type QuoteNode } from './source-quotes.ts';
const ClaimSchema = fromJSONSchema(SCHEMA as Parameters<typeof fromJSONSchema>[0]);
export type ClassifiedCase = { id: string; visit: number; categories: string[]; status: ClassificationStatus; judgments: CategoryJudgment[] };
export type Classification = { cases: ClassifiedCase[]; unclassified: string[]; errors: string[]; missing: string[] };
export function authorClassification(template: Template, records: Pick<CaseRecord, 'id' | 'visit' | 'category_ids'>[]): Classification {
  const cases = records.map(c => { const categories = authoredCategories(template,c.category_ids); return { id:c.id,visit:c.visit,categories:categories ?? [],status:(categories ? 'classified' : 'unclassified') as ClassificationStatus,judgments:[] }; });
  return { cases, unclassified:cases.filter(c=>c.status==='unclassified').map(c=>c.id),errors:[],missing:[] };
}
export function classify(template: Template, source: unknown, document: string, caseRule: 'marked' | 'tagged', claims: unknown, texts: Readonly<Record<string,string>>): Classification {
  if (!isRecord(source) || typeof source.sha256 !== 'string' || !isRecord(source.model) || !Array.isArray(source.model.nodes)) return {cases:[],unclassified:[],errors:[],missing:['冻结的原件解析树']};
  const model=source.model;const nodes=model.nodes as unknown[];
  const parsed:DocumentCases=casesOf(document,nodes,warningSink(),{caseRule});
  const out=authorClassification(template,parsed.cases), byId=new Map(out.cases.map(c=>[c.id,c]));
  if(claims===undefined || claims===null) return out;
  if(!Array.isArray(claims)){out.errors.push('类别主张不是数组');return out;}
  const owned=new Map<number,string>();
  const roots=new Map(parsed.cases.map(c=>[c.visit,c.id]));
  for(let at=0;at<parsed.nodes.texts.length;at++){const parent=parsed.nodes.parents[at];const id=roots.get(at)??owned.get(parent);if(id)owned.set(at,id);}
  const raw=texts[`src:${source.sha256}`];
  let verify:ReturnType<typeof originalQuoteVerifier>|undefined;
  const known=new Set(template.categories.map(c=>c.id));
  for(const [at,wrapper] of claims.entries()){
    const result=ClaimSchema.safeParse(isRecord(wrapper)?wrapper.data:undefined);
    if(!result.success){out.errors.push(`第 ${at+1} 条类别主张不符合 category-judgment@1：${result.error.message}`);continue;}
    const claim=result.data as CategoryJudgment, item=byId.get(claim.item);
    if(!item || !known.has(claim.category_id)){out.errors.push(`第 ${at+1} 条的 item 或 category_id 不在当前用例及闭集内`);continue;}
    if(!raw){out.missing.push(`原件 src:${source.sha256} 的原始 UTF-8 文本`);continue;}
    if(model.nulRemoved!==0 || (typeof model.surrogatesReplaced==='number' && model.surrogatesReplaced>0)){out.missing.push('未经 NUL/代理字符替换的原件解析视图；先修复原件后重读');continue;}
    try{verify??=originalQuoteVerifier(raw,source.sha256,nodes as QuoteNode[]);}catch(error){out.missing.push(error instanceof Error?error.message:'原件身份核验失败');continue;}
    const selected=nodes.findIndex(n=>isRecord(n) && typeof n.selector==='string' && (claim.quote.identity.path===n.selector || claim.quote.identity.path===`${n.selector}/@text`));
    const quoted=verify(claim.quote);
    if(selected<0 || quoted<0 || owned.get(selected)!==claim.item || owned.get(quoted)!==claim.item){out.errors.push(`第 ${at+1} 条引文的身份、跨度、逐字文本或用例归属不成立`);continue;}
    if(!item.categories.includes(claim.category_id))item.categories.push(claim.category_id);
    item.status='classified';item.judgments.push(claim);
  }
  out.unclassified=out.cases.filter(c=>c.status==='unclassified').map(c=>c.id);out.missing=[...new Set(out.missing)];
  return out;
}
