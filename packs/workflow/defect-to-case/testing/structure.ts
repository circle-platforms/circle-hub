// Independent, fully declared synthetic inputs for the R7 contract (not computed from the duplicate checker).
import {createHash} from 'node:crypto';
import type {CatalogSpec} from '../../../../hub/rules/api.ts';
import type {CommandIdentity,ExpectedQuoteIdentity} from '../../../../contracts/generated/shared-interfaces.ts';
const declarations=[
 {head:'widget health interval',params:[{name:'seconds',type:'int' as const,minimum:1,maximum:300}]},
 {head:'show health',params:[]},
 {head:'show health detail',params:[]},
 {head:'service http port',params:[{name:'port',type:'port' as const,minimum:1,maximum:65535}]},
];
export const NATIVE_CATALOG_BYTES=JSON.stringify({schema:'synthetic-catalog@1',entries:declarations});
export const TREE_SOURCE=createHash('sha256').update(NATIVE_CATALOG_BYTES).digest('hex');
export const STRUCTURAL_CATALOG_SPEC:CatalogSpec={root:'a'.repeat(64),complete:true,caseSensitive:true,entries:declarations.map((entry,index)=>({head:entry.head,reference:'tree:'+'a'.repeat(64)+'/commands/'+entry.head.split(' ').join('/'),signatures:[{id:'native-'+index,reference:`src:${TREE_SOURCE}/json@1/p/entries/${index}/params`,params:entry.params.map((param,position)=>({...param,native_type:{name:param.type,declaration:`src:${TREE_SOURCE}/json@1/p/entries/${index}/params/${position}`,grammar:'synthetic-catalog@1'}}))}]}))};
export function nativeStep(command:string){
 const tokens=command.split(' ');const index=declarations.findIndex(entry=>{const words=entry.head.split(' ');return tokens.length===words.length+entry.params.length&&words.every((word,i)=>tokens[i]===word);});
 if(index<0)return {command};const entry=declarations[index],args=tokens.slice(entry.head.split(' ').length);
 if(entry.params.some((p,n)=>! /^-?[0-9]+$/.test(args[n])||Number(args[n])<p.minimum||Number(args[n])>p.maximum))return {command};
 const identity:CommandIdentity={tree_root:TREE_SOURCE,path:'/commands/'+entry.head.split(' ').join('/'),signature:`src:${TREE_SOURCE}/json@1/p/entries/${index}/params`,parameters:entry.params.map((p,n)=>({position:n,name:p.name,raw:args[n],type:{name:p.type,catalog_type:p.type,declaration:`src:${TREE_SOURCE}/json@1/p/entries/${index}/params/${n}`,grammar:'synthetic-catalog@1'},parsed:{kind:'int',value:Number(args[n])}}))};return {command,identity};
}
export const QUOTE_BYTES='健康检查间隔设置成功\n系统运行正常\n健康检查状态显示正常';
export const QUOTE_SOURCE=createHash('sha256').update(QUOTE_BYTES).digest('hex');
export function nativeExpected(text='健康检查状态显示正常'){
 const quote=QUOTE_BYTES.includes(text)?text:'健康检查状态显示正常',at=QUOTE_BYTES.indexOf(quote),line=QUOTE_BYTES.slice(0,at).split('\n').length;
 const identity:ExpectedQuoteIdentity={source_sha256:QUOTE_SOURCE,parser:'text@1',path:'l/'+line,span:{unit:'byte',offset:Buffer.byteLength(QUOTE_BYTES.slice(0,at)),length:Buffer.byteLength(quote)}};
 return {text,after:1,identity,quote:{reference:`src:${QUOTE_SOURCE}/text@1/l/${line}`,text:quote}};
}
export const EXPECTED_IDENTITY=nativeExpected().identity;
export const indexedStructure={schema:'case-structure@2',commands:[nativeStep('show health detail').identity!],expected:[{after:1,quote:EXPECTED_IDENTITY}]};
