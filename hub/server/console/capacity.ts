// HTML wrappers keep exact-byte evidence while every visible size shares the server formatter.
import {html,type Html} from './html.ts';
import {formatCapacity,exactBytes,capacityFailure} from '../capacity.ts';
import type {CapacityUsage} from '../../knowledge/api.ts';
export const capacitySize=(bytes:number):Html=>html`<span class="ch-tip ch-tip--start ch-capacity-value" tabindex="0" title="${exactBytes(bytes)}" aria-description="${exactBytes(bytes)}">${formatCapacity(bytes)}<span class="ch-tip-bubble" role="tooltip" aria-hidden="true">${exactBytes(bytes)}</span></span>`;
export const capacityScope='知识、原文及其版本记录与记忆版本记录的逻辑计费量；不代表磁盘占用，不包含工作流或技能文件、同步暂存和索引。撤回或停用不释放仍保留的版本记录容量。';
export function capacitySummary(usage:CapacityUsage):Html{return html`<span title="${capacityScope}">已用 ${capacitySize(usage.used)} / 上限 ${capacitySize(usage.limit)} · 剩余 ${capacitySize(usage.remaining)}${usage.over?html` · 已超出 ${capacitySize(usage.over)}`:''}</span>`;}
export function capacityError(error:unknown):Html|null{const facts=capacityFailure(error);return facts?html`<div class="ch-section"><p class="error">${facts.space==='team'?'团队空间容量不足':'私人空间容量不足'}</p><p>${capacitySummary(facts)}</p><p>本次新增 ${capacitySize(facts.requested)}</p><p>请联系管理员调整容量后重试。撤回或停用内容不会释放版本记录占用。</p></div>`:null;}
