#!/usr/bin/env node
// Step 1: the mindmap JSON export → manifest.json. Requirements only, never commands.
//   node prep.mjs <mindmap.json> <batch folder>
// The rules follow the source system's prep step: one [root], 18-digit autoids as the
// primary key, two case layouts, and a whole-batch refusal on any bad input.
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import {
  AUTOID,
  CompileError,
  actionAtoms,
  checkRefs,
  labeledAtoms,
  numberedAtoms,
  parseJson,
  sha256,
  writeBytes,
  writeJson,
} from './lib.mjs';

const MAX_BYTES = 32 * 1024 * 1024;
const MARKERS = [Buffer.from([0xef, 0xbf, 0xbf]), Buffer.from([0xef, 0xbb, 0xbf])];

const text = (node) => String(node?.data?.text ?? '').trim();
const children = (node) => (Array.isArray(node?.children) ? node.children : []);

// The step intents of one case node, in one of two layouts.
export function stepIntents(node) {
  const kids = children(node);
  if (kids.length === 1 && !children(kids[0]).length && !numberedAtoms(text(kids[0])).length) {
    const expectation = text(kids[0]);
    const actions = actionAtoms(text(node));
    const labeled = labeledAtoms(expectation);
    const matched = new Set();
    const intents = actions.map(([, action]) => {
      const refs = checkRefs(action).filter((label) => labeled.has(label));
      refs.forEach((label) => matched.add(label));
      let parts = refs.map((label) => labeled.get(label));
      if (!parts.length && actions.length === 1) {
        parts = expectation ? [expectation] : [];
        labeled.forEach((_, label) => matched.add(label));
      }
      return { desc: action, expected: parts.join('  ') };
    });
    const unbound = [...labeled].filter(([label]) => !matched.has(label)).map(([, atom]) => atom);
    return { intents, layout: 'case_body_with_leaf_expectation', unbound };
  }
  return {
    intents: kids.map((step) => ({
      desc: text(step),
      expected: children(step).map(text).filter(Boolean).join('  '),
    })),
    layout: 'title_steps_expectations',
    unbound: [],
  };
}

export function extractCases(root) {
  const cases = [];
  const walk = (node, groupPath) => {
    const data = node?.data ?? {};
    const autoid = String(data.autoid ?? '').trim();
    if (autoid) {
      const auto = String(data.auto ?? '').trim();
      if (auto && auto.toUpperCase() !== 'YES') return;
      const { intents, layout, unbound } = stepIntents(node);
      cases.push({
        autoid,
        title: text(node),
        group_path: [...groupPath],
        priority: data.priority ?? null,
        resource: data.resource ?? null,
        source_layout: layout,
        step_intents: intents,
        unbound_expectations: unbound,
        init_commands: null,
        steps: null,
        compile_state: { status: 'pending', rounds: 0 },
      });
      return;
    }
    const title = text(node);
    for (const child of children(node)) walk(child, title ? [...groupPath, title] : groupPath);
  };
  walk(root, []);
  return cases;
}

// A hint for working through similar cases together: the first step with digits as N.
function families(cases) {
  const groups = new Map();
  for (const item of cases) {
    const key = (item.step_intents[0]?.desc ?? '').replace(/\d+/g, 'N').replace(/\s+/g, '');
    groups.set(key, [...(groups.get(key) ?? []), item.autoid]);
  }
  return [...groups.values()]
    .sort((a, b) => b.length - a.length)
    .map((autoids, index) => ({ family: `F${String(index + 1).padStart(2, '0')}`, autoids }));
}

export function prep(bytes, source) {
  if (bytes.length < 1 || bytes.length > MAX_BYTES)
    throw new CompileError('mindmap_parse_failed', 'the file must be 1 byte to 32 MiB');
  let body = bytes;
  for (let stripped = true; stripped; ) {
    stripped = false;
    for (const marker of MARKERS)
      if (body.subarray(0, 3).equals(marker)) {
        body = body.subarray(3);
        stripped = true;
      }
  }
  let parsed;
  try {
    parsed = parseJson(body.toString('utf8'));
  } catch (error) {
    throw new CompileError('mindmap_parse_failed', `not one JSON document: ${error.message}`);
  }
  if (!Array.isArray(parsed) || parsed.length !== 1)
    throw new CompileError('mindmap_parse_failed', 'the top level must be a one-element array [root]');
  const [root] = parsed;
  if (!root || typeof root !== 'object' || typeof root.data !== 'object' || !Array.isArray(root.children))
    throw new CompileError('mindmap_parse_failed', 'root needs a data object and a children array');
  const cases = extractCases(root);
  if (!cases.length) throw new CompileError('no_case_node', 'no case node with an autoid');
  const invalid = cases.map((item) => item.autoid).filter((id) => !AUTOID.test(id));
  if (invalid.length)
    throw new CompileError('invalid_autoid', `autoids must be 18 digits: ${invalid.slice(0, 5).join(', ')}`);
  const seen = new Set();
  for (const item of cases) {
    if (seen.has(item.autoid))
      throw new CompileError('duplicate_autoid', `the mindmap repeats autoid ${item.autoid}`);
    seen.add(item.autoid);
  }
  const sourceSha256 = sha256(bytes);
  const family = families(cases);
  for (const group of family)
    for (const autoid of group.autoids) cases.find((item) => item.autoid === autoid).family = group.family;
  return {
    schema: 'apv.mindmap-compile.manifest',
    source,
    source_sha256: sourceSha256,
    source_size: bytes.length,
    case_count: cases.length,
    groups: [...new Set(cases.map((item) => item.group_path.join(' / ')))],
    families: family,
    cases,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [input, batch] = process.argv.slice(2);
  if (!input || !batch) {
    console.error('usage: node prep.mjs <mindmap.json> <batch folder>');
    process.exit(2);
  }
  try {
    const bytes = readFileSync(input);
    const manifest = prep(bytes, basename(input));
    writeBytes(join(batch, 'mindmap_source.json'), bytes);
    writeJson(join(batch, 'manifest.json'), manifest);
    console.log(
      JSON.stringify({ ok: true, batch, case_count: manifest.case_count, source_sha256: manifest.source_sha256 }),
    );
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: error.code ?? 'failed', message: error.message }));
    process.exit(1);
  }
}
