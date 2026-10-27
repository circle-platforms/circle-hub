// Scan the exact admitted bytes; a container's semantic model alone cannot cover its opaque members.
import {createDefaultRegistry,recognize,readContainerMembers,type ParserRegistry} from '../refs/api.ts';
import {scanForCredentials,canonicalBytes,sha256Hex} from '../records/api.ts';
const registry=createDefaultRegistry();
function clean(bytes:Uint8Array):boolean {const scan=scanForCredentials(bytes);return scan.inspected&&scan.clean&&!scan.truncated;}
function decodeXml(s:string):string {return s.replace(/&(?:#([0-9]+)|#x([0-9a-fA-F]+)|(amp|apos|quot|lt|gt));/gi,(_,dec,hex,named)=>{if(dec)return String.fromCodePoint(parseInt(dec,10));if(hex)return String.fromCodePoint(parseInt(hex,16));const n=named.toLowerCase();return n==='amp'?'&':n==='apos'?"'":n==='quot'?'"':n==='lt'?'<':'>';});}
export function verifiedContent(bytes:Uint8Array,sha256:string,mediaType:string,parsers?:ParserRegistry):boolean {
 if(sha256Hex(bytes)!==sha256)return false;
 const original=scanForCredentials(bytes);if(original.findings.length||original.truncated)return false;
 if(original.inspected)return original.clean;
 try {
   const reg=parsers??registry;
   const parsed=recognize(reg,bytes,mediaType);if(parsed&&!clean(canonicalBytes(parsed.document.model)))return false;
   const members=readContainerMembers(bytes);if(!members.size)return false;
   const xml=reg.get('xml@1')??reg.list().find(p=>p.id==='xml');
   const html=reg.get('html@1')??reg.list().find(p=>p.id==='html');
   for(const [name,value] of members){
     if(!clean(Buffer.from(name))||!clean(value))return false;
     if(/\.(?:xml|rels)$/i.test(name)){
       if(xml){if(!clean(canonicalBytes(xml.parse(value,{mediaType:'application/xml'}).model)))return false;}
       else if(html){if(!clean(canonicalBytes(html.parse(value,{mediaType:'text/html'}).model)))return false;}
       else if(!clean(Buffer.from(decodeXml(Buffer.from(value).toString('utf8')))))return false;
     }
   }
   return sha256Hex(bytes)===sha256;
 }catch{return false;}
}
