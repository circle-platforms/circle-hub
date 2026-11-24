import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { request as unixRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect as connectUnixSocket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProtocolCode } from '../../contracts/generated/protocol-codes.ts';
import { ActionKindSchema, BotMessageRoleSchema, BotModelProtocolSchema, EffectOutcomeSchema, ProvenanceTypeSchema } from '../../contracts/generated/vocabulary.ts';
import { MemberBotInbound, MemberNotificationIntent, MemberNotificationReceipt } from '../../contracts/src/resources.ts';
import type { Principal, Vault } from '../records/api.ts';
import {
  authenticateAccessOnly,
  botError,
  canAccessBot,
  requireDirectAccessBearer,
  sendBotInsufficientScope,
  sendBotJson,
} from './access-auth.ts';
import type { ServerDeps } from './api.ts';
import {
  commitChannelStagedFiles,
  ensureBotRuntimeDir,
  fileDescriptor,
  inspectBotRuntimeDir,
  transferBotFile,
  validateBotFiles,
  verifyChannelStagedFiles,
  type BotFile,
  type BotRuntimeDirInspection,
} from './bot-files.ts';
import { CliError } from './errors.ts';
import { mediaTypeOf, readBody, serverOrigins, type BodyBudget } from './http.ts';

export { ensureBotRuntimeDir, inspectBotRuntimeDir, type BotRuntimeDirInspection };

const profileName = 'personal-bot.model';
const configVersionName = 'personal-bot.model-version';
const reviewerProfileName = 'personal-bot.reviewer';
export const identityProfileName = 'personal-bot.identity';
export const channelProfileName = 'personal-bot.channel';
export const chatPath = '/api/bot/v1';

const SEMVER_2_0_0 =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

const word = z.string().trim().min(1).max(256).regex(/^[^\p{Cc}]+$/u);
const sha256Hex = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

const endpoint = z
  .url()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))
      );
    } catch {
      return false;
    }
  });

const profileSchema = z.strictObject({
  name: word,
  protocol: BotModelProtocolSchema,
  model: word,
  family: z.string().min(1).max(256).regex(/^[^\p{Cc}]+$/u).optional(),
  endpoint,
  key: z.string().min(1).max(4096).regex(/^[^\p{Cc}]+$/u),
});

export const identityProfile = z.strictObject({
  tenant: word,
  application: word,
  secret: z.string().min(1).max(4096),
  adminLogin: z.boolean().optional(),
});
export const channelProfile = z.strictObject({
  bot: word,
  secret: z.string().min(1).max(4096),
  hub: endpoint.refine((s) => new URL(s).pathname === '/'),
});
const storedChannel = channelProfile.extend({ token: z.string().length(43), enabled: z.boolean() });
type StoredChannel = z.infer<typeof storedChannel>;

export const identityIssuer = (tenant: string): string =>
  sha256Hex(JSON.stringify(['bot-identity-v1', tenant]));

export async function readChannel(vault: Vault): Promise<StoredChannel | null> {
  const raw = await vault.getText(channelProfileName);
  return raw ? storedChannel.parse(JSON.parse(raw)) : null;
}

export function newChannel(input: z.infer<typeof channelProfile>): StoredChannel {
  return { ...input, enabled: false, token: randomBytes(32).toString('base64url') };
}

export async function readIdentity(vault: Vault): Promise<z.infer<typeof identityProfile> | null> {
  const value = await vault.getText(identityProfileName);
  return value ? identityProfile.parse(JSON.parse(value)) : null;
}

export type BotProfile = z.infer<typeof profileSchema>;

export const chatOperation = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('discover') }),
  z.strictObject({
    action: z.literal('history'),
    conversation: z.uuid(),
    after: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  }),
  z.strictObject({
    action: z.literal('send'),
    conversation: z.uuid(),
    request: z.uuid(),
    replyTo: z.uuid().optional(),
    text: z.string().max(16000),
    files: z.array(fileDescriptor).max(8).optional(),
  }),
  z.strictObject({ action: z.literal('new'), request: z.uuid() }),
  z.strictObject({ action: z.literal('stop'), conversation: z.uuid(), request: z.uuid() }),
]);

export async function readBotProfile(vault: Vault): Promise<BotProfile | null> {
  const sealed = await vault.get(profileName);
  if (!sealed) return null;
  const result = profileSchema.safeParse(JSON.parse(Buffer.from(sealed).toString('utf8')));
  if (!result.success) throw new CliError('机器人配置不可读');
  return result.data;
}

export async function isBotEnabled(vault: Vault | null | undefined): Promise<boolean> {
  if (!vault) return false;
  try {
    return (await readBotProfile(vault)) !== null;
  } catch (error) {
    void error;
    return false;
  }
}

async function readStoredConfigVersion(vault: Vault): Promise<number> {
  const versionRaw = await vault.getText(configVersionName);
  if (versionRaw !== null && /^\d+$/.test(versionRaw)) {
    return Number(versionRaw);
  }
  return (await vault.has(profileName)) ? 1 : 0;
}

export async function readBotConfigState(
  vault: Vault,
): Promise<{ config: BotProfile | null; configVersion: number }> {
  const versionRaw = await vault.getText(configVersionName);
  const config = await readBotProfile(vault);
  const configVersion =
    versionRaw !== null && /^\d+$/.test(versionRaw) ? Number(versionRaw) : config ? 1 : 0;
  return { config, configVersion };
}

export async function setBotProfile(vault: Vault, data: unknown): Promise<void> {
  const parsed = profileSchema.safeParse(data);
  if (!parsed.success) {
    throw new CliError('请检查名称、协议、模型标识、服务地址和密钥。地址须为 HTTPS 或本机 HTTP，密钥只填在密钥栏。');
  }
  const prev = await readStoredConfigVersion(vault);
  await vault.put(profileName, JSON.stringify(parsed.data));
  if (await vault.has(reviewerProfileName)) {
    await vault.remove(reviewerProfileName);
  }
  await vault.put(configVersionName, String(prev + 1));
}

export interface RefreshHostResult {
  notified: boolean;
  configVersion: number;
  detail?: string;
  socketAbsent?: boolean;
}

export async function refreshHost(
  dataDir: string,
  vault: Vault,
  log?: (line: string) => void,
  extraSecrets: readonly string[] = [],
): Promise<RefreshHostResult> {
  let configVersion = 0;
  try {
    const state = await readBotConfigState(vault);
    configVersion = state.configVersion;
    const result = await callBot(
      dataDir,
      state.config
        ? { owner: '_hub', op: { action: 'configure' }, config: state.config, configVersion }
        : { owner: '_hub', op: { action: 'disable' }, configVersion },
    );
    if (result.status === 200) {
      return { notified: true, configVersion };
    }
    const bodyObj = result.body && typeof result.body === 'object' ? (result.body as Record<string, unknown>) : {};
    const rawDetail =
      result.adminDetail ??
      (typeof bodyObj.message === 'string'
        ? bodyObj.message
        : typeof bodyObj.error === 'string'
          ? bodyObj.error
          : `状态 ${result.status}`);
    const detail = await maskVaultSecrets(vault, rawDetail, extraSecrets).catch(() => rawDetail);
    log?.(`通知机器人宿主配置变更失败（版本 ${configVersion}）：${detail}`);
    return { notified: false, configVersion, detail, socketAbsent: Boolean(result.socketAbsent) };
  } catch (error) {
    const rawDetail = error instanceof Error ? error.message : String(error);
    const detail = await maskVaultSecrets(vault, rawDetail, extraSecrets).catch(() => rawDetail);
    log?.(`通知机器人宿主配置变更失败（版本 ${configVersion}）：${detail}`);
    return { notified: false, configVersion, detail, socketAbsent: false };
  }
}

export async function syncHostOnStartup(
  dataDir: string,
  vault: Vault,
  log?: (line: string) => void,
): Promise<void> {
  try {
    const hasEntry = async (name: string): Promise<boolean> => {
      if (typeof vault.has === 'function') return await vault.has(name);
      if (typeof vault.getText === 'function') return (await vault.getText(name)) !== null;
      return false;
    };
    const [hasModel, hasVersion] = await Promise.all([hasEntry(profileName), hasEntry(configVersionName)]);
    if (!hasModel && !hasVersion) return;
    const res = await refreshHost(dataDir, vault);
    if (!res.notified && !res.socketAbsent) {
      log?.(`通知机器人宿主配置变更失败（版本 ${res.configVersion}）：${res.detail ?? '未知错误'}`);
    }
  } catch (error) {
    const rawDetail = error instanceof Error ? error.message : String(error);
    const detail = await maskVaultSecrets(vault, rawDetail).catch(() => rawDetail);
    try {
      log?.(`通知机器人宿主配置变更失败：${detail}`);
    } catch {
      // Startup sync must never abort server listen.
    }
  }
}

export async function disableBot(
  vaultOrDeps: Vault | Pick<ServerDeps, 'config' | 'records'>,
  dataDir?: string,
): Promise<void> {
  const vault = 'records' in vaultOrDeps ? vaultOrDeps.records.vault : vaultOrDeps;
  const dir = 'config' in vaultOrDeps ? vaultOrDeps.config.dataDir : dataDir;
  const prior = await readBotProfile(vault).catch(() => null);
  const prev = await readStoredConfigVersion(vault);
  await vault.remove(profileName);
  if (await vault.has(reviewerProfileName)) {
    await vault.remove(reviewerProfileName);
  }
  await vault.put(configVersionName, String(prev + 1));
  if (dir) await refreshHost(dir, vault, undefined, prior ? [prior.key] : undefined);
}

async function vaultSecrets(vault: Vault, extraSecrets: readonly string[] = []): Promise<string[]> {
  const found = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.length >= 4) found.add(value);
  };
  for (const extra of extraSecrets) add(extra);
  if (typeof vault.getText === 'function') {
    const modelRaw = await vault.getText(profileName).catch(() => null);
    if (modelRaw) {
      try {
        add((JSON.parse(modelRaw) as { key?: unknown }).key);
      } catch {
        // ignore unparseable vault text
      }
    }
    const channelRaw = await vault.getText(channelProfileName).catch(() => null);
    if (channelRaw) {
      try {
        const parsed = JSON.parse(channelRaw) as { secret?: unknown; token?: unknown };
        add(parsed.secret);
        add(parsed.token);
      } catch {
        // ignore
      }
    }
    const identityRaw = await vault.getText(identityProfileName).catch(() => null);
    if (identityRaw) {
      try {
        add((JSON.parse(identityRaw) as { secret?: unknown }).secret);
      } catch {
        // ignore
      }
    }
  }
  if (typeof vault.recentSecrets === 'function') {
    for (const secret of await vault.recentSecrets().catch(() => [])) add(secret.value);
  }
  return [...found].sort((a, b) => b.length - a.length);
}

function maskSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (out.includes(secret)) out = out.replaceAll(secret, '[REDACTED]');
  }
  return out;
}

export async function maskVaultSecrets(
  vault: Vault,
  text: string,
  extraSecrets: readonly string[] = [],
): Promise<string> {
  const secrets = await vaultSecrets(vault, extraSecrets);
  return maskSecrets(text, secrets);
}

function mapHostError(
  status: number,
  body: unknown,
): { status: number; code: ProtocolCode; fact?: string; nextAction?: string; rawCode: string } {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const rawCode = typeof obj.code === 'string' ? obj.code : '';
  if ((status === 409 || status === 400) && rawCode === 'version_mismatch') {
    return { status: 400, code: 'BOT_VERSION_MISMATCH', rawCode };
  }
  if (status === 409) {
    return { status: 409, code: 'BOT_CONFLICT', fact: '机器人当前正忙或状态冲突', rawCode };
  }
  if (status === 400 && rawCode === 'invalid_version') {
    return { status: 400, code: 'BOT_VERSION_INVALID', rawCode };
  }
  if (status === 400) {
    return { status: 400, code: 'BOT_INVALID_REQUEST', fact: '机器人请求无效', rawCode };
  }
  if (status === 404) {
    return { status: 404, code: 'BOT_NOT_FOUND', fact: '会话不存在或已不可用', rawCode };
  }
  if (status === 429 && rawCode === 'bot_busy') {
    return { status: 429, code: 'BOT_BUSY', fact: '当前机器人会话排队消息已满', rawCode };
  }
  if (status === 503 && rawCode === 'bot_not_enabled') {
    return { status: 503, code: 'BOT_DISABLED', fact: '机器人尚未配置启用', rawCode };
  }
  if (status === 413) {
    return { status: 413, code: 'BOT_INVALID_REQUEST', fact: '机器人请求体超过允许大小上限', rawCode };
  }
  if (status === 422 && (rawCode === 'attachment_integrity_failed' || rawCode === 'invalid_request')) {
    return {
      status: 422,
      code: 'BOT_INVALID_REQUEST',
      fact: '机器人私聊附件完整性校验未通过',
      nextAction: '请重新上传附件后重试',
      rawCode,
    };
  }
  const upstreamStatus = status === 502 || status === 503 ? status : 502;
  const upstreamMessages: Record<string, { fact: string; nextAction?: string }> = {
    model_auth_failed: { fact: '机器人上游模型凭证验证失败', nextAction: '请联系管理员检查配置后重试' },
    model_not_found: { fact: '机器人配置的模型不可用', nextAction: '请联系管理员检查配置后重试' },
    model_output_blocked: { fact: '机器人回复未能通过内容限制', nextAction: '请调整内容后重试' },
    model_empty_reply: { fact: '机器人未生成有效回复', nextAction: '请稍后重试' },
    model_unreachable: { fact: '机器人上游模型服务当前不可达', nextAction: '请稍后重试' },
  };
  const matched = upstreamMessages[rawCode];
  return {
    status: upstreamStatus,
    code: 'BOT_UPSTREAM_UNAVAILABLE',
    ...(matched ? { fact: matched.fact, nextAction: matched.nextAction } : {}),
    rawCode,
  };
}

async function recordHostFailure(
  deps: ServerDeps,
  userId: string,
  action: string,
  hostStatus: number,
  rawBody: unknown,
  mappedCode: ProtocolCode,
  adminDetail?: string,
): Promise<void> {
  const obj = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const rawMessage =
    adminDetail ??
    (typeof obj.message === 'string' ? obj.message : typeof obj.error === 'string' ? obj.error : '');
  const sanitized = (await maskVaultSecrets(deps.records.vault, rawMessage)).slice(0, 512);
  const adminNote = `personal_bot action=${action} host_status=${hostStatus} code=${mappedCode} detail=${sanitized}`;
  if (typeof deps.records.callLog?.append !== 'function') return;
  await deps.records.callLog
    .append({
      ...(deps.now ? { at: deps.now() } : {}),
      traceId: randomBytes(16).toString('hex'),
      userId,
      sessionId: null,
      tool: 'personal_bot',
      runId: null,
      arguments: { action, hostStatus, code: mappedCode },
      callResult: 'error',
      errorCode: mappedCode,
      durationMs: 0,
      adminNote,
    })
    .catch(() => undefined);
}

export async function probeBotSocket(directory: string, service: 'host' | 'channel'): Promise<boolean> {
  const dirCheck = await inspectBotRuntimeDir(directory);
  if (!dirCheck.ok) return false;
  const socketPath = join(directory, 'bot-runtime', service + '.sock');
  const sockInfo = await lstat(socketPath).catch(() => null);
  if (!sockInfo || sockInfo.isSymbolicLink() || !sockInfo.isSocket()) return false;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const socket = connectUnixSocket({ path: socketPath }, () => finish(true));
    const timer = setTimeout(() => finish(false), 500);
    timer.unref();
    socket.once('error', () => finish(false));
  });
}

export async function callBot(
  directory: string,
  frame: unknown,
  service: 'host' | 'channel' = 'host',
): Promise<{ status: number; body: unknown; adminDetail?: string; socketAbsent?: boolean }> {
  const dirCheck = await inspectBotRuntimeDir(directory);
  if (!dirCheck.ok) {
    return {
      status: 503,
      body: botError('BOT_UPSTREAM_UNAVAILABLE', '机器人宿主当前不可用', '请管理员检查运行文件夹与宿主进程后稍后重试'),
      adminDetail: `bot-runtime 异常：${dirCheck.reason}`,
      socketAbsent: dirCheck.missing,
    };
  }
  const bytes = Buffer.from(JSON.stringify(frame));
  return new Promise((resolve) => {
    const unavailable = (detail?: string, socketAbsent = false) =>
      resolve({
        status: 503,
        body: botError('BOT_UPSTREAM_UNAVAILABLE', '机器人宿主暂不可用', '请管理员检查宿主进程后稍后重试'),
        ...(detail ? { adminDetail: detail } : {}),
        socketAbsent,
      });
    const req = unixRequest(
      {
        socketPath: join(directory, 'bot-runtime', service + '.sock'),
        path: '/chat',
        method: 'POST',
        signal: AbortSignal.timeout(20000),
        headers: { 'content-type': 'application/json', 'content-length': bytes.length },
      },
      (res) => {
        let length = 0;
        const chunks: Buffer[] = [];
        res.on('error', (error) => unavailable(error instanceof Error ? error.message : String(error), false));
        res.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 8 * 1024 * 1024) res.destroy();
          else chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 503,
              body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
              socketAbsent: false,
            });
          } catch {
            unavailable('机器人宿主返回了无效的 JSON 响应', false);
          }
        });
      },
    );
    req.on('error', (error) =>
      unavailable(
        error instanceof Error ? error.message : String(error),
        (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT',
      ),
    );
    req.end(bytes);
  });
}

async function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  hold: ReturnType<BodyBudget['hold']>,
  messages: { busy: string; invalid: string },
): Promise<unknown | undefined> {
  const body = await readBody(req, 72 * 1024, hold);
  if (!body.ok) {
    if (res.headersSent || res.writableEnded || res.destroyed) return undefined;
    if (body.reason === 'busy') {
      sendBotJson(
        res,
        503,
        botError('BOT_UPSTREAM_UNAVAILABLE', messages.busy || '暂时无法接收消息', '当前服务请求负载较高，请稍后重试'),
      );
    } else if (body.reason === 'too_large') {
      sendBotJson(
        res,
        413,
        botError('BOT_INVALID_REQUEST', '请求体超过 72 KiB 大小上限', '请精简请求内容至 72 KiB 以内后重试'),
      );
    } else {
      sendBotJson(
        res,
        400,
        botError('BOT_INVALID_REQUEST', '请求体读取未完成', '请保持连接完整并重新发送请求'),
      );
    }
    return undefined;
  }
  try {
    return JSON.parse(body.bytes.toString('utf8'));
  } catch {
    sendBotJson(
      res,
      400,
      botError('BOT_INVALID_REQUEST', messages.invalid || '请求格式错误', '请发送合法的 JSON 请求体后重试'),
    );
    return undefined;
  }
}

export async function handleBot(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, budget: BodyBudget): Promise<void> {
  if (req.method !== 'POST') {
    req.resume();
    return sendBotJson(
      res,
      405,
      botError('BOT_INVALID_REQUEST', '此地址只接受 POST', '请改用 POST 方法重新请求'),
      { allow: 'POST' },
    );
  }
  const principal = await requireDirectAccessBearer(req, res, deps.records.principals);
  if (!principal) return;
  if (mediaTypeOf(req) !== 'application/json') {
    req.resume();
    return sendBotJson(
      res,
      415,
      botError('BOT_INVALID_REQUEST', '需要 JSON', '请将 Content-Type 设为 application/json 后重试'),
    );
  }
  const hold = budget.hold();
  try {
    const input = await readJsonBody(req, res, hold, { busy: '暂时无法接收消息', invalid: '请求格式错误' });
    if (input === undefined) return;
    const op = chatOperation.safeParse(input);
    if (!op.success) {
      return sendBotJson(
        res,
        400,
        botError('BOT_INVALID_REQUEST', '请求字段无效', '请核对操作类型与必填字段后重试'),
      );
    }
    const renewed = await authenticateAccessOnly(deps.records.principals, req.headers.authorization ?? null);
    if (!renewed.ok || renewed.principal.id !== principal.id) {
      return sendBotJson(res, 401, botError('BOT_UNAUTHENTICATED'), { 'www-authenticate': 'Bearer' });
    }
    if (!canAccessBot(renewed)) {
      sendBotInsufficientScope(res);
      return;
    }
    const version = req.headers['bot-client-version'];
    if (typeof version !== 'string' || !SEMVER_2_0_0.test(version)) {
      return sendBotJson(res, 400, botError('BOT_VERSION_INVALID'));
    }
    const nowMs = (deps.now?.() ?? new Date()).getTime();
    const { config, configVersion } = await readBotConfigState(deps.records.vault);
    if (
      op.data.action === 'send' &&
      ((!op.data.text.trim() && !op.data.files?.length) ||
        !(await validateBotFiles(deps.config.dataDir, principal.id, op.data.files ?? [], { now: nowMs })))
    ) {
      return sendBotJson(
        res,
        400,
        botError('BOT_INVALID_REQUEST', '消息或附件不可用', '请提供非空消息文本或重新上传有效附件后重试'),
      );
    }
    if (op.data.action === 'send' && !config) {
      return sendBotJson(
        res,
        503,
        botError('BOT_DISABLED', '机器人模型尚未启用', '请管理员在控制台配置并启用机器人模型后重试'),
      );
    }
    const identity =
      op.data.action === 'send' && (await deps.records.vault.has(identityProfileName))
        ? await readIdentity(deps.records.vault)
        : null;
    const issuer = identity ? identityIssuer(identity.tenant) : null;
    const route = issuer
      ? { source: 'client', issuer, subject: await deps.records.principals.externalSubject(principal.id, issuer) }
      : undefined;
    const result = await callBot(deps.config.dataDir, {
      owner: principal.id,
      op: op.data,
      version,
      config,
      configVersion,
      route,
    });
    if (result.status >= 400) {
      const mapped = mapHostError(result.status, result.body);
      await recordHostFailure(
        deps,
        principal.id,
        op.data.action,
        result.status,
        result.body,
        mapped.code,
        result.adminDetail,
      );
      return sendBotJson(res, mapped.status, botError(mapped.code, mapped.fact, mapped.nextAction));
    }
    if (op.data.action === 'discover' && result.status === 200 && (await deps.records.vault.has(profileName))) {
      const profile = await readBotProfile(deps.records.vault);
      if (profile) result.body = { ...(result.body as object), name: profile.name };
    }
    const serializedReply = JSON.stringify(result.body);
    if (
      (config?.key && serializedReply.includes(config.key)) ||
      (await maskVaultSecrets(deps.records.vault, serializedReply)) !== serializedReply
    ) {
      await recordHostFailure(
        deps,
        principal.id,
        op.data.action,
        502,
        { message: 'secret reflected in response' },
        'BOT_UPSTREAM_UNAVAILABLE',
      );
      return sendBotJson(
        res,
        502,
        botError('BOT_UPSTREAM_UNAVAILABLE', '机器人响应异常', '请管理员检查机器人模型配置后稍后重试'),
      );
    }
    sendBotJson(res, result.status, result.body);
  } finally {
    hold.release();
  }
}

const channelOutcome = EffectOutcomeSchema.extract(['issued', 'unknown', 'target_rejected', 'not_dispatched']);

const channelInput = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('authorize'), subject: word }),
  z.strictObject({
    action: z.literal('inbound'),
    subject: word,
    platformId: word,
    text: z.string().max(16000),
    files: z.array(fileDescriptor).max(8).optional(),
  }),
  z.strictObject({ action: z.literal('next') }),
  z.strictObject({
    action: z.literal('receipt'),
    receipt: z.uuid(),
    state: channelOutcome,
    acknowledgment: z.strictObject({ request: z.string().regex(/^[a-f0-9]{64}$/), code: z.number().int() }).optional(),
    reached_target: z.boolean().nullable(),
    missing: z.array(z.string().min(1)).min(1).optional(),
    next: z.string().min(1).optional(),
  }),
]);

type ChannelReceiptInput = Extract<z.infer<typeof channelInput>, { action: 'receipt' }>;
type ChannelInboundInput = Extract<z.infer<typeof channelInput>, { action: 'inbound' }>;

const deliverySchema = z.strictObject({
  id: z.uuid(),
  owner: z.string().min(1),
  subject: word,
  receipt: z.uuid(),
  role: BotMessageRoleSchema,
  code: z.string().regex(/^[a-z0-9_]{1,64}$/).optional(),
  text: z.string().max(64000),
  file: fileDescriptor.optional(),
});

function computeIntentPayload(text: string, file?: BotFile) {
  const textBytes = Buffer.from(text, 'utf8');
  const text_size = textBytes.length;
  const text_sha256 = text_size > 0 ? sha256Hex(textBytes) : null;
  const file_sha256 = file ? file.sha256 : null;
  const file_size = file ? file.size : null;
  const name_sha256 = file ? sha256Hex(Buffer.from(file.name, 'utf8')) : null;
  const size = text_size + (file_size ?? 0);
  const sha256 = sha256Hex(JSON.stringify({ file_sha256, file_size, name_sha256, text_sha256, text_size }));
  return { sha256, size, text_sha256, text_size, file_sha256, file_size, name_sha256 };
}

async function handleChannelFile(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  channel: StoredChannel,
  sha: string,
): Promise<void> {
  const subjectHeader = req.headers['bot-member-subject'];
  if (typeof subjectHeader !== 'string' || subjectHeader.length === 0 || subjectHeader.length > 1024) {
    req.resume();
    return sendBotJson(
      res,
      403,
      botError('BOT_CLIENT_FORBIDDEN', '缺少有效的通道成员身份头', '请在请求头中提供有效的 Bot-Member-Subject 后重试'),
    );
  }
  const identity = await readIdentity(deps.records.vault);
  if (!identity) {
    req.resume();
    return sendBotJson(
      res,
      403,
      botError('BOT_CLIENT_FORBIDDEN', '外部身份未绑定', '请管理员启用扫码登录应用并由成员绑定外部身份后重试'),
    );
  }
  const issuer = identityIssuer(identity.tenant);
  const subject = Buffer.from(subjectHeader, 'base64url').toString('utf8');
  const lookup = () => deps.records.principals.externalMember(issuer, subject);
  const member = await lookup();
  if (!member) {
    req.resume();
    return sendBotJson(
      res,
      403,
      botError('BOT_CLIENT_FORBIDDEN', '外部身份未绑定有效成员', '请成员在控制台绑定外部身份并确认账号启用后重试'),
    );
  }
  const stillActive = async () => {
    const latest = await readChannel(deps.records.vault);
    return latest?.enabled === true && latest.token === channel.token && (await lookup())?.id === member.id;
  };
  const clockOpt = { now: () => (deps.now?.() ?? new Date()).getTime() };
  if (req.method === 'PUT') {
    return transferBotFile(req, res, deps.config.dataDir, member.id, sha, stillActive, {
      ...clockOpt,
      scope: 'channel-staging',
    });
  }
  if (req.method !== 'GET') {
    req.resume();
    return sendBotJson(
      res,
      405,
      botError('BOT_INVALID_REQUEST', '只允许 GET 或 PUT', '请改用 GET 下载或 PUT 上传通道附件'),
      { allow: 'GET, PUT' },
    );
  }
  const receiptHeader = req.headers['bot-delivery-receipt'];
  const parsedReceipt = z.uuid().safeParse(receiptHeader);
  if (!parsedReceipt.success) {
    req.resume();
    return sendBotJson(
      res,
      403,
      botError(
        'BOT_CLIENT_FORBIDDEN',
        '下载附件须提供有效的 Bot-Delivery-Receipt',
        '请在请求头中提供有效的 Bot-Delivery-Receipt 后重试',
      ),
    );
  }
  const intentRecord = await deps.records.store.getByKey('action', 'chat-intent:' + parsedReceipt.data);
  const declared = MemberNotificationIntent.safeParse(intentRecord?.body);
  const channelId = sha256Hex(JSON.stringify([issuer, channel.bot]));
  const subjectDigest = sha256Hex(JSON.stringify([issuer, subject]));
  if (
    !intentRecord ||
    !declared.success ||
    declared.data.channel !== channelId ||
    declared.data.member !== member.id ||
    declared.data.subject !== subjectDigest ||
    declared.data.file_sha256 !== sha
  ) {
    req.resume();
    return sendBotJson(
      res,
      403,
      botError('BOT_CLIENT_FORBIDDEN', '未找到匹配当前成员与投递意图的附件', '请核对投递回执、成员身份及附件摘要是否一致'),
    );
  }
  return transferBotFile(req, res, deps.config.dataDir, member.id, sha, stillActive, { ...clockOpt, scope: 'files' });
}

async function handleChannelReceipt(
  res: ServerResponse,
  deps: ServerDeps,
  op: ChannelReceiptInput,
  channelId: string,
): Promise<void> {
  const intent = await deps.records.store.getByKey('action', 'chat-intent:' + op.receipt);
  const declared = MemberNotificationIntent.safeParse(intent?.body);
  if (!intent || !declared.success || declared.data.channel !== channelId) {
    return sendBotJson(res, 404, botError('BOT_NOT_FOUND', '未找到对应的投递意图记录', '请核对回执编号与所属通道后重试'));
  }

  const missingReasons: string[] = [];
  if (op.state === EffectOutcomeSchema.enum.issued) {
    if (!op.acknowledgment || op.acknowledgment.code !== 0) missingReasons.push('缺少成功的平台确认码');
    if (op.reached_target !== true) missingReasons.push('平台回执与送达确认状态不一致');
  } else if (op.state === EffectOutcomeSchema.enum.target_rejected) {
    if (!op.acknowledgment || op.acknowledgment.code === 0) missingReasons.push('缺少平台拒收错误码');
    if (op.reached_target !== true) missingReasons.push('拒收回执与送达状态不一致');
  } else if (op.state === EffectOutcomeSchema.enum.not_dispatched) {
    if (op.reached_target !== false) missingReasons.push('未发出状态与目标可达性不一致');
  }

  const effectiveOutcome = missingReasons.length > 0 ? EffectOutcomeSchema.enum.unknown : op.state;
  const candidate = MemberNotificationReceipt.parse({
    schema: 'member-notification-receipt@1',
    member: declared.data.member,
    intent: intent.digest,
    receipt: op.receipt,
    outcome: effectiveOutcome,
    acknowledgment: op.acknowledgment ?? null,
    reached_target:
      effectiveOutcome === EffectOutcomeSchema.enum.not_dispatched
        ? false
        : effectiveOutcome === EffectOutcomeSchema.enum.unknown
          ? null
          : true,
    missing:
      effectiveOutcome === EffectOutcomeSchema.enum.unknown
        ? (missingReasons.length > 0 ? missingReasons : (op.missing ?? ['未取得与本条消息对应的平台确认']))
        : null,
    next:
      effectiveOutcome === EffectOutcomeSchema.enum.unknown
        ? (op.next ?? '核对目标侧记录，不自动重发')
        : null,
  });

  const sameTerminalDecision = (a: z.infer<typeof MemberNotificationReceipt>, b: z.infer<typeof MemberNotificationReceipt>) =>
    a.outcome === b.outcome &&
    a.reached_target === b.reached_target &&
    JSON.stringify(a.acknowledgment) === JSON.stringify(b.acknowledgment);

  const outcome = await deps.records.store.withTransaction(async (tx) => {
    await deps.records.store.lock('chat-receipt:' + op.receipt, tx);
    const initial = await deps.records.store.getByKey('effect', 'chat-receipt:' + op.receipt, tx);
    if (!initial) {
      const putInitial = await deps.records.store.put(
        {
          kind: 'effect',
          schema: candidate.schema,
          provenance: ProvenanceTypeSchema.enum.declared,
          body: candidate,
          unique_key: 'chat-receipt:' + op.receipt,
          index: [{ key: 'chat.notification.intent', value: intent.digest }],
        },
        tx,
      );
      const eff = MemberNotificationReceipt.parse(putInitial.body);
      if (!putInitial.created && !sameTerminalDecision(eff, candidate)) {
        return { ok: false as const, message: '投递回执已记录且与当前请求不一致' };
      }
      return { ok: true as const, effective: eff };
    }
    const confirmed = await deps.records.store.getByKey('effect', 'chat-receipt:' + op.receipt + ':confirmed', tx);
    const latest = MemberNotificationReceipt.parse((confirmed ?? initial).body);
    if (latest.outcome !== EffectOutcomeSchema.enum.unknown) {
      if (candidate.outcome === EffectOutcomeSchema.enum.unknown) {
        return { ok: true as const, effective: latest };
      }
      if (!sameTerminalDecision(latest, candidate)) {
        return { ok: false as const, message: '投递回执已进入终态，不能改为其他结果' };
      }
      return { ok: true as const, effective: latest };
    }
    if (candidate.outcome === EffectOutcomeSchema.enum.unknown) {
      return { ok: true as const, effective: latest };
    }
    const confirmedBody = MemberNotificationReceipt.parse({ ...candidate, supersedes: initial.digest });
    const putConfirmed = await deps.records.store.put(
      {
        kind: 'effect',
        schema: confirmedBody.schema,
        provenance: ProvenanceTypeSchema.enum.declared,
        body: confirmedBody,
        unique_key: 'chat-receipt:' + op.receipt + ':confirmed',
        index: [{ key: 'chat.notification.intent', value: intent.digest }],
      },
      tx,
    );
    const eff = MemberNotificationReceipt.parse(putConfirmed.body);
    if (!putConfirmed.created && !sameTerminalDecision(eff, confirmedBody)) {
      return { ok: false as const, message: '投递回执确认结果与既有记录冲突' };
    }
    return { ok: true as const, effective: eff };
  });

  if (!outcome.ok) {
    return sendBotJson(res, 409, botError('BOT_CONFLICT', outcome.message, '请核对已记录的投递回执状态，勿对终态回执重复提交不同结果'));
  }
  const effective = outcome.effective;

  const { config, configVersion } = await readBotConfigState(deps.records.vault);
  const result = await callBot(deps.config.dataDir, {
    owner: 'channel',
    op: { action: 'receipt', receipt: op.receipt, state: effective.outcome },
    config,
    configVersion,
  });
  if (result.status >= 400) {
    const mapped = mapHostError(result.status, result.body);
    return sendBotJson(res, mapped.status, botError(mapped.code, mapped.fact, mapped.nextAction));
  }
  return sendBotJson(res, result.status, result.body);
}

async function handleChannelNext(
  res: ServerResponse,
  deps: ServerDeps,
  issuer: string,
  channelId: string,
): Promise<void> {
  const { config, configVersion } = await readBotConfigState(deps.records.vault);
  const result = await callBot(deps.config.dataDir, {
    owner: 'channel',
    op: { action: 'claim', issuer },
    config,
    configVersion,
  });
  if (result.status !== 200) {
    const mapped = mapHostError(result.status, result.body);
    return sendBotJson(res, mapped.status, botError(mapped.code, mapped.fact, mapped.nextAction));
  }
  const rawDelivery = (result.body as { delivery?: unknown })?.delivery;
  if (rawDelivery === undefined || rawDelivery === null) return sendBotJson(res, 200, { delivery: null });

  const parsed = deliverySchema.safeParse(rawDelivery);
  if (!parsed.success) {
    return sendBotJson(
      res,
      502,
      botError('BOT_UPSTREAM_UNAVAILABLE', '机器人宿主返回的投递载荷结构无效', '请管理员检查机器人宿主版本与日志后重试'),
    );
  }
  const item = parsed.data;
  const member = await deps.records.principals.externalMember(issuer, item.subject);
  if (!member || member.id !== item.owner) {
    await callBot(deps.config.dataDir, {
      owner: 'channel',
      op: { action: 'receipt', receipt: item.receipt, state: EffectOutcomeSchema.enum.not_dispatched },
      config,
      configVersion,
    });
    return sendBotJson(res, 200, { delivery: null });
  }
  const nowMs = (deps.now?.() ?? new Date()).getTime();
  if (item.file && !(await validateBotFiles(deps.config.dataDir, member.id, [item.file], { now: nowMs }))) {
    await callBot(deps.config.dataDir, {
      owner: 'channel',
      op: { action: 'receipt', receipt: item.receipt, state: EffectOutcomeSchema.enum.not_dispatched },
      config,
      configVersion,
    });
    return sendBotJson(
      res,
      409,
      botError('BOT_CONFLICT', '待投递的附件与当前本地文件状态冲突', '已向宿主回写未发出状态，请核对附件后重新发起发送'),
    );
  }
  const intentPayload = computeIntentPayload(item.text, item.file);
  const target = sha256Hex(JSON.stringify([issuer, item.subject]));
  const intent = MemberNotificationIntent.parse({
    schema: 'member-notification-intent@1',
    kind: ActionKindSchema.enum.dispatch,
    event: item.id,
    receipt: item.receipt,
    member: member.id,
    issuer,
    channel: channelId,
    subject: target,
    role: item.role,
    ...(item.code ? { code: item.code } : {}),
    sha256: intentPayload.sha256,
    size: intentPayload.size,
    text_sha256: intentPayload.text_sha256,
    text_size: intentPayload.text_size,
    file_sha256: intentPayload.file_sha256,
    file_size: intentPayload.file_size,
    name_sha256: intentPayload.name_sha256,
    write: {
      interaction: 'submit_then_read',
      effect_class: 'notification',
      retry_safety: 'unsafe',
      signing: 'service_on_behalf',
      reversible: false,
      target_key: target,
      audience: member.id,
      evidence: { call: 'receipt', pointer: '/acknowledgment/code' },
      refusal: { stage: '/state', reached_device: '/reached_target' },
      writes_hub_records: true,
    },
  });
  const held = await deps.records.store.withTransaction(async (tx) => {
    await deps.records.principals.lockActive(member, tx);
    return deps.records.store.put(
      {
        kind: 'action',
        schema: intent.schema,
        provenance: ProvenanceTypeSchema.enum.declared,
        body: intent,
        unique_key: 'chat-intent:' + item.receipt,
        index: [{ key: 'chat.notification.owner', value: member.id }],
      },
      tx,
    );
  });
  if (!held.created) return sendBotJson(res, 200, { delivery: null });
  return sendBotJson(res, 200, {
    delivery: {
      subject: item.subject,
      receipt: item.receipt,
      role: item.role,
      ...(item.code ? { code: item.code } : {}),
      text: item.text,
      sha256: intentPayload.sha256,
      size: intentPayload.size,
      file: item.file ?? null,
      intent: intentPayload,
    },
  });
}

async function handleChannelInbound(
  res: ServerResponse,
  deps: ServerDeps,
  member: Principal,
  op: ChannelInboundInput,
  issuer: string,
  channelId: string,
  bot: string,
): Promise<void> {
  if (!op.text.trim() && !op.files?.length) {
    return sendBotJson(
      res,
      400,
      botError('BOT_INVALID_REQUEST', '入站消息内容与附件不能同时为空', '请提供非空消息文本或至少一个有效附件后重试'),
    );
  }
  const { config, configVersion } = await readBotConfigState(deps.records.vault);
  if (!config) {
    return sendBotJson(
      res,
      503,
      botError('BOT_DISABLED', '机器人模型尚未启用', '请管理员在控制台配置并启用机器人模型后重试'),
    );
  }

  // RFC 9562 v8 deterministic request UUID derived from the inbound message identity.
  const hash = createHash('sha256').update(JSON.stringify([issuer, bot, op.subject, op.platformId])).digest();
  hash[6] = (hash[6] & 15) | 0x80;
  hash[8] = (hash[8] & 63) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  const request = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');

  const files = op.files ?? [];
  const textBytes = Buffer.from(op.text, 'utf8');
  const text_size = textBytes.length;
  const text_sha256 = text_size > 0 ? sha256Hex(textBytes) : null;
  const nowDate = deps.now?.() ?? new Date();
  const nowMs = nowDate.getTime();
  const inboundBody = MemberBotInbound.parse({
    schema: 'member-bot-inbound@1',
    kind: ActionKindSchema.enum.dispatch,
    request,
    member: member.id,
    issuer,
    subject: sha256Hex(JSON.stringify([issuer, op.subject])),
    channel: channelId,
    platform_id_sha256: sha256Hex(JSON.stringify([issuer, op.platformId])),
    text_sha256,
    text_size,
    files: files.map((file) => ({
      sha256: file.sha256,
      size: file.size,
      name_sha256: sha256Hex(Buffer.from(file.name, 'utf8')),
    })),
    at: nowDate.toISOString(),
  });

  const inboundMatches = (raw: unknown) => {
    const prior = MemberBotInbound.safeParse(raw);
    return (
      prior.success &&
      prior.data.member === inboundBody.member &&
      prior.data.text_sha256 === inboundBody.text_sha256 &&
      prior.data.text_size === inboundBody.text_size &&
      JSON.stringify(prior.data.files) === JSON.stringify(inboundBody.files)
    );
  };

  const existingInbound = await deps.records.store.getByKey('action', 'chat-inbound:' + request);
  if (existingInbound) {
    if (!inboundMatches(existingInbound.body)) {
      return sendBotJson(
        res,
        409,
        botError('BOT_CONFLICT', '入站消息请求与既有记录不一致', '请核对平台消息编号与内容，勿用同一消息编号提交不同载荷'),
      );
    }
    const healed = await commitChannelStagedFiles(deps.config.dataDir, member.id, files, { now: () => nowMs });
    if (!healed.ok) {
      return sendBotJson(res, healed.status, { code: healed.code, message: healed.message });
    }
    if (!(await validateBotFiles(deps.config.dataDir, member.id, files, { now: nowMs }))) {
      return sendBotJson(
        res,
        409,
        botError('BOT_CONFLICT', '入站消息附件与当前本地文件状态冲突', '请重新暂存对应附件后再重试该入站请求'),
      );
    }
  } else {
    const verified = await verifyChannelStagedFiles(deps.config.dataDir, member.id, files, { now: () => nowMs });
    if (!verified.ok) {
      return sendBotJson(res, verified.status, { code: verified.code, message: verified.message });
    }
    let reservationConsumed = false;
    try {
      const putResult = await deps.records.store.put({
        kind: 'action',
        schema: inboundBody.schema,
        provenance: ProvenanceTypeSchema.enum.declared,
        body: inboundBody,
        unique_key: 'chat-inbound:' + request,
        index: [{ key: 'chat.inbound.owner', value: member.id }],
      });
      if (!putResult.created && !inboundMatches(putResult.body)) {
        return sendBotJson(
          res,
          409,
          botError('BOT_CONFLICT', '入站消息请求与既有记录不一致', '请核对平台消息编号与内容，勿用同一消息编号提交不同载荷'),
        );
      }
      const committed = await commitChannelStagedFiles(deps.config.dataDir, member.id, files, {
        now: () => nowMs,
        reservation: verified.reservation,
        consumeReservation: () => {
          reservationConsumed = true;
        },
      });
      if (!committed.ok) {
        return sendBotJson(res, committed.status, { code: committed.code, message: committed.message });
      }
    } finally {
      if (!reservationConsumed) await verified.release();
    }
  }

  const result = await callBot(deps.config.dataDir, {
    owner: member.id,
    op: { action: 'inbound', request, text: op.text, files: op.files },
    config,
    configVersion,
    route: { source: 'channel', issuer, subject: op.subject },
  });
  if (result.status >= 400) {
    const mapped = mapHostError(result.status, result.body);
    await recordHostFailure(
      deps,
      member.id,
      'inbound',
      result.status,
      result.body,
      mapped.code,
      result.adminDetail,
    );
    return sendBotJson(res, mapped.status, botError(mapped.code, mapped.fact, mapped.nextAction));
  }
  return sendBotJson(res, result.status, { accepted: result.status === 200 });
}

export async function handleBotChannel(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  budget: BodyBudget,
  sha?: string,
): Promise<void> {
  if (sha === undefined && (req.method !== 'POST' || req.headers.origin || mediaTypeOf(req) !== 'application/json')) {
    req.resume();
    return sendBotJson(
      res,
      403,
      botError('BOT_CLIENT_FORBIDDEN', '通道入口请求不被允许', '请使用不带 Origin 的 POST application/json 请求访问通道入口'),
    );
  }
  if (!(await deps.records.vault.has(channelProfileName))) {
    req.resume();
    return sendBotJson(
      res,
      401,
      botError('BOT_UNAUTHENTICATED', '通道令牌未配置或无效', '请管理员保存并启用私聊通道配置，并使用当前通道令牌重试'),
    );
  }
  const channel = await readChannel(deps.records.vault);
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + channel?.token);
  if (!channel?.enabled || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    req.resume();
    return sendBotJson(
      res,
      401,
      botError('BOT_UNAUTHENTICATED', '通道凭证无效或已停用', '请核对当前启用的私聊通道令牌后重试'),
    );
  }
  if (sha !== undefined) return handleChannelFile(req, res, deps, channel, sha);
  const hold = budget.hold();
  try {
    const data = await readJsonBody(req, res, hold, { busy: '暂时无法接收通道请求', invalid: '通道请求格式无效' });
    if (data === undefined) return;
    const parsed = channelInput.safeParse(data);
    if (!parsed.success) {
      return sendBotJson(
        res,
        400,
        botError('BOT_INVALID_REQUEST', '通道请求字段无效', '请核对通道操作类型与必填字段后重试'),
      );
    }
    const identity = await readIdentity(deps.records.vault);
    if (!identity) {
      return sendBotJson(
        res,
        503,
        botError('BOT_DISABLED', '通道身份应用尚未启用', '请管理员在控制台配置扫码登录应用后重试'),
      );
    }
    const issuer = identityIssuer(identity.tenant);
    const channelId = sha256Hex(JSON.stringify([issuer, channel.bot]));
    const op = parsed.data;
    if (op.action === 'receipt') return handleChannelReceipt(res, deps, op, channelId);
    if (op.action === 'next') return handleChannelNext(res, deps, issuer, channelId);
    const member = await deps.records.principals.externalMember(issuer, op.subject);
    if (!member) {
      return sendBotJson(
        res,
        403,
        botError('BOT_CLIENT_FORBIDDEN', '外部身份未绑定有效成员', '请成员在控制台绑定外部身份并确认账号启用后重试'),
      );
    }
    if (op.action === 'authorize') return sendBotJson(res, 200, { bound: true });
    return handleChannelInbound(res, deps, member, op, issuer, channelId, channel.bot);
  } finally {
    hold.release();
  }
}

export const botOrigins = serverOrigins;

export async function refreshChannel(directory: string, vault: Vault, origins: ReadonlySet<string>) {
  if (!(await vault.has(channelProfileName))) return;
  const channel = await readChannel(vault);
  if (!channel) return;
  if (channel.enabled && !origins.has(new URL(channel.hub).origin)) {
    throw new CliError('适配器须访问本部署声明的 Hub 地址');
  }
  const stored = channel.enabled ? await readIdentity(vault) : null;
  const identity = stored ? { tenant: stored.tenant, application: stored.application, secret: stored.secret } : null;
  return callBot(
    directory,
    channel.enabled && identity ? { action: 'configure', identity, channel } : { action: 'disconnect' },
    'channel',
  );
}
