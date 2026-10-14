// Evaluate this side-effect module before imports that capture Hub settings.
// Legacy input is accepted only when its new name is undefined; values never
// enter the deprecation notice. Circle's client extension environment is an
// outbound protocol and is deliberately outside this Hub input migration.
export function initializeHubEnvironment(environment:NodeJS.ProcessEnv=process.env,log:(notice:{type:'hub.environment.deprecated';keys:string[]})=>void=notice=>process.stderr.write(JSON.stringify(notice)+'\n')){
 const keys=Object.keys(environment).filter(key=>key.startsWith('CIRCLE_SERVER_')&&environment[key]!==undefined).sort();
 for(const key of keys){const name=key.replace(/^CIRCLE_SERVER_/,'CIRCLE_HUB_');if(environment[name]===undefined)environment[name]=environment[key];}
 // This single legacy lookup belongs to a frozen execution implementation.
 // Preserve its bytes and digest; adapt the new input only at the Hub boundary.
 if(environment.CIRCLE_HUB_EXECUTION_GATEWAYS!==undefined)environment.CIRCLE_SERVER_EXECUTION_GATEWAYS=environment.CIRCLE_HUB_EXECUTION_GATEWAYS;
 if(keys.length)log({type:'hub.environment.deprecated',keys});
 return keys;
}
// Hub children receive resolved input names, avoiding repeated notices for
// inherited aliases and the internal frozen-implementation gateway lookup.
export function hubChildEnvironment(environment:NodeJS.ProcessEnv):NodeJS.ProcessEnv{return Object.fromEntries(Object.entries(environment).filter(([key])=>!key.startsWith('CIRCLE_SERVER_')));}
initializeHubEnvironment();
