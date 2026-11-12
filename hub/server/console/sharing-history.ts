import {evidence} from './presentation.ts';
// A receipt keeps its source identity; display resolves the owner's readable statement instead of a digest.
import {uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import type {KnowledgeShareReceipt} from '../../../contracts/src/sharing.ts';
import {parseReference} from '../../refs/api.ts';
import {html,link,type Html} from './html.ts';
import {timestamp} from './knowledge-display.ts';
import {directoryName} from './audience.ts';
import type {PageContext} from './pages.ts';

export async function sharingRows(ctx:PageContext,items:readonly KnowledgeShareReceipt[]):Promise<unknown[][]>{
 return Promise.all(items.map(async row=>{
  const view=row.source?await ctx.deps.knowledge.spaces!.entry(ctx.principal,row.source.root,row.source.path,row.source.entry):null;
  const statement=view?.body.content.statement??'条目当前不可读',ref=row.reference?parseReference(row.reference):null;
  const title=ref?.scheme==='tree'?link('/console/knowledge/space',statement,{space:'team',root:ref.root,path:ref.path,entry:ref.entry}):statement;
  const location=ref?.scheme==='tree'?link('/console/knowledge/space',directoryName(ref.path),{space:'team',root:ref.root,path:ref.path,entry:ref.entry}):html`${row.code??''}：${row.message}`;
  return [title,timestamp(row.at),uiLabelOf('knowledge_share_status',row.status),location];
 }));
}
