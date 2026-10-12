import {createServer, type IncomingMessage} from 'node:http';
import {randomBytes} from 'node:crypto';

// Every byte in this service is synthetic. Authentication is generated per run.
export async function createSyntheticSources() {
  const secret=randomBytes(24).toString('hex');
  const requests:{method:string;path:string;authorization?:string;body:any}[]=[];
  const state={revision:1,mode:'ready',fixed:['401'],command:'feature.enable',changedBuild:'',encoding:'UTF-8',expandedCommands:false,manualText:'',headCount:36,mirrorIds:[51],dynamicDocuments:false,documentReads:0,badCommandIndex:-1};
  const xml=(command:string,name:string)=>{
    const first=state.expandedCommands&&name.includes('_109')?'':`<item name="${command}"><arguments><arg position="1" name="mode" type="STRING" optional="true"/></arguments><results><result name="status"/></results></item>`;
    const expanded=state.expandedCommands?[
      '<item name="service create port"><arguments><arg position="1" type="U16" min="1" max="65535" help="Synthetic port"/></arguments></item>',
      '<item name="service create address"><arguments><arg position="1" type="IPADDR"/></arguments></item>',
      '<item name="service create name"><arguments><arg position="1" type="STRING"/></arguments></item>',
      '<item name="service create mode"><arguments><arg position="1" type="STRING" enum="active|standby"/></arguments></item>',
      ...Array.from({length:state.headCount},(_,i)=>`<item name="${i===state.badCommandIndex?'x'.repeat(600):`service inspect ${i}`}"><arguments><arg position="1" type="STRING" optional="true"/></arguments></item>`),
    ].join(''):'';
    return `<commands><scope name="configuration"><menu name="service">${first}${expanded}</menu></scope></commands>`;
  };
  const builds=[
    {name:'Rel_PHOTON_10_5_0_101',released:'2026-01-02',bugs:['401','402']},
    {name:'Rel_PHOTON_10_5_0_109',released:'2026-02-03',bugs:['401']},
    {name:'Beta_PHOTON_10_5_0_120',released:'2026-03-04',bugs:['499']},
  ];
  async function body(req:IncomingMessage){const chunks:Buffer[]=[];for await(const part of req)chunks.push(part);return chunks.length?JSON.parse(Buffer.concat(chunks).toString()):null;}
  const server=createServer(async(req,res)=>{
    const url=new URL(req.url!,'http://127.0.0.1'),payload=await body(req);
    requests.push({method:req.method!,path:url.pathname+url.search,authorization:req.headers.authorization,body:payload});
    if(url.pathname.startsWith('/plmquery/')&&req.headers.authorization!==secret){res.end(JSON.stringify({code:401,msg:'Token不存在.'}));return;}
    if(url.pathname.startsWith('/failure/')){
      if(state.mode==='expired'){res.writeHead(401);res.end();return;}
      if(state.mode==='forbidden'){res.writeHead(403);res.end();return;}
      if(state.mode==='absent'){res.writeHead(404);res.end();return;}
      if(state.mode==='unreachable'){res.writeHead(503);res.end();return;}
      res.end('recovered');return;
    }
    if(url.pathname==='/dav/'&&req.method==='PROPFIND'){
      res.writeHead(207,{'content-type':'application/xml'});
      res.end(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/manual.txt</d:href><d:propstat><d:prop><d:getetag>"r${state.revision}"</d:getetag><d:getcontentlength>${Buffer.byteLength(state.manualText||`Synthetic manual ${state.revision}`)}</d:getcontentlength><d:getlastmodified>Thu, 01 Jan 2026 00:00:00 GMT</d:getlastmodified><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`);return;
    }
    if(url.pathname==='/dav/manual.txt'){state.documentReads++;res.setHeader('etag',`"r${state.revision}"`);res.end(state.dynamicDocuments?`Synthetic dynamic observation ${state.documentReads}`:state.manualText||`Synthetic manual ${state.revision}`);return;}
    if(url.pathname==='/builds/'){res.end('<html><a href="PHOTON_10_5.html">PHOTON 10.5 builds</a><a href="kvm.html">kvm builds</a></html>');return;}
    if(url.pathname==='/builds/PHOTON_10_5.html'){
      const rows=[...builds,{name:'Rel_PHOTON_10_5_0_150',released:'',bugs:[]}];
      res.end(`<html><h2> PHOTON10.x Builds</h2>${rows.map(b=>{
        const imageHash=(b.name===state.changedBuild?'b':'a').repeat(64);
        return `<font color=red>${b.name} (build on  2026-01-01 01:00:00 ): ${b.released?`Released on ${b.released}`:''} </font> </br> <BLOCKQUOTE>
          <A href="ArrayOS-${b.name}.array">${url.origin}/builds/ArrayOS-${b.name}.array</A> ( 999M , SHA256: ${imageHash} )<BR>
          <A href="CA-SNMP-MIB-${b.name}.txt">${url.origin}/builds/CA-SNMP-MIB-${b.name}.txt</A><BR>
          <A href="CA-SNMP-MIB_cn-${b.name}.txt">${url.origin}/builds/CA-SNMP-MIB_cn-${b.name}.txt</A><BR>
          <A href="command_tree-${b.name}.xml">${url.origin}/builds/command_tree-${b.name}.xml</A><BR>
          <A href="Bugs_Fixed_with_${b.name}.html">${url.origin}/builds/Bugs_Fixed_with_${b.name}.html</A><BR></BLOCKQUOTE><hr>`;
      }).join('')}</html>`);return;
    }
    const fixed=/\/Bugs_Fixed_with_(.+)\.html$/.exec(url.pathname);
    if(fixed){const b=builds.find(b=>b.name===fixed[1]);res.end(`<table>${(b?.bugs??[]).map(id=>`<tr><td><a href="/legacy/show_bug.cgi?id=${id}">${id}</a></td></tr>`).join('')}</table>`);return;}
    if(url.pathname.includes('/command_tree-')){
      const content=`<?xml version="1.0" encoding="${state.encoding}"?>${xml(state.command,url.pathname)}`;
      res.end(Buffer.from(content,state.encoding==='ISO-8859-1'?'latin1':'utf8'));return;
    }
    if(url.pathname==='/plmquery/product/all/'){res.end(JSON.stringify({code:1000,data:[{id:7,name:'Synthetic product'}]}));return;}
    if(url.pathname==='/plmquery/bug/'){
      res.end(JSON.stringify({code:1000,data:state.mirrorIds.map(id=>({id,title:'Synthetic defect',severity:2,pri:3,status:'resolved',product:7,assignedTo:'closed',openedDate:'2026-01-01T08:00:00',resolvedDate:'0000-00-00 00:00:00',deleted:0}))}));return;
    }
    if(url.pathname==='/plmquery/bug/detail/'){
      res.end(JSON.stringify({code:1000,data:payload.bug_ids.map((id:number)=>({id:String(id),title:'Synthetic defect',severity:'2',pri:'3',status:'resolved',resolution:id===52?'future-resolution':'fixed',product:'7',assignedTo:'closed',openedDate:'2026-01-01 08:00:00',resolvedDate:'',lastEditedDate:`2026-01-02 08:00:0${state.revision}`,resolvedBuild:'99',openedBuild:'trunk',bugzillaID:'401',actions:[{id:'9',actor:'synthetic-user',action:'resolved',date:'2026-01-02 08:00:00',comment:'Synthetic correction',extra:''}]}))}));return;
    }
    if(url.pathname==='/plmquery/build/'){res.end(JSON.stringify({code:1000,data:[{id:99,product:7,name:'Synthetic collection bucket',date:'2026-01-02'}]}));return;}
    if(url.pathname==='/plmquery/build/99/'){res.end(JSON.stringify({code:1000,data:{id:'99',product:'7',name:'Synthetic collection bucket',date:'2026-01-02',bugs:'51,52',stories:'',deleted:'0'}}));return;}
    if(url.pathname==='/jump/view'&&req.method==='POST'){
      const values:Record<string,unknown>={
        'environment.inventory':[{id:'lab-a',revision:String(state.revision),label:'Synthetic laboratory'}],
        'environment.topology':{nodes:['node-a','node-b'],edges:[['node-a','node-b']]},
        'device.status':{id:'node-a',state:'ready'},
        'framework.files':[{path:'checks/sample.ts',revision:String(state.revision)}],
        'framework.get':{path:'checks/sample.ts',contentBase64:Buffer.from('export const sample = true;').toString('base64')},
      };
      if(!Object.hasOwn(values,payload.command)){res.writeHead(403);res.end();return;}
      res.end(JSON.stringify({revision:String(state.revision),result:values[payload.command]}));return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const close=async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));};
  return {origin,secret,state,requests,close};
}
