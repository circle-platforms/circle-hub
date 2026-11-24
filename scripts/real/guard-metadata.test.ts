import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { environment, decideRaw, decisionOf, parseToolCliDeclaration } from './guard-lib.ts';
import { writeHome } from './circle-home.ts';

const endpoint = { protocol: 'anthropic' as const, baseUrl: 'https://model.example.invalid', apiKey: 'synthetic', model: 'synthetic', sources: [] };
const cli = { schema: 'tool-cli@2', stdin: [], options: [{ name: 'sentence', required: true, kind: 'string', multiple: false, placeholder: '<file>', type: 'text' }] };

test('declared CLI identity and argument type override misleading source and placeholder spelling', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-metadata-'));
  try {
    const home = join(dir, 'home'); const { workdir } = writeHome({ home, profile: 'ops', hubUrl: 'http://127.0.0.1:7420/mcp' }, endpoint, 'synthetic');
    const tools = join(home, 'skills', 'synthetic', 'tools'); mkdirSync(tools, { recursive: true }); writeFileSync(join(tools, '..', 'SKILL.md'), '# Synthetic\n');
    const file = join(tools, 'entry.ts');
    writeFileSync(file, 'export const readTokenFromStdin = "arbitrary name";\n');
    writeFileSync(join(tools, 'entry.cli.json'), JSON.stringify(cli));
    const env = environment(home, workdir, 'ops-allow.declaration.json');
    const decide = async (command: string) => decisionOf(await decideRaw(env, JSON.stringify({ hook_event_name: 'PreToolUse', cwd: workdir, tool_name: 'execute', tool_input: { command } })));
    assert.deepEqual(await decide(`node '${file}' --sentence 'a sentence with / and spaces'`), {});
    const refused = await decide(`node '${file}' --unknown x`);
    assert.equal(refused.refusal?.category, 'invalid_parameters');
    assert.ok(refused.refusal?.fact); assert.ok(refused.refusal?.next_action);
    const labels = JSON.parse(readFileSync(join(home, 'hooks/ops-allow.declaration.json'), 'utf8')).errorLabels;
    assert.ok(refused.reason?.includes(labels.invalid_parameters));
    const pathCli = { ...cli, options: [{ ...cli.options[0], type: 'path', separator: ',', trimValues: true }] };
    writeFileSync(join(tools, 'entry.cli.json'), JSON.stringify(pathCli));
    assert.deepEqual(await decide(`node '${file}' --sentence 'one.json, two.json'`), {});
    const escape = await decide(`node '${file}' --sentence 'one.json, ../../outside'`);
    assert.equal(escape.decision, 'deny'); assert.equal(escape.refusal?.category, 'permission_denied'); assert.match(escape.refusal?.fact ?? '', /不在工作目录/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('machine declarations reject invalid fields, duplicate options and undeclared form pairs', () => {
  for (const bad of [
    { ...cli, extra: true }, { ...cli, options: [...cli.options, ...cli.options] },
    { ...cli, forms: [{ positional: null, pairs: [{ name: 'other', optional: true, placeholder: null }] }] },
    { ...cli, forms: [{ positional: null, pairs: [], extra: true }] },
    { ...cli, stdin: ['literal secret'] },
    { schema: 'tool-cli@1', stdin: [] },
  ]) assert.throws(() => parseToolCliDeclaration(bad));
  assert.equal(parseToolCliDeclaration(cli).options?.[0]?.type, 'text');
});

function releasedToolsFixture() {
  const dir = mkdtempSync(join(tmpdir(), 'guard-released-paths-'));
  const home = join(dir, 'home'); const { workdir } = writeHome({ home, profile: 'ops', hubUrl: 'http://127.0.0.1:7420/mcp' }, endpoint, 'synthetic');
  const tools = join(home, 'skills', 'case-compile', 'tools'); mkdirSync(tools, { recursive: true }); writeFileSync(join(tools, '..', 'SKILL.md'), '# Synthetic\n');
  for (const name of ['generate-workbook', 'normalize-mindmap']) {
    writeFileSync(join(tools, `${name}.ts`), 'export const syntheticEntry = true;');
    writeFileSync(join(tools, `${name}.cli.json`), readFileSync(new URL(`../../packs/workflow/case-compile/tools/${name}.cli.json`, import.meta.url)));
  }
  const env = environment(home, workdir, 'ops-allow.declaration.json');
  return { dir, home, workdir, tools, call: async (command: string) => decisionOf(await decideRaw(env, JSON.stringify({ hook_event_name: 'PreToolUse', cwd: workdir, tool_name: 'execute', tool_input: { command } }))), close: () => rmSync(dir, { recursive: true, force: true }) };
}

test('workbook CLI allows source-manifest mode without the contract, profile and inventory overrides', async () => {
  const f = releasedToolsFixture();
  try {
    const result = await f.call(`node '${join(f.tools, 'generate-workbook.ts')}' --run inputs --result inputs/result.json --submission inputs/submission.json --out delivery.xlsx`);
    assert.deepEqual(result, {});
  } finally { f.close(); }
});

test('all declared local workbook inputs and mindmap input enforce workspace containment', async () => {
  const f = releasedToolsFixture();
  try {
    const workbook = join(f.tools, 'generate-workbook.ts');
    const baseline = { run: 'inputs', result: 'inputs/result.json', submission: 'inputs/submission.json', contract: 'inputs/contract.json', profile: 'inputs/profile.json', inventory: 'inputs/inventory.json', out: 'delivery.xlsx' };
    for (const option of Object.keys(baseline)) {
      const values = { ...baseline, [option]: join(f.dir, 'outside') };
      const result = await f.call(`node '${workbook}' ${Object.entries(values).map(([key, value]) => `--${key} '${value}'`).join(' ')}`);
      assert.equal(result.decision, 'deny', option); assert.equal(result.refusal?.category, 'permission_denied', option);
    }
    const normalized = await f.call(`node '${join(f.tools, 'normalize-mindmap.ts')}' --in '${join(f.dir, 'outside')}' --out inputs/normalized.json`);
    assert.equal(normalized.decision, 'deny'); assert.equal(normalized.refusal?.category, 'permission_denied');
  } finally { f.close(); }
});
