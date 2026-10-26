// Only the exact expected-node references actually cited by explicit model choices enter check subjects and recipes.
import {isRecord} from './text.ts';
export function selectedExpectedNodes(nodes:unknown,data:unknown):unknown{
 if(!isRecord(data)||!Array.isArray(data.expects))return undefined;
 if(Array.isArray(data.blocks)&&data.blocks.length)return nodes;
 const references=new Set(data.expects.filter(isRecord).filter(expect=>expect.basis==='model_judgment'&&isRecord(expect.quote)&&typeof expect.quote.reference==='string').map(expect=>(expect.quote as {reference:string}).reference));
 if(!references.size)return undefined;
 if(!Array.isArray(nodes)||nodes.some(node=>!isRecord(node)||typeof node.reference!=='string'||typeof node.text!=='string'))return undefined;
 return nodes.filter(node=>references.has(node.reference));
}
