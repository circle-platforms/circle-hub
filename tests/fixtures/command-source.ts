export const externalTree=Buffer.from('<?xml version="1.0" encoding="ISO-8859-1"?><commands><scope name="config"><menu name="service"><menu name="create"><item name="port"><arg position="1" type="U16" min="1" max="65535" help="synthetic port"/></item></menu><menu name="inspect"><item name="alpha"/></menu></menu><menu name="feature"><item name="enable"/></menu></scope></commands>','latin1');
export function functionContract(disabled:{e:string;f:string}[]=[]):Buffer{
  const entries=[...['APV_0','APV_1'].flatMap(e=>['cmd','cmd_config','cmds_config','cmd_enable'].map(f=>({e,f,status:'enabled'}))),
    ...['clientc','clientd','cliente','routera','routerb','server213','server231','server232'].map(f=>({e:'test_env',f,status:'enabled'})),
    ...['found','not_found','abs_found','found_times'].map(f=>({e:'check_point',f,status:'enabled'})),{e:'time',f:'sleep',status:'enabled'},
    {e:'APV_0',f:'reboot',status:'disabled'},{e:'APV_1',f:'reboot',status:'disabled'},{e:'test_env',f:'close',status:'internal'}];
  for(const row of entries)if(disabled.some(item=>item.e===row.e&&item.f===row.f))row.status='disabled';
  return Buffer.from(JSON.stringify({schema:'ist.excel.function-contract',complete:true,entries}));
}
