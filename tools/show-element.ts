// Prints elements of the cause model: node tools/show-element.ts B01 A03 | --list | --vocab partition | --pending
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Element = { id: string; group: string; name: string; english: string; definition: string; fields?: string[]; rules?: string[]; tracedTo?: string[] };
type Model = {
  elements: Element[];
  vocabulary: { axis: string; label: string; owner: string; values: { code: string; label: string }[] }[];
  pendingDecisions: { item: string; options: string; recommend: string; affectsM1: boolean; status?: string; decision?: string }[];
};

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const model: Model = JSON.parse(readFileSync(join(root, 'contracts', 'model.json'), 'utf8'));
const args = process.argv.slice(2);

if (args.length === 0 || args[0] === '--list') {
  for (const e of model.elements) console.log(`${e.id}\t${e.group}\t${e.name}\t${e.english}`);
} else if (args[0] === '--vocab') {
  for (const name of args.slice(1)) {
    const a = model.vocabulary.find((x) => x.axis === name);
    if (!a) {
      console.log(`no axis ${name}`);
      continue;
    }
    console.log(`${a.axis} ${a.label} (${a.owner})`);
    for (const v of a.values) console.log(`  ${v.code}\t${v.label}`);
  }
} else if (args[0] === '--pending') {
  for (const p of model.pendingDecisions) console.log(`[${p.status ?? '?'}] ${p.item}\n    ${p.decision ?? p.recommend}`);
} else {
  for (const id of args) {
    const e = model.elements.find((x) => x.id === id);
    if (!e) {
      console.log(`no element ${id}`);
      continue;
    }
    console.log(`== ${e.id} ${e.name} (${e.english})  [${e.group}]`);
    console.log(`DEF: ${e.definition}`);
    (e.fields ?? []).forEach((f, i) => console.log(` F[${i}]: ${f}`));
    (e.rules ?? []).forEach((r, i) => console.log(` R[${i}]: ${r}`));
    console.log('');
  }
}
