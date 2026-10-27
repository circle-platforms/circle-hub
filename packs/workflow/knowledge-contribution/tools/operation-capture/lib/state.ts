import { appendFile, copyFile, lstat, mkdir, open, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { constants as FS_CONSTANTS } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import { EGRESS, GENERATED } from './constants.ts';
import { canonical, exact, isRecord, need, sessionDirectory, sha256, text, validSession } from './common.ts';
import { scanWithMatches } from './credentials.ts';

export interface Settings {
  schema: 'operation-capture-settings@1';
  session: string;
  enabled: boolean;
  hub: string;
  token_file: string;
}

export interface CaptureEvent {
  schema: string;
  kind: 'capture';
  sequence: number;
  session: string;
  captured_at: string;
  tool: { name: string; status: string };
  input: { summary: string; sha256: string; truncated: boolean };
  targets: Record<string, string>;
  output: { file: string; sha256: string; size: number };
  redaction: { scanner: string; status: 'unchanged' | 'redacted'; detectors: string[] };
  previous: string | null;
  digest: string;
}

export interface UploadEvent {
  schema: string;
  kind: 'upload';
  sequence: number;
  session: string;
  uploaded_at: string;
  capture: number;
  source: { sha256: string; reference: string; artifact?: string };
  provenance_type: string;
  previous: string | null;
  digest: string;
}

export type ManifestEvent = CaptureEvent | UploadEvent;
export type VerifiedCapture = { capture: CaptureEvent; upload: UploadEvent | null };

async function directory(path: string, create: boolean): Promise<void> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path).catch(() => null);
  need(stat?.isDirectory() && !stat.isSymbolicLink(), 'invalid_state_directory', '状态目录必须是普通目录，不能是链接');
}

async function regular(path: string, missing: boolean): Promise<import('node:fs').Stats | null> {
  const stat = await lstat(path).catch(() => null);
  if (!stat && missing) return null;
  need(stat?.isFile() && !stat.isSymbolicLink() && stat.nlink === 1, 'invalid_state_file', '状态文件必须是普通单链接文件');
  return stat;
}

async function prepareSession(session: string): Promise<string> {
  const dir = sessionDirectory(session);
  await directory(join(dir, '..', '..'), true);
  await directory(join(dir, '..'), true);
  await directory(dir, true);
  return dir;
}

export async function readSettings(session: string): Promise<Settings | null> {
  const dir = sessionDirectory(session);
  const stat = await lstat(dir).catch(() => null);
  if (!stat) return null;
  need(stat.isDirectory() && !stat.isSymbolicLink(), 'invalid_state_directory', '会话状态目录无效');
  const path = join(dir, 'settings.json');
  if (!await regular(path, true)) return null;
  let value: unknown;
  try { value = JSON.parse(await readFile(path, 'utf8')); } catch { throw new Error('invalid_settings'); }
  const row = exact(value, ['schema', 'session', 'enabled', 'hub', 'token_file']);
  need(row.schema === 'operation-capture-settings@1' && row.session === session && typeof row.enabled === 'boolean', 'invalid_settings', '会话开关格式不对');
  text(row.hub, 'invalid_settings', 'Hub 地址格式不对', 2048);
  const tokenFile = text(row.token_file, 'invalid_settings', '令牌文件路径格式不对', 4096);
  need(isAbsolute(tokenFile), 'invalid_settings', '令牌文件必须使用绝对路径');
  return row as unknown as Settings;
}

async function writeSettings(settings: Settings): Promise<void> {
  const dir = await prepareSession(settings.session);
  const path = join(dir, 'settings.json');
  await regular(path, true);
  const handle = await open(path, 'w', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(settings, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function enable(session: string, hub: string, tokenFile: string): Promise<void> {
  const id = validSession(session);
  const dir = await prepareSession(id);
  await withLock(dir, () => writeSettings({ schema: 'operation-capture-settings@1', session: id, enabled: true, hub, token_file: tokenFile }));
}

export async function disable(session: string): Promise<void> {
  const id = validSession(session);
  const current = await readSettings(id);
  if (!current) return;
  await withLock(sessionDirectory(id), async () => {
    const latest = await readSettings(id);
    if (latest) await writeSettings({ ...latest, enabled: false });
  });
}

export async function logFailure(session: string, code: string): Promise<void> {
  const dir = await prepareSession(session);
  const path = join(dir, 'errors.jsonl');
  await regular(path, true);
  const safe = /^[a-z][a-z0-9_]{0,63}$/.test(code) ? code : 'internal_error';
  await appendFile(path, `${JSON.stringify({ at: new Date().toISOString(), code: safe })}\n`, { mode: 0o600 });
}

function lockOwner(path: string): string {
  return join(path, 'owner.json');
}

function staleOwner(raw: string, old: boolean): boolean {
  let owner: unknown;
  try { owner = JSON.parse(raw); } catch { return old; }
  if (!isRecord(owner) || !Number.isSafeInteger(owner.pid) || (owner.pid as number) <= 0 || typeof owner.id !== 'string' || typeof owner.at !== 'string') return old;
  try { process.kill(owner.pid as number, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}

async function staleLock(path: string): Promise<{ stale: boolean; owners: Array<{ name: string; raw: string }> }> {
  const stat = await lstat(path).catch(() => null);
  if (!stat) return { stale: false, owners: [] };
  need(stat.isDirectory() && !stat.isSymbolicLink(), 'invalid_state_directory', '锁路径不是普通目录');
  const names = await readdir(path).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (names === null) return { stale: false, owners: [] };
  need(names.every(name => name === 'owner.json' || /^\.stale-[0-9a-f-]+$/.test(name)), 'state_busy', '锁目录含其他文件，不能自动恢复');
  const old = Date.now() - stat.mtimeMs > 120_000;
  if (names.length === 0) return { stale: false, owners: [] };
  const owners: Array<{ name: string; raw: string }> = [];
  for (const name of names) {
    const file = join(path, name);
    const fileStat = await lstat(file).catch(() => null);
    if (!fileStat) return { stale: false, owners: [] };
    need(fileStat.isFile() && !fileStat.isSymbolicLink() && fileStat.nlink === 1, 'invalid_state_file', '锁所有者文件无效');
    const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (raw === null || !staleOwner(raw, old)) return { stale: false, owners: [] };
    owners.push({ name, raw });
  }
  return { stale: true, owners };
}

async function clearStaleLock(path: string): Promise<boolean> {
  const snapshot = await staleLock(path);
  if (!snapshot.stale) return false;
  const quarantined: string[] = [];
  for (const owner of snapshot.owners) {
    const quarantine = join(path, `.stale-${randomUUID()}`);
    try {
      await copyFile(join(path, owner.name), quarantine, FS_CONSTANTS.COPYFILE_EXCL);
      quarantined.push(quarantine);
      await unlink(join(path, owner.name));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  for (const [index, quarantine] of quarantined.entries()) {
    const raw = await readFile(quarantine, 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
    if (raw === null || raw !== snapshot.owners[index].raw) return false;
  }
  for (const quarantine of quarantined) await unlink(quarantine);
  try { await rmdir(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return false; throw error; }
}

export async function withLock<T>(dir: string, run: () => Promise<T>): Promise<T> {
  const path = join(dir, '.lock');
  const ownerPath = lockOwner(path);
  const id = randomUUID();
  const deadline = Date.now() + 60_000;
  let acquired = false;
  try {
    for (;;) {
      try {
        await mkdir(path, { mode: 0o700 });
        acquired = true;
        break;
      } catch (error) {
        need((error as NodeJS.ErrnoException).code === 'EEXIST', 'state_busy', '会话状态路径无效');
        if (await clearStaleLock(path)) continue;
        need(Date.now() < deadline, 'state_busy', '会话状态锁一直未释放；核对是否有采集仍在运行');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
    }
    await writeFile(ownerPath, `${JSON.stringify({ id, pid: process.pid, at: new Date().toISOString() })}\n`, { mode: 0o600, flag: 'wx' });
    return await run();
  } finally {
    if (!acquired) {
      await rmdir(path).catch(() => undefined);
    } else {
      release: for (;;) {
        const names = await readdir(path).catch(() => [] as string[]);
        for (const name of names) {
          if (name !== 'owner.json' && !name.startsWith('.stale-')) continue;
          const raw = await readFile(join(path, name), 'utf8').catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? null : Promise.reject(error));
          if (raw === null) continue release;
          const owner = JSON.parse(raw) as { id?: string };
          if (owner.id !== id) continue;
          try { await unlink(join(path, name)); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue release; throw error; }
          await rmdir(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error; });
          break release;
        }
        try { await rmdir(path); break release; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTEMPTY') break release; throw error; }
      }
    }
  }
}

function manifestPath(dir: string): string {
  return join(dir, 'manifest.jsonl');
}

function eventDigest(row: Record<string, unknown>): void {
  const digest = row.digest;
  need(typeof digest === 'string' && /^[0-9a-f]{64}$/.test(digest), 'invalid_manifest', '清单事件摘要格式不对');
  const unsigned = { ...row };
  delete unsigned.digest;
  need(sha256(canonical(unsigned)) === digest, 'manifest_tampered', '清单事件摘要不符');
}

function time(value: unknown): void {
  need(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && new Date(value).toISOString() === value, 'invalid_manifest', '清单时间格式不对');
}

function baseEvent(value: unknown, session: string, sequence: number): Record<string, unknown> {
  need(isRecord(value), 'invalid_manifest', '清单行不是对象');
  need(value.schema === GENERATED.event_schema && value.sequence === sequence && value.session === session, 'invalid_manifest', '清单事件身份或顺序不符');
  need(value.previous === null || typeof value.previous === 'string' && /^[0-9a-f]{64}$/.test(value.previous), 'invalid_manifest', '清单前序摘要格式不对');
  eventDigest(value);
  return value;
}

function captureEvent(value: unknown, session: string, sequence: number): CaptureEvent {
  const row = baseEvent(value, session, sequence);
  exact(row, ['schema', 'kind', 'sequence', 'session', 'captured_at', 'tool', 'input', 'targets', 'output', 'redaction', 'previous', 'digest']);
  need(row.kind === 'capture', 'invalid_manifest', '采集事件种类不符');
  time(row.captured_at);
  const tool = exact(row.tool, ['name', 'status']);
  text(tool.name, 'invalid_manifest', '工具名格式不对', 300);
  text(tool.status, 'invalid_manifest', '工具状态格式不对', 100);
  const input = exact(row.input, ['summary', 'sha256', 'truncated']);
  text(input.summary, 'invalid_manifest', '参数摘要格式不对', EGRESS.max_input_summary_chars + 1, true);
  need(typeof input.sha256 === 'string' && /^[0-9a-f]{64}$/.test(input.sha256) && typeof input.truncated === 'boolean', 'invalid_manifest', '参数摘要身份不符');
  need(isRecord(row.targets), 'invalid_manifest', '台架或设备字段格式不对');
  for (const [key, target] of Object.entries(row.targets)) {
    need(['bed', 'bed_id', 'device', 'device_id', 'target'].includes(key), 'invalid_manifest', '台架或设备字段不在闭集');
    text(target, 'invalid_manifest', '台架或设备标识格式不对', 1024);
  }
  const output = exact(row.output, ['file', 'sha256', 'size']);
  need(output.file === `outputs/${String(sequence).padStart(16, '0')}.txt`, 'invalid_manifest', '原件路径与事件序号不符');
  need(typeof output.sha256 === 'string' && /^[0-9a-f]{64}$/.test(output.sha256), 'invalid_manifest', '原件摘要格式不对');
  need(Number.isSafeInteger(output.size) && (output.size as number) > 0 && (output.size as number) <= EGRESS.max_capture_bytes, 'invalid_manifest', '原件大小不符');
  const redaction = exact(row.redaction, ['scanner', 'status', 'detectors']);
  need(redaction.scanner === GENERATED.scanner && ['unchanged', 'redacted'].includes(redaction.status as string), 'invalid_manifest', '脱敏记录格式不对');
  need(Array.isArray(redaction.detectors) && redaction.detectors.every(item => typeof item === 'string' && /^[a-z_]+$/.test(item)), 'invalid_manifest', '脱敏检测器记录格式不对');
  return row as unknown as CaptureEvent;
}

function uploadEvent(value: unknown, session: string, sequence: number): UploadEvent {
  const row = baseEvent(value, session, sequence);
  exact(row, ['schema', 'kind', 'sequence', 'session', 'uploaded_at', 'capture', 'source', 'provenance_type', 'previous', 'digest']);
  need(row.kind === 'upload' && row.provenance_type === GENERATED.provenance_type, 'invalid_manifest', '上传事件种类或出处不符');
  time(row.uploaded_at);
  need(Number.isSafeInteger(row.capture) && (row.capture as number) > 0 && (row.capture as number) < sequence, 'invalid_manifest', '上传对应的采集序号不符');
  need(isRecord(row.source), 'invalid_manifest', '上传来源格式不对');
  const { artifact, ...source } = row.source;
  exact(source, ['sha256', 'reference']);
  need(typeof source.sha256 === 'string' && /^[0-9a-f]{64}$/.test(source.sha256) && source.reference === `src:${source.sha256}`, 'invalid_manifest', '上传引用与原件摘要不符');
  need(artifact === undefined || typeof artifact === 'string' && /^[0-9a-f]{64}$/.test(artifact), 'invalid_manifest', '上传原件记录格式不对');
  return row as unknown as UploadEvent;
}

export async function readEvents(dir: string, session: string): Promise<ManifestEvent[]> {
  const path = manifestPath(dir);
  const stat = await regular(path, true);
  if (!stat) return [];
  need(stat.size <= EGRESS.max_manifest_bytes, 'manifest_too_large', '清单超过核验上限');
  const raw = await readFile(path, 'utf8');
  need(raw === '' || raw.endsWith('\n'), 'manifest_tampered', '清单末尾不完整；先用 recover 保全未提交尾部');
  const lines = raw === '' ? [] : raw.trimEnd().split('\n');
  const events: ManifestEvent[] = [];
  let previous: string | null = null;
  for (const [index, line] of lines.entries()) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error('invalid_manifest'); }
    need(isRecord(value) && value.previous === previous, 'manifest_tampered', '清单哈希链不连续');
    const event = value.kind === 'capture' ? captureEvent(value, session, index + 1) : value.kind === 'upload' ? uploadEvent(value, session, index + 1) : null;
    need(event, 'invalid_manifest', '清单事件种类未知');
    events.push(event);
    previous = event.digest;
  }
  return events;
}

function manifestLine(event: ManifestEvent): string {
  const line = `${JSON.stringify(event)}\n`;
  const scan = scanWithMatches(Buffer.from(line));
  need(scan.complete && scan.scan.inspected && scan.scan.clean && !scan.scan.truncated, 'metadata_credential', '元数据未通过凭据扫描');
  return line;
}

async function appendManifest(dir: string, event: ManifestEvent): Promise<void> {
  const line = manifestLine(event);
  const path = manifestPath(dir);
  await regular(path, true);
  const handle = await open(path, 'a', 0o600);
  let before: number | undefined;
  try {
    before = (await handle.stat()).size;
    await handle.writeFile(line);
    await handle.sync();
  } catch (error) {
    if (before !== undefined) {
      await handle.truncate(before);
      await handle.sync();
    }
    throw error;
  } finally {
    await handle.close();
  }
}

export async function appendCapture(dir: string, input: Omit<CaptureEvent, 'schema' | 'kind' | 'sequence' | 'previous' | 'digest' | 'output'> & { bytes: Uint8Array }): Promise<CaptureEvent> {
  const session = input.session;
  const events = await readEvents(dir, session);
  const sequence = events.length + 1;
  const previous = events.at(-1)?.digest ?? null;
  const file = `outputs/${String(sequence).padStart(16, '0')}.txt`;
  const event: CaptureEvent = {
    schema: GENERATED.event_schema,
    kind: 'capture',
    sequence,
    session,
    captured_at: input.captured_at,
    tool: input.tool,
    input: input.input,
    targets: input.targets,
    output: { file, sha256: sha256(input.bytes), size: input.bytes.byteLength },
    redaction: input.redaction,
    previous,
    digest: '',
  };
  event.digest = sha256(canonical({ ...event, digest: undefined }));
  manifestLine(event);
  await directory(join(dir, 'outputs'), true);
  let handle: import('node:fs/promises').FileHandle | undefined;
  let created = false;
  try {
    handle = await open(join(dir, file), 'wx', 0o600);
    created = true;
    await handle.writeFile(input.bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await appendManifest(dir, event);
    return event;
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    if (created) await unlink(join(dir, file)).catch(() => { throw new Error('capture_orphan'); });
    throw error;
  }
}

export async function appendUpload(dir: string, capture: CaptureEvent, receipt: string | {reference:string;artifact?:string}): Promise<UploadEvent> {
  const events = await readEvents(dir, capture.session);
  need(!events.some(event => event.kind === 'upload' && event.capture === capture.sequence), 'duplicate_upload', '该采集已经有上传回执');
  const source = typeof receipt === 'string' ? {reference:receipt} : receipt;
  const event: UploadEvent = {
    schema: GENERATED.event_schema,
    kind: 'upload',
    sequence: events.length + 1,
    session: capture.session,
    uploaded_at: new Date().toISOString(),
    capture: capture.sequence,
    source: { sha256: capture.output.sha256, ...source },
    provenance_type: GENERATED.provenance_type,
    previous: events.at(-1)?.digest ?? null,
    digest: '',
  };
  event.digest = sha256(canonical({ ...event, digest: undefined }));
  await appendManifest(dir, event);
  return event;
}

async function preserveRecovery(dir: string, kind: 'manifest_tail' | 'unregistered_output', bytes: Uint8Array, source?: string): Promise<void> {
  const recovery = join(dir, 'recovery');
  await directory(recovery, true);
  const file = `${randomUUID()}.part`;
  if (source) {
    await copyFile(source, join(recovery, file), FS_CONSTANTS.COPYFILE_EXCL);
    await unlink(source);
  } else await writeFile(join(recovery, file), bytes, { mode: 0o600, flag: 'wx' });
  const index = join(recovery, 'index.jsonl');
  await regular(index, true);
  await appendFile(index, `${JSON.stringify({ kind, file, sha256: sha256(bytes), size: bytes.byteLength, at: new Date().toISOString() })}\n`, { mode: 0o600 });
}

export async function recoveryCount(session: string): Promise<number> {
  const path = join(sessionDirectory(session), 'recovery');
  const entries = await readdir(path, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const entry of entries) if (entry.name.endsWith('.part')) need(entry.isFile() && !entry.isSymbolicLink(), 'invalid_state_file', '恢复件必须是普通文件');
  return entries.filter(entry => entry.name.endsWith('.part')).length;
}

export async function recoverCaptures(session: string): Promise<number> {
  const dir = sessionDirectory(session);
  if (!await lstat(dir).catch(() => null)) return 0;
  const lock = join(dir, '.lock');
  const lockStat = await lstat(lock).catch(() => null);
  if (lockStat) {
    need(lockStat.isDirectory() && !lockStat.isSymbolicLink(), 'invalid_state_directory', '锁路径不是普通目录');
    if (Date.now() - lockStat.mtimeMs > 120_000 && (await readdir(lock)).length === 0) await rmdir(lock);
  }
  return withLock(dir, async () => {
    let recovered = 0;
    const path = manifestPath(dir);
    const stat = await regular(path, true);
    if (stat) {
      need(stat.size <= EGRESS.max_manifest_bytes, 'manifest_too_large', '清单超过恢复上限');
      const bytes = await readFile(path);
      if (bytes.length > 0 && bytes.at(-1) !== 10) {
        const last = bytes.lastIndexOf(10);
        await preserveRecovery(dir, 'manifest_tail', bytes.subarray(last + 1));
        const handle = await open(path, 'r+');
        try { await handle.truncate(last + 1); await handle.sync(); } finally { await handle.close(); }
        recovered++;
      }
    }
    const events = await readEvents(dir, session);
    const expected = new Set(events.flatMap(event => event.kind === 'capture' ? [event.output.file.slice('outputs/'.length)] : []));
    const outputs = join(dir, 'outputs');
    if (!await lstat(outputs).catch(() => null)) return recovered;
    await directory(outputs, false);
    for (const entry of await readdir(outputs, { withFileTypes: true })) {
      need(entry.isFile() && !entry.isSymbolicLink(), 'unexpected_capture_file', '原件目录有链接或特殊文件，不能自动恢复');
      if (expected.has(entry.name)) continue;
      const path = join(outputs, entry.name);
      const stat = await regular(path, false);
      need(stat && stat.size <= EGRESS.max_capture_bytes, 'capture_too_large', '未登记输出超过恢复上限');
      const bytes = await readFile(path);
      await preserveRecovery(dir, 'unregistered_output', bytes, path);
      recovered++;
    }
    return recovered;
  });
}

export async function verifyState(session: string): Promise<VerifiedCapture[]> {
  const dir = sessionDirectory(session);
  const stat = await lstat(dir).catch(() => null);
  if (!stat) return [];
  await directory(dir, false);
  const events = await readEvents(dir, session);
  const captures = new Map<number, VerifiedCapture>();
  for (const event of events) {
    if (event.kind === 'capture') {
      need(!captures.has(event.sequence), 'manifest_tampered', '采集事件重复');
      captures.set(event.sequence, { capture: event, upload: null });
    } else {
      const capture = captures.get(event.capture);
      need(capture && !capture.upload, 'manifest_tampered', '上传事件没有唯一的前序采集');
      need(event.source.sha256 === capture.capture.output.sha256, 'manifest_tampered', '上传事件与原件摘要不符');
      capture.upload = event;
    }
  }
  const outputDirectory = join(dir, 'outputs');
  const outputStat = await lstat(outputDirectory).catch(() => null);
  if (outputStat) await directory(outputDirectory, false);
  const names = outputStat ? await readdir(outputDirectory, { withFileTypes: true }) : [];
  const expected = new Set([...captures.values()].map(row => row.capture.output.file.slice('outputs/'.length)));
  for (const entry of names) need(entry.isFile() && !entry.isSymbolicLink() && expected.has(entry.name), 'unexpected_capture_file', '原件目录有未登记或无效文件');
  need(names.length === expected.size, 'missing_capture_file', '原件目录文件数与清单不符');
  for (const row of captures.values()) {
    const path = join(dir, row.capture.output.file);
    await regular(path, false);
    const bytes = await readFile(path);
    need(sha256(bytes) === row.capture.output.sha256 && bytes.byteLength === row.capture.output.size, 'capture_tampered', '原件字节与摘要不符');
    const scan = scanWithMatches(bytes);
    need(scan.complete && scan.scan.inspected && scan.scan.clean && !scan.scan.truncated, 'capture_credential', '原件未通过凭据扫描');
  }
  return [...captures.values()];
}

export async function outputBytes(session: string, capture: CaptureEvent): Promise<Uint8Array> {
  const dir = sessionDirectory(session);
  await directory(dir, false);
  await directory(join(dir, 'outputs'), false);
  const path = join(dir, capture.output.file);
  await regular(path, false);
  const bytes = await readFile(path);
  need(sha256(bytes) === capture.output.sha256 && bytes.byteLength === capture.output.size, 'capture_tampered', '读取时原件字节已改变');
  return bytes;
}

export async function appendReceipt(session: string, receipt: unknown): Promise<void> {
  const dir = sessionDirectory(session);
  await withLock(dir, async () => {
    const path = join(dir, 'receipts.jsonl');
    await regular(path, true);
    const line = `${JSON.stringify({ at: new Date().toISOString(), receipt })}\n`;
    const scan = scanWithMatches(Buffer.from(line));
    need(scan.complete && scan.scan.inspected && scan.scan.clean && !scan.scan.truncated, 'receipt_credential', '回执未通过凭据扫描，未写本地回执');
    await appendFile(path, line, { mode: 0o600 });
  });
}
