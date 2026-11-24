// The Circle guard reads the declaration beside each tool: the options the texts teach for the booking have to pass it, written as taught and no other way.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { writeHome } from '../../../../scripts/real/circle-home.ts';
import { decideRaw, decisionOf, environment } from '../../../../scripts/real/guard-lib.ts';

const endpoint = { protocol: 'anthropic' as const, baseUrl: 'https://model.example.invalid', apiKey: 'synthetic', model: 'synthetic', sources: [] };
const TOOLS = ['open-compile', 'assemble-delivery'] as const;

test('the guard lets --booking-acquired, --keep-booking and --release-booking through with their one value, and refuses each without it or joined to it with =', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'booking-cli-'));
  try {
    const home = join(dir, 'home'); const { workdir } = writeHome({ home, profile: 'ops', hubUrl: 'http://127.0.0.1:7420/mcp' }, endpoint, 'synthetic');
    const tools = join(home, 'skills', 'case-compile', 'tools'); mkdirSync(tools, { recursive: true }); writeFileSync(join(tools, '..', 'SKILL.md'), '# Synthetic\n');
    for (const name of TOOLS) {
      writeFileSync(join(tools, `${name}.ts`), 'export const syntheticEntry = true;');
      writeFileSync(join(tools, `${name}.cli.json`), readFileSync(new URL(`./${name}.cli.json`, import.meta.url)));
    }
    const env = environment(home, workdir, 'ops-allow.declaration.json');
    const call = async (command: string) => decisionOf(await decideRaw(env, JSON.stringify({ hook_event_name: 'PreToolUse', cwd: workdir, tool_name: 'execute', tool_input: { command } })));
    const open = (extra: string) => `node '${join(tools, 'open-compile.ts')}' --hub %HUB_URL% --plumb %PLUMB_URL% --subject 'agile:mindmap:900001' --product 'widget' --build 'B1' --booking 'run_01aaaaaaaaaaaaaaaaaaaaaaaa'${extra} --out 'open-compile.json' <<'EOF'\n%HUB_TOKEN%\n%PLUMB_API_KEY%\n%JEV_API_KEY%\nEOF`;
    const deliver = (extra: string) => `node '${join(tools, 'assemble-delivery.ts')}' --hub %HUB_URL% --runs 'run_01cccccccccccccccccccccccc' --recompose 'run_01bbbbbbbbbbbbbbbbbbbbbbbb' --notes 'notes.json' --open 'open-compile.json' --out 'delivery'${extra} <<'EOF'\n%HUB_TOKEN%\nEOF`;
    for (const command of [open(''), open(' --booking-acquired yes'), deliver(''), deliver(' --keep-booking yes'), deliver(' --release-booking yes')]) assert.deepEqual(await call(command), {}, command);
    for (const command of [open(' --booking-acquired'), deliver(' --keep-booking'), deliver(' --release-booking'), deliver(' --keep-booking=yes'), deliver(' --release-booking=yes')]) {
      const refused = await call(command);
      assert.equal(refused.decision, 'deny', command); assert.equal(refused.refusal?.category, 'invalid_parameters', command);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
