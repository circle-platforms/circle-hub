import {canonicalHash,requireCondition} from '../../contracts/src/index.ts';
import type {ProductObservation} from '../../knowledge/src/product-records.ts';
import {commandParam} from '../../methods/src/command-tree.ts';
import {BuildSite} from './build-site.ts';
import {HttpSource,type RawReturn} from './readonly-sdk.ts';
import {mirrorBug} from './query-mirror.ts';
import type {ConnectorProfile} from './tool-packages.ts';

export async function projectSource(packageId:string,originals:RawReturn[],profile:ConnectorProfile):Promise<ProductObservation[]>{
  const observations:ProductObservation[]=[];
  const add=(raw:RawReturn,subject:string,kind:string,name:string,predicate:string,value:unknown,conditions:Record<string,unknown>={},attributes:Record<string,unknown>={})=>observations.push({sourcePath:raw.path,entity:{subject,kind,name,attributes},predicate,value,conditions});
  if(packageId==='documents'){
    for(const raw of originals)if(!raw.path.endsWith('/')){
      const text=raw.bytes.toString('utf8'),plain=/\.(txt|md|html?)$/i.test(raw.path)&&Buffer.from(text).equals(raw.bytes)&&raw.bytes.length<=1_000_000;
      add(raw,raw.path,'document',raw.path,plain?'document-text':'document-sha256',plain?text:raw.sha256,{}, {sha256:raw.sha256,conversion:plain?'literal-utf8':'not-run'});
    }
  }else if(packageId==='build-site'){
    // Re-extract from the retained originals. This reader cannot reach the network.
    const source=new HttpSource(profile.origin);source.read=async(path)=>{const raw=originals.find(raw=>raw.path===source.path(path));requireCondition(raw,'EVIDENCE_INSUFFICIENT','Publication projection needs its retained page');return raw;};
    const site=new BuildSite(source),index=await site.index(profile.index??'/');
    for(const line of index.lines){const raw=originals.find(raw=>raw.path===line.path);if(!raw)continue;
      for(const build of (await site.listing(line.path,{versionLine:line.versionLine})).result){
        add(raw,`build:${build.name}`,'build',build.name,'build-record',{name:build.name,formal:build.formal,releasedOn:build.releasedOn,buildTime:build.buildTime,platform:build.platform,imageSha256:build.imageSha256},{versionLine:build.versionLine});
        const xml=originals.find(raw=>raw.path===build.files.commands);if(xml)for(const command of await site.commandsFrom(xml.bytes)){
          const parameters=commandParam([command],command.name).parameters;
          add(xml,`command:${build.name}:${command.name}`,'command',command.name,'command-definition',{head:command.name,parameters},{build:build.name,versionLine:build.versionLine,platform:build.platform});
        }
        const fixed=originals.find(raw=>raw.path===build.files.fixed);if(fixed){const ids=await site.fixed(build);add(fixed,`fixed:${build.name}`,'repair-list',build.name,'fixed-identifiers',ids.result,{build:build.name,formal:build.formal,releasedOn:build.releasedOn,versionLine:build.versionLine});}
      }
    }
  }else if(packageId==='query-mirror'){
    for(const raw of originals){const envelope=JSON.parse(raw.bytes.toString()),items=envelope[profile.payloadField??'data'];requireCondition(Number(envelope.code)===1000&&Array.isArray(items),'INVALID_PAYLOAD','Mirror projection needs a successful array');
      for(const row of items){const bug=mirrorBug(row);add(raw,`issue:${bug.id}`,'issue',bug.title||bug.id,'mirror-observation',bug,{product:bug.product,projectionKind:raw.path.includes('/detail/')?'detail':'list'});}
    }
  }else if(packageId==='environment-view'){
    for(const raw of originals){const value=JSON.parse(raw.bytes.toString());add(raw,`environment:${raw.path}:${raw.requestKey??canonicalHash(value.result)}`,'environment-observation',raw.path,'environment-read',value.result,{revision:value.revision});}
  }
  return observations;
}
