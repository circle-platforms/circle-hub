import assert from 'node:assert/strict';
import { access, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { layoutAt } from './layout.ts';
import { checkNode, launchAgent, parsePrint, renderPlist, serviceDefinition, serviceEnvironment } from './launchd.ts';
import { runCommand } from './process.ts';
import { newSettingsFile, resolveSettings } from './settings.ts';
import { exit, ok, recordingRunner, removeDir, tempDir, type Call } from './test-support.ts';

const roots: string[] = [];
after(async () => {
  for (const root of roots) await removeDir(root);
});

const layout = layoutAt('/synthetic-homes/someone/Library/Application Support/circle-hub');
const settings = resolveSettings(newSettingsFile({ environment: 'shared', port: 7420 }), {});
const identity = { home: '/synthetic-homes/someone', user: 'someone', database: { port: 5432, name: 'circle_hub', role: 'circle_hub' } };

const EXPECTED_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Label</key>
	<string>io.github.circle-platforms.circle-hub</string>
	<key>ProgramArguments</key>
	<array>
		<string>/opt/homebrew/bin/node</string>
		<string>/synthetic-homes/someone/Library/Application Support/circle-hub/current/bin/circle-hub</string>
		<string>serve</string>
	</array>
	<key>WorkingDirectory</key>
	<string>/synthetic-homes/someone/Library/Application Support/circle-hub/current</string>
	<key>EnvironmentVariables</key>
	<dict>
		<key>CIRCLE_HUB_DATABASE_NAME</key>
		<string>circle_hub</string>
		<key>CIRCLE_HUB_DATABASE_PORT</key>
		<string>5432</string>
		<key>CIRCLE_HUB_DATABASE_SOCKET_DIR</key>
		<string>/synthetic-homes/someone/Library/Application Support/circle-hub/run</string>
		<key>CIRCLE_HUB_DATABASE_USER</key>
		<string>circle_hub</string>
		<key>CIRCLE_HUB_DATA_DIR</key>
		<string>/synthetic-homes/someone/Library/Application Support/circle-hub</string>
		<key>CIRCLE_HUB_KEYCHAIN_ACCOUNT</key>
		<string>vault-master-key</string>
		<key>CIRCLE_HUB_KEYCHAIN_SERVICE</key>
		<string>circle-hub</string>
		<key>CIRCLE_HUB_PORT</key>
		<string>7420</string>
		<key>HOME</key>
		<string>/synthetic-homes/someone</string>
		<key>PATH</key>
		<string>/usr/bin:/bin:/usr/sbin:/sbin</string>
		<key>USER</key>
		<string>someone</string>
	</dict>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>ExitTimeOut</key>
	<integer>30</integer>
	<key>Umask</key>
	<integer>63</integer>
	<key>StandardOutPath</key>
	<string>/synthetic-homes/someone/Library/Application Support/circle-hub/logs/hub.out.log</string>
	<key>StandardErrorPath</key>
	<string>/synthetic-homes/someone/Library/Application Support/circle-hub/logs/hub.err.log</string>
</dict>
</plist>
`;

test('the LaunchAgent plist for circle-hub serve matches the snapshot', () => {
  assert.equal(renderPlist(serviceDefinition(layout, settings, { node: '/opt/homebrew/bin/node', ...identity })), EXPECTED_PLIST);
});

test('the service environment carries only hub/config names under CIRCLE_HUB_ and no secret', () => {
  const env = serviceEnvironment(layout, settings, identity);
  for (const key of Object.keys(env)) assert.ok(key.startsWith('CIRCLE_HUB_') || ['HOME', 'PATH', 'USER'].includes(key), key);
  assert.ok(!Object.keys(env).some((key) => /PASSWORD|PASSWD|SECRET|TOKEN|CREDENTIAL|PRIVATE|API_KEY/.test(key)));
  assert.ok(!('CIRCLE_HUB_HOME' in env) && !('CIRCLE_HUB_LIBPQ_BIN' in env), 'platform-only names stay out of the server environment');
});

test('the service connects as the application role and never migrates; the owner is only the account that runs it', () => {
  const definition = serviceDefinition(layout, settings, { node: '/opt/homebrew/bin/node', ...identity, user: 'owner-account' });
  assert.deepEqual(definition.programArguments.slice(2), ['serve'], 'no --migrate and no --migrate-only');
  assert.equal(definition.environment.CIRCLE_HUB_DATABASE_USER, 'circle_hub');
  assert.equal(definition.environment.USER, 'owner-account');
});

test('plist text is escaped and control characters are refused', () => {
  const definition = serviceDefinition(layoutAt('/srv/a&b <c>'), settings, { node: '/usr/local/bin/node', ...identity });
  const text = renderPlist(definition);
  assert.ok(text.includes('<string>/srv/a&amp;b &lt;c&gt;/current</string>'));
  assert.throws(() => renderPlist({ ...definition, environment: { BAD: 'a\u0001b' } }), /控制字符/);
  assert.throws(() => renderPlist({ ...definition, label: 'bad label' }), /服务标签/);
});

test('plutil accepts the generated plist', { skip: process.platform === 'darwin' ? false : 'skipped: plutil is only on macOS' }, async () => {
  const dir = await tempDir();
  roots.push(dir);
  const { writeFile } = await import('node:fs/promises');
  const path = join(dir, 'agent.plist');
  await writeFile(path, EXPECTED_PLIST);
  await access('/usr/bin/plutil');
  const result = await runCommand('/usr/bin/plutil', ['-lint', path]);
  assert.equal(result.code, 0, result.stdout + result.stderr);
});

test('parsePrint reads state, pid and last exit code of launchctl print', () => {
  const output = [
    'gui/501/io.github.circle-platforms.circle-hub = {',
    '\tactive count = 1',
    '\tpath = /synthetic-homes/someone/Library/LaunchAgents/io.github.circle-platforms.circle-hub.plist',
    '\tstate = running',
    '',
    '\tpid = 51234',
    '\tlast exit code = (never exited)',
    '}',
  ].join('\n');
  assert.deepEqual(parsePrint(output), { running: true, pid: 51234, lastExit: '(never exited)' });
  assert.deepEqual(parsePrint('\tstate = not running\n\tlast exit code = 1\n'), { running: false, lastExit: '1' });
});

/** A fake launchctl that keeps its own loaded/running state. */
function fakeLaunchctl() {
  const state = { loaded: false, running: false };
  const recorder = recordingRunner(
    (call: Call) => {
      if (call.command !== '/bin/launchctl') return undefined;
      const [verb] = call.args;
      if (verb === 'print') return state.loaded ? ok(`\tstate = ${state.running ? 'running' : 'not running'}\n${state.running ? '\tpid = 99\n' : ''}`) : exit(113, 'Could not find service');
      if (verb === 'bootstrap') {
        state.loaded = true;
        state.running = true;
        return ok();
      }
      if (verb === 'bootout') {
        state.loaded = false;
        state.running = false;
        return ok();
      }
      if (verb === 'kickstart') {
        state.running = true;
        return ok();
      }
      return exit(64, 'unknown verb');
    },
    { real: false },
  );
  return { state, ...recorder };
}

test('install writes the plist and bootstraps; start, stop and uninstall use the gui domain', async () => {
  const directory = await tempDir();
  roots.push(directory);
  const fake = fakeLaunchctl();
  const agent = launchAgent({ label: settings.label, directory, uid: 501, runner: fake.runner });
  const definition = serviceDefinition(layout, settings, { node: '/opt/homebrew/bin/node', ...identity });
  assert.deepEqual(await agent.status(), { plist: agent.plist, installed: false, loaded: false, running: false });
  await assert.rejects(agent.start(), /还没安装/);

  await agent.install(definition);
  assert.equal(await readFile(agent.plist, 'utf8'), EXPECTED_PLIST);
  assert.equal((await stat(agent.plist)).mode & 0o777, 0o644);
  assert.deepEqual(fake.calls.at(-1)?.args, ['bootstrap', 'gui/501', agent.plist]);
  assert.deepEqual(await agent.status(), { plist: agent.plist, installed: true, loaded: true, running: true, pid: 99 });

  await agent.install(definition);
  assert.deepEqual(
    fake.calls.slice(-3).map((call) => call.args[0]),
    ['print', 'bootout', 'bootstrap'],
    'reinstall unloads the old definition first',
  );

  assert.equal(await agent.start(), false, 'already running');
  fake.state.running = false;
  assert.equal(await agent.start(), true);
  assert.deepEqual(fake.calls.at(-1)?.args, ['kickstart', 'gui/501/io.github.circle-platforms.circle-hub']);

  assert.equal(await agent.stop(), true);
  assert.deepEqual(fake.calls.at(-1)?.args, ['bootout', 'gui/501/io.github.circle-platforms.circle-hub']);
  assert.equal(await agent.stop(), false);
  assert.equal(await agent.start(), true, 'a stopped (unloaded) service is bootstrapped again');
  assert.deepEqual(fake.calls.at(-1)?.args, ['bootstrap', 'gui/501', agent.plist]);

  assert.equal(await agent.uninstall(), true);
  await assert.rejects(access(agent.plist));
  assert.equal(await agent.uninstall(), false);
  assert.ok(fake.calls.every((call) => call.command === '/bin/launchctl'));
});

test('a launchctl failure is reported with its output', async () => {
  const directory = await tempDir();
  roots.push(directory);
  const { runner } = recordingRunner((call) => (call.args[0] === 'print' ? exit(113) : exit(5, 'Bootstrap failed: 5: Input/output error')), { real: false });
  const agent = launchAgent({ label: settings.label, directory, uid: 501, runner });
  await assert.rejects(agent.install(serviceDefinition(layout, settings, { node: '/opt/homebrew/bin/node', ...identity })), /加载服务失败（launchctl 退出码 5）：Bootstrap failed/);
});

test('checkNode requires Node 24 or newer', async () => {
  const old = recordingRunner(() => ok('v22.11.0\n'), { real: false });
  await assert.rejects(checkNode('/fake/node', old.runner), /需要 Node 24/);
  const fine = recordingRunner(() => ok('v24.17.0\n'), { real: false });
  assert.equal(await checkNode('/fake/node', fine.runner), 'v24.17.0');
  assert.equal(await checkNode(process.execPath), process.version);
});
