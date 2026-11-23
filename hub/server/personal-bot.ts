import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { request as unixRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import type { ProtocolCode } from '../../contracts/generated/protocol-codes.ts';
import { ActionKindSchema, BotModelProtocolSchema, EffectOutcomeSchema, ProvenanceTypeSchema } from '../../contracts/generated/vocabulary.ts';
import { MemberBotInbound, MemberNotificationIntent, MemberNotificationReceipt } from '../../contracts/src/resources.ts';
import type { Principal, Vault } from '../records/api.ts';
import { authenticateAccessOnly, requireDirectAccessBearer } from './access-auth.ts';
import type { ServerDeps } from './api.ts';
import { fileDescriptor, promoteChannelStagedFiles, transferBotFile, validateBotFiles, type BotFile } from './bot-files.ts';
import { CliError } from './errors.ts';
import { mediaTypeOf, readBody, sendJson, serverOrigins, type BodyBudget } from './http.ts';

const profileName = 'personal-bot.model';
export const identityProfileName = 'personal-bot.identity';
export const channelProfileName = 'personal-bot.channel';
export const chatPath = '/api/bot/v1';

const SEMVER_2_0_0 =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;

const word = z.string().trim().min(1).max(256).regex(/^[^\p{Cc}]+$/u);
const botError = (code: ProtocolCode, message: string) => ({ code, message });
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

export async function setBotProfile(vault: Vault, data: unknown): Promise<void> {
  const parsed = profileSchema.safeParse(data);
  if (!parsed.success) {
    throw new CliError('请检查名称、协议、模型 ID、API 地址和密钥。地址须为 HTTPS 或本机 HTTP，密钥只填在密钥栏。');
  }
  await vault.put(profileName, JSON.stringify(parsed.data));
}

export async function disableBot(vault: Vault): Promise<void> {
  await vault.remove(profileName);
}

async function vaultSecrets(vault: Vault): Promise<string[]> {
  const found = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === 'string' && value.length >= 4) found.add(value);
  };
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

function mapHostError(status: number, body: unknown): { status: number; code: ProtocolCode; message: string; rawCode: string } {
  const obj = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const rawCode = typeof obj.code === 'string' ? obj.code : '';
  if (status === 409 && rawCode === 'version_mismatch') {
    return { status: 409, code: 'BOT_VERSION_MISMATCH', message: '客户端版本与机器人不匹配，请更新客户端', rawCode };
  }
  if (status === 409) {
    return { status: 409, code: 'BOT_CONFLICT', message: '个人助手当前正忙或状态冲突，请稍后重试', rawCode };
  }
  if (status === 400 && rawCode === 'invalid_version') {
    return { status: 400, code: 'BOT_VERSION_INVALID', message: '缺少或无效的客户端版本号', rawCode };
  }
  if (status === 400) {
    return { status: 400, code: 'BOT_INVALID_REQUEST', message: '个人助手请求无效，请核对参数后重试', rawCode };
  }
  if (status === 404) {
    return { status: 404, code: 'BOT_CONFLICT', message: '会话不存在或已不可用', rawCode };
  }
  const upstreamStatus = status === 502 || status === 503 ? status : 502;
  const upstreamMessages: Record<string, string> = {
    model_auth_failed: '个人助手上游模型凭证验证失败，请联系管理员检查配置',
    model_not_found: '个人助手配置的模型不可用，请联系管理员检查配置',
    model_output_blocked: '个人助手回复未能通过内容限制',
    model_empty_reply: '个人助手未生成有效回复，请稍后重试',
    model_unreachable: '个人助手上游模型服务当前不可达，请稍后重试',
  };
  return {
    status: upstreamStatus,
    code: 'BOT_UPSTREAM_UNAVAILABLE',
    message: upstreamMessages[rawCode] ?? '个人助手服务当前不可用，请稍后重试',
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
): Promise<void> {
  const secrets = await vaultSecrets(deps.records.vault);
  const obj = rawBody && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>) : {};
  const rawMessage = typeof obj.message === 'string' ? obj.message : typeof obj.error === 'string' ? obj.error : '';
  const sanitized = maskSecrets(rawMessage.slice(0, 512), secrets);
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

async function safeBotRuntimeDir(directory: string): Promise<boolean> {
  const runtimeDir = join(directory, 'bot-runtime');
  const info = await lstat(runtimeDir).catch(() => null);
  if (!info || info.isSymbolicLink() || !info.isDirectory()) return false;
  if ((info.mode & 0o777) !== 0o700) return false;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return false;
  return true;
}

export async function callBot(
  directory: string,
  frame: unknown,
  service: 'host' | 'channel' = 'host',
): Promise<{ status: number; body: unknown }> {
  if (!(await safeBotRuntimeDir(directory))) {
    return { status: 503, body: botError('BOT_UPSTREAM_UNAVAILABLE', '个人助手宿主目录权限或类型不安全') };
  }
  const bytes = Buffer.from(JSON.stringify(frame));
  return new Promise((resolve) => {
    const unavailable = () =>
      resolve({ status: 503, body: botError('BOT_UPSTREAM_UNAVAILABLE', '机器人宿主暂不可用') });
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
        res.on('error', unavailable);
        res.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > 8 * 1024 * 1024) res.destroy();
          else chunks.push(chunk);
        });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 503, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            unavailable();
          }
        });
      },
    );
    req.on('error', unavailable);
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
    sendJson(
      res,
      body.reason === 'busy' ? 503 : 413,
      botError(body.reason === 'busy' ? 'BOT_UPSTREAM_UNAVAILABLE' : 'BOT_QUOTA_EXCEEDED', messages.busy || '暂时无法接收消息'),
    );
    return undefined;
  }
  try {
    return JSON.parse(body.bytes.toString('utf8'));
  } catch {
    sendJson(res, 400, botError('BOT_INVALID_REQUEST', messages.invalid || '请求格式错误'));
    return undefined;
  }
}

export async function handleBot(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, budget: BodyBudget): Promise<void> {
  if (req.method !== 'POST') {
    req.resume();
    return sendJson(res, 405, botError('BOT_INVALID_REQUEST', '此地址只接受 POST'), { allow: 'POST' });
  }
  const principal = await requireDirectAccessBearer(req, res, deps.records.principals);
  if (!principal) return;
  if (mediaTypeOf(req) !== 'application/json') {
    req.resume();
    return sendJson(res, 415, botError('BOT_INVALID_REQUEST', '需要 JSON'));
  }
  const hold = budget.hold();
  try {
    const input = await readJsonBody(req, res, hold, { busy: '暂时无法接收消息', invalid: '请求格式错误' });
    if (input === undefined) return;
    const op = chatOperation.safeParse(input);
    if (!op.success) return sendJson(res, 400, botError('BOT_INVALID_REQUEST', '请求字段无效'));
    const renewed = await authenticateAccessOnly(deps.records.principals, req.headers.authorization ?? null);
    if (!renewed.ok || renewed.principal.id !== principal.id || renewed.client_id !== null) {
      return sendJson(
        res,
        renewed.ok ? 403 : 401,
        botError('BOT_CLIENT_FORBIDDEN', renewed.ok ? '无权限：第三方授权应用令牌不能访问个人助手' : '请重新登录'),
      );
    }
    const version = req.headers['bot-client-version'];
    if (typeof version !== 'string' || !SEMVER_2_0_0.test(version)) {
      return sendJson(res, 400, botError('BOT_VERSION_INVALID', '缺少或无效的 Bot-Client-Version 客户端版本号'));
    }
    const config = op.data.action === 'send' ? await readBotProfile(deps.records.vault) : undefined;
    if (
      op.data.action === 'send' &&
      ((!op.data.text.trim() && !op.data.files?.length) ||
        !(await validateBotFiles(deps.config.dataDir, principal.id, op.data.files ?? [])))
    ) {
      return sendJson(res, 400, botError('BOT_INVALID_REQUEST', '消息或附件不可用'));
    }
    if (config === null) return sendJson(res, 503, botError('BOT_DISABLED', '机器人模型尚未启用'));
    const identity =
      op.data.action === 'send' && (await deps.records.vault.has(identityProfileName))
        ? await readIdentity(deps.records.vault)
        : null;
    const issuer = identity ? identityIssuer(identity.tenant) : null;
    const route = issuer
      ? { source: 'desktop', issuer, subject: await deps.records.principals.externalSubject(principal.id, issuer) }
      : undefined;
    const result = await callBot(deps.config.dataDir, { owner: principal.id, op: op.data, version, config, route });
    if (result.status >= 400) {
      const mapped = mapHostError(result.status, result.body);
      await recordHostFailure(deps, principal.id, op.data.action, result.status, result.body, mapped.code);
      return sendJson(res, mapped.status, botError(mapped.code, mapped.message));
    }
    if (op.data.action === 'discover' && result.status === 200 && (await deps.records.vault.has(profileName))) {
      const profile = await readBotProfile(deps.records.vault);
      if (profile) result.body = { ...(result.body as object), name: profile.name };
    }
    if (config?.key && JSON.stringify(result.body).includes(config.key)) {
      await recordHostFailure(deps, principal.id, op.data.action, 502, { message: 'secret reflected in response' }, 'BOT_UPSTREAM_UNAVAILABLE');
      return sendJson(res, 502, botError('BOT_UPSTREAM_UNAVAILABLE', '个人助手响应异常，请稍后重试'));
    }
    sendJson(res, result.status, result.body);
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
  role: z.enum(['user', 'assistant']),
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
    return sendJson(res, 403, botError('BOT_CLIENT_FORBIDDEN', '缺少有效的通道成员身份头'));
  }
  const identity = await readIdentity(deps.records.vault);
  if (!identity) {
    req.resume();
    return sendJson(res, 403, botError('BOT_CLIENT_FORBIDDEN', '外部身份未绑定'));
  }
  const issuer = identityIssuer(identity.tenant);
  const subject = Buffer.from(subjectHeader, 'base64url').toString('utf8');
  const lookup = () => deps.records.principals.externalMember(issuer, subject);
  const member = await lookup();
  if (!member) {
    req.resume();
    return sendJson(res, 403, botError('BOT_CLIENT_FORBIDDEN', '外部身份未绑定有效成员'));
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
    return sendJson(res, 405, botError('BOT_INVALID_REQUEST', '只允许 GET 或 PUT'), { allow: 'GET, PUT' });
  }
  const receiptHeader = req.headers['bot-delivery-receipt'];
  const parsedReceipt = z.uuid().safeParse(receiptHeader);
  if (!parsedReceipt.success) {
    req.resume();
    return sendJson(res, 403, botError('BOT_CLIENT_FORBIDDEN', '下载附件须提供有效的 Bot-Delivery-Receipt'));
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
    return sendJson(res, 403, botError('BOT_CLIENT_FORBIDDEN', '未找到匹配当前成员与投递意图的附件授权'));
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
    return sendJson(res, 404, botError('BOT_CONFLICT', '未找到对应的投递意图记录'));
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

  const initial = await deps.records.store.getByKey('effect', 'chat-receipt:' + op.receipt);
  let effective = candidate;

  if (!initial) {
    const putInitial = await deps.records.store.put({
      kind: 'effect',
      schema: candidate.schema,
      provenance: ProvenanceTypeSchema.enum.declared,
      body: candidate,
      unique_key: 'chat-receipt:' + op.receipt,
      index: [{ key: 'chat.notification.intent', value: intent.digest }],
    });
    effective = MemberNotificationReceipt.parse(putInitial.body);
    if (!putInitial.created && !sameTerminalDecision(effective, candidate)) {
      return sendJson(res, 409, botError('BOT_CONFLICT', '投递回执已记录且与当前请求不一致'));
    }
  } else {
    const confirmed = await deps.records.store.getByKey('effect', 'chat-receipt:' + op.receipt + ':confirmed');
    const latest = MemberNotificationReceipt.parse((confirmed ?? initial).body);
    if (latest.outcome !== EffectOutcomeSchema.enum.unknown) {
      if (!sameTerminalDecision(latest, candidate)) {
        return sendJson(res, 409, botError('BOT_CONFLICT', '投递回执已进入终态，不能改为其他结果'));
      }
      effective = latest;
    } else if (candidate.outcome === EffectOutcomeSchema.enum.unknown) {
      effective = latest;
    } else {
      const confirmedBody = MemberNotificationReceipt.parse({ ...candidate, supersedes: initial.digest });
      const putConfirmed = await deps.records.store.put({
        kind: 'effect',
        schema: confirmedBody.schema,
        provenance: ProvenanceTypeSchema.enum.declared,
        body: confirmedBody,
        unique_key: 'chat-receipt:' + op.receipt + ':confirmed',
        index: [{ key: 'chat.notification.intent', value: intent.digest }],
      });
      effective = MemberNotificationReceipt.parse(putConfirmed.body);
      if (!putConfirmed.created && !sameTerminalDecision(effective, confirmedBody)) {
        return sendJson(res, 409, botError('BOT_CONFLICT', '投递回执确认结果与既有记录冲突'));
      }
    }
  }

  const result = await callBot(deps.config.dataDir, {
    owner: 'channel',
    op: { action: 'receipt', receipt: op.receipt, state: effective.outcome },
  });
  if (result.status >= 400) {
    const mapped = mapHostError(result.status, result.body);
    return sendJson(res, mapped.status, botError(mapped.code, mapped.message));
  }
  return sendJson(res, result.status, result.body);
}

async function handleChannelNext(
  res: ServerResponse,
  deps: ServerDeps,
  issuer: string,
  channelId: string,
): Promise<void> {
  const result = await callBot(deps.config.dataDir, { owner: 'channel', op: { action: 'claim', issuer } });
  if (result.status !== 200) {
    const mapped = mapHostError(result.status, result.body);
    return sendJson(res, mapped.status, botError(mapped.code, mapped.message));
  }
  const rawDelivery = (result.body as { delivery?: unknown })?.delivery;
  if (rawDelivery === undefined || rawDelivery === null) return sendJson(res, 200, { delivery: null });

  const parsed = deliverySchema.safeParse(rawDelivery);
  if (!parsed.success) {
    return sendJson(res, 502, botError('BOT_UPSTREAM_UNAVAILABLE', '个人助手宿主返回的投递载荷结构无效'));
  }
  const item = parsed.data;
  const member = await deps.records.principals.externalMember(issuer, item.subject);
  if (!member || member.id !== item.owner) {
    await callBot(deps.config.dataDir, {
      owner: 'channel',
      op: { action: 'receipt', receipt: item.receipt, state: EffectOutcomeSchema.enum.not_dispatched },
    });
    return sendJson(res, 200, { delivery: null });
  }
  if (item.file && !(await validateBotFiles(deps.config.dataDir, member.id, [item.file]))) {
    await callBot(deps.config.dataDir, {
      owner: 'channel',
      op: { action: 'receipt', receipt: item.receipt, state: EffectOutcomeSchema.enum.not_dispatched },
    });
    return sendJson(res, 409, botError('BOT_CONFLICT', '待投递的附件在本地不存在或已失效'));
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
  if (!held.created) return sendJson(res, 200, { delivery: null });
  return sendJson(res, 200, {
    delivery: {
      subject: item.subject,
      receipt: item.receipt,
      role: item.role,
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
    return sendJson(res, 400, botError('BOT_INVALID_REQUEST', '入站消息内容与附件不能同时为空'));
  }
  const config = await readBotProfile(deps.records.vault);
  if (!config) return sendJson(res, 503, botError('BOT_DISABLED', '机器人模型尚未启用'));

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
    at: (deps.now?.() ?? new Date()).toISOString(),
  });

  const existingInbound = await deps.records.store.getByKey('action', 'chat-inbound:' + request);
  if (existingInbound) {
    const prior = MemberBotInbound.safeParse(existingInbound.body);
    if (
      !prior.success ||
      prior.data.member !== inboundBody.member ||
      prior.data.text_sha256 !== inboundBody.text_sha256 ||
      prior.data.text_size !== inboundBody.text_size ||
      JSON.stringify(prior.data.files) !== JSON.stringify(inboundBody.files) ||
      !(await validateBotFiles(deps.config.dataDir, member.id, files))
    ) {
      return sendJson(res, 409, botError('BOT_CONFLICT', '入站消息请求与既有记录不一致'));
    }
  } else {
    const promoted = await promoteChannelStagedFiles(deps.config.dataDir, member.id, files, {
      now: () => (deps.now?.() ?? new Date()).getTime(),
    });
    if (!promoted.ok) {
      return sendJson(res, promoted.status, botError(promoted.code, promoted.message));
    }
    await deps.records.store.put({
      kind: 'action',
      schema: inboundBody.schema,
      provenance: ProvenanceTypeSchema.enum.declared,
      body: inboundBody,
      unique_key: 'chat-inbound:' + request,
      index: [{ key: 'chat.inbound.owner', value: member.id }],
    });
  }

  const result = await callBot(deps.config.dataDir, {
    owner: member.id,
    op: { action: 'inbound', request, text: op.text, files: op.files },
    config,
    route: { source: 'channel', issuer, subject: op.subject },
  });
  if (result.status >= 400) {
    const mapped = mapHostError(result.status, result.body);
    await recordHostFailure(deps, member.id, 'inbound', result.status, result.body, mapped.code);
    return sendJson(res, mapped.status, botError(mapped.code, mapped.message));
  }
  return sendJson(res, result.status, { accepted: result.status === 200 });
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
    return sendJson(res, 403, botError('BOT_CLIENT_FORBIDDEN', '通道入口请求不被允许'));
  }
  if (!(await deps.records.vault.has(channelProfileName))) {
    req.resume();
    return sendJson(res, 401, botError('BOT_CLIENT_FORBIDDEN', '通道令牌未配置或无效'));
  }
  const channel = await readChannel(deps.records.vault);
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + channel?.token);
  if (!channel?.enabled || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    req.resume();
    return sendJson(res, 401, botError('BOT_CLIENT_FORBIDDEN', '通道凭证无效或已停用'));
  }
  if (sha !== undefined) return handleChannelFile(req, res, deps, channel, sha);
  const hold = budget.hold();
  try {
    const data = await readJsonBody(req, res, hold, { busy: '暂时无法接收通道请求', invalid: '通道请求格式无效' });
    if (data === undefined) return;
    const parsed = channelInput.safeParse(data);
    if (!parsed.success) return sendJson(res, 400, botError('BOT_INVALID_REQUEST', '通道请求字段无效'));
    const identity = await readIdentity(deps.records.vault);
    if (!identity) return sendJson(res, 503, botError('BOT_DISABLED', '通道身份应用尚未启用'));
    const issuer = identityIssuer(identity.tenant);
    const channelId = sha256Hex(JSON.stringify([issuer, channel.bot]));
    const op = parsed.data;
    if (op.action === 'receipt') return handleChannelReceipt(res, deps, op, channelId);
    if (op.action === 'next') return handleChannelNext(res, deps, issuer, channelId);
    const member = await deps.records.principals.externalMember(issuer, op.subject);
    if (!member) return sendJson(res, 403, botError('BOT_CLIENT_FORBIDDEN', '外部身份未绑定有效成员'));
    if (op.action === 'authorize') return sendJson(res, 200, { bound: true });
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
  const identity = channel.enabled ? await readIdentity(vault) : null;
  return callBot(
    directory,
    channel.enabled && identity ? { action: 'configure', identity, channel } : { action: 'disconnect' },
    'channel',
  );
}
