import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat, chmod, symlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { exportProtectedConfiguration, applyProtectedConfiguration, createResetConfigurationPorts, type ProtectedConfigurationDomain, applyCommand, applyDeployment, deploymentOrder, differentFields, exactName, exportCommand, exportDeployment, parseDeployment } from './cli-apply.ts';
import { terminalSafe } from './assemble/terminal.ts';
import { ExecutorNames, ExecutorRegistry } from '../dispatch/api.ts';
import { canonicalBytes, sha256Hex, type Principal } from '../records/api.ts';
import type { Session } from './cli-session.ts';
import { ExecutorSource } from '../../contracts/src/resources.ts';
import type { ExecutorNameBinding, DeploymentDefinition } from '../../contracts/src/deployment.ts';

const uid = 'usr_00000000000000000000000001', tid = 'tm_00000000000000000000000001', rid = 'res_00000000000000000000000001';
const admin = { id: uid, name: '合成管理员', role: 'admin' as const, disabled: false, deleted_at: null };
function fake(t: TestContext) {
  const calls: string[] = [], output: string[] = [];
  const executorNames:ExecutorNameBinding[]=[];
  t.mock.method(ExecutorNames.prototype,'inspect',async()=>({active:executorNames,reserved:executorNames}));
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
      teamsOf: async (_by:unknown,kind:string,object:string) => ({teams:teams.filter(team=>assignments.has(`${kind==='pack'?'assign':'resource_assign'}:${team.id}:${object}`)),all:assignments.has(`resource_assign:*:${object}`)}),
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
  return { session, calls, output, accounts, teams, publications, resources, objects, configs, installed,executorNames };
}

test('strict deployment rejects secret material and misspelled fields without echoing values', () => {
  for (const input of [ { schema: 'deployment@2', password: 'never-echo' }, { schema: 'deployment@2', accounts: [{ name: '合成账户', role: 'user', token: 'never-echo' }] },
    { schema: 'deployment@2', resources: [{ definition: { credentials: { auth: 'raw secret value' } } }] } ]) {
    assert.throws(() => parseDeployment(input), error => error instanceof Error && !error.message.includes('never-echo') && !error.message.includes('raw secret value'));
  }
});

test('exact lookup rejects ambiguity and never uses prefixes or synonyms', () => {
  const rows = [{ id: 'one', name: '合成账户' }, { id: 'two', name: 'one' }];
  assert.equal(exactName(rows,'one',row=>row.name)?.id,'two','a name never also selects an id');
  assert.throws(()=>exactName([{id:'one',name:'same'},{id:'two',name:'same'}],'same',row=>row.name));
  assert.equal(exactName(rows,'合成',row=>row.name),undefined);
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
  const input = { schema: 'deployment@2', accounts: [{ name: '合成成员', role: 'user' }], teams: [{ name: '合成团队', members: ['合成成员'] }],
    resources: [{ definition: { name: '合成资源', system_pack: 'system-demo@1.0.0', environment: 'test', origins: { main: 'https://192.0.2.1' }, credentials: { auth: '${secret:DEMO_SECRET}' } } }],
    workflowAssignments: [{ pack: 'workflow-demo', team: '合成团队' }, { pack: 'workflow-demo', user: '合成成员' }], resourceAssignments: [{ resource: '合成资源', team: '合成团队' }], knowledgeSources: ['product-demo'] };
  const first = await applyDeployment(f.session, input);
  assert.equal(first.differences.length, 0);
  assert.deepEqual(f.calls, ['account', 'team', 'member', 'resource', 'workflow-team', 'workflow-assign', 'resource-assign', 'activate']);
  const count = f.calls.length;
  const second = await applyDeployment(f.session, input);
  assert.equal(second.created, 0); assert.deepEqual(second.differences, []); assert.equal(f.calls.length, count);
  assert.ok(!f.calls.includes('publish-right'));
  const exported = await exportDeployment(f.session);
  assert.equal(exported.resources[0].definition.credentials.auth, '${secret:DEMO_SECRET}');
  assert.equal(JSON.stringify(exported).includes('password'), false);
});

test('existing differences report exact field paths without modifying or echoing values', async t => {
  const f = fake(t);
  const report = await applyDeployment(f.session, { schema: 'deployment@2', accounts: [{ name: admin.name, role: 'user' }] });
  assert.deepEqual(report.differences, [{ section: 'accounts', index: 0, fields: ['/role'] }]);
  assert.deepEqual(f.calls, []);
  assert.deepEqual(differentFields({ nested: { secret: 'old' } }, { nested: { secret: 'new' } }), ['/nested/secret']);
});

test('missing exact pack dependency fails before creating accounts', async t => {
  const f = fake(t);
  await assert.rejects(applyDeployment(f.session, { schema: 'deployment@2', accounts: [{ name: '合成成员', role: 'user' }], packs: [{ ref: 'aa@1.0.0' }] }));
  assert.deepEqual(f.calls, []);
});

test('CLI reads scratch JSON and returns nonzero on difference; export excludes credential APIs', async t => {
  const f = fake(t), root = await mkdtemp(join(tmpdir(), 'circle-hub-apply-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'deployment.json');
  await writeFile(file, JSON.stringify({ schema: 'deployment@2', accounts: [{ name: admin.name, role: 'user' }] }));
  assert.equal(await applyCommand(f.session, [file]), 1);
  assert.match(f.output.join('\n'), /\/role/);
  f.output.length = 0;
  assert.equal(await exportCommand(f.session, []), 0);
  assert.deepEqual(JSON.parse(f.output[0]).accounts[0], { name: admin.name, role: 'admin', disabled: false });
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
  const input = { schema: 'deployment@2', packs: [{ ref: 'workflow-demo@1.0.0', directory: 'workflow-demo' }, { ref: 'skill-demo@1.0.0', directory: 'skill-demo' }] };
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
  const f = fake(t), sources: Array<{ id: string; digest: string; source: ExecutorSource }> = [];
  t.mock.method(ExecutorRegistry.prototype, 'sources', async () => sources);
  t.mock.method(ExecutorRegistry.prototype, 'add', async (_by: Principal, input: unknown, name?:string) => {
    assert.equal(name,'synthetic-executor');
    f.calls.push('executor');
    const source = { ...parseDeployment({ schema: 'deployment@2', executors: [{name:'synthetic-executor',definition:input}] }).executors[0].definition, id: 'exe_00000000000000000000000001' };
    const entry = { id: source.id, digest: sha256Hex(canonicalBytes(source)), source };
    sources.push(entry);f.executorNames.push({schema:'executor-name@1',executor:source.id,name:name!});
    return { ...entry, definition: source, variables: [], resolved_digest: entry.digest } as Awaited<ReturnType<ExecutorRegistry['add']>>;
  });
  const input = { schema: 'deployment@2', executors: [{name:'synthetic-executor',definition:syntheticExecutor()}] };
  await applyDeployment(f.session, input);
  await applyDeployment(f.session, input);
  assert.deepEqual(f.calls, ['executor']);
  const exported = await exportDeployment(f.session);
  assert.equal(exported.executors[0].definition.credential, '${secret:DEMO_SECRET}');
  const changed = await applyDeployment(f.session, { ...input, executors: [{name:'synthetic-executor',definition:{ ...syntheticExecutor(), endpoint: 'http://127.0.0.1:2/mcp' }}] });
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
  await assert.rejects(applyDeployment(f.session, { schema: 'deployment@2', packs: [{ ref: 'skill-demo@1.0.0', directory }], teams: [{ name: '合成团队' }] }));
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
  const publicState = parseDeployment({ schema: 'deployment@2', accounts: [{ name: '合成管理员', role: 'admin' }] });
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
  const { removeTree } = await import('./assemble/files.ts');
  const kit = await openTestRecords();
  const database = new Database(createPool(kit.database, 2));
  t.after(async () => {
    try { await database.end(); await removeTree(join(kit.dataDir, 'packs')); }
    finally { await kit.close(); }
  });
  const by = (await kit.principals.bootstrapAdmin('合成覆盖管理员')).user;
  await kit.authorizations.grantPublishRight(by, by.id);
  const { productVariableNameAvailable } = await import('./variables.ts');
  const registry = createPackRegistry({ records: kit, extractDir: join(kit.dataDir, 'packs'), sandbox: { requireOsIsolation: false }, variableNameAvailable: (name, tx) => productVariableNameAvailable(kit, name, tx) });
  const product = productPack();
  const productFile = product.files['product.json'] as Record<string, unknown>;
  productFile.variables = Array.from({ length: 17 }, (_, index) => ({ name: `DEMO_ROOT_${index}`, description: '合成产品变量', schema: { type: 'string' }, default: `default-${index}` }));
  (productFile.sync as Record<string, unknown>).options = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`root${index}`, '${var:DEMO_ROOT_' + index + '}']));
  const productDirectory = await writePack(join(kit.dataDir, 'product-source'), product);
  const productOutcome = await registry.publish(by, productDirectory.dir);
  assert.equal(productOutcome.ok, true, productOutcome.ok ? undefined : JSON.stringify(productOutcome));
  const workflow = docsPack();
  const workflowFile = workflow.files['workflow.json'] as Record<string, unknown>;
  workflowFile.leases = { prefix: 'synthetic-environments/' }; workflowFile.context = ['leases'];
  const workflowDirectory = await writePack(join(kit.dataDir, 'workflow-source'), workflow);
  const workflowOutcome = await registry.publish(by, workflowDirectory.dir);
  assert.equal(workflowOutcome.ok, true, workflowOutcome.ok ? undefined : JSON.stringify(workflowOutcome));
  const workflows = createWorkflowStore(registry), docs = createDocs({ records: kit, workflows });
  const leases = new LeaseService(database, { records: kit.store });
  const output: string[] = [];
  const hub = { records: kit, registry, workflows, docs, resources: { list: async () => [] } };
  const session = { ctx: { io: { cwd: kit.dataDir, env: {}, stdout: (line: string) => output.push(line) } }, options: {},
    config: () => ({ ...kit.config, database: kit.database, host: '127.0.0.1', port: 0 }),
    admin: async () => by, viewer: async () => by, records: async () => kit, hub: async () => hub, leases: async () => leases,
    user: async (name: string) => { const found = name === by.id ? await kit.principals.get(name) : await kit.principals.findByName(name); if (!found) throw new Error('synthetic account missing'); return found; },
    out: (line: string) => output.push(terminalSafe(line)), err: (line: string) => output.push(terminalSafe(line)),
  } as unknown as Session;
  const variables = Array.from({ length: 17 }, (_, index) => ({ schema: 'variable@1', name: `DEMO_ROOT_${index}`, value: `synthetic-root-${index}` }));
  const documents = Array.from({ length: 12 }, (_, index) => {
    const bytes = Buffer.from(JSON.stringify({ topology: `synthetic-${index}`, empty: '' }) + '\r\n');
    return { name: `synthetic-document-${index}`, bytesBase64: bytes.toString('base64'), size: bytes.byteLength, sha256: sha256Hex(bytes), mediaType: 'application/json', fileName: `synthetic-${index}.json` };
  });
  const definition = { schema: 'deployment@2', variables, documents, leaseRegistrations: [{ prefix: 'synthetic-environments/one/', owner: by.name }], knowledgeSources: [product.id] };
  const applied = await applyDeployment(session, definition);
  assert.deepEqual(applied.differences, []);
  assert.equal((await kit.variables.list(by)).length, 17);
  assert.equal((await docs.list()).length, 12);
  assert.deepEqual(await leases.registrations(''), [{ prefix: 'synthetic-environments/one/', owner: by.id }]);
  const exported = await exportDeployment(session);
  assert.deepEqual(exported.variables, [...variables].sort((a, b) => a.name.localeCompare(b.name)));
  assert.deepEqual(exported.documents.map(document => document.sha256).sort(), documents.map(document => document.sha256).sort());
  for (const document of exported.documents) assert.deepEqual(Buffer.from(document.bytesBase64, 'base64'), await kit.artifacts.trustedBytes(document.sha256));
  assert.equal(exported.missingConfiguration.length, 1);
  const repeated = await applyDeployment(session, definition);
  assert.equal(repeated.created, 0); assert.deepEqual(repeated.differences, []);
  assert.equal((await kit.variables.list(by)).every(variable => variable.version === 1), true);
  const failedDocument = { ...documents[0], bytesBase64: Buffer.from('synthetic-changed').toString('base64') };
  await assert.rejects(applyDeployment(session, { schema: 'deployment@2', documents: [failedDocument] }), /字节、长度或摘要/);
  assert.equal((await docs.show(documents[0].name))?.sha256, documents[0].sha256);
  assert.equal((await applyDeployment(session, { schema: 'deployment@2', knowledgeSync: [] })).created, 1);
  const emptyIntent = await kit.authorizations.resourceConfig('deployment-sync');
  assert.ok(emptyIntent?.body.bound);
  assert.deepEqual((await exportDeployment(session)).knowledgeSync, []);
  assert.equal((await applyDeployment(session, { schema: 'deployment@2', knowledgeSync: [] })).created, 0);
  assert.equal((await kit.authorizations.resourceConfig('deployment-sync'))?.digest, emptyIntent!.digest);

});

test('document base64 accepts the 2 MiB boundary and rejects malformed or noncanonical input before writing', () => {
  const bytes = Buffer.alloc(2 * 1024 * 1024, 0x78);
  const document = { name: 'synthetic-boundary', size: bytes.byteLength, sha256: sha256Hex(bytes), bytesBase64: bytes.toString('base64'), mediaType: 'application/octet-stream', fileName: 'synthetic.bin' };
  assert.doesNotThrow(() => parseDeployment({ schema: 'deployment@2', documents: [document] }));
  const small = Buffer.from('f');
  const valid = { ...document, size: small.length, sha256: sha256Hex(small), bytesBase64: 'Zg==' };
  assert.doesNotThrow(() => parseDeployment({ schema: 'deployment@2', documents: [valid] }));
  assert.doesNotThrow(() => parseDeployment({ schema: 'deployment@2', documents: [{ ...document, size: 0, sha256: sha256Hex(Buffer.alloc(0)), bytesBase64: '' }] }));
  for (const bytesBase64 of ['Zg=', 'Zg==\n', 'Zg$=', 'Zh==']) {
    assert.throws(() => parseDeployment({ schema: 'deployment@2', documents: [{ ...valid, bytesBase64 }] }));
  }
  assert.throws(() => parseDeployment({ schema: 'deployment@2', documents: [{ ...document, size: bytes.byteLength + 1 }] }));
});

test('sync targets distinguish omitted and explicit empty intents and retain exact product and line spellings', async () => {
  const { DeploymentSyncIntent } = await import('../../contracts/src/deployment.ts');
  assert.equal(parseDeployment({ schema: 'deployment@2' }).knowledgeSync, undefined);
  assert.deepEqual(parseDeployment({ schema: 'deployment@2', knowledgeSync: [] }).knowledgeSync, []);
  const targets = [{ product: 'synthetic-product', line: 'Version-A' }, { product: 'synthetic-product', line: 'version-a' }, { product: 'synthetic-product', line: '版本-甲' }, { product: 'synthetic-product', line: null }];
  assert.deepEqual(parseDeployment({ schema: 'deployment@2', knowledgeSync: targets }).knowledgeSync, targets);
  assert.deepEqual(DeploymentSyncIntent.parse({ schema: 'deployment-sync-intent@1', targets }).targets, targets);
  for (const invalid of [
    [{ product: 'synthetic-product' }],
    [{ product: 'synthetic-product', line: '' }],
    [{ product: 'synthetic-product', line: 'same' }, { product: 'synthetic-product', line: 'same' }],
    [{ product: 'Synthetic-Product', line: 'one' }],
  ]) assert.throws(() => parseDeployment({ schema: 'deployment@2', knowledgeSync: invalid }));
});

test('fresh database definition apply rejects before mutations when no administrator session exists', async t => {
  const f = fake(t);
  const { Session: ActualSession } = await import('./cli-session.ts');
  const { memoryOperatorTokens } = await import('./assemble/operator-token.ts');
  const records = await f.session.records();
  const actual = new ActualSession({
    ...f.session.ctx,
    io: { ...f.session.ctx.io, env: {}, stderr: () => {} },
    records: async () => records,
    config: () => ({ dataDir: join(tmpdir(), 'circle-hub-synthetic-config') }),
  } as unknown as import('./api.ts').CliContext, { tokens: () => memoryOperatorTokens(null) });
  await assert.rejects(applyDeployment(actual, { schema: 'deployment@2', accounts: [{ name: '合成新管理员', role: 'admin' }] }), /管理员令牌/);
  assert.deepEqual(f.calls, []);
});

async function separateApplyRuntime(kit: import('../testing/records.ts').TestRecordsKit) {
  const { Database, createPool, migrateRecords } = await import('../records/api.ts');
  const owner = new Database(createPool(kit.database, 1));
  try {
    await owner.query('CREATE ROLE synthetic_apply_runtime LOGIN NOSUPERUSER');
    const database = '"' + kit.database.database.replaceAll('"', '""') + '"';
    await owner.query(`REVOKE TEMPORARY ON DATABASE ${database} FROM PUBLIC`);
    await migrateRecords({ database: kit.database }, { runtimeRole: 'synthetic_apply_runtime' });
  } finally { await owner.end(); }
  assert.notEqual(kit.database.user, 'synthetic_apply_runtime');
  return { ...kit.database, user: 'synthetic_apply_runtime' };
}

test('[PG] a fresh database requires standard init-admin before definition apply and never auto-creates an administrator', { timeout: 120000 }, async t => {
  const { openTestRecords } = await import('../testing/records.ts');
  const { Session: ActualSession } = await import('./cli-session.ts');
  const { initAdminCommand } = await import('./cli-admin.ts');
  const { memoryOperatorTokens } = await import('./assemble/operator-token.ts');
  const { removeTree } = await import('./assemble/files.ts');
  const kit = await openTestRecords();
  const database = await separateApplyRuntime(kit);
  const config: import('../config/index.ts').HubConfig = { ...kit.config, database, host: '127.0.0.1', port: 0 };
  const { openRecords } = await import('../records/api.ts');
  const runtime = await openRecords(config, { migrate: false, keyProvider: kit.keyProvider });
  const output: string[] = [];
  const tokens = memoryOperatorTokens(null, '合成首次设置令牌库');
  const password = 'Synthetic-initial-password-58!';
  const context: import('./api.ts').CliContext = {
    io: { env: {}, cwd: kit.dataDir, stdout: line => output.push(line), stderr: line => output.push(line) },
    config: () => config, records: async () => runtime,
    deps: async () => { throw new Error('synthetic context does not expose unrelated deps'); },
    actingAdmin: async () => { throw new Error('first setup must not infer an administrator'); },
  };
  const session = new ActualSession(context, { tokens: () => tokens, readSecret: async () => password, assembly: { requireOsIsolation: false } });
  t.after(async () => {
    try { await session.close(); await removeTree(join(kit.dataDir, 'packs')); }
    finally { try { await runtime.close(); } finally { await kit.close(); } }
  });
  const definition = { schema: 'deployment@2', accounts: [{ name: '合成成员', role: 'user' }] };
  await assert.rejects(applyDeployment(session, definition), error => {
    const failure = error as Error & { hint?: string };
    assert.match(failure.message, /数据库里还没有管理员/);
    assert.match(failure.hint!, /circle-hub init-admin/);
    assert.doesNotMatch(failure.hint!, /operator-token remove|operator-token reissue/);
    return true;
  });
  assert.equal((await kit.principals.list()).length, 0);
  tokens.value = 'synthetic-old-operator-token';
  assert.equal((await kit.principals.list()).length, 0);
  assert.equal(await initAdminCommand(session, ['合成初始管理员', '--password-stdin']), 0);
  assert.notEqual(tokens.value, 'synthetic-old-operator-token');
  assert.ok(tokens.value);
  const applied = await applyDeployment(session, definition);
  assert.equal(applied.created, 1);
  assert.deepEqual(applied.differences, []);
  assert.equal((await kit.principals.list()).length, 2);
  assert.equal(output.join('\n').includes(password), false);
  assert.equal(output.join('\n').includes(tokens.value!), false);
});

test('[PG] actual CLI children perform fresh init-admin stdin then apply and export without another identity step', { timeout: 180000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { open } = await import('node:fs/promises');
  const { startPostgres } = await import('../testing/postgres.ts');
  const { openTestRecords } = await import('../testing/records.ts');
  const { fileOperatorTokens } = await import('./assemble/operator-token.ts');
  const { DEFAULT_KEY_SERVICE } = await import('../platform/api.ts');
  const { removeTree } = await import('./assemble/files.ts');
  const postgres = await startPostgres({ socket: true, passwordless: true, private: true });
  let kit: Awaited<ReturnType<typeof openTestRecords>> | undefined;
  t.after(async () => {
    try {
      if (kit) {
        try { await removeTree(join(kit.dataDir, 'packs')); }
        finally { await kit.close(); }
      }
    } finally { await postgres.stop(); }
  });
  kit = await openTestRecords({ postgres, initKey: false });
  const database = await separateApplyRuntime(kit);
  assert.equal((await kit.principals.list()).length, 0);
  const home = join(kit.dataDir, 'synthetic-home'); await mkdir(home, { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1',
    CIRCLE_HUB_DATA_DIR: kit.dataDir, CIRCLE_HUB_LOG_DIR: kit.config.logDir, CIRCLE_HUB_PORT: '0',
    CIRCLE_HUB_DATABASE_SOCKET_DIR: kit.database.host, CIRCLE_HUB_DATABASE_PORT: String(kit.database.port),
    CIRCLE_HUB_DATABASE_NAME: database.database, CIRCLE_HUB_DATABASE_USER: database.user,
  };
  const documentBytes = Buffer.from('{"topology":"synthetic-fresh"}\r\n');
  const definition = {
    schema: 'deployment@2',
    accounts: [{ name: '合成脚本管理员', role: 'admin' }, { name: '合成脚本成员', role: 'user' }],
    teams: [{ name: '合成脚本团队', members: ['合成脚本成员'] }],
    variables: [{ schema: 'variable@1', name: 'SYNTHETIC_SCRIPT_COUNT', value: 17 }],
    documents: [{ name: 'synthetic-script-topology', sha256: sha256Hex(documentBytes), size: documentBytes.length, bytesBase64: documentBytes.toString('base64'), mediaType: 'application/json', fileName: 'synthetic-topology.json' }],
    knowledgeSync: [],
  };
  const definitionFile = join(kit.dataDir, 'synthetic-definition.json');
  await writeFile(definitionFile, JSON.stringify(definition), { mode: 0o600, flag: 'wx' });
  const password = 'Synthetic-script-initial-password-93!';
  const passwordFile = join(kit.dataDir, 'synthetic-initial-password.input');
  await writeFile(passwordFile, password + '\n', { mode: 0o600, flag: 'wx' });
  assert.equal((await stat(passwordFile)).mode & 0o777, 0o600);
  const entry = fileURLToPath(new URL('../../bin/circle-hub', import.meta.url));
  const child = async (args: string[], inputFd?: number): Promise<{ code: number; stdout: string; stderr: string }> => {
    return new Promise((resolve, reject) => {
      const processChild = spawn(process.execPath, [entry, ...args], { cwd: home, env, stdio: [inputFd ?? 'ignore', 'pipe', 'pipe'], signal: t.signal });
      let stdout = '', stderr = '';
      processChild.stdout?.on('data', chunk => { stdout += String(chunk); });
      processChild.stderr?.on('data', chunk => { stderr += String(chunk); });
      processChild.once('error', () => reject(new Error('Synthetic CLI child could not start')));
      processChild.once('close', code => resolve({ code: code ?? -1, stdout, stderr }));
    });
  };
  const input = await open(passwordFile, 'r');
  let initialized: Awaited<ReturnType<typeof child>>;
  try { initialized = await child(['init-admin', '合成脚本管理员', '--password-stdin'], input.fd); }
  finally { await input.close(); }
  assert.equal(initialized.code, 0, 'Fresh init-admin child failed; diagnostics must not print stdin material');
  const applied = await child(['apply', definitionFile]);
  assert.equal(applied.code, 0, 'Definition apply child failed after standard first setup');
  const exported = await child(['export']);
  assert.equal(exported.code, 0, 'Definition export child failed');
  const actual = parseDeployment(JSON.parse(exported.stdout));
  assert.ok(actual.accounts.every(account => !('id' in account)));
  assert.ok(actual.teams.every(team => !('id' in team)));
  const normalized = {
    ...actual,
    accounts: actual.accounts.map(account=>account).sort((a, b) => a.name.localeCompare(b.name)),
    teams: actual.teams.map(team => ({ ...team, members: [...team.members].sort() })).sort((a, b) => a.name.localeCompare(b.name)),
  };
  const expected = parseDeployment(definition);
  expected.accounts.sort((a, b) => a.name.localeCompare(b.name));
  assert.deepEqual(normalized, expected);
  const administrator = await kit.principals.findByName('合成脚本管理员');
  assert.ok(administrator);
  assert.ok(await kit.principals.verifyPassword(administrator.name, password));
  const storedToken = await fileOperatorTokens(kit.dataDir, DEFAULT_KEY_SERVICE).read();
  assert.ok(storedToken);
  const output = initialized.stdout + initialized.stderr + applied.stdout + applied.stderr + exported.stdout + exported.stderr;
  assert.equal(output.includes(password), false);
  assert.equal(output.includes(storedToken), false);
  assert.doesNotMatch(initialized.stdout, /初始密码（仅显示一次/);
});

test('[PG] same-root all reset preserves old operator bytes and the standard CLI first setup remains usable', { timeout: 180000 }, async t => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const { open } = await import('node:fs/promises');
  const { migrateRecords } = await import('../records/api.ts');
  const { createContext, postgresFor, layoutAt, ensureLayout, newSettingsFile, writeSettingsFile, ensureDatabaseRunning, withSession } = await import('../platform/api.ts');
  const { recordingRunner, exit, freePort, socketPort, libpqAvailable } = await import('../platform/test-support.ts');
  const { resetData } = await import('./reset/host.ts');
  const { protectedFiles } = await import('./reset/protected-files.ts');
  const { removeTree } = await import('./assemble/files.ts');
  const libpq = await libpqAvailable(); assert.ok(libpq, 'Real reset regression needs the existing PostgreSQL 18 backup tools');
  const parent = await mkdtemp(join(tmpdir(), 'chu1-reset-')), layout = layoutAt(join(parent, 'data'));
  await ensureLayout(layout);
  const port = await freePort(), databasePort = socketPort();
  await writeSettingsFile(layout, newSettingsFile({ environment: 'test', port, database: { port: databasePort } }));
  const runner = recordingRunner(call => /(?:launchctl|systemctl)$/.test(call.command) ? exit(113, 'synthetic service not loaded') : undefined).runner;
  const context = createContext({ CIRCLE_HUB_DATA_DIR: layout.root }, { platform: 'darwin', home: parent, launchAgentsDir: join(parent, 'agents'), layout, runner, libpqBin: libpq });
  const postgres = postgresFor(context);
  t.after(async () => { try { await postgres.stop(); } finally { await removeTree(parent); } });
  await postgres.initialise(); await ensureDatabaseRunning(postgres, { create: true });
  const database = { host: postgres.target.socketDir, port: databasePort, user: postgres.target.user, database: postgres.target.database };
  await migrateRecords({ database }, { runtimeRole: postgres.application.user });
  const env: NodeJS.ProcessEnv = {
    HOME: parent, PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8', NODE_NO_WARNINGS: '1',
    CIRCLE_HUB_DATA_DIR: layout.root, CIRCLE_HUB_LOG_DIR: layout.logs, CIRCLE_HUB_PORT: String(port),
    CIRCLE_HUB_DATABASE_SOCKET_DIR: database.host, CIRCLE_HUB_DATABASE_PORT: String(database.port),
    CIRCLE_HUB_DATABASE_NAME: database.database, CIRCLE_HUB_DATABASE_USER: postgres.application.user,
  };
  const password = 'Synthetic-same-root-password-82!';
  const passwordFile = join(parent, 'synthetic-first-setup.input');
  await writeFile(passwordFile, password + '\n', { mode: 0o600, flag: 'wx' });
  const entry = fileURLToPath(new URL('../../bin/circle-hub', import.meta.url));
  const child = async (args: string[], stdin = false): Promise<{ code: number; stdout: string; stderr: string }> => {
    const input = stdin ? await open(passwordFile, 'r') : null;
    try {
      return await new Promise((resolve, reject) => {
        const subprocess = spawn(process.execPath, [entry, ...args], { cwd: parent, env, stdio: [input?.fd ?? 'ignore', 'pipe', 'pipe'], signal: t.signal });
        let stdout = '', stderr = '';
        subprocess.stdout?.on('data', chunk => { stdout += String(chunk); });
        subprocess.stderr?.on('data', chunk => { stderr += String(chunk); });
        subprocess.once('error', () => reject(new Error('Synthetic same-root CLI child could not start')));
        subprocess.once('close', code => resolve({ code: code ?? -1, stdout, stderr }));
      });
    } finally { await input?.close(); }
  };
  const oldSetup = await child(['init-admin', '合成原管理员', '--password-stdin'], true);
  const setupDiagnostic = oldSetup.stderr.replaceAll(password, '[omitted]').replace(/[A-Za-z0-9_-]{43}/g, '[omitted-token]');
  assert.equal(oldSetup.code, 0, 'Original current-schema setup failed: ' + setupDiagnostic);
  assert.equal(oldSetup.stdout.includes(password), false);
  const originals = await protectedFiles(layout);
  assert.ok(originals.some(file => file.area === 'keys'));
  const report = await resetData(context, { scopes: 'all', keepConfig: false });
  assert.ok(report.archive); assert.ok(report.backup);
  assert.deepEqual(await protectedFiles(layout), originals);
  const [empty] = await withSession(postgres.connector, postgres.target.database, session => session.query('SELECT count(*)::int AS n FROM users'));
  assert.equal(empty!.n, 0);
  const prematureFile = join(parent, 'synthetic-premature-definition.json');
  await writeFile(prematureFile, JSON.stringify({ schema: 'deployment@2' }), { mode: 0o600, flag: 'wx' });
  const premature = await child(['apply', prematureFile]);
  assert.equal(premature.code, 1);
  assert.match(premature.stderr, /数据库里还没有管理员/);
  assert.match(premature.stderr, /circle-hub init-admin/);
  assert.doesNotMatch(premature.stderr, /operator-token remove|operator-token reissue/);
  assert.deepEqual(await protectedFiles(layout), originals);
  const freshSetup = await child(['init-admin', '合成新管理员', '--password-stdin'], true);
  assert.equal(freshSetup.stdout.includes(password) || freshSetup.stderr.includes(password), false);
  if (freshSetup.code !== 0) assert.match(freshSetup.stderr, /已经有操作令牌/);
  assert.equal(freshSetup.code, 0, 'Known first-setup blocker: reset preserved the stale operator token; no remove or other identity step was inserted');
  const afterSetup = await protectedFiles(layout);
  assert.deepEqual(afterSetup.map(file => [file.area, file.path]), originals.map(file => [file.area, file.path]));
  assert.deepEqual(afterSetup.filter(file => file.area === 'vault'), originals.filter(file => file.area === 'vault'));
  assert.ok(originals.some(before => before.area === 'keys' && afterSetup.some(after => after.area === before.area && after.path === before.path && after.sha256 !== before.sha256)));
  const definition = { schema: 'deployment@2', accounts: [{ name: '合成新管理员', role: 'admin' }], knowledgeSync: [] };
  const file = join(parent, 'synthetic-after-reset-definition.json'); await writeFile(file, JSON.stringify(definition), { mode: 0o600, flag: 'wx' });
  const applied = await child(['apply', file]); assert.equal(applied.code, 0, 'Same-root apply failed after standard first setup');
  const exported = await child(['export']); assert.equal(exported.code, 0);
  const actual = parseDeployment(JSON.parse(exported.stdout));
  assert.deepEqual({ ...actual, accounts: actual.accounts.map(account=>account) }, parseDeployment(definition));
  const { fileOperatorTokens, deploymentKeyService } = await import('./assemble/operator-token.ts');
  const token = await fileOperatorTokens(layout.root, await deploymentKeyService(env)).read();
  assert.ok(token);
  const output = oldSetup.stdout + oldSetup.stderr + freshSetup.stdout + freshSetup.stderr + applied.stdout + applied.stderr + exported.stdout + exported.stderr;
  assert.equal(output.includes(password), false);
  assert.equal(output.includes(token), false);
});


test('empty-database apply directs initial setup before reading a stale or absent operator token', async t => {
  const f = fake(t); f.accounts.length = 0;
  t.mock.method(f.session, 'admin', async () => { throw new Error('must not read stale operator token'); });
  await assert.rejects(applyDeployment(f.session, { schema: 'deployment@2' }), error => {
    const failure = error as Error & { hint?: string };
    assert.match(failure.message, /数据库里还没有管理员/);
    assert.match(failure.hint!, /circle-hub init-admin/);
    assert.match(failure.hint!, /circle-hub apply/);
    assert.doesNotMatch(failure.hint!, /operator-token remove|operator-token reissue/);
    return true;
  });
  assert.deepEqual(f.calls, []);
});

test('portable export retains all named executors at the same target and reapplies exact names',async t=>{
  const f=fake(t),one={...syntheticExecutor(),id:'exe_'+ '0'.repeat(25)+'1',target:'synthetic-shared'},two={...syntheticExecutor(),id:'exe_'+ '0'.repeat(25)+'2',target:'synthetic-shared'};
  t.mock.method(ExecutorRegistry.prototype,'sources',async()=>[one,two].map(source=>({id:source.id,digest:sha256Hex(canonicalBytes(source)),source})));
  f.executorNames.push({schema:'executor-name@1',executor:one.id,name:'synthetic-first'},{schema:'executor-name@1',executor:two.id,name:'synthetic-second'});
  const exported=await exportDeployment(f.session);
  assert.equal(exported.executors.length,2);assert.deepEqual(exported.executors.map(row=>row.name),['synthetic-first','synthetic-second']);
  assert.ok(exported.executors.every(row=>!('id'in row.definition)));
  for(let n=0;n<2;n++)assert.equal((await applyDeployment(f.session,{...exported,missingConfiguration:[]})).created,0);
  assert.deepEqual(f.calls,[]);
});

test('an explicit executor name never also selects another executor target',async t=>{
  const f=fake(t),one=ExecutorSource.parse({...syntheticExecutor(),id:'exe_'+ '0'.repeat(25)+'1',target:'synthetic-first'}),two=ExecutorSource.parse({...syntheticExecutor(),id:'exe_'+ '0'.repeat(25)+'2',target:'synthetic-name'});
  assert.ok(one.id); assert.ok(two.id);
  t.mock.method(ExecutorRegistry.prototype,'sources',async()=>[one,two].map(source=>{ assert.ok(source.id); return {id:source.id,digest:sha256Hex(canonicalBytes(source)),source}; }));
  f.executorNames.push({schema:'executor-name@1',executor:one.id,name:'synthetic-name'},{schema:'executor-name@1',executor:two.id,name:'synthetic-other'});
  const {id,...definition}=one;
  const report=await applyDeployment(f.session,{schema:'deployment@2',executors:[{name:'synthetic-name',definition}]});
  assert.equal(report.created,0);assert.deepEqual(report.differences,[]);assert.deepEqual(f.calls,[]);
});

test('an unnamed executor blocks export with an explicit administrator naming command, not silent omission',async t=>{
  const f=fake(t),source={...syntheticExecutor(),id:'exe_'+ '0'.repeat(25)+'1'};
  t.mock.method(ExecutorRegistry.prototype,'sources',async()=>[{id:source.id,digest:sha256Hex(canonicalBytes(source)),source}]);
  await assert.rejects(exportDeployment(f.session),error=>error instanceof Error&&error.message.includes(`circle-hub executor name ${source.id} <明确名字>`));
  f.executorNames.push({schema:'executor-name@1',executor:source.id,name:'synthetic-named'});
  assert.equal((await exportDeployment(f.session)).executors.length,1);
});

test('missing or duplicate names refuse before an otherwise new account or any other write',async t=>{
  const f=fake(t),definition=syntheticExecutor();
  for(const executors of [[{definition}],[{name:'same',definition},{name:'same',definition}]]){
    await assert.rejects(applyDeployment(f.session,{schema:'deployment@2',accounts:[{name:'synthetic-new-account',role:'user'}],executors}),/executors/);
    assert.deepEqual(f.calls,[]);assert.equal(f.accounts.length,1);
  }
});

test('public executor internal ids and retired deployment files are refused without conversion or writes',async t=>{
  const f=fake(t);
  for(const input of [{schema:'deployment@1'},{schema:'deployment@2',executors:[{name:'synthetic-named',definition:{...syntheticExecutor(),id:'exe_'+ '0'.repeat(26)}}]},{schema:'deployment@2',accounts:[{id:uid,name:'synthetic-account',role:'user'}]}]){
    await assert.rejects(applyDeployment(f.session,input));assert.deepEqual(f.calls,[]);
  }
});
