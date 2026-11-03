// Derives the bundled examples from examples/case-mindmap.json with the pack's own projection (issue #130): uploading those
// bytes gives src:<sha256>, start_run projects the item ids, and every quote cites src:<sha256>/kityminder@1/<selector> of
// the node whose text it copies. `node testing/examples.ts --write` rewrites start-run.json and submit-result.json from
// the mind map; examples.test.ts fails when the written files drift from the derivation.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createTestParserRegistry } from '../../../../hub/testing/parsers.ts';
import { parserKey, recognize } from '../../../../hub/refs/api.ts';
import { projectItems } from '../functions/project.ts';

const at = (name: string) => new URL(`../examples/${name}`, import.meta.url);
const json = (name: string): any => JSON.parse(readFileSync(at(name), 'utf8'));

export interface DerivedExamples {
  /** The reference upload_file returns for examples/case-mindmap.json. */
  subject: string;
  items: Array<{ id: string; autoid: string; path: unknown }>;
  /** Quote reference of each node text of the mind map that names exactly one node. */
  references: Map<string, string>;
  bed: string;
}

export function deriveExamples(parameters: Record<string, unknown> = json('start-run.json').arguments.parameters): DerivedExamples {
  const bytes = new Uint8Array(readFileSync(at('case-mindmap.json')));
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const parsed = recognize(createTestParserRegistry(), bytes, 'application/json');
  if (!parsed || parserKey(parsed.parser) !== 'kityminder@1') throw new Error('examples/case-mindmap.json is not read by kityminder@1');
  const model = parsed.document.model as { nodes: Array<{ text: string; selector: string }> };
  const profile = json('runtime-profile-v2.json');
  const out = projectItems({
    inputs: [
      { slot: 'subject', external: null, sha256, parser: 'kityminder@1', model },
      { slot: 'contract', model: json('runtime-contract-v2.json') },
      { slot: 'profile', model: profile },
      { slot: 'inventory', model: json('bed-topology.json') },
    ],
    parameters,
    context: { leases: { now: '2026-11-03T00:00:00.000Z', entries: [] } },
  }) as { items?: Array<{ id: string; fields: { autoid: string; path: unknown } }>; error?: unknown };
  if (!out.items) throw new Error('the example start does not project: ' + JSON.stringify(out.error));
  const counts = new Map<string, number>(); for (const node of model.nodes) counts.set(node.text, (counts.get(node.text) ?? 0) + 1);
  const references = new Map(model.nodes.filter((node) => counts.get(node.text) === 1).map((node) => [node.text, `src:${sha256}/kityminder@1/${node.selector}`]));
  return { subject: `src:${sha256}`, items: out.items.map((item) => ({ id: item.id, autoid: item.fields.autoid, path: item.fields.path })), references, bed: profile.bed };
}

/** Every quote object of a submission: the plan claim's quotes and each expectation's quote. */
export function quotesOf(submission: any): Array<{ reference: string; text: string }> {
  return submission.items.flatMap((item: any) => item.slots.plan.flatMap((claim: any) => [...(claim.quotes ?? []), ...(claim.data?.expects ?? []).map((expect: any) => expect.quote)]));
}

function write(): void {
  const start = json('start-run.json'), submission = json('submit-result.json'), derived = deriveExamples(start.arguments.parameters);
  start.arguments.inputs.subject = { reference: derived.subject };
  if (derived.items.length !== submission.items.length) throw new Error('the example submission must answer every projected item');
  for (const [k, item] of submission.items.entries()) item.item = derived.items[k].id;
  for (const quote of quotesOf(submission)) {
    const reference = derived.references.get(quote.text); if (!reference) throw new Error(`no single mind-map node has the quoted text ${quote.text}`);
    quote.reference = reference;
  }
  writeFileSync(at('start-run.json'), JSON.stringify(start, null, 2) + '\n');
  writeFileSync(at('submit-result.json'), JSON.stringify(submission, null, 2) + '\n');
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) write();
