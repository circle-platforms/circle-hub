// Prints elements of the cause model in contracts/model.json.
//   node tools/show-element.ts B01 A03       elements (ids are case-insensitive; commas also separate)
//   node tools/show-element.ts --list        every element: id, group, name, English name
//   node tools/show-element.ts --vocab [axis ...]   axes with codes and labels; without names, every axis
//   node tools/show-element.ts --pending     pending decisions and their status
// Exit status: 0 everything found, 1 something asked for is not in the model, 2 bad usage or unreadable model.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

type Element = { id: string; group: string; name: string; english: string; definition: string; fields?: string[]; rules?: string[] };
type Axis = { axis: string; label: string; owner: string; values: { code: string; label: string }[] };
type Model = {
  elements: Element[];
  vocabulary: Axis[];
  pendingDecisions?: { item: string; options: string; recommend: string; affectsM1: boolean; status?: string; decision?: string }[];
};

const USAGE = `usage: node tools/show-element.ts <id> [<id> ...] | --list | --vocab [<axis> ...] | --pending | --help
  ids look like B01 or w08; --vocab without names lists every axis`;

function loadModel(path: string): Model {
  let model: unknown;
  try {
    model = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${path}: ${(error as Error).message}`);
  }
  const m = model as Partial<Model>;
  if (!Array.isArray(m.elements) || !Array.isArray(m.vocabulary)) throw new Error(`${path} has no elements or vocabulary array`);
  return m as Model;
}

/** Up to three of the closest names: longest common prefix, then containment; only the best score is offered. */
function suggest(wanted: string, names: string[]): string[] {
  const w = wanted.toLowerCase();
  const scored = names.map((n) => {
    const l = n.toLowerCase();
    let common = 0;
    while (common < w.length && common < l.length && w[common] === l[common]) common++;
    return { n, score: common * 10 + (l.includes(w) || w.includes(l) ? 5 : 0) };
  });
  const best = Math.max(0, ...scored.map((s) => s.score));
  return best === 0 ? [] : scored.filter((s) => s.score === best).map((s) => s.n).sort().slice(0, 3);
}

function printElement(e: Element, out: (line: string) => void): void {
  out(`== ${e.id} ${e.name} (${e.english})  [${e.group}]`);
  out(`DEF: ${e.definition}`);
  (e.fields ?? []).forEach((f, i) => out(` F[${i}]: ${f}`));
  (e.rules ?? []).forEach((r, i) => out(` R[${i}]: ${r}`));
  out('');
}

export function main(args: string[], modelPath: string, out: (line: string) => void, err: (line: string) => void): number {
  if (args.includes('--help') || args.includes('-h')) {
    out(USAGE);
    return 0;
  }
  const mode = args[0]?.startsWith('-') ? args[0] : args.length === 0 ? '--list' : 'ids';
  const rest = mode === 'ids' ? args : args.slice(1);
  const strayOption = rest.find((a) => a.startsWith('-'));
  if (!['ids', '--list', '--vocab', '--pending'].includes(mode) || strayOption !== undefined) {
    err(`unknown option ${strayOption ?? mode}`);
    err(USAGE);
    return 2;
  }
  if ((mode === '--list' || mode === '--pending') && rest.length > 0) {
    err(`${mode} takes no names (got ${rest.join(' ')})`);
    err(USAGE);
    return 2;
  }
  let model: Model;
  try {
    model = loadModel(modelPath);
  } catch (error) {
    err((error as Error).message);
    return 2;
  }
  if (mode === '--list') {
    for (const e of model.elements) out(`${e.id}\t${e.group}\t${e.name}\t${e.english}`);
    return 0;
  }
  if (mode === '--pending') {
    for (const p of model.pendingDecisions ?? []) out(`[${p.status ?? '?'}] ${p.item}\n    ${p.decision ?? p.recommend}`);
    return 0;
  }
  const names = rest.flatMap((a) => a.split(',')).map((a) => a.trim()).filter((a) => a !== '');
  let missing = 0;
  if (mode === '--vocab') {
    if (names.length === 0) {
      for (const a of model.vocabulary) out(`${a.axis}\t${a.label} (${a.owner})\t${a.values.length} values`);
      return 0;
    }
    for (const name of names) {
      const a = model.vocabulary.find((x) => x.axis === name.toLowerCase());
      if (!a) {
        missing++;
        const close = suggest(name, model.vocabulary.map((x) => x.axis));
        err(`no axis ${name}${close.length ? `; did you mean ${close.join(', ')}?` : ''} (node tools/show-element.ts --vocab lists all ${model.vocabulary.length})`);
        continue;
      }
      out(`${a.axis} ${a.label} (${a.owner})`);
      for (const v of a.values) out(`  ${v.code}\t${v.label}`);
    }
    return missing > 0 ? 1 : 0;
  }
  if (names.length === 0) {
    err('no element ids given');
    err(USAGE);
    return 2;
  }
  for (const name of names) {
    const e = model.elements.find((x) => x.id === name.toUpperCase());
    if (!e) {
      missing++;
      const close = suggest(name, model.elements.map((x) => x.id));
      err(`no element ${name}${close.length ? `; did you mean ${close.join(', ')}?` : ''} (node tools/show-element.ts --list lists all ${model.elements.length})`);
      continue;
    }
    printElement(e, out);
  }
  return missing > 0 ? 1 : 0;
}

if (import.meta.main) {
  const path = join(dirname(fileURLToPath(import.meta.url)), '..', 'contracts', 'model.json');
  process.exitCode = main(process.argv.slice(2), path, (line) => console.log(line), (line) => console.error(line));
}
