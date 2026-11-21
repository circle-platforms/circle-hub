import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderTaskBrief, resolveSubagentRole } from '../../packs/workflow/case-compile/functions/subagent-roles.ts';
import { writeHome, type Endpoint, type Profile } from './circle-home.ts';
import { decisionOf } from './guard-lib.ts';

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
const PLUMB_URL = 'https://192.0.2.60:8443';
const ALT_PLUMB_URL = 'https://192.0.2.61:8443';
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

  const plumbSrc = join(REPO_ROOT, 'packs/skill/plumb');
  const plumbDst = join(home, 'skills/plumb');
  mkdirSync(join(plumbDst, 'tools'), { recursive: true });
  writeFileSync(join(plumbDst, 'SKILL.md'), readFileSync(join(plumbSrc, 'SKILL.md'), 'utf8'));
  cpSync(join(plumbSrc, 'tools'), join(plumbDst, 'tools'), { recursive: true });

  const kcTools = join(REPO_ROOT, 'packs/workflow/knowledge-contribution/tools');
  for (const name of ['jev', 'operation-capture']) {
    cpSync(join(kcTools, name), join(home, 'skills', name), { recursive: true });
  }
}

function createGuardHarness(profile: Exclude<Profile, 'review'>, opts: { homeName?: string; withSkills?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'circle-guard-test-'));
  const home = join(dir, opts.homeName ?? 'home');
  const written = writeHome({ home, profile, hubUrl: HUB_URL, plumbUrl: PLUMB_URL, plumbModel: 'plumb-27b-0.5.0' }, ENDPOINT, 'synthetic-hub-token');
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
    return decisionOf(JSON.parse(child.stdout));
  };

  const call = (tool_name: string, tool_input: Record<string, unknown>, extra: { cwd?: string; paths?: string[]; session_id?: string } = {}) =>
    runHook(
      {
        hook_event_name: 'PreToolUse',
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

test('guard-offline A/D: literal quote grammar, space-in-home, and 3-line fixes without expansion or escaped-space permission', () => {
  for (const profile of ['ops', 'skills'] as const) {
    const h = createGuardHarness(profile, { homeName: 'Application Support/circle home' });
    try {
      const tb = `'${h.skillPath('case-compile', 'tools/task-brief.ts')}'`;
      h.assertAllowed(
        h.exec(`node ${tb} --role '脚本编写' --case case-01 --brief briefs/0.md --out 'plans/case 01.json' --task-file tasks/0.md --note '加一条 中文说明' --round 2 --run case-compile-run --brief-json briefs/0.json`),
        `${profile}: single quotes allowed`,
      );

      h.assertAllowed(
        h.exec(`node ${tb} --role '脚本编写' --case case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md --prior-plans 'plans/r1/0.json,-,plans/r2/0.json' --prior-returns -`),
      );
      h.assertRefused3(
        h.exec(`node ${tb} --role '脚本编写' --case case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md --prior-plans 'plans/r1/0.json,../outside.json'`),
        /--prior-plans/,
      );

      const dbl = h.exec(`node "${h.skillPath('case-compile', 'tools/task-brief.ts')}" --role "脚本编写" --case case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md`);
      h.assertAllowed(dbl);

      h.assertRefused3(h.exec(`node ${tb} --role '脚本编写' --case case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md --note foo\\ bar`), /反斜杠/);
      h.assertRefused3(h.exec(`node ${tb} --role 脚本编写 --case case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md`), /英文单引号/);
      h.assertRefused3(h.exec(`node ${tb} --role '脚本''编写' --case case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md`), /紧连/);
      h.assertRefused3(h.exec(`node ${tb} --role '脚本编写' --case=case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md`), /--case=…/);

      const ad = `'${h.skillPath('case-compile', 'tools/assemble-delivery.ts')}'`;
      h.assertAllowed(h.exec(`node ${ad} --hub ${HUB_URL} --runs ${RUN_ID},${RUN_ID_2} --notes notes.json --out dist --recompose ${RUN_ID} --name '合成 交付' <<'EOF'\n%HUB_TOKEN%\nEOF`));
      const dr = `'${h.skillPath('case-compile', 'tools/download-returns.ts')}'`;
      h.assertAllowed(h.exec(`node ${dr} --hub ${HUB_URL} --run ${RUN_ID} --out returns --wait 30 <<'EOF'\n%HUB_TOKEN%\nEOF`));
      const cr = `'${h.skillPath('recompose', 'tools/check-record.ts')}'`;
      h.assertAllowed(h.exec(`node ${cr} --file records --run recompose-run`));
      h.assertRefused3(h.exec(`node ${ad} --hub ${HUB_URL} --runs ${RUN_ID} --notes notes.json --out dist`), /从标准输入读令牌/);
      h.assertRefused3(h.exec(`node ${cr} --file records <<'EOF'\n%HUB_TOKEN%\nEOF`), /不读标准输入/);
      assert.ok(!h.allowedText().includes('authoring-brief.ts'));
      assert.ok(!h.allowedText().includes('rework-inputs.ts'));
      assert.ok(!h.allowedText().includes('workspace-path.ts'));
      h.assertRefused3(h.exec(`node '${h.skillPath('case-compile', 'tools/authoring-brief.ts')}'`), /可执行身份未知/);
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
      h.assertRefused3(h.exec('sed -i s/a/b/ x.txt'), /只放行技能目录里的脚本/, h === hOps ? /先 read_file.*edit_file/ : /没有放行编辑能力/);
    }
    hOps.assertAllowed(hOps.call('write_file', { file_path: 'out/a.md' }, { paths: [join(hOps.workdir, 'out/a.md')] }));
    hOps.assertRefused3(hOps.call('write_file', { file_path: virtualLog }, { paths: [virtualLog] }), /不在工作目录/);
    hOps.assertRefused3(hOps.call('write_file', { file_path: hOps.allowedPath }, { paths: [hOps.allowedPath] }), /不在工作目录/);
    hSkills.assertRefused3(hSkills.call('write_file', { file_path: 'out/a.md' }, { paths: [join(hSkills.workdir, 'out/a.md')] }), /不在这个配置放行/);

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
          h.assertRefused3(h.call('mcp__hub__start_run', { pack, parameters: { action } }), /释放或变更测试环境的预订登记/, /预订保持原样/);
          h.assertRefused3(
            h.call('mcp__hub__start_run', { pack, parameters: JSON.stringify({ action }) }),
            /释放或变更测试环境的预订登记/,
          );
        }
      }
      for (const action of ['search', 'facts', 'help', 'acquire', 'extend']) {
        h.assertAllowed(h.call('mcp__hub__start_run', { pack: 'test-bed@1.3.3', parameters: { action } }));
      }
      h.assertAllowed(h.call('mcp__hub__start_run', { pack: 'other-pack@1.0.0', parameters: { action: 'release' } }));
    } finally {
      h.close();
    }
  }
});

test('PreToolUse schema, case-insensitive/custom mcpServers key, agent_id subagent detection, and virtualReadOnly without paths[]', () => {
  const virtualLog = '/large_tool_results/0123456789abcdef01234567.txt';
  for (const profile of ['ops', 'skills'] as const) {
    const h = createGuardHarness(profile, { withSkills: false });
    try {
      const callPre = (payload: Record<string, unknown>) => {
        const child = spawnSync(process.execPath, [h.hook], {
          cwd: h.workdir,
          input: JSON.stringify({ hook_event_name: 'PreToolUse', cwd: h.workdir, ...payload }),
          encoding: 'utf8',
          timeout: 5000,
        });
        assert.equal(child.status, 0, child.stderr);
        return JSON.parse(child.stdout) as {
          hookSpecificOutput?: { hookEventName?: string; permissionDecision?: string; permissionDecisionReason?: string };
        };
      };
      const assertPreAllowed = (out: ReturnType<typeof callPre>, label: string) => {
        if (profile === 'ops') {
          assert.deepEqual(out, {}, label);
        } else {
          assert.equal(out.hookSpecificOutput?.hookEventName, 'PreToolUse', label);
          assert.equal(out.hookSpecificOutput?.permissionDecision, 'allow', label);
        }
      };
      const assertPreDenied = (out: ReturnType<typeof callPre>, pattern: RegExp, label: string) => {
        assert.equal(out.hookSpecificOutput?.hookEventName, 'PreToolUse', label);
        assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny', label);
        assert.match(String(out.hookSpecificOutput?.permissionDecisionReason ?? ''), pattern, label);
      };

      assertPreAllowed(
        callPre({ tool_name: 'mcp__Hub__start_run', tool_input: { pack: 'other-pack@1.0.0', parameters: { action: 'release' } } }),
        `${profile}: mcp__Hub__start_run allow`,
      );
      assertPreDenied(
        callPre({ tool_name: 'mcp__Hub__start_run', tool_input: { pack: 'test-bed@1.3.3', parameters: { action: 'release' } } }),
        /释放或变更测试环境的预订登记/,
        `${profile}: mcp__Hub__start_run booking stays`,
      );
      assertPreDenied(callPre({ tool_name: 'mcp__hubx__start_run', tool_input: {} }), /不在这个配置放行的工具里/, `${profile}: mcp__hubx__ deny`);
      assertPreDenied(callPre({ tool_name: 'hub_start_run', tool_input: {} }), /ALLOWED\.md/, `${profile}: flat hub_start_run deny`);

      const emptyAgentRes = callPre({ tool_name: 'question', tool_input: { questions: [] }, agent_id: '' });
      const subAgentRes = callPre({ tool_name: 'question', tool_input: { questions: [] }, agent_id: 'sub_agent_01' });
      if (profile === 'ops') {
        assertPreDenied(emptyAgentRes, /全程不向使用者提问/, `${profile}: empty agent_id`);
        assertPreDenied(subAgentRes, /子代理不向使用者提问/, `${profile}: non-empty agent_id`);
      } else {
        assertPreDenied(emptyAgentRes, /不在这个配置放行的工具里/, `${profile}: empty agent_id`);
        assertPreDenied(subAgentRes, /不在这个配置放行的工具里/, `${profile}: non-empty agent_id`);
      }

      assertPreAllowed(callPre({ tool_name: 'read_file', tool_input: { file_path: virtualLog } }), `${profile}: read_file virtual no paths`);
      assertPreAllowed(callPre({ tool_name: 'read_file', tool_input: { file_path: virtualLog }, paths: [virtualLog] }), `${profile}: read_file virtual with paths`);
      assertPreAllowed(callPre({ tool_name: 'grep', tool_input: { path: virtualLog, pattern: 'err' } }), `${profile}: grep virtual no paths`);
      assertPreDenied(callPre({ tool_name: 'read_file', tool_input: { file_path: '/large_tool_results/not24hex.txt' } }), /不在工作目录/, `${profile}: bad virtual read`);
      assertPreDenied(callPre({ tool_name: 'write_file', tool_input: { file_path: virtualLog, content: 'x' } }), /不允许|不在工作目录|禁止|不在这个配置放行的工具里/, `${profile}: write_file virtual deny`);

      const settingsPath = join(h.home, 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
      settings.mcpServers = { customHub: settings.mcpServers.hub };
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
      const regen = spawnSync(process.execPath, [h.gen], { cwd: h.workdir, encoding: 'utf8', timeout: 5000 });
      assert.equal(regen.status, 0, regen.stderr);
      assertPreAllowed(
        callPre({ tool_name: 'mcp__CustomHub__start_run', tool_input: { pack: 'test-bed@1.3.3', parameters: { action: 'facts' } } }),
        `${profile}: customHub facts allow`,
      );
      assertPreDenied(
        callPre({ tool_name: 'mcp__CustomHub__start_run', tool_input: { pack: 'test-bed@1.3.3', parameters: { action: 'release' } } }),
        /释放或变更测试环境的预订登记/,
        `${profile}: customHub release deny`,
      );
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

    h.assertRefused3(h.call('question', { questions: [] }, { session_id: 'sess_main_01' }), /全程不向使用者提问/, /模型决定/);
    h.assertRefused3(h.call('question', { questions: [] }, { session_id: "bad'id;--" }), /全程不向使用者提问/, /模型决定/);
    h.assertRefused3(h.call('question', { questions: [] }, { session_id: 'sess_sub_01' }), /子代理不向使用者提问/, /给主代理的报告/);
  } finally {
    h.close();
  }
});

test('ops sibling ^work-ops trust, execute key hygiene, skills/ symlink, globWithin, hooks.json delegation, --hub mismatch, and --schemas', () => {
  const hOps = createGuardHarness('ops');
  const hSkills = createGuardHarness('skills', { withSkills: false });
  try {
    const opsSibling = join(hOps.dir, 'work-ops-run29');
    const badSibling = join(hOps.dir, 'other-dir');
    mkdirSync(opsSibling, { recursive: true });
    mkdirSync(badSibling, { recursive: true });
    hOps.assertAllowed(hOps.call('read_file', { file_path: 'a.txt' }, { cwd: opsSibling, paths: [join(opsSibling, 'a.txt')] }));
    hOps.assertRefused3(hOps.call('read_file', { file_path: 'a.txt' }, { cwd: badSibling, paths: [join(badSibling, 'a.txt')] }), /trusted_folders/);

    const skillsSibling = join(hSkills.dir, 'work-ops-run29');
    mkdirSync(skillsSibling, { recursive: true });
    hSkills.assertRefused3(hSkills.call('read_file', { file_path: 'a.txt' }, { cwd: skillsSibling, paths: [join(skillsSibling, 'a.txt')] }), /trusted_folders/);

    const fetchRun = hOps.skillPath('case-compile', 'tools/fetch-run.ts');
    hOps.assertRefused3(hOps.exec(`node ${fetchRun} --hub ${HUB_URL} --run ${RUN_ID} --out r <<'EOF'\n%HUB_TOKEN%\nEOF`, { fields: { env: {} } }), /execute 参数形状无效/);
    hOps.assertRefused3(hOps.exec(`node ${fetchRun} --hub ${ALT_HUB_URL} --run ${RUN_ID} --out r <<'EOF'\n%HUB_TOKEN%\nEOF`), /Hub 的地址/);

    const jev = hOps.skillPath('jev', 'jev.ts');
    const jevAsk = hOps.exec(`node ${jev} ask --hub ${HUB_URL} --model synthetic-jev --input ask.json --send case --out jev-out <<'EOF'\n%JEV_API_KEY%\n%HUB_TOKEN%\nEOF`);
    assert.equal(jevAsk.decision, 'ask');

    const outside = join(hOps.dir, 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'synthetic');
    symlinkSync(outside, join(hOps.workdir, 'linked'), 'dir');
    hOps.assertRefused3(hOps.call('glob', { pattern: 'linked/*', path: hOps.workdir }, { paths: [hOps.workdir] }), /软链接/);

    const localDir = join(hOps.workdir, 'local-tools/demo/tools');
    mkdirSync(localDir, { recursive: true });
    const localCli = join(localDir, 'run.ts');
    const localLib = join(localDir, 'helper.ts');
    writeFileSync(localCli, "// node demo/tools/run.ts --out <文件路径>\nconst idx = process.argv.indexOf('--out');\n");
    writeFileSync(join(localDir,'run.cli.json'),JSON.stringify({schema:'tool-cli@2',stdin:[],options:[{name:'out',type:'path',required:true,kind:'string',multiple:false,placeholder:null}]}));
    writeFileSync(localLib, 'export const HELPER = 1;\n');
    hOps.assertAllowed(hOps.exec(`node ${localCli} --out out.json`));
    hOps.assertRefused3(hOps.exec(`node ${localCli} --out ../outside.json`), /不在工作目录/);
    hOps.assertRefused3(hOps.exec(`node ${localLib}`), /可执行身份未知/);

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

      const undeclaredRes = h.exec(`node ${undeclared}`);
      verifyRefusalSecondLine('undeclared helper', undeclaredRes, false);
      const undeclaredHow = String(undeclaredRes.reason ?? '').split('\n').slice(1, -1).join('\n');
      assert.match(undeclaredHow, /已装.*脚本|assemble-delivery\.ts|task-brief\.ts/, `undeclared helper should list installed scripts:\n${undeclaredHow}`);

      verifyRefusalSecondLine('outside script', h.exec(`node ${outside}`), false);
      verifyRefusalSecondLine('missing script', h.exec(`node '${h.skillPath('case-compile', 'tools/no-such.ts')}'`), false);
      verifyRefusalSecondLine('node -e', h.exec("node -e 'console.log(1)'"), false);
      verifyRefusalSecondLine('unknown interpreter', h.exec('python3 x.py'), false);
      verifyRefusalSecondLine('ambiguous relative download-run', h.exec(`node tools/download-run.ts --hub ${HUB_URL} --run ${RUN_ID} --out r <<'EOF'\n%HUB_TOKEN%\nEOF`), false);
      verifyRefusalSecondLine('unique relative missing required opt', h.exec('node tools/task-brief.ts'), false);
      verifyRefusalSecondLine('missing required --runs', h.exec(`node ${ad} --hub ${HUB_URL} --notes notes.json --out dist <<'EOF'\n%HUB_TOKEN%\nEOF`), false);
      verifyRefusalSecondLine('invalid --run id', h.exec(`node ${fr} --hub ${HUB_URL} --run bad_id --out r <<'EOF'\n%HUB_TOKEN%\nEOF`), false);
      verifyRefusalSecondLine('bad subcommand', h.exec(`node ${op} bogus --session s1`), false);

      verifyRefusalSecondLine('unique relative complete check-record', h.exec('node recompose/tools/check-record.ts --file records --run recompose-run'), true);

      h.assertAllowed(h.exec(`node "${h.skillPath('case-compile', 'tools/task-brief.ts')}" --role "脚本编写" --case c1 --brief b.md --out p.json --task-file t.md`));
      verifyRefusalSecondLine('bare Chinese', h.exec(`node ${tb} --role 脚本编写 --case c1 --brief b.md --out p.json --task-file t.md`), true);
      verifyRefusalSecondLine('backslash space', h.exec(`node ${tb} --role '脚本编写' --case c1 --brief b.md --out p.json --task-file t.md --note foo\\ bar`), true);
      verifyRefusalSecondLine('adjacent quotes', h.exec(`node ${tb} --role '脚本''编写' --case c1 --brief b.md --out p.json --task-file t.md`), true);
      verifyRefusalSecondLine('equals option', h.exec(`node ${tb} --role '脚本编写' --case=c1 --brief b.md --out p.json --task-file t.md`), true);
      verifyRefusalSecondLine('optional invalid prior-plans', h.exec(`node ${tb} --role '脚本编写' --case c1 --brief b.md --out p.json --task-file t.md --prior-plans ../outside.json`), false);
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
    const cpPath = h.skillPath('case-compile', 'tools/check-plan.ts');
    rmSync(join(h.skillPath('case-compile', 'tools'), 'check-plan.cli.json'));
    const regen = spawnSync(process.execPath, [h.gen], {
      cwd: h.workdir,
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(regen.status, 0, regen.stderr);

    const refusedTool = h.exec(`node '${cpPath}' --file plans/0.json <<'EOF'\n%HUB_TOKEN%\nEOF`);
    h.assertRefused3(refusedTool, /没有在已声明的可执行工具清单里找到/);
    assert.ok(!String(refusedTool.reason).includes('不读标准输入'), `must not assert 不读标准输入: ${refusedTool.reason}`);
    assert.ok(!String(refusedTool.reason).includes('这次可以这样写：'), `must not blindly suggest stripping EOF: ${refusedTool.reason}`);
    h.assertRefused3(h.exec(`node '${cpPath}' --file plans/0.json`), /缺少明确|未声明|身份未知/);

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

test('plumb skill and case-compile plumb scripts enforce host-pinning, subcommands, and %PLUMB_API_KEY% stdin across ops and skills', () => {
  for (const profile of ['ops', 'skills'] as const) {
    const h = createGuardHarness(profile);
    try {
      const plumbCli = `'${h.skillPath('plumb', 'tools/plumb.ts')}'`;
      const selectPlumb = `'${h.skillPath('case-compile', 'tools/cmd-select-plumb.ts')}'`;
      const verifyPlumb = `'${h.skillPath('case-compile', 'tools/cmd-verify-plumb.ts')}'`;
      const fidelityPlumb = `'${h.skillPath('case-compile', 'tools/fidelity-plumb.ts')}'`;

      h.assertAllowed(h.exec(`node ${plumbCli} models --base-url %PLUMB_URL% --key-stdin <<'EOF'\n%PLUMB_API_KEY%\nEOF`));
      h.assertAllowed(h.exec(`node ${plumbCli} wake --base-url ${PLUMB_URL} --wait --timeout-sec 720 --model plumb-27b-0.5.0 --key-stdin <<'EOF'\n%PLUMB_API_KEY%\nEOF`));
      h.assertRefused3(h.exec(`node ${plumbCli} request-key --name x --purpose y --base-url %PLUMB_URL% <<'EOF'\n%PLUMB_API_KEY%\nEOF`), /不在放行的/);
      h.assertRefused3(h.exec(`node ${plumbCli} models --base-url ${ALT_PLUMB_URL} --key-stdin <<'EOF'\n%PLUMB_API_KEY%\nEOF`), /Plumb 的地址/);
      h.assertRefused3(h.exec(`node ${plumbCli} models --base-url %PLUMB_URL% --key-stdin <<'EOF'\n%HUB_TOKEN%\nEOF`), /%PLUMB_API_KEY%/);

      h.assertAllowed(h.exec(`node ${selectPlumb} --run run-dir --base-url %PLUMB_URL% --no-cache --strict-review --key-stdin <<'EOF'\n%PLUMB_API_KEY%\nEOF`));
      h.assertAllowed(h.exec(`node ${verifyPlumb} --plans plans --run run-dir --base-url ${PLUMB_URL} --context-mode node --key-stdin <<'EOF'\n%PLUMB_API_KEY%\nEOF`));
      h.assertAllowed(h.exec(`node ${fidelityPlumb} --run run-dir --plans plans --briefs briefs --base-url %PLUMB_URL% --ca-sha256 ${'a'.repeat(64)} --key-stdin <<'EOF'\n%PLUMB_API_KEY%\nEOF`));

      h.assertRefused3(h.exec(`node ${fidelityPlumb} --run run-dir --plans plans --briefs briefs --base-url ${ALT_PLUMB_URL} --key-stdin <<'EOF'\n%PLUMB_API_KEY%\nEOF`), /Plumb 的地址/);
      h.assertRefused3(h.exec(`node ${fidelityPlumb} --run run-dir --plans plans --briefs briefs --base-url %PLUMB_URL% --key-stdin`), /标准输入读令牌/);
      h.assertRefused3(h.exec(`node ${fidelityPlumb} --run run-dir --plans plans --briefs briefs --base-url %PLUMB_URL% --key-stdin <<'EOF'\n%HUB_TOKEN%\nEOF`), /%PLUMB_API_KEY%/);
      h.assertRefused3(h.exec(`node ${fidelityPlumb} --run run-dir --plans plans --briefs briefs --base-url %PLUMB_URL% --key-stdin --ca-file ../outside.pem <<'EOF'\n%PLUMB_API_KEY%\nEOF`), /不在工作目录/);
    } finally {
      h.close();
    }
  }
});

test('cmd-lookup is a declared tool: the command the writer task file prints passes both guards, and what its declaration does not allow is refused', () => {
  for (const profile of ['ops', 'skills'] as const) {
    const h = createGuardHarness(profile);
    try {
      const lookup = `'${h.skillPath('case-compile', 'tools/cmd-lookup.ts')}'`;
      const brief = renderTaskBrief({ role: resolveSubagentRole('plan')!, caseRef: 'case-1', briefPath: 'briefs/0.md', outPath: 'plans/0.json', skillDir: h.skillPath('case-compile'), frozenRunDir: join(h.workdir, 'plan-run'), scopeText: '合成范围' });
      const printed = brief.split('\n').filter((line) => line.startsWith('`node ') && line.includes('cmd-lookup.ts'));
      assert.equal(printed.length, 1, brief);
      assert.ok(printed[0]!.includes(` --run '${join(h.workdir, 'plan-run')}' --param `) && !printed[0]!.includes('run.json'), printed[0]);
      h.assertAllowed(h.exec(printed[0]!.slice(1, -1).replace("'<命令词，可带参数>'", "'orbit beacon add'")), `${profile}: the printed lookup command`);
      const check = brief.split('\n').filter((line) => line.startsWith('`node ') && line.includes('check-plan.ts'));
      assert.equal(check.length, 1, brief);
      assert.ok(check[0]!.includes(` --file 'plans/0.json' --run '${join(h.workdir, 'plan-run')}'`) && !check[0]!.includes('run.json'), check[0]);
      h.assertAllowed(h.exec(check[0]!.slice(1, -1)), `${profile}: the printed check command`);
      h.assertAllowed(h.exec(`node ${lookup} --run plan-run --param 'orbit beacon add "b1" fast 3'`), `${profile}: a command with quoted arguments inside one single-quoted word`);
      h.assertAllowed(h.exec(`node ${lookup} --run plan-run --heads 'orbit beacon'`), `${profile}: heads`);
      h.assertAllowed(h.exec(`node ${lookup} --run plan-run --method 'routera.cmd'`), `${profile}: method`);
      h.assertAllowed(h.exec(`node ${lookup} --run plan-run --methods 'APV_0'`), `${profile}: methods`);
      h.assertAllowed(h.exec(`node ${lookup} --run plan-run --block 'CAPTURE_COMPARE'`), `${profile}: block`);
      h.assertRefused3(h.exec(`node ${lookup} --run plan-run --method=routera.cmd`), /不认“=”/);
      h.assertRefused3(h.exec(`node ${lookup} --run plan-run --block 'CONFIG' <<'EOF'\n%HUB_TOKEN%\nEOF`), /声明不读标准输入/);
      h.assertRefused3(h.exec(`node ${lookup} --param 'orbit beacon add'`), /缺少必填选项 --run/);
      h.assertRefused3(h.exec(`node ${lookup} --run ../outside --param 'orbit beacon add'`), /不在工作目录/);
      h.assertRefused3(h.exec(`node ${lookup} --run plan-run --param=orbit`), /不认“=”/);
      h.assertRefused3(h.exec(`node ${lookup} --run plan-run --guess orbit`), /没有 --guess 选项/);
      h.assertRefused3(h.exec(`node ${lookup} --run plan-run --param 'orbit' <<'EOF'\n%HUB_TOKEN%\nEOF`), /声明不读标准输入/);
      h.assertRefused3(h.exec(`node tools/cmd-lookup.ts --run plan-run --param 'orbit'`), /脚本路径/);
      assert.match(h.allowedText(), /^\| case-compile\/tools\/cmd-lookup\.ts \| `node '<技能目录>\/tools\/cmd-lookup\.ts' --run '<运行目录>' \[--param '<命令词，可带参数>'\] \[--heads '<命令词前缀>'\] \[--method '<对象>\.<方法>'\] \[--methods '<对象>'\] \[--block '<块种类>'\]` \|$/m);
    } finally {
      h.close();
    }
  }
});
