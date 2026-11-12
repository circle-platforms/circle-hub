// Presentation only; original instants are retained in datetime and the full-time tooltip.
import {html,type Html} from './html.ts';
const pad=(n:number)=>String(n).padStart(2,'0');
export function fullTime(iso:string|null|undefined):string{
 if(!iso)return '未记录';const d=new Date(iso);if(!Number.isFinite(d.getTime()))return iso;
 return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
/** The offset of an instant in the time zone the Hub writes times in, as people write it: UTC+08:00. */
export function zoneOf(d:Date):string{const m=-d.getTimezoneOffset(),a=Math.abs(m);return `UTC${m<0?'-':'+'}${pad(Math.floor(a/60))}:${pad(a%60)}`;}
/** What a compact time shows on hover (wording table, W37): the full time and the zone it is written in. */
export function hoverTime(iso:string|null|undefined):string{
 if(!iso)return '未记录';const d=new Date(iso);return Number.isFinite(d.getTime())?`${fullTime(iso)}（${zoneOf(d)}）`:iso;
}
export function relativeTime(iso:string|null|undefined,now=new Date()):string{
 if(!iso)return '未记录';const d=new Date(iso);if(!Number.isFinite(d.getTime()))return iso;
 const today=new Date(now.getFullYear(),now.getMonth(),now.getDate()),date=new Date(d.getFullYear(),d.getMonth(),d.getDate());
 if(date.getTime()===today.getTime())return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
 const yesterday=new Date(today);yesterday.setDate(yesterday.getDate()-1);if(date.getTime()===yesterday.getTime())return '昨天';
 return d.getFullYear()===now.getFullYear()?`${pad(d.getMonth()+1)}-${pad(d.getDate())}`:`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
export function time(iso:string|null|undefined,now=new Date()):Html{return html`<time class="nowrap ch-time"${iso?html` datetime="${iso}" title="${hoverTime(iso)}"`:''}>${relativeTime(iso,now)}</time>`;}
export function size(bytes:number):string{
 if(!Number.isFinite(bytes)||bytes<0)return '未知';const units=['B','KB','MB','GB','TB'];let n=bytes,unit=0;
 while(n>=1024&&unit<units.length-1){n/=1024;unit++;}return n.toLocaleString('en-US',{minimumFractionDigits:unit?1:0,maximumFractionDigits:unit?1:0})+' '+units[unit];
}
