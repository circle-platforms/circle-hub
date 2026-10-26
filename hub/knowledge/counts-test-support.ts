// Synthetic counting fixture: duplicate origins, duplicate node mounts and one content present both placed and unplaced.
import type { TemporaryPostgres } from '../testing/postgres.ts';
import { makeWorld } from './test-support.ts';
const BUILD = {name:'Rel_DEMO_10_6_1_1',base:'Rel_DEMO_10_6_1_1',family:'DEMO',line:'10.6.1',platform:null,built_at:null,released_at:'2026-01-01T00:00:00.000Z',sources:{documents:['site:document:a','site:document:b']}};
const PRODUCER = `export default function(input){
 const row=(statement,path,source,commands)=>({kind:'case',path,statement,data:{document:'shared',line:'10.6.1',module:'Synthetic',has_expected:true,vague_expected:false,negative:false,commands,...(input.params.pageKeys?{page_key:('Synthetic '+statement+' ').repeat(60)}:{})},fragments:[{slot:'documents',source:source.sha256,parser:'json@1',selector:'p'}],applicability:null});
 return {entries:input.lists.documents.flatMap(source=>{
   const unplaced=[row('B',null,source,[]),row('B',null,source,[]),row('C',null,source,[]),row('D',null,source,[])];
   if(input.params.scope)return [row('B',input.params.scopePlacesOverlap?'/synthetic/scope-b':null,source,[]),row('Scope only',null,source,[])];
   if(input.params.onlyUnplaced)return unplaced;
   const commands=input.params.commandlessOverlap?[]:['/synthetic/overlap'];
   return [row('A','/synthetic/a',source,['/synthetic/a']),row('A','/synthetic/b',source,['/synthetic/a']),...unplaced,row('E',null,source,commands),row('E','/synthetic/overlap',source,commands)];
 }),warnings:[]};
}`;
export async function countWorld(postgres:TemporaryPostgres,options:{parts?:boolean;scope?:boolean;scopePlacesOverlap?:boolean;onlyUnplaced?:boolean;commandlessOverlap?:boolean;maxViewBytes?:number;pageKeys?:boolean}={}){
 const producer={id:'cases',title:'合成用例',function:{module:'functions/counts.ts'},inputs:{documents:{source:'documents',many:true,batch:1}},params:{scope:false,pageKeys:options.pageKeys===true,onlyUnplaced:options.onlyUnplaced===true,commandlessOverlap:options.commandlessOverlap===true}};
 const w=await makeWorld(postgres,{knowledge:{limits:{inlineRows:options.parts?1:1000,...(options.maxViewBytes?{maxViewBytes:options.maxViewBytes}:{})}},pack:{id:'demo-counts',names:['DEMO'],functions:{'plan.ts':`export default()=>({fetch:[],builds:[${JSON.stringify(BUILD)}],${options.scope?"scope:{documents:['site:document:scope']},":''}done:true});`,'counts.ts':PRODUCER},declaration:{catalogs:[],producers:[producer,...(options.scope?[{...producer,id:'scope_cases',unversioned:true,params:{...producer.params,scope:true,scopePlacesOverlap:options.scopePlacesOverlap===true}}]:[])]}}});
 w.external.set('site:page:index',{bytes:'{}',mediaType:'application/json'});
 for(const name of ['a','b','scope'])w.external.set('site:document:'+name,{bytes:JSON.stringify({origin:name}),mediaType:'application/json'});
 return w;
}
