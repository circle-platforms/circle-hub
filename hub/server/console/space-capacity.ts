// Team and member quota controls share exact conversion, CSRF and the existing quota operation.
import {capacityInput,inputCapacityUnits} from '../capacity.ts';
import type {CapacityUsage} from '../../knowledge/api.ts';
import {capacitySummary,capacityScope} from './capacity.ts';
import {dialog,field,tooltip} from './presentation.ts';
import {uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import {html} from './html.ts';
import { csrfField, selectControl, submitButton } from './components.ts';
import type { PageContext } from './context.ts';
export async function spaceCapacityDialog(ctx:PageContext,space:string,usage:CapacityUsage){
 const input=capacityInput(usage.limit),id=space==='team'?'adjust-team-capacity':'adjust-member-capacity';
 const unit=selectControl('unit',inputCapacityUnits.options.map(unit=>({value:unit,label:uiLabelOf('capacity_unit',unit),selected:unit===input.unit})));
 return dialog(id,space==='team'?'调整公共空间容量':'调整成员容量',html`<p>${capacitySummary(usage)}</p><p>降低到已用以下会暂停新增内容，已有内容保留。容量按所选单位精确换算为整数字节。</p>${tooltip('容量统计范围',capacityScope)}${csrfField(ctx.csrf??'')}<input type="hidden" name="space" value="${space}">${field('容量数值',html`<input name="amount" type="text" inputmode="decimal" required maxlength="64" value="${input.amount}" aria-describedby="capacity-input-help">`)}${field('单位',unit)}<p id="capacity-input-help" class="ch-meta">换算结果须为整数字节；例如 0.5 MB。</p>`,submitButton('保存容量上限'),{action:'/console/knowledge/do/quota'});
}
