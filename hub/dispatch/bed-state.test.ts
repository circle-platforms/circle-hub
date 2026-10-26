import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { canonicalBytes } from '../records/api.ts';
import { againstBaseline, bedName, parseBaseline, parseReply, captureText, lineDiff, type BedItem } from './bed-state.ts';
import { ExecutorDefinition } from './definition.ts';
import { definition } from './testing/definition.ts';
import { setup } from './testing/context.ts';

const addressItem = {
  id: 'addresses',
  call: { tool: 'show_bed', arguments: { ticket: { $value: 'lease_id' }, item: 'addresses' }, timeout_ms: 30000 },
  output: '/rows',
  lead: [] as string[],
  trail: [] as string[],
  parser: { kind: 'address_table' as const, rows: '/rows', address: '/address', manifest_devices: '/devices', manifest_lists: ['/ipv4', '/ipv6'] },
  cleanup: { actor: '合成管理员', command: 'synthetic-clear-addresses' },
};
const configItem = {
  id: 'config',
  call: { tool: 'show_bed', arguments: { ticket: { $value: 'lease_id' }, item: 'config' }, timeout_ms: 30000 },
  output: '/rows',
  lead: [] as string[],
  trail: [] as string[],
  parser: {
    kind: 'config_list' as const, rows: '/rows', identity: '/id', fields: [{ name: 'mode', pointer: '/mode' }],
    snapshot_only: false,
    manifest_rows: '/baseline', manifest_identity: '/id', manifest_fields: [{ name: 'mode', pointer: '/values/mode' }],
  },
  cleanup: { actor: '合成管理员', command: 'synthetic-clear-config' },
};
const bedState = { bed: '/bed', items: [addressItem, configItem] };
const bed = { name: 'bed-a', devices: [{ ipv4: ['192.0.2.1/24', '192.0.2.2/24'], ipv6: [] }], baseline: [{ id: 'pool', values: { mode: 'off' } }] };
const cleanAddress = { rows: [{ address: '192.0.2.2/24' }, { address: '192.0.2.1/24' }], note: '残留 synthetic-clear-addresses' };
const cleanConfig = { rows: [{ id: 'pool', mode: 'off', comment: '未恢复' }] };
const dirtyAddress = { rows: [{ address: '192.0.2.1/24' }, { address: '192.0.2.2/24' }, { address: '192.0.2.9/24' }] };

test('snapshot comparison uses the declared parser and ignores neighbouring text', () => {
  const addresses = parseReply(addressItem as BedItem, cleanAddress);
  const config = parseReply(configItem as BedItem, cleanConfig);
  assert.ok(addresses && config);
  assert.deepEqual(againstBaseline([addressItem, configItem] as BedItem[], bed, [
    { id: 'addresses', ok: true, canonical: addresses, source: 'src:' + 'a'.repeat(64) },
    { id: 'config', ok: true, canonical: config, source: 'src:' + 'b'.repeat(64) },
  ]), []);
  assert.equal(bedName(bed), 'bed-a');
  assert.equal(parseBaseline(addressItem as BedItem, { devices: [{ ipv4: ['not-an-address'] }] }), null);
  const base = definition('http://127.0.0.1:9/');
  const withBed = { ...base, allowed_tools: [...base.allowed_tools, 'show_bed'], bed_state: bedState };
  assert.equal(ExecutorDefinition.safeParse(withBed).success, true);
  assert.equal(ExecutorDefinition.safeParse({ ...withBed, bed_state: { ...bedState, items: [{ ...addressItem, call: { ...addressItem.call, arguments: { item: 'addresses' } } }] } }).success, false);
});

async function bind(c: Awaited<ReturnType<typeof setup>>) {
  const stored = await c.kit.artifacts.ingest({ bytes: canonicalBytes({ id: 'synthetic-bed', devices: [1, 2].map(n => ({ interfaces: [{ address: `192.0.2.${n}/24` }] })), bed }), mediaType: 'application/json', origin: { upload: { session: 'synthetic' } }, author: { user: c.owner.id }, provenanceType: 'declared', visibility: { readers: [c.owner.id], admins: true, packs: [], shareable: false } });
  c.detail.run.sources = c.detail.run.sources.map(source => source.slot === 'synthetic-manifest' ? { ...source, reference: `src:${stored.body.sha256}` } : source);
  (c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as { bed: { manifest_sha256: string } }).bed.manifest_sha256 = stored.body.sha256;
  c.effectDocument.effects[0].parameters.values.manifest_sha256 = [stored.body.sha256];
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, manifest_sha256: stored.body.sha256, allowed_tools: [...c.executor.definition.allowed_tools, 'show_bed'], bed_state: bedState });
  await c.freezeExecutor();
}

async function rotate(c: Awaited<ReturnType<typeof setup>>, text: string) {
  const payload = await c.kit.artifacts.ingest({ bytes: new TextEncoder().encode(text), mediaType: 'application/octet-stream', origin: { upload: { session: 'synthetic' } }, author: { user: c.owner.id }, provenanceType: 'declared', visibility: { readers: [c.owner.id], admins: true, packs: [], shareable: false } });
  (c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as { sha256: string }).sha256 = payload.body.sha256;
  c.detail.run.sources = c.detail.run.sources.map(source => source.slot === 'synthetic-artifact' ? { ...source, reference: `src:${payload.body.sha256}` } : source);
  c.effectDocument.effects[0].parameters.values.sha256 = [payload.body.sha256];
}

async function snaps(c: Awaited<ReturnType<typeof setup>>, job: string) {
  const rows = await c.kit.store.findMany<{ detail: Record<string, unknown> }>({ kind: 'action', key: 'dispatch.job', values: [job] });
  return rows.map(row => row.body.detail).filter(detail => detail.phase === 'bed_snapshot');
}

test('residue that is not in the frozen baseline blocks dispatch and names the probe and cleanup', async t => {
  const queue = [dirtyAddress, cleanConfig];
  const c = await setup({ extraTools: ['show_bed'], alter: (name, value) => name === 'show_bed' ? queue.shift() ?? value : value });
  t.after(() => c.close());
  await bind(c);
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched');
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 0);
  assert.match(state.missing_fact ?? '', /床面残留不属于基线/);
  assert.match(state.missing_fact ?? '', /来源探针 addresses/);
  assert.match(state.next_action ?? '', /由合成管理员按 synthetic-clear-addresses 处理后重开/);
  const pre = (await snaps(c, state.job)).find(detail => detail.when === 'pre');
  assert.deepEqual(pre?.differences, [{ item: 'addresses', kind: 'extra', identity: '192.0.2.9/24' }]);
});

test('a restored bed drops the shared-bed limit and leaves the reported pass in place', async t => {
  const queue = [cleanAddress, cleanConfig, cleanAddress, cleanConfig];
  const c = await setup({ extraTools: ['show_bed'], alter: (name, value) => name === 'show_bed' ? queue.shift() ?? value : value });
  t.after(() => c.close());
  await bind(c);
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'effective');
  const bytes = await c.kit.objects.get(String(state.result).slice(4));
  const report = JSON.parse(new TextDecoder().decode(bytes!)) as { rows: Array<{ reported_terminal: string; dynamic_terminal: string; limits: string[] }>; bed_state: { recovery: string; limits: string[]; differences: unknown[] } };
  assert.equal(report.rows[0].reported_terminal, 'pass');
  assert.equal(report.rows[0].dynamic_terminal, 'no_verdict');
  assert.equal(report.bed_state.recovery, 'restored');
  assert.deepEqual(report.bed_state.differences, []);
  assert.deepEqual(report.bed_state.limits, []);
  assert.equal(report.rows[0].limits.includes('未排除共享床影响'), false);
  assert.equal(report.rows[0].limits.includes('未排除本地操作'), true);
});

test('an unrestored bed keeps the reported pass, attaches the diff, and blocks the next dispatch until the pre snapshot returns', async t => {
  const queue = [cleanAddress, cleanConfig, dirtyAddress, cleanConfig, dirtyAddress, cleanConfig, cleanAddress, cleanConfig, cleanAddress, cleanConfig];
  const c = await setup({ extraTools: ['show_bed'], alter: (name, value) => name === 'show_bed' ? queue.shift() ?? value : value });
  t.after(() => c.close());
  await bind(c);
  const first = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(first.outcome, 'effective');
  const bytes = await c.kit.objects.get(String(first.result).slice(4));
  const report = JSON.parse(new TextDecoder().decode(bytes!)) as { rows: Array<{ reported_terminal: string; limits: string[] }>; bed_state: { recovery: string; limits: string[]; differences: unknown[]; next_action: string } };
  assert.equal(report.rows[0].reported_terminal, 'pass');
  assert.equal(report.bed_state.recovery, 'unrestored');
  assert.deepEqual(report.bed_state.differences, [{ item: 'addresses', kind: 'extra', identity: '192.0.2.9/24' }]);
  assert.deepEqual(report.bed_state.limits, ['未排除共享床影响', '床面未恢复']);
  assert.match(report.bed_state.next_action, /synthetic-clear-addresses/);
  assert.ok(report.rows[0].limits.includes('床面未恢复'));
  await rotate(c, 'synthetic verified bytes again');
  const blocked = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(blocked.outcome, 'not_dispatched');
  assert.match(blocked.missing_fact ?? '', /该床尚未恢复/);
  assert.match(blocked.next_action ?? '', /由合成管理员按 synthetic-clear-addresses 处理后重开/);
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 1);
  await rotate(c, 'synthetic verified bytes restored');
  const cleared = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(cleared.outcome, 'effective', JSON.stringify(cleared));
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 2);
});

test('a missing probe is unknown, names the reread, and does not submit', async t => {
  const queue = [{ note: 'show interfaces 残留' }, cleanConfig];
  const c = await setup({ extraTools: ['show_bed'], alter: (name, value) => name === 'show_bed' ? queue.shift() ?? value : value });
  t.after(() => c.close());
  await bind(c);
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched');
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 0);
  assert.match(state.missing_fact ?? '', /床面探针缺失：addresses/);
  assert.match(state.next_action ?? '', /只读探针 addresses 没有按声明解析出结构/);
  assert.match(state.next_action ?? '', /重读 show_bed 后再开/);
  assert.doesNotMatch(state.missing_fact ?? '', /不属于基线/);
  const pre = (await snaps(c, state.job)).find(detail => detail.when === 'pre');
  assert.ok(Array.isArray(pre?.sources) && (pre.sources as string[]).some(source => source.startsWith('src:')));
});

const surface = JSON.parse(readFileSync(new URL('../../packs/product/famx/tables/bed-surface.json', import.meta.url), 'utf8')) as unknown;
const sessionItem = { ...addressItem, id: 'sessions', call: { ...addressItem.call, arguments: { ticket: { $value: 'lease_id' }, item: 'sessions' } } };
const surfaceState = { bed: '/bed', items: [addressItem, sessionItem] };
const cliAddressClean = { output: 'Interface       IP Address        Status\n' };
const cliSessionClean = { output: 'Session-ID      Source                  Destination\n' };
const cliAddressDirty = { output: 'Interface       IP Address        Status\neth0            192.0.2.9/24      Up\n' };
const cliSessionDirty = { output: 'Session-ID      Source                  Destination\nleft            192.0.2.1               192.0.2.2\n' };

async function bindSurface(c: Awaited<ReturnType<typeof setup>>) {
  const stored = await c.kit.artifacts.ingest({ bytes: canonicalBytes({ id: 'synthetic-bed', devices: [1, 2].map(n => ({ interfaces: [{ address: `192.0.2.${n}/24` }] })), bed, surface }), mediaType: 'application/json', origin: { upload: { session: 'synthetic' } }, author: { user: c.owner.id }, provenanceType: 'declared', visibility: { readers: [c.owner.id], admins: true, packs: [], shareable: false } });
  c.detail.run.sources = c.detail.run.sources.map(source => source.slot === 'synthetic-manifest' ? { ...source, reference: `src:${stored.body.sha256}` } : source);
  (c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as { bed: { manifest_sha256: string } }).bed.manifest_sha256 = stored.body.sha256;
  c.effectDocument.effects[0].parameters.values.manifest_sha256 = [stored.body.sha256];
  await c.registry.update(c.admin, c.executor.id, { ...c.executor.definition, manifest_sha256: stored.body.sha256, allowed_tools: [...c.executor.definition.allowed_tools, 'show_bed'], bed_state: surfaceState });
  await c.freezeExecutor();
}

async function cleanupRows(c: Awaited<ReturnType<typeof setup>>, job: string) {
  const rows = await c.kit.store.findMany<{ detail: Record<string, unknown> }>({ kind: 'action', key: 'dispatch.job', values: [job] });
  return rows.map(row => row.body.detail).filter(detail => detail.phase === 'bed_cleanup');
}

test('an empty header is not residue and does not block dispatch', async t => {
  const queue = [cliAddressClean, cliSessionClean, cliAddressClean, cliSessionClean];
  const c = await setup({ extraTools: ['show_bed'], alter: (name, value) => name === 'show_bed' ? queue.shift() ?? value : value });
  t.after(() => c.close());
  await bindSurface(c);
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'effective', JSON.stringify(state));
  assert.equal((await cleanupRows(c, state.job)).length, 0);
  assert.equal(c.calls.includes('synthetic-clear-row'), false);
});

test('auto-cleanable residue is a dispatch action and is not executed in the hub', async t => {
  const queue = [cliAddressDirty, cliSessionClean];
  const c = await setup({ extraTools: ['show_bed'], alter: (name, value) => name === 'show_bed' ? queue.shift() ?? value : value });
  t.after(() => c.close());
  await bindSurface(c);
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched');
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 0);
  assert.equal(c.calls.includes('synthetic-clear-row'), false);
  assert.match(state.missing_fact ?? '', /可自动清理/);
  assert.match(state.next_action ?? '', /synthetic-clear-row/);
  assert.match(state.next_action ?? '', /Hub 不执行这些命令/);
  const requested = await cleanupRows(c, state.job);
  assert.equal(requested.length, 1);
  assert.equal(requested[0]?.executed, false);
  assert.equal(requested[0]?.authorization, 'required');
  assert.deepEqual(requested[0]?.actions, [{ probe: 'addresses', seat: 'synthetic-0', command: 'synthetic-clear-row', granularity: 'row', identities: ['192.0.2.9/24'] }]);
});

test('residue that needs interactive confirmation blocks dispatch and names the exit', async t => {
  const queue = [cliAddressClean, cliSessionDirty];
  const c = await setup({ extraTools: ['show_bed'], alter: (name, value) => name === 'show_bed' ? queue.shift() ?? value : value });
  t.after(() => c.close());
  await bindSurface(c);
  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched');
  assert.equal(c.calls.filter(name => name === 'send_blob').length, 0);
  assert.equal(c.calls.includes('synthetic-confirm-clear'), false);
  assert.match(state.missing_fact ?? '', /不可自动清理/);
  assert.match(state.next_action ?? '', /合成管理员/);
  assert.match(state.next_action ?? '', /重新派发之前/);
  assert.equal((await cleanupRows(c, state.job)).length, 0);
});

const textAddressItem = {
  id: 'addresses',
  call: { tool: 'show_bed', arguments: { ticket: { $value: 'lease_id' }, item: 'addresses' }, timeout_ms: 30000 },
  output: '/output',
  lead: [] as string[],
  trail: [] as string[],
  parser: {
    kind: 'text_table' as const,
    text: '/output',
    header: 'Interface       IP Address        Status',
    columns: [{ name: 'address', start: 16, end: 34, cidr: true }],
    address: 'address',
    snapshot_only: false,
    manifest_device: '/devices/0',
    manifest_lists: ['/ipv4'],
  },
  cleanup: { actor: '合成管理员', command: 'synthetic-clear-addresses' },
};

const textConfigItem = {
  id: 'config',
  call: { tool: 'show_bed', arguments: { ticket: { $value: 'lease_id' }, item: 'config' }, timeout_ms: 30000 },
  output: '/output',
  lead: [] as string[],
  trail: [] as string[],
  parser: {
    kind: 'text_table' as const,
    text: '/output',
    header: 'Pool            Mode',
    columns: [{ name: 'pool', start: 0, end: 16, cidr: false }, { name: 'mode', start: 16, end: 32, cidr: false }],
    identity: 'pool',
    snapshot_only: false,
    manifest_rows: '/baseline',
    manifest_identity: '/id',
    manifest_fields: [{ name: 'mode', pointer: '/values/mode' }],
  },
  cleanup: { actor: '合成管理员', command: 'synthetic-clear-config' },
};

const snapshotOnlyConfigItem = {
  ...textConfigItem,
  parser: {
    ...textConfigItem.parser,
    snapshot_only: true,
  },
};

test('text_table parser handles data rows, header_only, missing header, CIDR conversion, and simple list', () => {
  // With data rows
  const withRows = parseReply(textAddressItem as BedItem, {
    output: 'Interface       IP Address        Status\neth0            192.0.2.1/24      Up\neth1            192.0.2.2/24      Up\n',
  });
  assert.deepEqual(withRows, { kind: 'address_table', addresses: ['192.0.2.1/24', '192.0.2.2/24'] });

  // Address conversion with dotted netmask to CIDR
  const maskItem: BedItem = {
    ...textAddressItem,
    parser: {
      ...textAddressItem.parser,
      header: 'Interface       IP Address / Netmask      Status',
      columns: [{ name: 'address', start: 16, end: 42, cidr: true }],
    },
  };
  const withMask = parseReply(maskItem, {
    output: 'Interface       IP Address / Netmask      Status\neth0            192.0.2.1 255.255.255.0   Up\n',
  });
  assert.deepEqual(withMask, { kind: 'address_table', addresses: ['192.0.2.1/24'] });

  // Header only (empty)
  const headerOnlyResult = parseReply(textAddressItem as BedItem, {
    output: 'Interface       IP Address        Status\n',
  });
  assert.deepEqual(headerOnlyResult, { kind: 'address_table', addresses: [] });

  // Header not found (parse failure)
  const missingHeader = parseReply(textAddressItem as BedItem, {
    output: 'CLI syntax error or different prompt#\n',
  });
  assert.equal(missingHeader, null);

  // Simple list ("每行一个值")
  const simpleList = {
    id: 'simple',
    call: { tool: 'show_bed', arguments: { ticket: { $value: 'lease_id' }, item: 'simple' }, timeout_ms: 30000 },
    output: '/output',
    lead: [] as string[],
    trail: [] as string[],
    parser: {
      kind: 'text_table' as const,
      columns: [{ name: 'val', start: 0, cidr: true }],
      address: 'val',
      snapshot_only: false,
      manifest_device: '/devices/0',
      manifest_lists: ['/ipv4'],
    },
    cleanup: { actor: '合成管理员', command: 'synthetic-clear' },
  };
  const listResult = parseReply(simpleList as BedItem, {
    output: '192.0.2.1/24\n192.0.2.2/24\n',
  });
  assert.deepEqual(listResult, { kind: 'address_table', addresses: ['192.0.2.1/24', '192.0.2.2/24'] });

  // Config text_table
  const configParsed = parseReply(textConfigItem as BedItem, {
    output: 'Pool            Mode            \npool1           off             \n',
  });
  assert.deepEqual(configParsed, { kind: 'config_list', rows: [{ id: 'pool1', values: { mode: 'off' } }] });
});

test('parseBaseline narrows address baseline by declared manifest_device pointer', () => {
  const multiDeviceBed = {
    name: 'bed-multi',
    devices: [
      { name: 'dev0', ipv4: ['192.0.2.1/24'], ipv6: [] },
      { name: 'dev1', ipv4: ['192.0.2.2/24', '192.0.2.3/24'], ipv6: [] },
    ],
    baseline: [],
  };
  // With manifest_device: '/devices/0', only dev0 addresses are included
  const narrowed = parseBaseline(textAddressItem as BedItem, multiDeviceBed);
  assert.deepEqual(narrowed, { kind: 'address_table', addresses: ['192.0.2.1/24'] });

  // Comparison against dev0 observation does NOT report dev1 addresses as missing
  const read = { id: 'addresses', ok: true as const, canonical: { kind: 'address_table' as const, addresses: ['192.0.2.1/24'] }, source: 'src:' + 'a'.repeat(64) };
  assert.deepEqual(againstBaseline([textAddressItem as BedItem], multiDeviceBed, [read]), []);
});

test('snapshot_only config channel skips baseline residue check and verifies pre/post recovery', async t => {
  const bedNoBaseline = {
    name: 'bed-a',
    devices: [{ ipv4: ['192.0.2.1/24'], ipv6: [] }],
  };
  const snapshotItem = snapshotOnlyConfigItem;
  const textBedState = { bed: '/bed', items: [snapshotItem] };

  async function bindSnapshotOnly(c: Awaited<ReturnType<typeof setup>>) {
    const stored = await c.kit.artifacts.ingest({
      bytes: canonicalBytes({ id: 'synthetic-bed', devices: [1, 2].map(n => ({ interfaces: [{ address: `192.0.2.${n}/24` }] })), bed: bedNoBaseline }),
      mediaType: 'application/json',
      origin: { upload: { session: 'synthetic' } },
      author: { user: c.owner.id },
      provenanceType: 'declared',
      visibility: { readers: [c.owner.id], admins: true, packs: [], shareable: false },
    });
    c.detail.run.sources = c.detail.run.sources.map(s => s.slot === 'synthetic-manifest' ? { ...s, reference: `src:${stored.body.sha256}` } : s);
    (c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as { bed: { manifest_sha256: string } }).bed.manifest_sha256 = stored.body.sha256;
    c.effectDocument.effects[0].parameters.values.manifest_sha256 = [stored.body.sha256];
    await c.registry.update(c.admin, c.executor.id, {
      ...c.executor.definition,
      manifest_sha256: stored.body.sha256,
      allowed_tools: [...c.executor.definition.allowed_tools, 'show_bed'],
      bed_state: textBedState,
    });
    await c.freezeExecutor();
  }

  const cleanReply = { output: 'Pool            Mode            \npool1           off             \n' };
  const queue = [cleanReply, cleanReply];
  const c = await setup({ extraTools: ['show_bed'], alter: (name, value) => name === 'show_bed' ? queue.shift() ?? value : value });
  t.after(() => c.close());
  await bindSnapshotOnly(c);

  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'effective');
});

test('config channel without snapshot_only and without manifest baseline records undeclared baseline and refuses dispatch', async t => {
  const bedNoBaseline = {
    name: 'bed-a',
    devices: [{ ipv4: ['192.0.2.1/24'], ipv6: [] }],
  };
  const textBedState = { bed: '/bed', items: [textConfigItem] };

  async function bindMissingBaseline(c: Awaited<ReturnType<typeof setup>>) {
    const stored = await c.kit.artifacts.ingest({
      bytes: canonicalBytes({ id: 'synthetic-bed', devices: [1, 2].map(n => ({ interfaces: [{ address: `192.0.2.${n}/24` }] })), bed: bedNoBaseline }),
      mediaType: 'application/json',
      origin: { upload: { session: 'synthetic' } },
      author: { user: c.owner.id },
      provenanceType: 'declared',
      visibility: { readers: [c.owner.id], admins: true, packs: [], shareable: false },
    });
    c.detail.run.sources = c.detail.run.sources.map(s => s.slot === 'synthetic-manifest' ? { ...s, reference: `src:${stored.body.sha256}` } : s);
    (c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as { bed: { manifest_sha256: string } }).bed.manifest_sha256 = stored.body.sha256;
    c.effectDocument.effects[0].parameters.values.manifest_sha256 = [stored.body.sha256];
    await c.registry.update(c.admin, c.executor.id, {
      ...c.executor.definition,
      manifest_sha256: stored.body.sha256,
      allowed_tools: [...c.executor.definition.allowed_tools, 'show_bed'],
      bed_state: textBedState,
    });
    await c.freezeExecutor();
  }

  const cleanReply = { output: 'Pool            Mode            \npool1           off             \n' };
  const queue = [cleanReply];
  const c = await setup({ extraTools: ['show_bed'], alter: (name, value) => name === 'show_bed' ? queue.shift() ?? value : value });
  t.after(() => c.close());
  await bindMissingBaseline(c);

  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched');
  assert.match(state.missing_fact ?? '', /未声明基线，无法判残留/);
  assert.match(state.next_action ?? '', /由合成管理员在台架清单中声明 baseline 行或将通道声明为 snapshot_only 后重开/);
});

test('captureText strips declared lead and trail lines verbatim, preserving content', () => {
  const raw = `show ip interface brief

Interface       IP Address        Status
port1           192.0.2.1/24      up
port2           192.0.2.2/24      up

DEVICE#
`;
  const stripped = captureText(raw, ['show ip interface brief'], ['DEVICE#']);
  assert.equal(stripped, 'Interface       IP Address        Status\nport1           192.0.2.1/24      up\nport2           192.0.2.2/24      up');

  // Undeclared lead/trail lines are preserved
  const noStrip = captureText(raw, [], []);
  assert.ok(noStrip.startsWith('show ip interface brief'));
  assert.ok(noStrip.endsWith('DEVICE#'));

  // lineDiff checks
  assert.deepEqual(lineDiff('a\nb', 'a\nb'), []);
  assert.deepEqual(lineDiff('port1  192.0.2.1/24', 'port1  192.0.2.9/24'), [
    '第 1 行改变: - port1  192.0.2.1/24 / + port1  192.0.2.9/24',
  ]);
  assert.deepEqual(lineDiff('line1', 'line1\nline2'), [
    '第 2 行新增: + line2',
  ]);
  assert.deepEqual(lineDiff('line1\nline2', 'line1'), [
    '第 2 行缺失: - line2',
  ]);
});

test('raw capture probe without registered baseline blocks dispatch with unregisteredBaselineFact and gives exit', async t => {
  const rawProbe = {
    id: 'raw_probe',
    call: { tool: 'show_bed', arguments: { ticket: { $value: 'lease_id' }, item: 'raw' }, timeout_ms: 30000 },
    output: '/output',
    lead: ['show interfaces'],
    trail: ['DEVICE#'],
    cleanup: { actor: '合成管理员', command: 'synthetic-cleanup-probe' },
  };
  const rawBedState = { bed: '/bed', items: [rawProbe] };

  async function bindRawProbe(c: Awaited<ReturnType<typeof setup>>) {
    const stored = await c.kit.artifacts.ingest({
      bytes: canonicalBytes({ id: 'synthetic-bed', devices: [1, 2].map(n => ({ interfaces: [{ address: `192.0.2.${n}/24` }] })), bed }),
      mediaType: 'application/json',
      origin: { upload: { session: 'synthetic' } },
      author: { user: c.owner.id },
      provenanceType: 'declared',
      visibility: { readers: [c.owner.id], admins: true, packs: [], shareable: false },
    });
    c.detail.run.sources = c.detail.run.sources.map(s => s.slot === 'synthetic-manifest' ? { ...s, reference: `src:${stored.body.sha256}` } : s);
    (c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as { bed: { manifest_sha256: string } }).bed.manifest_sha256 = stored.body.sha256;
    c.effectDocument.effects[0].parameters.values.manifest_sha256 = [stored.body.sha256];
    await c.registry.update(c.admin, c.executor.id, {
      ...c.executor.definition,
      manifest_sha256: stored.body.sha256,
      allowed_tools: [...c.executor.definition.allowed_tools, 'show_bed'],
      bed_state: rawBedState,
    });
    await c.freezeExecutor();
  }

  const rawEcho = { output: 'show interfaces\nport1 192.0.2.1/24\nDEVICE#' };
  const queue = [rawEcho];
  const c = await setup({ extraTools: ['show_bed'], alter: (name, value) => name === 'show_bed' ? queue.shift() ?? value : value });
  t.after(() => c.close());
  await bindRawProbe(c);

  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched');
  assert.match(state.missing_fact ?? '', /未登记基线，无法判残留/);
  assert.match(state.missing_fact ?? '', /raw_probe/);
  assert.match(state.next_action ?? '', /circle-hub bed baseline record/);
  assert.match(state.next_action ?? '', /raw_probe/);
});

test('raw capture probe with baseline mismatch blocks dispatch, lists diff lines, and provides exits', async t => {
  const rawProbe = {
    id: 'raw_probe',
    call: { tool: 'show_bed', arguments: { ticket: { $value: 'lease_id' }, item: 'raw' }, timeout_ms: 30000 },
    output: '/output',
    lead: ['show interfaces'],
    trail: ['DEVICE#'],
    cleanup: { actor: '合成管理员', command: 'synthetic-cleanup-probe' },
  };
  const rawBedState = { bed: '/bed', items: [rawProbe] };

  async function bindRawProbe(c: Awaited<ReturnType<typeof setup>>) {
    const stored = await c.kit.artifacts.ingest({
      bytes: canonicalBytes({ id: 'synthetic-bed', devices: [1, 2].map(n => ({ interfaces: [{ address: `192.0.2.${n}/24` }] })), bed }),
      mediaType: 'application/json',
      origin: { upload: { session: 'synthetic' } },
      author: { user: c.owner.id },
      provenanceType: 'declared',
      visibility: { readers: [c.owner.id], admins: true, packs: [], shareable: false },
    });
    c.detail.run.sources = c.detail.run.sources.map(s => s.slot === 'synthetic-manifest' ? { ...s, reference: `src:${stored.body.sha256}` } : s);
    (c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as { bed: { manifest_sha256: string } }).bed.manifest_sha256 = stored.body.sha256;
    c.effectDocument.effects[0].parameters.values.manifest_sha256 = [stored.body.sha256];
    await c.registry.update(c.admin, c.executor.id, {
      ...c.executor.definition,
      manifest_sha256: stored.body.sha256,
      allowed_tools: [...c.executor.definition.allowed_tools, 'show_bed'],
      bed_state: rawBedState,
    });
    await c.freezeExecutor();
  }

  // Pre-dispatch returns dirty output (192.0.2.9/24 instead of registered 192.0.2.1/24)
  const dirtyEcho = { output: 'show interfaces\nport1 192.0.2.9/24\nDEVICE#' };
  const queue = [dirtyEcho];
  const c = await setup({ extraTools: ['show_bed'], alter: (name, value) => name === 'show_bed' ? queue.shift() ?? value : value });
  t.after(() => c.close());
  await bindRawProbe(c);

  // Register clean baseline: 'port1 192.0.2.1/24'
  await c.service.setBaseline(c.admin, c.executor.id, 'raw_probe', 'port1 192.0.2.1/24', '干净基线');

  const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
  assert.equal(state.outcome, 'not_dispatched');
  assert.match(state.missing_fact ?? '', /床面存在残留，与登记基线不一致/);
  assert.match(state.missing_fact ?? '', /raw_probe/);
  assert.match(state.missing_fact ?? '', /第 1 行改变/);
  assert.match(state.next_action ?? '', /synthetic-cleanup-probe/);
  assert.match(state.next_action ?? '', /circle-hub bed baseline record/);
  assert.match(state.next_action ?? '', /--reason <理由>/);
});

test('post-run match restores bed and post-run mismatch leaves bed unrestored with line diffs', async t => {
  const rawProbe = {
    id: 'raw_probe',
    call: { tool: 'show_bed', arguments: { ticket: { $value: 'lease_id' }, item: 'raw' }, timeout_ms: 30000 },
    output: '/output',
    lead: ['show interfaces'],
    trail: ['DEVICE#'],
    cleanup: { actor: '合成管理员', command: 'synthetic-cleanup-probe' },
  };
  const rawBedState = { bed: '/bed', items: [rawProbe] };

  async function bindRawProbe(c: Awaited<ReturnType<typeof setup>>) {
    const stored = await c.kit.artifacts.ingest({
      bytes: canonicalBytes({ id: 'synthetic-bed', devices: [1, 2].map(n => ({ interfaces: [{ address: `192.0.2.${n}/24` }] })), bed }),
      mediaType: 'application/json',
      origin: { upload: { session: 'synthetic' } },
      author: { user: c.owner.id },
      provenanceType: 'declared',
      visibility: { readers: [c.owner.id], admins: true, packs: [], shareable: false },
    });
    c.detail.run.sources = c.detail.run.sources.map(s => s.slot === 'synthetic-manifest' ? { ...s, reference: `src:${stored.body.sha256}` } : s);
    (c.detail.latest!.result.partitions.delivered[0].requirements[0].claims[0].statement.data as { bed: { manifest_sha256: string } }).bed.manifest_sha256 = stored.body.sha256;
    c.effectDocument.effects[0].parameters.values.manifest_sha256 = [stored.body.sha256];
    await c.registry.update(c.admin, c.executor.id, {
      ...c.executor.definition,
      manifest_sha256: stored.body.sha256,
      allowed_tools: [...c.executor.definition.allowed_tools, 'show_bed'],
      bed_state: rawBedState,
    });
    await c.freezeExecutor();
  }

  const cleanEcho = { output: 'show interfaces\nport1 192.0.2.1/24\nDEVICE#' };
  const dirtyEcho = { output: 'show interfaces\nport1 192.0.2.9/24\nDEVICE#' };

  // Case A: Post match -> restored
  {
    const queue = [cleanEcho, cleanEcho];
    const c = await setup({ extraTools: ['show_bed'], alter: (name, value) => name === 'show_bed' ? queue.shift() ?? value : value });
    t.after(() => c.close());
    await bindRawProbe(c);
    await c.service.setBaseline(c.admin, c.executor.id, 'raw_probe', 'port1 192.0.2.1/24');

    const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
    assert.equal(state.outcome, 'effective');
    const bytes = await c.kit.objects.get(String(state.result).slice(4));
    const report = JSON.parse(new TextDecoder().decode(bytes!)) as {
      bed_state: { recovery: string; differences: unknown[]; limits: string[] };
    };
    assert.equal(report.bed_state.recovery, 'restored');
    assert.deepEqual(report.bed_state.differences, []);
    assert.deepEqual(report.bed_state.limits, []);
  }

  // Case B: Post mismatch -> unrestored with line diffs, blocks subsequent dispatch
  {
    const queue = [cleanEcho, dirtyEcho];
    const c = await setup({ extraTools: ['show_bed'], alter: (name, value) => name === 'show_bed' ? queue.shift() ?? value : value });
    t.after(() => c.close());
    await bindRawProbe(c);
    await c.service.setBaseline(c.admin, c.executor.id, 'raw_probe', 'port1 192.0.2.1/24');

    const state = await c.service.dispatch(c.admin, c.run, c.executor.id);
    assert.equal(state.outcome, 'effective');
    const bytes = await c.kit.objects.get(String(state.result).slice(4));
    const report = JSON.parse(new TextDecoder().decode(bytes!)) as {
      bed_state: { recovery: string; differences: Array<{ item: string; diff_lines?: string[] }>; limits: string[] };
    };
    assert.equal(report.bed_state.recovery, 'unrestored');
    assert.equal(report.bed_state.differences.length, 1);
    assert.equal(report.bed_state.differences[0].item, 'raw_probe');
    assert.match(report.bed_state.differences[0].diff_lines?.[0] ?? '', /第 1 行改变/);
    assert.deepEqual(report.bed_state.limits, ['未排除共享床影响', '床面未恢复']);

    // Next dispatch while bed is still dirty is blocked by bed hold
    await rotate(c, 'synthetic verified bytes for next dispatch');
    queue.push(dirtyEcho);
    const nextState = await c.service.dispatch(c.admin, c.run, c.executor.id);
    assert.equal(nextState.outcome, 'not_dispatched');
    assert.match(nextState.missing_fact ?? '', /该床尚未恢复/);

    // After cleanup (pre snapshot returns to clean), hold clears and dispatch succeeds
    await rotate(c, 'synthetic verified bytes cleared');
    queue.push(cleanEcho, cleanEcho);
    const clearedState = await c.service.dispatch(c.admin, c.run, c.executor.id);
    assert.equal(clearedState.outcome, 'effective');
  }
});
