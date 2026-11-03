// Presentation only; original instants are retained in datetime and the full-time tooltip.
import {html,type Html} from './html.ts';
const pad=(n:number)=>String(n).padStart(2,'0');
export function fullTime(iso:string|null|undefined):string{
 if(!iso)return '—';const d=new Date(iso);if(!Number.isFinite(d.getTime()))return iso;
 return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
export function relativeTime(iso:string|null|undefined,now=new Date()):string{
 if(!iso)return '—';const d=new Date(iso);if(!Number.isFinite(d.getTime()))return iso;
 const today=new Date(now.getFullYear(),now.getMonth(),now.getDate()),date=new Date(d.getFullYear(),d.getMonth(),d.getDate());
 if(date.getTime()===today.getTime())return `今天 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
 const yesterday=new Date(today);yesterday.setDate(yesterday.getDate()-1);if(date.getTime()===yesterday.getTime())return '昨天';
 return d.getFullYear()===now.getFullYear()?`${pad(d.getMonth()+1)}-${pad(d.getDate())}`:`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
}
export function time(iso:string|null|undefined,now=new Date()):Html{return html`<time class="nowrap ch-time"${iso?html` datetime="${iso}" title="${fullTime(iso)}"`:''}>${relativeTime(iso,now)}</time>`;}
export function size(bytes:number):string{
 if(!Number.isFinite(bytes)||bytes<0)return '—';const units=['B','KB','MB','GB','TB'];let n=bytes,unit=0;
 while(n>=1024&&unit<units.length-1){n/=1024;unit++;}return n.toLocaleString('en-US',{minimumFractionDigits:unit?1:0,maximumFractionDigits:unit?1:0})+' '+units[unit];
}
