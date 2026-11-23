import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { isSha256 } from '../records/api.ts';
import type { ServerDeps } from './api.ts';
import { requireAccessBearer, authenticateAccessOnly } from './access-auth.ts';
import { sendJson, setCommonHeaders } from './http.ts';

export const fileLimit = 100 * 1024 * 1024;
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

const folder = (root: string, owner: string) =>
  join(root, 'bot-runtime', 'files', createHash('sha256').update(owner).digest('hex'));

export async function verifiedBotFile(root: string, owner: string, sha: string, size?: number) {
  if (!isSha256(sha)) return null;
  const handle = await open(join(folder(root, owner), sha), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!handle) return null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > fileLimit || (size !== undefined && size !== stat.size)) {
      await handle.close();
      return null;
    }
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ start: 0, autoClose: false })) digest.update(chunk);
    if (digest.digest('hex') !== sha) {
      await handle.close();
      return null;
    }
    return { handle, size: stat.size };
  } catch {
    await handle.close();
    return null;
  }
}

export async function validateBotFiles(root: string, owner: string, files: BotFile[]): Promise<boolean> {
  for (const file of files) {
    const got = await verifiedBotFile(root, owner, file.sha256, file.size);
    if (!got) return false;
    await got.handle.close();
  }
  return true;
}

export async function transferBotFile(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  owner: string,
  sha: string,
  stillActive: () => Promise<boolean>,
): Promise<void> {
  if (!isSha256(sha)) {
    req.resume();
    return sendJson(res, 404, {});
  }
  if (req.method === 'GET') {
    const file = await verifiedBotFile(root, owner, sha);
    if (!file) return sendJson(res, 404, {});
    try {
      if (!(await stillActive())) return sendJson(res, 401, {});
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
    return sendJson(res, 405, {}, { allow: 'GET, PUT' });
  }
  const length = req.headers['content-length'];
  if (!length || !/^\d{1,9}$/.test(length) || Number(length) > fileLimit) {
    req.resume();
    return sendJson(res, 413, {});
  }
  const dir = folder(root, owner);
  await mkdir(dir, { mode: 0o700, recursive: true });
  const temp = join(dir, randomUUID() + '.part');
  const handle = await open(temp, 'wx', 0o600);
  try {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > Number(length)) {
        req.resume();
        return sendJson(res, 413, {}, { connection: 'close' });
      }
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    if (size !== Number(length) || hash.digest('hex') !== sha) {
      return sendJson(res, 422, { message: '文件摘要或长度不一致' });
    }
    if (!(await stillActive())) return sendJson(res, 401, {});
    await handle.sync();
    try {
      await link(temp, join(dir, sha));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const prior = await verifiedBotFile(root, owner, sha, size);
      if (!prior) return sendJson(res, 409, {});
      await prior.handle.close();
    }
    sendJson(res, 200, { sha256: sha, size });
  } finally {
    await handle.close();
    await rm(temp, { force: true });
  }
}

export async function handleBotFile(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, sha: string): Promise<void> {
  const actor = await requireAccessBearer(req, res, deps.records.principals);
  if (!actor) return;
  return transferBotFile(req, res, deps.config.dataDir, actor.id, sha, async () => {
    const again = await authenticateAccessOnly(deps.records.principals, req.headers.authorization ?? null);
    return again.ok && again.principal.id === actor.id;
  });
}
