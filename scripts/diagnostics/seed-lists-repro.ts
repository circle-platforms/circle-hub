// Reproduce the real seeding failure shape: two family manual producers (like manual-famx / manual-famy), the FAMY
// family selected, a declared adoc root with a multi-file group (109 files, batch 200), a producer that throws
// ManualSourceError('incomplete_group') when its lists input is empty. Runs the real knowledgeSeed.
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, realpath, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

type Hub = Pick<typeof import('../../hub/connectors/api.ts'), 'createConnectors'> &
  Pick<typeof import('../../hub/testing/parsers.ts'), 'createTestParserRegistry'> &
  Pick<typeof import('../../hub/testing/postgres.ts'), 'startPostgres'> &
  Pick<
    typeof import('../../hub/knowledge/test-support.ts'),
    'makeWorld' | 'DEFAULT_SYNC' | 'STATIC_PLAN_SOURCE' | 'catalogXml'
  > &
  Pick<typeof import('../../hub/knowledge/seed.ts'), 'knowledgeSeed' | 'parseKnowledgeSeedArgs' | 'formatSeedReport'> &
  Pick<
    typeof import('../../hub/connectors/testing/credentials.ts'),
    'addSyntheticResource' | 'setSyntheticCredential'
  > &
  Pick<typeof import('../../hub/connectors/testing/packs.ts'), 'fakePacks'> &
  Pick<typeof import('../../packs/workflow/case-review/packaging.ts'), 'readManifest' | 'stagePack'> &
  Pick<typeof import('../../packs/system/svn/api.ts'), 'PACK_DIR'> &
  Pick<typeof import('../../hub/runs/api.ts'), 'manifestDigest'> &
  Pick<typeof import('../../hub/connectors/testing/api.ts'), 'startStub' | 'text'>;

interface ReproIO {
  mkdtemp?: (prefix: string) => Promise<string>;
  rm?: (path: string, options: { recursive: true; force: true }) => Promise<void>;
  log?: (...args: unknown[]) => void;
}

const HUB_MODULES = [
  ['hub/connectors/api.ts', ['createConnectors']],
  ['hub/testing/parsers.ts', ['createTestParserRegistry']],
  ['hub/testing/postgres.ts', ['startPostgres']],
  ['hub/knowledge/test-support.ts', ['makeWorld', 'DEFAULT_SYNC', 'STATIC_PLAN_SOURCE', 'catalogXml']],
  ['hub/knowledge/seed.ts', ['knowledgeSeed', 'parseKnowledgeSeedArgs', 'formatSeedReport']],
  ['hub/connectors/testing/credentials.ts', ['addSyntheticResource', 'setSyntheticCredential']],
  ['hub/connectors/testing/packs.ts', ['fakePacks']],
  ['packs/workflow/case-review/packaging.ts', ['readManifest', 'stagePack']],
  ['packs/system/svn/api.ts', ['PACK_DIR']],
  ['hub/runs/api.ts', ['manifestDigest']],
  ['hub/connectors/testing/api.ts', ['startStub', 'text']],
] as const;

export function parseArgs(args: string[]): string {
  if (args.length !== 2 || args[0] !== '--hub-root' || !args[1] || args[1].startsWith('--')) {
    throw new Error('用法：node scripts/diagnostics/seed-lists-repro.ts --hub-root <Hub 源码目录>');
  }
  return resolve(args[1]);
}

export async function loadHub(hubRoot: string): Promise<Hub> {
  const root = await realpath(hubRoot);
  // Check every source before importing anything or allocating test resources.
  const paths = HUB_MODULES.map(([path]) => join(root, path));
  for (const path of paths) {
    if (!(await stat(path)).isFile()) throw new Error(`Hub 源码不是文件：${path}`);
  }
  const modules = await Promise.all(paths.map((path) => import(pathToFileURL(path).href)));
  const hub: Record<string, unknown> = {};
  for (const [index, module] of modules.entries()) {
    // Keep the original named imports: test-support re-exports startPostgres,
    // which must not replace the explicitly selected postgres module's export.
    for (const name of HUB_MODULES[index][1]) {
      if (!(name in module)) throw new Error(`Hub 源码缺少导出 ${name}：${paths[index]}`);
      hub[name] = module[name];
    }
  }
  return hub as Hub;
}

const LINE = '10.8';
const BUILD = 'Synthetic_zx-u_10_8_1';
const DIR = 'synthetic/10.8';
const COUNT = 109;

// The real producer shape: family manual over a declared adoc directory; throws ManualSourceError-shaped errors
// (an Error whose message carries code；下一步：next_action like the famx pack's) when the files list is empty.
const FAMILY_MANUAL = `
export default async function familyManual(input) {
  const family = input.params.family;
  if (input.params.root === null) return { entries: [], warnings: [] };
  const meta = input.slots.meta;
  if (!meta || meta.parser !== 'json@1') { const e = new Error('名称族 ' + family + ' 缺少固定修订号的目录清单；下一步：请管理员核对 SVN 资源和 ' + family + '_ADOC_ROOT 后重跑同步，旧根不动'); e.code = 'famx.adoc.directory_unreadable'; throw e; }
  const given = input.lists?.files ?? [];
  const members = meta.model?.members ?? [];
  if (given.length !== members.length) { const e = new Error('需要每本书目录里的全部 adoc 和子目录清单，不能拆批、漏文件或混入其他目录；下一步：核对本族 ROOT、MAIN 和同修订号 SVN 原件后重跑同步'); e.code = 'famx.adoc.incomplete_group'; throw e; }
  { const e = new Error('需要每本书目录里的全部 adoc 和子目录清单，不能拆批、漏文件或混入其他目录；下一步：核对本族 ROOT、MAIN 和同修订号 SVN 原件后重跑同步'); e.code = 'famx.adoc.incomplete_group'; throw e; }
  return { entries: given.map((file, index) => ({ kind: 'definition', path: '/manual/files/n' + index, statement: file.model.raw_utf8, data: {}, fragments: [{ slot: 'files', source: file.sha256, parser: 'text@1', selector: 'l/1' }], applicability: null })), warnings: [] };
}
`;

// Exported only so the standalone verification can inject failures at resource
// boundaries without modifying Hub helpers or reaching a real service.
export async function runRepro(hub: Hub, io: ReproIO = {}) {
  const {
    startPostgres,
    makeWorld,
    DEFAULT_SYNC,
    STATIC_PLAN_SOURCE,
    catalogXml,
    startStub,
    text,
    stagePack,
    PACK_DIR,
    readManifest,
    fakePacks,
    manifestDigest,
    createConnectors,
    createTestParserRegistry,
    addSyntheticResource,
    setSyntheticCredential,
    knowledgeSeed,
    parseKnowledgeSeedArgs,
    formatSeedReport,
  } = hub;
  const makeTemp = io.mkdtemp ?? mkdtemp;
  const remove = io.rm ?? rm;
  const log = io.log ?? console.log;
  const cleanup: Partial<Record<'server' | 'world' | 'postgres' | 'directory', () => Promise<void>>> = {};
  const cleanupErrors: Error[] = [];
  let bodyFailed = false;
  let bodyError: unknown;
  let reports:
    | {
        synced: { error: unknown };
        dry: Awaited<ReturnType<Hub['knowledgeSeed']>>;
        seeded: Awaited<ReturnType<Hub['knowledgeSeed']>>;
      }
    | undefined;
  try {
    const pg = await startPostgres();
    cleanup.postgres = () => pg.stop();
    const build = {
      name: BUILD,
      base: BUILD,
      family: 'FAMY',
      line: LINE,
      platform: 'zx-u',
      built_at: '2026-10-01T00:00:00.000Z',
      released_at: '2026-10-02T00:00:00.000Z',
      sources: { tree: 'site:tree:10_8' },
    };
    const w = await makeWorld(pg, {
      pack: {
        id: 'famx',
        names: ['FAMX', 'FAMY'],
        functions: {
          'family-manual.ts': FAMILY_MANUAL,
          'plan.ts': STATIC_PLAN_SOURCE,
        },
        declaration: {
          names: ['FAMX', 'FAMY'],
          catalogs: [
            {
              id: 'commands@1',
              entry_kind: 'definition',
              producer: 'command-tree',
              complete: true,
              case_sensitive: false,
            },
          ],
          sync: { ...DEFAULT_SYNC, options: { builds: [build] } },
          variables: [
            {
              name: 'FAMX_ADOC_ROOT',
              description: 'Synthetic directory template',
              schema: { type: ['string', 'null'] },
              default: null,
            },
          ],
          producers: [
            {
              id: 'command-tree',
              title: '命令树',
              function: { module: 'functions/commands.ts' },
              inputs: { tree: { source: 'tree' } },
            },
            {
              id: 'manual-famx',
              title: 'FAMX 手册',
              function: { module: 'functions/family-manual.ts' },
              params: { family: 'FAMX', root: '${var:FAMX_ADOC_ROOT}' },
              inputs: {
                tree: { source: 'tree' },
                cli: { external: 'manual:cli:{line}', optional: true },
                app: { external: 'manual:app:{line}', optional: true },
                meta: { source: 'adoc_famx_meta', optional: true },
                files: {
                  source: 'adoc_famx_files',
                  parser: 'text@1',
                  many: true,
                  batch: 200,
                  optional: true,
                },
              },
            },
            {
              id: 'manual-famy',
              title: 'FAMY 手册',
              function: { module: 'functions/family-manual.ts' },
              params: { family: 'FAMY', root: '${var:FAMX_ADOC_ROOT}' },
              inputs: {
                tree: { source: 'tree' },
                cli: { external: 'manual:cli:{line}', optional: true },
                app: { external: 'manual:app:{line}', optional: true },
                meta: { source: 'adoc_famy_meta', optional: true },
                files: {
                  source: 'adoc_famy_files',
                  parser: 'text@1',
                  many: true,
                  batch: 200,
                  optional: true,
                },
              },
            },
          ],
        },
      },
    });
    cleanup.world = () => w.close();
    w.external.set('site:tree:10_8', {
      bytes: catalogXml({ system: [{ name: 'reboot', params: [] }] }),
      mediaType: 'application/xml',
    });
    await w.kit.variables.setVariable(w.admin, 'FAMX_ADOC_ROOT', 'synthetic/{line}', '合成目录');

    const files = Array.from({ length: COUNT }, (_, i) => `f${String(i).padStart(3, '0')}.adoc`);
    const bodies = new Map(files.map((name, i) => [name, `192.0.2.${(i % 200) + 10} file ${name}\n`]));
    const member = (name: string) => ({
      name,
      directory: false,
      external: `svn:file:17/${encodeURIComponent(`${DIR}/${name}`)}`,
      size: Buffer.byteLength(bodies.get(name) ?? ''),
      revision: '17',
    });
    const metaDoc = JSON.stringify({
      schema: 'svn-directory@1',
      identity: { path: DIR, revision: '17' },
      revision: '17',
      members: [
        {
          name: DIR,
          directory: true,
          external: `svn:directory:${encodeURIComponent(DIR)}`,
          revision: '17',
        },
        ...files.map(member),
      ],
    });

    const authorization = `Basic ${randomBytes(24).toString('base64')}`;
    const prefix = '/repository';
    const base = `${prefix}/!svn/rvr/17/${DIR}/`;
    const davRow = (href: string, rev = '17', dir = true, size = '12') =>
      `<D:response xmlns:D="DAV:"><D:href>${href}</D:href><D:propstat><D:prop><D:resourcetype>${dir ? '<D:collection/>' : ''}</D:resourcetype><D:version-name>${rev}</D:version-name>${dir ? '' : `<D:getcontentlength>${size}</D:getcontentlength>`}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
    const listing = `<D:multistatus xmlns:D="DAV:">${davRow(base)}${files.map((n) => davRow(`${base}${n}`, '17', false, String(Buffer.byteLength(bodies.get(n) ?? '')))).join('')}</D:multistatus>`;
    const server = await startStub((request) => {
      if (request.headers.authorization !== authorization) return text('Unauthorized', 'text/plain', 401);
      const path = decodeURIComponent(request.path);
      if (request.method === 'PROPFIND' && path === `${prefix}/${DIR}/`)
        return text(`<D:multistatus xmlns:D="DAV:">${davRow(path)}</D:multistatus>`, 'application/xml', 207);
      if (request.method === 'PROPFIND' && path === base) return text(listing, 'application/xml', 207);
      const m = path.match(new RegExp(`^${prefix}/!svn/rvr/17/${DIR}/(.+)$`));
      if (request.method === 'GET' && m) {
        const name = decodeURIComponent(m[1]);
        if (name === '.directory.json') return text(metaDoc, 'application/json');
        if (bodies.has(name)) return text(bodies.get(name) ?? '', 'text/plain');
      }
      return text('Absent', 'text/plain', 404);
    });
    cleanup.server = () => server.close();

    const root = await makeTemp(join(tmpdir(), 'circle-hub-seed-lists-'));
    cleanup.directory = () => remove(root, { recursive: true, force: true });
    const directory = await stagePack(PACK_DIR, join(root, 'svn'));
    const manifest = await readManifest(directory);
    const svnPacks = fakePacks([
      {
        id: manifest.id,
        version: manifest.version,
        kind: manifest.kind,
        digest: manifestDigest(manifest),
        directory,
      },
    ]);
    const connectors = createConnectors({
      records: w.kit,
      packs: svnPacks,
      sandbox: { requireOsIsolation: false },
      parsers: createTestParserRegistry(),
      resourceCacheMs: 0,
    });
    const original = w.external.read.bind(w.external);
    w.external.read = (id, readContext) =>
      id.startsWith('svn:') ? connectors.reader.read(id, readContext) : original(id, readContext);
    const resource = (
      await addSyntheticResource(w.kit, svnPacks, connectors, w.admin, {
        system_pack: 'svn',
        name: '合成仓库',
        environment: 'test',
        origins: { svn: `${server.origin}${prefix}` },
        allow_plaintext: [server.origin],
        settings: { repository_path: prefix },
      })
    ).id;
    await setSyntheticCredential(w.kit, connectors, w.admin, resource, 'authorization', authorization);

    const synced = await w.knowledge.syncProduct(w.product, { by: w.admin });
    log('sync error:', synced.error);
    const dry = await knowledgeSeed(
      w.knowledge,
      w.packs,
      w.admin,
      parseKnowledgeSeedArgs([
        '--product',
        'FAMY',
        '--line',
        LINE,
        '--build',
        BUILD,
        '--basis',
        '多批文件组育苗',
        '--dry-run',
      ]),
      connectors.catalog,
    );
    log('DRY REPORT:\n' + formatSeedReport(dry));
    const seeded = await knowledgeSeed(
      w.knowledge,
      w.packs,
      w.admin,
      parseKnowledgeSeedArgs(['--product', 'FAMY', '--line', LINE, '--build', BUILD, '--basis', '多批文件组育苗']),
      connectors.catalog,
    );
    log('SEED REPORT:\n' + formatSeedReport(seeded));
    reports = { synced, dry, seeded };
  } catch (error) {
    bodyFailed = true;
    bodyError = error;
  } finally {
    // World cleanup uses PostgreSQL; await it before stopping the database.
    // One rejection must not skip the remaining, already-owned resources.
    for (const name of ['server', 'world', 'postgres', 'directory'] as const) {
      if (!cleanup[name]) continue;
      try {
        await cleanup[name]!();
      } catch (error) {
        cleanupErrors.push(new Error(`清理 ${name} 失败`, { cause: error }));
      }
    }
  }
  if (bodyFailed) {
    if (cleanupErrors.length) {
      throw new AggregateError([bodyError, ...cleanupErrors], '复现执行失败，且资源清理有错误', { cause: bodyError });
    }
    throw bodyError;
  }
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, '资源清理失败');
  return reports;
}

if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) {
  try {
    await runRepro(await loadHub(parseArgs(process.argv.slice(2))));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
