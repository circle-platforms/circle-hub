import {createServer} from 'node:http';
import type {TestContext} from 'node:test';

export async function documentTree(t:TestContext){
  const requests:{method:string;path:string}[]=[],state={revision:1,count:2,deep:false};
  const server=createServer((req,res)=>{
    const path=req.url!;requests.push({method:req.method!,path});
    if(req.method==='PROPFIND'){
      const entries=path==='/webdav/'?[{path:'/webdav/cli/',directory:true}]:path==='/webdav/cli/'?[{path:'/webdav/cli/rel_photon_10_8/',directory:true}]:path==='/webdav/cli/rel_photon_10_8/'?[{path:'/webdav/cli/rel_photon_10_8/manuals/',directory:true}]:path==='/webdav/cli/rel_photon_10_8/manuals/'?[...Array.from({length:state.count},(_,index)=>({path:`/webdav/cli/rel_photon_10_8/manuals/guide-${index}.md`,directory:false})),...(state.deep?[{path:'/webdav/cli/rel_photon_10_8/manuals/deeper/',directory:true}]:[])]:path.endsWith('/deeper/')?[{path:'/webdav/cli/rel_photon_10_8/manuals/deeper/guide.md',directory:false}]:null;
      if(!entries){res.writeHead(405);res.end();return;}
      res.writeHead(207,{'content-type':'application/xml'});res.end(`<d:multistatus xmlns:d="DAV:">${[{path,directory:true},...entries].map(entry=>`<d:response><d:href>${entry.path}</d:href><d:propstat><d:prop><d:getetag>"r${state.revision}"</d:getetag><d:getcontentlength>64</d:getcontentlength><d:resourcetype>${entry.directory?'<d:collection/>':''}</d:resourcetype></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join('')}</d:multistatus>`);return;
    }
    if(path.endsWith('.md')){res.setHeader('etag',`"r${state.revision}"`);res.end(`Synthetic manual r${state.revision}\n**service virtual**\nHTTP settings revision ${state.revision}\n`);return;}
    res.writeHead(404);res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {origin:`http://127.0.0.1:${(server.address() as {port:number}).port}`,requests,state,policy:{versionDirectoryTemplate:'cli/rel_photon_{version}/',versionSeparator:'_',maxDepth:3,maxFiles:100,maxBytes:4*1024*1024}};
}
