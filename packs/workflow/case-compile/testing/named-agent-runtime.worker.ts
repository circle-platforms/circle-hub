import assert from 'node:assert/strict';
import { parentPort, workerData } from 'node:worker_threads';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { stage } from '../pack-files.ts';
import { SUBAGENT_ROLES, subagentTypeFor } from '../functions/subagent-roles.ts';

if (parentPort) {
  const root = mkdtempSync(join(tmpdir(), 'cc-named-runtime-'));
  let runtime: any;
  let reply: { roles: number } | { error: string };
  try {
    const home = join(root, 'home'), workspace = join(root, 'work'), userHome = join(root, 'user');
    for (const dir of [home, workspace, userHome]) mkdirSync(dir, { mode: 0o700 });
    const skillsRoot = join(userHome, '.agents', 'skills');
    mkdirSync(skillsRoot, { recursive: true, mode: 0o700 });
    await stage(join(skillsRoot, 'case-compile'));
    const load = (name: string) => import(pathToFileURL(join(workerData.app, 'dist', `${name}.js`)).href);
    const [{ AgentRuntime }, { defaultSettings }, { emptyUsage }] = await Promise.all(['runtime', 'settings', 'types'].map(load));
    const observed = new Map<string, { tools: string[]; system: string }>();
    let parentStep = 0;
    const model = {
      model: 'synthetic-named-role', sideRequests: false, contextWindow: 1_000_000,
      async complete(request: any) {
        const first = request.messages.find((m: any) => m.role === 'user' && !m.internal)?.content;
        if (first === 'synthetic root') {
          const tool_calls = parentStep++ === 0 ? SUBAGENT_ROLES.map(role => ({ id: role.agentName, name: 'task', args: { subagent_type: subagentTypeFor(role), description: JSON.stringify({ role: role.agentName }) } })) : [];
          return { message: { id: `parent-${parentStep}`, role: 'assistant', content: tool_calls.length ? '' : 'synthetic complete', tool_calls, completion: { reason: tool_calls.length ? 'tool_calls' : 'stop' } }, usage: emptyUsage() };
        }
        const input = JSON.parse(first);
        observed.set(input.role, { tools: request.tools.map((t: any) => t.name).sort(), system: request.system });
        return { message: { id: `child-${input.role}`, role: 'assistant', content: `synthetic ${input.role} done`, completion: { reason: 'stop' } }, usage: emptyUsage() };
      },
    };
    const settings = defaultSettings(); settings.auth.model = model.model; settings.update_check = false;
    runtime = new AgentRuntime({ workspace, home, userHome, settings, model, headless: true, integrations: false, bundledExtensions: false, approve: async () => 'approve' });
    assert.equal(existsSync(join(home, 'knowledge', 'knowledge.sqlite')), false);
    runtime.policy.setMode(runtime.session.id, 'auto');
    await runtime.harness.run('synthetic root');
    assert.equal(observed.size, SUBAGENT_ROLES.length);
    for (const role of SUBAGENT_ROLES) {
      const actual = observed.get(role.agentName)!;
      assert.deepEqual(actual.tools, [...role.tools].sort(), role.agentName);
      assert.ok(actual.system.includes(role.body.trim()), role.agentName);
      assert.ok(!actual.system.includes('<技能目录>'), role.agentName);
    }
    const failed = runtime.harness.messages.filter((m: any) => m.role === 'tool' && m.status === 'error');
    assert.deepEqual(failed, []);
    reply = { roles: observed.size };
  } catch (error) {
    reply = { error: error instanceof Error ? error.message : String(error) };
  } finally {
    await runtime?.close(false);
    rmSync(root, { recursive: true, force: true });
  }
  parentPort.postMessage(reply!);
}
