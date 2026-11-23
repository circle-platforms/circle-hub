import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const MODULE_DIR = fileURLToPath(new URL('./', import.meta.url));
const PACK_DIR = fileURLToPath(new URL('../../../', import.meta.url));

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort()
    .map((name) => join(dir, name));

const MODULE_FILES = sourceFiles(MODULE_DIR);
const TOOL_FILES = sourceFiles(join(PACK_DIR, 'tools'));
const ALL_FILES = [...MODULE_FILES, ...TOOL_FILES, join(PACK_DIR, 'api.ts')];

const read = (path: string): string => readFileSync(path, 'utf8');
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
const specifiers = (source: string): string[] => [...stripComments(source).matchAll(/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)'([^']+)'/gu)].map((match) => match[1]!);

describe('the module can be carried into a workflow pack as it is', () => {
  it('has the files the pack lists and no others', () => {
    assert.deepEqual(MODULE_FILES.map((path) => path.slice(MODULE_DIR.length)), ['client.ts', 'files.ts', 'index.ts', 'redact.ts', 'transport.ts', 'types.ts', 'validate.ts']);
  });

  it('imports only node:* and files of its own directory', () => {
    const found = new Set<string>();
    for (const path of MODULE_FILES) {
      for (const specifier of specifiers(read(path))) {
        found.add(specifier);
        if (specifier.startsWith('node:')) continue;
        assert.match(specifier, /^\.\/[a-z-]+\.ts$/u, `${path}: ${specifier}`);
        assert.ok(existsSync(join(MODULE_DIR, specifier)), `${path}: ${specifier} does not exist`);
      }
    }
    assert.deepEqual([...found].filter((specifier) => specifier.startsWith('node:')).sort(), ['node:crypto', 'node:fs', 'node:fs/promises', 'node:http', 'node:https', 'node:path']);
  });

  it('uses erasable TypeScript only', () => {
    for (const path of ALL_FILES) {
      const source = stripComments(read(path));
      assert.doesNotMatch(source, /^\s*(?:export\s+)?(?:const\s+)?enum\s/mu, path);
      assert.doesNotMatch(source, /^\s*(?:export\s+)?namespace\s/mu, path);
      assert.doesNotMatch(source, /constructor\s*\(\s*(?:private|public|protected|readonly)\s/u, path);
    }
  });
});

describe('nothing reaches the environment, a command, the code of others or another address', () => {
  it('reads no environment variable and starts no process', () => {
    for (const path of ALL_FILES) {
      const source = stripComments(read(path));
      assert.doesNotMatch(source, /process\.env|process\.getBuiltinModule|import\.meta\.env|Deno\.env|\bBun\.env/u, path);
      assert.doesNotMatch(source, /child_process|node:vm|node:worker_threads|node:cluster|\beval\s*\(|new\s+Function\b|\brequire\s*\(|\.constructor\b/u, path);
    }
  });

  it('keeps the module free of the process object, argv and stdin', () => {
    for (const path of MODULE_FILES) assert.doesNotMatch(stripComments(read(path)), /\bprocess\b/u, path);
  });

  it('holds the address of the service once, in one constant', () => {
    const addresses = ALL_FILES.flatMap((path) => [...stripComments(read(path)).matchAll(/https?:\/\/[^\s'"`)]+/gu)].map((match) => `${path.slice(PACK_DIR.length)} ${match[0]}`));
    assert.deepEqual(addresses, ['functions/modules/jev-client/types.ts https://api.typesafe.ai/v1/systemone']);
  });

  it('uses no other way to the network than the one transport', () => {
    for (const path of ALL_FILES) {
      const source = stripComments(read(path));
      assert.doesNotMatch(source, /\bfetch\s*\(|XMLHttpRequest|WebSocket|node:net|node:dns|node:tls|node:dgram|node:http2/u, path);
      const usesHttps = /from\s+'node:https'/u.test(source);
      assert.equal(usesHttps, path.endsWith('/transport.ts'), `${path}: node:https is the transport's alone`);
    }
  });

  it('sets exactly one certificate option, rejectUnauthorized: true, and nothing else that changes the trust or the proxy', () => {
    const transport = stripComments(read(join(MODULE_DIR, 'transport.ts')));
    assert.equal([...transport.matchAll(/\brejectUnauthorized\b/gu)].length, 1, 'the option is named once');
    assert.match(transport, /^\s*rejectUnauthorized:\s*true,?\s*$/mu);
    assert.doesNotMatch(
      transport,
      /\bca\s*:|\bcert\s*:|\bkey\s*:|\bpfx\s*:|\bpassphrase\b|\bcrl\s*:|\bciphers\b|\bservername\b|checkServerIdentity|\bsecureContext\b|\bsecureProtocol\b|\bminVersion\b|\bmaxVersion\b|NODE_TLS|NODE_EXTRA_CA_CERTS|proxy/iu,
    );
    for (const path of ALL_FILES.filter((candidate) => !candidate.endsWith('/transport.ts'))) {
      assert.doesNotMatch(stripComments(read(path)), /rejectUnauthorized|NODE_TLS|checkServerIdentity/u, path);
    }
  });

  it('writes files only through the private-file helpers', () => {
    for (const path of ALL_FILES) {
      const source = stripComments(read(path));
      const file = path.slice(PACK_DIR.length);
      if (file === 'functions/modules/jev-client/files.ts') continue;
      assert.doesNotMatch(source, /\b(?:writeFile|appendFile|createWriteStream|rename|symlink|link|copyFile|cp|rm|unlink)\s*\(/u, file);
    }
  });
});
