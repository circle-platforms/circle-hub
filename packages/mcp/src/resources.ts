import {RegistryPageQuery,type AuthContext} from '../../contracts/src/index.ts';
import {KnowledgeRegistryPages} from '../../knowledge/src/registry-pages.ts';
export async function resourceList(services:any,ctx:AuthContext,cursor?:string,filters:Record<string,unknown>={}){
 const query=RegistryPageQuery.parse({limit:100,sort:'age',order:'desc',...filters,view:'page',cursor}),page=await new KnowledgeRegistryPages(services.knowledge,services.graph).resources(ctx,query);
 return {resources:page.items.map(item=>({uri:item.uri,name:item.id,mimeType:item.mediaType,_meta:{sha256:item.sha256}})),...(page.cursor?{nextCursor:page.cursor}:{}),_meta:{'hub/total':page.total}};
}
