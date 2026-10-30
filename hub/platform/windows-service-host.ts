// What the Service Control Manager starts for the Hub's Windows service (windows-service.ts), or, in the Task Scheduler
// fallback (windows-task.ts), what the task starts:
//   node <release>\hub\platform\windows-service-host.ts [--task] <definition.json>
// It reads the definition, then runs `programArguments` as its server child: under the SCM (runServiceHost, which must
// connect within the SCM's 30 s, so nothing slow comes first) or supervised by itself (runTaskHost). Its own diagnostics
// are fixed operation names and exit codes, appended to the definition's error log; never an argument, path or value.
import { appendFileSync } from 'node:fs';
import { PlatformError } from './errors.ts';
import { createServerSpawner, createWindowsDispatcher, loadKoffi } from './windows-scm.ts';
import { readServiceDefinition, runServiceHost, runTaskHost } from './windows-service.ts';

const args = process.argv.slice(2);
const task = args[0] === '--task';
const definitionPath = task ? args[1] : args[0];
try {
  if (definitionPath === undefined || args.length !== (task ? 2 : 1)) throw new PlatformError('用法：windows-service-host.ts [--task] <服务定义文件>');
  const definition = await readServiceDefinition(definitionPath);
  const log = (line: string) => {
    try {
      appendFileSync(definition.standardErrorPath, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // The log is best effort: the SCM's status and exit codes remain the record.
    }
  };
  const koffi = loadKoffi();
  const spawnServer = createServerSpawner(koffi);
  if (task) await runTaskHost({ definition, spawn: spawnServer, log });
  else process.exitCode = await runServiceHost(createWindowsDispatcher(koffi), { definition, spawn: spawnServer, log });
} catch (error) {
  process.stderr.write(`错误：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
