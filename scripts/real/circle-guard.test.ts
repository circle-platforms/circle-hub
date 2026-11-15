import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeHome, type Endpoint, type Profile } from './circle-home.ts';
import { buildTaskBrief } from '../../packs/workflow/case-compile/tools/task-brief.ts';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const ENDPOINT: Endpoint = {
  protocol: 'anthropic',
  baseUrl: 'https://model.example.invalid/v1',
  apiKey: 'synthetic-model-key',
  model: 'synthetic-model',
  sources: ['synthetic'],
};
const HUB_URL = 'https://127.0.0.1:7420/mcp';
const ALT_HUB_URL = 'https://192.0.2.50:7420/mcp';
const RUN_ID = 'run_01arz3ndektsv4rrffq69g5fav';
const RUN_ID_2 = 'run_01000000000000000000000000';

function installRealSkillSubsets(home: string) {
  const ccSrc = join(REPO_ROOT, 'packs/workflow/case-compile');
  const ccDst = join(home, 'skills/case-compile');
  mkdirSync(join(ccDst, 'tools'), { recursive: true });
  writeFileSync(join(ccDst, 'SKILL.md'), readFileSync(join(ccSrc, 'SKILL.md'), 'utf8'));
  cpSync(join(ccSrc, 'tools'), join(ccDst, 'tools'), { recursive: true });

  const rcSrc = join(ccSrc, 'recompose');
  const rcDst = join(home, 'skills/recompose');
  mkdirSync(join(rcDst, 'tools'), { recursive: true });
  writeFileSync(join(rcDst, 'SKILL.md'), readFileSync(join(rcSrc, 'SKILL.md'), 'utf8'));
  cpSync(join(rcSrc, 'tools'), join(rcDst, 'tools'), { recursive: true });

  const kcTools = join(REPO_ROOT, 'packs/workflow/knowledge-contribution/tools');
  for (const name of ['jev', 'operation-capture']) {
    cpSync(join(kcTools, name), join(home, 'skills', name), { recursive: true });
  }
}

function createGuardHarness(profile: Exclude<Profile, 'review'>, opts: { homeName?: string; withSkills?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'circle-guard-test-'));
  const home = join(dir, opts.homeName ?? 'home');
  const written = writeHome({ home, profile, hubUrl: HUB_URL }, ENDPOINT, 'synthetic-hub-token');
  if (opts.withSkills !== false) installRealSkillSubsets(home);
  const hook = join(home, written.files.find((f) => f === 'hooks/ops-allow.mjs' || f === 'hooks/skills-only.mjs')!);
  const gen = join(home, written.files.find((f) => f.endsWith('-gen.mjs'))!);
  const regen = spawnSync(process.execPath, [gen], { cwd: written.workdir, encoding: 'utf8', timeout: 5000 });
  assert.equal(regen.status, 0, regen.stderr);

  const runHook = (payload: unknown, cwd = written.workdir) => {
    const child = spawnSync(process.execPath, [hook], {
      cwd,
      input: JSON.stringify(payload),
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout) as { decision?: 'allow' | 'deny' | 'ask'; reason?: string };
  };

  const call = (tool_name: string, tool_input: Record<string, unknown>, extra: { cwd?: string; paths?: string[]; session_id?: string } = {}) =>
    runHook(
      {
        event: 'before_tool',
        cwd: extra.cwd ?? written.workdir,
        tool_name,
        tool_input,
        paths: extra.paths ?? [],
        ...(extra.session_id !== undefined ? { session_id: extra.session_id } : {}),
      },
      extra.cwd ?? written.workdir,
    );

  const exec = (command: string, extra: { cwd?: string; fields?: Record<string, unknown> } = {}) =>
    call('execute', { command, ...(extra.fields ?? {}) }, { cwd: extra.cwd });

  const assertAllowed = (res: { decision?: string; reason?: string }, msg?: string) => {
    if (profile === 'ops') assert.deepEqual(res, {}, msg);
    else assert.equal(res.decision, 'allow', msg);
  };

  const assertRefused3 = (res: { decision?: string; reason?: string }, whatPattern: RegExp, howPattern?: RegExp) => {
    assert.equal(res.decision, 'deny');
    const lines = String(res.reason ?? '').split('\n');
    assert.ok(lines.length >= 3, `expected at least 3 lines, got:\n${res.reason}`);
    assert.match(lines[0], whatPattern, `line 1: ${lines[0]}`);
    const how = lines.slice(1, -1).join('\n');
    if (howPattern) assert.match(how, howPattern, `how: ${how}`);
    assert.match(lines[lines.length - 1], /^规则全文：.*ALLOWED\.md（用 read_file 读）$/, `last line: ${lines[lines.length - 1]}`);
    if (!how.includes("<<'EOF'")) assert.equal(lines.length, 3, `expected exact 3-line refusal without heredoc, got:\n${res.reason}`);
  };

  return {
    dir,
    home,
    hook,
    gen,
    workdir: written.workdir,
    allowedPath: join(home, 'hooks', 'ALLOWED.md'),
    allowedText: () => readFileSync(join(home, 'hooks', 'ALLOWED.md'), 'utf8'),
    skillPath: (name: string, ...parts: string[]) => join(home, 'skills', name, ...parts),
    runHook,
    call,
    exec,
    assertAllowed,
    assertRefused3,
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

test('guard-offline A/D: single-quote grammar, space-in-home, 3-line fixes, and refusal on double quotes & backslashes', () => {
  for (const profile of ['ops', 'skills'] as const) {
    const h = createGuardHarness(profile, { homeName: 'Application Support/circle home' });
    try {
      const tb = `'${h.skillPath('case-compile', 'tools/task-brief.ts')}'`;
      // Valid single-quoted script path and single-quoted Chinese / space values pass.
      h.assertAllowed(
        h.exec(`node ${tb} --role '脚本编写' --case case-01 --brief briefs/0.md --out 'plans/case 01.json' --task-file tasks/0.md --note '加一条 中文说明' --round 2 --run case-compile-run --brief-json briefs/0.json`),
        `${profile}: single quotes allowed`,
      );

      // Comma-separated --prior-* paths inside workdir pass, traversal outside workdir fails.
      h.assertAllowed(
        h.exec(`node ${tb} --role '脚本编写' --case case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md --prior-plans 'plans/r1/0.json,-,plans/r2/0.json' --prior-returns -`),
      );
      h.assertRefused3(
        h.exec(`node ${tb} --role '脚本编写' --case case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md --prior-plans 'plans/r1/0.json,../outside.json'`),
        /--prior-plans/,
      );

      // Double quotes are uniformly refused with a 3-line refusal suggesting single-quoted command.
      const dbl = h.exec(`node "${h.skillPath('case-compile', 'tools/task-brief.ts')}" --role "脚本编写" --case case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md`);
      h.assertRefused3(dbl, /不支持英文双引号/, /这次可以这样写：node '.*task-brief\.ts'.*--role '脚本编写'/);

      // Backslash escapes, bare non-ASCII, concatenated quotes, --opt=val are all refused cleanly.
      h.assertRefused3(h.exec(`node ${tb} --role '脚本编写' --case case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md --note foo\\ bar`), /反斜杠/);
      h.assertRefused3(h.exec(`node ${tb} --role 脚本编写 --case case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md`), /英文单引号/);
      h.assertRefused3(h.exec(`node ${tb} --role '脚本''编写' --case case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md`), /紧连/);
      h.assertRefused3(h.exec(`node ${tb} --role '脚本编写' --case=case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md`), /--case=…/);

      // All 3.20.3 readTokenFromStdin tools (assemble-delivery, download-returns, check-record) work with single-quoted args & EOF heredoc.
      const ad = `'${h.skillPath('case-compile', 'tools/assemble-delivery.ts')}'`;
      h.assertAllowed(h.exec(`node ${ad} --hub ${HUB_URL} --runs ${RUN_ID},${RUN_ID_2} --notes notes.json --out dist --recompose ${RUN_ID} --name '合成 交付' <<'EOF'\n%HUB_TOKEN%\nEOF`));
      const dr = `'${h.skillPath('case-compile', 'tools/download-returns.ts')}'`;
      h.assertAllowed(h.exec(`node ${dr} --hub ${HUB_URL} --run ${RUN_ID} --out returns --wait 30 <<'EOF'\n%HUB_TOKEN%\nEOF`));
      const cr = `'${h.skillPath('recompose', 'tools/check-record.ts')}'`;
      h.assertAllowed(h.exec(`node ${cr} --file records --run recompose-run`));
      // Missing required stdin heredoc or unexpected heredoc are refused.
      h.assertRefused3(h.exec(`node ${ad} --hub ${HUB_URL} --runs ${RUN_ID} --notes notes.json --out dist`), /从标准输入读令牌/);
      h.assertRefused3(h.exec(`node ${cr} --file records <<'EOF'\n%HUB_TOKEN%\nEOF`), /不读标准输入/);
      // Internal non-CLI helpers are excluded from ALLOWED.md and blocked from execution.
      assert.ok(!h.allowedText().includes('authoring-brief.ts'));
      assert.ok(!h.allowedText().includes('rework-inputs.ts'));
      assert.ok(!h.allowedText().includes('workspace-path.ts'));
      h.assertRefused3(h.exec(`node '${h.skillPath('case-compile', 'tools/authoring-brief.ts')}'`), /辅助库|未声明|可执行的工具/);
    } finally {
      h.close();
    }
  }
});

test('guard-offline B/C: virtual readOnly files, ALLOWED.md access, shell alternatives, and sleep bounds', () => {
  const hOps = createGuardHarness('ops');
  const hSkills = createGuardHarness('skills');
  try {
    const virtualLog = '/large_tool_results/0123456789abcdef01234567.txt';
    const virtualBg = '/background_jobs/job_01/run-12.log';
    for (const h of [hOps, hSkills]) {
      h.assertAllowed(h.call('read_file', { file_path: virtualLog }, { paths: [virtualLog] }));
      h.assertAllowed(h.call('grep', { path: virtualBg, pattern: 'err' }, { paths: [virtualBg] }));
      h.assertRefused3(h.call('ls', { path: '/large_tool_results' }, { paths: ['/large_tool_results'] }), /不在工作目录/);
      h.assertRefused3(h.call('read_file', { file_path: '/large_tool_results/not24hex.txt' }, { paths: ['/large_tool_results/not24hex.txt'] }), /不在工作目录/);
      h.assertAllowed(h.call('read_file', { file_path: 'hooks/ALLOWED.md' }, { paths: [h.allowedPath] }));
      h.assertRefused3(h.exec(`cat ${virtualLog}`), /read_file|cat|只放行技能目录里的脚本/, /read_file/);
      h.assertRefused3(h.exec('ls -la'), /只放行技能目录里的脚本/, /ls/);
      h.assertRefused3(h.exec('sed -i s/a/b/ x.txt'), /只放行技能目录里的脚本/, /edit_file/);
    }
    // write_file works in workdir on ops, denied on virtual paths / ALLOWED.md / outside work, and denied everywhere on skills.
    hOps.assertAllowed(hOps.call('write_file', { file_path: 'out/a.md' }, { paths: [join(hOps.workdir, 'out/a.md')] }));
    hOps.assertRefused3(hOps.call('write_file', { file_path: virtualLog }, { paths: [virtualLog] }), /不在工作目录/);
    hOps.assertRefused3(hOps.call('write_file', { file_path: hOps.allowedPath }, { paths: [hOps.allowedPath] }), /不在工作目录/);
    hSkills.assertRefused3(hSkills.call('write_file', { file_path: 'out/a.md' }, { paths: [join(hSkills.workdir, 'out/a.md')] }), /不在这个配置放行/);

    // sleep bounds on ops vs completely blocked on skills.
    hOps.assertAllowed(hOps.exec('sleep 10'));
    hOps.assertAllowed(hOps.exec('sleep 600'));
    hOps.assertRefused3(hOps.exec('sleep 0'), /1 到 600/);
    hOps.assertRefused3(hOps.exec('sleep 601'), /1 到 600/);
    hOps.assertRefused3(hOps.exec("sleep 10 <<'EOF'\n%HUB_TOKEN%\nEOF"), /不读标准输入/);
    hSkills.assertRefused3(hSkills.exec('sleep 10'), /只放行技能目录里的脚本/);
  } finally {
    hOps.close();
    hSkills.close();
  }
});

test('operation-capture subcommands & parameter checks enforce declared bounds', () => {
  const h = createGuardHarness('ops');
  try {
    const op = h.skillPath('operation-capture', 'operation.ts');
    h.assertAllowed(h.exec(`node ${op} list --session s1`));
    h.assertAllowed(h.exec(`node ${op} read --session s1 --sha ${'a'.repeat(64)}`));
    h.assertAllowed(h.exec(`node ${op} status --session s1`));
    h.assertAllowed(h.exec(`node ${op} verify --session s1`));
    h.assertAllowed(h.exec(`node ${op} flush --session s1`));
    h.assertAllowed(h.exec(`node ${op} submit --session s1 --proposals props.json --product prod --build '2026.11' --model synthetic-model`));
    // enable and unknown subcommands stay blocked even if present in source.
    h.assertRefused3(h.exec(`node ${op} enable --session s1 --hub ${HUB_URL} --token-file tok.txt`), /不在放行的/);
    h.assertRefused3(h.exec(`node ${op} unknown --session s1`), /不在放行的/);
  } finally {
    h.close();
  }
});

test('test-bed booking stays rule blocks release/force_release/unregister/register in both ops and skills', () => {
  for (const profile of ['ops', 'skills'] as const) {
    const h = createGuardHarness(profile, { withSkills: false });
    try {
      for (const action of ['release', 'force_release', 'unregister', 'register', 'Release', 'FORCE_RELEASE']) {
        for (const pack of ['test-bed', 'test-bed@1.3.3', 'TEST-BED@2.0.0']) {
          h.assertRefused3(h.call('hub_start_run', { pack, parameters: { action } }), /释放或变更测试环境的预订登记/, /预订保持原样/);
          h.assertRefused3(
            h.call('hub_start_run', { pack, parameters: JSON.stringify({ action }) }),
            /释放或变更测试环境的预订登记/,
          );
        }
      }
      for (const action of ['search', 'facts', 'help', 'acquire', 'extend']) {
        h.assertAllowed(h.call('hub_start_run', { pack: 'test-bed@1.3.3', parameters: { action } }));
      }
      h.assertAllowed(h.call('hub_start_run', { pack: 'other-pack@1.0.0', parameters: { action: 'release' } }));
    } finally {
      h.close();
    }
  }
});

test('SQLite circle.sqlite subagent lookup blocks subagent question while allowing main session', () => {
  const h = createGuardHarness('ops', { withSkills: false });
  try {
    const db = new DatabaseSync(join(h.home, 'circle.sqlite'));
    try {
      db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_id TEXT)');
      db.prepare('INSERT INTO sessions (id, parent_id) VALUES (?, ?)').run('sess_main_01', null);
      db.prepare('INSERT INTO sessions (id, parent_id) VALUES (?, ?)').run('sess_sub_01', 'sess_main_01');
    } finally {
      db.close();
    }

    h.assertAllowed(h.call('question', { questions: [] }, { session_id: 'sess_main_01' }));
    h.assertAllowed(h.call('question', { questions: [] }, { session_id: "bad'id;--" }));
    h.assertRefused3(h.call('question', { questions: [] }, { session_id: 'sess_sub_01' }), /子代理不向使用者提问/, /给主代理的报告/);
  } finally {
    h.close();
  }
});

test('ops sibling ^work-ops trust, execute key hygiene, skills/ symlink, globWithin, hooks.json delegation, --hub mismatch, and --schemas', () => {
  const hOps = createGuardHarness('ops');
  const hSkills = createGuardHarness('skills', { withSkills: false });
  try {
    // 1. Sibling ^work-ops is auto-trusted on ops, rejected on skills; non-matching sibling rejected on ops.
    const opsSibling = join(hOps.dir, 'work-ops-run29');
    const badSibling = join(hOps.dir, 'other-dir');
    mkdirSync(opsSibling, { recursive: true });
    mkdirSync(badSibling, { recursive: true });
    hOps.assertAllowed(hOps.call('read_file', { file_path: 'a.txt' }, { cwd: opsSibling, paths: [join(opsSibling, 'a.txt')] }));
    hOps.assertRefused3(hOps.call('read_file', { file_path: 'a.txt' }, { cwd: badSibling, paths: [join(badSibling, 'a.txt')] }), /trusted_folders/);

    const skillsSibling = join(hSkills.dir, 'work-ops-run29');
    mkdirSync(skillsSibling, { recursive: true });
    hSkills.assertRefused3(hSkills.call('read_file', { file_path: 'a.txt' }, { cwd: skillsSibling, paths: [join(skillsSibling, 'a.txt')] }), /trusted_folders/);

    // 2. execute field shape & unexpected env/cwd keys refused.
    const fetchRun = hOps.skillPath('case-compile', 'tools/fetch-run.ts');
    hOps.assertRefused3(hOps.exec(`node ${fetchRun} --hub ${HUB_URL} --run ${RUN_ID} --out r <<'EOF'\n%HUB_TOKEN%\nEOF`, { fields: { env: {} } }), /execute 参数形状无效/);
    hOps.assertRefused3(hOps.exec(`node ${fetchRun} --hub ${ALT_HUB_URL} --run ${RUN_ID} --out r <<'EOF'\n%HUB_TOKEN%\nEOF`), /Hub 的地址/);

    // 3. Delegated skill hooks.json works under ops (ask stays ask even though normal allow is {}).
    const jev = hOps.skillPath('jev', 'jev.ts');
    const jevAsk = hOps.exec(`node ${jev} ask --hub ${HUB_URL} --model synthetic-jev --input ask.json --send case --out jev-out <<'EOF'\n%JEV_API_KEY%\n%HUB_TOKEN%\nEOF`);
    assert.equal(jevAsk.decision, 'ask');

    // 4. globWithin on ops catches directory symlink traversal inside workdir.
    const outside = join(hOps.dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'synthetic');
    symlinkSync(outside, join(hOps.workdir, 'linked'), 'dir');
    hOps.assertRefused3(hOps.call('glob', { pattern: 'linked/*', path: hOps.workdir }, { paths: [hOps.workdir] }), /软链接/);

    // 5. local-tools/<pack>/tools/*.ts allowed on ops only (while helper lib excluded).
    const localDir = join(hOps.workdir, 'local-tools/demo/tools');
    mkdirSync(localDir, { recursive: true });
    const localCli = join(localDir, 'run.ts');
    const localLib = join(localDir, 'helper.ts');
    writeFileSync(localCli, "// node demo/tools/run.ts --out <文件路径>\nconst idx = process.argv.indexOf('--out');\n");
    writeFileSync(localLib, 'export const HELPER = 1;\n');
    hOps.assertAllowed(hOps.exec(`node ${localCli} --out out.json`));
    hOps.assertRefused3(hOps.exec(`node ${localCli} --out ../outside.json`), /不在工作目录/);
    hOps.assertRefused3(hOps.exec(`node ${localLib}`), /未声明|辅助库/);

    // 6. --schemas output produces valid JSON schema entries without hub property.
    const schemasOut = spawnSync(process.execPath, [hOps.gen, '--schemas'], { cwd: hOps.workdir, encoding: 'utf8', timeout: 5000 });
    assert.equal(schemasOut.status, 0, schemasOut.stderr);
    const schemas = JSON.parse(schemasOut.stdout) as Array<{ name: string; description: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }>;
    const fetchSchema = schemas.find((s) => s.name === 'case-compile__fetch-run');
    assert.ok(fetchSchema, 'includes case-compile__fetch-run schema');
    assert.equal(fetchSchema.inputSchema.properties.hub, undefined, '--hub omitted from model schema');
    assert.deepEqual(fetchSchema.inputSchema.required, ['run', 'out']);
    assert.match(fetchSchema.description, /令牌由客户端/);
    assert.ok(existsSync(hOps.allowedPath));
  } finally {
    hOps.close();
    hSkills.close();
  }
});

test('every command-form second line across all execute refusals passes replay, while non-computable cases list installed tools instead of fake templates', () => {
  for (const profile of ['ops', 'skills'] as const) {
    const h = createGuardHarness(profile, { homeName: 'Application Support/circle home' });
    try {
      const tb = `'${h.skillPath('case-compile', 'tools/task-brief.ts')}'`;
      const ad = `'${h.skillPath('case-compile', 'tools/assemble-delivery.ts')}'`;
      const cr = `'${h.skillPath('recompose', 'tools/check-record.ts')}'`;
      const fr = `'${h.skillPath('case-compile', 'tools/fetch-run.ts')}'`;
      const op = `'${h.skillPath('operation-capture', 'operation.ts')}'`;
      const undeclared = `'${h.skillPath('case-compile', 'tools/authoring-brief.ts')}'`;
      const outside = `'${join(h.dir, 'outside.ts')}'`;
      writeFileSync(join(h.dir, 'outside.ts'), 'export {};\n');

      const verifyRefusalSecondLine = (label: string, res: { decision?: string; reason?: string }, expectCommandForm: boolean) => {
        assert.equal(res.decision, 'deny', `${label}: expected deny, got ${JSON.stringify(res)}`);
        const lines = String(res.reason ?? '').split('\n');
        assert.ok(lines.length >= 3, `${label}: expected >= 3 lines, got:\n${res.reason}`);
        assert.match(lines[lines.length - 1], /^规则全文：.*ALLOWED\.md（用 read_file 读）$/, `${label}: line 3`);
        const how = lines.slice(1, -1).join('\n');
        assert.doesNotMatch(how, /<技能目录>|<脚本>/, `${label}: second line must not emit fake angle-bracket template:\n${how}`);
        assert.doesNotMatch(how, /^写法：\s*node\b/, `${label}: second line must not start with template 写法：node:\n${how}`);
        if (expectCommandForm) {
          assert.ok(how.startsWith('这次可以这样写：'), `${label}: expected runnable command on line 2, got:\n${how}`);
          const cmd = how.slice('这次可以这样写：'.length);
          h.assertAllowed(h.exec(cmd), `${label} replay failed for command:\n${cmd}`);
        } else if (how.startsWith('这次可以这样写：')) {
          const cmd = how.slice('这次可以这样写：'.length);
          h.assertAllowed(h.exec(cmd), `${label} unexpected command-form line 2 must still pass replay:\n${cmd}`);
        }
      };

      // Undeclared internal helper: must list actual installed declared scripts instead of a copyable template.
      const undeclaredRes = h.exec(`node ${undeclared}`);
      verifyRefusalSecondLine('undeclared helper', undeclaredRes, false);
      const undeclaredHow = String(undeclaredRes.reason ?? '').split('\n').slice(1, -1).join('\n');
      assert.match(undeclaredHow, /已装.*脚本|assemble-delivery\.ts|task-brief\.ts/, `undeclared helper should list installed scripts:\n${undeclaredHow}`);

      // Outside skills / missing file / non-interpreter / node -e / ambiguous or incomplete relative path.
      verifyRefusalSecondLine('outside script', h.exec(`node ${outside}`), false);
      verifyRefusalSecondLine('missing script', h.exec(`node '${h.skillPath('case-compile', 'tools/no-such.ts')}'`), false);
      verifyRefusalSecondLine('node -e', h.exec("node -e 'console.log(1)'"), false);
      verifyRefusalSecondLine('unknown interpreter', h.exec('python3 x.py'), false);
      verifyRefusalSecondLine('ambiguous relative download-run', h.exec(`node tools/download-run.ts --hub ${HUB_URL} --run ${RUN_ID} --out r <<'EOF'\n%HUB_TOKEN%\nEOF`), false);
      verifyRefusalSecondLine('unique relative missing required opt', h.exec('node tools/task-brief.ts'), false);
      verifyRefusalSecondLine('missing required --runs', h.exec(`node ${ad} --hub ${HUB_URL} --notes notes.json --out dist <<'EOF'\n%HUB_TOKEN%\nEOF`), false);
      verifyRefusalSecondLine('invalid --run id', h.exec(`node ${fr} --hub ${HUB_URL} --run bad_id --out r <<'EOF'\n%HUB_TOKEN%\nEOF`), false);
      verifyRefusalSecondLine('bad subcommand', h.exec(`node ${op} bogus --session s1`), false);

      // Unique relative script whose remaining arguments are already complete & valid -> computable passing command!
      verifyRefusalSecondLine('unique relative complete check-record', h.exec('node recompose/tools/check-record.ts --file records --run recompose-run'), true);

      // Fixable syntax / quoting / --hub / heredoc mistakes -> second line is a concrete command that passes replay!
      verifyRefusalSecondLine('double quotes', h.exec(`node "${h.skillPath('case-compile', 'tools/task-brief.ts')}" --role "脚本编写" --case c1 --brief b.md --out p.json --task-file t.md`), true);
      verifyRefusalSecondLine('bare Chinese', h.exec(`node ${tb} --role 脚本编写 --case c1 --brief b.md --out p.json --task-file t.md`), true);
      verifyRefusalSecondLine('backslash space', h.exec(`node ${tb} --role '脚本编写' --case c1 --brief b.md --out p.json --task-file t.md --note foo\\ bar`), true);
      verifyRefusalSecondLine('adjacent quotes', h.exec(`node ${tb} --role '脚本''编写' --case c1 --brief b.md --out p.json --task-file t.md`), true);
      verifyRefusalSecondLine('equals option', h.exec(`node ${tb} --role '脚本编写' --case=c1 --brief b.md --out p.json --task-file t.md`), true);
      verifyRefusalSecondLine('optional invalid prior-plans', h.exec(`node ${tb} --role '脚本编写' --case c1 --brief b.md --out p.json --task-file t.md --prior-plans ../outside.json`), true);
      verifyRefusalSecondLine('wrong hub url', h.exec(`node ${fr} --hub ${ALT_HUB_URL} --run ${RUN_ID} --out r <<'EOF'\n%HUB_TOKEN%\nEOF`), true);
      verifyRefusalSecondLine('missing heredoc', h.exec(`node ${ad} --hub ${HUB_URL} --runs ${RUN_ID} --notes n.json --out dist`), true);
      verifyRefusalSecondLine('unexpected heredoc', h.exec(`node ${cr} --file records <<'EOF'\n%HUB_TOKEN%\nEOF`), true);

      if (profile === 'ops') {
        verifyRefusalSecondLine('sleep 0', h.exec('sleep 0'), true);
        verifyRefusalSecondLine('sleep 601', h.exec('sleep 601'), true);
        verifyRefusalSecondLine('sleep extra heredoc', h.exec("sleep 10 <<'EOF'\n%HUB_TOKEN%\nEOF"), true);
      } else {
        verifyRefusalSecondLine('sleep disallowed on skills', h.exec('sleep 10'), false);
      }
    } finally {
      h.close();
    }
  }
});

interface ExtractedDocCommand {
  source: string;
  kind: 'shell' | 'text' | 'inline';
  raw: string;
  isMetaTemplate?: boolean;
}

/**
 * Structurally extracts every taught `node` CLI command from a markdown file:
 * fenced `sh`/`bash`/`shell` command statements (including `<<'EOF'` heredocs),
 * `text` fence command lines (with optional `label: ` prefix), and inline backticked
 * `node ...` spans in prose.
 */
function extractTaughtCommands(markdown: string, sourceLabel: string): ExtractedDocCommand[] {
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const out: ExtractedDocCommand[] = [];
  let fence: '' | 'sh' | 'text' | 'other' = '';

  const readHeredoc = (firstLine: string, startIndex: number): { command: string; nextIndex: number } => {
    if (!firstLine.endsWith("<<'EOF'")) return { command: firstLine, nextIndex: startIndex };
    const collected = [firstLine];
    let j = startIndex + 1;
    while (j < lines.length && lines[j] !== 'EOF') {
      collected.push(lines[j]);
      j += 1;
    }
    assert.equal(lines[j], 'EOF', `${sourceLabel}:${startIndex + 1} missing heredoc EOF terminator`);
    collected.push('EOF');
    return { command: collected.join('\n'), nextIndex: j };
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (fence === '') {
      const open = /^```([^\s`]*)/.exec(line);
      if (open) {
        const lang = open[1].toLowerCase();
        fence = lang === 'sh' || lang === 'bash' || lang === 'shell' ? 'sh' : lang === 'text' ? 'text' : 'other';
        continue;
      }
      assert.doesNotMatch(line, /\bnode\s+<[^>]+>/, `${sourceLabel}:${i + 1} has unquoted placeholder in node command`);
      for (const m of line.matchAll(/`([^`\n]+)`/g)) {
        const span = m[1].trim();
        if (!span.startsWith('node ')) continue;
        if (span === 'node -e') {
          assert.match(line, /严禁|禁止/, `${sourceLabel}:${i + 1} unexpected node -e mention outside prohibition: ${line}`);
          continue;
        }
        const isMetaTemplate = span === "node '<技能目录>/tools/<脚本>.ts' --选项 值";
        out.push({ source: `${sourceLabel}:${i + 1}`, kind: 'inline', raw: span, isMetaTemplate });
      }
      continue;
    }

    if (/^```\s*$/.test(line)) {
      fence = '';
      continue;
    }
    if (fence === 'other') continue;

    if (fence === 'sh') {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      assert.ok(trimmed.startsWith('node '), `${sourceLabel}:${i + 1} unexpected shell block line: ${line}`);
      const { command, nextIndex } = readHeredoc(trimmed, i);
      i = nextIndex;
      out.push({ source: `${sourceLabel}:${i + 1}`, kind: 'shell', raw: command });
      continue;
    }

    const textMatch = /^(?:[^:\n`]+:\s*)?(node\s.+)$/.exec(line.trim());
    if (textMatch) {
      const { command, nextIndex } = readHeredoc(textMatch[1], i);
      i = nextIndex;
      out.push({ source: `${sourceLabel}:${i + 1}`, kind: 'text', raw: command });
    }
  }
  return out;
}

const DOC_PLACEHOLDERS: Record<string, string> = {
  '用例重组|脚本编写|保真核对|失败分析': '脚本编写',
  '脚本编写编号': RUN_ID,
  '脚本合并编号': RUN_ID,
  '合并或上机编号': RUN_ID,
  '用例重组编号': RUN_ID,
  模型: 'synthetic model',
  轮次: '2',
  '逗号分隔autoid': 'case_1,case_2',
  '用例或范围': 'case_1',
  autoid: 'case_1',
  补充: '补充 说明',
  前缀: 'case_1',
  '8位摘要': '12345678',
  '计划或判断JSON': 'plans dir/plan 01.json',
  计划JSON相对路径: 'plans dir/plan 01.json',
  目标计划相对路径: 'plans dir/plan 01.json',
  目标自动化用例相对路径: 'plans dir/case 01.json',
  verdict相对路径: 'audit dir/case_1.12345678.verdict.json',
  brief相对路径: 'audit dir/case_1.12345678.brief.json',
  核对文件: 'audit dir/case_1.12345678.brief.json',
  脚本编写目录: 'run dir',
  上一轮脚本编写目录: 'prev run dir',
  新脚本编写目录: 'next run dir',
  运行目录: 'prev run dir',
  下载运行目录: 'recompose run dir',
  新目录: 'out dir',
  自动化用例目录: 'plans dir',
  上一轮自动化用例目录: 'prev plans dir',
  核对目录: 'audit dir',
  上一轮核对目录: 'prev audit dir',
  核对任务目录: 'audit tasks dir',
  简报或输入路径: 'briefs dir/case 01.md',
  目标路径: 'plans dir/case 01.json',
  任务文件路径: 'tasks dir/case 01.md',
  条目JSON: 'briefs dir/item 01.json',
  结构简报JSON: 'briefs dir/brief 01.json',
  '路径...': 'prev plans dir/plan 01.json',
  '目录...': 'prev returns dir',
  导出文件: 'inputs/mindmap raw.km',
  规整文件: 'inputs/mindmap norm.json',
  重组后的用例目录: 'records dir',
  '说明.json': 'delivery dir/notes 说明.json',
};

function instantiateTaughtVariants(entry: ExtractedDocCommand, skillDir: string, skillName: 'case-compile' | 'recompose'): string[] {
  let command = entry.raw;
  if (entry.isMetaTemplate) {
    command = skillName === 'recompose'
      ? "node '<技能目录>/tools/check-record.ts' --file '<重组后的用例目录>'"
      : "node '<技能目录>/tools/check-plan.ts' --file '<计划或判断JSON>'";
  }

  assert.doesNotMatch(command, /["\\]/, `${entry.source} must not teach double quotes or backslashes: ${command}`);
  if (command.includes('<技能目录>')) {
    assert.ok(command.includes("'<技能目录>/tools/"), `${entry.source} must single-quote <技能目录>/tools/...: ${command}`);
    command = command.replaceAll('<技能目录>', skillDir);
  }

  const optionalStripped = command.replace(/\s*\[[^\]]+\]/g, '');
  const optionalExpanded = command.replace(/\[([^\]]+)\]/g, '$1');
  const rawVariants = optionalStripped === optionalExpanded ? [optionalStripped] : [optionalStripped, optionalExpanded];

  return rawVariants.map((variant) => {
    const filled = variant.replace(/<([^>]+)>/g, (_, key: string) => {
      assert.ok(Object.hasOwn(DOC_PLACEHOLDERS, key), `${entry.source} unmapped placeholder <${key}> in ${variant}`);
      return DOC_PLACEHOLDERS[key];
    });
    assert.doesNotMatch(filled, /(?<!<)<(?!<)|>/, `${entry.source} still contains placeholder brackets: ${filled}`);
    return filled;
  });
}

test('every CLI command taught in case-compile docs, agents, and task-brief passes ops and skills guards under spaced home', async () => {
  const docSources = [
    { rel: 'packs/workflow/case-compile/SKILL.md', skill: 'case-compile' as const, required: true },
    { rel: 'packs/workflow/case-compile/recompose/SKILL.md', skill: 'recompose' as const, required: true },
    { rel: 'packs/workflow/case-compile/tools/delivery.md', skill: 'case-compile' as const, required: true },
    { rel: 'packs/workflow/case-compile/tools/fidelity.md', skill: 'case-compile' as const, required: true },
    { rel: 'packs/workflow/case-compile/agents/compile-attributor.md', skill: 'case-compile' as const, required: false },
    { rel: 'packs/workflow/case-compile/agents/compile-fidelity.md', skill: 'case-compile' as const, required: true },
    { rel: 'packs/workflow/case-compile/agents/compile-recomposer.md', skill: 'case-compile' as const, required: false },
    { rel: 'packs/workflow/case-compile/agents/compile-writer.md', skill: 'case-compile' as const, required: true },
  ];

  const extractedBySkill: Array<{ skill: 'case-compile' | 'recompose'; entry: ExtractedDocCommand }> = [];
  let metaTemplateCount = 0;
  for (const doc of docSources) {
    const content = readFileSync(join(REPO_ROOT, doc.rel), 'utf8');
    const entries = extractTaughtCommands(content, doc.rel);
    if (doc.required) assert.ok(entries.length >= 1, `${doc.rel} expected at least 1 taught node command`);
    for (const entry of entries) {
      if (entry.isMetaTemplate) metaTemplateCount += 1;
      extractedBySkill.push({ skill: doc.skill, entry });
    }
  }
  assert.ok(extractedBySkill.length >= 15, `expected at least 15 taught commands across docs/agents, got ${extractedBySkill.length}`);
  assert.equal(metaTemplateCount, 2, 'expected abstract meta-template once each in SKILL.md and recompose/SKILL.md');

  for (const profile of ['ops', 'skills'] as const) {
    const h = createGuardHarness(profile, { homeName: 'Application Support/circle home' });
    try {
      mkdirSync(join(h.workdir, 'briefs'), { recursive: true });
      mkdirSync(join(h.workdir, 'audit'), { recursive: true });
      mkdirSync(join(h.workdir, 'returns'), { recursive: true });
      writeFileSync(join(h.workdir, 'scope.md'), '只做合成测试范围。\n');
      writeFileSync(join(h.workdir, 'briefs', '01.md'), '# synthetic brief\n', 'utf8');
      writeFileSync(join(h.workdir, 'audit', 'case-1.12345678.brief.json'), '{"schema":"fidelity-brief@1"}\n', 'utf8');
      writeFileSync(join(h.workdir, 'returns', 'index.json'), '{"jobs":[]}\n', 'utf8');

      const renderedBriefs = [
        {
          label: 'buildTaskBrief(脚本编写)',
          text: await buildTaskBrief({
            role: '脚本编写',
            caseRef: 'case-101',
            briefPath: 'briefs/01.md',
            outPath: 'plans/01.json',
            cwd: h.workdir,
            packRoot: h.skillPath('case-compile'),
          }),
        },
        {
          label: 'buildTaskBrief(保真核对)',
          text: await buildTaskBrief({
            role: '保真核对',
            caseRef: 'case-1',
            briefPath: 'audit/case-1.12345678.brief.json',
            outPath: 'audit/case-1.12345678.verdict.json',
            cwd: h.workdir,
            packRoot: h.skillPath('case-compile'),
          }),
        },
      ];

      for (const item of renderedBriefs) {
        const briefEntries = extractTaughtCommands(item.text, item.label);
        assert.ok(briefEntries.length >= 1, `${item.label} should teach at least one check-plan command`);
        for (const entry of briefEntries) {
          for (const cmd of instantiateTaughtVariants(entry, h.skillPath('case-compile'), 'case-compile')) {
            h.assertAllowed(h.exec(cmd), `${profile} blocked ${item.label} (${entry.source}):\n${cmd}`);
          }
        }
      }

      for (const { skill, entry } of extractedBySkill) {
        for (const cmd of instantiateTaughtVariants(entry, h.skillPath(skill), skill)) {
          h.assertAllowed(h.exec(cmd), `${profile} blocked ${entry.source}:\n${cmd}`);
        }
      }
    } finally {
      h.close();
    }
  }
});

test('helper-rename regression: renaming readTokenFromStdin never changes guard decisions or ALLOWED.md', () => {
  const h = createGuardHarness('ops');
  try {
    const allowedBefore = h.allowedText();
    const fetchPath = h.skillPath('case-compile', 'tools/fetch-run.ts');
    const retryPath = join(dirname_safe(fetchPath), '..', 'functions', 'hub-retry.ts');
    const checkPlanPath = h.skillPath('case-compile', 'tools/check-plan.ts');

    const ccSrc = join(REPO_ROOT, 'packs/workflow/case-compile');
    cpSync(join(ccSrc, 'functions'), join(h.skillPath('case-compile'), 'functions'), { recursive: true });
    writeFileSync(fetchPath, readFileSync(fetchPath, 'utf8').replaceAll('readTokenFromStdin', 'customSecretPipe'));
    writeFileSync(retryPath, readFileSync(retryPath, 'utf8').replaceAll('readTokenFromStdin', 'customSecretPipe'));
    // Add misleading helper name into a zero-stdin tool whose .cli.json declares [].
    writeFileSync(
      checkPlanPath,
      `${readFileSync(checkPlanPath, 'utf8')}\n// synthetic distraction: readTokenFromStdin readKeys\n`,
    );

    const regen = spawnSync(process.execPath, [h.gen], {
      cwd: h.workdir,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(regen.status, 0, regen.stderr);
    assert.equal(h.allowedText(), allowedBefore);

    const fCmd = `'${fetchPath}'`;
    h.assertRefused3(h.exec(`node ${fCmd} --hub ${HUB_URL} --run ${RUN_ID} --out run-out`), /声明从标准输入读令牌/);
    h.assertAllowed(h.exec(`node ${fCmd} --hub ${HUB_URL} --run ${RUN_ID} --out run-out <<'EOF'\n%HUB_TOKEN%\nEOF`));

    const cpCmd = `'${checkPlanPath}'`;
    h.assertAllowed(h.exec(`node ${cpCmd} --file plans/0.json`));
    h.assertRefused3(h.exec(`node ${cpCmd} --file plans/0.json <<'EOF'\n%HUB_TOKEN%\nEOF`), /声明不读标准输入/);
  } finally {
    h.close();
  }
});

test('epistemic refusal when a tool or command has no pure-data stdin declaration', () => {
  const h = createGuardHarness('ops');
  try {
    // 1. Delete check-plan.cli.json -> undeclared tool called with <<'EOF' must refuse epistemically.
    const cpPath = h.skillPath('case-compile', 'tools/check-plan.ts');
    rmSync(join(h.skillPath('case-compile', 'tools'), 'check-plan.cli.json'));
    const regen = spawnSync(process.execPath, [h.gen], {
      cwd: h.workdir,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(regen.status, 0, regen.stderr);

    const refusedTool = h.exec(`node '${cpPath}' --file plans/0.json <<'EOF'\n%HUB_TOKEN%\nEOF`);
    h.assertRefused3(refusedTool, /here-doc（<<'EOF'）.*没有找到 .*check-plan\.ts 读标准输入的声明/);
    assert.ok(!String(refusedTool.reason).includes('不读标准输入'), `must not assert 不读标准输入: ${refusedTool.reason}`);
    assert.ok(!String(refusedTool.reason).includes('这次可以这样写：'), `must not blindly suggest stripping EOF: ${refusedTool.reason}`);
    // Without heredoc, undeclared tool stays runnable instead of inventing a token requirement.
    h.assertAllowed(h.exec(`node '${cpPath}' --file plans/0.json`));

    // 2. Remove declaration.commands[0].stdin -> simple command called with <<'EOF' refuses epistemically.
    const declPath = join(h.home, 'hooks', 'ops-allow.declaration.json');
    const decl = JSON.parse(readFileSync(declPath, 'utf8')) as { commands: Array<Record<string, unknown>> };
    delete decl.commands[0].stdin;
    writeFileSync(declPath, JSON.stringify(decl, null, 2));
    const refusedSleep = h.exec("sleep 10 <<'EOF'\n%HUB_TOKEN%\nEOF");
    h.assertRefused3(refusedSleep, /here-doc（<<'EOF'）.*没有找到 sleep 读标准输入的声明/);
    assert.ok(!String(refusedSleep.reason).includes('不读标准输入'), `must not assert 不读标准输入: ${refusedSleep.reason}`);
    assert.ok(!String(refusedSleep.reason).includes('这次可以这样写：'), `must not suggest sleep 10 stripping EOF: ${refusedSleep.reason}`);
  } finally {
    h.close();
  }
});

function dirname_safe(p: string): string {
  return join(p, '..');
}
