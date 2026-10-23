// Resolve only declared whole-value references. Inputs, not function internals, determine dependency provenance.
import type {ProductDeclaration} from '../../contracts/src/product.ts';
import {referencesIn, resolve, type VariableUse} from '../../contracts/src/variables.ts';
import type {ProductHandle} from '../ports.ts';
import {packSchema} from '../runs/api.ts';
import {canonicalize, type RecordVariables, type Principal, type VariableSnapshot} from '../records/api.ts';
import {DEFAULT_SANDBOX} from './context.ts';

export interface ProductVariables {
 product:ProductHandle;
 uses:VariableUse[];
 versions:Array<{name:string;version:number|null;default:boolean}>;
 snapshot:VariableSnapshot;
}

/** Diagnostic locations only: never include a value or schema enum in an error. */
export function productVariableProblems(product:ProductDeclaration, values:ReadonlyMap<string,unknown>, limits=DEFAULT_SANDBOX, onlyName?:string):string[]{
 const out:string[]=[];
 for(const variable of product.variables??[]){
  if(onlyName!==undefined&&variable.name!==onlyName)continue;
  if(!values.has(variable.name)) {out.push(`变量 ${variable.name} 没设置；下一步 circle-hub var set ${variable.name} --file <JSON文件> --reason <理由>`);continue;}
  const compiled=packSchema(variable.schema);
  if(!compiled.ok || !compiled.schema.safeParse(values.get(variable.name)).success)out.push(`变量 ${variable.name} 不合包 ${product.id} /variables/${(product.variables??[]).indexOf(variable)}/schema；下一步 circle-hub var set ${variable.name} --file <JSON文件> --reason <理由>（若给了 --text，请去掉 --text）`);
 }
 if(out.length)return out;
 const resolved=resolve(product,(kind,name)=>{
  if(kind!=='var')throw new Error('产品包不能引用密钥');
  return values.get(name);
 }) as ProductDeclaration;
 const checks:Array<{at:string;value:unknown;limit:number}>=[{at:'/sync/options',value:resolved.sync?.options??{},limit:limits.plan.inputBytes!},...resolved.producers.map((p,i)=>({at:`/producers/${i}/params`,value:p.params??{},limit:limits.producer.inputBytes!}))];
 for(const check of checks)if(Buffer.byteLength(JSON.stringify(check.value),'utf8')>check.limit){
  const names=[...new Set(referencesIn(product).filter(r=>r.at.startsWith(check.at+'/')).map(r=>r.name))];
  out.push(`包 ${product.id} ${check.at} 解析后超过函数输入上限；变量 ${names.join('、')}，下一步 circle-hub var set ${names[0]} --file <较小的JSON文件> --reason <理由>`);
 }
 return out;
}

export async function resolveProductVariables(product:ProductHandle, variables:Pick<RecordVariables,'snapshot'|'valueAt'|'history'>|undefined, by:Principal, dryRun:boolean, limits=DEFAULT_SANDBOX):Promise<ProductVariables|{problems:string[]}>{
 const snapshot=variables ? await variables.snapshot() : new Map<string,string>();
 const values=new Map<string,unknown>();
 const versions:ProductVariables['versions']=[];
 for(const declaration of product.product.variables??[]){
  const decision=snapshot.get(declaration.name);
  if(!decision){if(dryRun){values.set(declaration.name,declaration.default);versions.push({name:declaration.name,version:null,default:true});}continue;}
  values.set(declaration.name,await variables!.valueAt(declaration.name,decision));
  const version=(await variables!.history(by,'var',declaration.name)).find(v=>v.decision.digest===decision)?.version;
  if(version===undefined)throw new Error('变量决定版本缺失；请管理员恢复完整记录后重跑同步');
  versions.push({name:declaration.name,version,default:false});
 }
 const problems=productVariableProblems(product.product,values,limits);
 if(problems.length)return {problems};
 const uses=referencesIn(product.product).flatMap(ref=>{
  const decision=snapshot.get(ref.name);
  return decision?[{at:`${product.id}@${product.version}#${ref.at}`,name:ref.name,decision}]:[];
 });
 return {product:{...product,product:resolve(product.product,(_kind,name)=>values.get(name)) as ProductDeclaration},uses,versions,snapshot};
}

export const sameVariableUses=(a:readonly VariableUse[],b:readonly VariableUse[]):boolean=>canonicalize(a)===canonicalize(b);
