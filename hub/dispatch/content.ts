// Scan the exact admitted bytes; a container's semantic model alone cannot cover its opaque members.
import {createDefaultRegistry,recognize,readContainerMembers,xmlParser} from '../refs/api.ts';
import {scanForCredentials,canonicalBytes,sha256Hex} from '../records/api.ts';
const registry=createDefaultRegistry();
function clean(bytes:Uint8Array):boolean {const scan=scanForCredentials(bytes);return scan.inspected&&scan.clean&&!scan.truncated;}
export function verifiedContent(bytes:Uint8Array,sha256:string,mediaType:string):boolean {
 if(sha256Hex(bytes)!==sha256)return false;
 const original=scanForCredentials(bytes);if(original.findings.length||original.truncated)return false;
 if(original.inspected)return original.clean;
 try {
   const parsed=recognize(registry,bytes,mediaType);if(!parsed||!clean(canonicalBytes(parsed.document.model)))return false;
   const members=readContainerMembers(bytes);if(!members.size)return false;
   for(const [name,value] of members){
     if(!clean(Buffer.from(name))||!clean(value))return false;
     if(/\.(?:xml|rels)$/i.test(name)&&!clean(canonicalBytes(xmlParser.parse(value,{mediaType:'application/xml'}).model)))return false;
   }
   return sha256Hex(bytes)===sha256;
 }catch{return false;}
}
