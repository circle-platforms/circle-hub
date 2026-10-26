// Drives the REAL Circle client in an Otty tab against a running Hub with a scripted model, and checks what the model was
// shown. The client is real, the Hub is real (the deployed one, reading the real systems), the answers of the model are
// scripted, so nothing leaves the machine and no model key is needed: this proves the whole path from the client to the
// Hub and back, and the Hub's results on real data; it does not prove the quality of a real model's review.
//
//   HUB_REAL_TOKEN=<token> node scripts/real/accept-circle.ts --scenario <module> --gold <json> --out <dir>
//        [--hub-url http://127.0.0.1:7420/mcp] [--circle-cli <dist/cli.js>] [--timeout-ms 300000]
//
// A scenario module exports `default (gold) => Scenario`. The gold file (kept outside Git, it names real documents) holds the
// expected answers written down independently of the Hub. The evidence (the model log with every tool result as the client
// forwarded it, the final screen, the checks) is written to --out, outside Git, because it holds real content.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeHome, type Endpoint } from './circle-home.ts';
import { createOtty } from './lib/otty.ts';
import { startCircle } from './lib/circle-session.ts';
import { parseLog, type Scenario } from './lib/accept.ts';
import { renderReport, type Check } from './lib/report.ts';
import { createScriptedModel } from './scripted-model.ts';

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

/** Only check verdicts and explicit safe count lines go to the terminal; detailed report fields stay in the file. */
export function summaryLines(checks: readonly Check[], counts: readonly string[] = []): string[] {
  const passed = checks.filter(check => check.ok).length;
  return [...checks.map(check => `${check.ok ? '相符' : '不符'}：${check.name}`), ...counts, `共 ${checks.length} 项核对，${passed} 项相符，${checks.length - passed} 项不符`];
}

export async function run(): Promise<number> {
  const scenarioPath = arg('scenario');
  const goldPath = arg('gold');
  const out = arg('out');
  const token = process.env.HUB_REAL_TOKEN;
  if (scenarioPath === undefined || goldPath === undefined || out === undefined || !token) {
    console.error('用法：HUB_REAL_TOKEN=… node scripts/real/accept-circle.ts --scenario <模块> --gold <json> --out <目录>');
    return 2;
  }
  const hubUrl = arg('hub-url') ?? 'http://127.0.0.1:7420/mcp';
  const circleCli = arg('circle-cli') ?? resolve(process.env.HOME ?? '', 'Public/circle-mcp-client/dist/cli.js');
  const timeoutMs = Number(arg('timeout-ms') ?? 300_000);
  const gold = JSON.parse(readFileSync(goldPath, 'utf8')) as unknown;
  const scenario = ((await import(pathToFileURL(resolve(scenarioPath)).href)) as { default: (gold: unknown) => Scenario }).default(gold);

  mkdirSync(out, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(join(tmpdir(), 'chub-accept-'));
  const logFile = join(out, `${scenario.name}.model-log.jsonl`);
  writeFileSync(logFile, '');
  const model = createScriptedModel({ respond: scenario.respond, model: 'scripted-model', logFile });
  await new Promise<void>((done) => model.listen(0, '127.0.0.1', done));
  const address = model.address();
  if (address === null || typeof address === 'string') throw new Error('the scripted model has no port');
  const endpoint: Endpoint = { protocol: 'anthropic', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'scripted', model: 'scripted-model', sources: ['scripted'] };
  const home = join(scratch, 'home');
  let screen = '';
  let done = false;
  try {
    const written = writeHome({ envFile: 'environment', home, provider: 'qwen', hubUrl, contextWindow: 1_000_000 }, endpoint, token);
    await scenario.prepare?.(written.workdir);
    const progress = (what: string): void => console.error(`[accept] ${what}`);
    progress(`脚本化模型在 127.0.0.1:${address.port}，专用 Circle 目录已写好`);
    const otty = createOtty();
    const session = await startCircle({ otty, home, cwd: written.workdir, cli: circleCli, title: `hub-accept-${scenario.name}` });
    progress('Circle 已启动，发送提示');
    const result = await session.ask(scenario.prompt, { timeoutMs });
    progress(`这轮结束：done=${result.done} sawBusy=${result.sawBusy}`);
    done = result.done;
    screen = session.screen({ scrollback: true });
    await session.exit();
  } finally {
    try { await new Promise<void>((closed) => model.close(() => closed())); }
    finally { rmSync(scratch, { recursive: true, force: true }); }
  }
  writeFileSync(join(out, `${scenario.name}.screen.txt`), screen);
  const turns = parseLog(readFileSync(logFile, 'utf8'));
  const checks: Check[] = [
    { area: scenario.area, name: '客户端把这轮对话走完', expected: '输入框回到空闲', actual: done ? '空闲' : '超时仍在处理', ok: done, evidence: [`${scenario.name}.screen.txt`] },
    ...scenario.check(turns),
  ];
  const report = renderReport({
    title: `真实 Circle 客户端验收：${scenario.name}`,
    generatedAt: new Date().toISOString(),
    checks,
    limits: [
      '模型的回答是脚本化的：这只证明从客户端到 Hub 再回到模型的整条路和 Hub 在真实数据上的结果，不证明真实模型的评审质量',
      '证据文件含真实内容，只放在本机，不进 Git',
      ...(scenario.limits ?? []),
    ],
    sections: scenario.sections,
  });
  writeFileSync(join(out, `${scenario.name}.report.md`), report);
  // Explicit count lines avoid printing detailed sections of unrelated scenarios.
  for (const line of summaryLines(checks, scenario.countLines)) console.log(line);
  return checks.every((c) => c.ok) ? 0 : 1;
}

if (import.meta.main) process.exitCode = await run();
