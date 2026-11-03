// Team and member quota controls share exact conversion, CSRF and the existing quota operation.
import {capacityInput,inputCapacityUnits} from '../capacity.ts';
import type {CapacityUsage} from '../../knowledge/api.ts';
import {capacitySummary,capacityScope} from './capacity.ts';
import {dialog,field,tooltip} from './presentation.ts';
import {uiLabelOf} from '../../../contracts/generated/vocabulary.ts';
import {html} from './html.ts';
import type {PageContext} from './pages.ts';
export async function spaceCapacityDialog(ctx:PageContext,space:string,usage:CapacityUsage){
 const input=capacityInput(usage.limit),id=space==='team'?'adjust-team-capacity':'adjust-member-capacity';
 return dialog(id,space==='team'?'调整团队容量':'调整成员容量',html`<p>${capacitySummary(usage)}</p><p>降低到已用以下会暂停新增内容，已有内容保留。容量按所选单位精确换算为整数字节。</p>${tooltip('计费范围',capacityScope)}<input type="hidden" name="csrf" value="${ctx.csrf??''}"><input type="hidden" name="space" value="${space}">${field('容量数值',html`<input name="amount" type="text" inputmode="decimal" required maxlength="64" value="${input.amount}" aria-describedby="capacity-input-help">`)}${field('单位',html`<select name="unit">${inputCapacityUnits.options.map(unit=>html`<option value="${unit}"${unit===input.unit?html` selected`:''}>${uiLabelOf('capacity_unit',unit)}</option>`)}</select>`)}<p id="capacity-input-help" class="ch-meta">换算结果须为整数字节；例如 0.5 MB。</p>`,html`<button class="ch-btn ch-btn--primary" type="submit">保存容量上限</button>`,{action:'/console/knowledge/do/quota'});
}
