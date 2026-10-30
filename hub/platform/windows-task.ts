// The fallback the owner named (2026-10-30) for the case where runner CI shows that koffi cannot serve the SCM dispatcher: a
// Task Scheduler task that starts at boot and runs the same host in task mode (runTaskHost in windows-service.ts), with
// the same LaunchAgent contract. Changes go through schtasks.exe with an XML task definition, as argv without a shell; only
// the running state is read through PowerShell's ScheduledTasks module, whose state names do not depend on the display
// language (schtasks prints them translated). What this fallback cannot match, and says so: Task Scheduler has no
// per-service virtual account, so the task runs as NT AUTHORITY\LocalService, an identity other local services share; a
// stop ends the host, and with its Job the server, at once (no 30 s graceful stop); the host itself restarts the server
// RESTART_DELAY_MS after any exit. Selected explicitly (windowsTaskAgent), never as a silent replacement for the service.
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PlatformError } from './errors.ts';
import { exists, writeFileAtomic } from './files.ts';
import type { LaunchAgent, ServiceDefinition, ServiceStatus } from './launchd.ts';
import { runCommand, tailLines, windowsToolEnvironment, type CommandRunner } from './process.ts';
import { quoteWindowsArgument, renderServiceDefinition } from './windows-service.ts';

const LABEL = /^[A-Za-z0-9._-]{1,128}$/;
/** Task folder of the Hub's tasks. */
export const TASK_FOLDER = '\\circle-hub\\';
/** NT AUTHORITY\LocalService. */
export const LOCAL_SERVICE_SID = 'S-1-5-19';

function xml(text: string): string {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(text)) throw new PlatformError('任务定义里有 XML 不允许的控制字符');
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function unxml(text: string): string {
  return text.replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&amp;', '&');
}

/** The arguments of the task's action: the host script in task mode and the definition file. */
export function taskArguments(hostScript: string, definitionPath: string): string {
  return [hostScript, '--task', definitionPath].map(quoteWindowsArgument).join(' ');
}

/**
 * The task: a boot trigger, LocalService with least privilege, no time limit, one instance, no battery or idle conditions,
 * and the host as its action. Task Scheduler reads UTF-16; the caller writes this text with a byte order mark.
 */
export function renderTaskXml(definition: ServiceDefinition, hostScript: string, definitionPath: string): string {
  if (!LABEL.test(definition.label)) throw new PlatformError('服务标签只能含字母、数字、点、下划线和连字符');
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    '  <RegistrationInfo>',
    '    <Description>Circle Hub（circle-hub serve），只监听本机</Description>',
    '  </RegistrationInfo>',
    '  <Triggers>',
    '    <BootTrigger>',
    '      <Enabled>true</Enabled>',
    '    </BootTrigger>',
    '  </Triggers>',
    '  <Principals>',
    '    <Principal id="Author">',
    `      <UserId>${LOCAL_SERVICE_SID}</UserId>`,
    '      <RunLevel>LeastPrivilege</RunLevel>',
    '    </Principal>',
    '  </Principals>',
    '  <Settings>',
    '    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>',
    '    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>',
    '    <AllowHardTerminate>true</AllowHardTerminate>',
    '    <StartWhenAvailable>true</StartWhenAvailable>',
    '    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>',
    '    <IdleSettings>',
    '      <StopOnIdleEnd>false</StopOnIdleEnd>',
    '      <RestartOnIdle>false</RestartOnIdle>',
    '    </IdleSettings>',
    '    <AllowStartOnDemand>true</AllowStartOnDemand>',
    '    <Enabled>true</Enabled>',
    '    <Hidden>false</Hidden>',
    '    <RunOnlyIfIdle>false</RunOnlyIfIdle>',
    '    <WakeToRun>false</WakeToRun>',
    '    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>',
    '    <Priority>7</Priority>',
    '    <RestartOnFailure>',
    '      <Interval>PT1M</Interval>',
    '      <Count>999</Count>',
    '    </RestartOnFailure>',
    '  </Settings>',
    '  <Actions Context="Author">',
    '    <Exec>',
    `      <Command>${xml(definition.programArguments[0]!)}</Command>`,
    `      <Arguments>${xml(taskArguments(hostScript, definitionPath))}</Arguments>`,
    `      <WorkingDirectory>${xml(definition.workingDirectory)}</WorkingDirectory>`,
    '    </Exec>',
    '  </Actions>',
    '</Task>',
    '',
  ].join('\r\n');
}

export interface WindowsTaskAgentOptions {
  label: string;
  directory: string;
  hostScript: string;
  runner?: CommandRunner;
  /** Directory of schtasks.exe and PowerShell; default the SystemRoot of the caller's environment. */
  systemRoot?: string;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The Task Scheduler fallback of a deployment, as a `LaunchAgent`; `service` is the task's full name. */
export function windowsTaskAgent(options: WindowsTaskAgentOptions): LaunchAgent {
  if (!LABEL.test(options.label)) throw new PlatformError('服务标签只能含字母、数字、点、下划线和连字符');
  const runner = options.runner ?? runCommand;
  const systemRoot = options.systemRoot ?? String(windowsToolEnvironment().SystemRoot);
  const env = windowsToolEnvironment({ SystemRoot: systemRoot });
  const schtasks = `${systemRoot}\\System32\\schtasks.exe`;
  const powershell = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  const sleep = options.sleep ?? pause;
  const now = options.now ?? Date.now;
  const service = `${TASK_FOLDER}${options.label}`;
  const plist = join(options.directory, `${options.label}.json`);
  const taskFile = join(options.directory, `${options.label}.task.xml`);
  const run = async (args: string[], action: string) => {
    const result = await runner(schtasks, args, { env, timeoutMs: 60_000 });
    if (result.code !== 0) throw new PlatformError(`${action}失败（schtasks 退出码 ${result.code}）：${tailLines(result.stderr || result.stdout) || '没有输出'}`, '以管理员身份运行 circle-hub service 命令');
    return result;
  };
  /** The registered definition, or undefined when there is no such task. */
  const registered = async (): Promise<string | undefined> => {
    const result = await runner(schtasks, ['/Query', '/TN', service, '/XML'], { env, timeoutMs: 60_000 });
    return result.code === 0 ? result.stdout : undefined;
  };
  const ensureOwned = (definition: string | undefined): void => {
    if (definition === undefined) return;
    const args = /<Arguments>([^<]*)<\/Arguments>/.exec(definition)?.[1];
    if (args === undefined || !unxml(args).toLowerCase().endsWith(quoteWindowsArgument(plist).toLowerCase())) {
      throw new PlatformError('计划任务里的同名任务不属于这个部署（参数没有指向这个服务定义），不结束、不删除也不覆盖', '管理员核对这个任务的来源后再处理');
    }
  };
  /** Running, Ready, Queued, Disabled or Unknown: ScheduledTasks' state names, the same in every display language. */
  const state = async (): Promise<string> => {
    const script = `(Get-ScheduledTask -TaskPath '${TASK_FOLDER}' -TaskName '${options.label}' -ErrorAction Stop).State.ToString()`;
    const result = await runner(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { env, timeoutMs: 60_000 });
    const value = result.stdout.trim();
    if (result.code !== 0 || !['Running', 'Ready', 'Queued', 'Disabled', 'Unknown'].includes(value)) throw new PlatformError(`无法读取计划任务状态：${tailLines(result.stderr || result.stdout) || '没有输出'}`);
    return value;
  };
  const waitEnded = async (): Promise<void> => {
    const deadline = now() + 30_000;
    while ((await state()) === 'Running') {
      if (now() >= deadline) throw new PlatformError('计划任务没有在 30 秒内结束');
      await sleep(250);
    }
  };
  const status = async (): Promise<ServiceStatus> => {
    const installed = await exists(plist);
    if ((await registered()) === undefined) return { plist, installed, loaded: false, running: false };
    const current = await state();
    return { plist, installed, loaded: current === 'Running' || current === 'Queued', running: current === 'Running' };
  };
  return {
    plist,
    service,
    status,
    async install(definition) {
      if (definition.label !== options.label) throw new PlatformError('服务标签不一致');
      const text = renderServiceDefinition(definition);
      const task = renderTaskXml(definition, options.hostScript, plist);
      const current = await registered();
      ensureOwned(current);
      if (current !== undefined && (await state()) === 'Running') {
        await run(['/End', '/TN', service], '结束旧任务');
        await waitEnded();
      }
      await writeFileAtomic(plist, text, 0o644);
      // Task Scheduler reads the XML as UTF-16 LE with a byte order mark.
      await writeFile(taskFile, Buffer.from(`\ufeff${task}`, 'utf16le'), { mode: 0o644 });
      await run(['/Create', '/TN', service, '/XML', taskFile, '/F'], '登记计划任务');
      await run(['/Run', '/TN', service], '启动计划任务');
    },
    async uninstall() {
      const installed = await exists(plist);
      const current = await registered();
      ensureOwned(current);
      if (current === undefined && !installed) return false;
      if (current !== undefined) {
        if ((await state()) === 'Running') {
          await run(['/End', '/TN', service], '结束任务');
          await waitEnded();
        }
        await run(['/Delete', '/TN', service, '/F'], '删除计划任务');
      }
      await rm(plist, { force: true });
      await rm(taskFile, { force: true });
      return true;
    },
    async start() {
      if (!(await exists(plist))) throw new PlatformError('服务还没安装', '先运行 circle-hub service install');
      const current = await registered();
      if (current === undefined) throw new PlatformError('服务定义在，但计划任务里没有这个任务', '运行 circle-hub service install');
      ensureOwned(current);
      if ((await state()) === 'Running') return false;
      await run(['/Run', '/TN', service], '启动计划任务');
      return true;
    },
    async stop() {
      const current = await registered();
      ensureOwned(current);
      if (current === undefined || (await state()) !== 'Running') return false;
      await run(['/End', '/TN', service], '结束任务');
      await waitEnded();
      return true;
    },
  };
}
