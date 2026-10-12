import {readFile} from 'node:fs/promises';
import {dirname,isAbsolute,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import {ApiError,ToolName,requireCondition} from '../packages/contracts/src/index.ts';
import {toolPackages,type ToolPackage} from '../packages/connectors/src/tool-packages.ts';

const name=z.string().regex(/^[a-z][a-z0-9-]{0,99}$/);
const relativePath=z.string().min(1).max(500).refine(path=>!isAbsolute(path)&&!path.includes('\\')&&!path.includes(':')&&path.split('/').every(part=>!!part&&part!=='.'&&part!=='..'),'Package paths must stay inside the product line');
const binding=z.object({packageId:name,alias:ToolName.optional()}).strict();
export const ProductLineManifest=z.object({
  schemaVersion:z.literal('product-line/1'),id:name,version:z.string().regex(/^\d+\.\d+\.\d+$/),synthetic:z.boolean().optional(),
  connectorPackages:z.array(z.union([name,binding])).max(100),toolAliases:z.record(name,ToolName).default({}),
  skills:z.array(relativePath).max(100).default([]),methods:z.array(relativePath).max(100).default([]),
  configuration:z.string().max(2000).optional(),knowledgeMappings:z.record(z.string(),z.unknown()).default({}),
}).strict();
const Installation=z.object({schemaVersion:z.literal('installed-product-lines/1'),productLines:z.array(z.string().min(1).max(4096)).max(100)}).strict();

// The installation file chooses trusted local manifests, never executable imports.
// Skill files still require the ordinary submission, approval and run gates.
export async function loadProductLines(configFile?:string):Promise<{productLines:(z.infer<typeof ProductLineManifest>&{directory:string})[];toolPackages:ToolPackage[]}>{
  try{
    const file=configFile??fileURLToPath(new URL('./installed-product-lines.json',import.meta.url));
    const installation=Installation.parse(JSON.parse(await readFile(file,'utf8'))),productLines=[],installed=new Map<string,ToolPackage>(),ids=new Set<string>();
    // Shared knowledge tools are available independently of a product line.
    const shared=toolPackages.find(pack=>pack.id==='knowledge')!;installed.set(shared.id,{...shared,productLinePrefixes:{}});
    for(const path of installation.productLines){
      const manifestFile=resolve(dirname(file),path),manifest=ProductLineManifest.parse(JSON.parse(await readFile(manifestFile,'utf8')));
      requireCondition(!ids.has(manifest.id),'INVALID_PAYLOAD','Installed product-line identities must be unique');ids.add(manifest.id);
      const bindings=manifest.connectorPackages.map(item=>typeof item==='string'?{packageId:item}:item),seen=new Set<string>();
      for(const packageId of Object.keys(manifest.toolAliases)){
        requireCondition(toolPackages.some(pack=>pack.id===packageId),'INVALID_PAYLOAD','Product-line alias references an unknown tool package');
        requireCondition(packageId===shared.id||bindings.some(binding=>binding.packageId===packageId),'INVALID_PAYLOAD','Product-line alias requires a declared tool package');
      }
      if(manifest.toolAliases[shared.id]&&!bindings.some(binding=>binding.packageId===shared.id))bindings.push({packageId:shared.id});
      for(const binding of bindings){
        const definition=toolPackages.find(pack=>pack.id===binding.packageId);
        requireCondition(definition&&!seen.has(binding.packageId),'INVALID_PAYLOAD','Product-line tool packages must be known and unique');seen.add(binding.packageId);
        const alias=manifest.toolAliases[binding.packageId];requireCondition(!binding.alias||!alias||binding.alias===alias,'INVALID_PAYLOAD','Product-line tool aliases disagree');
        const prefix=binding.alias??alias??definition.prefix;
        let pack=installed.get(definition.id);if(!pack){pack={...definition,prefix,productLinePrefixes:{}};installed.set(pack.id,pack);}
        pack.productLinePrefixes![manifest.id]=prefix;
      }
      productLines.push({...manifest,directory:dirname(manifestFile)});
    }
    return {productLines,toolPackages:[...installed.values()]};
  }catch(error){
    if(error instanceof ApiError)throw error;
    // Do not echo runtime paths, source configuration or arbitrary manifest bytes.
    throw new ApiError('INVALID_PAYLOAD','Product-line installation configuration is invalid');
  }
}
