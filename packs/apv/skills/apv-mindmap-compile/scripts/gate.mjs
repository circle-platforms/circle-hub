#!/usr/bin/env node
// Step 4: the mechanical checks on each written case (cases/<autoid>.json) before any
// workbook is made. A case passes only with no violation; a command the build's command
// tree does not have ends the case as an unsupported feature, never as something to retry.
//   node gate.mjs <batch folder>
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJson, writeJson } from './lib.mjs';
import { expectationIds } from './check-recompose.mjs';

const KEYS = ['autoid', 'blocks', 'build', 'command_receipts', 'description', 'escape_hatches', 'expectation_binding', 'init_commands', 'schema'];
const HOSTS = new Set(['APV_0', 'APV_1']);
const OPS = new Set(['found', 'not_found', 'abs_found']);
const CLAIMS = new Set(['Author', 'Manual', 'CapabilityXml', 'Spec', 'DefectSpec']);
const STEP_OBJECTS = new Set(['APV_0', 'APV_1', 'check_point', 'time', 'test_env']);

const here = dirname(fileURLToPath(import.meta.url));
export function destructivePatterns() {
  const path = join(here, '..', 'references', 'destructive.json');
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')).patterns.map((p) => new RegExp(p, 'i')) : [];
}

// Every device command a case runs: init, CONFIG and observation commands.
export function deviceCommands(item) {
  const commands = [...(item.init_commands ?? [])];
  for (const block of item.blocks ?? []) {
    if (block.kind === 'CONFIG') commands.push(...(block.cmds ?? []));
    if (block.kind === 'OBSERVE_ASSERT') commands.push(block.cmd);
  }
  return commands.filter((command) => typeof command === 'string');
}

export function gateCase(item, entry, manifestCase, build, destructive = destructivePatterns()) {
  const violations = [];
  const flag = (code, detail) => violations.push({ code, detail });
  if (!item || typeof item !== 'object') return { ok: false, terminal: null, violations: [{ code: 'not_an_object', detail: '' }] };
  const keys = Object.keys(item).sort();
  if (keys.join() !== KEYS.join()) flag('body_keys_mismatch', `keys must be ${KEYS.join(', ')}`);
  if (item.schema !== 'apv.mechanical-case') flag('schema_invalid', String(item.schema));
  if (item.description?.intent_verbatim !== entry.contract?.intent) flag('intent_verbatim_mismatch', 'copy the recomposed intent byte for byte');
  if (JSON.stringify(item.description?.group_path) !== JSON.stringify(manifestCase.group_path)) flag('group_path_mismatch', 'copy the manifest group path');
  if (item.build !== build) flag('build_mismatch', `written for ${String(item.build)}, bound to ${build}`);
  if (!Array.isArray(item.init_commands) || item.init_commands.some((c) => typeof c !== 'string' || !c.trim() || /\n/.test(c)))
    flag('init_commands_invalid', 'a list of single-line commands');
  const blocks = Array.isArray(item.blocks) ? item.blocks : [];
  if (!blocks.length || blocks.length > 1024) flag('blocks_invalid', '1 to 1024 blocks');
  const asserts = [];
  const steps = [];
  blocks.forEach((block, index) => {
    const at = `block ${index}`;
    if (block?.kind === 'CONFIG') {
      if (!HOSTS.has(block.host ?? 'APV_0')) flag('host_invalid', at);
      const cmds = block.cmds;
      if (!Array.isArray(cmds) || !cmds.length || cmds.some((c) => typeof c !== 'string' || !c.trim()))
        flag('empty_command_payload', at);
      else if (cmds.length > 1 && cmds.every((c) => c.length === 1)) flag('cmds_split_into_characters', at);
      else if (cmds.some((c) => /\n/.test(c))) flag('cmd_config_multiline', `${at}: one command per item`);
      if (block.timeout_s !== undefined && !(Number.isInteger(block.timeout_s) && block.timeout_s >= 1 && block.timeout_s <= 600))
        flag('timeout_invalid', at);
    } else if (block?.kind === 'OBSERVE_ASSERT') {
      if (!HOSTS.has(block.host ?? 'APV_0')) flag('host_invalid', at);
      if (typeof block.cmd !== 'string' || !block.cmd.trim() || /\n/.test(block.cmd)) flag('observe_command_invalid', at);
      if (!Array.isArray(block.asserts) || !block.asserts.length) flag('no_assertion_in_block', at);
      (block.asserts ?? []).forEach((check, assertIndex) => {
        if (!OPS.has(check?.op)) flag('assert_operator_invalid', `${at}.${assertIndex}`);
        if (typeof check?.pattern !== 'string' || !check.pattern) flag('empty_assertion_pattern', `${at}.${assertIndex}`);
        else if (check.op !== 'abs_found')
          try {
            new RegExp(check.pattern);
          } catch {
            flag('assertion_regex_invalid', `${at}.${assertIndex}`);
          }
        asserts.push({ id: check?.expectation_id, block: index, index: assertIndex });
      });
    } else if (block?.kind === 'SLEEP') {
      if (!(Number.isInteger(block.seconds) && block.seconds >= 1 && block.seconds <= 300)) flag('sleep_invalid', `${at}: 1 to 300 seconds`);
    } else if (block?.kind === 'STEP') {
      steps.push(index);
      if (!block.desc || !STEP_OBJECTS.has(block.E) || !block.F) flag('step_row_invalid', `${at}: desc, E and F`);
    } else flag('block_kind_unknown', `${at}: ${String(block?.kind)}`);
  });
  if (!asserts.length) flag('no_assertion_in_case', 'a case needs at least one check_point');
  const hatches = (item.escape_hatches ?? []).map((h) => h?.block_index).sort((a, b) => a - b);
  if (JSON.stringify(hatches) !== JSON.stringify(steps)) flag('escape_hatch_mismatch', 'one escape hatch for each STEP block, with a reason');
  // Each expectation of the recomposed case is asserted exactly once, and bound to that assert.
  const wanted = expectationIds(entry);
  const asserted = asserts.map((a) => a.id);
  const bindings = Array.isArray(item.expectation_binding) ? item.expectation_binding : [];
  if ([...asserted].sort().join() !== [...wanted].sort().join() || new Set(asserted).size !== asserted.length)
    flag('expectation_bijection_failed', `asserts must carry exactly ${wanted.join(', ')}`);
  for (const binding of bindings) {
    const target = asserts.find((a) => a.block === binding?.block_index && a.index === binding?.assert_index);
    if (!target || target.id !== binding?.expectation_id) flag('binding_target_invalid', String(binding?.expectation_id));
    if (!CLAIMS.has(binding?.claim_kind)) flag('claim_kind_invalid', String(binding?.expectation_id));
  }
  if (bindings.map((b) => b?.expectation_id).sort().join() !== [...wanted].sort().join())
    flag('expectation_binding_incomplete', 'bind every expectation id once');
  // Commands: each needs the server's verdict for this build; a miss is final.
  let terminal = null;
  const receipts = new Map((item.command_receipts ?? []).map((receipt) => [receipt?.command, receipt]));
  for (const command of deviceCommands(item)) {
    if (destructive.some((pattern) => pattern.test(command))) flag('destructive_command', command);
    const receipt = receipts.get(command);
    if (!receipt) flag('command_unverified', `${command}: check it with buildsite.command_check for ${build}`);
    else if (receipt.build !== undefined && receipt.build !== build) flag('command_receipt_other_build', command);
    else if (receipt.status === 'missing') {
      flag('command_not_in_tree', `${command}: ${build} has no such command`);
      terminal = 'unsupported_feature';
    } else if (receipt.status !== 'hit') flag('command_unverified', command);
    else if ((receipt.violations ?? []).length) flag('command_parameter_contract', `${command}: ${receipt.violations.join(', ')}`);
  }
  return { ok: violations.length === 0, terminal, violations };
}

export function gateBatch(batch) {
  const manifest = readJson(join(batch, 'manifest.json'));
  const machine = readJson(join(batch, 'machine_mindmap.json'));
  const destructive = destructivePatterns();
  const results = {};
  for (const manifestCase of manifest.cases) {
    const entry = machine.cases.find((c) => c.autoid === manifestCase.autoid);
    const path = join(batch, 'cases', `${manifestCase.autoid}.json`);
    if (!entry) results[manifestCase.autoid] = { ok: false, status: 'not_recomposed', violations: [] };
    else if (entry.bucket === 'true_gap')
      results[manifestCase.autoid] = { ok: false, status: 'needs_decision', violations: [{ code: 'source_incomplete', detail: (entry.proposal ?? []).join(' / ') }] };
    else if (!existsSync(path)) results[manifestCase.autoid] = { ok: false, status: 'not_written', violations: [] };
    else {
      const result = gateCase(readJson(path), entry, manifestCase, machine.build, destructive);
      results[manifestCase.autoid] = { ...result, status: result.ok ? 'gated' : result.terminal ?? 'rejected' };
    }
  }
  return { schema: 'apv.mindmap-compile.gate-report', source_sha256: manifest.source_sha256, build: machine.build, cases: results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [batch] = process.argv.slice(2);
  if (!batch) {
    console.error('usage: node gate.mjs <batch folder>');
    process.exit(2);
  }
  const report = gateBatch(batch);
  writeJson(join(batch, 'gate_report.json'), report);
  const counts = {};
  for (const result of Object.values(report.cases)) counts[result.status] = (counts[result.status] ?? 0) + 1;
  console.log(JSON.stringify({ counts, rejected: Object.entries(report.cases).filter(([, r]) => !r.ok && r.violations.length).map(([id, r]) => ({ autoid: id, violations: r.violations.slice(0, 8) })) }));
}
