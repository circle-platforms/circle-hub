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
  writeHome({ home, profile, hubUrl: HUB_URL }, ENDPOINT, 'synthetic-hub-token');
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
    assert.match(lines.join('\n'), /声明限制 3/);
    // Spaced placeholder <原件 SHA-256> must become one synthetic token (not a redirect / extra arg).
    assert.ok(!report.results.some((r) => r.kind === 'check' && !r.ok && /原件 SHA-256|SHA-256/.test(r.name)));
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
