// The Task Scheduler fallback of the Windows service: its task definition, and the same lifecycle contract over scripted
// schtasks.exe and PowerShell. The runner check registers, runs, ends and deletes a real task on an ephemeral Windows runner.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { ServiceDefinition } from './launchd.ts';
import type { CommandRunner } from './process.ts';
import { parseServiceDefinition, quoteWindowsArgument, splitWindowsCommandLine } from './windows-service.ts';
import { LOCAL_SERVICE_SID, renderTaskXml, TASK_FOLDER, taskArguments, windowsTaskAgent } from './windows-task.ts';

const RUNNER = process.platform === 'win32' && process.env.GITHUB_ACTIONS === 'true';
const RUNNER_ONLY = RUNNER ? false : 'needs an ephemeral Windows GitHub runner with administrator rights: it registers and deletes a real scheduled task';
const LABEL = 'io.github.circle-platforms.circle-hub';
const HOST = 'C:\\release\\hub\\platform\\windows-service-host.ts';

const definition = (directory: string): ServiceDefinition => ({
  label: LABEL, programArguments: ['C:\\node\\node.exe', 'C:\\release\\bin\\circle-hub', 'serve'], workingDirectory: 'C:\\release',
  environment: { CIRCLE_HUB_PORT: '7420' }, standardOutPath: join(directory, 'hub.out.log'), standardErrorPath: join(directory, 'hub.err.log'),
});

test('the task starts the host in task mode at boot as LocalService, without a time limit and as one instance', () => {
  const text = renderTaskXml(definition('C:\\svc'), HOST, 'C:\\svc\\x & y.json');
  for (const line of [
    '<?xml version="1.0" encoding="UTF-16"?>', '    <BootTrigger>', `      <UserId>${LOCAL_SERVICE_SID}</UserId>`, '      <RunLevel>LeastPrivilege</RunLevel>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>', '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '      <Command>C:\\node\\node.exe</Command>', '      <WorkingDirectory>C:\\release</WorkingDirectory>',
  ]) assert.ok(text.split('\r\n').includes(line), line);
  assert.equal(LOCAL_SERVICE_SID, 'S-1-5-19');
  assert.doesNotMatch(text, /S-1-5-18|HighestAvailable|<Password>|InteractiveToken/);
  // Arguments are XML-escaped Windows argv: the host, --task and the definition file.
  assert.ok(text.includes('<Arguments>&quot;C:\\release\\hub\\platform\\windows-service-host.ts&quot; &quot;--task&quot; &quot;C:\\svc\\x &amp; y.json&quot;</Arguments>'));
  assert.deepEqual(splitWindowsCommandLine(taskArguments(HOST, 'C:\\svc\\x & y.json')), [HOST, '--task', 'C:\\svc\\x & y.json']);
  assert.throws(() => renderTaskXml({ ...definition('C:\\svc'), label: 'a b' }, HOST, 'C:\\svc\\d.json'), /服务标签/);
});

/** Scripted schtasks.exe and PowerShell over one fake task. */
function fakeScheduler() {
  let task: { xml: string; state: string } | undefined;
  const calls: string[] = [];
  let endsLeft = 0;
  const runner: CommandRunner = async (command, args) => {
    const tool = command.split('\\').at(-1);
    if (tool === 'powershell.exe') {
      calls.push('state');
      assert.ok(args.at(-1)!.includes(`-TaskPath '${TASK_FOLDER}' -TaskName '${LABEL}'`));
      if (task === undefined) return { code: 1, stdout: '', stderr: 'No MSFT_ScheduledTask objects found' };
      if (task.state === 'Running' && endsLeft > 0 && --endsLeft === 0) task.state = 'Ready';
      return { code: 0, stdout: `${task.state}\r\n`, stderr: '' };
    }
    assert.equal(tool, 'schtasks.exe');
    const verb = args[0]!;
    calls.push(verb);
    assert.equal(args[2], `${TASK_FOLDER}${LABEL}`);
    if (verb === '/Query') return task === undefined ? { code: 1, stdout: '', stderr: 'ERROR: The system cannot find the file specified.' } : { code: 0, stdout: task.xml, stderr: '' };
    if (verb === '/Create') {
      const raw = await readFile(args[4]!);
      assert.deepEqual([...raw.subarray(0, 2)], [0xff, 0xfe], 'UTF-16 LE with a byte order mark');
      task = { xml: raw.toString('utf16le').slice(1), state: 'Ready' };
      return { code: 0, stdout: 'SUCCESS', stderr: '' };
    }
    if (task === undefined) return { code: 1, stdout: '', stderr: 'ERROR: missing' };
    if (verb === '/Run') { task.state = 'Running'; return { code: 0, stdout: 'SUCCESS', stderr: '' }; }
    if (verb === '/End') { endsLeft = 2; return { code: 0, stdout: 'SUCCESS', stderr: '' }; }
    if (verb === '/Delete') { task = undefined; return { code: 0, stdout: 'SUCCESS', stderr: '' }; }
    return { code: 1, stdout: '', stderr: `unexpected ${verb}` };
  };
  return { runner, calls, task: () => task, setTask: (value: { xml: string; state: string }) => { task = value; } };
}

async function directoryFor(t: { after(fn: () => Promise<void>): void }): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'hub-wintask-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('the fallback keeps the lifecycle contract: install registers and runs, stop ends, uninstall deletes', async (t) => {
  const directory = await directoryFor(t);
  const fake = fakeScheduler();
  const agent = windowsTaskAgent({ label: LABEL, directory, hostScript: HOST, runner: fake.runner, systemRoot: 'C:\\Windows', sleep: async () => {} });
  assert.equal(agent.service, `${TASK_FOLDER}${LABEL}`);
  assert.deepEqual(await agent.status(), { plist: agent.plist, installed: false, loaded: false, running: false });
  await assert.rejects(agent.start(), /服务还没安装/);
  assert.equal(await agent.stop(), false);
  await agent.install(definition(directory));
  assert.equal(parseServiceDefinition(await readFile(agent.plist, 'utf8')).label, LABEL);
  assert.ok(fake.task()!.xml.includes(`&quot;${agent.plist.replaceAll('&', '&amp;')}&quot;</Arguments>`));
  assert.deepEqual(await agent.status(), { plist: agent.plist, installed: true, loaded: true, running: true });
  assert.equal(await agent.start(), false);
  assert.equal(await agent.stop(), true);
  assert.equal((await agent.status()).running, false);
  assert.equal(await agent.start(), true);
  assert.equal(await agent.uninstall(), true);
  assert.equal(fake.task(), undefined);
  await assert.rejects(stat(agent.plist), { code: 'ENOENT' });
  assert.equal(await agent.uninstall(), false);
  assert.deepEqual(fake.calls.filter((call) => call.startsWith('/') && call !== '/Query'), ['/Create', '/Run', '/End', '/Run', '/End', '/Delete']);
});

test('a same-named task that does not point at this definition is never ended, replaced or deleted', async (t) => {
  const directory = await directoryFor(t);
  const fake = fakeScheduler();
  fake.setTask({ xml: '<Task><Actions><Exec><Arguments>&quot;C:\\other\\host.ts&quot; &quot;--task&quot; &quot;C:\\other\\d.json&quot;</Arguments></Exec></Actions></Task>', state: 'Running' });
  const agent = windowsTaskAgent({ label: LABEL, directory, hostScript: HOST, runner: fake.runner, systemRoot: 'C:\\Windows', sleep: async () => {} });
  await writeFile(agent.plist, '{}');
  for (const action of [() => agent.install(definition(directory)), () => agent.stop(), () => agent.uninstall(), () => agent.start()]) {
    await assert.rejects(action(), /不属于这个部署/);
  }
  assert.deepEqual(fake.calls.filter((call) => call.startsWith('/') && call !== '/Query'), []);
  assert.equal(quoteWindowsArgument(agent.plist).startsWith('"'), true);
});

test('runner check: the fallback task runs the host as LocalService, restarts nothing after an end and is deleted', { skip: RUNNER_ONLY, timeout: 180_000 }, async (t) => {
  const label = `circle-hub-synthetic-task-${process.pid}`;
  const directory = await mkdtemp(join(tmpdir(), 'hub-wintask-runner-'));
  const repository = fileURLToPath(new URL('../../', import.meta.url));
  const node = join(directory, 'node.exe');
  await copyFile(process.execPath, node);
  execFileSync('icacls.exe', [directory, '/grant', `*${LOCAL_SERVICE_SID}:(OI)(CI)M`], { encoding: 'utf8' });
  execFileSync('icacls.exe', [repository, '/grant', `*${LOCAL_SERVICE_SID}:(OI)(CI)RX`], { encoding: 'utf8' });
  const agent = windowsTaskAgent({ label, directory, hostScript: join(repository, 'hub', 'platform', 'windows-service-host.ts') });
  t.after(async () => {
    await agent.uninstall().catch(() => false);
    execFileSync('icacls.exe', [repository, '/remove:g', `*${LOCAL_SERVICE_SID}`], { encoding: 'utf8' });
    await rm(directory, { recursive: true, force: true, maxRetries: 5 });
  });
  const server = join(directory, 'server.mjs');
  await writeFile(server, `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(join(directory, 'started'))}, String(process.pid));\nsetInterval(() => {}, 1000);\n`);
  await agent.install({ label, programArguments: [node, server], workingDirectory: directory, environment: { CIRCLE_HUB_SYNTHETIC: '1' }, standardOutPath: join(directory, 'out.log'), standardErrorPath: join(directory, 'err.log') });
  const deadline = Date.now() + 60_000;
  while (!(await stat(join(directory, 'started')).then(() => true, () => false))) {
    if (Date.now() > deadline) assert.fail(`the server child did not start; host log: ${await readFile(join(directory, 'err.log'), 'utf8').catch(() => 'none')}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal((await agent.status()).running, true);
  assert.equal(await agent.stop(), true);
  assert.equal((await agent.status()).running, false);
  assert.equal(await agent.uninstall(), true);
  assert.equal((await agent.status()).loaded, false);
});
