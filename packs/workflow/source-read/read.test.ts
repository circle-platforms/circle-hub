// Integration and scenario tests for generic source-read skill pack:
// - 1 sample for each of the 7 system read routes (defect, story, build, mindmap, build_page, manual_file, svn_file)
// - ID not found (SOURCE_ABSENT / SOURCE_UNAVAILABLE)
// - Route not declared / type not accepted (SUBMISSION_SCHEMA_VIOLATION)
// - Source unreachable (SOURCE_UNAVAILABLE)
// - Empty inputs refusal (source-read.no_source)
// - Multi-source read in a single run
//
// Synthetic fixtures only: product Meridian, lumen-api, 192.0.2.0/24 addresses.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { PermissionRole } from '../../../contracts/generated/vocabulary.ts';
import type { ExternalRead, ExternalReadContext, ExternalReaderPort } from '../../../hub/ports.ts';
import type { Artifacts, Principal } from '../../../hub/records/api.ts';
import {
  createPackRegistry,
  createPacksPort,
  createRunsService,
  createWorkflowStore,
  temporaryDirectory,
  type AdminLogEntry,
  type PackRegistry,
  type RunsEngine,
} from '../../../hub/runs/api.ts';
import { osIsolationAvailable } from '../../../hub/rules/api.ts';
import { startPostgres, type TemporaryPostgres } from '../../../hub/testing/postgres.ts';
import { openTestRecords, type TestRecordsKit } from '../../../hub/testing/records.ts';
import { FakeKnowledge } from '../../../hub/runs/engine/testing/knowledge.ts';
import { stage } from './pack-files.ts';

const skip = (await osIsolationAvailable()) ? false : 'no OS network isolation on this machine (sandbox-exec)';

export interface FakeObject {
  bytes: Uint8Array;
  mediaType: string;
  meta?: Record<string, unknown>;
}

export class FakeExternal implements ExternalReaderPort {
  readonly objects = new Map<string, FakeObject>();
  readonly absent = new Set<string>();
  readonly unreachable = new Set<string>();
  readonly reads: string[] = [];
  readonly #artifacts: Artifacts;

  constructor(artifacts: Artifacts) {
    this.#artifacts = artifacts;
  }

  put(id: string, text: string | Uint8Array, mediaType: string, meta?: Record<string, unknown>): void {
    const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
    this.objects.set(id, { bytes, mediaType, meta });
  }

  setAbsent(id: string): void {
    this.absent.add(id);
  }

  setUnreachable(id: string): void {
    this.unreachable.add(id);
  }

  async accepts(id: string): Promise<boolean> {
    const prefix = id.split(':').slice(0, 2).join(':');
    return [
      'plm:bug',
      'plm:story',
      'plm:builds',
      'agile:mindmap',
      'buildsite:listing',
      'buildsite:file',
      'manual:file',
      'openkm:file',
      'svn:file',
    ].includes(prefix);
  }

  async read(id: string, context: ExternalReadContext): Promise<ExternalRead> {
    this.reads.push(id);
    if (this.unreachable.has(id)) {
      return { ok: false, id, reason: 'connection to origin http://192.0.2.10:80 refused' };
    }
    if (this.absent.has(id)) {
      const parts = id.split(':');
      return {
        ok: true,
        id,
        revision: null,
        artifacts: [],
        manifest: 'synthetic',
        absent: {
          code: 'SOURCE_ABSENT',
          system: parts[0],
          object: id,
          observed_at: new Date(0).toISOString(),
        },
      };
    }
    const object = this.objects.get(id);
    if (object === undefined) {
      return { ok: false, id, reason: `synthetic system answered not found for ${id}` };
    }
    const visibility = { readers: [context.principal.id], admins: true, packs: [], shareable: false };
    const ingest = (bytes: Uint8Array, mediaType: string, name: string) =>
      this.#artifacts.ingest({
        bytes,
        mediaType,
        origin: { read: { object: `${id}@1` } },
        author: { user: null },
        provenanceType: 'observed',
        visibility,
        name,
      });
    const artifacts = [{ name: 'original', artifact: await ingest(object.bytes, object.mediaType, id) }];
    if (object.meta !== undefined) {
      artifacts.push({
        name: 'meta',
        artifact: await ingest(new TextEncoder().encode(JSON.stringify(object.meta)), 'application/json', `${id} meta`),
      });
    }
    return { ok: true, id, revision: '1', artifacts, manifest: 'synthetic' };
  }
}

interface TestWorld {
  kit: TestRecordsKit;
  registry: PackRegistry;
  service: RunsEngine;
  external: FakeExternal;
  admin: Principal;
  alice: Principal;
  close(): Promise<void>;
}

let traces = 1;
const call = () => ({
  traceId: `4bf92f3577b34da6a3ce929d0e0e${(traces++).toString(16).padStart(4, '0')}`,
  sessionId: 'sess-source-read',
});

async function openWorld(postgres: TemporaryPostgres): Promise<TestWorld> {
  let clock = Date.parse('2026-10-26T12:00:00.000Z');
  const now = (): Date => new Date(clock++);
  const kit = await openTestRecords({ postgres, now });
  const temp = await temporaryDirectory('source-read-test-');
  const root = temp.path;
  try {
    const admin = (await kit.principals.bootstrapAdmin('管理员')).user;
    const alice = await kit.principals.createUser(admin, '甲');
    await kit.authorizations.grantPublishRight(admin, alice.id);
    const registry = createPackRegistry({ records: kit, extractDir: join(root, 'extracted'), now });
    const published = await registry.publish(alice, await stage(join(root, 'source-read')));
    if (!published.ok) throw new Error(`source-read publish failed: ${JSON.stringify(published.problems, null, 1)}`);
    await registry.assign(admin, alice.id, 'source-read');

    const external = new FakeExternal(kit.artifacts);
    const logs: AdminLogEntry[] = [];
    const service = createRunsService({
      records: kit,
      workflows: createWorkflowStore(registry),
      packs: createPacksPort(registry),
      knowledge: new FakeKnowledge(),
      external,
      now,
      adminLog: (entry) => logs.push(entry),
    });
    const principal = (u: { id: string; name: string; role: PermissionRole }): Principal => ({ id: u.id, name: u.name, role: u.role });
    return {
      kit,
      registry,
      service,
      external,
      admin: principal(admin),
      alice: principal(alice),
      async close() {
        await kit.close();
        await temp.remove();
      },
    };
  } catch (error) {
    await kit.close();
    await temp.remove();
    throw error;
  }
}

describe('source-read workflow runs', { skip }, () => {
  let postgres: TemporaryPostgres;
  let w: TestWorld;

  before(async () => {
    postgres = await startPostgres();
    w = await openWorld(postgres);

    // Populate synthetic fixtures for each route
    // 1. defect (plm:bug)
    w.external.put(
      'plm:bug:1001',
      JSON.stringify({ id: 1001, product: 'Meridian', title: '路由同步状态异常', status: 'resolved' }),
      'application/json',
      { title: 'Meridian 缺陷 1001' },
    );
    // 2. story (plm:story)
    w.external.put(
      'plm:story:2001',
      JSON.stringify({ id: 2001, product: 'Meridian', title: '支持 lumen-api 聚合认证', stage: 'testing' }),
      'application/json',
      { title: 'Meridian 需求 2001' },
    );
    // 3. build (plm:builds)
    w.external.put(
      'plm:builds:3001',
      JSON.stringify([{ id: '3001', name: 'Rel_Meridian_1_0_1', built_at: '2026-10-20T00:00:00Z' }]),
      'application/json',
      { title: 'Meridian 构建列表 3001' },
    );
    // 4. mindmap (agile:mindmap)
    w.external.put(
      'agile:mindmap:4001',
      JSON.stringify({
        root: {
          data: { id: 'm1', text: 'Meridian 核心功能测试脑图' },
          children: [{ data: { id: 'c1', text: 'lumen-api 接口连通性' } }],
        },
      }),
      'application/json',
      { title: 'Meridian 核心功能测试脑图', root: 'Meridian', ancestors: ['项目', '测试'] },
    );
    // 5. build_page (buildsite:listing)
    w.external.put(
      'buildsite:listing:meridian_rel_1_0.html',
      '<!DOCTYPE html><html><head><title>Meridian 1.0 发布页</title></head><body><h1>Meridian 1.0</h1></body></html>',
      'text/html',
      { title: 'Meridian 1.0 构建发布页' },
    );
    // 6. manual_file (manual:file)
    w.external.put(
      'manual:file:cli.md',
      '# Meridian CLI Manual\n\nCommand interface documentation at 192.0.2.10\n',
      'text/markdown',
      { title: 'Meridian CLI 手册' },
    );
    // 7. svn_file (svn:file)
    w.external.put(
      'svn:file:17/src/lumen.txt',
      'Lumen API configuration rev 17\nendpoint: 192.0.2.20\n',
      'text/plain',
      { title: 'lumen-api 配置文件' },
    );

    // Negative scenario stubs:
    // Absent IDs
    w.external.setAbsent('plm:bug:9999');
    w.external.setAbsent('plm:story:9999');
    // Unreachable origin
    w.external.setUnreachable('manual:file:unreachable.md');
  });

  after(async () => {
    await w?.close();
    await postgres?.stop();
  });

  it('reads a defect (plm:bug) and returns the original reference and version binding', async () => {
    const detail = await w.service.startRunDetailed(
      w.alice,
      { pack: 'source-read', inputs: { defect: { external: 'plm:bug:1001' } } },
      call(),
    );
    assert.equal(detail.answer.call_result, 'ok', JSON.stringify(detail.answer.errors));
    const run = detail.answer.run!;
    assert.ok(run.run.startsWith('run_'));
    assert.equal(run.items.length, 0, 'zero requirements yield zero items');
    assert.equal(run.sources.length, 1);

    const source = run.sources[0];
    assert.equal(source.slot, 'defect');
    assert.equal(source.role, 'subject');
    assert.equal(source.external, 'plm:bug:1001@1');
    assert.ok(source.reference.startsWith('src:'));
    assert.equal(source.media_type, 'application/json');
    assert.equal(source.label, 'Meridian 缺陷 1001');

    // Production result was computed and accepted with zero contradictions
    assert.ok(detail.production);
    assert.equal(detail.production.result.acceptance, 'accepted');
    assert.deepEqual(detail.production.counts, { delivered: 0, rejected: 0, quarantined: 0, incomplete: 0, unknown: 0 });
    assert.deepEqual(detail.production.result.errors, []);

    // Verbatim bytes readable by reference
    const sha = source.reference.slice(4);
    const read = await w.kit.artifacts.source(w.alice, sha, { consumer: 'function' });
    assert.ok(read?.bytes);
    const body = JSON.parse(new TextDecoder().decode(read.bytes));
    assert.equal(body.id, 1001);
    assert.equal(body.product, 'Meridian');
  });

  it('reads a story (plm:story) and returns the original reference', async () => {
    const detail = await w.service.startRunDetailed(
      w.alice,
      { pack: 'source-read', inputs: { story: { external: 'plm:story:2001' } } },
      call(),
    );
    assert.equal(detail.answer.call_result, 'ok');
    const run = detail.answer.run!;
    assert.equal(run.sources.length, 1);
    const source = run.sources[0];
    assert.equal(source.slot, 'story');
    assert.equal(source.external, 'plm:story:2001@1');
    assert.ok(source.reference.startsWith('src:'));
    assert.equal(source.label, 'Meridian 需求 2001');
  });

  it('reads product builds (plm:builds) and returns the original reference', async () => {
    const detail = await w.service.startRunDetailed(
      w.alice,
      { pack: 'source-read', inputs: { build: { external: 'plm:builds:3001' } } },
      call(),
    );
    assert.equal(detail.answer.call_result, 'ok');
    const run = detail.answer.run!;
    assert.equal(run.sources.length, 1);
    const source = run.sources[0];
    assert.equal(source.slot, 'build');
    assert.equal(source.external, 'plm:builds:3001@1');
    assert.ok(source.reference.startsWith('src:'));
    assert.equal(source.label, 'Meridian 构建列表 3001');
  });

  it('reads a mindmap (agile:mindmap) and returns the original reference', async () => {
    const detail = await w.service.startRunDetailed(
      w.alice,
      { pack: 'source-read', inputs: { mindmap: { external: 'agile:mindmap:4001' } } },
      call(),
    );
    assert.equal(detail.answer.call_result, 'ok');
    const run = detail.answer.run!;
    assert.equal(run.sources.length, 1);
    const source = run.sources[0];
    assert.equal(source.slot, 'mindmap');
    assert.equal(source.external, 'agile:mindmap:4001@1');
    assert.ok(source.reference.startsWith('src:'));
    assert.equal(source.label, 'Meridian 核心功能测试脑图');
  });

  it('reads a build site page (buildsite:listing) and returns the original reference', async () => {
    const detail = await w.service.startRunDetailed(
      w.alice,
      { pack: 'source-read', inputs: { build_page: { external: 'buildsite:listing:meridian_rel_1_0.html' } } },
      call(),
    );
    assert.equal(detail.answer.call_result, 'ok');
    const run = detail.answer.run!;
    assert.equal(run.sources.length, 1);
    const source = run.sources[0];
    assert.equal(source.slot, 'build_page');
    assert.equal(source.external, 'buildsite:listing:meridian_rel_1_0.html@1');
    assert.ok(source.reference.startsWith('src:'));
    assert.equal(source.media_type, 'text/html');
  });

  it('reads a manual file (manual:file) and returns the original reference', async () => {
    const detail = await w.service.startRunDetailed(
      w.alice,
      { pack: 'source-read', inputs: { manual_file: { external: 'manual:file:cli.md' } } },
      call(),
    );
    assert.equal(detail.answer.call_result, 'ok');
    const run = detail.answer.run!;
    assert.equal(run.sources.length, 1);
    const source = run.sources[0];
    assert.equal(source.slot, 'manual_file');
    assert.equal(source.external, 'manual:file:cli.md@1');
    assert.ok(source.reference.startsWith('src:'));
    assert.equal(source.media_type, 'text/markdown');
  });

  it('reads an SVN repository file (svn:file) and returns the original reference', async () => {
    const detail = await w.service.startRunDetailed(
      w.alice,
      { pack: 'source-read', inputs: { svn_file: { external: 'svn:file:17/src/lumen.txt' } } },
      call(),
    );
    assert.equal(detail.answer.call_result, 'ok');
    const run = detail.answer.run!;
    assert.equal(run.sources.length, 1);
    const source = run.sources[0];
    assert.equal(source.slot, 'svn_file');
    assert.equal(source.external, 'svn:file:17/src/lumen.txt@1');
    assert.ok(source.reference.startsWith('src:'));
    assert.equal(source.media_type, 'text/plain');
  });

  it('supports reading multiple sources in a single run', async () => {
    const detail = await w.service.startRunDetailed(
      w.alice,
      {
        pack: 'source-read',
        inputs: {
          defect: { external: 'plm:bug:1001' },
          manual_file: { external: 'manual:file:cli.md' },
          svn_file: { external: 'svn:file:17/src/lumen.txt' },
        },
      },
      call(),
    );
    assert.equal(detail.answer.call_result, 'ok');
    const run = detail.answer.run!;
    assert.equal(run.sources.length, 3);
    const slots = run.sources.map((s) => s.slot);
    assert.ok(slots.includes('defect') && slots.includes('manual_file') && slots.includes('svn_file'));
  });

  it('refuses start_run when external ID is absent (SOURCE_ABSENT)', async () => {
    const detail = await w.service.startRunDetailed(
      w.alice,
      { pack: 'source-read', inputs: { defect: { external: 'plm:bug:9999' } } },
      call(),
    );
    assert.equal(detail.answer.call_result, 'error');
    assert.equal(detail.answer.run, undefined);
    assert.ok(detail.answer.errors.some((e) => e.code === 'SOURCE_ABSENT'));
  });

  it('refuses start_run when document is not found in external system (SOURCE_UNAVAILABLE)', async () => {
    const detail = await w.service.startRunDetailed(
      w.alice,
      { pack: 'source-read', inputs: { mindmap: { external: 'agile:mindmap:9999' } } },
      call(),
    );
    assert.equal(detail.answer.call_result, 'error');
    assert.equal(detail.answer.run, undefined);
    assert.ok(detail.answer.errors.some((e) => e.code === 'SOURCE_UNAVAILABLE'));
  });

  it('refuses start_run when route/external type is not accepted by slot (SUBMISSION_SCHEMA_VIOLATION)', async () => {
    const detail = await w.service.startRunDetailed(
      w.alice,
      { pack: 'source-read', inputs: { defect: { external: 'plm:products:all' } } },
      call(),
    );
    assert.equal(detail.answer.call_result, 'error');
    assert.equal(detail.answer.run, undefined);
    assert.ok(detail.answer.errors.some((e) => e.code === 'SUBMISSION_SCHEMA_VIOLATION'));
    assert.ok(detail.answer.errors.some((e) => e.message.includes('不接受 plm:products 类型的外部对象')));
  });

  it('refuses start_run when external type is entirely undeclared/unsupported', async () => {
    const detail = await w.service.startRunDetailed(
      w.alice,
      { pack: 'source-read', inputs: { manual_file: { external: 'unsupported:doc:101' } } },
      call(),
    );
    assert.equal(detail.answer.call_result, 'error');
    assert.equal(detail.answer.run, undefined);
    assert.ok(detail.answer.errors.some((e) => e.code === 'SUBMISSION_SCHEMA_VIOLATION'));
  });

  it('refuses start_run when source origin is unreachable (SOURCE_UNAVAILABLE)', async () => {
    const detail = await w.service.startRunDetailed(
      w.alice,
      { pack: 'source-read', inputs: { manual_file: { external: 'manual:file:unreachable.md' } } },
      call(),
    );
    assert.equal(detail.answer.call_result, 'error');
    assert.equal(detail.answer.run, undefined);
    assert.ok(detail.answer.errors.some((e) => e.code === 'SOURCE_UNAVAILABLE'));
  });

  it('refuses start_run when inputs is empty with source-read.no_source', async () => {
    const detail = await w.service.startRunDetailed(
      w.alice,
      { pack: 'source-read', inputs: {} },
      call(),
    );
    assert.equal(detail.answer.call_result, 'error');
    assert.equal(detail.answer.run, undefined);
    assert.ok(detail.answer.errors.some((e) => e.code === 'source-read.no_source'));
  });
});
