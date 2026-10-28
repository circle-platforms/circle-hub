// Synthetic contract coverage only; no service, credential store or business endpoint is opened.
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseTestOutput, report } from './test-summary.ts';

if (process.argv[2] === '--windows-readiness') {
  assert.equal(process.platform, 'win32');
  const missing = 'Windows 运行时打包、原生服务、凭证存储与规则沙箱尚未完成验收；当前不支持发布';
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\n${missing}\n`);
  console.error(missing);
  process.exitCode = 1;
} else {
  assert.equal(process.argv.length, 4);
  assert.equal(process.platform, process.argv[2], 'native operating system must match the target');
  assert.equal(process.arch, process.argv[3], 'native Node architecture must match the target');
  console.log(`原生 Node：${process.platform}/${process.arch} ${process.version}`);
  const result = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap', '--test-concurrency=2', 'contracts/**/*.test.ts',
  ], { encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 32 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  const output = parseTestOutput(result.stdout ?? '');
  const summary = report('原生合成契约检查（不代表服务或发布验收）', output);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary.markdown);
  for (const annotation of summary.annotations) console.log(annotation);
  assert.equal(result.error, undefined, 'test process completed without a spawn error or timeout');
  assert.equal(result.signal, null, 'test process was not killed');
  assert.equal(result.status, 0, 'test process succeeded');
  assert.equal(summary.ok, true, 'at least one test completed successfully');
  assert.equal(output.counts?.skipped, 0, 'skips cannot establish native support');
  assert.equal(output.skips.length, 0, 'skipped suites cannot establish native support');
  assert.equal(output.counts?.todo, 0, 'unfinished tests cannot establish native support');
  assert.ok((output.counts?.pass ?? 0) > 0, 'nonzero passing tests required');
}
