import {SaxesParser} from 'saxes';
import {parse, type DefaultTreeAdapterTypes} from 'parse5';
import {ApiError,requireCondition} from '../../contracts/src/index.ts';

export interface XmlNode {name:string;attributes:Record<string,string>;text:string;children:XmlNode[]}
export function xmlTree(bytes:Buffer):XmlNode {
  const parser=new SaxesParser({xmlns:false}),root:XmlNode={name:'#root',attributes:{},text:'',children:[]},stack=[root];
  parser.on('doctype',()=>{throw new ApiError('INVALID_PAYLOAD','XML document types and entities are not supported');});
  parser.on('error',()=>{throw new ApiError('INVALID_PAYLOAD','Source XML is malformed');});
  parser.on('opentag',tag=>{requireCondition(stack.length<100,'INVALID_PAYLOAD','XML nesting exceeds the limit');const node={name:tag.name.split(':').at(-1)!,attributes:tag.attributes as Record<string,string>,text:'',children:[]};stack.at(-1)!.children.push(node);stack.push(node);});
  parser.on('text',value=>{stack.at(-1)!.text+=value;});parser.on('cdata',value=>{stack.at(-1)!.text+=value;});
  const encoding=bytes.subarray(0,300).toString('ascii').match(/<\?xml\b[^?]*encoding\s*=\s*["']([^"']+)["']/i)?.[1]?.toLowerCase()??'utf-8';
  requireCondition(['utf-8','utf8','iso-8859-1','latin1','us-ascii'].includes(encoding),'INVALID_PAYLOAD','XML encoding is not supported');
  const decoded=bytes.toString(['iso-8859-1','latin1'].includes(encoding)?'latin1':'utf8');
  parser.on('closetag',()=>{stack.pop();});parser.write(decoded).close();return root;
}
export function xmlNodes(node:XmlNode,name:string):XmlNode[]{return [...(node.name===name?[node]:[]),...node.children.flatMap(child=>xmlNodes(child,name))];}
export type HtmlNode=DefaultTreeAdapterTypes.Node;
export function html(bytes:Buffer):HtmlNode{return parse(bytes.toString('utf8'));}
export function children(node:HtmlNode):HtmlNode[]{return 'childNodes' in node?node.childNodes:[];}
export function elements(node:HtmlNode,tag:string):DefaultTreeAdapterTypes.Element[]{return [...('tagName' in node&&node.tagName===tag?[node]:[]),...children(node).flatMap(child=>elements(child,tag))];}
export function attribute(node:DefaultTreeAdapterTypes.Element,name:string):string|undefined{return node.attrs.find(attr=>attr.name===name)?.value;}
export function textOf(node:HtmlNode):string{return ('value' in node?node.value:children(node).map(textOf).join(' ')).replace(/\s+/g,' ').trim();}
