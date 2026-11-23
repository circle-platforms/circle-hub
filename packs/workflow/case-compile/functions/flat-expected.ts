import {commandObligations,type UndoneConfiguration} from './command-obligations.ts';
import {deviceCommandLines,planCommands} from './plan-commands.ts';
import type {RuntimeContract} from './runtime-contract.ts';
import type {RuntimeProfile} from './profile.ts';
import type {PlanSlots} from './slots.ts';
import type {AuthorityGap} from './typed-authority.ts';

export function configuredExpectedSources(contract:RuntimeContract,profile:RuntimeProfile,slots:PlanSlots,catalog:unknown):{sources:UndoneConfiguration[];problems:AuthorityGap[]}{
 const resolved=planCommands(contract,profile,slots,catalog);
 if(resolved.problems.length)return {sources:[],problems:resolved.problems};
 const operations=deviceCommandLines(contract,profile,slots,resolved.answers).map(operation=>({...operation,cleanup:slots.steps[Number(operation.pointer.split('/')[2])].cleanup===true}));
 const sources:UndoneConfiguration[]=[];
 const problems=commandObligations(operations,slots,catalog,[],contract.cleanup,undefined,sources);
 return {sources,problems};
}
