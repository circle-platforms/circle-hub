// The manifest identifies work only. Sources are always resolved independently at the Hub boundary.
import type { ProjectionInput, ProjectionOutput } from '../../../../contracts/src/pack.ts';
export default function project(input: ProjectionInput): ProjectionOutput {
  const source = input.inputs.find(v => v.slot === 'subject');
  const value = source?.model as {items?: Array<{id?: unknown;title?: unknown}>} | undefined;
  if (source?.parser !== 'json@1' || !Array.isArray(value?.items) || value.items.length > 1000 || value.items.some(v => typeof v?.id !== 'string' || typeof v?.title !== 'string')) return {error:{code:'knowledge-contribution.manifest',message:'回注清单必须有至多 1000 个 items，每项有 id 和 title',fix:'按 examples/manifest.json 修正清单后重开运行'},warnings:[]};
  return {items:value.items.map((row,i)=>({id:row.id as string,label:row.title as string,location:{parser:'json@1',selector:'p/items/'+i},fields:{}})),warnings:[]};
}
