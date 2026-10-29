// Assemble explicitly selected category judgments; no classification or quote verification happens here.
import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import TABLE from '../tables/template-v3.json' with {type:'json'};

const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const text=(value:unknown):value is string=>typeof value==='string'&&value.length>0;
class PreparationError extends Error {}

/** The identity is the explicit identity object, a start response's run, or a stored run record's body. */
export function declaredIdentity(value:unknown):Record<string,string> {
  if(!record(value))throw new PreparationError('缺模型身份；由当前会话声明 model_id 和 model_family_id 后重试');
  const container=record(value.run)?value.run:record(value.body)?value.body:value;
  const candidate=record(container.model_identity)?container.model_identity:container;
  if(!text(candidate.model_id)||!text(candidate.model_family_id)||Object.keys(candidate).some(key=>!['model_id','model_family_id','configuration_reference'].includes(key))||candidate.configuration_reference!==undefined&&typeof candidate.configuration_reference!=='string')throw new PreparationError('模型身份不完整或字段不合形状；由当前会话按 model-identity@1 声明后重试');
  return {model_id:candidate.model_id,model_family_id:candidate.model_family_id,...(typeof candidate.configuration_reference==='string'?{configuration_reference:candidate.configuration_reference}:{})};
}

/** Preserve the caller's explicit choices and the locator's original quote; Hub verifies both on submission. */
export function prepareClaims(located:unknown,choices:unknown,identity:unknown):Array<{text:string;data:Record<string,unknown>}> {
  const producer=declaredIdentity(identity),categories=new Set(TABLE.categories.map(row=>row.id));
  if(!Array.isArray(located)||!Array.isArray(choices))throw new PreparationError('缺定位结果或选择数组；按 README 生成两份文件后重试');
  const byOrdinal=new Map<number,{item:string;quotes:unknown[]}>();
  for(const row of located){
    if(!record(row)||!Number.isSafeInteger(row.ordinal)||Number(row.ordinal)<1||!text(row.item)||!Array.isArray(row.quotes)||byOrdinal.has(Number(row.ordinal)))throw new PreparationError('定位结果编号或用例字段无效；重新生成定位结果后重试');
    byOrdinal.set(Number(row.ordinal),{item:row.item,quotes:row.quotes});
  }
  return choices.map(choice=>{
    if(!record(choice)||!Number.isSafeInteger(choice.ordinal)||!text(choice.category_id)||!categories.has(choice.category_id)||!text(choice.statement))throw new PreparationError('缺编号或判断陈述，或类别 id 未在闭集声明；按模板和模型判断修正后重试');
    const row=byOrdinal.get(Number(choice.ordinal));if(!row||row.quotes.length===0)throw new PreparationError('缺所选候选的引文；核对原件和选择器后重新定位');
    const index=choice.quote_index===undefined&&row.quotes.length===1?0:choice.quote_index;
    if(!Number.isSafeInteger(index)||Number(index)<0||Number(index)>=row.quotes.length)throw new PreparationError('引文有多处或选择序号无效；显式填写有效的 quote_index 后重试');
    const quote=row.quotes[Number(index)];if(!record(quote)||!record(quote.identity)||!text(quote.text))throw new PreparationError('所选引文结构缺失；重新定位原件后重试');
    return {text:choice.statement,data:{item:row.item,category_id:choice.category_id,quote,producer:{...producer}}};
  });
}

async function main(){
  const {values}=parseArgs({options:{located:{type:'string'},choices:{type:'string'},identity:{type:'string'},out:{type:'string'}},strict:true});
  if(!values.located||!values.choices||!values.identity||!values.out)throw new PreparationError('缺定位、选择、身份或输出文件；按 README 补齐后重试');
  const load=async(path:string)=>JSON.parse(await readFile(path,'utf8')) as unknown;
  const claims=prepareClaims(await load(values.located),await load(values.choices),await load(values.identity));
  await writeFile(values.out,JSON.stringify(claims,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(`已准备 ${claims.length} 条类别主张；逐字引文和用例归属由 Hub 核验`);
}
if(import.meta.main)main().catch(error=>{console.error(error instanceof PreparationError?error.message:'文件读取或写入未完成；核对路径及已有输出后重试');process.exitCode=1;});
