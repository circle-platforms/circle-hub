import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parse} from 'parse5';
import {chart,comparisons,curve,parts,timeline,type Curve} from './charts.ts';
import {fullTime,relativeTime,size,time} from './format.ts';

const text=(markup:string)=>{const walk=(node:any):string=>node.nodeName==='#text'?node.value:(node.childNodes??[]).map(walk).join('');return walk(parse(markup));};

test('chart readouts and the accessible table retain every observation, including zeros and escaped names',()=>{
 const points=[{label:'2026-11-01',values:[48000,0]},{label:'2026-11-02',values:[7,13]}],series=[{label:'合成甲 <script>',className:'s1'},{label:'合成乙',className:'s2'}];
 const figure=chart('合成趋势',points,series,'line').text;
 const table=figure.slice(figure.indexOf('<table'));
 for(const value of ['48,000','0','7','13','2026-11-01','2026-11-02','合成甲 <script>','合成乙'])assert.ok(text(table).includes(value),value);
 assert.match(figure,/data-chart-tip="0"/);assert.match(figure,/<b>48,000<\/b>/);assert.match(figure,/class="line s1"/);assert.match(figure,/class="dot s2"/);
 assert.doesNotMatch(figure,/<script|style=|fill-t[5-9]|NaN|Infinity/);
 assert.match(figure,/tabindex="0"/);assert.match(figure,/tabindex="-1"/);
 assert.throws(()=>chart('未知不可冒充零',[{label:'合成',values:[NaN]}],[{label:'合成'}]),RangeError);
 assert.throws(()=>chart('错列',[{label:'合成',values:[1,2]}],[{label:'合成'}]),RangeError);
});

test('a single comparison is a Stat; composition and temporal spans retain a full data table',()=>{
 const one=comparisons('合成数量',[{label:'合成项目',value:48000}]).text;assert.match(one,/ch-stat-value">48,000/);assert.doesNotMatch(one,/<svg/);
 const bar=parts([{label:'通过',value:3,className:'fill-pass'},{label:'未知',value:0,className:'fill-unknown'}],'合成分布').text;
 assert.throws(()=>comparisons('未知统计',[{label:'合成项目',value:NaN}]),RangeError);
 assert.match(bar,/class="ch-parts"/);assert.match(text(bar.slice(bar.indexOf('<table'))),/通过3未知0/);assert.doesNotMatch(bar,/NaN|Infinity|donut/);
 const start=Date.parse('2026-11-01T10:00:00Z');const span=timeline('合成执行',[{label:'合成长步骤',detail:'原始说明 <raw>',start,end:start+1200}]).text;
 assert.ok(span.includes('2026-11-01T10:00:00.000Z'));assert.ok(span.includes('2026-11-01T10:00:01.200Z'));assert.match(text(span),/原始说明 <raw>/);assert.match(span,/<td class="num">1,200<\/td>/);
});

test('timeline event points disclose an instant and unrecorded duration while measured zero remains zero',()=>{
 const start=Date.parse('2026-11-01T10:00:00Z');const markup=timeline('合成事件',[
  {label:'合成检查 <raw>',detail:'原始说明 <script>',start,end:start,point:true},
  {label:'实测零时长',start,end:start},
  {label:'实测调用',start,end:start+8},
 ]).text;
 const rows=[...markup.matchAll(/<tr>([\s\S]*?)<\/tr>/g)].map(match=>text(match[1]));
 assert.ok(rows.some(row=>row.includes('合成检查 <raw>')&&row.includes('记录时间点')&&row.endsWith('未记录')),JSON.stringify(rows));
 assert.ok(rows.some(row=>row.includes('实测零时长')&&row.endsWith('0')),JSON.stringify(rows));
 assert.ok(rows.some(row=>row.includes('实测调用')&&row.endsWith('8')),JSON.stringify(rows));
 const eventTip=markup.slice(markup.indexOf('<div data-chart-tip="0"'),markup.indexOf('<div data-chart-tip="1"'));
 assert.match(text(eventTip),/2026-11-01T10:00:00\.000Z记录于/);assert.match(text(eventTip),/耗时未记录/);assert.doesNotMatch(text(eventTip),/0 秒/);
 assert.match(markup,/aria-label="合成检查 &lt;raw&gt;；原始说明 &lt;script&gt;；记录时间点；耗时未记录"/);
 assert.doesNotMatch(markup,/<script>/);assert.match(markup,/<circle class="dot"/);assert.match(markup,/<b>0 毫秒<\/b>/);assert.match(markup,/<b>8 毫秒<\/b>/);
});

test('a curve breaks where nothing was read: no value is invented, the gap is named and the read-out says 未知',()=>{
 const base:Curve={title:'合成曲线',labels:['甲','乙','丙','丁','戊','己'],series:[{label:'合成值',values:[1,2,null,null,5,6]}],max:10,ticks:[0,5,10],tick:String,value:value=>value+' 个',xLabels:[[0,'甲'],[5,'己']]};
 const figure=curve(base).text;
 assert.equal([...figure.matchAll(/class="line "/g)].length,2,'one line each side of the gap');
 const lines=[...figure.matchAll(/class="line " d="([^"]+)"/g)].map(match=>match[1]);
 assert.equal(lines[0].split(' L ').length,2);assert.equal(lines[1].split(' L ').length,2);
 assert.match(figure,/class="gapband"/);assert.match(text(figure),/未知/);
 assert.match(figure,/aria-label="丙；未知 合成值"/);assert.match(figure,/<b>未知<\/b>/);assert.match(figure,/<b>1 个<\/b>/);
 assert.doesNotMatch(figure,/style=|NaN|Infinity/);
 const zero=curve({...base,series:[{label:'合成值',values:[0,0,0,0,0,0]}]}).text;
 assert.doesNotMatch(zero,/gapband/,'0 is a reading, not a gap');assert.match(zero,/<b>0 个<\/b>/);
 const none=curve({...base,series:[{label:'合成值',values:[null,null,null,null,null,null]}]}).text;
 assert.match(none,/class="gapband"/);assert.doesNotMatch(none,/class="line/);assert.doesNotMatch(none,/class="dot/);
 const two=curve({...base,series:[{label:'运行中',className:'s1',values:[1,null,3,4,5,6]},{label:'排队',className:'s2',values:[1,null,null,null,null,null]}]}).text;
 assert.match(two,/class="ch-legend is-line"/);assert.match(two,/class="line s2"/);assert.doesNotMatch(two,/class="wash/,'an area only under a single line');
 assert.equal([...two.matchAll(/class="gapband"/g)].length,1,'a gap is where no series has a value');
});

test('a curve groups its read-outs, draws its marks and a known value off the line, and keeps its table',()=>{
 const figure=curve({title:'合成曲线',note:'合成说明',labels:['甲','乙','丙','丁'],series:[{label:'合成值',values:[1,9,3,4]}],max:10,ticks:[0,10],tick:String,value:String,xLabels:[[0,'甲'],[3,'丁']],hoverEvery:2,marks:[{index:1,label:'合成事件',side:'left',low:true}],points:[{index:3,value:7,label:'合成报告 7'}],table:{head:['时间','合成值'],rows:[['甲',1],['乙',9]]}}).text;
 assert.equal([...figure.matchAll(/data-chart-index=/g)].length,2);assert.match(figure,/<b>9<\/b>/,'a read-out covers its points by the largest');
 assert.match(figure,/class="mark"/);assert.match(text(figure),/合成事件/);assert.match(figure,/class="dot pin"/);assert.match(text(figure),/合成报告 7/);
 assert.match(figure,/ch-tableview/);assert.match(text(figure.slice(figure.indexOf('<table'))),/甲1乙9/);assert.match(figure,/ch-tip/);
});

test('a read-out covers its points by what the curve keeps: the largest, or with least the smallest',()=>{
 const base:Curve={title:'合成曲线',labels:['甲','乙','丙','丁'],series:[{label:'合成值',values:[9,1,null,4]}],max:10,ticks:[0,10],tick:String,value:value=>value+' 个',xLabels:[[0,'甲'],[3,'丁']],hoverEvery:2};
 const most=curve(base).text;
 assert.match(most,/<b>9 个<\/b>/);assert.match(most,/aria-label="甲；9 个 合成值"/);assert.doesNotMatch(most,/<b>1 个<\/b>/);
 const least=curve({...base,least:true}).text;
 assert.match(least,/<b>1 个<\/b>/,'the dip the curve keeps');assert.match(least,/aria-label="甲；1 个 合成值"/);assert.doesNotMatch(least,/<b>9 个<\/b>/);
 assert.match(least,/<b>4 个<\/b>/,'a point nobody read is left out, not read as the least');
 assert.match(curve({...base,least:true,series:[{label:'合成值',values:[null,null,4,4]}]}).text,/<b>未知<\/b>/);
});

test('compact times retain the original instant and full tooltip across calendar and year boundaries',()=>{
 const now=new Date(2026,0,1,13,4,5),today=new Date(2026,0,1,10,24,0).toISOString(),yesterday=new Date(2025,11,31,22).toISOString();
 assert.equal(relativeTime(today,now),'今天 10:24');assert.equal(relativeTime(yesterday,now),'昨天');
 assert.equal(relativeTime(new Date(2025,11,30).toISOString(),now),'2025-12-30');assert.equal(relativeTime(new Date(2026,5,3).toISOString(),now),'06-03');
 assert.ok(time(today,now).text.includes('datetime="'+today+'"'));assert.ok(time(today,now).text.includes('title="'+fullTime(today)+'"'));
 assert.equal(relativeTime(null,now),'—');assert.equal(relativeTime('unknown',now),'unknown');
 assert.equal(size(0),'0 B');assert.equal(size(1024),'1.0 KB');assert.equal(size(1024**3),'1.0 GB');assert.equal(size(1.25*1024**2),'1.3 MB');assert.equal(size(NaN),'—');
});
