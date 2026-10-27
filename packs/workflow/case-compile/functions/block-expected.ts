// Author expectation coverage and quoted, typed judgments. No descriptive-language classification.
import TABLE from '../tables/blocks-format.json' with {type:'json'};
import {isRecord,type Outcome} from './text.ts';
import {canonicalJson} from './canonical-json.ts';
import {blockMeta} from './blocks.ts';
import {hasSingleLineValue} from './binding.ts';
import type {PlanSlots} from './slots.ts';
function recordInput(value:unknown,kind:string):Record<string,any>|null{
 if(!isRecord(value)||!isRecord(value.meta)||value.meta.kind!==kind||typeof value.meta.record!=='string'||!isRecord(value.model)||value.model.kind!==kind||!isRecord(value.model.body)||value.external!==null||value.meta.pointer!==undefined)return null;
 return {reference:'rec:'+value.meta.record,body:value.model.body};
}
export function criterionReviewed(declaration:Record<string,any>,evidence:unknown):{ok:true;data:Record<string,unknown>}|{ok:false;missing:string}{
 const raw=isRecord(evidence)?evidence:{},result=recordInput(raw.result,'validation_result'),snapshot=recordInput(raw.run,'run');
 const missing='缺类型化判据的独立复核运行快照与已受理结果；下一步：按本包 review 阶段，以原声明运行作只读前驱，由非作者账号核对，再绑定 criteria_review 与 criteria_review_run 的 Hub 记录；上传自述 JSON 不算复核';
 if(!result||!snapshot)return {ok:false,missing};
 const run=snapshot.body,body=result.body;
 if(run.pack!==TABLE.review_pack.id+'@'+TABLE.review_pack.version||body.schema!=='validation@1'||body.acceptance!=='accepted'||body.run!==run.run||body.locks?.pack!==run.pack||body.locks?.pack_digest!==run.pack_digest||!Array.isArray(run.items)||!isRecord(body.partitions))return {ok:false,missing};
 const item=run.items.find((row:any)=>isRecord(row)&&isRecord(row.fields)&&canonicalJson(row.fields.criterion)===canonicalJson(declaration));
 if(!item||typeof item.fields.author_run!=='string'||run.predecessor!==item.fields.author_run)return {ok:false,missing:'复核运行的实际前驱不等于原声明运行；下一步：以正确 author_run 重开独立复核，不能换无关前驱取得独立标记'};
 const rows=Object.values(body.partitions).flatMap(value=>Array.isArray(value)?value:[]),row=rows.find((value:any)=>isRecord(value)&&value.item===item.id),requirement=isRecord(row)&&Array.isArray(row.requirements)?row.requirements.find((value:any)=>value.requirement==='review'):null;
 const claim=requirement?.status==='satisfied'&&Array.isArray(requirement.claims)?requirement.claims.find((value:any)=>value.statement?.code==='accept'&&value.warrant?.producer==='model'&&value.warrant?.independence==='human_non_author'&&value.qualifier?.nature==='judgment'&&value.validity?.status==='valid'):null;
 if(!claim)return {ok:false,missing:'类型化判据尚无通过账号独立性核验的接受判断；下一步：非作者账号复核接受，或修改判据后重交，拒绝不能当作通过'};
 return {ok:true,data:{criterion:declaration.id,review:result.reference,review_run:snapshot.reference,reviewer:run.runner,model:claim.warrant.id,conditional_on_judgment:true}};
}
export function checkBlockExpected(slots:PlanSlots,nodes:unknown,evidence:unknown,root:unknown,item:string):Outcome[]{
 const meta=blockMeta(slots);if(!meta)return [];
 const unknown=(missing:string,pointer='/data/obligations'):Outcome=>({verdict:'unknown',reason:'missing_input',missing,statement:missing,grounds:[],tier:'blocking',item,pointer});
 const bad=(message:string,pointer:string):Outcome=>({verdict:'refute',code:'case-compile.expect_not_in_quote',statement:message,grounds:[],tier:'blocking',item,pointer});
 if(!Array.isArray(nodes)||!nodes.length||nodes.some(node=>!isRecord(node)||typeof node.reference!=='string'||typeof node.text!=='string'))return [unknown('缺作者期望全集及稳定节点引用；下一步：按完整脑图原件重新投影，不用模型选中的子集替代')];
 if(!Array.isArray(slots.obligations))return [unknown('缺逐期望履约账；下一步：模型为全部期望逐条绑定断言，未实现写 unmet、缺事实和下一步')];
 if(typeof root!=='string')return [unknown('缺本轮锁定根，不能核对类型化判据适用范围；下一步：绑定产品构建与命令目录后重开运行')];
 const out:Outcome[]=[],reviews:Record<string,unknown>[]=[],ids=new Set(slots.expects.map(expect=>expect.id));
 for(const node of nodes){
  const obligations=slots.obligations.filter(row=>row.expectation===node.reference);
  if(obligations.length!==1){out.push(bad('作者期望没有唯一履约条目，不能遗漏或重复记账','/data/obligations'));continue;}
  const obligation=obligations[0];
  if(obligation.status==='unmet'){out.push(unknown((obligation.missing??'作者期望未履约')+'；下一步：'+(obligation.next_action??'模型补对应断言或具名补证步骤')));continue;}
  if(!TABLE.obligation_states.includes(obligation.status)||!obligation.assertions.length||new Set(obligation.assertions).size!==obligation.assertions.length||obligation.assertions.some((id:string)=>!ids.has(id)||!slots.expects.some(expect=>expect.id===id&&expect.expectation===node.reference)))out.push(bad('履约必须引用属于该期望的实际断言，不能借别的期望或不存在的 id','/data/obligations'));
 }
 for(const obligation of slots.obligations)if(!nodes.some(node=>node.reference===obligation.expectation))out.push(bad('履约账含本用例之外的期望身份','/data/obligations'));
 for(const expect of slots.expects){
  const at='/data'+expect.origin,node=nodes.find(node=>node.reference===expect.expectation);
  if(!node||!expect.quote||expect.quote.reference!==node.reference||typeof expect.quote.text!=='string'||!expect.quote.text||!node.text.includes(expect.quote.text)){out.push(bad('断言 quote 必须逐字来自本用例该期望节点，不能换标题、步骤或其他用例',at+'/quote'));continue;}
  if(!slots.obligations.some(row=>row.status==='asserted'&&row.expectation===expect.expectation&&row.assertions.includes(expect.id)))out.push(bad('存在未记入作者履约账的断言',at));
  if(!expect.register&&!hasSingleLineValue(expect.text))out.push(bad('字面断言必须合单行取值规则；捕获原文只能经寄存器使用，不能转成正则',at+'/literal'));
  const author=isRecord(node.declaration)?node.declaration:null;
  const authorLiteral=author&&author.op===expect.operator&&author.literal===expect.text&&(expect.count===undefined?author.count===undefined:author.count===expect.count)&&!expect.register;
  if(node.declaration!==undefined){
   if(!author||!TABLE.assertion_ops.some(row=>row.op===author.op)||typeof author.literal!=='string'||!author.literal||author.op==='found_times'&&(!Number.isSafeInteger(author.count)||author.count<1)){out.push(unknown('作者字面声明格式未核对；下一步：维护者修正原声明或明确 unmet，不由模型猜补',at));continue;}
   if(!authorLiteral)out.push(bad('计划不能更换作者已明确声明的算子、字面或次数；保留原声明或显式未履约',at));
   continue;
  }

  const declared=slots.criteria?.filter(value=>value.id===expect.criterion)??[];
  if(declared.length!==1){out.push(unknown('期望未声明原文字面算子，缺唯一的类型化判据；下一步：模型按 literal / count / capture_relation 声明判据和理由并提交独立复核，不能把描述文字直接复制成断言',at+'/criterion'));continue;}
  const criterion=declared[0],kind=expect.register?'capture_relation':expect.count!==undefined?'count':'literal';
  if(!TABLE.criterion_kinds.includes(criterion.kind)||criterion.kind!==kind||criterion.expectation!==expect.expectation||canonicalJson(criterion.quote)!==canonicalJson(expect.quote)||criterion.scope_root!==root||criterion.operator!==expect.operator||!expect.register&&criterion.literal!==expect.text||expect.count!==undefined&&criterion.count!==expect.count||expect.comparison&&criterion.relation!==expect.comparison){out.push(bad('类型化判据的来源、锁根、类型或取值不等于本断言声明，不能凭引文相同代替类型核对',at+'/criterion'));continue;}
  const reviewed=criterionReviewed(criterion,evidence);if(!reviewed.ok)out.push(unknown(reviewed.missing,at+'/criterion'));else reviews.push(reviewed.data);
 }
 if(!slots.expects.length)out.push(unknown('缺可执行断言；下一步：模型为作者期望写明确观察和断言，只有观察或捕获不构成通过'));
 return out.length?out:[{verdict:'support',statement:'作者期望全集已逐条履约；字面声明、类型化判据复核与显式输出关系已核对；以判断为前提，不证明设备结果',grounds:nodes.map(node=>node.reference),tier:'blocking',item,data:{typed_criteria:reviews,obligations:slots.obligations},judgment_sources:['/plan/0']}];
}
