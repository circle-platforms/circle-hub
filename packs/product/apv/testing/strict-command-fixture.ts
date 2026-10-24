// Independently authored synthetic grammar for manual tests. It is not derived from producer output or prose.
import {commandCatalog} from '../functions/cases-commands.ts';
import {xml} from './test-support.ts';
const arg=(name:string,optional=false)=>`<arg name="${name}" type="STRING" optional="${optional?'YES':'NO'}"/>`;
const item=(words:string,forms:Array<Array<[string,boolean?]>>)=>`<item name="${words}">${forms.map(params=>'<arguments>'+params.map(([name,optional])=>arg(name,optional)).join('')+'</arguments>').join('')}</item>`;
export const STRICT_MANUAL_XML='<commands>'+[
 item('?', [[]]),item('help',[[]]),item('enable',[[],[['recovery',true]]]),
 ...['tcp','udp'].map(protocol=>item('demo acl deny '+protocol,[[['address']]])),...['gre','probe hello'].map(protocol=>item('demo acl permit '+protocol,[[['address']]])),item('demo acl log',[[['level']]]),
 item('x',[[]]),item('demo policy agent',[[['agent']],[['agent'],['mode']]]),item('demo disk warn',[[['high'],['low']]]),item('demo limit',[[['method']],[['method'],['value']]]),item('demo v6 6',[[]]),
 item('demo login',[[['account'],['secret']]]),item('demo pool add',[[['name']],[['name'],['address']],[['name'],['address'],['weight',true]]]),
 ...['rr','lc','hash'].map(mode=>item('demo pool mode '+mode,[[['pool']]])),
 ...['on','off'].map(mode=>item('demo mode '+mode,[[]])),item('demo mode',[[]]),
 ...['demo route static','no demo route static'].map(head=>item(head,[[['network'],['mask'],['gateway'],['duration'],['metric',true]],[['network'],['gateway']]])),
 item('demo probe',[[['name'],['protocol'],['port',true],['timeout',true]]]),item('show demo status',[[['pool',true]]]),item('demo nul',[[]]),
].join('')+'</commands>';
export const STRICT_MANUAL_CATALOG=commandCatalog(xml(STRICT_MANUAL_XML)).catalog;

// Legacy manual tests concern placement, source spans and symbolic parameter projection.
// Their old head-only trees were incomplete inputs under R4. This fixture explicitly declares
// all 0..4 positional STRING/optional forms, independent of manual text. Type/arity rejection
// regressions use their own exact trees in keyword-grammar.test.ts, never this helper.
export function placementXml(source:string|Uint8Array){
 const parsed=xml(source);
 const forms=Array.from({length:5},(_,size)=>Array.from({length:2**size},(_,mask)=>'<arguments>'+Array.from({length:size},(_,at)=>arg('p'+(at+1),!!(mask&(1<<at)))).join('')+'</arguments>')).flat().join('');
 const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('"','&quot;').replaceAll('<','&lt;');
 const render=(element:any):string=>{
  if(typeof element==='string')return element.replaceAll('&','&amp;').replaceAll('<','&lt;');
  const children=element.children as any[];
  const emptyForms=element.name==='item'&&children.some(child=>typeof child!=='string'&&child.name==='arguments'&&child.children.length===0);
  return '<'+element.name+Object.entries(element.attributes).map(([key,value])=>' '+key+'="'+escape(String(value))+'"').join('')+'>'+children.map(child=>emptyForms&&typeof child!=='string'&&child.name==='arguments'&&child.children.length===0?forms:render(child)).join('')+'</'+element.name+'>';
 };
 return xml(render(parsed.root));
}
