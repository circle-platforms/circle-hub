import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, rename, rm, rmdir, stat, utimes } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import type { ProtocolCode } from '../../contracts/generated/protocol-codes.ts';
import { isSha256 } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { authenticateAccessOnly, botError, canAccessBot, requireDirectAccessBearer, sendBotJson } from './access-auth.ts';
import { setCommonHeaders } from './http.ts';

export const fileLimit = 100 * 1024 * 1024;
export const MAX_MEMBER_BOT_BYTES = 512 * 1024 * 1024;
export const MAX_MEMBER_BOT_FILES = 256;
export const BOT_FILE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_BOT_TEMP_MAX_AGE_MS = 15 * 60 * 1000;

export const fileDescriptor = z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  size: z.number().int().min(0).max(fileLimit),
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^/\\\p{Cc}]+$/u)
    .refine((x) => x !== '.' && x !== '..'),
});
export const botFilesPath = '/api/bot/v1/files/';
export type BotFile = z.infer<typeof fileDescriptor>;

type BotFileScope = 'files' | 'channel-staging';
type QuotaReservation = { files: number; bytes: number };

const quotaLocks = new Map<string, Promise<void>>();
const quotaInFlight = new Map<string, QuotaReservation>();

const ownerHash = (owner: string) => createHash('sha256').update(owner).digest('hex');

const folder = (root: string, owner: string, scope: BotFileScope = 'files') =>
  join(root, 'bot-runtime', scope, ownerHash(owner));

function quotaLockKey(root: string, scope: BotFileScope, ownerKey: string): string {
  return `${resolve(root)}\0${scope}\0${ownerKey}`;
}

async function withQuotaLock<T>(
  root: string,
  scope: BotFileScope,
  ownerKey: string,
  fn: (key: string) => Promise<T>,
): Promise<T> {
  const key = quotaLockKey(root, scope, ownerKey);
  const prev = quotaLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  const tail = prev.then(
    () => gate,
    () => gate,
  );
  quotaLocks.set(key, tail);
  await prev.catch(() => undefined);
  try {
    return await fn(key);
  } finally {
    release();
    if (quotaLocks.get(key) === tail) quotaLocks.delete(key);
  }
}

function addInFlight(key: string, delta: QuotaReservation): void {
  if (delta.files === 0 && delta.bytes === 0) return;
  const current = quotaInFlight.get(key) ?? { files: 0, bytes: 0 };
  quotaInFlight.set(key, {
    files: current.files + delta.files,
    bytes: current.bytes + delta.bytes,
  });
}

function subtractInFlight(key: string, delta: QuotaReservation): void {
  if (delta.files === 0 && delta.bytes === 0) return;
  const current = quotaInFlight.get(key);
  if (!current) return;
  const nextFiles = current.files - delta.files;
  const nextBytes = current.bytes - delta.bytes;
  if (nextFiles <= 0 && nextBytes <= 0) quotaInFlight.delete(key);
  else quotaInFlight.set(key, { files: Math.max(0, nextFiles), bytes: Math.max(0, nextBytes) });
}

export async function ensureBotRuntimeDir(dataDir: string): Promise<void> {
  if (typeof dataDir !== 'string' || dataDir.length === 0) return;
  const runtimeDir = join(dataDir, 'bot-runtime');
  try {
    await lstat(runtimeDir);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(runtimeDir, { recursive: true, mode: 0o700 });
}

export type BotRuntimeDirInspection =
  | { ok: true; path: string }
  | { ok: false; path: string; reason: string; missing: boolean };

export async function inspectBotRuntimeDir(dataDir: string): Promise<BotRuntimeDirInspection> {
  const runtimeDir = join(dataDir, 'bot-runtime');
  let info;
  try {
    info = await lstat(runtimeDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, path: runtimeDir, reason: '不存在', missing: true };
    }
    return {
      ok: false,
      path: runtimeDir,
      reason: `读取状态失败（${(error as NodeJS.ErrnoException).code ?? 'ERROR'}）`,
      missing: false,
    };
  }
  if (info.isSymbolicLink()) {
    return { ok: false, path: runtimeDir, reason: '是符号链接', missing: false };
  }
  if (!info.isDirectory()) {
    return { ok: false, path: runtimeDir, reason: '不是普通目录', missing: false };
  }
  const mode = info.mode & 0o777;
  if (mode !== 0o700) {
    return {
      ok: false,
      path: runtimeDir,
      reason: `权限为 0${mode.toString(8).padStart(3, '0')}（须为 0700）`,
      missing: false,
    };
  }
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
    return { ok: false, path: runtimeDir, reason: '属主不匹配', missing: false };
  }
  return { ok: true, path: runtimeDir };
}

export interface VerifiedFileOptions {
  now?: number;
  retentionMs?: number;
}

async function verifyFileInDir(
  dir: string,
  sha: string,
  size?: number,
  options?: VerifiedFileOptions,
) {
  if (!isSha256(sha)) return null;
  const handle = await open(join(dir, sha), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > fileLimit || (size !== undefined && size !== info.size)) {
      await handle.close();
      return null;
    }
    if (options?.now !== undefined) {
      const retentionMs = options.retentionMs ?? BOT_FILE_RETENTION_MS;
      if (options.now - info.mtimeMs >= retentionMs) {
        await handle.close();
        return null;
      }
    }
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) digest.update(chunk);
    if (digest.digest('hex') !== sha) {
      await handle.close();
      return null;
    }
    return { handle, size: info.size };
  } catch {
    await handle.close();
    return null;
  }
}

export async function verifiedBotFile(
  root: string,
  owner: string,
  sha: string,
  size?: number,
  options?: VerifiedFileOptions,
) {
  return verifyFileInDir(folder(root, owner, 'files'), sha, size, options);
}

export async function validateBotFiles(
  root: string,
  owner: string,
  files: BotFile[],
  options?: VerifiedFileOptions,
): Promise<boolean> {
  for (const file of files) {
    const got = await verifiedBotFile(root, owner, file.sha256, file.size, options);
    if (!got) return false;
    await got.handle.close();
  }
  return true;
}

async function pruneAndMeasureDir(
  dir: string,
  nowMs: number,
  retentionMs: number,
  options: { create?: boolean } = {},
): Promise<{ count: number; bytes: number }> {
  if (options.create !== false) {
    await mkdir(dir, { mode: 0o700, recursive: true });
  }
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  let count = 0;
  let bytes = 0;
  for (const entry of entries) {
    if (!isSha256(entry.name)) continue;
    const entryPath = join(dir, entry.name);
    const info = await stat(entryPath).catch(() => null);
    if (!info || !info.isFile()) continue;
    if (nowMs - info.mtimeMs >= retentionMs) {
      await rm(entryPath, { force: true });
      continue;
    }
    count += 1;
    bytes += info.size;
  }
  return { count, bytes };
}

export interface BotFileTransferOptions {
  scope?: BotFileScope;
  now?: () => number;
  maxMemberBytes?: number;
  maxMemberFiles?: number;
  retentionMs?: number;
  onBeforeQuotaLock?: () => Promise<void> | void;
  onQuotaInspected?: () => Promise<void> | void;
}

export type ChannelStagingVerifyResult =
  | {
      ok: true;
      reservation: QuotaReservation;
      release: () => Promise<void>;
    }
  | { ok: false; status: number; code: ProtocolCode; message: string };

export async function verifyChannelStagedFiles(
  root: string,
  owner: string,
  files: BotFile[],
  options: Omit<BotFileTransferOptions, 'scope'> = {},
): Promise<ChannelStagingVerifyResult> {
  if (files.length === 0) {
    return {
      ok: true,
      reservation: { files: 0, bytes: 0 },
      release: async () => undefined,
    };
  }
  const stagingDir = folder(root, owner, 'channel-staging');
  const destDir = folder(root, owner, 'files');
  const ownerKey = ownerHash(owner);
  const nowMs = options.now?.() ?? Date.now();
  const maxBytes = options.maxMemberBytes ?? MAX_MEMBER_BOT_BYTES;
  const maxFiles = options.maxMemberFiles ?? MAX_MEMBER_BOT_FILES;
  const retentionMs = options.retentionMs ?? BOT_FILE_RETENTION_MS;

  await ensureBotRuntimeDir(root).catch(() => undefined);
  const dirCheck = await inspectBotRuntimeDir(root);
  if (!dirCheck.ok) {
    return {
      ok: false,
      status: 503,
      ...botError('BOT_UPSTREAM_UNAVAILABLE', '机器人私聊附件运行目录当前不可用', '请管理员检查运行文件夹权限与类型后重试'),
    };
  }
  return withQuotaLock(root, 'files', ownerKey, async (key) => {
    for (const file of files) {
      const staged = await verifyFileInDir(stagingDir, file.sha256, file.size);
      if (!staged) {
        return {
          ok: false,
          status: 400,
          ...botError('BOT_INVALID_REQUEST', '附件尚未暂存或校验失败', '请先将附件完整上传至通道暂存区后再发送入站消息'),
        };
      }
      await staged.handle.close();
    }

    const usage = await pruneAndMeasureDir(destDir, nowMs, retentionMs);
    let pendingCount = 0;
    let pendingBytes = 0;
    const seen = new Set<string>();
    for (const file of files) {
      if (seen.has(file.sha256)) continue;
      seen.add(file.sha256);
      const existing = await verifyFileInDir(destDir, file.sha256, file.size);
      if (existing) {
        await existing.handle.close();
      } else {
        pendingCount += 1;
        pendingBytes += file.size;
      }
    }
    const inFlight = quotaInFlight.get(key) ?? { files: 0, bytes: 0 };
    if (
      usage.count + inFlight.files + pendingCount > maxFiles ||
      usage.bytes + inFlight.bytes + pendingBytes > maxBytes
    ) {
      return {
        ok: false,
        status: 413,
        ...botError('BOT_QUOTA_EXCEEDED', '机器人私聊附件存储配额已满', '请等待旧附件到期清理或释放空间后再发送'),
      };
    }
    const reservation: QuotaReservation = { files: pendingCount, bytes: pendingBytes };
    addInFlight(key, reservation);
    let released = false;
    const release = async () => {
      if (released) return;
      released = true;
      if (reservation.files === 0 && reservation.bytes === 0) return;
      await withQuotaLock(root, 'files', ownerKey, async (lockKey) => {
        subtractInFlight(lockKey, reservation);
      });
    };
    return {
      ok: true,
      reservation,
      release,
    };
  });
}

export async function commitChannelStagedFiles(
  root: string,
  owner: string,
  files: BotFile[],
  options: Omit<BotFileTransferOptions, 'scope'> & {
    reservation?: QuotaReservation;
    consumeReservation?: () => void;
  } = {},
): Promise<{ ok: true } | { ok: false; status: number; code: ProtocolCode; message: string }> {
  if (files.length === 0) {
    options.consumeReservation?.();
    return { ok: true };
  }
  const stagingDir = folder(root, owner, 'channel-staging');
  const destDir = folder(root, owner, 'files');
  const ownerKey = ownerHash(owner);
  const nowMs = options.now?.() ?? Date.now();
  const maxBytes = options.maxMemberBytes ?? MAX_MEMBER_BOT_BYTES;
  const maxFiles = options.maxMemberFiles ?? MAX_MEMBER_BOT_FILES;
  const retentionMs = options.retentionMs ?? BOT_FILE_RETENTION_MS;

  await ensureBotRuntimeDir(root).catch(() => undefined);
  const dirCheck = await inspectBotRuntimeDir(root);
  if (!dirCheck.ok) {
    return {
      ok: false,
      status: 503,
      ...botError('BOT_UPSTREAM_UNAVAILABLE', '机器人私聊附件运行目录当前不可用', '请管理员检查运行文件夹权限与类型后重试'),
    };
  }
  return withQuotaLock(root, 'files', ownerKey, async (key) => {
    try {
      const usage = await pruneAndMeasureDir(destDir, nowMs, retentionMs);
      const seen = new Set<string>();
      for (const file of files) seen.add(file.sha256);

      if (!options.reservation) {
        let missingCount = 0;
        let missingBytes = 0;
        for (const sha of seen) {
          const expected = files.find((f) => f.sha256 === sha)!;
          const already = await verifyFileInDir(destDir, sha, expected.size);
          if (already) {
            await already.handle.close();
          } else {
            missingCount += 1;
            missingBytes += expected.size;
          }
        }
        const inFlight = quotaInFlight.get(key) ?? { files: 0, bytes: 0 };
        if (
          missingCount > 0 &&
          (usage.count + inFlight.files + missingCount > maxFiles ||
            usage.bytes + inFlight.bytes + missingBytes > maxBytes)
        ) {
          return {
            ok: false,
            status: 413,
            ...botError('BOT_QUOTA_EXCEEDED', '机器人私聊附件存储配额已满', '请等待旧附件到期清理或释放空间后再发送'),
          };
        }
      }

      const timestamp = new Date(nowMs);
      for (const sha of seen) {
        const stagedPath = join(stagingDir, sha);
        const destPath = join(destDir, sha);
        const expected = files.find((f) => f.sha256 === sha)!;
        const staged = await verifyFileInDir(stagingDir, sha, expected.size);
        if (!staged) {
          const already = await verifyFileInDir(destDir, sha, expected.size);
          if (already) {
            await already.handle.utimes(timestamp, timestamp).catch(() => undefined);
            await already.handle.close();
            continue;
          }
          return {
            ok: false,
            status: 400,
            ...botError('BOT_INVALID_REQUEST', '附件尚未暂存或校验失败', '请先将附件完整上传至通道暂存区后再发送入站消息'),
          };
        }
        await staged.handle.utimes(timestamp, timestamp).catch(() => undefined);
        await staged.handle.close();
        try {
          await link(stagedPath, destPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
            await rename(stagedPath, destPath);
            continue;
          }
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const prior = await verifyFileInDir(destDir, sha, expected.size);
          if (!prior) {
            return {
              ok: false,
              status: 409,
              ...botError('BOT_CONFLICT', '已存在同摘要但内容冲突的文件', '请核对文件摘要后重新上传'),
            };
          }
          await prior.handle.utimes(timestamp, timestamp).catch(() => undefined);
          await prior.handle.close();
        }
        await rm(stagedPath, { force: true });
      }
      return { ok: true };
    } finally {
      if (options.reservation) {
        subtractInFlight(key, options.reservation);
        options.consumeReservation?.();
      }
    }
  });
}

export async function promoteChannelStagedFiles(
  root: string,
  owner: string,
  files: BotFile[],
  options: Omit<BotFileTransferOptions, 'scope'> = {},
): Promise<{ ok: true } | { ok: false; status: number; code: ProtocolCode; message: string }> {
  const verified = await verifyChannelStagedFiles(root, owner, files, options);
  if (!verified.ok) return verified;
  let consumed = false;
  try {
    return await commitChannelStagedFiles(root, owner, files, {
      ...options,
      reservation: verified.reservation,
      consumeReservation: () => {
        consumed = true;
      },
    });
  } finally {
    if (!consumed) await verified.release();
  }
}

export async function cleanupBotRuntimeTempFiles(
  dataDir: string,
  options: { maxAgeMs?: number; now?: number } = {},
): Promise<void> {
  if (typeof dataDir !== 'string' || dataDir.length === 0) return;
  const nowMs = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_BOT_TEMP_MAX_AGE_MS;

  const filesRoot = join(dataDir, 'bot-runtime', 'files');
  const memberDirs = await readdir(filesRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of memberDirs) {
    if (!entry.isDirectory()) continue;
    const memberDir = join(filesRoot, entry.name);
    const items = await readdir(memberDir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      if (!item.name.endsWith('.part')) continue;
      const fullPath = join(memberDir, item.name);
      if (maxAgeMs <= 0) {
        await rm(fullPath, { force: true });
        continue;
      }
      const info = await stat(fullPath).catch(() => null);
      if (!info || nowMs - info.mtimeMs >= maxAgeMs) {
        await rm(fullPath, { force: true });
      }
    }
  }

  const stagingRoot = join(dataDir, 'bot-runtime', 'channel-staging');
  const stagingDirs = await readdir(stagingRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of stagingDirs) {
    if (!entry.isDirectory()) continue;
    const stagingDir = join(stagingRoot, entry.name);
    const items = await readdir(stagingDir, { withFileTypes: true }).catch(() => []);
    for (const item of items) {
      const fullPath = join(stagingDir, item.name);
      if (maxAgeMs <= 0) {
        await rm(fullPath, { force: true });
        continue;
      }
      const info = await stat(fullPath).catch(() => null);
      if (!info || nowMs - info.mtimeMs >= maxAgeMs) {
        await rm(fullPath, { force: true });
      }
    }
    const remaining = await readdir(stagingDir).catch(() => []);
    if (remaining.length === 0) await rmdir(stagingDir).catch(() => undefined);
  }
}

export async function pruneExpiredBotFiles(
  dataDir: string,
  options: { now?: number; retentionMs?: number } = {},
): Promise<void> {
  if (typeof dataDir !== 'string' || dataDir.length === 0) return;
  const nowMs = options.now ?? Date.now();
  const retentionMs = options.retentionMs ?? BOT_FILE_RETENTION_MS;
  const filesRoot = join(dataDir, 'bot-runtime', 'files');
  const memberDirs = await readdir(filesRoot, { withFileTypes: true }).catch(() => []);
  for (const entry of memberDirs) {
    if (!entry.isDirectory()) continue;
    const memberDir = join(filesRoot, entry.name);
    await withQuotaLock(dataDir, 'files', entry.name, async () => {
      await pruneAndMeasureDir(memberDir, nowMs, retentionMs, { create: false });
    });
  }
}

export async function transferBotFile(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  owner: string,
  sha: string,
  stillActive: () => Promise<boolean>,
  options: BotFileTransferOptions = {},
): Promise<void> {
  const scope = options.scope ?? 'files';
  const nowMs = options.now?.() ?? Date.now();
  const retentionMs = options.retentionMs ?? BOT_FILE_RETENTION_MS;
  if (!isSha256(sha)) {
    req.resume();
    return sendBotJson(
      res,
      404,
      botError('BOT_NOT_FOUND', '文件摘要不存在或格式无效', '请提供有效的 64 位小写十六进制 SHA-256 文件摘要'),
    );
  }
  if (req.method === 'GET') {
    const dirCheck = await inspectBotRuntimeDir(root);
    if (!dirCheck.ok && !dirCheck.missing) {
      req.resume();
      return sendBotJson(
        res,
        503,
        botError('BOT_UPSTREAM_UNAVAILABLE', '机器人私聊附件运行目录当前不可用', '请管理员检查运行文件夹权限与类型后重试'),
      );
    }
    const file = await verifiedBotFile(root, owner, sha, undefined, { now: nowMs, retentionMs });
    if (!file) {
      req.resume();
      return sendBotJson(res, 404, botError('BOT_NOT_FOUND', '文件不存在或校验失败', '请核对文件摘要，若已过期请重新上传'));
    }
    try {
      if (!(await stillActive())) {
        req.resume();
        return sendBotJson(res, 401, botError('BOT_UNAUTHENTICATED'));
      }
      if (res.headersSent || res.writableEnded || res.destroyed) return;
      setCommonHeaders(res);
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': file.size,
        'content-disposition': 'attachment',
        etag: '"' + sha + '"',
      });
      await pipeline(file.handle.createReadStream({ start: 0, autoClose: false }), res);
    } finally {
      await file.handle.close();
    }
    return;
  }
  if (req.method !== 'PUT') {
    req.resume();
    return sendBotJson(
      res,
      405,
      botError('BOT_INVALID_REQUEST', '只允许 GET 或 PUT', '请改用 GET 下载或 PUT 上传文件'),
      { allow: 'GET, PUT' },
    );
  }
  const lengthHeader = req.headers['content-length'];
  if (typeof lengthHeader !== 'string' || !/^\d+$/.test(lengthHeader)) {
    req.resume();
    return sendBotJson(
      res,
      400,
      botError('BOT_INVALID_REQUEST', '需要有效的文件长度', '请在请求头中提供非负整数 Content-Length 后重试'),
    );
  }
  const declaredLength = Number(lengthHeader);
  if (!Number.isSafeInteger(declaredLength) || declaredLength > fileLimit) {
    req.resume();
    return sendBotJson(
      res,
      413,
      botError('BOT_INVALID_REQUEST', '单个文件大小超过 100 MiB 上限', '请将单个附件压缩或拆分至 100 MiB 以内后再上传'),
    );
  }
  const maxBytes = options.maxMemberBytes ?? MAX_MEMBER_BOT_BYTES;
  const maxFiles = options.maxMemberFiles ?? MAX_MEMBER_BOT_FILES;
  const ownerKey = ownerHash(owner);
  const dir = folder(root, owner, scope);
  const timestamp = new Date(nowMs);

  await ensureBotRuntimeDir(root).catch(() => undefined);
  const dirCheck = await inspectBotRuntimeDir(root);
  if (!dirCheck.ok) {
    req.resume();
    return sendBotJson(
      res,
      503,
      botError('BOT_UPSTREAM_UNAVAILABLE', '机器人私聊附件运行目录当前不可用', '请管理员检查运行文件夹权限与类型后重试'),
    );
  }
  await options.onBeforeQuotaLock?.();
  const reservationCheck = await withQuotaLock(root, scope, ownerKey, async (key) => {
    const usage = await pruneAndMeasureDir(dir, nowMs, retentionMs);
    const existing = await verifyFileInDir(dir, sha, declaredLength);
    let hasExisting = false;
    if (existing) {
      hasExisting = true;
      await existing.handle.close();
    }
    const inFlight = quotaInFlight.get(key) ?? { files: 0, bytes: 0 };
    const usedCount = hasExisting ? Math.max(0, usage.count - 1) : usage.count;
    const usedBytes = hasExisting ? Math.max(0, usage.bytes - declaredLength) : usage.bytes;
    if (
      usedCount + inFlight.files + 1 > maxFiles ||
      usedBytes + inFlight.bytes + declaredLength > maxBytes
    ) {
      return { ok: false as const };
    }
    await options.onQuotaInspected?.();
    if (hasExisting) {
      await utimes(join(dir, sha), timestamp, timestamp).catch(() => undefined);
    }
    const reservation: QuotaReservation = { files: 1, bytes: declaredLength };
    addInFlight(key, reservation);
    return { ok: true as const, reservation };
  });

  if (!reservationCheck.ok) {
    req.resume();
    return sendBotJson(
      res,
      413,
      botError('BOT_QUOTA_EXCEEDED', '机器人私聊附件存储配额已满', '请等待旧附件到期清理或释放空间后再上传'),
    );
  }

  let reserved: QuotaReservation | null = reservationCheck.reservation;
  const releaseReservation = async () => {
    if (!reserved) return;
    const toRelease = reserved;
    reserved = null;
    if (toRelease.files === 0 && toRelease.bytes === 0) return;
    await withQuotaLock(root, scope, ownerKey, async (key) => {
      subtractInFlight(key, toRelease);
    });
  };

  const temp = join(dir, randomUUID() + '.part');
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  const discardTemp = async () => {
    const active = handle;
    handle = null;
    if (active) await active.close().catch(() => undefined);
    await rm(temp, { force: true }).catch(() => undefined);
  };
  try {
    handle = await open(temp, 'wx', 0o600);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > declaredLength) {
        req.resume();
        await discardTemp();
        await releaseReservation();
        return sendBotJson(
          res,
          413,
          botError('BOT_INVALID_REQUEST', '上传内容超出声明大小', '请确保实际上传字节数与 Content-Length 一致后重试'),
          { connection: 'close' },
        );
      }
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    if (res.headersSent || res.writableEnded || res.destroyed) return;
    if (size !== declaredLength || hash.digest('hex') !== sha) {
      await discardTemp();
      await releaseReservation();
      return sendBotJson(
        res,
        422,
        botError('BOT_INVALID_REQUEST', '文件摘要或长度不一致', '请重新计算 SHA-256 与文件长度并完整上传'),
      );
    }
    if (!(await stillActive())) {
      await discardTemp();
      await releaseReservation();
      return sendBotJson(res, 401, botError('BOT_UNAUTHENTICATED'));
    }
    await handle.sync();
    await handle.utimes(timestamp, timestamp);
    let conflict = false;
    await withQuotaLock(root, scope, ownerKey, async (key) => {
      try {
        try {
          await link(temp, join(dir, sha));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const prior = await verifyFileInDir(dir, sha, size);
          if (!prior) {
            conflict = true;
            return;
          }
          await prior.handle.utimes(timestamp, timestamp).catch(() => undefined);
          await prior.handle.close();
        }
      } finally {
        if (reserved) {
          subtractInFlight(key, reserved);
          reserved = null;
        }
      }
    });
    await discardTemp();
    if (conflict) {
      return sendBotJson(res, 409, botError('BOT_CONFLICT', '已存在同摘要但内容冲突的文件', '请核对文件摘要后重新上传'));
    }
    sendBotJson(res, 200, { sha256: sha, size });
  } finally {
    await releaseReservation();
    await discardTemp();
  }
}

const botFilesDisabledBody = () =>
  botError('BOT_DISABLED', '机器人尚未启用', '请管理员在控制台配置并启用机器人模型后重试');

export async function handleBotFile(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  sha: string,
  botEnabled: () => Promise<boolean>,
): Promise<void> {
  const actor = await requireDirectAccessBearer(req, res, deps.records.principals, {
    enabled: botEnabled,
    disabledBody: botFilesDisabledBody,
  });
  if (!actor) return;
  const configured = await deps.records.vault.has('personal-bot.model');
  if (!configured) {
    req.resume();
    return sendBotJson(res, 503, botFilesDisabledBody());
  }
  return transferBotFile(
    req,
    res,
    deps.config.dataDir,
    actor.id,
    sha,
    async () => {
      const again = await authenticateAccessOnly(deps.records.principals, req.headers.authorization ?? null);
      return again.ok && again.principal.id === actor.id && canAccessBot(again);
    },
    { now: () => (deps.now?.() ?? new Date()).getTime() },
  );
}
