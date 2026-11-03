import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parse} from 'parse5';
import {chart,comparisons,parts,timeline} from './charts.ts';
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

test('compact times retain the original instant and full tooltip across calendar and year boundaries',()=>{
 const now=new Date(2026,0,1,13,4,5),today=new Date(2026,0,1,10,24,0).toISOString(),yesterday=new Date(2025,11,31,22).toISOString();
 assert.equal(relativeTime(today,now),'今天 10:24');assert.equal(relativeTime(yesterday,now),'昨天');
 assert.equal(relativeTime(new Date(2025,11,30).toISOString(),now),'2025-12-30');assert.equal(relativeTime(new Date(2026,5,3).toISOString(),now),'06-03');
 assert.ok(time(today,now).text.includes('datetime="'+today+'"'));assert.ok(time(today,now).text.includes('title="'+fullTime(today)+'"'));
 assert.equal(relativeTime(null,now),'—');assert.equal(relativeTime('unknown',now),'unknown');
 assert.equal(size(0),'0 B');assert.equal(size(1024),'1.0 KB');assert.equal(size(1024**3),'1.0 GB');assert.equal(size(1.25*1024**2),'1.3 MB');assert.equal(size(NaN),'—');
});
