// Rendered-interface checks only: original evidence, protocol bytes and user-authored content are deliberately immutable.
import {parse,type DefaultTreeAdapterTypes as Tree} from 'parse5';
export function wordingProblems(markup:string):string[]{
 const errors=new Set<string>(),old=/共享给我的|个人|出处|依据|可见范围|授权|提交共享|添加条目|已核验|未核验|历史|修订引文|目录|种类|继承自上级/g;
 const check=(text:string,where:string)=>{text=text.replace(/\s+/g,' ').trim();if(!text)return;for(const found of text.matchAll(old))errors.add(where+': old wording '+found[0]);if(/(?:^|[，。；：\s])(?:你|他)(?:们)?(?:的|已|可|需|要|正在|把|将|来|正|会|能|应|处理)|等待你|交给你|请你/.test(text))errors.add(where+': personal subject');if(/[\p{Script=Han}][A-Za-z0-9]|[A-Za-z0-9][\p{Script=Han}]/u.test(text))errors.add(where+': missing Chinese/Latin spacing: '+text);};
 const attrs=(node:Tree.Node)=>'attrs'in node?Object.fromEntries(node.attrs.map(attr=>[attr.name,attr.value])):{};
 const raw=(node:Tree.Node)=>'value'in node?node.value:'';
 const flow=(node:Tree.Node):string=>{const a=attrs(node);if(a['data-evidence']!==undefined||a['role']==='tooltip'||['pre','code','textarea','select','input','script','style'].includes(node.nodeName))return '';return node.nodeName==='#text'?raw(node):'childNodes'in node?node.childNodes.map(flow).join(''):'';};
 const walk=(node:Tree.Node)=>{
  const a=attrs(node);if(['script','style','pre','code','textarea'].includes(node.nodeName)||a['data-evidence']!==undefined)return;
  const technical=a['data-technical']!==undefined;
  for(const key of ['title','aria-label','aria-description','placeholder'])if(a[key])check(a[key],node.nodeName+'['+key+']');
  if(node.nodeName==='#text')check(raw(node),'text');
  if(/^(p|h[1-6]|dt|dd|th|td|summary|a|label|button|option|figcaption)$/.test(node.nodeName))check(flow(node),node.nodeName);
  if('childNodes'in node)for(const child of node.childNodes)if(!technical||child.nodeName==='summary')walk(child);
 };
 walk(parse(markup));return [...errors];
}
