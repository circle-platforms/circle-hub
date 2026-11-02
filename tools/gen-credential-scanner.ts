// Generate portable standard entity data and the standalone scanner from the Hub's reviewed implementation.
import {createRequire} from 'node:module';
import {readFile,writeFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {parseFragment} from 'parse5';

const root=new URL('../',import.meta.url);
const read=(path:string)=>readFile(new URL(path,root),'utf8');
const portableHeader=`import {createHash} from 'node:crypto';
export interface CredentialFinding {detector:string;offset:number;line:number;column:number}
export interface CredentialScan {scanner:string;inspected:boolean;clean:boolean;findings:CredentialFinding[];truncated:boolean}
function canonicalize(value:unknown):string{
 if(value===null||typeof value!=='object')return JSON.stringify(value);
 if(Array.isArray(value))return '['+value.map(canonicalize).join(',')+']';
 const row=value as Record<string,unknown>;return '{'+Object.keys(row).sort().filter(key=>row[key]!==undefined).map(key=>JSON.stringify(key)+':'+canonicalize(row[key])).join(',')+'}';
}
function digestOf(value:unknown):string{return createHash('sha256').update(canonicalize(value)).digest('hex');}
`;
export async function credentialScannerFiles():Promise<Map<string,string>>{
 const scanner=(await read('hub/records/scan.ts')).replace(/^import type \{ CredentialFinding, CredentialScan \} from '\.\/api\.ts';\n/m,'').replace(/^import \{ digestOf \} from '\.\/digest\.ts';\n/m,'');
 return new Map([['tools/operation-capture/lib/credentials.ts',portableHeader+scanner],['tools/operation-capture/lib/html-entity.ts',await read('hub/records/html-entity.ts')],['tools/operation-capture/lib/html-entities.generated.ts',await read('hub/records/html-entities.generated.ts')]]);
}
export async function htmlEntitiesSource():Promise<string>{
 // Resolve the existing declared parser's decoder for generation only. No decoder dependency enters a portable skill.
 const require=createRequire(import.meta.url),decoderPath=createRequire(require.resolve('parse5')).resolve('entities/decode');
 const {EntityDecoder,DecodingMode,htmlDecodeTree}=await import(pathToFileURL(decoderPath).href);
 const strict=(value:string)=>{const decoder=new EntityDecoder(htmlDecodeTree,()=>{});decoder.startEntity(DecodingMode.Strict);return decoder.write(value,0);};
 const decoded=(value:string)=>{const node=parseFragment(value).childNodes[0];return node&&'value'in node?node.value:value;};
 const alphabet='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',pending=[...alphabet],names:Record<string,string>={};let count=0;
 while(pending.length){
  const name=pending.pop()!;if(strict(name)!==-1)continue;
  if(strict(name+';')===name.length+2){const key='&'+name;names[key+';']=decoded(key+';');const legacy=decoded(key);if(legacy!==key)names[key]=legacy;count++;}
  if(name.length<32)for(const char of alphabet)pending.push(name+char);
 }
 if(count<2000)throw new Error('HTML reference generation did not enumerate the complete standard table');
 const numeric:Record<number,string>={};for(let point=0;point<160;point++){const value=decoded('&#'+point+';');if(value!==String.fromCodePoint(point))numeric[point]=value;}
 const license=await readFile(new URL('../LICENSE',pathToFileURL(decoderPath)),'utf8');
 const sorted=Object.fromEntries(Object.entries(names).sort(([a],[b])=>a<b?-1:a>b?1:0));
 const literal=(value:unknown)=>JSON.stringify(value,null,1).replace(/[\u0080-\uffff]/g,char=>'\\u'+char.charCodeAt(0).toString(16).padStart(4,'0'));
 return '// Generated standard HTML character-reference data through the declared parse5 dependency.\n/*\n'+license+'\n*/\nexport const HTML_NAMED_REFERENCES:Readonly<Record<string,string>>=Object.freeze('+literal(sorted)+');\nexport const HTML_NUMERIC_REPLACEMENTS:Readonly<Record<number,string>>=Object.freeze('+literal(numeric)+');\n';
}
if(import.meta.main){
 const source=await htmlEntitiesSource(),path='hub/records/html-entities.generated.ts';
 if(process.argv.includes('--check')){if(source!==await read(path))throw new Error('Generated HTML reference data differs');console.log('Credential HTML reference data matches');}
 else{await writeFile(new URL(path,root),source);console.log('Generated credential HTML reference data');}
}
