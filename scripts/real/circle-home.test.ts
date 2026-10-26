import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HUB_TOOLS, INTERNAL_TOOLS_ALLOWED, SERVER_NAME, TOKEN_SECRET, circleEndpoint, endpointFrom, main, parseArgs, writeHome, type Endpoint } from './circle-home.ts';
import { parseEnvText } from './lib/env-file.ts';

// Invented content: section names follow the owner's file layout, every value is made up.
const ENV = [
  'SOME_ACTIVE_KEY = active-value-1',
  '# ---- GLM ----',
  '# ANTHROPIC_API_KEY = glm-secret-value-AAAA',
  '# ANTHROPIC_BASE_URL = https://glm.example/api/anthropic',
  '# ---- 千问 ----',
  '# ANTHROPIC_BASE_URL = https://qwen.example/anthropic',
  '# ANTHROPIC_API_KEY = qwen-secret-value-BBBB',
  '# ---- 选项 B：DashScope qwen ----',
  '# IST_MODEL = qwen-test-model',
  '# ---- OpenAI 兼容 ----',
  '# OPENAI_BASE_URL = https://openai-like.example/v1',
  '# OPENAI_API_KEY = openai-secret-value-CCCC',
].join('\n');

const scratch = () => mkdtempSync(join(tmpdir(), 'circle-home-test-'));
const entries = parseEnvText(ENV);

test('the provider section gives the Anthropic pair and the model from the matching section', () => {
  const qwen = endpointFrom(entries, 'qwen');
  assert.equal(qwen.protocol, 'anthropic');
  assert.equal(qwen.baseUrl, 'https://qwen.example/anthropic');
  assert.equal(qwen.apiKey, 'qwen-secret-value-BBBB');
  assert.equal(qwen.model, 'qwen-test-model');
  assert.ok(qwen.sources.every((s) => !s.includes('secret') && !s.includes('example')), 'sources name keys and lines only');
});

test('a provider without a model name needs --model', () => {
  assert.throws(() => endpointFrom(entries, 'glm'), /--model/);
  assert.equal(endpointFrom(entries, 'glm', 'glm-test').model, 'glm-test');
});

test('a section without a usable pair fails without echoing content', () => {
  assert.throws(() => endpointFrom(entries, 'qwen', 'm', 'no-such-section'), (e: Error) => /没有可用的地址和密钥对/.test(e.message) && !/secret/.test(e.message));
});

test('the OpenAI-compatible pair is used when a section has no Anthropic pair', () => {
  const e = endpointFrom(entries, 'qwen', 'm', 'OpenAI');
  assert.equal(e.protocol, 'openai');
  assert.equal(e.apiKey, 'openai-secret-value-CCCC');
});

test('writeHome writes private files, keeps the token out of settings and refuses to overwrite', () => {
  const dir = scratch();
  try {
    const endpoint = endpointFrom(entries, 'qwen');
    const home = join(dir, 'home');
    const written = writeHome({ envFile: '/x/owner-env-notes', home, provider: 'qwen', hubUrl: 'http://127.0.0.1:7420/mcp' }, endpoint, 'hub-token-value');
    for (const f of written.files) assert.equal(statSync(join(home, f)).mode & 0o777, 0o600, f);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(written.workdir).mode & 0o777, 0o700);
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    assert.deepEqual(settings.auth, { protocol: 'anthropic', base_url: 'https://qwen.example/anthropic', model: 'qwen-test-model', api_key_ref: 'api_key' });
    assert.deepEqual(settings.mcp_servers, [{ name: SERVER_NAME, url: 'http://127.0.0.1:7420/mcp', transport: 'streamable_http', headers: { Authorization: `Bearer \${secret:${TOKEN_SECRET}}` } }]);
    assert.deepEqual(settings.credential_files, ['owner-env-notes']);
    assert.deepEqual(settings.trusted_folders, [written.workdir]);
    const text = readFileSync(join(home, 'settings.json'), 'utf8');
    assert.ok(!text.includes('hub-token-value') && !text.includes('qwen-secret-value-BBBB'), 'settings.json holds neither the token nor the key');
    assert.equal(JSON.parse(readFileSync(join(home, 'credentials.json'), 'utf8')).api_key, 'qwen-secret-value-BBBB');
    assert.equal(JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8')).secrets[TOKEN_SECRET], 'hub-token-value');
    assert.throws(() => writeHome({ envFile: 'f', home, provider: 'qwen', hubUrl: 'http://127.0.0.1:7420/mcp' }, endpoint, 't'), /不覆盖/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the hook allows exactly the six Hub tools and the todo list and denies everything else, including unreadable input', () => {
  const dir = scratch();
  try {
    const endpoint = endpointFrom(entries, 'qwen');
    writeHome({ envFile: 'f', home: join(dir, 'home'), provider: 'qwen', hubUrl: 'http://127.0.0.1:7420/mcp' }, endpoint, 't');
    const hook = join(dir, 'home', 'hooks', 'hub-only.mjs');
    const decide = (stdin: string) => {
      const r = spawnSync(process.execPath, [hook], { input: stdin, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout).decision;
    };
    for (const t of HUB_TOOLS) assert.equal(decide(JSON.stringify({ event: 'before_tool', tool_name: `${SERVER_NAME}_${t}` })), 'allow', t);
    for (const t of INTERNAL_TOOLS_ALLOWED) assert.equal(decide(JSON.stringify({ event: 'before_tool', tool_name: t })), 'allow', t);
    for (const t of ['bash', 'webfetch', 'websearch', 'write_file', 'read_file', `${SERVER_NAME}_other`, `hubx_start_run`]) {
      assert.equal(decide(JSON.stringify({ event: 'before_tool', tool_name: t })), 'deny', t);
    }
    assert.equal(decide('not json'), 'deny');
    assert.equal(decide(''), 'deny');
    const hooks = JSON.parse(readFileSync(join(dir, 'home', 'hooks.json'), 'utf8'));
    assert.equal(hooks.hooks.before_tool.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main prints names, lengths and nothing secret, and needs the token in the environment', () => {
  const dir = scratch();
  try {
    const envFile = join(dir, 'owner-env-notes');
    writeFileSync(envFile, ENV);
    const lines: string[] = [];
    const args = ['--env-file', envFile, '--home', join(dir, 'home'), '--provider', 'qwen'];
    assert.equal(main(args, {}, (l) => lines.push(l)), 1);
    assert.match(lines.join('\n'), /HUB_REAL_TOKEN/);
    lines.length = 0;
    assert.equal(main(args, { HUB_REAL_TOKEN: 'hub-token-value' }, (l) => lines.push(l)), 0);
    const shown = lines.join('\n');
    assert.match(shown, /qwen-test-model/);
    assert.match(shown, /密钥长度 \d+/);
    for (const secret of ['qwen-secret-value-BBBB', 'hub-token-value', 'qwen.example']) assert.ok(!shown.includes(secret), `the screen must not show ${secret}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('argument errors name the problem and never a value', () => {
  assert.throws(() => parseArgs(['--provider', 'other', '--env-file', 'a', '--home', 'b']), /glm 或 qwen/);
  assert.throws(() => parseArgs(['--provider', 'qwen', '--home', 'b']), /--env-file/);
  assert.throws(() => parseArgs(['bad']), /参数不对/);
});

// circleEndpoint: the endpoint of a Circle data directory (fake settings.json and credentials.json in a temp dir; the real
// ~/.circle is never read by a test). Invented content: the address is in example.invalid, the key is made up.
const CIRCLE_KEY = 'fake-circle-key-1234';
const CIRCLE_SETTINGS = { version: 1, auth: { protocol: 'anthropic', base_url: 'https://glm.example.invalid/api', model: 'glm-fake-model', api_key_ref: 'api_key' } };

function fakeCircleDir(dir: string, settings: unknown = CIRCLE_SETTINGS, credentials: unknown = { api_key: CIRCLE_KEY }, mode = 0o600): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'settings.json'), `${JSON.stringify(settings)}\n`);
  writeFileSync(join(dir, 'credentials.json'), `${JSON.stringify(credentials)}\n`);
  chmodSync(join(dir, 'credentials.json'), mode);
  return dir;
}

const throwsWithout = (block: () => unknown, pattern: RegExp): void => {
  try {
    block();
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, pattern);
    assert.ok(!message.includes(CIRCLE_KEY), 'the error must not carry the key');
    return;
  }
  assert.fail(`expected an error matching ${pattern}`);
};

test('circleEndpoint reads settings auth and the referenced key, and says only file and key names', () => {
  const dir = scratch();
  try {
    fakeCircleDir(dir);
    const endpoint = circleEndpoint(dir);
    assert.equal(endpoint.protocol, 'anthropic');
    assert.equal(endpoint.baseUrl, 'https://glm.example.invalid/api');
    assert.equal(endpoint.model, 'glm-fake-model');
    assert.equal(endpoint.apiKey, CIRCLE_KEY);
    assert.ok(endpoint.sources.length >= 2 && endpoint.sources.every((s) => /settings\.json|credentials\.json/.test(s) && !s.includes(CIRCLE_KEY) && !s.includes('example.invalid')), 'sources name files and keys only');
    assert.equal(circleEndpoint(dir, { model: 'other-model' }).model, 'other-model');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('circleEndpoint fails on a missing file, a missing field or an unreadable shape, naming only file and key names', () => {
  const dir = scratch();
  try {
    mkdirSync(dir, { recursive: true });
    throwsWithout(() => circleEndpoint(dir), /settings\.json/);
    throwsWithout(() => circleEndpoint(fakeCircleDir(join(dir, 'a'), { version: 1 })), /auth/);
    throwsWithout(() => circleEndpoint(fakeCircleDir(join(dir, 'b'), { ...CIRCLE_SETTINGS, auth: { ...CIRCLE_SETTINGS.auth, protocol: 'wechat' } })), /protocol/);
    throwsWithout(() => circleEndpoint(fakeCircleDir(join(dir, 'c'), { ...CIRCLE_SETTINGS, auth: { ...CIRCLE_SETTINGS.auth, base_url: 'not a url' } })), /base_url/);
    throwsWithout(() => circleEndpoint(fakeCircleDir(join(dir, 'd'), { ...CIRCLE_SETTINGS, auth: { protocol: 'anthropic', base_url: CIRCLE_SETTINGS.auth.base_url, api_key_ref: 'api_key' } })), /model|模型/);
    throwsWithout(() => circleEndpoint(fakeCircleDir(join(dir, 'e'), { ...CIRCLE_SETTINGS, auth: { ...CIRCLE_SETTINGS.auth, api_key_ref: 'vault:main' } })), /api_key_ref/);
    throwsWithout(() => circleEndpoint(fakeCircleDir(join(dir, 'f'), undefined, { token: CIRCLE_KEY })), /api_key/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('circleEndpoint warns when the credentials file is looser than 0600 and reads it anyway', () => {
  const dir = scratch();
  try {
    const lines: string[] = [];
    const endpoint = circleEndpoint(fakeCircleDir(join(dir, 'open'), undefined, undefined, 0o644), { warn: (l) => lines.push(l) });
    assert.equal(endpoint.apiKey, CIRCLE_KEY);
    assert.ok(lines.some((l) => /0600/.test(l)), 'a looser mode is warned about');
    lines.length = 0;
    circleEndpoint(fakeCircleDir(join(dir, 'tight')), { warn: (l) => lines.push(l) });
    assert.equal(lines.length, 0, 'a 0600 file is not warned about');
    for (const line of lines) assert.ok(!line.includes(CIRCLE_KEY));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeHome names the environment file as a protected file only when there is one', () => {
  const dir = scratch();
  try {
    const endpoint = endpointFrom(entries, 'qwen');
    const home = join(dir, 'home');
    writeHome({ home, hubUrl: 'http://127.0.0.1:7420/mcp' }, endpoint, 't');
    const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    assert.ok(!('credential_files' in settings), 'no environment file means no protected file entry');
    assert.equal(settings.auth.model, 'qwen-test-model');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Frozen before adding profiles; normalize only the scratch home prefix, never JSON formatting.
const REVIEW_BYTES = {
  'settings.json': '23ad030ae047db362be96316b6a9539f15eb269e9e15eabcfb5f9af680d48c49',
  'credentials.json': ["bae342","f65c62","474558","2bb94c","f7ff51","b0e3f6","e3ff60","8454ff","f61df2","17e294","7425"].join(''),
  'secrets.json': ["080e2c","babac7","df441b","fe6e72","0f4c06","7a3795","5a5077","9ce58d","981977","031c6a","79e5"].join(''),
  'hooks.json': '70f9cde0f4fb7678c956fc84e390497e87426185f22302e08435abb40011b90d',
  'hooks/hub-only.mjs': 'd6aba984c5d307c65457d90390638f57e2caff8512e519e1eb2c469353a7449c',
};
test('default and explicit review preserve every pre-profile file byte', async () => {
  const { createHash } = await import('node:crypto'); const dir = scratch(); const home = join(dir, 'home');
  try {
    for (const profile of [undefined, 'review'] as const) {
      rmSync(home, { recursive: true, force: true });
      const written = writeHome({ home, profile, envFile: 'synthetic.env', hubUrl: 'http://127.0.0.1:12345/mcp' }, { protocol: 'anthropic', baseUrl: 'https://model.example.invalid', model: 'synthetic-model', apiKey: 'synthetic-model-key', sources: [] }, 'synthetic-hub-token');
      for (const file of written.files) {
        const bytes = readFileSync(join(home, file), 'utf8').replaceAll(home, '<HOME>');
        assert.equal(createHash('sha256').update(bytes).digest('hex'), REVIEW_BYTES[file as keyof typeof REVIEW_BYTES], `${profile ?? 'default'} ${file}`);
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('profile arguments default to review and accept only the two named profiles', () => {
  const args = ['--env-file', 'synthetic.env', '--home', 'home', '--provider', 'qwen'];
  assert.equal(parseArgs(args).profile, 'review');
  assert.equal(parseArgs([...args, '--profile', 'skills', '--jev-model', 'synthetic-jev']).jevModel, 'synthetic-jev');
  assert.throws(() => parseArgs([...args, '--profile', 'unknown']), /profile/);
});
test('skills settings add only named variables and a private empty skills directory', () => {
  const dir = scratch();
  try {
    for (const jevModel of [undefined, 'synthetic-jev']) {
      const home = join(dir, jevModel ? 'selected' : 'unset');
      const written = writeHome({ home, hubUrl: 'https://hub.example.invalid/mcp', profile: 'skills', jevModel }, endpointFrom(entries, 'qwen'), 'synthetic-token');
      const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
      assert.deepEqual(settings.variables, { HUB_URL: 'https://hub.example.invalid/mcp', ...(jevModel ? { JEV_MODEL: jevModel } : {}) });
      assert.deepEqual(JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8')), { secrets: { HUB_TOKEN: 'synthetic-token' } });
      assert.equal(statSync(join(home, 'skills')).mode & 0o777, 0o700);
      for (const f of written.files) assert.equal(statSync(join(home, f)).mode & 0o777, 0o600);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('skills screen lists owner followups without exposing the Jev model value or any key', () => {
  const dir = scratch();
  try {
    const envFile = join(dir, 'synthetic.env'); writeFileSync(envFile, ENV); const lines: string[] = [];
    const argv = ['--env-file', envFile, '--home', join(dir, 'home'), '--provider', 'qwen', '--profile', 'skills'];
    assert.equal(main(argv, { HUB_REAL_TOKEN: 'synthetic-token' }, line => lines.push(line)), 0);
    const shown = lines.join('\n'); for (const hint of ['/secrets JEV_API_KEY', '/variables JEV_MODEL', 'local-tools verify --digest', 'pack-files.ts --verify-install']) assert.ok(shown.includes(hint));
    assert.ok(!/synthetic-token|qwen-secret|qwen\.example/.test(shown));
    const selected = [...argv]; selected[selected.indexOf('--home') + 1] = join(dir, 'selected'); selected.push('--jev-model', 'synthetic-private-model'); lines.length = 0;
    assert.equal(main(selected, { HUB_REAL_TOKEN: 'synthetic-token', JEV_API_KEY: 'synthetic-never-read-key' }, line => lines.push(line)), 0);
    assert.ok(!lines.join('\n').includes('/variables JEV_MODEL'));
    for (const value of ['synthetic-private-model', 'synthetic-never-read-key']) assert.ok(!lines.join('\n').includes(value));
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'selected/secrets.json'), 'utf8')), { secrets: { HUB_TOKEN: 'synthetic-token' } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function skillsFixture() {
  const dir = scratch(), home = join(dir, 'home');
  const written = writeHome({ home, profile: 'skills', hubUrl: 'https://hub.example.invalid/mcp' }, endpointFrom(entries, 'qwen'), 'synthetic-token');
  const root = join(home, 'skills', 'x'); mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'SKILL.md'), '# Synthetic skill\n'); const script = join(root, 'tools', 't.ts'); writeFileSync(script, '// synthetic\n');
  const hook = join(home, written.files.find(f => f.startsWith('hooks/'))!);
  const input = (tool_name = 'execute', tool_input: Record<string, unknown> = { command: `node ${script} --a b` }, paths: unknown = []) => ({ event: 'before_tool', cwd: written.workdir, tool_name, tool_input, paths });
  const raw = (stdin: string) => { const child = spawnSync(process.execPath, [hook], { input: stdin, encoding: 'utf8', timeout: 5000 }); assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout) as { decision: string; reason: string }; };
  return { dir, home, root, script, workdir: written.workdir, hook, input, decide: (value: unknown) => raw(JSON.stringify(value)), raw, close: () => rmSync(dir, { recursive: true, force: true }) };
}
test('skills guard allows six Hub tools todos and skill but denies write tools and malformed input', () => {
  const f = skillsFixture();
  try {
    for (const tool of [...HUB_TOOLS.map(t => `${SERVER_NAME}_${t}`), 'write_todos', 'skill']) assert.equal(f.decide(f.input(tool, {})).decision, 'allow', tool);
    for (const tool of ['write_file', 'edit_file', 'bash', 'hub_other']) assert.equal(f.decide(f.input(tool, {})).decision, 'deny', tool);
    for (const input of [null, [], {}, { tool_name: 'skill' }, f.input('execute', { command: 1 }), { ...f.input('skill', {}), tool_input: [] }]) assert.equal(f.decide(input).decision, 'deny');
    assert.equal(f.raw('not json').decision, 'deny');
    const config = JSON.parse(readFileSync(join(f.home, 'hooks.json'), 'utf8')); assert.equal(config.hooks.before_tool.length, 1);
  } finally { f.close(); }
});
test('readonly file tools require every path inside the configured workspace', async () => {
  const { symlinkSync } = await import('node:fs'); const f = skillsFixture();
  try {
    const inside = join(f.workdir, 'inside.txt'); writeFileSync(inside, 'synthetic'); const outside = join(f.dir, 'outside.txt'); writeFileSync(outside, 'synthetic');
    symlinkSync(outside, join(f.workdir, 'escape.txt'));
    for (const tool of ['read_file', 'ls', 'glob', 'grep']) {
      assert.equal(f.decide(f.input(tool, tool === 'glob' ? {pattern:'**/*'} : {}, [inside])).decision, 'allow');
      for (const paths of [[], [outside], [inside, outside], [join(f.workdir, 'escape.txt')], [1], ['']]) assert.equal(f.decide(f.input(tool, {}, paths)).decision, 'deny', tool);
    }
  } finally { f.close(); }
});
test('execute permits only a Node TypeScript script below skills and the declared argument grammar', () => {
  const f = skillsFixture();
  try {
    for (const command of [`node ${f.script} --a b`, `node '${f.script}' --a 'a value' --b=two`, `node ${f.script} --send <<'EOF'\n%JEV_API_KEY%\n%HUB_TOKEN%\nEOF`, `node ${f.script} <<'END'\n%HUB_TOKEN%\nEND\n`]) assert.equal(f.decide(f.input('execute', { command, background: true, timeout: 10 })).decision, 'allow', command);
    for (const suffix of ['; echo bad', '&& echo bad', '| cat', '`echo bad`', '$(echo bad)', '> out', '2>out', '\necho bad']) {
      const result = f.decide(f.input('execute', { command: `node ${f.script} ${suffix}` })); assert.equal(result.decision, 'deny', suffix); assert.match(result.reason, /这个目录只放行技能目录里的脚本/);
    }
    for (const command of [`node -e 'x'`, `node --input-type=module ${f.script}`, `node ${f.script} <<EOF\n%HUB_TOKEN%\nEOF`, `node ${f.script} <<'EOF'\nnot-a-placeholder\nEOF`, `node ${f.script} <<'EOF'\n%HUB_TOKEN% extra\nEOF`, `node ${f.script} <<'EOF'\n%HUB_TOKEN%\nEOF\necho bad`, `node ${join(f.home, 'outside.ts')}`, `node ${f.root}/tools/../tools/t.ts`, `node tools/t.ts`, `node ${f.script}.mjs`, `node ${f.script} "double quoted"`, `node ${f.script} 'unclosed`, `node ${f.script} 'one'two`]) assert.equal(f.decide(f.input('execute', { command })).decision, 'deny', command);
  } finally { f.close(); }
});
test('canonical script containment rejects symlinks to scripts outside skills', async () => {
  const { symlinkSync } = await import('node:fs'); const f = skillsFixture();
  try {
    const outside = join(f.dir, 'outside.ts'); writeFileSync(outside, '// synthetic'); const link = join(f.root, 'tools', 'linked.ts'); symlinkSync(outside, link);
    assert.equal(f.decide(f.input('execute', { command: `node ${link}` })).decision, 'deny');
  } finally { f.close(); }
});

function skillHooks(f: ReturnType<typeof skillsFixture>, bodies: Array<{ source: string; timeout_ms?: number; tools?: string | string[]; paths?: string[] }>) {
  const hooks = bodies.map((body, i) => { const file = join(f.root, `hook-${i}.mjs`); writeFileSync(file, body.source); const { source: _source, ...settings } = body; return { name: `synthetic-${i}`, command: `node ${JSON.stringify(file)}`, ...settings }; });
  writeFileSync(join(f.root, 'hooks.json'), JSON.stringify({ version: 1, hooks: { before_tool: hooks } }));
}
test('an unloaded Jev style skill still asks for send and receives the identical redacted input', () => {
  const f = skillsFixture();
  try {
    const copy = join(f.root, 'received.json');
    skillHooks(f, [{ source: `import{writeFileSync}from'node:fs';let raw='';for await(const x of process.stdin)raw+=x;writeFileSync(${JSON.stringify(copy)},raw);const i=JSON.parse(raw);console.log(JSON.stringify({decision:i.tool_input.command.includes('--send')?'ask':'allow',reason:'合成外发需要确认'}));` }]);
    const input = f.input('execute', { command: `node ${f.script} --send <<'EOF'\n%JEV_API_KEY%\n%HUB_TOKEN%\nEOF` });
    assert.equal(f.decide(input).decision, 'ask'); assert.equal(readFileSync(copy, 'utf8'), JSON.stringify(input));
    assert.equal(f.decide(f.input()).decision, 'allow');
  } finally { f.close(); }
});
test('every matching hook runs and deny wins over ask and allow', () => {
  const f = skillsFixture();
  try {
    const marker = join(f.root, 'last-ran');
    skillHooks(f, [{ source: 'console.log(JSON.stringify({decision:"ask",reason:"合成确认"}));' }, { source: 'console.log(JSON.stringify({decision:"deny",reason:"合成拒绝"}));' }, { source: `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'yes');console.log(JSON.stringify({decision:'allow'}));` }]);
    const reply = f.decide(f.input()); assert.equal(reply.decision, 'deny'); assert.match(reply.reason, /synthetic-1.*合成拒绝/); assert.equal(readFileSync(marker, 'utf8'), 'yes');
    skillHooks(f, [{ source: 'console.log(JSON.stringify({decision:"ask",reason:"合成确认"}));' }, { source: 'console.log(JSON.stringify({decision:"allow"}));' }]); assert.equal(f.decide(f.input()).decision, 'ask');
  } finally { f.close(); }
});
test('skill hook failures timeouts and non-object outputs fail closed', () => {
  const f = skillsFixture();
  try {
    for (const source of ['', 'process.stdout.write("x".repeat(120000));', 'process.exit(1);', 'process.exit(2);', 'console.log("not JSON");', 'console.log("[]");', 'console.log("null");', 'setInterval(()=>{},1000);']) {
      skillHooks(f, [{ source, timeout_ms: 100 }]); assert.equal(f.decide(f.input()).decision, 'deny', source);
    }
  } finally { f.close(); }
});
test('no skill hooks allows while unreadable or malformed declarations deny', () => {
  const f = skillsFixture();
  try {
    assert.equal(f.decide(f.input()).decision, 'allow');
    for (const value of ['not JSON', '[]', '{"version":2,"hooks":{}}', '{"hooks":{"before_tool":{}}}', '{"hooks":{"before_tool":[{}]}}']) { writeFileSync(join(f.root, 'hooks.json'), value); assert.equal(f.decide(f.input()).decision, 'deny'); }
    rmSync(join(f.root, 'hooks.json')); mkdirSync(join(f.root, 'hooks.json')); assert.equal(f.decide(f.input()).decision, 'deny');
  } finally { f.close(); }
});
test('tool and path filters follow Circle before_tool matching', () => {
  const f = skillsFixture();
  try {
    skillHooks(f, [{ source: 'console.log(JSON.stringify({decision:"deny"}));', tools: 'read_file' }]); assert.equal(f.decide(f.input()).decision, 'allow');
    skillHooks(f, [{ source: 'console.log(JSON.stringify({decision:"ask"}));', tools: 'execute|read_file', paths: ['**/*.ts'] }]);
    assert.equal(f.decide(f.input()).decision, 'allow');
    const file = join(f.workdir, 'nested', 'x.ts'); mkdirSync(join(f.workdir, 'nested')); writeFileSync(file, '');
    assert.equal(f.decide(f.input('execute', { command: `node ${f.script}` }, [file])).decision, 'ask');
    const declaration = JSON.parse(readFileSync(join(f.root, 'hooks.json'), 'utf8')); declaration.hooks.before_tool[0].paths = [join(f.workdir, '**', '*.ts')]; writeFileSync(join(f.root, 'hooks.json'), JSON.stringify(declaration));
    assert.equal(f.decide(f.input('execute', { command: `node ${f.script}` }, [file])).decision, 'ask');
  } finally { f.close(); }
});


test('deeply nested installed scripts retain their skill hook and neutral hook JSON permits execution', () => {
  const f = skillsFixture();
  try {
    const nested = join(f.root, 'deep', 'nested', 'tools'); mkdirSync(nested, { recursive: true }); const script = join(nested, 't.ts'); writeFileSync(script, '// synthetic');
    skillHooks(f, [{ source: 'console.log(JSON.stringify({decision:"ask",reason:"合成确认"}));' }]);
    assert.equal(f.decide(f.input('execute', { command: `node ${script}` })).decision, 'ask');
    skillHooks(f, [{ source: 'console.log("{}");' }]); assert.equal(f.decide(f.input()).decision, 'allow');
  } finally { f.close(); }
});


test('the installed skills hook command handles quoted home paths without shell interpolation', () => {
  const dir = scratch();
  try {
    const home = join(dir, "home ' $(touch synthetic-marker)");
    const written = writeHome({ home, profile: 'skills', hubUrl: 'https://hub.example.invalid/mcp' }, endpointFrom(entries, 'qwen'), 'synthetic-token');
    const hooks = JSON.parse(readFileSync(join(home, 'hooks.json'), 'utf8'));
    const result = spawnSync(hooks.hooks.before_tool[0].command, { cwd: written.workdir, shell: true, input: JSON.stringify({ event: 'before_tool', tool_name: 'hub_start_run', tool_input: {}, paths: [], cwd: written.workdir }), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).decision, 'allow');
    assert.throws(() => statSync(join(written.workdir, 'synthetic-marker')), /ENOENT/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('only the installed script spelling can reach a skill send approval hook',async()=>{
  const {symlinkSync}=await import('node:fs');const f=skillsFixture();
  try{
    skillHooks(f,[{source:`let raw='';for await(const part of process.stdin)raw+=part;const input=JSON.parse(raw);console.log(JSON.stringify({decision:input.tool_input.command.includes('t.ts')&&input.tool_input.command.includes('--send')?'ask':'allow',reason:'合成发送确认'}));`}]);
    assert.equal(f.decide(f.input('execute',{command:`node ${f.script} --send`})).decision,'ask');
    for(const name of ['T.ts','t.TS'])assert.equal(f.decide(f.input('execute',{command:`node ${join(f.root,'tools',name)} --send`})).decision,'deny');
    const alias=join(f.root,'tools','alias.ts');symlinkSync(f.script,alias);assert.equal(f.decide(f.input('execute',{command:`node ${alias} --send`})).decision,'deny');
  }finally{f.close();}
});

test('glob patterns cannot escape the workspace independently of their reported path',()=>{
  const f=skillsFixture();
  try{
    for(const pattern of [join(f.dir,'outside','**/*'),'../../**/*.yml',['~','private','**','*'].join('/'),'{../outside,safe}/**/*','{safe,/outside}/**/*',String.raw`nested/\.\./\.\./outside/*`])assert.equal(f.decide(f.input('glob',{pattern,path:f.workdir},[f.workdir])).decision,'deny',pattern);
    for(const pattern of ['**/*.ts','src/**/*.ts','test/**/*.ts','name..literal/*'])assert.equal(f.decide(f.input('glob',{pattern,path:f.workdir},[f.workdir])).decision,'allow',pattern);
    assert.equal(f.decide(f.input('read_file',{path:'large_tool_results/example'},[join(f.workdir,'large_tool_results/example')])).decision,'allow','Circle-owned offload reads retain their existing semantics');
  }finally{f.close();}
});

test('padded delegated decisions retain their deny and ask strength while empty output still denies',()=>{
  const f=skillsFixture();
  try{
    for(const [word,decision]of [['deny ','deny'],['ask\n','ask'],[' ask','ask'],['allow ','allow']]){
      skillHooks(f,[{source:`console.log(JSON.stringify({decision:${JSON.stringify(word)},reason:'合成带空白决定'}));`}]);assert.equal(f.decide(f.input()).decision,decision);
    }
    skillHooks(f,[{source:'process.stdout.write("   ");'}]);assert.equal(f.decide(f.input()).decision,'deny');
  }finally{f.close();}
});

test('here document separators use shell spaces and tabs rather than JavaScript whitespace',()=>{
  const f=skillsFixture();
  try{
    for(const separator of ['\u00a0','\v','\f','\r','\u3000','\u2028','\ufeff'])assert.equal(f.decide(f.input('execute',{command:`node ${f.script} --a b${separator}<<'EOF'\n%HUB_TOKEN%\nEOF`})).decision,'deny',JSON.stringify(separator));
    for(const separator of [' ','\t'])assert.equal(f.decide(f.input('execute',{command:`node ${f.script} --a b${separator}<<'EOF'\n%HUB_TOKEN%\nEOF`})).decision,'allow');
  }finally{f.close();}
});

test('refusal sites disclose their own missing fact and recovery action',async()=>{
  const {renameSync,symlinkSync}=await import('node:fs');const f=skillsFixture();
  try{
    const outside=join(f.dir,'outside.txt');writeFileSync(outside,'synthetic');const refused=f.decide(f.input('read_file',{path:outside},[outside]));
    assert.equal(refused.decision,'deny');assert.ok(refused.reason.includes(outside));assert.match(refused.reason,/工作目录.*改用/);
    assert.match(f.decide(f.input('ls',{},[])).reason,/ls.*路径.*重试/);
    writeFileSync(join(f.root,'hooks.json'),'not JSON');const malformed=f.decide(f.input());assert.match(malformed.reason,/技能.*x.*hooks\.json.*JSON.*安装.*verify/);
    rmSync(join(f.root,'hooks.json'));renameSync(join(f.home,'skills'),join(f.home,'saved-skills'));mkdirSync(join(f.dir,'other-skills'));symlinkSync(join(f.dir,'other-skills'),join(f.home,'skills'));
    assert.match(f.decide(f.input()).reason,/skills.*根.*恢复/);
  }finally{f.close();}
});
test('delegated decisions identify the skill and hook even when the hook omits its reason',()=>{
  const f=skillsFixture();
  try{
    skillHooks(f,[{source:'console.log(JSON.stringify({decision:"ask"}));'}]);const result=f.decide(f.input());assert.equal(result.decision,'ask');assert.match(result.reason,/技能.*x.*synthetic-0.*确认/);
    skillHooks(f,[{source:'process.exit(1);'}]);const failed=f.decide(f.input());assert.equal(failed.decision,'deny');assert.match(failed.reason,/技能.*x.*synthetic-0.*退出码 1.*verify/);
  }finally{f.close();}
});

for (const pattern of ['[.][.]/**/*', '.[.]/*', '[.]./*', '{.,x}{.,y}/**/*', '.{.,z}/*', '{.,z}./*', '[.][.]/[.][.]/**/*']) {
  test(`glob refuses expanded parent traversal ${pattern}`, () => {
    const f = skillsFixture();
    try { assert.equal(f.decide(f.input('glob', { pattern, path: f.workdir }, [f.workdir])).decision, 'deny'); }
    finally { f.close(); }
  });
}

test('glob permits only nonempty relative literal and star segments with no expansion syntax', () => {
  const f = skillsFixture();
  try {
    for (const pattern of ['*.json', '**/*', 'src/**/*.ts', 'src-1/_file.*', '.config/*.json', '*.*', 'name..literal/*']) assert.equal(f.decide(f.input('glob', { pattern, path: f.workdir }, [f.workdir])).decision, 'allow', pattern);
    for (const pattern of ['', '/', '//src/*', '/src/*', 'src//*.ts', 'src/', '..', 'src/../*', './*', '[ab]/*', '{src,test}/**/*.ts', '**/*.{ts,js}', '@(src|test)/*', '!(src)/*', 'src/?.ts', 'src\\*.ts', 'src/**x/*', 'src/文件*', 'src/*.ts\n']) {
      const reply = f.decide(f.input('glob', { pattern, path: f.workdir }, [f.workdir]));
      assert.equal(reply.decision, 'deny', pattern); assert.match(reply.reason, /glob.*文法.*重试/);
    }
  } finally { f.close(); }
});

for (const pattern of ['linked/*', 'linked/**/*.txt', '**/linked/*', '*/*.txt']) {
  test(`glob refuses directory symlink traversal ${pattern}`, async () => {
    const { symlinkSync } = await import('node:fs'); const f = skillsFixture();
    try {
      const outside = join(f.dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'synthetic-outside.txt'), 'synthetic');
      symlinkSync(outside, join(f.workdir, 'linked'), 'dir');
      const reply = f.decide(f.input('glob', { pattern, path: f.workdir }, [f.workdir]));
      assert.equal(reply.decision, 'deny'); assert.match(reply.reason, /glob.*软链接.*重试/);
    } finally { f.close(); }
  });
}

test('glob checks nested and wildcard directory segments while allowing searches that never traverse a link', async () => {
  const { symlinkSync } = await import('node:fs'); const f = skillsFixture();
  try {
    const safe = join(f.workdir, 'safe'); mkdirSync(safe); writeFileSync(join(safe, 'synthetic-inside.txt'), 'synthetic');
    const outside = join(f.dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'synthetic-outside.txt'), 'synthetic');
    symlinkSync(outside, join(f.workdir, 'linked'), 'dir'); symlinkSync(outside, join(safe, 'nested-link'), 'dir');
    symlinkSync(safe, join(f.workdir, 'inside-alias'), 'dir'); symlinkSync(join(f.dir, 'absent'), join(f.workdir, 'dangling'), 'dir');
    for (const pattern of ['safe/*.txt', '**/*.txt', 'safe/missing/*.txt']) assert.equal(f.decide(f.input('glob', { pattern, path: f.workdir }, [f.workdir])).decision, 'allow', pattern);
    for (const pattern of ['safe/nested-link/*', 'safe/*/*.txt', 'safe/**/*.txt', '**/nested-link/*', 'l*/*.txt', 'inside-alias/*.txt', 'dangling/*']) assert.equal(f.decide(f.input('glob', { pattern, path: f.workdir }, [f.workdir])).decision, 'deny', pattern);
  } finally { f.close(); }
});


test('glob wildcard directory checks include names containing a newline', async () => {
  const { symlinkSync } = await import('node:fs'); const f = skillsFixture();
  try {
    const outside = join(f.dir, 'outside'); mkdirSync(outside); writeFileSync(join(outside, 'synthetic-outside.txt'), 'synthetic');
    symlinkSync(outside, join(f.workdir, 'line\nbreak'), 'dir');
    assert.equal(f.decide(f.input('glob', { pattern: '*/*.txt', path: f.workdir }, [f.workdir])).decision, 'deny');
  } finally { f.close(); }
});

test('writeHome without contextWindow writes settings.json exactly as before, and with it writes the model window', () => {
  const dir = mkdtempSync(join(tmpdir(), 'chub-home-'));
  const endpoint: Endpoint = { protocol: 'anthropic', baseUrl: 'http://127.0.0.1:9/v1', apiKey: 'k', model: 'scripted-model', sources: ['scripted'] };
  writeHome({ envFile: 'f', home: join(dir, 'a'), provider: 'qwen', hubUrl: 'http://127.0.0.1:7420/mcp' }, endpoint, 't');
  const plainSettings = JSON.parse(readFileSync(join(dir, 'a', 'settings.json'), 'utf8'));
  assert.equal(plainSettings.models, undefined, 'no models key without the option');
  const big = writeHome({ envFile: 'f', home: join(dir, 'b'), provider: 'qwen', hubUrl: 'http://127.0.0.1:7420/mcp', contextWindow: 1_000_000 }, endpoint, 't');
  void big;
  const bigSettings = JSON.parse(readFileSync(join(dir, 'b', 'settings.json'), 'utf8'));
  assert.deepEqual(bigSettings.models, { 'scripted-model': { context_window: 1_000_000 } });
});

test('model calls cannot create links or rename directories through direct tools or shell commands', () => {
  const f=skillsFixture();
  try {
    for(const tool of ['write_file','edit_file','move_file','rename','rename_directory','symlink','create_symlink','link','cp'])assert.equal(f.decide(f.input(tool,{path:f.workdir},[f.workdir])).decision,'deny',tool);
    for(const command of ['ln -s outside slot','mv slot slot-before','cp -R outside slot',"node -e 'process.exit(0)'"])assert.equal(f.decide(f.input('execute',{command})).decision,'deny',command);
    assert.equal(f.decide(f.input('execute',{command:`node ${f.script} --a b`})).decision,'allow','installed scripts remain subject to the separate manifest static check');
  }finally{f.close();}
});
