// A frozen run as the Hub exports it to the client: what a test supplies (groups, items, root, command policy) plus the
// item-slot schema start_run froze for this pack, built by the Hub's own slotSchemaOf from this pack's files.
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {slotSchemaOf} from '../../../../hub/runs/engine/slots.ts';
import type {LoadedWorkflow} from '../../../../hub/ports.ts';
import {nodesText,type FlatCatalog} from './locked-tree.ts';

const read=(name:string)=>readFileSync(new URL('../'+name,import.meta.url));
/** The parts of a loaded workflow the slot schema and the slot check read; nothing else of the Hub is involved. */
export function slotWorkflow():LoadedWorkflow{
 const slots=JSON.parse(read('slots.schema.json').toString()),requirements=JSON.parse(read('requirements.json').toString()).requirements;
 return {slots,requirements,manifest:{files:[{path:'slots.schema.json',sha256:createHash('sha256').update(read('slots.schema.json')).digest('hex'),size:read('slots.schema.json').length}]}} as unknown as LoadedWorkflow;
}
/** run.slots exactly as the Hub freezes it. */
export function frozenSlots():{schema:Record<string,unknown>;sha256:string}{
 const made=slotSchemaOf(slotWorkflow());if(made===undefined)throw new Error('the pack declares no slots');
 return made as {schema:Record<string,unknown>;sha256:string};
}
export interface FrozenRunInput {groups:unknown[];items:Array<Record<string,unknown>>;root?:string;command_policy?:unknown;run?:string;extra?:Record<string,unknown>}
export function frozenRun(input:FrozenRunInput):Record<string,unknown>{
 return {run:input.run??'run_synthetic',...(input.root!==undefined?{root:input.root}:{}),...(input.command_policy!==undefined?{command_policy:input.command_policy}:{}),groups:input.groups,items:input.items,slots:frozenSlots(),...input.extra};
}

/**
 * Writes a run the way the download tool leaves it, run.json with knowledge/nodes.jsonl beside it, for the plan check CLI.
 * The tree is the one the Hub's export writes for `catalog.entries` (testing/locked-tree.ts).
 */
export async function writeDownload(directory:string,run:Record<string,unknown>,catalog:FlatCatalog):Promise<string>{
 const {mkdir,writeFile}=await import('node:fs/promises'),{join}=await import('node:path');
 await mkdir(join(directory,'knowledge'),{recursive:true});
 await writeFile(join(directory,'knowledge','nodes.jsonl'),nodesText(catalog,String(run.run)));
 const file=join(directory,'run.json');await writeFile(file,JSON.stringify(run));return file;
}
