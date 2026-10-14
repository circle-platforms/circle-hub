import {importFrom,type HubSkill,type VirtualFiles} from '../../harness-adapters/index.ts';
import {SafeRelativePath,requireCondition,sha256} from '../../contracts/src/index.ts';
export function deriveCircleSkill(manifest:any,files:{path:string;bytes:Buffer;sha256:string}[]):HubSkill{
 const prefix=`.claude/skills/${manifest.id}/`,virtual:VirtualFiles=Object.fromEntries(files.map(file=>[prefix+file.path,file.bytes]));
 const derived=importFrom('claude-code',virtual).manifests.find(item=>item.kind==='hub-skill/1') as HubSkill|undefined;
 return {kind:'hub-skill/1',name:derived?.name??manifest.id,description:derived?.description??'',version:manifest.version,entry:'SKILL.md',tools:manifest.tools??[],inputs:Object.keys(manifest.inputs?.properties??manifest.inputs??{}).sort(),outputs:manifest.outputs??[],triggers:manifest.triggers??[],...(typeof manifest.model==='string'?{model:manifest.model}:{}),sourceHarness:'circle',knownCompatible:[],files:files.map(file=>({path:file.path,sha256:file.sha256})),harnessSpecific:{...(derived?.harnessSpecific??{}),sourceRoot:'.circle/skills/'+manifest.id}};
}
export function exportCircleSkill(manifest:HubSkill,originals:VirtualFiles){
 requireCondition(/^[a-z][a-z0-9-]{0,99}$/.test(manifest.name),'INVALID_PAYLOAD','Skill name cannot escape its harness directory');const files:VirtualFiles={},entry=typeof manifest.harnessSpecific.path==='string'?manifest.harnessSpecific.path:manifest.entry,root=entry.endsWith('SKILL.md')?entry.slice(0,-'SKILL.md'.length):'';
 for(const file of manifest.files){SafeRelativePath.parse(file.path);const raw=originals[file.path];requireCondition(raw!==undefined,'SOURCE_ABSENT','A frozen skill original is unavailable');const bytes=typeof raw==='string'?Buffer.from(raw):Buffer.from(raw);requireCondition(sha256(bytes)===file.sha256,'SOURCE_HASH_MISMATCH','Frozen skill bytes changed');const path=root&&file.path.startsWith(root)?file.path.slice(root.length):file.path;SafeRelativePath.parse(path);files[`.circle/skills/${manifest.name}/${path}`]=bytes;}
 requireCondition(Object.hasOwn(files,`.circle/skills/${manifest.name}/SKILL.md`),'INVALID_PAYLOAD','Skill projection needs its original entry');return {files,warnings:[]};
}
