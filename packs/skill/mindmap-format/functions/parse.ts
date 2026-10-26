// Sandboxed wire boundary: source bytes in, format-neutral document data out.
import {kityminderParser} from './kityminder.ts';
import {ParseError,ParseLimitError,QUOTATION_UNITS,type ParseOptions} from './format.ts';
import {selectorSegment,MAX_SELECTOR_LENGTH,MAX_SEGMENTS} from './selectors.ts';
export default function parse(input:{bytes:string;options?:ParseOptions}) {
  try {
    const document=kityminderParser.parse(Buffer.from(input.bytes,'base64'),input.options);
    const selectors=document.listSelectors(''),properties=document.listSelectors('',{properties:true});
    const aliases=new Set(properties),paths:string[]=[];
    for(const [index,node]of document.model.nodes.entries()){
      const path=node.parent===null?'i':paths[node.parent]+'/'+document.model.nodes[node.parent].children.indexOf(index);
      paths.push(path);if(path.length>MAX_SELECTOR_LENGTH||path.split('/').length>MAX_SEGMENTS)continue;
      aliases.add(path);for(const key of Object.keys(node.data)){const field=path+'/'+selectorSegment('@'+key);if(field.length<=MAX_SELECTOR_LENGTH)aliases.add(field);}
    }
    const quotation=document as typeof document&{[QUOTATION_UNITS]:(options:{properties:boolean})=>unknown};
    return {document:{parser:document.parser,model:document.model,summary:document.summary(),selectors,properties,fragments:[...aliases].flatMap(lookup=>{const fragment=document.locate(lookup);return fragment?[{lookup,...fragment}]:[];}),quotation:{plain:quotation[QUOTATION_UNITS]({properties:false}),properties:quotation[QUOTATION_UNITS]({properties:true})}}};
  }catch(error){
    if(!(error instanceof ParseError))throw error;
    return {error:{name:error.name,message:error.message,offset:error.offset,fix:error.fix,...(error instanceof ParseLimitError?{limit:error.limit,max:error.max}:{})}};
  }
}
