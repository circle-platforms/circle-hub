import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { main as refreshMain, refreshGuards, writeHome, type Endpoint } from './circle-home.ts';
import { isDeclarationLimitedCommand, main as preflightMain, runPreflight } from './guard-preflight.ts';
import { environment, quote } from './guard-lib.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENDPOINT: Endpoint = {
  protocol: 'anthropic',
  baseUrl: 'https://model.example.invalid/v1',
  apiKey: 'synthetic-model-key',
  model: 'synthetic-model',
  sources: ['synthetic'],
};
const HUB_URL = 'https://192.0.2.10:7420/mcp';

function scratch(label: string): string {
  return mkdtempSync(join(tmpdir(), `guard-preflight-${label}-`));
}

function installSkills(home: string): void {
  const ccSrc = join(REPO_ROOT, 'packs/workflow/case-compile');
  const ccDst = join(home, 'skills/case-compile');
  mkdirSync(join(ccDst, 'tools'), { recursive: true });
  mkdirSync(join(ccDst, 'agents'), { recursive: true });
  writeFileSync(join(ccDst, 'SKILL.md'), readFileSync(join(ccSrc, 'SKILL.md')));
  cpSync(join(ccSrc, 'tools'), join(ccDst, 'tools'), { recursive: true });
  for (const name of ['compile-writer.md', 'compile-fidelity.md', 'compile-recomposer.md', 'compile-attributor.md']) {
    const src = join(ccSrc, 'agents', name);
    if (existsSync(src)) writeFileSync(join(ccDst, 'agents', name), readFileSync(src));
  }

  const plumbSrc = join(REPO_ROOT, 'packs/skill/plumb');
  const plumbDst = join(home, 'skills/plumb');
  mkdirSync(join(plumbDst, 'tools'), { recursive: true });
  writeFileSync(join(plumbDst, 'SKILL.md'), readFileSync(join(plumbSrc, 'SKILL.md')));
  cpSync(join(plumbSrc, 'tools'), join(plumbDst, 'tools'), { recursive: true });

  const rcSrc = join(ccSrc, 'recompose');
  const rcDst = join(home, 'skills/recompose');
  mkdirSync(join(rcDst, 'tools'), { recursive: true });
  writeFileSync(join(rcDst, 'SKILL.md'), readFileSync(join(rcSrc, 'SKILL.md')));
  cpSync(join(rcSrc, 'tools'), join(rcDst, 'tools'), { recursive: true });

  const jevSrc = join(REPO_ROOT, 'packs/workflow/knowledge-contribution/tools/jev');
  cpSync(jevSrc, join(home, 'skills/jev'), { recursive: true });

  const opSrc = join(REPO_ROOT, 'packs/workflow/knowledge-contribution/tools/operation-capture');
  cpSync(opSrc, join(home, 'skills/operation-capture'), { recursive: true });
}

function makeHome(dir: string, profile: 'skills' | 'ops', homeName: string): string {
  const home = join(dir, homeName);
  writeHome({ home, profile, hubUrl: HUB_URL, plumbUrl: 'https://192.0.2.60:8443', plumbModel: 'plumb-27b-0.5.0' }, ENDPOINT, 'synthetic-hub-token');
  installSkills(home);
  return home;
}

test('preflight passes on a fresh ops home whose path has spaces and Chinese', () => {
  const dir = scratch('ok');
  try {
    const home = makeHome(dir, 'ops', join('Application Support', '验收主目录'));
    const report = runPreflight(home);
    assert.equal(report.ok, true, report.mismatches.map((m) => `${m.name} want=${m.want} got=${m.got} ${m.reason ?? ''}`).join('\n'));
    assert.ok(report.allowCount > 10, `expected many allow cases, got ${report.allowCount}`);
    assert.equal(report.denyCount, 8);
    // operation-capture SKILL teaches enable/recover/disable; declaration only lists list/read/status/verify/flush/submit.
    assert.equal(report.mismatches.length, 0);
    assert.equal(report.declarationLimits.length, 3, report.declarationLimits.map((d) => d.name).join('\n'));
    assert.ok(report.declarationLimits.every((d) => /enable|recover|disable/.test(d.name)));
    const lines: string[] = [];
    assert.equal(preflightMain(['--home', home], (line) => lines.push(line)), 0);
    assert.match(lines.join('\n'), /核对相符|全部相符/);
    assert.match(lines.join('\n'), /声明里未放行且已拒绝 3|声明限制 3/);
    // Spaced placeholder <原件 SHA-256> must become one synthetic allow case that still passes.
    const shaCase = report.results.find((r) => /原件 SHA-256|SHA-256/.test(r.name));
    assert.ok(shaCase, 'expected a taught command that uses the spaced SHA-256 placeholder');
    assert.equal(shaCase.kind, 'check');
    assert.equal(shaCase.want, 'allow');
    assert.equal(shaCase.ok, true, shaCase.reason ?? shaCase.name);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight accepts single-quoted skill-dir docs with spaced and Chinese placeholder values', () => {
  const dir = scratch('quoted');
  try {
    const home = makeHome(dir, 'ops', join('Application Support', '验收主目录'));
    const skillDir = join(home, 'skills', 'case-compile');
    // Overlay the post-3d9 teaching shape without requiring that pack tip on this branch.
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      [
        '# case-compile',
        '',
        '```sh',
        "node '<技能目录>/tools/task-brief.ts' --role '<用例重组|脚本编写|保真核对|失败分析>' --case '<用例或范围>' --brief '<简报或输入路径>' --out '<目标路径>' --task-file '<任务文件路径>' [--note '<补充>']",
        "node '<技能目录>/tools/check-plan.ts' --file '<计划或判断JSON>'",
        "node '<技能目录>/tools/submit-plans.ts' --hub %HUB_URL% --run '<脚本编写编号>' --model '<模型>' --plans '<自动化用例目录>' <<'EOF'",
        '%HUB_TOKEN%',
        'EOF',
        '```',
        '',
        "元模板：`node '<技能目录>/tools/<脚本>.ts' --选项 值`",
        '',
      ].join('\n'),
    );
    const report = runPreflight(home);
    assert.equal(
      report.mismatches.length,
      0,
      report.mismatches.map((m) => `${m.name} want=${m.want} got=${m.got} ${m.reason ?? ''}`).join('\n'),
    );
    assert.ok(
      report.results.some((r) => r.kind === 'check' && r.want === 'allow' && r.ok && /task-brief/.test(r.name)),
      'expected allow case from single-quoted task-brief teaching',
    );
    assert.ok(
      report.results.some((r) => r.kind === 'check' && r.want === 'allow' && r.ok && /check-plan/.test(r.name)),
      'expected meta-template expansion to check-plan',
    );
    assert.equal(report.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declaration limit uses the scripts[].subcommands list, not keywords', () => {
  const dir = scratch('decl');
  try {
    const home = makeHome(dir, 'ops', 'home');
    const env = environment(home, join(home, 'work'), 'ops-allow.declaration.json');
    const script = quote(join(home, 'skills', 'operation-capture', 'operation.ts'));
    assert.equal(isDeclarationLimitedCommand(env, `node ${script} enable --session s`), true);
    assert.equal(isDeclarationLimitedCommand(env, `node ${script} recover --session s`), true);
    assert.equal(isDeclarationLimitedCommand(env, `node ${script} disable --session s`), true);
    assert.equal(isDeclarationLimitedCommand(env, `node ${script} read --session s --sha a`), false);
    assert.equal(isDeclarationLimitedCommand(env, `node ${script} list --session s`), false);
    // A subcommand that is neither in the declaration nor a known keyword still counts as limited.
    assert.equal(isDeclarationLimitedCommand(env, `node ${script} zzz-not-a-keyword --session s`), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hook crash, empty output and non-JSON count as error mismatches, not allow', () => {
  const dir = scratch('hook-error');
  try {
    const home = makeHome(dir, 'ops', 'home');
    const entry = join(home, 'hooks', 'ops-allow.mjs');
    writeFileSync(entry, 'throw new Error("synthetic hook crash");\n');
    const crash = runPreflight(home);
    assert.equal(crash.ok, false);
    assert.ok(
      crash.mismatches.some((m) => m.got === 'error'),
      `expected error mismatches after crash, got: ${crash.mismatches.map((m) => `${m.name}:${m.got}`).join('; ') || '(none)'}`,
    );

    writeFileSync(entry, 'process.stdout.write("");\n');
    const empty = runPreflight(home);
    assert.equal(empty.ok, false);
    assert.ok(empty.mismatches.some((m) => m.got === 'error' && /没有输出/.test(m.reason ?? '')));

    writeFileSync(entry, 'process.stdout.write("not-json");\n');
    const badJson = runPreflight(home);
    assert.equal(badJson.ok, false);
    assert.ok(badJson.mismatches.some((m) => m.got === 'error' && /不是 JSON/.test(m.reason ?? '')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declaration-limited command that the hook allows is a mismatch', () => {
  const dir = scratch('decl-allow');
  try {
    const home = makeHome(dir, 'ops', 'home');
    // Force every execute to allow so declaration-limited taught commands fail the preflight (G2).
    writeFileSync(join(home, 'hooks', 'ops-allow.mjs'), 'process.stdout.write(JSON.stringify({decision:"allow"}));\n');
    const report = runPreflight(home);
    assert.equal(report.ok, false);
    assert.ok(
      report.mismatches.some((m) => m.kind === 'declaration-limit' && m.want === 'deny' && m.got === 'allow'),
      `expected declaration-limit allow mismatches, got: ${report.mismatches.map((m) => `${m.kind}:${m.name}:${m.got}`).join('; ') || '(none)'}`,
    );
    assert.equal(report.declarationLimits.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight fails when the installed guard still looks for the old stdin helper name', () => {
  const dir = scratch('stale');
  try {
    const home = makeHome(dir, 'ops', 'home');
    const libPath = join(home, 'hooks', 'guard-lib.ts');
    const lib = readFileSync(libPath, 'utf8');
    // Simulate the round-30 accident: installed discovery only recognizes the retired helper name.
    assert.match(lib, /tokenFromStdin\|readTokenFromStdin/);
    writeFileSync(libPath, lib.replaceAll('tokenFromStdin|readTokenFromStdin', 'tokenFromStdin'));
    const report = runPreflight(home);
    assert.equal(report.ok, false);
    assert.ok(
      report.mismatches.some((m) => m.want === 'allow' && m.got === 'deny'),
      `expected allow→deny mismatches, got: ${report.mismatches.map((m) => m.name).join('; ') || '(none)'}`,
    );
    const lines: string[] = [];
    assert.equal(preflightMain(['--home', home], (line) => lines.push(line)), 1);
    assert.match(lines.join('\n'), /不符/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh-guards dry-run changes nothing; --apply updates guards and keeps settings', () => {
  const dir = scratch('refresh');
  try {
    const home = makeHome(dir, 'skills', join('带 空格', 'home'));
    const settingsBefore = readFileSync(join(home, 'settings.json'), 'utf8');
    const secretsBefore = readFileSync(join(home, 'secrets.json'), 'utf8');
    const hooksJsonBefore = readFileSync(join(home, 'hooks.json'), 'utf8');
    const libBefore = readFileSync(join(home, 'hooks', 'guard-lib.ts'), 'utf8');

    writeFileSync(join(home, 'hooks', 'guard-lib.ts'), `${libBefore}\n// stale marker\n`);

    const dry = refreshGuards(home, { apply: false });
    assert.equal(dry.apply, false);
    assert.ok(dry.changes.some((c) => c.relative === 'hooks/guard-lib.ts' && c.status === 'change'));
    assert.match(readFileSync(join(home, 'hooks', 'guard-lib.ts'), 'utf8'), /stale marker/);
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), settingsBefore);

    const lines: string[] = [];
    assert.equal(refreshMain(['refresh-guards', '--home', home, '--apply'], {}, (line) => lines.push(line)), 0);
    assert.match(lines.join('\n'), /核对通过/);
    assert.equal(readFileSync(join(home, 'settings.json'), 'utf8'), settingsBefore);
    assert.equal(readFileSync(join(home, 'secrets.json'), 'utf8'), secretsBefore);
    assert.equal(readFileSync(join(home, 'hooks.json'), 'utf8'), hooksJsonBefore);
    assert.doesNotMatch(readFileSync(join(home, 'hooks', 'guard-lib.ts'), 'utf8'), /stale marker/);
    assert.equal(runPreflight(home).ok, true);
    assert.ok(lines.some((line) => line.includes('已备份 hooks/')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh-guards --apply restores the backup when post-install preflight fails', () => {
  const dir = scratch('restore');
  try {
    const home = makeHome(dir, 'ops', 'home');
    const libPath = join(home, 'hooks', 'guard-lib.ts');
    const markedLib = `${readFileSync(libPath, 'utf8')}\n// before-apply\n`;
    writeFileSync(libPath, markedLib);

    // A taught command with a pipe must be denied; preflight therefore fails after any guard rewrite.
    const badSkill = join(home, 'skills', 'bad-pipe');
    mkdirSync(join(badSkill, 'tools'), { recursive: true });
    writeFileSync(
      join(badSkill, 'tools', 'noop.ts'),
      `const OPTIONS = { out: true };\nif (import.meta.main) process.stdout.write('ok\\n');\n`,
    );
    writeFileSync(join(badSkill, 'SKILL.md'), `# bad-pipe\n\n\`\`\`sh\nnode <技能目录>/tools/noop.ts --out out/x | cat\n\`\`\`\n`);
    assert.equal(runPreflight(home).ok, false);

    const result = refreshGuards(home, { apply: true });
    assert.equal(result.preflightOk, false);
    assert.equal(result.restored, true);
    assert.match(readFileSync(libPath, 'utf8'), /before-apply/);
    assert.ok(result.backup && existsSync(result.backup));
    assert.equal(existsSync(join(home, 'hooks.apply-in-progress')), false, 'marker cleared after controlled restore');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('refresh-guards --apply refuses when a prior apply left hooks.apply-in-progress', () => {
  const dir = scratch('incomplete');
  try {
    const home = makeHome(dir, 'skills', 'home');
    const libPath = join(home, 'hooks', 'guard-lib.ts');
    const before = `${readFileSync(libPath, 'utf8')}\n// pristine-before-incomplete\n`;
    writeFileSync(libPath, before);
    const priorBackup = join(home, 'hooks.bak.prior-complete');
    mkdirSync(priorBackup, { recursive: true });
    writeFileSync(join(priorBackup, 'guard-lib.ts'), before);
    writeFileSync(join(home, 'hooks.apply-in-progress'), `${priorBackup}\n`, { mode: 0o600 });
    // Corrupt the live hooks so a mistaken re-apply would back up the bad state.
    writeFileSync(libPath, `${before}\n// partial-write\n`);

    const lines: string[] = [];
    const result = refreshGuards(home, { apply: true, out: (line) => lines.push(line) });
    assert.equal(result.preflightOk, false);
    assert.equal(result.restored, false);
    assert.equal(result.backup, undefined);
    assert.match(lines.join('\n'), /上次刷新未完成/);
    assert.match(lines.join('\n'), /恢复命令：/);
    assert.ok(lines.some((line) => line.includes(priorBackup)));
    assert.match(readFileSync(libPath, 'utf8'), /partial-write/, 'live hooks untouched when refusing');
    assert.equal(existsSync(join(home, 'hooks.apply-in-progress')), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('preflight discovers plumb tools under tools/ and validates skills-profile plumb commands', () => {
  const dir = scratch('plumb-skills');
  try {
    const home = makeHome(dir, 'skills', 'home');
    const report = runPreflight(home);
    assert.equal(report.ok, true, report.mismatches.map((m) => `${m.name} want=${m.want} got=${m.got} ${m.reason ?? ''}`).join('\n'));
    assert.ok(report.results.some((r) => /plumb\/SKILL\.md.*tools\/plumb\.ts models/.test(r.name) && r.want === 'allow' && r.ok));
    assert.ok(report.results.some((r) => /fidelity-plumb\.ts/.test(r.name) && r.want === 'allow' && r.ok));
    assert.ok(report.results.some((r) => /cmd-select-plumb\.ts/.test(r.name) && r.want === 'allow' && r.ok));
    assert.ok(report.results.some((r) => /cmd-verify-plumb\.ts/.test(r.name) && r.want === 'allow' && r.ok));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
