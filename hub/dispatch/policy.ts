// Global policy is core-versioned content; resource administration never supplies another table.
import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import {EffectClassSchema,EnvironmentSchema,EFFECT_CLASS,ENVIRONMENT,type EffectClass,type Environment} from '../../contracts/generated/vocabulary.ts';
import {canonicalBytes,sha256Hex} from '../records/api.ts';
const cell=z.strictObject({effect_class:EffectClassSchema,reversible:z.boolean(),environment:EnvironmentSchema});
export const BoundaryPolicy=z.strictObject({schema:z.literal('boundary-policy@1'),rows:z.array(z.strictObject({effect_class:EffectClassSchema,reversible:z.boolean(),environments:z.record(EnvironmentSchema,z.boolean())})),samples:z.array(z.strictObject({input:cell,expected:z.boolean()}))}).superRefine((table,ctx)=>{
 for(const effect of EFFECT_CLASS)for(const reversible of [false,true])if(table.rows.filter(row=>row.effect_class===effect&&row.reversible===reversible).length!==1)ctx.addIssue({code:'custom',message:'policy cells must be complete and unique'});
 if(table.rows.length!==EFFECT_CLASS.length*2)ctx.addIssue({code:'custom',message:'unexpected policy cells'});
 for(const sample of table.samples)if(policyAllows(table,sample.input)!==sample.expected)ctx.addIssue({code:'custom',message:'policy sample disagrees with the table'});
 if(!table.samples.some(sample=>sample.expected)||!table.samples.some(sample=>!sample.expected))ctx.addIssue({code:'custom',message:'policy has positive and negative examples'});
});
export type BoundaryPolicy=z.infer<typeof BoundaryPolicy>;
export function policyAllows(table:BoundaryPolicy,input:{effect_class:EffectClass;reversible:boolean;environment:Environment}):boolean {
 const row=table.rows.find(row=>row.effect_class===input.effect_class&&row.reversible===input.reversible);
 return row?.environments[input.environment]===true;
}
export async function boundaryPolicy(){const document=BoundaryPolicy.parse(JSON.parse(await readFile(new URL('./policy/boundary.json',import.meta.url),'utf8')));return {document,version:sha256Hex(canonicalBytes(document))};}
