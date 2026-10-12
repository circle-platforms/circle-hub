import {createServer} from 'node:http';
import type {TestContext} from 'node:test';

// Fictional content with the observed summary/listing/variant structure.
export async function publicationLayout(t:TestContext){
  const requests:string[]=[],builds=[
    {name:'Rel_PHOTON_10_8_1_701',date:'2026-04-01'},
    {name:'Rel_PHOTON_10_8_1_711',date:'2026-04-09'},
    {name:'Beta_PHOTON_10_8_1_722',date:''},
    {name:'Rel_PHOTON_10_8_1_730',date:''},
  ];
  const commands='<?xml version="1.0" encoding="ISO-8859-1"?><commands><scope name="configuration"><menu name="aaa"><menu name="ldap"><menu name="attribute"><item name="group"><arguments><arg type="STRING" help="Synthetic café"/></arguments></item></menu></menu><menu name="acl"><item name="group"><arguments><arg type="U16" min="1" max="1024"/></arguments></item></menu></menu><menu name="service"><item name="address"><arguments><arg type="IPADDR"/></arguments></item><item name="mode"><arguments><arg type="STRING" enum="active|standby"/></arguments></item></menu></scope></commands>';
  const server=createServer((req,res)=>{
    const path=req.url!;requests.push(path);
    if(path==='/builds/'){res.end('<A href="line_photon_10_8.html">PHOTON 10.8 builds</A>');return;}
    if(path==='/builds/line_photon_10_8.html'){res.end('<h2>Summary</h2><A href="rel_photon_10_8.html">standard</A><A href="rel_photon_10_8_SyntheticOS.html">OS variant</A><A href="rel_orion_10_8.html">other product</A><A href="line_photon_10_8.html">self</A>');return;}
    if(/^\/builds\/rel_photon_10_8(?:_SyntheticOS)?\.html$/.test(path)){
      const variant=path.includes('SyntheticOS'),prefix=variant?'SyntheticOS-':'',fixedPrefix=variant?'SyntheticOS_':'';
      res.end(`<h2> PHOTON10.x Builds</h2>${builds.map(build=>{
        const title=`${build.name} (build on  2026-03-31 01:02:03 ): ${build.date?`Released on ${build.date}`:''}`;
        return `${build.date?`<font color=red>${title}</font>`:title} </br><BLOCKQUOTE>
          <A href="${prefix}${build.name}.${variant?'click':'array'}">image</A> ( 42M , SHA256: ${'c'.repeat(64)} )<BR>
          <A href="/builds/CA-SNMP-MIB-${build.name}.txt">MIB</A><BR>
          <A href="http://127.0.0.1:${(server.address() as {port:number}).port}/builds/command_tree-${prefix}${build.name}.xml">command tree</A><BR>
          <A href="Bugs_Fixed_with_${fixedPrefix}${build.name}.html">fixed list</A><BR></BLOCKQUOTE><hr>`;
      }).join('')}`);return;
    }
    if(path.includes('/command_tree-')){res.end(Buffer.from(commands,'latin1'));return;}
    if(path.includes('/Bugs_Fixed_with_')){
      if(path.includes('_730.html')){res.end('<p>No observed fixes</p>');return;}
      const beta=path.includes('Beta_'),first=path.includes('_701.html');
      const direct=beta?'99':'51',legacy=beta?'990':'401';
      res.end(`<A href="/tracker/index.php?m=bug&amp;f=view&amp;t=html&amp;id=${direct}">direct ${direct}</A><BR><A href="/legacy/show_bug.cgi?id=${legacy}">external ${legacy}</A><BR><A href="index.php?m=story&amp;f=view&amp;id=51">unrelated</A>${first?'':'<A href="index.php?m=bug&amp;f=view&amp;id=401">same numeric value, another system</A>'}`);return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));});
  return {origin:`http://127.0.0.1:${(server.address() as {port:number}).port}`,requests,builds,commands,policy:{listingPathPattern:'(?:^|/)rel_photon_(?<versionLine>\\d+(?:_\\d+){1,2})(?<variant>_[^.]+)?\\.html$',variantPlatforms:{SyntheticOS:'synthetic-os'}}};
}
