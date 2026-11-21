import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { HUB_TOOLS, INTERNAL_TOOLS_ALLOWED, PLUMB_KEY_SECRET, SERVER_NAME, TOKEN_SECRET, circleEndpoint, endpointFrom, firstLineOf, main, parseArgs, writeHome, type Endpoint } from './circle-home.ts';
import { parseEnvText } from './lib/env-file.ts';
import { extractTaughtCommands, instantiateTaughtCommand } from './taught-commands.ts';
import { parseCommand } from './guard-lib.ts';

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
    assert.deepEqual(settings.mcpServers, {
      [SERVER_NAME]: {
        type: 'http',
        url: 'http://127.0.0.1:7420/mcp',
        placeholders: { url: 'HUB_URL', token: 'HUB_TOKEN' },
        headers: { Authorization: `Bearer \${secret:${TOKEN_SECRET}}` },
      },
    });
    assert.equal(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.type, 'command');
    assert.equal(settings.hooks?.PreToolUse?.[0]?.hooks?.[0]?.onFailure, 'block');
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
      const parsed = JSON.parse(r.stdout);
      return parsed.hookSpecificOutput ? parsed.hookSpecificOutput.permissionDecision : parsed.decision;
    };
    for (const t of HUB_TOOLS) {
      assert.equal(decide(JSON.stringify({ event: 'before_tool', tool_name: `mcp__${SERVER_NAME}__${t}` })), 'allow', t);
      assert.equal(decide(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: `mcp__Hub__${t}` })), 'allow', `PreToolUse:${t}`);
    }
    for (const t of INTERNAL_TOOLS_ALLOWED) assert.equal(decide(JSON.stringify({ event: 'before_tool', tool_name: t })), 'allow', t);
    for (const t of ['bash', 'webfetch', 'websearch', 'write_file', 'read_file', `mcp__${SERVER_NAME}__other`, 'mcp__hubx__start_run', 'hub_start_run']) {
      assert.equal(decide(JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: t })), 'deny', t);
    }
    assert.equal(decide('not json'), 'deny');
    assert.equal(decide(''), 'deny');
    assert.equal(existsSync(join(dir, 'home', 'hooks.json')), false);
    const writtenSettings = JSON.parse(readFileSync(join(dir, 'home', 'settings.json'), 'utf8'));
    assert.equal(writtenSettings.hooks.PreToolUse.length, 1);
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
  'settings.json': '5109958f4222737c84f6ac0fe626971030f6aa858d2b11c5d1427fb1698ade43',
  'credentials.json': ["bae342","f65c62","474558","2bb94c","f7ff51","b0e3f6","e3ff60","8454ff","f61df2","17e294","7425"].join(''),
  'secrets.json': ["080e2c","babac7","df441b","fe6e72","0f4c06","7a3795","5a5077","9ce58d","981977","031c6a","79e5"].join(''),
  'hooks/hub-only.mjs': '1029618481271a93b493105a8a3b242586b5891481fd26f81b6a1890847a4c70',
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
test('profile arguments default to review and accept review, skills and ops', () => {
  const args = ['--env-file', 'synthetic.env', '--home', 'home', '--provider', 'qwen'];
  assert.equal(parseArgs(args).profile, 'review');
  assert.equal(parseArgs([...args, '--profile', 'skills', '--jev-model', 'synthetic-jev']).jevModel, 'synthetic-jev');
  assert.equal(parseArgs([...args, '--profile', 'ops']).profile, 'ops');
  assert.throws(() => parseArgs([...args, '--profile', 'unknown']), /profile/);
});
test('skills settings add only named variables, trust_cert_files, and a private empty skills directory', () => {
  const dir = scratch();
  try {
    for (const jevModel of [undefined, 'synthetic-jev']) {
      const home = join(dir, jevModel ? 'selected' : 'unset');
      const written = writeHome(
        {
          home,
          hubUrl: 'https://hub.example.invalid/mcp',
          profile: 'skills',
          jevModel,
          ...(jevModel ? { plumbUrl: 'https://plumb.example.invalid', plumbModel: 'plumb-27b-0.5.0', plumbCaFile: '/certs/plumb-ca.pem' } : {}),
        },
        endpointFrom(entries, 'qwen'),
        'synthetic-token',
      );
      const settings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
      assert.deepEqual(settings.variables, {
        HUB_URL: 'https://hub.example.invalid/mcp',
        ...(jevModel ? { JEV_MODEL: jevModel, PLUMB_URL: 'https://plumb.example.invalid', PLUMB_MODEL: 'plumb-27b-0.5.0' } : {}),
      });
      if (jevModel) assert.deepEqual(settings.trust_cert_files, ['/certs/plumb-ca.pem']);
      else assert.equal(settings.trust_cert_files, undefined);
      assert.deepEqual(JSON.parse(readFileSync(join(home, 'secrets.json'), 'utf8')), { secrets: { HUB_TOKEN: 'synthetic-token' } });
      assert.equal(statSync(join(home, 'skills')).mode & 0o777, 0o700);
      for (const f of written.files) assert.equal(statSync(join(home, f)).mode & 0o777, 0o600);
    }
    const parsed = parseArgs([
      '--env-file', 'synthetic.env', '--home', 'h', '--provider', 'qwen', '--profile', 'ops',
      '--plumb-url', 'https://plumb.example.invalid', '--plumb-model', 'plumb-27b-0.5.0', '--plumb-ca-file', 'ca.pem',
    ]);
    assert.deepEqual([parsed.plumbUrl, parsed.plumbModel, parsed.plumbCaFile], ['https://plumb.example.invalid', 'plumb-27b-0.5.0', 'ca.pem']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('skills screen lists owner followups including Plumb without exposing model values or any key', () => {
  const dir = scratch();
  try {
    const envFile = join(dir, 'synthetic.env'); writeFileSync(envFile, ENV); const lines: string[] = [];
    const argv = ['--env-file', envFile, '--home', join(dir, 'home'), '--provider', 'qwen', '--profile', 'skills'];
    assert.equal(main(argv, { HUB_REAL_TOKEN: 'synthetic-token' }, line => lines.push(line)), 0);
    const shown = lines.join('\n');
    for (const hint of ['/secrets JEV_API_KEY', '/secrets PLUMB_API_KEY', '/variables JEV_MODEL', '/variables PLUMB_URL', '/variables PLUMB_MODEL', 'local-tools verify --digest', 'pack-files.ts --verify-install']) assert.ok(shown.includes(hint), hint);
    assert.ok(!/synthetic-token|qwen-secret|qwen\.example/.test(shown));
    const selected = [...argv]; selected[selected.indexOf('--home') + 1] = join(dir, 'selected');
    selected.push('--jev-model', 'synthetic-private-model', '--plumb-url', 'https://plumb-private.invalid', '--plumb-model', 'plumb-private-model', '--plumb-ca-file', '/private/ca.pem');
    lines.length = 0;
    assert.equal(main(selected, { HUB_REAL_TOKEN: 'synthetic-token', JEV_API_KEY: 'synthetic-never-read-key', PLUMB_API_KEY: 'synthetic-plumb-secret' }, line => lines.push(line)), 0);
    const selectedText = lines.join('\n');
    assert.ok(!selectedText.includes('/variables JEV_MODEL'));
    assert.ok(!selectedText.includes('/variables PLUMB_URL'));
    assert.ok(!selectedText.includes('/variables PLUMB_MODEL'));
    for (const value of ['synthetic-private-model', 'synthetic-never-read-key', 'plumb-private.invalid', 'plumb-private-model', '/private/ca.pem', 'synthetic-plumb-secret']) {
      assert.ok(!selectedText.includes(value), `leaked ${value}`);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'selected/secrets.json'), 'utf8')), { secrets: { HUB_TOKEN: 'synthetic-token' } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function skillsFixture() {
  const dir = scratch(), home = join(dir, 'home');
  const written = writeHome({ home, profile: 'skills', hubUrl: 'https://hub.example.invalid/mcp' }, endpointFrom(entries, 'qwen'), 'synthetic-token');
  const root = join(home, 'skills', 'x'); mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'SKILL.md'), '# Synthetic skill\n');
  const script = join(root, 'tools', 't.ts'); writeFileSync(script, '// synthetic\n');
  writeFileSync(join(root, 'tools', 't.cli.json'), JSON.stringify({ schema: 'tool-cli@2', stdin: [], options: [...['a','b'].map(name=>({name,type:'path',required:false,kind:'string',multiple:false,placeholder:null})), {name:'send',type:'text',required:false,kind:'boolean',multiple:false,placeholder:null}] }));
  const token1 = join(root, 'tools', 't-token.ts'); writeFileSync(token1, '// synthetic token1\n');
  writeFileSync(join(root, 'tools', 't-token.cli.json'), JSON.stringify({ schema: 'tool-cli@2', stdin: ['%HUB_TOKEN%'], options: ['a','b'].map(name=>({name,type:'path',required:false,kind:'string',multiple:false,placeholder:null})) }));
  const token2 = join(root, 'tools', 't-send.ts'); writeFileSync(token2, '// synthetic token2\n');
  writeFileSync(join(root, 'tools', 't-send.cli.json'), JSON.stringify({ schema: 'tool-cli@2', stdin: ['%JEV_API_KEY%', '%HUB_TOKEN%'], options: [{name:'send',type:'text',required:false,kind:'boolean',multiple:false,placeholder:null}] }));
  const hook = join(home, written.files.find(f => f.startsWith('hooks/'))!);
  const input = (tool_name = 'execute', tool_input: Record<string, unknown> = { command: `node ${script} --a b` }, paths: unknown = []) => ({ event: 'before_tool', cwd: written.workdir, tool_name, tool_input, paths });
  const raw = (stdin: string) => { const child = spawnSync(process.execPath, [hook], { input: stdin, encoding: 'utf8', timeout: 5000 }); assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout) as { decision: string; reason: string }; };
  return { dir, home, root, script, token1, token2, workdir: written.workdir, hook, input, decide: (value: unknown) => raw(JSON.stringify(value)), raw, close: () => rmSync(dir, { recursive: true, force: true }) };
}
test('skills guard allows six Hub tools todos and installed skill but denies write tools and malformed input', () => {
  const f = skillsFixture();
  try {
    for (const tool of [...HUB_TOOLS.map(t => `mcp__${SERVER_NAME}__${t}`), 'write_todos']) assert.equal(f.decide(f.input(tool, {})).decision, 'allow', tool);
    assert.equal(f.decide(f.input('skill', { name: 'x' })).decision, 'allow', 'installed skill');
    for (const badSkill of [{}, { name: 'missing' }]) assert.equal(f.decide(f.input('skill', badSkill)).decision, 'deny', JSON.stringify(badSkill));
    for (const tool of ['write_file', 'edit_file', 'bash', 'mcp__hub__other', 'hub_start_run']) assert.equal(f.decide(f.input(tool, {})).decision, 'deny', tool);
    for (const input of [null, [], {}, { tool_name: 'skill' }, f.input('execute', { command: 1 }), { ...f.input('skill', {}), tool_input: [] }]) assert.equal(f.decide(input).decision, 'deny');
    assert.equal(f.raw('not json').decision, 'deny');
    assert.equal(existsSync(join(f.home, 'hooks.json')), false);
    const settingsConfig = JSON.parse(readFileSync(join(f.home, 'settings.json'), 'utf8')); assert.equal(settingsConfig.hooks.PreToolUse.length, 1);
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
    for (const command of [`node ${f.script} --a b`, `node '${f.script}' --a 'a value' --b two`, `node ${f.token2} --send <<'EOF'\n%JEV_API_KEY%\n%HUB_TOKEN%\nEOF`, `node ${f.token1} <<'END'\n%HUB_TOKEN%\nEND\n`]) assert.equal(f.decide(f.input('execute', { command, background: true, timeout: 10 })).decision, 'allow', command);
    for (const suffix of ['; echo bad', '&& echo bad', '| cat', '`echo bad`', '$(echo bad)', '> out', '2>out', '\necho bad']) {
      const result = f.decide(f.input('execute', { command: `node ${f.script} ${suffix}` })); assert.equal(result.decision, 'deny', suffix); assert.match(result.reason, /这个目录只放行技能目录里的脚本/);
    }
    for (const command of [`node -e 'x'`, `node --input-type=module ${f.script}`, `node '${f.script}' --a 'a value' --b=two`, `node ${f.token1} <<EOF\n%HUB_TOKEN%\nEOF`, `node ${f.token1} <<'EOF'\nnot-a-placeholder\nEOF`, `node ${f.token1} <<'EOF'\n%HUB_TOKEN% extra\nEOF`, `node ${f.token1} <<'EOF'\n%HUB_TOKEN%\nEOF\necho bad`, `node ${join(f.home, 'outside.ts')}`, `node ${f.root}/tools/../tools/t.ts`, `node tools/t.ts`, `node ${f.script}.mjs`, `node ${f.script} "double quoted"`, `node ${f.script} 'unclosed`, `node ${f.script} 'one'two`]) assert.equal(f.decide(f.input('execute', { command })).decision, 'deny', command);
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
    const input = f.input('execute', { command: `node ${f.token2} --send <<'EOF'\n%JEV_API_KEY%\n%HUB_TOKEN%\nEOF` });
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
    const nested = join(f.root, 'deep', 'nested', 'tools'); mkdirSync(nested, { recursive: true }); const script = join(nested, 't.ts'); writeFileSync(script, '// synthetic'); writeFileSync(join(nested,'t.cli.json'), JSON.stringify({schema:'tool-cli@2',stdin:[],options:[]}));
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
    const writtenSettings = JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'));
    const result = spawnSync(writtenSettings.hooks.PreToolUse[0].hooks[0].command, { cwd: written.workdir, shell: true, input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'mcp__hub__start_run', tool_input: {}, paths: [], cwd: written.workdir }), encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'allow');
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

test('undeclared padded delegated decision values fail closed instead of being normalized',()=>{
  const f=skillsFixture();
  try{
    for(const [word,decision]of [['deny ','deny'],['ask\n','deny'],[' ask','deny'],['allow ','deny']]){
      skillHooks(f,[{source:`console.log(JSON.stringify({decision:${JSON.stringify(word)},reason:'合成带空白决定'}));`}]);assert.equal(f.decide(f.input()).decision,decision);
    }
    skillHooks(f,[{source:'process.stdout.write("   ");'}]);assert.equal(f.decide(f.input()).decision,'deny');
  }finally{f.close();}
});

test('here document separators use shell spaces and tabs rather than JavaScript whitespace',()=>{
  const f=skillsFixture();
  try{
    for(const separator of ['\u00a0','\v','\f','\r','\u3000','\u2028','\ufeff'])assert.equal(f.decide(f.input('execute',{command:`node ${f.token1} --a b${separator}<<'EOF'\n%HUB_TOKEN%\nEOF`})).decision,'deny',JSON.stringify(separator));
    for(const separator of [' ','\t'])assert.equal(f.decide(f.input('execute',{command:`node ${f.token1} --a b${separator}<<'EOF'\n%HUB_TOKEN%\nEOF`})).decision,'allow');
  }finally{f.close();}
});

test('refusal sites disclose their own missing fact and recovery action',async()=>{
  const {renameSync,symlinkSync}=await import('node:fs');const f=skillsFixture();
  try{
    const outside=join(f.dir,'outside.txt');writeFileSync(outside,'synthetic');const refused=f.decide(f.input('read_file',{path:outside},[outside]));
    assert.equal(refused.decision,'deny');assert.ok(refused.reason.includes(outside));assert.equal(refused.reason.split('\n').length,3);assert.match(refused.reason,/工作目录[\s\S]*改用/);assert.match(refused.reason,/ALLOWED\.md/);
    assert.match(f.decide(f.input('ls',{},[])).reason,/ls.*路径[\s\S]*重试/);
    writeFileSync(join(f.root,'hooks.json'),'not JSON');const malformed=f.decide(f.input());assert.match(malformed.reason,/技能.*x.*hooks\.json.*JSON.*安装.*verify/);
    rmSync(join(f.root,'hooks.json'));renameSync(join(f.home,'skills'),join(f.home,'saved-skills'));mkdirSync(join(f.dir,'other-skills'));symlinkSync(join(f.dir,'other-skills'),join(f.home,'skills'));
    assert.match(f.decide(f.input()).reason,/skills.*根[\s\S]*恢复/);
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
      assert.equal(reply.decision, 'deny', pattern); assert.match(reply.reason, /glob.*文法[\s\S]*重试/);
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

test('the case-compile, recompose and jev skill commands, filled in as Circle hands them to hooks, pass both skills and ops unified home guards', () => {
  const dir = scratch();
  try {
    const hubUrl = 'https://hub.example.invalid/mcp';
    const plumbUrl = 'https://plumb.example.invalid';
    for (const [label, profile, home] of [
      ['skills', 'skills', join(dir, 'home-skills')],
      ['ops-with-spaces', 'ops', join(dir, 'Application Support', 'home-ops')],
    ] as const) {
      const written = writeHome({ home, profile, hubUrl, plumbUrl, plumbModel: 'plumb-27b-0.5.0' }, endpointFrom(entries, 'qwen'), 'synthetic-token');
      const hook = join(home, written.files.find((file) => file.startsWith('hooks/'))!);
      const decide = (command: string) => {
        const child = spawnSync(process.execPath, [hook], {
          input: JSON.stringify({ event: 'before_tool', cwd: written.workdir, tool_name: 'execute', tool_input: { command }, paths: [] }),
          encoding: 'utf8',
          timeout: 5000,
        });
        assert.equal(child.status, 0, `${label}: ${child.stderr}`);
        return JSON.parse(child.stdout) as { decision?: string; reason?: string };
      };
      const expectAllowed = (decision: { decision?: string; reason?: string }, msg: string) => {
        if (profile === 'ops') assert.deepEqual(decision, {}, msg);
        else assert.equal(decision.decision, 'allow', msg);
      };

      const packs = [
        {
          name: 'plumb',
          dir: fileURLToPath(new URL('../../packs/skill/plumb/', import.meta.url)),
          expectedScripts: ['plumb.ts'],
        },
        {
          name: 'case-compile',
          dir: fileURLToPath(new URL('../../packs/workflow/case-compile/', import.meta.url)),
          // cmd-verify-plumb.ts is no longer taught: tools/pipeline.ts runs it by code between two subagents (decision 179).
          expectedScripts: ['assemble-delivery.ts', 'carry-plans.ts', 'check-plan.ts', 'cmd-select-plumb.ts', 'download-returns.ts', 'download-run.ts', 'fetch-run.ts', 'fidelity-apply.ts', 'fidelity-brief.ts', 'fidelity-plumb.ts', 'generate-workbook.ts', 'normalize-mindmap.ts', 'open-compile.ts', 'open-merge.ts', 'pipeline.ts', 'submit-plans.ts', 'task-brief.ts'],
        },
        {
          name: 'recompose',
          dir: fileURLToPath(new URL('../../packs/workflow/case-compile/recompose/', import.meta.url)),
          expectedScripts: ['check-record.ts', 'download-run.ts', 'submit-records.ts'],
        },
      ];

      // Install every skill before reading any of them: case-compile/SKILL.md runs the recompose skill's download-run.ts.
      const stagedOf = (pack: (typeof packs)[number]) => (JSON.parse(readFileSync(join(pack.dir, 'pack.json'), 'utf8')) as { files: Array<{ path: string }> })
        .files.filter((file) => file.path === 'SKILL.md' || file.path.startsWith('tools/'));
      for (const pack of packs) {
        for (const { path: rel } of stagedOf(pack)) {
          mkdirSync(dirname(join(home, 'skills', pack.name, rel)), { recursive: true });
          writeFileSync(join(home, 'skills', pack.name, rel), readFileSync(join(pack.dir, rel)));
        }
      }
      for (const pack of packs) {
        const skill = join(home, 'skills', pack.name);
        const staged = stagedOf(pack);
        const docs = staged.map((f) => f.path).filter((p) => p === 'SKILL.md' || (p.startsWith('tools/') && p.endsWith('.md')));
        const parsed = docs.flatMap((docPath) => extractTaughtCommands(readFileSync(join(pack.dir, docPath), 'utf8'), `${pack.name}/${docPath}`));
        assert.ok(parsed.length >= pack.expectedScripts.length, `${pack.name}: extracted commands from ${docs.join(', ')}`);

        const values: Record<string, string> = {
          脚本编写编号: 'run_01aaaaaaaaaaaaaaaaaaaaaaaa',
          用例重组编号: 'run_01bbbbbbbbbbbbbbbbbbbbbbbb',
          脚本合并编号: 'run_01cccccccccccccccccccccccc',
          合并或上机编号: 'run_01cccccccccccccccccccccccc',
          脚本编写目录: 'case-compile-run',
          上一轮脚本编写目录: 'prev-case-compile-run',
          新脚本编写目录: 'case-compile-run',
          上一轮自动化用例目录: 'prev-plans',
          上一轮核对目录: 'prev-fidelity',
          逗号分隔autoid: 'orbit-case-0001',
          autoid: 'orbit-case-0001',
          前缀: '0',
          '8位摘要': 'aaaaaaaa',
          运行目录: 'case-compile-run',
          核对目录: 'fidelity',
          核对任务目录: 'fidelity-tasks',
          核对文件: 'fidelity/0.brief.json',
          自动化用例目录: 'plans',
          重组后的用例目录: 'records',
          下载运行目录: 'recompose-run',
          新目录: 'run-out',
          导出文件: 'export.json',
          规整文件: 'normalized.json',
          '说明.json': 'notes.json',
          'scope.md': 'scope.md',
          用例或范围: 'case-01',
          简报或输入路径: 'briefs/0.md',
          目标路径: 'plans/0.json',
          目标文件路径: 'plans/0.json',
          任务文件路径: 'tasks/0.md',
          补充: '合成补充说明',
          补充说明: '合成补充说明',
          轮次: '2',
          条目JSON: 'items/0.json',
          '路径...': 'plans/r1/0.json',
          '目录...': 'returns/r1',
          范围文件: 'scope.md',
          结构简报JSON: 'briefs/0.json',
          计划或判断JSON: 'plans/0.json',
          CA证书: 'certs/plumb-ca.pem',
          请求JSON: 'plumb-req.json',
          模型: 'synthetic-model',
        };
        const seenScripts = new Set<string>();
        for (const usage of parsed) {
          for (const concrete of instantiateTaughtCommand(usage, { skillDir: skill, skillName: pack.name, placeholders: values })) {
            let command = concrete.replaceAll('%HUB_URL%', hubUrl).replaceAll('%PLUMB_URL%', plumbUrl);
            const scriptPath = parseCommand(command).words[1] ?? '';
            assert.ok(existsSync(scriptPath), `${label} ${usage.source}: installed script exists: ${command}`);
            seenScripts.add(scriptPath.split('/').pop()!);
            const supplied = command;
            const decision = decide(supplied);
            expectAllowed(decision, `${label} ${usage.source}: ${supplied}\n${decision.reason ?? ''}`);
          }
        }
        for (const script of pack.expectedScripts) {
          assert.ok(seenScripts.has(script), `${pack.name}: missing parsed usage for tools/${script}`);
        }
      }

      // Regenerate ALLOWED.md via installed hooks/guard-gen.mjs (ops) or verify pre-installed ALLOWED.md follows the single-quote rule.
      const jevDir = fileURLToPath(new URL('../../packs/workflow/knowledge-contribution/tools/jev/', import.meta.url));
      const jevSkill = join(home, 'skills', 'jev');
      mkdirSync(join(jevSkill, 'lib'), { recursive: true });
      for (const rel of ['SKILL.md', 'hooks.json', 'jev.ts', 'jev.cli.json', 'lib/api.ts', 'lib/validate.ts', 'lib/placement.ts']) {
        const src = join(jevDir, rel);
        if (existsSync(src)) writeFileSync(join(jevSkill, rel), readFileSync(src));
      }
      const genScript = written.files.find((f) => f.endsWith('-gen.mjs'))!;
      const regen = spawnSync(process.execPath, [join(home, genScript)], { cwd: written.workdir, encoding: 'utf8', timeout: 5000 });
      assert.equal(regen.status, 0, `${label} gen: ${regen.stderr}`);
      const allowedMd = readFileSync(join(home, 'hooks', 'ALLOWED.md'), 'utf8');
      assert.doesNotMatch(allowedMd, /node "/, `${label} ALLOWED.md must not teach double-quoted commands`);
      assert.match(allowedMd, /英文单引号/, `${label} ALLOWED.md must document the single-quote rule`);
      assert.ok(allowedMd.includes('case-compile/tools/task-brief.ts'), `${label} ALLOWED.md includes task-brief.ts`);
      assert.ok(!allowedMd.includes('authoring-brief.ts') && !allowedMd.includes('rework-inputs.ts') && !allowedMd.includes('workspace-path.ts'), `${label} ALLOWED.md excludes non-CLI helper modules`);
      assert.ok(allowedMd.includes('jev/jev.ts submit'), `${label} ALLOWED.md includes jev subcommands`);

      const jevCmd = (body: string) => `node ${jevSkill.includes(' ') ? `'${jevSkill}/jev.ts'` : `${jevSkill}/jev.ts`} ${body}`;
      expectAllowed(decide(jevCmd(`ask --hub ${hubUrl} --model synthetic-jev --input ask.json --out jev-results <<'EOF'\n%JEV_API_KEY%\n%HUB_TOKEN%\nEOF`)), `${label} jev ask`);
      expectAllowed(decide(jevCmd(`calibrate --hub ${hubUrl} --model synthetic-jev --root r0 --under /cmd --limit 50 --dry-run --out jev-results <<'EOF'\n%JEV_API_KEY%\n%HUB_TOKEN%\nEOF`)), `${label} jev calibrate --dry-run`);
      expectAllowed(decide(jevCmd(`place --hub ${hubUrl} --model synthetic-jev --root r0 --under /cmd --from sub --limit 10 --out jev-results <<'EOF'\n%JEV_API_KEY%\n%HUB_TOKEN%\nEOF`)), `${label} jev place --from`);
      expectAllowed(decide(jevCmd(`lock --hub ${hubUrl} --product prod --build '2026.1' --out jev-results <<'EOF'\n%HUB_TOKEN%\nEOF`)), `${label} jev lock 1-line`);
      expectAllowed(decide(jevCmd(`submit --hub ${hubUrl} --proposals jev-results/proposals.json --product prod --build '2026.1' --skip 'i1=合成原因 one' --skip 'i2=合成原因 two' --out jev-results <<'EOF'\n%HUB_TOKEN%\nEOF`)), `${label} jev submit --skip`);
      const askSend = decide(jevCmd(`ask --hub ${hubUrl} --model synthetic-jev --input ask.json --send case --send src --out jev-results <<'EOF'\n%JEV_API_KEY%\n%HUB_TOKEN%\nEOF`));
      assert.equal(askSend.decision, 'ask', `${label} jev ask --send delegates to jev/hooks.json`);

      const ccSkill = join(home, 'skills', 'case-compile');
      const quotedFetch = ccSkill.includes(' ') ? `'${ccSkill}/tools/fetch-run.ts'` : `${ccSkill}/tools/fetch-run.ts`;
      const quotedTaskBrief = ccSkill.includes(' ') ? `'${ccSkill}/tools/task-brief.ts'` : `${ccSkill}/tools/task-brief.ts`;
      // Relative script path + here-string refused.
      assert.equal(decide(`node tools/fetch-run.ts --hub ${hubUrl} --run run_01aaaaaaaaaaaaaaaaaaaaaaaa --out case-compile-run <<< '%HUB_TOKEN%'`).decision, 'deny');
      assert.equal(decide(`node ${quotedFetch} --hub ${hubUrl} --run run_01aaaaaaaaaaaaaaaaaaaaaaaa --out case-compile-run <<< '%HUB_TOKEN%'`).decision, 'deny');
      // Unquoted non-ASCII role argument refused on both skills and ops.
      assert.equal(decide(`node ${quotedTaskBrief} --role 脚本编写 --case case-01 --brief briefs/0.md --out plans/0.json --task-file tasks/0.md`).decision, 'deny');
      // Internal helper module under tools/ cannot be executed directly.
      assert.equal(decide(`node ${ccSkill.includes(' ') ? `'${ccSkill}/tools/authoring-brief.ts'` : `${ccSkill}/tools/authoring-brief.ts`}`).decision, 'deny');

      // Four-consumer consistency: every CLI .cli.json in case-compile & recompose agrees with ALLOWED.md table rows.
      const allowedRows = new Map<string, string>();
      for (const row of allowedMd.split('\n')) {
        const m = /^\| ([^|]+?) \| (.+) \|$/.exec(row);
        if (m) allowedRows.set(m[1], m[2]);
      }
      for (const pack of packs) {
        const skillDir = join(home, 'skills', pack.name);
        const manifest = JSON.parse(readFileSync(join(pack.dir, 'pack.json'), 'utf8')) as { files: Array<{ path: string }> };
        for (const { path: rel } of manifest.files) {
          if (!rel.startsWith('tools/') || !rel.endsWith('.cli.json')) continue;
          const decl = JSON.parse(readFileSync(join(skillDir, rel), 'utf8')) as {
            stdin: string[];
            subcommands?: Record<string, string[]>;
          };
          const toolName = rel.replace(/\.cli\.json$/, '.ts');
          const toolId = `${pack.name}/${toolName}`;
          const subEntries = decl.subcommands && !Array.isArray(decl.subcommands) ? Object.entries(decl.subcommands) : [];
          const targets = subEntries.length > 0
            ? subEntries.map(([sub, stdin]) => ({ rowId: `${toolId} ${sub}`, stdin }))
            : [{ rowId: toolId, stdin: decl.stdin }];
          for (const target of targets) {
            const cell = allowedRows.get(target.rowId);
            assert.ok(cell, `${label}: ALLOWED.md missing table row for ${target.rowId}`);
            if (target.stdin.length > 0) {
              assert.ok(cell.includes("<<'EOF'"), `${label}: ${target.rowId} ALLOWED.md missing <<'EOF'`);
              for (const ph of target.stdin) assert.ok(cell.includes(ph), `${label}: ${target.rowId} ALLOWED.md missing ${ph}`);
            } else {
              assert.ok(!cell.includes("<<'EOF'"), `${label}: ${target.rowId} ALLOWED.md should not include <<'EOF'`);
            }
          }
        }
      }
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--plumb-key-stdin reads only the first line into 0600 secrets.json and omits both key and exact length from receipts', () => {
  assert.equal(firstLineOf('first-only\r\nignored-second\n'), 'first-only');
  assert.equal(firstLineOf('\nsecond'), '');
  assert.equal(firstLineOf(''), '');

  const dir = scratch();
  try {
    const envFile = join(dir, 'synthetic.env');
    writeFileSync(envFile, ENV);
    const home = join(dir, 'ops-home');
    const argv = ['--plumb-key-stdin', '--env-file', envFile, '--home', home, '--provider', 'qwen', '--profile', 'ops'];
    assert.equal(parseArgs(argv).plumbKeyStdin, true);
    assert.equal(parseArgs(['--env-file', envFile, '--home', home, '--provider', 'qwen']).plumbKeyStdin, undefined);

    const fakeKey = 'synthetic-plumb-key-stdin-val';
    const lines: string[] = [];
    const code = main(argv, { HUB_REAL_TOKEN: 'synthetic-token' }, (line) => lines.push(line), () => `${fakeKey}\nignored-line\n`);
    assert.equal(code, 0, lines.join('\n'));
    const shown = lines.join('\n');
    assert.match(shown, new RegExp(`${PLUMB_KEY_SECRET}.*已写入.*长度为 0：否`));
    assert.ok(!shown.includes('/secrets PLUMB_API_KEY'));
    assert.ok(!shown.includes(fakeKey), 'receipt must not print the Plumb key');
    assert.ok(!shown.includes('ignored-line'), 'receipt must not print subsequent stdin lines');
    assert.ok(!shown.includes(String(fakeKey.length)), 'receipt must not expose numeric length of the Plumb key');

    const secretsPath = join(home, 'secrets.json');
    assert.equal(statSync(secretsPath).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(secretsPath, 'utf8')), {
      secrets: { HUB_TOKEN: 'synthetic-token', [PLUMB_KEY_SECRET]: fakeKey },
    });
    assert.ok(!readFileSync(join(home, 'settings.json'), 'utf8').includes(fakeKey));
    assert.ok(!readFileSync(join(home, 'credentials.json'), 'utf8').includes(fakeKey));

    // Empty stdin records PLUMB_API_KEY as empty and reports zero length status cleanly.
    const emptyHome = join(dir, 'empty-home');
    lines.length = 0;
    const emptyCode = main(['--env-file', envFile, '--home', emptyHome, '--provider', 'qwen', '--plumb-key-stdin'], { HUB_REAL_TOKEN: 'synthetic-token' }, (line) => lines.push(line), () => '\n');
    assert.equal(emptyCode, 0, lines.join('\n'));
    const emptyShown = lines.join('\n');
    assert.match(emptyShown, new RegExp(`${PLUMB_KEY_SECRET}.*已写入.*长度为 0：是`));
    assert.equal(statSync(join(emptyHome, 'secrets.json')).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(emptyHome, 'secrets.json'), 'utf8')), {
      secrets: { HUB_TOKEN: 'synthetic-token', [PLUMB_KEY_SECRET]: '' },
    });

    // End-to-end CLI stdin pipe via node process execution.
    const cliHome = join(dir, 'cli-home');
    const cliKey = 'synthetic-plumb-cli-piped-key';
    const cli = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('./circle-home.ts', import.meta.url)), '--env-file', envFile, '--home', cliHome, '--provider', 'qwen', '--profile', 'skills', '--plumb-key-stdin'],
      { input: `${cliKey}\r\nsecond-line\n`, env: { ...process.env, HUB_REAL_TOKEN: 'synthetic-token' }, encoding: 'utf8', timeout: 10000 },
    );
    assert.equal(cli.status, 0, cli.stderr);
    const cliOut = `${cli.stdout}\n${cli.stderr}`;
    assert.match(cli.stdout, new RegExp(`${PLUMB_KEY_SECRET}.*已写入.*长度为 0：否`));
    assert.ok(!cliOut.includes('/secrets PLUMB_API_KEY'));
    assert.ok(!cliOut.includes(cliKey));
    assert.ok(!cliOut.includes('second-line'));
    assert.ok(!cliOut.includes(String(cliKey.length)));
    assert.equal(statSync(join(cliHome, 'secrets.json')).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(readFileSync(join(cliHome, 'secrets.json'), 'utf8')), {
      secrets: { HUB_TOKEN: 'synthetic-token', [PLUMB_KEY_SECRET]: cliKey },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the ops guard starts a workflow only from a script an installed skill ships, and its refusal names the script that may run', () => {
  const dir = scratch(), home = join(dir, 'home');
  try {
    const written = writeHome({ home, profile: 'ops', hubUrl: 'https://hub.example.invalid/mcp' }, endpointFrom(entries, 'qwen'), 'synthetic-token');
    const root = join(home, 'skills', 'x'); mkdirSync(join(root, 'workflows'), { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), '# Synthetic skill\n');
    const script = join(root, 'workflows', 'loop.js'); writeFileSync(script, "export const meta = { name: 'loop', description: 'synthetic', phases: [] }\n");
    writeFileSync(join(root, 'workflows', 'notes.txt'), 'not a script\n');
    writeFileSync(join(written.workdir, 'loop.js'), "export const meta = { name: 'own', description: 'synthetic', phases: [] }\n");
    const hook = join(home, written.files.find(f => f.startsWith('hooks/'))!);
    const decide = (tool_input: Record<string, unknown>) => { const child = spawnSync(process.execPath, [hook], { input: JSON.stringify({ event: 'before_tool', cwd: written.workdir, tool_name: 'workflow', tool_input, paths: [] }), encoding: 'utf8', timeout: 5000 }); assert.equal(child.status, 0, child.stderr); return JSON.parse(child.stdout) as { decision: string; reason: string }; };
    const first = decide({ script_path: script, args: { pipeline: 'whatever the script is given', state: 'pipeline.json' } });
    // The ops guard does not object (it answers nothing, and the client's own approval mode decides); it never says deny.
    assert.notEqual(first.decision, 'deny', JSON.stringify(first));
    // By the name a client lists the shipped script under, and nothing else beside it.
    assert.notEqual(decide({ name: 'x:loop', args: {} }).decision, 'deny');
    // A script written in the call, another name, a name beside a path, a relaunch, a file of the work folder, a file that is no script, a relative path.
    for (const refused of [{ script: "export const meta = { name: 'own', description: 'synthetic', phases: [] }" }, { name: 'own' }, { name: 'x:other' }, { name: 'x:loop', script_path: script }, { name: 'x:loop', resume_from_run_id: 'w00000000' }, { script_path: script, resume_from_run_id: 'w00000000' }, { script_path: join(written.workdir, 'loop.js') }, { script_path: join(root, 'workflows', 'notes.txt') }, { script_path: 'skills/x/workflows/loop.js' }, {}]) {
      const got = decide(refused);
      assert.equal(got.decision, 'deny', JSON.stringify(refused));
      assert.match(got.reason, /workflow 只运行已装技能自带的工作流脚本/);
      assert.ok(got.reason.includes(script), got.reason);
    }
    assert.match(readFileSync(join(home, 'hooks', 'ALLOWED.md'), 'utf8'), /- workflow：只运行已装技能自带的工作流脚本，script_path 写技能目录下 workflows\/ 里的文件[^\n]*或者 name 写客户端列出的名字/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
  // The skills profile has no workflow tool.
  const f = skillsFixture();
  try { assert.equal(f.decide(f.input('workflow', { script_path: join(f.root, 'workflows', 'loop.js') })).decision, 'deny'); } finally { f.close(); }
});
