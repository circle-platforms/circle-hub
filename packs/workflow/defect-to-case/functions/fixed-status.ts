// Only an original structured status can establish a repaired defect. Draft slots never supply this field.
import {isReleaseStatus} from './generated/vocabulary.ts';
import type {CheckOutcome} from '../../../../contracts/src/tables.ts';
const object=(value:unknown):value is Record<string,unknown>=>typeof value==='object'&&value!==null&&!Array.isArray(value);
export const STATUS_NEXT='发布页或缺陷系统维护者补原始结构 status（fixed/known）及所属构建，运行者重读该原件并开新运行；不能从修复说明文字、标题或文件名补状态';
export function fixedStatusDeclaration(model:unknown){
 const raw=object(model)?model:{},fields=object(raw.fields)?raw.fields:{};
 const status=Object.hasOwn(fields,'status')?fields.status:raw.status;
 return raw.declaration_status!=='undeclared'&&isReleaseStatus(status)?{declaration_status:'declared',status}:{declaration_status:'undeclared',status:null,missing:'缺陷的原始结构化发布状态 fixed/known',next_action:STATUS_NEXT};
}
export default function fixedStatus(input:unknown):CheckOutcome[]{
 const raw=object(input)?input:{},subject=object(raw.subject)?raw.subject:{},fields=object(subject.fields)?subject.fields:{},state=object(fields.fixed_status)?fields.fixed_status:{};
 const own=typeof subject.item==='string'?{item:subject.item}:{};
 if(state.declaration_status!=='declared'||!isReleaseStatus(state.status))return [{verdict:'unknown',reason:'missing_input',missing:typeof state.missing==='string'?state.missing:'缺陷的原始结构化发布状态 fixed/known',statement:'已修复状态未声明；下一步：'+STATUS_NEXT,grounds:[],tier:'advisory',...own,data:{declaration_status:'undeclared',status:null,next_action:STATUS_NEXT}}];
 return state.status==='fixed'?[{verdict:'support',statement:'原始结构字段明确声明该缺陷已修复',grounds:[],tier:'advisory',...own,data:state}]:[{verdict:'refute',code:'defect-to-case.not_fixed',statement:'原始结构字段声明 known，不能将其当作已修复缺陷；下一步由运行者选择有明确 fixed 原件的缺陷，或由来源维护者更正后开新运行',grounds:[],tier:'advisory',...own,data:state}];
}
