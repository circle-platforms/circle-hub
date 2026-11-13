import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, chmod, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { exportProtectedConfiguration, applyProtectedConfiguration, createResetConfigurationPorts, type ProtectedConfigurationDomain, applyCommand, applyDeployment, deploymentOrder, differentFields, exactMatch, exportCommand, exportDeployment, parseDeployment } from './cli-apply.ts';
import { terminalSafe } from './assemble/terminal.ts';
import { ExecutorRegistry } from '../dispatch/api.ts';
import { canonicalBytes, sha256Hex, type Principal } from '../records/api.ts';
import type { Session } from './cli-session.ts';
import type { DeploymentDefinition } from '../../contracts/src/deployment.ts';

const uid = 'usr_00000000000000000000000001', tid = 'tm_00000000000000000000000001', rid = 'res_00000000000000000000000001';
const admin = { id: uid, name: '合成管理员', role: 'admin' as const, disabled: false, deleted_at: null };
function fake(t: TestContext) {
  const calls: string[] = [], output: string[] = [];
  const accounts = [admin], teams: Array<{ id: string; name: string }> = [], memberships = new Map<string, string[]>();
  const assignments = new Set<string>(), objects = new Map<string, Uint8Array>();
  const resources: Array<{ id: string; name: string; enabled: boolean }> = [];
  const configs = new Map<string, { body: { bound: string } }>();
  const publications = new Map<string, { id: string; latest: string; kind: string; active: boolean; digest?: string }>();
  const installed = new Set<string>();
  let publishRight = false;
  const records = {
    principals: {
      list: async () => accounts,
      createUser: async (_by: unknown, name: string, role: typeof admin.role) => { calls.push('account'); const user = { ...admin, id: 'usr_00000000000000000000000002', name, role }; accounts.push(user); return user; },
      setDisabled: async (_by: unknown, id: string, disabled: boolean) => { calls.push('disable'); accounts.find(row => row.id === id)!.disabled = disabled; },
    },
    teams: {
      list: async () => teams,
      members: async (_by: unknown, id: string) => (memberships.get(id) ?? []).map(member => ({ user: accounts.find(user => user.id === member)! })),
      create: async (_by: unknown, name: string) => { calls.push('team'); const team = { id: tid, name }; teams.push(team); memberships.set(tid, []); return team; },
      add: async (_by: unknown, id: string, user: string) => { calls.push('member'); memberships.get(id)!.push(user); },
    },
    authorizations: {
      resourceConfig: async (id: string) => configs.get(id) ?? null,
      history: async () => ({ items: [], next: null }),
      teamsOf: async () => ({ teams: [], all: false }),
      isActive: async (permission: string, subject: string, object: string) => assignments.has(`${permission}:${subject}:${object}`),
      assignResource: async (_by: unknown, resource: string, subject: string) => { calls.push('resource-assign'); assignments.add(`resource_assign:${subject}:${resource}`); },
      canPublish: async () => publishRight,
      grantPublishRight: async (_by: unknown, user: string) => { assert.equal(user, uid); calls.push('publish-right'); publishRight = true; },
    },
    objects: { get: async (digest: string) => objects.get(digest) ?? null },
    get vault(): never { throw new Error('must not read vault'); },
    variables: { list: async () => [] },
  };
  const hub = {
    records,
    resources: { list: async () => resources },
    docs: { list: async () => [] },
    registry: {
      listPacks: async () => [...publications.values()],
      installedSkills: async () => [...installed].map(ref => ({ info: { id: ref.split('@')[0], version: ref.split('@')[1] } })),
      install: async (_by: unknown, ref: string) => { calls.push('install:' + ref); installed.add(ref); },
      publish: async (_by: unknown, directory: string) => {
        const manifest = JSON.parse(await (await import('node:fs/promises')).readFile(join(directory, 'pack.json'), 'utf8'));
        calls.push('publish:' + manifest.id);
        const digest = sha256Hex(canonicalBytes(manifest));
        publications.set(manifest.id, { id: manifest.id, latest: manifest.version, kind: manifest.kind, active: false, digest });
        return { ok: true, created: true, version: { ...manifest, digest }, report: { samples: { passed: 1, total: 1 }, warnings: [] } };
      },
      resolve: async (ref: string) => {
        const [id, version] = ref.split('@'), pack = publications.get(id);
        return pack && (pack.latest === version || installed.has(ref)) ? { ...pack, version } : null;
      },
      assign: async (_by: unknown, subject: string, object: string) => { calls.push('workflow-assign'); assignments.add(`assign:${subject}:${object}`); },
      assignTeam: async (_by: unknown, subject: string, object: string) => { calls.push('workflow-team'); assignments.add(`assign:${subject}:${object}`); },
      isActive: async (id: string) => publications.get(id)?.active ?? false,
      activate: async (_by: unknown, id: string) => { calls.push('activate'); publications.get(id)!.active = true; },
    },
    connectors: { admin: {
      addResource: async (_by: unknown, input: DeploymentDefinition['resources'][number]['definition']) => {
        calls.push('resource');
        const source = { ...input, schema: 'resource@1', id: rid, system_pack_digest: 'a'.repeat(64),
          credentials: Object.fromEntries(Object.entries(input.credentials).map(([key, name]) => [key, '${secret:' + name + '}'])),
          credential_digests: Object.fromEntries(Object.keys(input.credentials).map(key => [key, 'plain'])), created_by: uid, created_at: '2026-01-01T00:00:00.000Z' };
        const bytes = canonicalBytes(source), digest = sha256Hex(bytes); objects.set(digest, bytes); configs.set(rid, { body: { bound: digest } });
        resources.push({ id: rid, name: input.name, enabled: true }); return source;
      },
      disable: async (_by: unknown, id: string) => { calls.push('resource-disable'); resources.find(row => row.id === id)!.enabled = false; },
    } },
  };
  t.mock.method(ExecutorRegistry.prototype, 'sources', async () => []);
  const session = { ctx: { io: { cwd: tmpdir(), stdout: (line: string) => output.push(line) } }, admin: async () => admin, leases: async () => ({ registrations: async () => [] }), records: async () => records, hub: async () => hub,
    out: (line: string) => output.push(terminalSafe(line)), err: (line: string) => output.push(line) } as unknown as Session;
  return { session, calls, output, accounts, teams, publications, resources, objects, configs, installed };
}

test('strict deployment rejects secret material and misspelled fields without echoing values', () => {
  for (const input of [ { schema: 'deployment@1', password: 'never-echo' }, { schema: 'deployment@1', accounts: [{ name: '合成账户', role: 'user', token: 'never-echo' }] },
    { schema: 'deployment@1', resources: [{ definition: { credentials: { auth: 'raw secret value' } } }] } ]) {
    assert.throws(() => parseDeployment(input), error => error instanceof Error && !error.message.includes('never-echo') && !error.message.includes('raw secret value'));
  }
});

test('exact lookup rejects ambiguity and never uses prefixes or synonyms', () => {
  const rows = [{ id: 'one', name: '合成账户' }, { id: 'two', name: 'one' }];
  assert.throws(() => exactMatch(rows, 'one', row => row.name));
  assert.equal(exactMatch(rows, '合成', row => row.name), undefined);
});

test('topological publication rejects cycles and duplicates and preserves exact versions', () => {
  const entry = (ref: string, dependsOn: string[] = []) => ({ ref, dependsOn, manifest: null, install: false });
  assert.deepEqual(deploymentOrder([entry('workflow@1.0.0', ['skill@1.0.0']), entry('skill@1.0.0')]).map(row => row.ref), ['skill@1.0.0', 'workflow@1.0.0']);
  assert.throws(() => deploymentOrder([entry('aa@1.0.0', ['bb@1.0.0']), entry('bb@1.0.0', ['aa@1.0.0'])]));
  assert.throws(() => deploymentOrder([entry('aa@1.0.0'), entry('aa@1.0.0')]));
  assert.equal(deploymentOrder([entry('aa@1.0.0'), entry('aa@2.0.0')]).length, 2);
});

test('apply calls account/team/resource/assignment/source APIs once and then skips', async t => {
  const f = fake(t);
  f.publications.set('product-demo', { id: 'product-demo', latest: '1.0.0', kind: 'product', active: false });
  const input = { schema: 'deployment@1', accounts: [{ name: '合成成员', role: 'user' }], teams: [{ name: '合成团队', members: ['合成成员'] }],
    resources: [{ definition: { name: '合成资源', system_pack: 'system-demo@1.0.0', environment: 'test', origins: { main: 'https://192.0.2.1' }, credentials: { auth: 'DEMO_SECRET' } } }],
    workflowAssignments: [{ pack: 'workflow-demo', team: '合成团队' }, { pack: 'workflow-demo', user: '合成成员' }], resourceAssignments: [{ resource: '合成资源', team: '合成团队' }], knowledgeSources: ['product-demo'] };
  const first = await applyDeployment(f.session, input);
  assert.equal(first.differences.length, 0);
  assert.deepEqual(f.calls, ['account', 'team', 'member', 'resource', 'workflow-team', 'workflow-assign', 'resource-assign', 'activate']);
  const count = f.calls.length;
  const second = await applyDeployment(f.session, input);
  assert.equal(second.created, 0); assert.deepEqual(second.differences, []); assert.equal(f.calls.length, count);
  assert.ok(!f.calls.includes('publish-right'));
  const exported = await exportDeployment(f.session);
  assert.equal(exported.resources[0].definition.credentials.auth, 'DEMO_SECRET');
  assert.equal(JSON.stringify(exported).includes('password'), false);
});

test('existing differences report exact field paths without modifying or echoing values', async t => {
  const f = fake(t);
  const report = await applyDeployment(f.session, { schema: 'deployment@1', accounts: [{ name: admin.name, role: 'user' }] });
  assert.deepEqual(report.differences, [{ section: 'accounts', index: 0, fields: ['/role'] }]);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(differentFields({ nested: { secret: 'old' } }, { nested: { secret: 'new' } }), ['/nested/secret']);
});

test('missing exact pack dependency fails before creating accounts', async t => {
  const f = fake(t);
  await assert.rejects(applyDeployment(f.session, { schema: 'deployment@1', accounts: [{ name: '合成成员', role: 'user' }], packs: [{ ref: 'aa@1.0.0' }] }));
  assert.deepEqual(f.calls, []);
});

test('CLI reads scratch JSON and returns nonzero on difference; export excludes credential APIs', async t => {
  const f = fake(t), root = await mkdtemp(join(tmpdir(), 'circle-hub-apply-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'deployment.json');
  await writeFile(file, JSON.stringify({ schema: 'deployment@1', accounts: [{ name: admin.name, role: 'user' }] }));
  assert.equal(await applyCommand(f.session, [file]), 1);
  assert.match(f.output.join('\n'), /\/role/);
  f.output.length = 0;
  assert.equal(await exportCommand(f.session, []), 0);
  assert.deepEqual(JSON.parse(f.output[0]).accounts[0], { id: uid, name: admin.name, role: 'admin', disabled: false });
  await assert.rejects(applyCommand(f.session, []));
  await assert.rejects(exportCommand(f.session, ['unexpected']));
});

test('scratch pack directories publish dependencies first, install skills and grant only the publisher', async t => {
  const f = fake(t), root = await mkdtemp(join(tmpdir(), 'circle-hub-deployment-packs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const make = async (id: string, kind: string, files: string[], dependencies?: unknown[]) => {
    const directory = join(root, id); await mkdir(directory);
    for (const path of files) await writeFile(join(directory, path), '{}');
    const manifest = { schema: 'pack@1', id, version: '1.0.0', kind, title: '合成包', description: '合成样例',
      ...(dependencies ? { dependencies } : {}), files: files.sort().map(path => ({ path, sha256: sha256Hex(Buffer.from('{}')), size: 2 })) };
    await writeFile(join(directory, 'pack.json'), JSON.stringify(manifest));
  };
  await make('skill-demo', 'skill', ['skill.json', 'SKILL.md']);
  await make('workflow-demo', 'workflow', ['workflow.json', 'requirements.json', 'checks.json', 'slots.schema.json', 'SKILL.md'], [{ pack: 'skill-demo', version: '1.0.0' }]);
  const input = { schema: 'deployment@1', packs: [{ ref: 'workflow-demo@1.0.0', directory: 'workflow-demo' }, { ref: 'skill-demo@1.0.0', directory: 'skill-demo' }] };
  await applyDeployment(f.session, input, root);
  assert.deepEqual(f.calls, ['publish-right', 'publish:skill-demo', 'install:skill-demo@1.0.0', 'publish:workflow-demo']);
  const count = f.calls.length;
  await applyDeployment(f.session, input, root);
  assert.equal(f.calls.length, count);
  await writeFile(join(root, 'workflow-demo', 'SKILL.md'), 'changed');
  await assert.rejects(applyDeployment(f.session, input, root), /文件与清单不同/);
  assert.equal(f.calls.length, count);
});

test('resource integrity failure refuses export instead of emitting a partial document', async t => {
  const f = fake(t);
  f.resources.push({ id: rid, name: '合成损坏资源', enabled: true });
  f.configs.set(rid, { body: { bound: 'a'.repeat(64) } });
  await assert.rejects(exportCommand(f.session, []), /原件缺失/);
  assert.deepEqual(f.output, []);
});

function syntheticExecutor() {
  const call = (tool: string) => ({ tool, arguments: {} });
  return {
    schema: 'executor@1', target: 'synthetic-bed', endpoint: 'http://127.0.0.1:1/mcp', ca: '', credential: '${secret:DEMO_SECRET}',
    resources: ['synthetic/device/a'], max_run_ms: 9000, max_bytes: 1048576, poll_ms: 20, payload_argument: '/blob',
    allowed_tools: ['acquire', 'heartbeat', 'release', 'precheck', 'submit', 'status', 'result'],
    calls: { acquire: call('acquire'), heartbeat: call('heartbeat'), release: call('release'), precheck: call('precheck'),
      submit: { tool: 'submit', arguments: { request: { $value: 'request_id' }, dispatch_sequence: { $value: 'dispatch_sequence' }, sequence_scope: { $value: 'sequence_scope' }, blob: { $value: 'payload_base64' }, digest: { $value: 'sha256' }, ids: { $value: 'items' } } }, status: call('status'), result: call('result') },
    lease: { id: '/ticket', token: '/token', ttl_ms: '/ttl', acceptance: '/ok', map: { true: 'accepted', false: 'not_accepted' } },
    receipt: { request_id: '/request', acceptance: '/ok', map: { true: 'accepted', false: 'not_accepted' }, id: '/key', sha256: '/digest', items: '/ids' },
    status: { pointer: '/state', exit_code: '/exit', map: { ended: { action_result: 'completed', effect_outcome: 'effective' } } },
    result: { id: '/key', sha256: '/digest', submitted_at: '/submitted', items: '/rows', item_id: '/id', item_outcome: '/outcome', map: { good: 'pass', bad: 'fail' }, complete: '/complete' },
    proof: { package: 'synthetic-workflow', manifest_sha256: '/manifest', requirement: 'synthetic_verified', warrant_id: 'synthetic.verify@1', slot: 'synthetic-artifact', plan_run: '/plan_run', sha256: '/sha256', items: '/items', target: '/target', build: '/build', generator: '/generator' },
  };
}

test('executor source API receives only named references and repeated apply does not add or resolve values', async t => {
  const f = fake(t), sources: Array<{ id: string; digest: string; source: DeploymentDefinition['executors'][number] }> = [];
  t.mock.method(ExecutorRegistry.prototype, 'sources', async () => sources);
  t.mock.method(ExecutorRegistry.prototype, 'add', async (_by: Principal, input: unknown) => {
    f.calls.push('executor');
    const source = { ...parseDeployment({ schema: 'deployment@1', executors: [input] }).executors[0], id: 'exe_00000000000000000000000001' };
    const entry = { id: source.id, digest: sha256Hex(canonicalBytes(source)), source };
    sources.push(entry);
    return { ...entry, definition: source, variables: [], resolved_digest: entry.digest } as Awaited<ReturnType<ExecutorRegistry['add']>>;
  });
  const input = { schema: 'deployment@1', executors: [syntheticExecutor()] };
  await applyDeployment(f.session, input);
  await applyDeployment(f.session, input);
  assert.deepEqual(f.calls, ['executor']);
  const exported = await exportDeployment(f.session);
  assert.equal(exported.executors[0].credential, '${secret:DEMO_SECRET}');
  const changed = await applyDeployment(f.session, { ...input, executors: [{ ...syntheticExecutor(), endpoint: 'http://127.0.0.1:2/mcp' }] });
  assert.deepEqual(changed.differences, [{ section: 'executors', index: 0, fields: ['/endpoint'] }]);
  assert.deepEqual(f.calls, ['executor']);
});

test('a refused publication stops its dependents and does not report success', async t => {
  const f = fake(t), root = await mkdtemp(join(tmpdir(), 'circle-hub-refused-deployment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'skill'); await mkdir(directory);
  const files = ['SKILL.md', 'skill.json'].map(path => ({ path, size: 2, sha256: sha256Hex(Buffer.from('{}')) }));
  for (const file of files) await writeFile(join(directory, file.path), '{}');
  await writeFile(join(directory, 'pack.json'), JSON.stringify({ schema: 'pack@1', id: 'skill-demo', version: '1.0.0', kind: 'skill', title: '合成包', description: '合成包', files }));
  const hub = await f.session.hub();
  t.mock.method(hub.registry, 'publish', async () => ({ ok: false as const, problems: [], report: null }));
  await assert.rejects(applyDeployment(f.session, { schema: 'deployment@1', packs: [{ ref: 'skill-demo@1.0.0', directory }], teams: [{ name: '合成团队' }] }));
  assert.deepEqual(f.calls, ['team', 'publish-right']);
  assert.equal(f.output.some(line => line.includes('已发布')), false);
});

test('export preserves an older installed skill and reapply does not install an unrelated publication', async t => {
  const f = fake(t);
  f.publications.set('skill-demo', { id: 'skill-demo', latest: '2.0.0', kind: 'skill', active: false });
  f.publications.set('skill-other', { id: 'skill-other', latest: '1.0.0', kind: 'skill', active: false });
  f.installed.add('skill-demo@1.0.0');
  const exported = await exportDeployment(f.session);
  assert.equal(exported.packs.find(pack => pack.ref === 'skill-demo@1.0.0')?.install, true);
  assert.equal(exported.packs.find(pack => pack.ref === 'skill-other@1.0.0')?.install, false);
  await applyDeployment(f.session, exported);
  assert.deepEqual(f.calls, []);
});

function protectedFixture() {
  const state = { schema: 'synthetic-current-config@1', schemaFingerprint: 'a'.repeat(64),
    users: [{ id: uid, password_hash: 'synthetic-scrypt-hash', disabled: true }],
    tokens: [{ id: 'tok_00000000000000000000000001', user_id: uid, sha256: 'b'.repeat(64), revoked_at: null }],
    oauth_clients: [{ id: 'cli_00000000000000000000000001', redirect_uris: ['http://127.0.0.1/callback'] }],
    ordinary: [{ name: 'DEMO_ROOT', value: 'synthetic-root' }],
  };
  const calls: string[] = [];
  let restored: typeof state | undefined;
  const domain: ProtectedConfigurationDomain<typeof state> = {
    capture: async () => { calls.push('capture'); return structuredClone(state); },
    validate: input => { calls.push('validate'); const value = input as typeof state; if (value.schema !== state.schema || value.schemaFingerprint !== state.schemaFingerprint) throw new Error('synthetic incompatible'); return value; },
    restore: async input => { calls.push('restore'); restored = structuredClone(input); },
  };
  return { state, calls, domain, restored: () => restored };
}

test('protected snapshot writes private files and restores original IDs and authentication hashes without public export', async t => {
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-private-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = protectedFixture(), config = { dataDir: root };
  const receipt = await exportProtectedConfiguration(config, f.domain);
  assert.equal((await stat(join(root, receipt.file))).mode & 0o777, 0o600);
  assert.equal((await stat(join(root, 'private-config-snapshots'))).mode & 0o777, 0o700);
  assert.deepEqual(Object.keys(receipt).sort(), ['bytes', 'file', 'sha256']);
  await applyProtectedConfiguration(config, receipt, f.domain);
  assert.deepEqual(f.restored(), f.state);
  assert.equal(f.restored()!.users[0].id, uid);
  assert.equal(f.restored()!.tokens[0].sha256, 'b'.repeat(64));
  const publicState = parseDeployment({ schema: 'deployment@1', accounts: [{ id: uid, name: '合成管理员', role: 'admin' }] });
  assert.equal(JSON.stringify(publicState).includes('password_hash'), false);
  assert.equal(JSON.stringify(publicState).includes('sha256'), false);
  assert.deepEqual((await readdir(join(root, 'private-config-snapshots'))), [receipt.file.split('/')[1]]);
});

test('protected export refuses incompatible current schema before making a snapshot and never exposes raw failures', async t => {
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-incompatible-config-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = protectedFixture();
  f.domain.capture = async () => { throw new Error('raw-password-or-token-must-not-appear'); };
  await assert.rejects(exportProtectedConfiguration({ dataDir: root }, f.domain), error => {
    assert.ok(error instanceof Error); assert.match(error.message, /不能导出/); assert.equal(error.message.includes('raw-password'), false); assert.equal('cause' in error, false); return true;
  });
  assert.deepEqual(await readdir(root), []);
  assert.equal(f.calls.includes('restore'), false);
});

test('protected restore rejects altered bytes, loose permissions, and symlinks before calling records', async t => {
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-config-integrity-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = protectedFixture(), config = { dataDir: root };
  const receipt = await exportProtectedConfiguration(config, f.domain), path = join(root, receipt.file);
  await chmod(path, 0o644);
  await assert.rejects(applyProtectedConfiguration(config, receipt, f.domain));
  await chmod(path, 0o600);
  const original = await readFile(path);
  await writeFile(path, Buffer.concat([original, Buffer.from(' ')]));
  await assert.rejects(applyProtectedConfiguration(config, receipt, f.domain));
  await rm(path); await symlink(join(root, 'absent.json'), path);
  await assert.rejects(applyProtectedConfiguration(config, receipt, f.domain));
  assert.equal(f.calls.includes('restore'), false);
});

test('reset bound callbacks persist and automatically restore a private snapshot and delegate the existing definition apply', async t => {
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-reset-ports-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = protectedFixture(), definitions: string[] = [];
  const options = { dataDir: root, domain: f.domain, applyDefinition: async (path: string) => { definitions.push(path); } };
  const ports = createResetConfigurationPorts(options), path = join(root, 'private-config-snapshots', `${randomUUID()}.json`);
  await ports.exportConfiguration(path);
  const reopened = createResetConfigurationPorts(options);
  await reopened.restoreConfiguration(path);
  assert.deepEqual(f.restored(), f.state);
  await reopened.applyDefinition('synthetic-definition.json');
  assert.deepEqual(definitions, ['synthetic-definition.json']);
  const before = await readFile(path);
  await assert.rejects(ports.exportConfiguration(path));
  assert.deepEqual(await readFile(path), before);
  await assert.rejects(ports.exportConfiguration(join(root, '..', `${randomUUID()}.json`)));
});

test('reset restore verifies persisted payload checksum even without an in-memory receipt', async t => {
  const root = await mkdtemp(join(tmpdir(), 'circle-hub-config-checksum-')); t.after(() => rm(root, { recursive: true, force: true }));
  const f = protectedFixture(), path = join(root, 'private-config-snapshots', `${randomUUID()}.json`);
  const ports = createResetConfigurationPorts({ dataDir: root, domain: f.domain, applyDefinition: async () => {} });
  await ports.exportConfiguration(path);
  const envelope = JSON.parse(await readFile(path, 'utf8')); envelope.payload.users[0].disabled = false;
  await writeFile(path, JSON.stringify(envelope));
  await assert.rejects(ports.restoreConfiguration(path));
  assert.equal(f.calls.includes('restore'), false);
});

test('[PG] real product variables, named document bytes and booking registrations survive export and repeated apply', { timeout: 180000 }, async t => {
  const { openTestRecords } = await import('../testing/records.ts');
  const { createPackRegistry, createWorkflowStore, writePack } = await import('../runs/api.ts');
  const { productPack, docsPack } = await import('./assemble/test-packs.ts');
  const { createDocs } = await import('./docs.ts');
  const { Database, createPool } = await import('../records/api.ts');
  const { LeaseService } = await import('../leases/api.ts');
  const kit = await openTestRecords(); t.after(() => kit.close());
  const database = new Database(createPool(kit.database, 2)); t.after(() => database.end());
  const by = (await kit.principals.bootstrapAdmin('合成覆盖管理员')).user;
  await kit.authorizations.grantPublishRight(by, by.id);
  const { productVariableNameAvailable } = await import('./variables.ts');
  const registry = createPackRegistry({ records: kit, extractDir: join(kit.dataDir, 'packs'), sandbox: { requireOsIsolation: false }, variableNameAvailable: (name, tx) => productVariableNameAvailable(kit, name, tx) });
  const product = productPack();
  const productFile = product.files['product.json'] as Record<string, unknown>;
  productFile.variables = Array.from({ length: 17 }, (_, index) => ({ name: `DEMO_ROOT_${index}`, description: '合成产品变量', schema: { type: 'string' }, default: `default-${index}` }));
  const productDirectory = await writePack(join(kit.dataDir, 'product-source'), product);
  const productOutcome = await registry.publish(by, productDirectory.dir);
  assert.equal(productOutcome.ok, true);
  const workflow = docsPack();
  const workflowFile = workflow.files['workflow.json'] as Record<string, unknown>;
  workflowFile.leases = { prefix: 'synthetic-environments/' }; workflowFile.context = ['leases'];
  const workflowDirectory = await writePack(join(kit.dataDir, 'workflow-source'), workflow);
  const workflowOutcome = await registry.publish(by, workflowDirectory.dir);
  assert.equal(workflowOutcome.ok, true);
  const workflows = createWorkflowStore(registry), docs = createDocs({ records: kit, workflows });
  const leases = new LeaseService(database, { records: kit.store });
  const output: string[] = [];
  const hub = { records: kit, registry, workflows, docs, resources: { list: async () => [] } };
  const session = { ctx: { io: { cwd: kit.dataDir, stdout: (line: string) => output.push(line) } }, options: {},
    admin: async () => by, viewer: async () => by, records: async () => kit, hub: async () => hub, leases: async () => leases,
    user: async (name: string) => { const found = name === by.id ? await kit.principals.get(name) : await kit.principals.findByName(name); if (!found) throw new Error('synthetic account missing'); return found; },
    out: (line: string) => output.push(terminalSafe(line)), err: (line: string) => output.push(terminalSafe(line)),
  } as unknown as Session;
  const variables = Array.from({ length: 17 }, (_, index) => ({ schema: 'variable@1', name: `DEMO_ROOT_${index}`, value: `synthetic-root-${index}` }));
  const documents = Array.from({ length: 12 }, (_, index) => {
    const bytes = Buffer.from(JSON.stringify({ topology: `synthetic-${index}`, empty: '' }) + '\r\n');
    return { name: `synthetic-document-${index}`, bytesBase64: bytes.toString('base64'), size: bytes.byteLength, sha256: sha256Hex(bytes), mediaType: 'application/json', fileName: `synthetic-${index}.json` };
  });
  const definition = { schema: 'deployment@1', variables, documents, leaseRegistrations: [{ prefix: 'synthetic-environments/one/', owner: by.id }], knowledgeSources: [product.id] };
  const applied = await applyDeployment(session, definition);
  assert.deepEqual(applied.differences, []);
  assert.equal((await kit.variables.list(by)).length, 17);
  assert.equal((await docs.list()).length, 12);
  assert.deepEqual(await leases.registrations(''), definition.leaseRegistrations);
  const exported = await exportDeployment(session);
  assert.deepEqual(exported.variables, [...variables].sort((a, b) => a.name.localeCompare(b.name)));
  assert.deepEqual(exported.documents.map(document => document.sha256).sort(), documents.map(document => document.sha256).sort());
  for (const document of exported.documents) assert.deepEqual(Buffer.from(document.bytesBase64, 'base64'), await kit.artifacts.trustedBytes(document.sha256));
  assert.equal(exported.missingConfiguration.length, 1);
  const repeated = await applyDeployment(session, definition);
  assert.equal(repeated.created, 0); assert.deepEqual(repeated.differences, []);
  assert.equal((await kit.variables.list(by)).every(variable => variable.version === 1), true);
  const failedDocument = { ...documents[0], bytesBase64: Buffer.from('synthetic-changed').toString('base64') };
  await assert.rejects(applyDeployment(session, { schema: 'deployment@1', documents: [failedDocument] }), /字节、长度或摘要/);
  assert.equal((await docs.show(documents[0].name))?.sha256, documents[0].sha256);
});
