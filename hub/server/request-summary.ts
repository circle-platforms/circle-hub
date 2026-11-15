// A request-structure receipt, not a copy of arguments or proof that a declared reference exists.
import tools from '../../contracts/generated/tools.json' with {type:'json'};
import {RunId} from '../../contracts/src/common.ts';
import {parseReference} from '../refs/api.ts';
import {sha256Hex} from '../records/api.ts';

const MAX_BYTES=1024;
const record=(value:unknown):value is Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const kind=(value:unknown)=>value===null?'null':Array.isArray(value)?'array':typeof value;

/** Only declared top-level field names, shape/counts and typed reference metadata; no free text, uploads or unknown keys. */
export function requestSummary(tool:string,args:unknown):string|null {
  const declaration=tools.find(value=>value.name===tool);
  if(!declaration)return null;
  const schema=declaration.inputSchema as {properties?:Record<string,unknown>};
  const known=new Set(Object.keys(schema.properties??{}));
  const summary:Record<string,unknown>={schema:'mcp-request-summary@1',argument_shape:kind(args)};
  if(record(args)){
    const keys=Object.keys(args),present=keys.filter(key=>known.has(key)).sort();
    summary.fields=present;
    summary.unknown_fields=keys.length-present.length;
    const shapes:Record<string,unknown>={};
    for(const key of present){const value=args[key];shapes[key]=Array.isArray(value)?{type:'array',count:value.length}:record(value)?{type:'object',count:Object.keys(value).length}:{type:kind(value)};}
    summary.shapes=shapes;
    if(known.has('run')){summary.run_supplied=Object.hasOwn(args,'run');if(RunId.safeParse(args.run).success)summary.declared_run=args.run;}
    const referenceField=known.has('reference')?'reference':known.has('text')?'text':null;
    if(referenceField!==null&&typeof args[referenceField]==='string'){
      try{
        const reference=parseReference(args[referenceField] as string);
        const declared:Record<string,unknown>={scheme:reference.scheme};
        if(reference.scheme==='src'){
          declared.source=reference.sha256;
          if(reference.parser!==undefined){
            if(reference.parser.length<=100)declared.parser=reference.parser;
            else declared.parser_omitted=true;
          }
          if(reference.selector!==undefined){declared.selector_digest=sha256Hex(reference.selector);declared.selector_bytes=Buffer.byteLength(reference.selector,'utf8');}
          if(reference.range!==undefined)declared.range=reference.range;
        }else if(reference.scheme==='tree'){declared.root=reference.root;declared.path_digest=sha256Hex(reference.path);}
        else if(reference.scheme==='entry')declared.entry=reference.entry;
        else if(reference.scheme==='rec'){declared.record=reference.record;if(reference.pointer!==undefined)declared.pointer_digest=sha256Hex(reference.pointer);}
        summary.declared_reference=declared;
      }catch{/* Invalid references and free-text queries are represented by shape only. */}
    }
  }
  const text=JSON.stringify(summary);
  return Buffer.byteLength(text,'utf8')<=MAX_BYTES?text:null;
}
