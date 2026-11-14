// Cleanroom black-box harness for reset/rebuild and deployment-definition acceptance suites.
// Interacts strictly through bin/circle-hub subprocesses, HTTP/console/MCP endpoints, public contracts, and live DB reads.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Pool } from 'pg';
import { RESET_SCOPE, RESET_SCOPE_LABEL, type ResetScope } from '../../../contracts/src/reset.ts';
import { definition as baseExecutorDefinition } from '../../../hub/dispatch/testing/definition.ts';
import { BACKUP_SCHEMA, createContext, postgresFor, settingsOf, verifyBackup } from '../../../hub/platform/api.ts';
import { checkAnswer, type Answer, type Outputs, type ToolName } from './mcp.ts';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const BIN_HUB = resolve(REPO_ROOT, 'bin', 'circle-hub');

export const SYNTHETIC_ADMIN_PASS = 'SynthAdmin!Reset#2026';
export const RFC5737_PLM_OAUTH = 'http://192.0.2.10:8080';
export const RFC5737_PLM_API = 'http://192.0.2.11:8080';
export const RFC5737_PLM_ALT = 'http://192.0.2.99:8080';
export const LOOPBACK_EXEC_ENDPOINT = 'http://127.0.0.1:19201/mcp';
export const LOOPBACK_EXEC_ALT = 'http://127.0.0.1:19299/mcp';

export interface CliResult {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  combined: string;
}

export interface CliRunOptions {
  stdin?: string;
  token?: string;
  scratchHome?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  expectOk?: boolean;
  cwd?: string;
}

export interface VaultKeySnapshot {
  keys: ReadonlyMap<string, string>;
  vault: ReadonlyMap<string, string>;
  rawSubstrings: readonly string[];
}

export interface HttpReply {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface ServeHandle {
  port: number;
  process: ChildProcess;
  logs: () => string;
  stop: () => Promise<void>;
  healthz: () => Promise<HttpReply>;
}

export interface DirectMcpClient {
  call<N extends ToolName>(name: N, args: Record<string, unknown>): Promise<Answer<Outputs[N]>>;
  close(): Promise<void>;
}

export interface ParsedCliSyntax {
  usageText: string;
  hasReset: boolean;
  hasExport: boolean;
  hasApply: boolean;
  resetSupportsJson: boolean;
  exportMode: 'out-flag' | 'positional' | 'stdout';
  applyMode: 'definition-flag' | 'file-flag' | 'positional';
}

export interface SeededCanaries {
  adminPassword: string;
  userPasswords: string[];
  aliceToken: string;
  plmUserSecret: string;
  plmPassSecret: string;
  execSecret: string;
  varSecret: string;
  extraSecret: string;
}

export interface SeededHubState {
  dataDir: string;
  scratchHome: string;
  port: number;
  teamAlphaId: string;
  teamBetaId: string;
  plmResourceId: string;
  aliceId: string;
  bobId: string;
  adminId: string;
  skillRef: string;
  productId: string;
  workflowId: string;
  executorTarget: string;
  plainVarName: string;
  plainVarValue: string;
  secretVarName: string;
  docBedName: string;
  docBedSha256: string;
  docNoteName: string;
  docNoteText: string;
  docNoteSha256: string;
  overlayPackId: string;
  runArtifactSha256?: string;
  runArtifactRef?: string;
  knowledgeOriginalSha256?: string;
  knowledgeEntryRef?: string;
  teamShareRef?: string;
  memoryDocId?: string;
  canaries: SeededCanaries;
  seededRunsCount: number;
  canRunSandboxedPacks: boolean;
}

let cachedCliSyntax: ParsedCliSyntax | undefined;

/** Allocates an ephemeral TCP port bound to loopback 127.0.0.1. */
export async function allocateLoopbackPort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('failed to allocate loopback port')));
        return;
      }
      const { port } = address;
      server.close((err) => (err ? reject(err) : resolvePort(port)));
    });
  });
}

/** Creates a short temp root safe against the ~103-byte unix domain socket limit for embedded PostgreSQL. */
export async function createShortTempRoot(prefix = 'ch-r-'): Promise<{ root: string; dataDir: string; scratchHome: string }> {
  const candidate = tmpdir();
  const sampleSocket = join(candidate, `${prefix}123456`, 'd', 'run', '.s.PGSQL.5432');
  const base = Buffer.byteLength(sampleSocket, 'utf8') < 96 ? candidate : '/tmp';
  const root = await mkdtemp(join(base, prefix));
  const dataDir = join(root, 'd');
  const scratchHome = join(root, 'h');
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  await mkdir(scratchHome, { recursive: true, mode: 0o700 });
  return { root, dataDir, scratchHome };
}

/** Recursively restores owner write bits so read-only pack directories remove cleanly. */
async function restoreWritableTree(target: string): Promise<void> {
  const info = await lstat(target).catch(() => null);
  if (!info || info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await chmod(target, 0o700).catch(() => undefined);
    const entries = await readdir(target).catch(() => []);
    for (const entry of entries) await restoreWritableTree(join(target, entry));
  } else {
    await chmod(target, 0o600).catch(() => undefined);
  }
}

/** Stops any Hub server/DB cleanly and deletes temporary root directories. */
export async function teardownRoot(root: string, dataDir: string, serve?: ServeHandle): Promise<void> {
  if (serve) await serve.stop().catch(() => undefined);
  await runCli(dataDir, ['db', 'stop'], { timeoutMs: 20_000 }).catch(() => undefined);
  await restoreWritableTree(root);
  await rm(root, { recursive: true, force: true }).catch(() => undefined);
}

/** Builds a clean stripped subprocess environment free of retired/inherited cluster variables. */
export function buildSubprocessEnv(
  dataDir: string,
  options: { scratchHome?: string; token?: string; allowServeToken?: boolean; extra?: Record<string, string | undefined> } = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TZ', 'USER', 'LOGNAME', 'TMPDIR', 'NODE_OPTIONS', 'CIRCLE_HUB_LIBPQ_BIN']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.HOME = options.scratchHome ?? dirname(dataDir);
  env.CIRCLE_HUB_DATA_DIR = dataDir;
  if (options.token !== undefined || options.allowServeToken) {
    if (options.token !== undefined) env.CIRCLE_HUB_TOKEN = options.token;
  }
  if (options.extra) {
    for (const [k, v] of Object.entries(options.extra)) {
      if (v === undefined) delete env[k];
      else env[k] = v;
    }
  }
  return env;
}

/** Executes bin/circle-hub in an isolated subprocess with bounded timeout and clean environment. */
export async function runCli(dataDir: string, args: readonly string[], options: CliRunOptions = {}): Promise<CliResult> {
  const env = buildSubprocessEnv(dataDir, { scratchHome: options.scratchHome, token: options.token, extra: options.env });
  const timeoutMs = options.timeoutMs ?? 60_000;
  return await new Promise((resolveCli, reject) => {
    const child = spawn(BIN_HUB, [...args], {
      cwd: options.cwd ?? REPO_ROOT,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`circle-hub ${args.join(' ')} timed out after ${timeoutMs}ms\nstdout=${Buffer.concat(outChunks).toString('utf8')}\nstderr=${Buffer.concat(errChunks).toString('utf8')}`));
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => outChunks.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    child.once('error', (err) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      const stdout = Buffer.concat(outChunks).toString('utf8');
      const stderr = Buffer.concat(errChunks).toString('utf8');
      const res: CliResult = {
        code: code ?? (signal ? 1 : 0),
        signal,
        stdout,
        stderr,
        combined: `${stdout}\n${stderr}`,
      };
      if (options.expectOk && res.code !== 0) {
        reject(new Error(`circle-hub ${args.join(' ')} failed with exit ${res.code} (${signal ?? 'none'}):\nstdout: ${stdout}\nstderr: ${stderr}`));
        return;
      }
      resolveCli(res);
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

/** Discovers live CLI usage signatures for reset/export/apply without hardcoding unspec'd optional flags. */
export async function discoverCliSyntax(dataDir: string): Promise<ParsedCliSyntax> {
  if (cachedCliSyntax) return cachedCliSyntax;
  const rootUsage = await runCli(dataDir, [], { timeoutMs: 20_000 });
  const text = `${rootUsage.stdout}\n${rootUsage.stderr}`;
  const extractCommandLines = (output: string, cmd: string): string =>
    output
      .split('\n')
      .filter((line) => new RegExp(`^\\s*(?:用法：circle-hub\\s+)?${cmd}\\b`).test(line))
      .join(' ');
  let resetLine = extractCommandLines(text, 'reset');
  let exportLine = extractCommandLines(text, 'export');
  let applyLine = extractCommandLines(text, 'apply');

  // If subcommand help gives richer flags (without dumping the entire root usage menu), inspect matching lines only.
  for (const [cmd, setter] of [
    ['reset', (v: string) => { resetLine = `${resetLine} ${v}`; }],
    ['export', (v: string) => { exportLine = `${exportLine} ${v}`; }],
    ['apply', (v: string) => { applyLine = `${applyLine} ${v}`; }],
  ] as const) {
    const sub = await runCli(dataDir, [cmd, '--help'], { timeoutMs: 15_000 }).catch(() => null);
    if (sub && !/未知命令|unknown command/i.test(sub.combined)) {
      const scoped = sub.code === 0 ? sub.combined : extractCommandLines(sub.combined, cmd);
      if (scoped.trim().length > 0) setter(scoped);
    }
  }

  const hasReset = resetLine.trim().length > 0 && !/未知命令/.test(resetLine);
  const hasExport = exportLine.trim().length > 0 && !/未知命令/.test(exportLine);
  const hasApply = applyLine.trim().length > 0 && !/未知命令/.test(applyLine);

  const exportMode: ParsedCliSyntax['exportMode'] = /--out\b/.test(exportLine)
    ? 'out-flag'
    : /\bexport\s+(?:\[)?<[^>]+>/.test(exportLine)
      ? 'positional'
      : 'stdout';

  const applyMode: ParsedCliSyntax['applyMode'] = /--definition\b/.test(applyLine)
    ? 'definition-flag'
    : /--file\b/.test(applyLine)
      ? 'file-flag'
      : 'positional';

  const parsed: ParsedCliSyntax = {
    usageText: text,
    hasReset,
    hasExport,
    hasApply,
    resetSupportsJson: /\breset\b[^\n]*--json\b/.test(resetLine),
    exportMode,
    applyMode,
  };
  cachedCliSyntax = parsed;
  return parsed;
}

/** Runs `circle-hub export` according to CLI syntax and writes the exported JSON definition to outFile. */
export async function runExportCli(dataDir: string, outFile: string, options: CliRunOptions = {}): Promise<CliResult> {
  const syntax = await discoverCliSyntax(dataDir);
  assert.ok(syntax.hasExport, `circle-hub CLI must expose 'export' command; usage:\n${syntax.usageText}`);
  const args =
    syntax.exportMode === 'out-flag'
      ? ['export', '--out', outFile]
      : syntax.exportMode === 'positional'
        ? ['export', outFile]
        : ['export'];
  const res = await runCli(dataDir, args, options);
  if (res.code === 0 && syntax.exportMode === 'stdout') {
    await writeFile(outFile, res.stdout, 'utf8');
  }
  return res;
}

/** Runs `circle-hub apply` against defFile according to CLI syntax. */
export async function runApplyCli(dataDir: string, defFile: string, options: CliRunOptions = {}): Promise<CliResult> {
  const syntax = await discoverCliSyntax(dataDir);
  assert.ok(syntax.hasApply, `circle-hub CLI must expose 'apply' command; usage:\n${syntax.usageText}`);
  const args =
    syntax.applyMode === 'definition-flag'
      ? ['apply', '--definition', defFile]
      : syntax.applyMode === 'file-flag'
        ? ['apply', '--file', defFile]
        : ['apply', defFile];
  return await runCli(dataDir, args, options);
}

/** Runs `circle-hub reset` with spec'd flags (adds --json if supported). */
export async function runResetCli(
  dataDir: string,
  params: { scopes: readonly ResetScope[] | 'all'; keepConfig?: boolean; definition?: string },
  options: CliRunOptions = {},
): Promise<CliResult> {
  const syntax = await discoverCliSyntax(dataDir);
  assert.ok(syntax.hasReset, `circle-hub CLI must expose 'reset' command; usage:\n${syntax.usageText}`);
  const args: string[] = ['reset'];
  if (params.scopes === 'all') {
    args.push('--scope', 'all');
  } else {
    for (const s of params.scopes) args.push('--scope', s);
  }
  if (params.keepConfig) args.push('--keep-config');
  if (params.definition !== undefined) args.push('--definition', params.definition);
  if (syntax.resetSupportsJson) args.push('--json');
  return await runCli(dataDir, args, { timeoutMs: 120_000, ...options });
}

/** Sends an HTTP request directly to loopback 127.0.0.1:port without trusting process proxy state. */
export function httpCall(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<HttpReply> {
  return new Promise((resolveHttp, reject) => {
    const headers: Record<string, string> = { host: `127.0.0.1:${port}`, ...(options.headers ?? {}) };
    const req = httpRequest(
      { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers, setHost: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolveHttp({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

/** Spawns `circle-hub serve` and polls `/healthz` until HTTP 200 (or throws if process exits prematurely). */
export async function spawnServe(
  dataDir: string,
  port: number,
  options: { scratchHome?: string; extraEnv?: Record<string, string | undefined>; deadlineMs?: number } = {},
): Promise<ServeHandle> {
  const env = buildSubprocessEnv(dataDir, { scratchHome: options.scratchHome, extra: options.extraEnv });
  const child = spawn(BIN_HUB, ['serve'], {
    cwd: REPO_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const logChunks: Buffer[] = [];
  const push = (chunk: Buffer) => {
    logChunks.push(chunk);
    if (logChunks.length > 200) logChunks.shift();
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);

  let exited = false;
  let exitInfo = '';
  child.once('exit', (code, signal) => {
    exited = true;
    exitInfo = `code=${code} signal=${signal ?? 'none'}`;
  });

  const logs = () => Buffer.concat(logChunks).toString('utf8');
  const stop = async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      const deadline = Date.now() + 8_000;
      while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
        await delay(50);
      }
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await new Promise<void>((r) => child.once('exit', () => r()));
      }
    }
  };

  const deadline = Date.now() + (options.deadlineMs ?? 20_000);
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`circle-hub serve exited prematurely (${exitInfo}) before /healthz answered:\n${logs()}`);
    }
    try {
      const reply = await httpCall(port, '/healthz');
      if (reply.status === 200) {
        return {
          port,
          process: child,
          logs,
          stop,
          healthz: () => httpCall(port, '/healthz'),
        };
      }
    } catch {
      // Listener not bound yet; keep polling until deadline.
    }
    await delay(100);
  }
  await stop();
  throw new Error(`circle-hub serve did not answer /healthz HTTP 200 within deadline:\n${logs()}`);
}

/** Connects an official MCP SDK client over Streamable HTTP using a user's Bearer token. */
export async function connectMcpHttp(port: number, token: string, sessionId?: string): Promise<DirectMcpClient> {
  const client = new Client({ name: 'reset-acceptance-client', version: '1.0.0' }, { capabilities: {} });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } });
  await client.connect(transport);
  await client.listTools();
  return {
    async call(name, args) {
      const raw = await client.callTool({ name, arguments: args });
      return checkAnswer(name, raw as Parameters<typeof checkAnswer>[1]);
    },
    async close() {
      await transport.close().catch(() => undefined);
      await client.close().catch(() => undefined);
    },
  };
}

/** Recursively hashes every regular file under `dir` keyed by sorted POSIX relative paths. */
export async function hashDirectoryFiles(dir: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  const walk = async (current: string): Promise<void> => {
    const info = await stat(current).catch(() => null);
    if (!info || !info.isDirectory()) return;
    const entries = (await readdir(current)).sort();
    for (const entry of entries) {
      const full = join(current, entry);
      const childInfo = await lstat(full);
      if (childInfo.isSymbolicLink()) continue;
      if (childInfo.isDirectory()) {
        await walk(full);
      } else if (childInfo.isFile()) {
        const bytes = await readFile(full);
        const rel = relative(dir, full).split('\\').join('/');
        hashes.set(rel, createHash('sha256').update(bytes).digest('hex'));
      }
    }
  };
  await walk(dir);
  return new Map([...hashes.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));
}

/** Captures file paths, SHA-256 digests, and encoded substrings for <dataDir>/keys and <dataDir>/vault. */
export async function snapshotVaultAndKeys(dataDir: string): Promise<VaultKeySnapshot> {
  const keys = await hashDirectoryFiles(join(dataDir, 'keys'));
  const vault = await hashDirectoryFiles(join(dataDir, 'vault'));
  const rawSubstrings = new Set<string>();
  for (const [sub, map] of [['keys', keys], ['vault', vault]] as const) {
    for (const rel of map.keys()) {
      const buf = await readFile(join(dataDir, sub, rel));
      if (buf.length >= 16) {
        const b64 = buf.toString('base64');
        if (b64.length >= 16) rawSubstrings.add(b64);
        const hex = buf.toString('hex');
        if (hex.length >= 24) rawSubstrings.add(hex);
      }
      const utf8 = buf.toString('utf8').trim();
      if (/^[A-Za-z0-9+/=_-]{16,}$/.test(utf8)) rawSubstrings.add(utf8);
      // Extract JSON-encoded sealed payload / ciphertext strings >= 16 chars from vault files.
      try {
        const parsed = JSON.parse(utf8) as Record<string, unknown>;
        for (const field of ['data', 'ciphertext', 'iv', 'tag', 'salt']) {
          const v = parsed[field];
          if (typeof v === 'string' && v.length >= 12) rawSubstrings.add(v);
        }
      } catch {
        // Raw key file or binary format; base64/hex captures covered above.
      }
    }
  }
  return { keys, vault, rawSubstrings: [...rawSubstrings] };
}

/** Asserts that every file path and SHA-256 checksum in keys/ and vault/ matches byte-for-byte. */
export async function assertVaultAndKeysUnchanged(dataDir: string, before: VaultKeySnapshot, label: string): Promise<void> {
  const after = await snapshotVaultAndKeys(dataDir);
  assert.deepEqual([...after.keys.entries()], [...before.keys.entries()], `${label}: keys/ files and SHA-256 digests must remain byte-for-byte identical`);
  assert.deepEqual([...after.vault.entries()], [...before.vault.entries()], `${label}: vault/ files and SHA-256 digests must remain byte-for-byte identical`);
}

/** Opens a short-lived superuser PostgreSQL Pool for the data root's database (or override database like postgres/archive). */
export async function withRootDb<T>(
  dataDir: string,
  fn: (pool: Pool, meta: { database: string; appUser: string; ownerUser: string }) => Promise<T>,
  databaseOverride?: string,
): Promise<T> {
  const platformContext = createContext({
    HOME: process.env.HOME,
    PATH: process.env.PATH,
    CIRCLE_HUB_DATA_DIR: dataDir,
  });
  await settingsOf(platformContext);
  const pg = postgresFor(platformContext);
  const ownerUser = userInfo().username;
  const pool = new Pool({
    host: pg.target.socketDir,
    port: pg.target.port,
    user: ownerUser,
    database: databaseOverride ?? pg.target.database,
  });
  try {
    return await fn(pool, { database: pg.target.database, appUser: pg.target.user, ownerUser });
  } finally {
    await pool.end();
  }
}

/** Returns row counts of all public tables and per-kind counts in `records` if present. */
export async function inspectDatabaseState(
  dataDir: string,
  databaseOverride?: string,
): Promise<{ tables: Record<string, number>; recordKinds: Record<string, number> }> {
  return await withRootDb(
    dataDir,
    async (pool) => {
      const tableRes = await pool.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
      );
      const tables: Record<string, number> = {};
      for (const { tablename } of tableRes.rows) {
        const quoted = `"${tablename.replaceAll('"', '""')}"`;
        const countRes = await pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${quoted}`);
        tables[tablename] = Number(countRes.rows[0]?.n ?? '0');
      }
      const recordKinds: Record<string, number> = {};
      if (Object.hasOwn(tables, 'records')) {
        const kindRes = await pool.query<{ kind: string; n: string }>(
          'SELECT kind, count(*)::text AS n FROM records GROUP BY kind ORDER BY kind',
        );
        for (const row of kindRes.rows) recordKinds[row.kind] = Number(row.n);
      }
      return { tables, recordKinds };
    },
    databaseOverride,
  );
}

/** Reads secret digest/hash values stored in DB users/tokens tables to ensure exports never leak them. */
export async function extractDbAuthHashes(dataDir: string): Promise<string[]> {
  return await withRootDb(dataDir, async (pool) => {
    const colRes = await pool.query<{ table_name: string; column_name: string }>(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('users', 'tokens') AND (column_name LIKE '%hash%' OR column_name LIKE '%password%' OR column_name LIKE '%secret%' OR column_name LIKE '%digest%' OR column_name LIKE '%salt%' OR column_name LIKE '%sha256%')",
    );
    const values = new Set<string>();
    for (const row of colRes.rows) {
      const t = `"${row.table_name.replaceAll('"', '""')}"`;
      const c = `"${row.column_name.replaceAll('"', '""')}"`;
      const res = await pool.query<{ v: string | null }>(`SELECT ${c}::text AS v FROM ${t} WHERE ${c} IS NOT NULL`);
      for (const item of res.rows) {
        if (item.v && item.v.length >= 12) values.add(item.v);
      }
    }
    return [...values];
  });
}

/** Reads an embedded pack's manifest id and version from the repository packs directory. */
async function readRepoPackMeta(relDir: string): Promise<{ id: string; version: string; dir: string }> {
  const dir = resolve(REPO_ROOT, relDir);
  const raw = JSON.parse(await readFile(join(dir, 'pack.json'), 'utf8')) as { id: string; version: string };
  return { id: raw.id, version: raw.version, dir };
}

/** Creates a minimal clean temporary workflow pack directory for overlay/published pack checks. */
async function writeSyntheticOverlayPack(parentDir: string, packId: string): Promise<string> {
  const dir = join(parentDir, packId);
  await mkdir(join(dir, 'functions'), { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `# ${packId}\n合成辅助工作流说明。\n`, 'utf8');
  await writeFile(
    join(dir, 'slots.schema.json'),
    JSON.stringify({ schema: 'slots@1', item: {}, run: {} }, null, 2),
  );
  await writeFile(
    join(dir, 'checks.json'),
    JSON.stringify({ schema: 'checks@1', checks: [] }, null, 2),
  );
  await writeFile(
    join(dir, 'requirements.json'),
    JSON.stringify({ schema: 'requirements@1', requirements: [] }, null, 2),
  );
  await writeFile(
    join(dir, 'functions', 'project.ts'),
    [
      'export default function project(): { items: unknown[]; groups: unknown[]; warnings: unknown[] } {',
      '  return { items: [], groups: [], warnings: [] };',
      '}',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(dir, 'workflow.json'),
    JSON.stringify({
      schema: 'workflow@1',
      inputs: [
        {
          slot: 'defect',
          role: 'subject',
          description: '合成缺陷输入',
          accepts: ['plm:bug'],
          required: false,
          many: false,
        },
      ],
      parameters: [],
      product: { catalogs: [] },
      subject: 'defect',
      projection: { module: 'functions/project.ts' },
    }, null, 2),
  );
  const trackedFiles = [
    'SKILL.md',
    'checks.json',
    'functions/project.ts',
    'requirements.json',
    'slots.schema.json',
    'workflow.json',
  ];
  const entries = await Promise.all(
    trackedFiles.map(async (rel) => {
      const buf = await readFile(join(dir, rel));
      return { path: rel, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length };
    }),
  );
  await writeFile(
    join(dir, 'pack.json'),
    JSON.stringify({
      schema: 'pack@1',
      id: packId,
      version: '0.1.0',
      kind: 'workflow',
      title: '合成附加工作流',
      description: '用于验收初始化与包重建的合成工作流包',
      files: entries,
    }, null, 2),
  );
  return dir;
}

/** Extracts any printed initial passwords or reset codes cleanly from CLI output. */
function collectPasswordTokens(output: string, bucket: string[]): void {
  for (const line of output.split('\n')) {
    const match = /(?:初始密码|密码|password)[：:\s]+([^\s]+)/i.exec(line);
    if (match?.[1] && match[1].length >= 6) bucket.push(match[1]);
  }
}

/** Builds a rich realistic synthetic Hub covering every config, pack, knowledge, history, and vault category. */
export async function seedRichHub(
  options: {
    canRunSandboxedPacks?: boolean;
    includeHistoryAndKnowledge?: boolean;
    includeHistory?: boolean;
    includeKnowledge?: boolean;
  } = {},
): Promise<{ root: string; state: SeededHubState }> {
  const { root, dataDir, scratchHome } = await createShortTempRoot('ch-acc-');
  const port = await allocateLoopbackPort();
  try {
    await runCli(dataDir, ['init', '--environment', 'test', '--port', String(port)], { scratchHome, expectOk: true });
    await runCli(dataDir, ['key', 'init'], { expectOk: true });
    await runCli(dataDir, ['serve', '--migrate-only'], { expectOk: true, timeoutMs: 30_000 });
    const adminInitRes = await runCli(dataDir, ['init-admin', 'admin', '--password-stdin'], {
      stdin: `${SYNTHETIC_ADMIN_PASS}\n`,
      expectOk: true,
    });

    const userPasswords: string[] = [];
    collectPasswordTokens(adminInitRes.combined, userPasswords);

    const aliceCreate = await runCli(dataDir, ['user', 'create', 'alice'], { expectOk: true });
    collectPasswordTokens(aliceCreate.combined, userPasswords);
    const alicePwReset = await runCli(dataDir, ['user', 'password-reset', 'alice'], { expectOk: true });
    collectPasswordTokens(alicePwReset.combined, userPasswords);

    const bobCreate = await runCli(dataDir, ['user', 'create', 'bob'], { expectOk: true });
    collectPasswordTokens(bobCreate.combined, userPasswords);
    await runCli(dataDir, ['user', 'disable', 'bob'], { expectOk: true });

    const aliceTokenRes = await runCli(dataDir, ['token', 'issue', 'alice', '--label', 'synth-alice-mcp', '--raw'], { expectOk: true });
    const aliceToken = aliceTokenRes.stdout.trim();
    assert.ok(aliceToken.length >= 16, 'issued alice MCP token must be non-empty');

    const userListRes = await runCli(dataDir, ['user', 'list', '--json'], { expectOk: true });
    const users = JSON.parse(userListRes.stdout) as Array<{ id: string; name: string; role: string; disabled?: boolean }>;
    const adminRow = users.find((u) => u.name === 'admin');
    const aliceRow = users.find((u) => u.name === 'alice');
    const bobRow = users.find((u) => u.name === 'bob');
    assert.ok(adminRow && aliceRow && bobRow, `expected admin, alice, bob in user list: ${userListRes.stdout}`);

    const teamAlphaRes = await runCli(dataDir, ['team', 'create', '研发测试组'], { expectOk: true });
    const teamAlphaId = /tm_[0-7][0-9a-hjkmnp-tv-z]{25}/.exec(teamAlphaRes.combined)?.[0] ?? '';
    assert.ok(teamAlphaId.length > 0, `expected TeamId from team create: ${teamAlphaRes.combined}`);
    await runCli(dataDir, ['team', 'add', teamAlphaId, 'alice'], { expectOk: true });

    const teamBetaRes = await runCli(dataDir, ['team', 'create', '辅助观测组'], { expectOk: true });
    const teamBetaId = /tm_[0-7][0-9a-hjkmnp-tv-z]{25}/.exec(teamBetaRes.combined)?.[0] ?? '';
    assert.ok(teamBetaId.length > 0, `expected second TeamId from team create: ${teamBetaRes.combined}`);
    await runCli(dataDir, ['team', 'add', teamBetaId, 'admin'], { expectOk: true });

    await runCli(dataDir, ['pack', 'grant-publish', 'admin'], { expectOk: true });

    const skillMeta = await readRepoPackMeta('packs/skill/mindmap-format');
    const productMeta = await readRepoPackMeta('packs/product/lumen-api');
    const systemMeta = await readRepoPackMeta('packs/system/plm');
    const workflowMeta = await readRepoPackMeta('packs/workflow/test-bed');

    await runCli(dataDir, ['pack', 'publish', skillMeta.dir, '--stage'], { expectOk: true });
    await runCli(dataDir, ['pack', 'install', `${skillMeta.id}@${skillMeta.version}`], { expectOk: true });

    await runCli(dataDir, ['pack', 'publish', productMeta.dir, '--stage'], { expectOk: true });
    await runCli(dataDir, ['pack', 'activate', productMeta.id], { expectOk: true });

    await runCli(dataDir, ['pack', 'publish', systemMeta.dir, '--stage'], { expectOk: true });
    await runCli(dataDir, ['pack', 'publish', workflowMeta.dir, '--stage'], { expectOk: true });

    const overlayPackId = 'synth-overlay-flow';
    const overlayDir = await writeSyntheticOverlayPack(scratchHome, overlayPackId);
    await runCli(dataDir, ['pack', 'publish', overlayDir, '--stage'], { expectOk: true });

    await runCli(dataDir, ['pack', 'assign', workflowMeta.id, `--team=${teamAlphaId}`], { expectOk: true });
    await runCli(dataDir, ['pack', 'assign', 'alice', workflowMeta.id], { expectOk: true });

    const canaries: SeededCanaries = {
      adminPassword: SYNTHETIC_ADMIN_PASS,
      userPasswords,
      aliceToken,
      plmUserSecret: 'CANARY_PLM_USER_SECRET_XYZ_111',
      plmPassSecret: 'CANARY_PLM_PASS_SECRET_XYZ_222',
      execSecret: 'CANARY_EXEC_TOKEN_SECRET_XYZ_333',
      varSecret: 'CANARY_VAR_SECRET_XYZ_444',
      extraSecret: 'CANARY_STANDALONE_SECRET_XYZ_555',
    };

    const resAdd = await runCli(dataDir, [
      'resource', 'add', systemMeta.id,
      '--name', 'synth-plm',
      '--environment', 'test',
      '--origin', `plm-oauth=${RFC5737_PLM_OAUTH}`,
      '--origin', `plm-api=${RFC5737_PLM_API}`,
      '--allow-plaintext', 'plm-oauth',
      '--allow-plaintext', 'plm-api',
      '--credential', 'username=SYNTH_PLM_USER',
      '--credential', 'password=SYNTH_PLM_PASS',
      '--setting', 'mode=synthetic',
    ], { expectOk: true });
    const plmResourceId = /res_[0-9a-hjkmnp-tv-z]{26}/.exec(resAdd.combined)?.[0] ?? '';
    assert.ok(plmResourceId.length > 0, `expected ResourceId from resource add: ${resAdd.combined}`);

    await runCli(dataDir, ['secret', 'set', '--name', 'SYNTH_PLM_USER', '--reason', 'synthetic resource user secret'], {
      stdin: `${canaries.plmUserSecret}\n`,
      expectOk: true,
    });
    await runCli(dataDir, ['secret', 'set', '--name', 'SYNTH_PLM_PASS', '--digest', 'SYNTH_PLM_PASS=sha512_base64', '--reason', 'synthetic resource password secret'], {
      stdin: `${canaries.plmPassSecret}\n`,
      expectOk: true,
    });
    await runCli(dataDir, ['resource', 'assign', plmResourceId, `--team=${teamAlphaId}`], { expectOk: true });

    const execDefPath = join(scratchHome, 'synth-executor.json');
    const execDef = {
      ...baseExecutorDefinition(LOOPBACK_EXEC_ENDPOINT),
      target: 'synthetic-bed',
      credential: '${secret:SYNTH_EXEC_TOKEN}',
    };
    await writeFile(execDefPath, JSON.stringify(execDef, null, 2), 'utf8');
    await runCli(dataDir, ['executor', 'add', execDefPath, '--name=synthetic-reset-runner'], { expectOk: true });
    await runCli(dataDir, ['secret', 'set', '--name', 'SYNTH_EXEC_TOKEN', '--reason', 'synthetic executor token'], {
      stdin: `${canaries.execSecret}\n`,
      expectOk: true,
    });

    // Standalone vault secrets (verifies post-C12 secret vault entry independent of consumers).
    await runCli(dataDir, ['secret', 'set', '--name', 'SYNTH_STANDALONE_SECRET', '--reason', 'synthetic standalone vault check'], {
      stdin: `${canaries.extraSecret}\n`,
      expectOk: true,
    });
    await runCli(dataDir, ['secret', 'set', '--name', 'SYNTH_EXTRA_VAULT_SECRET', '--reason', 'synthetic second vault secret check'], {
      stdin: `${canaries.varSecret}\n`,
      expectOk: true,
    });

    const plainVarName = 'SYNTH_PLAIN_VAR';
    const plainVarValue = 'synthetic-var-value-v1';
    const secretVarName = 'SYNTH_BUILD_LABEL';
    const buildLabelValue = 'ordinary-build-label-v1';
    await runCli(dataDir, ['var', 'set', plainVarName, '--not-secret', '--text', '--reason', 'synthetic plain variable'], {
      stdin: plainVarValue,
      expectOk: true,
    });
    await runCli(dataDir, ['var', 'set', secretVarName, '--not-secret', '--text', '--reason', 'synthetic build label ordinary variable'], {
      stdin: buildLabelValue,
      expectOk: true,
    });

    const docBedName = 'bed-topology';
    const bedTopologyPath = resolve(REPO_ROOT, 'packs/workflow/test-bed/examples/bed-topology.json');
    const bedBytes = await readFile(bedTopologyPath);
    const docBedSha256 = createHash('sha256').update(bedBytes).digest('hex');
    await runCli(dataDir, ['doc', 'put', docBedName, bedTopologyPath], { expectOk: true });

    const docNoteName = 'synth-run-note';
    const docNoteText = '合成命名文档正文-utf8-字节校验-20261113\n第二行用于核对 SHA-256 一致性\n';
    const docNoteBytes = Buffer.from(docNoteText, 'utf8');
    const docNoteSha256 = createHash('sha256').update(docNoteBytes).digest('hex');
    const docNotePath = join(scratchHome, 'synth-run-note.txt');
    await writeFile(docNotePath, docNoteBytes);
    await runCli(dataDir, ['doc', 'put', docNoteName, docNotePath], { expectOk: true });

    const state: SeededHubState = {
      dataDir,
      scratchHome,
      port,
      teamAlphaId,
      teamBetaId,
      plmResourceId,
      aliceId: aliceRow.id,
      bobId: bobRow.id,
      adminId: adminRow.id,
      skillRef: `${skillMeta.id}@${skillMeta.version}`,
      productId: productMeta.id,
      workflowId: workflowMeta.id,
      executorTarget: execDef.target,
      plainVarName,
      plainVarValue,
      secretVarName,
      docBedName,
      docBedSha256,
      docNoteName,
      docNoteText,
      docNoteSha256,
      overlayPackId,
      canaries,
      seededRunsCount: 0,
      canRunSandboxedPacks: options.canRunSandboxedPacks ?? false,
    };

    const includeAll = options.includeHistoryAndKnowledge !== false;
    const includeHistory = options.includeHistory ?? includeAll;
    const includeKnowledge = options.includeKnowledge ?? includeAll;
    if (includeHistory || includeKnowledge) {
      await seedHistoryAndKnowledgeViaMcp(state, { includeHistory, includeKnowledge });
    }

    return { root, state };
  } catch (err) {
    await teardownRoot(root, dataDir);
    throw err;
  }
}

/** Populates MCP history (uploads, runs, bookings, call logs) and knowledge space/memory records via live serve. */
export async function seedHistoryAndKnowledgeViaMcp(
  state: SeededHubState,
  modes: { includeHistory?: boolean; includeKnowledge?: boolean } = {},
): Promise<void> {
  const withHistory = modes.includeHistory ?? true;
  const withKnowledge = modes.includeKnowledge ?? true;
  const serve = await spawnServe(state.dataDir, state.port, { scratchHome: state.scratchHome });
  let mcp: DirectMcpClient | undefined;
  try {
    mcp = await connectMcpHttp(state.port, state.canaries.aliceToken, 'sess-seed-reset');

    if (withHistory) {
      // 1. Upload an ordinary artifact -> creates source_artifact + objects/ blob + call_log.
      const runInputBytes = Buffer.from('合成运行附件原文：用于核对 history/objects/artifacts 清除边界\n', 'utf8');
      const uploadRun = await mcp.call('upload_file', {
        file_path: runInputBytes.toString('base64'),
        name: 'synth-run-artifact.txt',
        media_type: 'text/plain',
      });
      assert.equal(uploadRun.out.acceptance, 'accepted', uploadRun.text);
      state.runArtifactSha256 = uploadRun.out.sha256;
      state.runArtifactRef = uploadRun.out.reference;
    }

    if (withKnowledge) {
      // 2. Import a personal knowledge space original -> creates knowledge_space_source + objects/ blob.
      const knowSourceText = '合成知识原件正文：唯一可核查条款 X-42 仅在知识空间保留';
      const uploadKnowledge = await mcp.call('upload_file', {
        file_path: Buffer.from(knowSourceText, 'utf8').toString('base64'),
        space: 'personal',
        name: 'synth-knowledge-source.txt',
        media_type: 'text/plain',
      });
      assert.equal(uploadKnowledge.out.acceptance, 'accepted', uploadKnowledge.text);
      state.knowledgeOriginalSha256 = uploadKnowledge.out.sha256;

      // 3. Write a personal knowledge entry grounded on the imported original.
      const writeEntry = await mcp.call('upload_file', {
        personal_entry: {
          kind: 'observation',
          statement: '合成个人知识条目：重置知识范围应清除本条',
          grounds: [{ reference: `src:${state.knowledgeOriginalSha256}`, quotation: '唯一可核查条款 X-42' }],
          path: '/合成知识',
        },
      });
      assert.equal(writeEntry.isError, false, writeEntry.text);
      state.knowledgeEntryRef = writeEntry.out.personal_entry?.reference;

      // 4. Write a personal memory preference document.
      const memWrite = await mcp.call('upload_file', {
        memory: {
          client_key: 'synth-reset-mem-1',
          expected_version: null,
          title: '合成测试偏好',
          markdown: '合成个人偏好正文：用于检验 knowledge 清理范围。',
          path: '/',
        },
      });
      assert.equal(memWrite.isError, false, memWrite.text);
      state.memoryDocId = memWrite.out.memory_write?.document;
    }

    if (withHistory) {
      // 5. Read pack docs + call logs -> adds call_logs.
      const listed = await mcp.call('list_task_packs', {});
      assert.equal(listed.isError, false, listed.text);
      const nodes = await mcp.call('get_nodes', { pack: state.workflowId });
      assert.equal(nodes.isError, false, nodes.text);
    }
    if (withKnowledge) {
      const personalNodes = await mcp.call('get_nodes', { scope: 'personal', search: '合成' });
      assert.equal(personalNodes.isError, false, personalNodes.text);
    }

    // 6. When OS pack-function sandbox is available, run test-bed facts + acquire (creates real runs + booking lease).
    if (withHistory && state.canRunSandboxedPacks) {
      const factsRun = await mcp.call('start_run', {
        pack: state.workflowId,
        inputs: { inventory: { external: `doc:doc:${state.docBedName}` } },
        parameters: { action: 'facts' },
      });
      assert.equal(factsRun.isError, false, factsRun.text);
      assert.ok(factsRun.out.run?.run, 'test-bed facts run must produce run id');
      state.seededRunsCount += 1;

      const acquireRun = await mcp.call('start_run', {
        pack: state.workflowId,
        inputs: { inventory: { external: `doc:doc:${state.docBedName}` } },
        parameters: {
          action: 'acquire',
          bed: 'bed-a',
          need: { devices: [{ type: 'load-balancer', count: 1 }, { type: 'client', count: 1 }] },
        },
      });
      assert.equal(acquireRun.isError, false, acquireRun.text);
      assert.ok(acquireRun.out.run?.run, 'test-bed acquire run must produce run id');
      state.seededRunsCount += 1;
    }
  } finally {
    await mcp?.close().catch(() => undefined);
    await serve.stop();
  }
}

/** Parses ResetReport fields or CLI report text for archive location, backup dir, and scope counts. */
export function parseResetCliReport(res: CliResult): {
  json: Record<string, unknown> | null;
  archive: string | undefined;
  backup: string | undefined;
  counts: Array<{ scope: ResetScope; retained: number; cleared: number }>;
} {
  let parsed: Record<string, unknown> | null = null;
  const trimmed = res.stdout.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      parsed = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      parsed = null;
    }
  }
  if (parsed && typeof parsed.archive === 'string' && typeof parsed.backup === 'string' && Array.isArray(parsed.counts)) {
    return {
      json: parsed,
      archive: parsed.archive,
      backup: parsed.backup,
      counts: parsed.counts as Array<{ scope: ResetScope; retained: number; cleared: number }>,
    };
  }
  const archiveMatch = /(?:归档|archive)[^\n：:]*[：:\s]+([^\s\n；;,]+)/i.exec(res.combined);
  const backupMatch = /(?:备份|backup)[^\n：:]*[：:\s]+([^\s\n；;,]+)/i.exec(res.combined);
  const counts: Array<{ scope: ResetScope; retained: number; cleared: number }> = [];
  for (const scope of RESET_SCOPE) {
    if (new RegExp(`\\b${scope}\\b`).test(res.combined)) {
      counts.push({ scope, retained: 0, cleared: 0 });
    }
  }
  return {
    json: parsed,
    archive: archiveMatch?.[1],
    backup: backupMatch?.[1],
    counts,
  };
}

/** Verifies backup readability + verifyBackup() + archive DB/dir presence & readability after a reset run. */
export async function assertBackupAndArchivePreserved(
  dataDir: string,
  res: CliResult,
  expectedScopes: readonly ResetScope[],
  expectArchivedRuns: boolean,
): Promise<{ archive: string; backup: string; issues: string[] }> {
  const report = parseResetCliReport(res);
  assert.ok(report.backup && report.backup.length > 0, `reset output must report backup path:\n${res.combined}`);
  assert.ok(report.archive && report.archive.length > 0, `reset output must report archive location:\n${res.combined}`);
  const issues: string[] = [];

  // 1. Pre-reset backup exists on disk, is readable, and contains manifest.json + dump; check verifyBackup() conformance.
  const backupStat = await stat(report.backup);
  assert.ok(backupStat.isDirectory(), `backup path must be a readable directory: ${report.backup}`);
  const manifestRaw = await readFile(join(report.backup, 'manifest.json'), 'utf8');
  const dumpStat = await stat(join(report.backup, 'database.dump'));
  assert.ok(dumpStat.size > 0, `reset backup database.dump must be non-empty: ${report.backup}`);
  try {
    const manifest = await verifyBackup(report.backup);
    assert.equal(manifest.schema, BACKUP_SCHEMA);
    assert.ok(manifest.files.length > 0, `verified backup manifest in ${report.backup} must list files`);
  } catch (err) {
    issues.push(
      `backup manifest at ${report.backup} failed verifyBackup() (${BACKUP_SCHEMA}): ${err instanceof Error ? err.message : String(err)}; manifest.json=${manifestRaw.slice(0, 400)}`,
    );
  }

  // 2. Old data archive is preserved and readable (either archive database in pg_database or readable archive directory).
  let archiveVerified = false;
  if (report.archive.includes('/')) {
    const archStat = await stat(report.archive);
    assert.ok(archStat.isDirectory() || archStat.isFile(), `archive path must exist and be readable: ${report.archive}`);
    if (archStat.isDirectory()) {
      const entries = await readdir(report.archive);
      assert.ok(entries.length > 0, `archive directory ${report.archive} must contain archived files`);
    }
    archiveVerified = true;
  }
  const dbRows = await withRootDb(
    dataDir,
    async (pool) =>
      (
        await pool.query<{ datname: string; datallowconn: boolean; bytes: string }>(
          'SELECT datname, datallowconn, pg_database_size(datname)::text AS bytes FROM pg_database WHERE datname = $1',
          [report.archive],
        )
      ).rows,
    'postgres',
  );
  if (dbRows.length === 1) {
    const dbRow = dbRows[0];
    if (dbRow.datallowconn) {
      const archInspect = await inspectDatabaseState(dataDir, report.archive);
      const totalRows = Object.values(archInspect.tables).reduce((a, b) => a + b, 0);
      assert.ok(totalRows > 0, `archive database ${report.archive} must still be readable with archived rows`);
      if (expectArchivedRuns && Object.hasOwn(archInspect.recordKinds, 'run')) {
        assert.ok(archInspect.recordKinds.run > 0, `archive database ${report.archive} must retain pre-reset run records`);
      }
    } else {
      assert.ok(Number(dbRow.bytes) > 0, `locked archive database ${report.archive} must retain non-zero PG storage`);
    }
    archiveVerified = true;
  }
  assert.ok(archiveVerified, `archive ${report.archive} could not be verified as a readable directory or PostgreSQL database`);

  // 3. Report explicitly identifies per-category counts / scope breakdown.
  if (report.json && Array.isArray(report.json.counts)) {
    for (const scope of expectedScopes) {
      const entry = report.counts.find((c) => c.scope === scope);
      assert.ok(entry, `reset report counts missing scope '${scope}': ${JSON.stringify(report.json)}`);
      assert.equal(typeof entry.cleared, 'number');
      assert.equal(typeof entry.retained, 'number');
    }
  } else {
    for (const scope of expectedScopes) {
      const hasWord = res.combined.includes(scope) || res.combined.includes(RESET_SCOPE_LABEL[scope]);
      assert.ok(hasWord, `reset output should explicitly report count/status for scope '${scope}' (${RESET_SCOPE_LABEL[scope]}):\n${res.combined}`);
    }
  }

  return { archive: report.archive, backup: report.backup, issues };
}

/** Verifies every object file digest exists cleanly on disk inside <dataDir>/objects. */
export async function objectExistsOnDisk(dataDir: string, sha256: string): Promise<boolean> {
  const path = join(dataDir, 'objects', sha256.slice(0, 2), sha256);
  return await stat(path).then((s) => s.isFile()).catch(() => false);
}

/** Simple cookie jar for console & rebuild HTTP flows without assuming exact cookie names. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  absorb(reply: HttpReply): void {
    const raw = ([] as string[]).concat(reply.headers['set-cookie'] ?? []);
    for (const header of raw) {
      const pair = header.split(';')[0] ?? '';
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const val = pair.slice(eq + 1).trim();
      if (val === '') this.cookies.delete(name);
      else this.cookies.set(name, val);
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  size(): number {
    return this.cookies.size;
  }
}

/** Extracts hidden input value from HTML regardless of attribute ordering. */
export function extractFormInputValue(html: string, fieldName: string): string | undefined {
  for (const tag of html.matchAll(/<input\b[^>]*>/gi)) {
    const t = tag[0];
    if (new RegExp(`\\bname=["']${fieldName}["']`).test(t)) {
      const m = /\bvalue=["']([^"']*)["']/.exec(t);
      if (m) return m[1];
    }
  }
  return undefined;
}
