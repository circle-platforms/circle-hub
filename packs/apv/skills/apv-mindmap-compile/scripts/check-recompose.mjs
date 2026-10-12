#!/usr/bin/env node
// Step 2 check: machine_mindmap.json against the manifest. The model relocates text, it
// never writes any: every contract field and expectation must be a whole atom of the case's
// own source, cited by an origin that points at that atom.
//   node check-recompose.mjs <batch folder>
import { join } from 'node:path';
import { labeledAtoms, normalize, readJson, writeJson } from './lib.mjs';

export const BUCKETS = new Set(['exp_recipe', 'step_recipe', 'true_gap']);
const ORIGIN = /^(title|step:\d+|expectation:[A-Za-z0-9_-]+|spec:[^:\s]+:\d+(?:-\d+)?|defect:zentao:(?:BUG|STORY)-\d+:(?:title|description))$/;
// A locator prefix the source wrote in front of an atom: "1." "[2]、" "[check1]".
const PREFIX = /^[ \t]*(?:\[?[0-9]+\]?[.、:：)）]|\[[A-Za-z0-9_-]+\])[ \t]*/;

// The text an origin points at, or undefined when it points at nothing in this case;
// external origins (spec, defect) cannot be resolved here and return null.
function resolve(item, origin) {
  if (origin === 'title') return item.title;
  const step = /^step:(\d+)$/.exec(origin);
  if (step) return item.step_intents[Number(step[1]) - 1]?.desc;
  const expectation = /^expectation:(.+)$/.exec(origin);
  if (expectation) {
    const key = expectation[1].toLowerCase();
    if (/^\d+$/.test(key)) return item.step_intents[Number(key) - 1]?.expected || undefined;
    for (const atom of [...item.step_intents.map((s) => s.expected), ...item.unbound_expectations]) {
      const found = labeledAtoms(atom).get(key);
      if (found) return found;
    }
    return undefined;
  }
  return null;
}
const same = (field, atom) => {
  const a = normalize(field);
  return a === normalize(atom) || a === normalize(String(atom).replace(PREFIX, ''));
};
const complete = (item) =>
  item.step_intents.length > 0 &&
  item.step_intents.every((s) => s.desc) &&
  (item.step_intents.some((s) => s.expected) || item.unbound_expectations.length > 0);

export const expectationId = (autoid, n, index) => `u1:${autoid}:${n}:${index}`;

export function checkRecompose(manifest, machine) {
  const violations = [];
  const flag = (code, autoid, detail) => violations.push({ code, autoid, detail });
  const disclosures = [];
  if (machine?.source_sha256 !== manifest.source_sha256)
    flag('source_identity_drift', null, 'machine_mindmap.json is for another mindmap');
  if (typeof machine?.build !== 'string' || !machine.build)
    flag('build_unbound', null, 'name the build the cases are written for');
  const byId = new Map(manifest.cases.map((item) => [item.autoid, item]));
  const seen = new Set();
  for (const entry of Array.isArray(machine?.cases) ? machine.cases : []) {
    const item = byId.get(entry?.autoid);
    if (!item) {
      flag('autoid_not_in_manifest', entry?.autoid ?? null, 'not a case of this mindmap');
      continue;
    }
    if (seen.has(item.autoid)) flag('autoid_duplicated', item.autoid, 'listed twice');
    seen.add(item.autoid);
    if (!BUCKETS.has(entry.bucket)) flag('bucket_not_in_closed_set', item.autoid, String(entry.bucket));
    if (entry.bucket === 'true_gap' && complete(item))
      flag('true_gap_source_complete', item.autoid, 'the source has steps and expectations');
    if (entry.bucket !== 'true_gap' && !complete(item))
      flag('source_incomplete', item.autoid, 'steps or expectations are missing: use true_gap and a proposal');
    if (entry.proposal !== undefined && (!Array.isArray(entry.proposal) || entry.proposal.some((p) => typeof p !== 'string')))
      flag('proposal_shape_invalid', item.autoid, 'proposal is a list of plain strings');
    if (entry.bucket === 'true_gap') continue;
    for (const field of ['intent', 'verification_method', 'expectation']) {
      const value = entry.contract?.[field];
      const origin = entry.origin?.[field];
      if (typeof value !== 'string' || !value.trim()) {
        flag('contract_field_missing', item.autoid, field);
        continue;
      }
      if (!ORIGIN.test(String(origin))) {
        flag('origin_invalid', item.autoid, `${field}: ${String(origin)}`);
        continue;
      }
      const atom = resolve(item, origin);
      if (atom === null) disclosures.push({ autoid: item.autoid, field, origin, note: 'external source; checked by the server' });
      else if (atom === undefined) flag('origin_unresolved', item.autoid, `${field}: ${origin}`);
      else if (!same(value, atom)) flag('case_verbatim_mismatch', item.autoid, `${field} is not the whole text at ${origin}`);
    }
    const expectations = Array.isArray(entry.expectations) ? entry.expectations : [];
    if (!expectations.length) flag('expectations_missing', item.autoid, 'list the expectations by step');
    for (const expectation of expectations) {
      const n = Number(expectation?.n);
      if (!Number.isInteger(n) || n < 1 || n > item.step_intents.length)
        flag('expectation_step_invalid', item.autoid, `n=${String(expectation?.n)}`);
      if (!ORIGIN.test(String(expectation?.origin))) {
        flag('origin_invalid', item.autoid, `expectation: ${String(expectation?.origin)}`);
        continue;
      }
      const atom = resolve(item, expectation.origin);
      if (atom === null) disclosures.push({ autoid: item.autoid, field: 'expectation', origin: expectation.origin, note: 'external source; checked by the server' });
      else if (atom === undefined) flag('origin_unresolved', item.autoid, `expectation: ${expectation.origin}`);
      else if (!same(expectation.text, atom))
        flag('case_verbatim_mismatch', item.autoid, `expectation is not the whole text at ${expectation.origin}`);
    }
  }
  for (const item of manifest.cases)
    if (!seen.has(item.autoid)) flag('case_not_recomposed', item.autoid, 'no entry in machine_mindmap.json');
  return { ok: violations.length === 0, violations, disclosures };
}

// The expectation ids of a recomposed case, in the order the gate and the workbook use.
export function expectationIds(entry) {
  const counts = new Map();
  return (entry.expectations ?? []).map((expectation) => {
    const n = Number(expectation.n);
    const index = counts.get(n) ?? 0;
    counts.set(n, index + 1);
    return expectationId(entry.autoid, n, index);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [batch] = process.argv.slice(2);
  if (!batch) {
    console.error('usage: node check-recompose.mjs <batch folder>');
    process.exit(2);
  }
  const result = checkRecompose(readJson(join(batch, 'manifest.json')), readJson(join(batch, 'machine_mindmap.json')));
  writeJson(join(batch, 'recompose_check.json'), result);
  console.log(JSON.stringify({ ok: result.ok, violations: result.violations.slice(0, 32), disclosures: result.disclosures.length }));
  process.exit(result.ok ? 0 : 1);
}
