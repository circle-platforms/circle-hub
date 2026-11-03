// The knowledge sync discovery document (RFC 8615): where a client finds the sync API, the OAuth resource to authorize
// for, the local-tools base and which MCP tool and argument serve each team-side operation. Unauthenticated and public:
// it names addresses and capabilities of this Hub, never anything of an account. docs/protocols/knowledge-sync-v1.md.
import type {IncomingMessage,ServerResponse} from 'node:http';
import {z} from 'zod';
import {TOOLS} from '../../contracts/src/tools.ts';
import {KnowledgeSyncDiscovery,PERSONAL_SYNC_CAPABILITIES,KNOWLEDGE_MCP_CAPABILITIES} from '../../contracts/src/sync.ts';
import {sendJson,sendText} from './http.ts';

export const SYNC_DISCOVERY_PATH='/.well-known/knowledge-sync';
/** Route templates stay fixed relative to this base: the idempotency hash of a request includes the template. */
export const SYNC_V1_BASE='/api/sync/v1';
export const LOCAL_TOOLS_BASE='/local-tools';
export const MCP_PATH='/mcp';

/** Each MCP capability names a tool and an input member that the generated tool contract really has. */
function toolUse(tool:string,argument:string,fixed?:Record<string,string|boolean>){
 const definition=TOOLS.find(t=>t.name===tool);
 if(!definition||!(definition.input instanceof z.ZodObject)||!(argument in definition.input.shape))throw new TypeError(`discovery names ${tool}.${argument}, which the tool contract lacks`);
 return {tool,argument,...(fixed?{fixed}:{})};
}
const MCP_CAPABILITIES=Object.freeze({
 [KNOWLEDGE_MCP_CAPABILITIES.entryShare]:toolUse('upload_file','share_entry'),
 [KNOWLEDGE_MCP_CAPABILITIES.memoryShare]:toolUse('upload_file','memory_share'),
 [KNOWLEDGE_MCP_CAPABILITIES.teamMemoryRead]:toolUse('get_nodes','memory',{scope:'team'}),
});

export function knowledgeSyncDiscovery(issuer:string):z.infer<typeof KnowledgeSyncDiscovery>{
 return KnowledgeSyncDiscovery.parse({
  schema:'knowledge-sync-discovery@1',
  issuer,
  sync:{versions:[{version:'v1',base_url:issuer+SYNC_V1_BASE,capabilities:Object.values(PERSONAL_SYNC_CAPABILITIES).sort()}]},
  authorization:{resource:issuer+MCP_PATH,resource_metadata:issuer+'/.well-known/oauth-protected-resource'+MCP_PATH,bearer_methods_supported:['header']},
  local_tools:{base_url:issuer+LOCAL_TOOLS_BASE},
  mcp:{endpoint:issuer+MCP_PATH,capabilities:MCP_CAPABILITIES},
 });
}

export function handleSyncDiscovery(request:IncomingMessage,response:ServerResponse,issuer:string):void{
 request.resume();
 if(request.method!=='GET'&&request.method!=='HEAD')return sendText(response,405,'只接受 GET',{allow:'GET, HEAD'});
 sendJson(response,200,knowledgeSyncDiscovery(issuer),{'cache-control':'max-age=60'});
}
