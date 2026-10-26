// Opal comparison only; not a producer. Keep dates, object identities and raw AST objects out of the result.
// @ts-ignore -- pinned temporary pack file, deliberately not a repository dependency
import Asciidoctor from './core-3.mjs';
export default function(input:{text:string;include?:boolean}):unknown {
  const begin=performance.now(),a=Asciidoctor();
  const registry=a.Extensions.create();
  if(input.include)registry.includeProcessor(function(this:any){this.handles(()=>true);this.process((_doc:any,reader:any)=>reader.pushInclude('== Included\n\n*demo set* _<n>_','chapter.adoc','chapter.adoc',1,{}));});
  const doc=a.load(input.text,{safe:'secure',sourcemap:true,extension_registry:registry,attributes:{reproducible:''}});
  const nodes=doc.findBy().filter((n:any)=>['section','paragraph','listing','table','ulist','olist'].includes(n.getContext())).map((n:any)=>({
    context:n.getContext(),title:n.getTitle()??null,id:n.getId()??null,level:n.getLevel(),source:n.getSource?.()??null,
    path:n.getSourceLocation()?.getPath()??null,line:n.getSourceLocation()?.getLineNumber()??null,
  }));
  console.log(JSON.stringify({parseAndExtractMs:performance.now()-begin,maxRssKiB:process.resourceUsage().maxRSS}));
  return nodes;
}
