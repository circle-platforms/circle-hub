export const builtinToolNames=Object.freeze(['hub_task','hub_packs','hub.tasks_submit','hub.sources_upload','hub.skillpacks_submit','hub.approvals_decide','hub.tasks_status','hub.tasks_result','hub.skillpacks_run']);
export function knownToolNames(packages:{id:string;prefix?:string;productLinePrefixes?:Record<string,string>;tools:{suffix:string}[]}[]):Set<string>{
  const names=new Set<string>(builtinToolNames);
  for(const pack of packages){
    const prefixes=new Set<string>();
    if(pack.prefix)prefixes.add(pack.prefix);
    prefixes.add(pack.id.replaceAll('-','_'));
    for(const prefix of Object.values(pack.productLinePrefixes??{}))prefixes.add(prefix);
    for(const prefix of prefixes)for(const tool of pack.tools)names.add(`${prefix}.${tool.suffix}`);
  }
  return names;
}
