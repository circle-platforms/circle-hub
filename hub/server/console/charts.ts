// Chart geometry and its accessible table are derived together from the caller's observed values.
import {html,table,type Html} from './html.ts';
import {tooltip} from './presentation.ts';

export interface Series {label:string;className?:string}
export interface Point {label:string;values:readonly number[]}
const W=480,H=224,L=38,R=20,T=24,B=32;
const finite=(n:number)=>{if(!Number.isFinite(n)||n<0)throw new RangeError('Chart values must be finite non-negative observations');return n;};
const fmt=(n:number)=>n.toLocaleString('en-US');
const scale=(values:readonly number[])=>{const peak=Math.max(1,...values.map(finite));const power=10**Math.floor(Math.log10(peak));return Math.ceil(peak/power)*power;};
const tip=(points:readonly Point[],series:readonly Series[])=>html`<div class="ch-chart-tip" hidden role="status">${points.map((point,index)=>html`<div data-chart-tip="${index}" hidden><div class="when">${point.label}</div>${point.values.map((value,k)=>html`<div class="row ${series[k]?.className??''}"><b>${fmt(value)}</b><span>${series[k]?.label??''}</span></div>`)}</div>`)}</div>`;
const fallback=(points:readonly Point[],series:readonly Series[],axisLabel='日期')=>html`<details class="ch-tableview"><summary>以表格查看</summary>${table([axisLabel,...series.map(s=>s.label)],points.map(point=>[point.label,...point.values]))}</details>`;
const legend=(series:readonly Series[],line=false)=>series.length<2?'':html`<div class="ch-legend${line?' is-line':''}">${series.map(s=>html`<span class="${s.className??''}">${s.label}</span>`)}</div>`;

/** Values never come from client calculations; hover targets point to server-rendered readouts and table rows. */
export function chart(title:string,points:readonly Point[],series:readonly Series[],mode:'bar'|'line'='bar',note?:string,axisLabel='日期'):Html{
 if(points.some(point=>point.values.length!==series.length))throw new RangeError('Chart series and values differ');
 if(!points.length||!series.length)return html`<div class="ch-empty"><p class="ch-empty-title">没有可绘制的记录</p></div>`;
 const max=scale(points.map(point=>mode==='bar'?point.values.reduce((sum,value)=>sum+finite(value),0):Math.max(0,...point.values)));
 const right=mode==='line'?110:R,pw=W-L-right,ph=H-T-B,band=pw/points.length,bw=Math.min(24,Math.max(2,band-2)),step=points.length===1?0:pw/(points.length-1);
 const X=(i:number)=>mode==='bar'?L+(i+.5)*band:L+i*step,Y=(v:number)=>T+ph-finite(v)/max*ph;
 const ticks=[0,Math.ceil(max/2),max].filter((value,index,all)=>all.indexOf(value)===index);
 const grid=html`${ticks.map(value=>html`<line class="grid" x1="${L}" x2="${W-right}" y1="${Y(value)}" y2="${Y(value)}"></line><text class="tick" x="${L-8}" y="${Y(value)+4}" text-anchor="end">${fmt(value)}</text>`)}`;
 const dates=html`${[0,Math.floor((points.length-1)/2),points.length-1].filter((v,i,a)=>a.indexOf(v)===i).map(i=>html`<text class="tick" x="${X(i)}" y="${H-8}" text-anchor="${i===0?'start':i===points.length-1?'end':'middle'}">${[...points[i].label].length>10?[...points[i].label].slice(0,10).join('')+'…':points[i].label}</text>`)}`;
 const marks:Html[]=[];
 if(mode==='bar'){
  points.forEach((point,i)=>{let used=0;point.values.forEach((value,k)=>{const v=finite(value),height=v/max*ph,y=Y(used+v),x=X(i)-bw/2,r=Math.min(4,height,bw/2);if(v>0)marks.push(html`<path data-chart-mark="${i}" class="bar ${series[k].className??''}" d="M ${x} ${y+height} V ${y+r} Q ${x} ${y} ${x+r} ${y} H ${x+bw-r} Q ${x+bw} ${y} ${x+bw} ${y+r} V ${y+height} Z"></path>`);used+=v;});});
 }else{
  series.forEach((s,k)=>{const d=points.map((point,i)=>(i?'L':'M')+X(i).toFixed(2)+' '+Y(point.values[k]??0).toFixed(2)).join(' ');marks.push(html`<path class="line ${s.className??''}" d="${d}"></path><circle class="dot ${s.className??''}" cx="${X(points.length-1)}" cy="${Y(points.at(-1)!.values[k]??0)}" r="4"></circle>`);});
 }
 const endLabels=mode==='line'?series.map((s,k)=>({label:s.label+' '+fmt(points.at(-1)!.values[k]),y:Y(points.at(-1)!.values[k])})).sort((a,b)=>a.y-b.y):[];
 let previous=T;for(let i=endLabels.length-1;i>=0;i--){endLabels[i].y=Math.min(endLabels[i].y,H-B-18*(endLabels.length-1-i));}for(const label of endLabels){label.y=Math.max(T,previous,label.y);previous=label.y+18;}
 const labels=html`${endLabels.map(label=>html`<text class="name" x="${W-right+8}" y="${label.y+4}">${label.label}</text>`)}`;
 const keyNumbers:Html[]=[];
 if(mode==='bar'){
  const totals=points.map(point=>point.values.reduce((sum,value)=>sum+value,0)),peak=Math.max(...totals);
  for(const i of new Set([totals.indexOf(peak),points.length-1]))keyNumbers.push(html`<text class="value" x="${X(i)}" y="${Y(totals[i])-8}" text-anchor="middle">${fmt(totals[i])}</text>`);
 }else{
  const seen=new Set<string>();series.forEach((_,k)=>{const values=points.map(point=>point.values[k]),peak=Math.max(...values),i=values.indexOf(peak),key=i+':'+peak;if(i!==points.length-1&&!seen.has(key)){seen.add(key);keyNumbers.push(html`<text class="value" x="${X(i)+5}" y="${Y(peak)-8}">${fmt(peak)}</text>`);}});
 }
 const targets=html`${points.map((point,i)=>html`<g data-chart-index="${i}" tabindex="${i===0?0:-1}" role="img" aria-label="${point.label+'；'+point.values.map((value,k)=>fmt(value)+' '+series[k].label).join('；')}">${mode==='line'?html`<line class="crosshair" x1="${X(i)}" x2="${X(i)}" y1="${T}" y2="${H-B}" data-crosshair></line>`:''}<rect class="hit" x="${mode==='bar'?L+i*band:Math.max(L,X(i)-Math.max(step/2,8))}" y="${T}" width="${mode==='bar'?band:points.length===1?pw:Math.min(step,pw-(Math.max(L,X(i)-Math.max(step/2,8))-L))}" height="${ph}"><title>${point.label+'；'+point.values.map((value,k)=>fmt(value)+' '+series[k].label).join('；')}</title></rect></g>`)}`;
 return html`<figure class="ch-figure" data-chart><div><h3 class="ch-figure-title">${note?tooltip(title,note):title}</h3></div>${legend(series,mode==='line')}<div class="ch-plot"><svg class="ch-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">${grid}${marks}${dates}${labels}${keyNumbers}${targets}</svg>${tip(points,series)}</div>${fallback(points,series,axisLabel)}</figure>`;
}

export function comparisons(title:string,rows:readonly {label:string;value:number}[],note?:string):Html{
 if(rows.length===1)return html`<div class="ch-stat"><span class="ch-stat-label">${note?tooltip(rows[0].label,note):rows[0].label}</span><span class="ch-stat-value">${fmt(finite(rows[0].value))}</span></div>`;
 return chart(title,rows.map(row=>({label:row.label,values:[row.value]})),[{label:title}],'bar',note,'项目');
}

export function parts(rows:readonly {label:string;value:number;className:string}[],title:string):Html{
 const sum=rows.reduce((total,row)=>total+finite(row.value),0);let x=0;
 const rects=rows.map(row=>{const width=sum?finite(row.value)/sum*100:0,previous=x;x+=width;return width?html`<rect class="${row.className}" x="${previous}" y="0" width="${width}" height="8"><title>${fmt(row.value)} ${row.label}</title></rect>`:'';});
 return html`<figure class="ch-figure"><h3 class="ch-figure-title">${title}</h3><svg class="ch-parts" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${title}">${rects}</svg><div class="ch-legend">${rows.map(row=>html`<span class="${row.className}">${row.label} <b class="num">${fmt(row.value)}</b></span>`)}</div><details class="ch-tableview"><summary>以表格查看</summary>${table(['状态','数量'],rows.map(row=>[row.label,row.value]))}</details></figure>`;
}

/** One line of a curve. A null value is an interval nobody has a reading for: the line breaks there, it is never drawn as 0. */
export interface CurveSeries {label:string;className?:string;values:readonly (number|null)[]}
export interface Curve {
 title:string;note?:string;
 /** One per point, for the read-out. */
 labels:readonly string[];
 series:readonly CurveSeries[];
 max:number;ticks:readonly number[];tick:(value:number)=>string;value:(value:number)=>string;
 /** The x axis: a point's index and its text. */
 xLabels:readonly (readonly [number,string])[];
 /** A moment on the curve: a vertical line with its name. */
 marks?:readonly {index:number;label:string;side?:'left'|'right';low?:boolean}[];
 /** A known value off the sampled line, such as the heap in a crash report. */
 points?:readonly {index:number;value:number;label:string}[];
 /** Points one read-out covers, so that a long curve stays a small page; it shows the largest of them, with `least` the smallest. */
 hoverEvery?:number;
 least?:boolean;
 table?:{head:readonly string[];rows:readonly (readonly unknown[])[]};
}
const CW=360,CH=148,CL=44,CR=12,CT=16,CB=22;
/** The narrowest stretch with no reading that still has room for the word. */
const GAP_WORD_WIDTH=32;

/** The stretches where no series has a value, as first and last index. */
function gaps(series:readonly CurveSeries[],points:number):[number,number][]{
 const out:[number,number][]=[];let start:number|null=null;
 for(let i=0;i<=points;i++){
  const empty=i<points&&series.every(line=>line.values[i]===null);
  if(empty&&start===null)start=i;
  if(!empty&&start!==null){out.push([start,i-1]);start=null;}
 }
 return out;
}

/** A line that may break, with the same read-outs and table as chart(); `chart` refuses a value that is not a number. */
export function curve(input:Curve):Html{
 const pw=CW-CL-CR,ph=CH-CT-CB,n=input.labels.length,every=input.hoverEvery??1;
 const X=(i:number)=>CL+(n<=1?0:i/(n-1)*pw),Y=(v:number)=>CT+ph-Math.min(v,input.max)/input.max*ph;
 const f=(value:number)=>value.toFixed(1);
 const grid=input.ticks.map(value=>html`<line class="grid" x1="${CL}" x2="${CW-CR}" y1="${f(Y(value))}" y2="${f(Y(value))}"></line><text class="tick" x="${CL-6}" y="${f(Y(value)+4)}" text-anchor="end">${input.tick(value)}</text>`);
 const bands=gaps(input.series,n).map(([from,to])=>{const x=X(from===0?0:from-1),w=X(to===n-1?n-1:to+1)-x;return html`<rect class="gapband" x="${f(x)}" y="${CT}" width="${f(Math.max(w,1))}" height="${ph}"></rect>${w>=GAP_WORD_WIDTH?html`<text class="name" x="${f(x+w/2)}" y="${CT+ph/2+4}" text-anchor="middle">未知</text>`:''}`;});
 const lines=input.series.map(line=>{
  const cls=line.className??'',runs:string[][]=[];let run:string[]|null=null;
  line.values.forEach((value,i)=>{if(value===null){run=null;return;}if(run===null){run=[];runs.push(run);}run.push(f(X(i))+' '+f(Y(value)));});
  const last=line.values.findLastIndex(value=>value!==null);
  const wash=input.series.length===1?runs.map(points=>html`<path class="wash ${cls}" d="M ${points.join(' L ')} L ${points.at(-1)!.split(' ')[0]} ${f(CT+ph)} L ${points[0].split(' ')[0]} ${f(CT+ph)} Z"></path>`):'';
  return html`${wash}${runs.map(points=>html`<path class="line ${cls}" d="M ${points.join(' L ')}"></path>`)}${last===-1?'':html`<circle class="dot ${cls}" cx="${f(X(last))}" cy="${f(Y(line.values[last]!))}" r="4"></circle>`}`;
 });
 const marks=(input.marks??[]).map(mark=>{const x=X(mark.index),right=mark.side!=='left';return html`<line class="mark" x1="${f(x)}" x2="${f(x)}" y1="${CT}" y2="${CT+ph}"></line><text class="value" x="${f(x+(right?4:-4))}" y="${mark.low?CT+ph-6:CT+10}" text-anchor="${right?'start':'end'}">${mark.label}</text>`;});
 const pins=(input.points??[]).map(point=>html`<circle class="dot pin" cx="${f(X(point.index))}" cy="${f(Y(point.value))}" r="4"></circle><text class="value" x="${f(X(point.index))}" y="${CT-6}" text-anchor="end">${point.label}</text>`);
 const axis=input.xLabels.map(([index,text],i,all)=>html`<text class="tick" x="${f(X(index))}" y="${CH-6}" text-anchor="${i===0?'start':i===all.length-1?'end':'middle'}">${text}</text>`);
 const hits:Html[]=[],tips:Html[]=[];
 for(let start=0,slot=0;start<n;start+=every,slot++){
  const stop=Math.min(n,start+every),mid=Math.min(n-1,start+Math.floor(every/2));
  const fold=(values:readonly (number|null)[])=>{const inside=values.slice(start,stop).filter((value):value is number=>value!==null);return inside.length===0?null:input.least?Math.min(...inside):Math.max(...inside);};
  const row=input.series.map(line=>({label:line.label,className:line.className??'',value:fold(line.values)}));
  const read=(value:number|null)=>value===null?'未知':input.value(value);
  const left=Math.max(CL,start===0?CL:(X(start-1)+X(start))/2),right=stop>=n?CW-CR:(X(stop-1)+X(stop))/2;
  hits.push(html`<g data-chart-index="${slot}" tabindex="${slot===0?0:-1}" role="img" aria-label="${input.labels[start]+'；'+row.map(item=>read(item.value)+' '+item.label).join('；')}"><line class="crosshair" x1="${f(X(mid))}" x2="${f(X(mid))}" y1="${CT}" y2="${CT+ph}"></line><rect class="hit" x="${f(left)}" y="${CT}" width="${f(Math.max(1,right-left))}" height="${ph}"></rect></g>`);
  tips.push(html`<div data-chart-tip="${slot}" hidden><div class="when">${input.labels[start]}</div>${row.map(item=>html`<div class="row ${item.className}"><b>${read(item.value)}</b><span>${item.label}</span></div>`)}</div>`);
 }
 const fallbackTable=input.table?html`<details class="ch-tableview"><summary>以表格查看</summary>${table(input.table.head,input.table.rows as unknown[][])}</details>`:'';
 return html`<figure class="ch-figure" data-chart><h3 class="ch-figure-title">${input.note?tooltip(input.title,input.note):input.title}</h3>${legend(input.series,true)}<div class="ch-plot"><svg class="ch-chart ch-curve" viewBox="0 0 ${CW} ${CH}" role="group" aria-label="${input.title}">${grid}${bands}${lines}${marks}${pins}${axis}${hits}</svg><div class="ch-chart-tip" hidden role="status">${tips}</div></div>${fallbackTable}</figure>`;
}

export interface Span {label:string;detail?:string;start:number;end:number;point?:boolean;url?:string}
/** One temporal series: colour denotes the area's elapsed spans, never a mix of activity and result colours. */
export function timeline(title:string,spans:readonly Span[],note?:string):Html{
 if(!spans.length)return html`<div class="ch-empty"><p class="ch-empty-title">没有可展示的执行记录</p></div>`;
 const start=Math.min(...spans.map(s=>s.start)),end=Math.max(start+1,...spans.map(s=>s.end)),width=680,left=180,right=30,top=28,row=30,height=top+row*spans.length+28;
 const X=(time:number)=>left+(time-start)/(end-start)*(width-left-right);
 const trim=(s:string)=>[...s].length>14?[...s].slice(0,14).join('')+'…':s;
 return html`<figure class="ch-figure" data-chart><div><h3 class="ch-figure-title">${note?tooltip(title,note):title}</h3></div><div class="ch-plot"><svg class="ch-chart" data-timeline viewBox="0 0 ${width} ${height}" role="img" aria-label="${title}"><text class="tick" x="${left}" y="16">${new Date(start).toLocaleTimeString('zh-CN',{hour12:false})}</text><text class="tick" x="${width-right}" y="16" text-anchor="end">${new Date(end).toLocaleTimeString('zh-CN',{hour12:false})}</text>${spans.map((span,index)=>{const y=top+index*row,x=X(span.start),w=Math.max(1,X(span.end)-x);return html`<g data-chart-index="${index}" tabindex="${index===0?0:-1}" role="img" aria-label="${span.label+'；'+(span.detail??'')}"${span.url?html` data-row-href="${span.url}"`:''}><line class="grid" x1="0" x2="${width}" y1="${y+row}" y2="${y+row}"></line><text class="name" x="0" y="${y+20}">${trim(span.label)}</text>${span.point?html`<circle class="dot" cx="${x}" cy="${y+15}" r="4"></circle>`:html`<rect class="bar" data-chart-mark="${index}" x="${x}" y="${y+8}" width="${w}" height="14" rx="4"></rect>`}<rect class="hit" x="0" y="${y}" width="${width}" height="${row}"><title>${span.label+'；'+(span.detail??'')}</title></rect></g>`;})}</svg><div class="ch-chart-tip" hidden role="status">${spans.map((span,index)=>html`<div data-chart-tip="${index}" hidden><div class="when">${span.label}</div><div class="row"><b>${((span.end-span.start)/1000).toLocaleString('en-US',{maximumFractionDigits:1})} 秒</b><span>跨度</span></div><p>${span.detail??''}</p></div>`)}</div></div><details class="ch-tableview"><summary>以表格查看</summary>${table(['步骤','说明','开始时间','结束时间','跨度（毫秒）'],spans.map(span=>[span.url?html`<a href="${span.url}">${span.label}</a>`:span.label,span.detail??'',new Date(span.start).toISOString(),new Date(span.end).toISOString(),span.end-span.start]))}</details></figure>`;
}
