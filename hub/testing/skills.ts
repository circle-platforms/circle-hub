// Explicit installation fixture for package integration tests; production never auto-installs repository skills.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import type {RecordsKit,Principal} from '../records/api.ts';
import {temporaryDirectory,writePack,type PackRegistry} from '../runs/api.ts';
import {createSkillParserRegistry,bindLegacyParser} from '../refs/api.ts';

export async function installMindmapFixture(registry:PackRegistry,records:RecordsKit,admin:Principal){
 const temp=await temporaryDirectory('hub-skill-fixture-');
 try{
  const root=fileURLToPath(new URL('../../packs/skill/mindmap-format/',import.meta.url));
  const manifest=JSON.parse(await readFile(join(root,'pack.json'),'utf8'));
  const files:Record<string,Uint8Array>={};for(const row of manifest.files)files[row.path]=await readFile(join(root,row.path));
  const staged=await writePack(join(temp.path,'mindmap-format'),{...manifest,files});
  await records.authorizations.grantPublishRight(admin,admin.id,'显式合成技能安装夹具');
  const outcome=await registry.publish(admin,staged.dir);if(!outcome.ok)throw new Error('synthetic skill publication refused: '+JSON.stringify(outcome.problems));
  await registry.install(admin,manifest.id+'@'+manifest.version);
  if(!(await records.store.find({kind:'action',key:'refs.legacy-parser',value:'kityminder@1',limit:1})).items.length)await bindLegacyParser({registry,records},admin,'kityminder@1',manifest.id+'@'+manifest.version);
  const parsers=createSkillParserRegistry({registry,records,sandbox:{requireOsIsolation:false}});await parsers.refresh!();return parsers;
 }finally{await temp.remove();}
}

export async function installWorkbookFixture(registry:PackRegistry,records:RecordsKit,admin:Principal){
 const temp=await temporaryDirectory('hub-workbook-fixture-');
 try{
  const root=fileURLToPath(new URL('../../packs/skill/workbook-format/',import.meta.url));
  const manifest=JSON.parse(await readFile(join(root,'pack.json'),'utf8'));
  const files:Record<string,Uint8Array>={};for(const row of manifest.files)files[row.path]=await readFile(join(root,row.path));
  const staged=await writePack(join(temp.path,'workbook-format'),{...manifest,files});
  await records.authorizations.grantPublishRight(admin,admin.id,'显式合成技能安装夹具');
  const outcome=await registry.publish(admin,staged.dir);if(!outcome.ok)throw new Error('synthetic skill publication refused: '+JSON.stringify(outcome.problems));
  await registry.install(admin,manifest.id+'@'+manifest.version);
  if(!(await records.store.find({kind:'action',key:'refs.legacy-parser',value:'xlsx@1',limit:1})).items.length)await bindLegacyParser({registry,records},admin,'xlsx@1',manifest.id+'@'+manifest.version);
  const parsers=createSkillParserRegistry({registry,records,sandbox:{requireOsIsolation:false}});await parsers.refresh!();return parsers;
 }finally{await temp.remove();}
}

export async function installXmlFixture(registry:PackRegistry,records:RecordsKit,admin:Principal){
 const temp=await temporaryDirectory('hub-xml-fixture-');
 try{
  const root=fileURLToPath(new URL('../../packs/skill/xml-format/',import.meta.url));
  const manifest=JSON.parse(await readFile(join(root,'pack.json'),'utf8'));
  const files:Record<string,Uint8Array>={};for(const row of manifest.files)files[row.path]=await readFile(join(root,row.path));
  const staged=await writePack(join(temp.path,'xml-format'),{...manifest,files});
  await records.authorizations.grantPublishRight(admin,admin.id,'显式合成技能安装夹具');
  const outcome=await registry.publish(admin,staged.dir);if(!outcome.ok)throw new Error('synthetic skill publication refused: '+JSON.stringify(outcome.problems));
  await registry.install(admin,manifest.id+'@'+manifest.version);
  if(!(await records.store.find({kind:'action',key:'refs.legacy-parser',value:'xml@1',limit:1})).items.length)await bindLegacyParser({registry,records},admin,'xml@1',manifest.id+'@'+manifest.version);
  const parsers=createSkillParserRegistry({registry,records,sandbox:{requireOsIsolation:false}});await parsers.refresh!();return parsers;
 }finally{await temp.remove();}
}

export async function installHtmlFixture(registry:PackRegistry,records:RecordsKit,admin:Principal){
 const temp=await temporaryDirectory('hub-html-fixture-');
 try{
  const root=fileURLToPath(new URL('../../packs/skill/html-format/',import.meta.url));
  const manifest=JSON.parse(await readFile(join(root,'pack.json'),'utf8'));
  const files:Record<string,Uint8Array>={};for(const row of manifest.files)files[row.path]=await readFile(join(root,row.path));
  const staged=await writePack(join(temp.path,'html-format'),{...manifest,files});
  await records.authorizations.grantPublishRight(admin,admin.id,'显式合成技能安装夹具');
  const outcome=await registry.publish(admin,staged.dir);if(!outcome.ok)throw new Error('synthetic skill publication refused: '+JSON.stringify(outcome.problems));
  await registry.install(admin,manifest.id+'@'+manifest.version);
  if(!(await records.store.find({kind:'action',key:'refs.legacy-parser',value:'html@1',limit:1})).items.length)await bindLegacyParser({registry,records},admin,'html@1',manifest.id+'@'+manifest.version);
  const parsers=createSkillParserRegistry({registry,records,sandbox:{requireOsIsolation:false}});await parsers.refresh!();return parsers;
 }finally{await temp.remove();}
}
