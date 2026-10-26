// Exercise the published two-part command check: declaration guard plus the shared complete-signature interpreter.
import {catalogInterpreter} from '../../../../hub/rules/interpreters/catalog.ts';
import {createCatalogView} from '../../../../hub/rules/api.ts';
import {checkCommandsRefutation as declarations} from '../functions/checks.ts';
import {refutationSubject} from '../functions/subjects.ts';
import TABLE from '../tables/refutation-commands.json' with {type:'json'};
import type {PackCheckInput} from '../../../../hub/rules/api.ts';
import type {CheckOutcome} from '../../../../contracts/src/tables.ts';
export function checkCommandsRefutation(input:PackCheckInput):CheckOutcome[]{
 const guarded=declarations(input);if(guarded.some(row=>row.verdict!=='support'))return guarded;
 const raw=input.subject as Record<string,unknown>;
 return catalogInterpreter.run({...input,table:TABLE,subject:refutationSubject(raw),catalog:createCatalogView(input.catalog??[],{complete:true,caseSensitive:true})} as never) as CheckOutcome[];
}
