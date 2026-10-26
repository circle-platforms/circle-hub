// Synthetic shape examples only; the admission pipeline must separately verify bytes, identities and permissions.
const H='a'.repeat(64),user='usr_'+'0'.repeat(26),run='run_'+'0'.repeat(26),at='2026-10-25T00:00:00.000Z';
const quote={identity:{source_sha256:H,parser:'json@1',path:'p/directory',span:{unit:'byte',offset:0,length:4}},text:'10.8'};
export function feedingExamples():Record<string,unknown[]>{
 const common={object:H,product:'synthetic',root:H,path:'/commands/synthetic/show'};
 const kase={...common,schema:'fed-case@1',source:{system:'agile',document:'synthetic-document',element:'case-1',revision:'r1',bytes:H},autoid:null,priority:2,resources:['functional'],steps:[{text:'synthetic show'}],expects:[{text:'合成逐字期望'}],commands:[],unparsed_steps:1,document_lines:['10.8']};
 const defect={...common,schema:'fed-defect@1',source:{system:'plm',ticket:'SYN-1',revision:'batch-1',bytes:H},id:'SYN-1',status:null,affected_lines:[],resolved_lines:[],fix_builds:[]};
 const spec={...common,schema:'fed-spec@1',source:{system:'plm-requirements',ticket:'SYN-2',bytes:H},id:'SYN-2',title:'合成规格',linked_builds:[],document_lines:[]};
 const build={...common,schema:'fed-build@1',source:{system:'build-site',page:'synthetic.html',bytes:H},name:'Rel_FAMX_10_8_9_42_main_zx-u',family:'FAMX',line:'10.8.9',platform:'zx-u',built_at:at,released_at:null,tree:H,fixed_bugs:[]};
 const note={...common,schema:'fed-note@1',source:{system:'upload',bytes:H},by:user,run:null,at};
 const binding={schema:'version-binding@1',object:H,product:'synthetic',line:'10.8',basis:'source_structure',grounds:{quote,grammar:'synthetic-directory@1'},state:'bound',candidates:[]};
 const usage={schema:'usage@1',object:H,run,line:'10.9',at};const offset={schema:'feeding-offset@1',run,root:H,offset:7};const retraction={schema:'retraction@1',objects:[H],by:user,at,reason:'合成撤回'};
 return {'feeding-quote@1':[quote,{reference:'src:'+H+'/json@1/p',text:'10.8'}],'fed-case@1':[kase],'fed-defect@1':[defect],'fed-spec@1':[spec,{...spec,source:{system:'manual-store',path:'synthetic/spec.md',bytes:H}}],'fed-build@1':[build],'fed-note@1':[note],'version-binding@1':[binding,{...binding,basis:'declared',grounds:{by:user,run}},{...binding,line:null,state:'undeclared',missing:'缺目录版本层',next_action:'维护者补目录后重读'},{...binding,line:null,state:'conflict',candidates:['10.8','10.9']}],'usage@1':[usage],'feeding-offset@1':[offset],'retraction@1':[retraction,{schema:'retraction@1',runs:[run],by:user,at,reason:'合成撤回'},{schema:'retraction@1',entries:[H],by:user,at,reason:'合成撤回'}],'knowledge-structure@1':[kase,defect,spec,build,note,binding,usage,offset,retraction]};
}
