// Evaluate this side-effect module before imports that capture Hub settings.
// Hub input uses only CIRCLE_HUB_*. The pre-rename CIRCLE_SERVER_* names were
// retired on 2026-10-16 and are never read, copied or aliased. A process that
// still carries one, even empty or beside its replacement, refuses to start
// instead of silently running with defaults such as another database. The
// error names keys and their replacements only, never values. Circle's client
// extension environment is an outbound protocol outside this check.
const RETIRED_PREFIX='CIRCLE_SERVER_',HUB_PREFIX='CIRCLE_HUB_';
export function retiredHubEnvironmentKeys(environment:NodeJS.ProcessEnv=process.env):string[]{return Object.keys(environment).filter(key=>key.startsWith(RETIRED_PREFIX)&&environment[key]!==undefined).sort();}
export function assertHubEnvironment(environment:NodeJS.ProcessEnv=process.env):void{
 const keys=retiredHubEnvironmentKeys(environment);if(!keys.length)return;
 const renames=keys.map(key=>`${key} -> ${HUB_PREFIX}${key.slice(RETIRED_PREFIX.length)}`).join(', ');
 const error=new Error(`circle-hub no longer reads ${RETIRED_PREFIX}* configuration and will not start while it is set. Rename each variable to its ${HUB_PREFIX}* replacement: ${renames}`);error.name='HubEnvironmentError';throw error;
}
assertHubEnvironment();
