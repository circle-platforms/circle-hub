import SLOT_TABLE from '../slots.schema.json' with {type:'json'};
import {schema} from './schema.ts';
import {readBlockSlots,isNormalized} from './blocks.ts';
import {isExpectationBasis,type ExpectationBasis} from './generated/vocabulary.ts';
// Restricted authored plan slots. This module verifies structure and never generates an execution artifact.
import { isRecord } from './text.ts';
export type KeywordValue = string | number;
export interface PlanStep { id?:string;origin?:string;block_kind?:string;output?:boolean;save_as?:string;input_register?:string;restore_for?:number;restore_target?:{tree_root:string;path:string;leading_parameters:unknown[];bed:string;manifest_sha256:string};cleanup?:boolean; object: string; method: string; args: string[]; keywords: Record<string, KeywordValue> }
export interface PlanExpect {id?:string;origin?:string;operator?:string;output?:string;register?:string;actual_register?:string;comparison?:string;count?:number;expectation?:string;criterion?:string;basis?:ExpectationBasis;rationale?:string; text: string; quote: { reference: string; text: string }; after: number }
export interface Replacement { case: string; bed: string }
export interface PlanSlots { recomposition?:{receipt:string;case_id:string;slots:Array<{slot:string;assertions:string[]}>;rebindings:Array<{slot:string;from:string;to:string;authority?:string;source_of_value?:string}>}; command_identities?:unknown; bucket: string; blocks: Array<Record<string,any>>;block_context?:Record<string,any>;criteria?:Array<Record<string,any>>;obligations?:Array<Record<string,any>>; steps: PlanStep[]; expects: PlanExpect[]; replacements: Replacement[] }
export interface SlotProblem { pointer: string; message: string }
export function readSlots(value: unknown): { ok: true; slots: PlanSlots } | { ok: false; problems: SlotProblem[] } {
  if(isNormalized(value))return {ok:true,slots:value};
  if(isRecord(value)&&Array.isArray(value.blocks)&&value.blocks.length)return readBlockSlots(value);
  const problems: SlotProblem[] = [];
  const issue = (pointer: string, message: string) => problems.push({ pointer, message });
  if (!isRecord(value)) return { ok: false, problems: [{ pointer: '', message: '槽位不是对象；按 slots.schema.json 的完整形状填写' }] };
  const keys = (raw: Record<string, unknown>, allowed: string[], at: string): void => {
    for (const key of Object.keys(raw)) if (!allowed.includes(key)) issue(`${at}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`, '多余字段；按 slots.schema.json 删除');
  };
  keys(value, ['bucket', 'blocks', 'steps', 'expects', 'replacements','command_identities','recomposition'], '');
  if (typeof value.bucket !== 'string' || !value.bucket) issue('/bucket', 'bucket 必须是台架名');
  if (!Array.isArray(value.blocks) || value.blocks.length) issue('/blocks', '本轮 blocks 必须是空数组');
  if(Object.hasOwn(value,'recomposition')&&!schema(SLOT_TABLE.item.plan.data.properties.recomposition).safeParse(value.recomposition).success)issue('/recomposition','重组消费形状不符合声明');
  const steps: PlanStep[] = [];
  if (!Array.isArray(value.steps) || !value.steps.length) issue('/steps', '步骤必须是非空数组');
  for (const [i, raw] of (Array.isArray(value.steps) ? value.steps : []).entries()) {
    const at = `/steps/${i}`;
    if (!isRecord(raw)) { issue(at, '步骤不是对象'); continue; }
    keys(raw, ['object', 'method', 'args', 'keywords','cleanup'], at);
    if(raw.cleanup!==undefined&&typeof raw.cleanup!=='boolean')issue(at+'/cleanup','cleanup 必须是显式布尔声明');
    for (const field of ['object', 'method']) if (typeof raw[field] !== 'string' || !raw[field]) issue(`${at}/${field}`, '缺少对象或方法原名');
    if (!Array.isArray(raw.args) || raw.args.some((v) => typeof v !== 'string')) issue(`${at}/args`, 'args 必须是文字列表，没有位置参数写 []');
    if (!isRecord(raw.keywords) || Object.values(raw.keywords).some((v) => typeof v !== 'string' && !(typeof v === 'number' && Number.isSafeInteger(v) && v >= 0))) issue(`${at}/keywords`, 'keywords 必须是参数名到文字或安全非负整数的映射，没有关键字写 {}');
    if (typeof raw.object === 'string' && typeof raw.method === 'string' && Array.isArray(raw.args) && isRecord(raw.keywords)) steps.push({...(typeof raw.cleanup==='boolean'?{cleanup:raw.cleanup}:{}),object: raw.object, method: raw.method, args: raw.args as string[], keywords: raw.keywords as Record<string, KeywordValue> });
  }
  const expects: PlanExpect[] = [];
  if (!Array.isArray(value.expects)) issue('/expects', 'expects 必须是数组');
  for (const [i, raw] of (Array.isArray(value.expects) ? value.expects : []).entries()) {
    const at = `/expects/${i}`;
    if (!isRecord(raw)) { issue(at, '期望不是对象'); continue; }
    keys(raw, ['text', 'quote', 'after','basis','rationale'], at);
    if(raw.basis!==undefined&&!isExpectationBasis(raw.basis))issue(at+'/basis','basis 必须是生成合约声明的完全相等值；默认逐字规则请省略');
    if(raw.basis!==undefined&&(typeof raw.rationale!=='string'||!raw.rationale.trim()))issue(at+'/rationale','模型判断必须有非空 rationale，说明为何选择这段设备可观察文字');
    if(raw.basis===undefined&&raw.rationale!==undefined)issue(at+'/rationale','默认规则不接收 rationale；模型判断请显式声明 basis');
    if (typeof raw.text !== 'string' || !raw.text) issue(`${at}/text`, '期望文字不能为空');
    if (!Number.isSafeInteger(raw.after) || (raw.after as number) < 1) issue(`${at}/after`, 'after 必须是从 1 开始的步骤号');
    if (!isRecord(raw.quote) || typeof raw.quote.reference !== 'string' || !raw.quote.reference || typeof raw.quote.text !== 'string' || !raw.quote.text) issue(`${at}/quote`, 'quote 必须带 reference 和逐字 text');
    else { keys(raw.quote, ['reference', 'text'], `${at}/quote`); expects.push({...(isExpectationBasis(raw.basis)?{basis:raw.basis,rationale:String(raw.rationale)}:{}), text: String(raw.text), after: raw.after as number, quote: { reference: raw.quote.reference, text: raw.quote.text } }); }
  }
  const replacements: Replacement[] = [];
  if (!Array.isArray(value.replacements)) issue('/replacements', 'replacements 必须是数组，没有替换写 []');
  for (const [i, raw] of (Array.isArray(value.replacements) ? value.replacements : []).entries()) {
    const at = `/replacements/${i}`;
    if (!isRecord(raw)) { issue(at, '替换条目不是对象'); continue; }
    keys(raw, ['case', 'bed'], at);
    if (typeof raw.case !== 'string' || !raw.case || typeof raw.bed !== 'string' || !raw.bed) issue(at, '替换条目必须是 {case, bed} 文字地址');
    else replacements.push({ case: raw.case, bed: raw.bed });
  }
  return problems.length ? { ok: false, problems } : { ok: true, slots: { ...(Object.hasOwn(value,'command_identities')?{command_identities:value.command_identities}:{}),...(Object.hasOwn(value,'recomposition')?{recomposition:value.recomposition as PlanSlots['recomposition']}:{}),bucket: String(value.bucket), blocks: [], steps, expects, replacements } };
}
