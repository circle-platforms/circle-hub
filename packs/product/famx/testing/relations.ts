// Test-only evaluation of the shipped declaration against catalog and producer output.
import {readFileSync} from 'node:fs';
import {ProductDeclaration} from '../../../../contracts/src/product.ts';
import {entryContentOf,entryDigest} from '../../../../hub/knowledge/digest.ts';
import {relationFacts,relationNode,type RelationNode} from '../../../../hub/knowledge/links.ts';
import type {CommandCatalog} from '../functions/cases-commands.ts';
export function manualRelations(result:{entries:readonly (Parameters<typeof entryContentOf>[0]&{path:string|null})[]},catalog:CommandCatalog){
  const product=ProductDeclaration.parse(JSON.parse(readFileSync(new URL('../product.json',import.meta.url),'utf8')));
  const nodes=new Map<string,RelationNode>();
  const visit=(node:CommandCatalog['root'],words:string[])=>{
    const path='/commands'+(words.length?'/'+words.map(encodeURIComponent).join('/'):'');
    nodes.set(path,relationNode(node.path?[{kind:'definition',producers:['command-tree']}]:[]));
    for(const [word,child] of node.children)visit(child,[...words,word]);
  };visit(catalog.root,[]);
  const sources=result.entries.map(entry=>{const content=entryContentOf(entry);return {path:entry.path??'/',entry:entryDigest(content),content,producers:['manual-famx']};});
  return relationFacts('a'.repeat(64),product.links??[],nodes,sources);
}
