import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { request as unixRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { join } from 'node:path';
import { z } from 'zod';
import { EffectOutcomeSchema } from '../../contracts/generated/vocabulary.ts';
import { MemberNotificationIntent, MemberNotificationReceipt } from '../../contracts/src/resources.ts';
import type { Principal, Vault } from '../records/api.ts';
import { authenticateAccessOnly, requireAccessBearer } from './access-auth.ts';
import type { ServerDeps } from './api.ts';
import { fileDescriptor, transferBotFile, validateBotFiles, type BotFile } from './bot-files.ts';
import { CliError } from './errors.ts';
import { mediaTypeOf, readBody, sendJson, serverOrigins, type BodyBudget } from './http.ts';

const profileName = 'personal-bot.model';
const reviewerName = 'personal-bot.reviewer';
export const identityProfileName = 'personal-bot.identity';
export const channelProfileName = 'personal-bot.channel';
export const chatPath = '/api/bot/v1';

const word = z.string().trim().min(1).max(256).regex(/^[^\p{Cc}]+$/u);
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
  protocol: z.enum(['openai', 'anthropic', 'responses']),
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
  createHash('sha256').update(JSON.stringify(['bot-identity-v1', tenant])).digest('hex');

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

export async function readBotProfile(vault: Vault, reviewer = false): Promise<BotProfile | null> {
  const sealed = await vault.get(reviewer ? reviewerName : profileName);
  if (!sealed) return null;
  const result = profileSchema.safeParse(JSON.parse(Buffer.from(sealed).toString('utf8')));
  if (!result.success) throw new CliError('机器人配置不可读');
  return result.data;
}

export async function setBotProfile(vault: Vault, data: unknown, reviewer = false): Promise<void> {
  const parsed = profileSchema.safeParse(data);
  if (!parsed.success) {
    throw new CliError('请检查名称、协议、模型 ID、API 地址和密钥。地址须为 HTTPS 或本机 HTTP，密钥只填在密钥栏。');
  }
  await vault.put(reviewer ? reviewerName : profileName, JSON.stringify(parsed.data));
}

export async function disableBot(vault: Vault, reviewer = false): Promise<void> {
  await vault.remove(reviewer ? reviewerName : profileName);
}

export async function callBot(
  directory: string,
  frame: unknown,
  service: 'host' | 'channel' = 'host',
): Promise<{ status: number; body: unknown }> {
  const bytes = Buffer.from(JSON.stringify(frame));
  return new Promise((resolve) => {
    const unavailable = () => resolve({ status: 503, body: { message: '机器人宿主暂不可用' } });
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
    sendJson(res, body.reason === 'busy' ? 503 : 413, messages.busy ? { message: messages.busy } : {});
    return undefined;
  }
  try {
    return JSON.parse(body.bytes.toString('utf8'));
  } catch {
    sendJson(res, 400, messages.invalid ? { message: messages.invalid } : {});
    return undefined;
  }
}

export async function handleBot(req: IncomingMessage, res: ServerResponse, deps: ServerDeps, budget: BodyBudget): Promise<void> {
  if (req.method !== 'POST') {
    req.resume();
    return sendJson(res, 405, { message: '此地址只接受 POST' }, { allow: 'POST' });
  }
  const principal = await requireAccessBearer(req, res, deps.records.principals);
  if (!principal) return;
  if (mediaTypeOf(req) !== 'application/json') {
    req.resume();
    return sendJson(res, 415, { message: '需要 JSON' });
  }
  const hold = budget.hold();
  try {
    const input = await readJsonBody(req, res, hold, { busy: '暂时无法接收消息', invalid: '请求格式错误' });
    if (input === undefined) return;
    const op = chatOperation.safeParse(input);
    if (!op.success) return sendJson(res, 400, { message: '请求字段无效' });
    const renewed = await authenticateAccessOnly(deps.records.principals, req.headers.authorization ?? null);
    if (!renewed.ok || renewed.principal.id !== principal.id) return sendJson(res, 401, { message: '请重新登录' });
    const version = req.headers['circle-version'];
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
      return sendJson(res, 400, { message: '缺少 Circle 客户端版本' });
    }
    const config = op.data.action === 'send' ? await readBotProfile(deps.records.vault) : undefined;
    if (
      op.data.action === 'send' &&
      ((!op.data.text.trim() && !op.data.files?.length) ||
        !(await validateBotFiles(deps.config.dataDir, principal.id, op.data.files ?? [])))
    ) {
      return sendJson(res, 400, { message: '消息或附件不可用' });
    }
    if (config === null) return sendJson(res, 503, { message: '机器人模型尚未启用' });
    const identity =
      op.data.action === 'send' && (await deps.records.vault.has(identityProfileName))
        ? await readIdentity(deps.records.vault)
        : null;
    const issuer = identity ? identityIssuer(identity.tenant) : null;
    const route = issuer
      ? { source: 'desktop', issuer, subject: await deps.records.principals.externalSubject(principal.id, issuer) }
      : undefined;
    const result = await callBot(deps.config.dataDir, { owner: principal.id, op: op.data, version, config, route });
    if (op.data.action === 'discover' && result.status === 200 && (await deps.records.vault.has(profileName))) {
      const profile = await readBotProfile(deps.records.vault);
      if (profile) result.body = { ...(result.body as object), name: profile.name };
    }
    sendJson(res, result.status, result.body);
  } finally {
    hold.release();
  }
}

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
    state: z.enum(['sent', 'unknown', 'refused', 'not_sent']),
    acknowledgment: z.strictObject({ request: z.string().regex(/^[a-f0-9]{64}$/), code: z.number().int() }).optional(),
    reached_target: z.boolean().nullable(),
  }),
]);

type ChannelReceiptInput = Extract<z.infer<typeof channelInput>, { action: 'receipt' }>;
type ChannelInboundInput = Extract<z.infer<typeof channelInput>, { action: 'inbound' }>;

async function handleChannelFile(
  req: IncomingMessage,
  res: ServerResponse,
  deps: ServerDeps,
  channel: StoredChannel,
  sha: string,
): Promise<void> {
  const subject = req.headers['circle-member-subject'];
  if (typeof subject !== 'string' || subject.length > 1024) {
    req.resume();
    return sendJson(res, 403, {});
  }
  const identity = await readIdentity(deps.records.vault);
  if (!identity) {
    req.resume();
    return sendJson(res, 403, {});
  }
  const lookup = () =>
    deps.records.principals.externalMember(
      identityIssuer(identity.tenant),
      Buffer.from(subject, 'base64url').toString('utf8'),
    );
  const member = await lookup();
  if (!member) {
    req.resume();
    return sendJson(res, 403, {});
  }
  return transferBotFile(req, res, deps.config.dataDir, member.id, sha, async () => {
    const latest = await readChannel(deps.records.vault);
    return latest?.enabled === true && latest.token === channel.token && (await lookup())?.id === member.id;
  });
}

async function handleChannelReceipt(
  res: ServerResponse,
  deps: ServerDeps,
  op: ChannelReceiptInput,
  channelId: string,
): Promise<void> {
  const intent = await deps.records.store.getByKey('action', 'chat-intent:' + op.receipt);
  const declared = MemberNotificationIntent.safeParse(intent?.body);
  if (!intent || !declared.success || declared.data.channel !== channelId) return sendJson(res, 404, {});
  const state =
    (op.state === 'sent' && (op.acknowledgment?.code !== 0 || op.reached_target !== true)) ||
    (op.state === 'refused' && (!op.acknowledgment || op.acknowledgment.code === 0 || op.reached_target !== true)) ||
    (op.state === 'not_sent' && op.reached_target !== false)
      ? 'unknown'
      : op.state;
  const body = MemberNotificationReceipt.parse({
    schema: 'member-notification-receipt@1',
    member: declared.data.member,
    intent: intent.digest,
    receipt: op.receipt,
    outcome:
      state === 'sent'
        ? 'issued'
        : state === 'refused'
          ? 'target_rejected'
          : state === 'not_sent'
            ? 'not_dispatched'
            : 'unknown',
    acknowledgment: op.acknowledgment ?? null,
    reached_target: state === 'unknown' ? null : state === 'not_sent' ? false : true,
    missing: state === 'unknown' ? '未取得与本条消息对应的平台确认' : null,
    next: state === 'unknown' ? '核对目标侧记录，不自动重发' : null,
  });
  const record = await deps.records.store.put({
    kind: 'effect',
    schema: body.schema,
    provenance: 'observed',
    body,
    unique_key: 'chat-receipt:' + op.receipt,
    index: [{ key: 'chat.notification.intent', value: intent.digest }],
  });
  const effective = MemberNotificationReceipt.parse(record.body);
  const result = await callBot(deps.config.dataDir, {
    owner: 'channel',
    op: {
      action: 'receipt',
      receipt: op.receipt,
      state:
        effective.outcome === 'issued'
          ? 'sent'
          : effective.outcome === EffectOutcomeSchema.enum.target_rejected ||
              effective.outcome === EffectOutcomeSchema.enum.not_dispatched
            ? 'refused'
            : 'unknown',
    },
  });
  return sendJson(res, result.status, result.body);
}

async function handleChannelNext(
  res: ServerResponse,
  deps: ServerDeps,
  issuer: string,
  channelId: string,
): Promise<void> {
  const result = await callBot(deps.config.dataDir, { owner: 'channel', op: { action: 'claim', issuer } });
  if (result.status !== 200) return sendJson(res, result.status, {});
  const item = (
    result.body as {
      delivery?: {
        id: string;
        owner: string;
        subject: string;
        receipt: string;
        role: string;
        text: string;
        file?: BotFile;
      };
    }
  )?.delivery;
  if (!item) return sendJson(res, 200, { delivery: null });
  const member = await deps.records.principals.externalMember(issuer, item.subject);
  if (!member || member.id !== item.owner) {
    await callBot(deps.config.dataDir, {
      owner: 'channel',
      op: { action: 'receipt', receipt: item.receipt, state: 'refused' },
    });
    return sendJson(res, 200, { delivery: null });
  }
  const content = item.role === 'user' ? '来自 Mac：\n' + item.text : item.text;
  const sha256 = item.file?.sha256 ?? createHash('sha256').update(content).digest('hex');
  const size = item.file?.size ?? Buffer.byteLength(content);
  if (item.file && !(await validateBotFiles(deps.config.dataDir, member.id, [item.file]))) {
    return sendJson(res, 409, {});
  }
  const target = createHash('sha256').update(JSON.stringify([issuer, item.subject])).digest('hex');
  const intent = MemberNotificationIntent.parse({
    schema: 'member-notification-intent@1',
    kind: 'dispatch',
    event: item.id,
    receipt: item.receipt,
    member: member.id,
    issuer,
    channel: channelId,
    subject: target,
    sha256,
    size,
    name_sha256: item.file ? createHash('sha256').update(item.file.name).digest('hex') : null,
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
        provenance: 'observed',
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
      text: content,
      sha256,
      size,
      file: item.file ?? null,
    },
  });
}

async function handleChannelInbound(
  res: ServerResponse,
  deps: ServerDeps,
  member: Principal,
  op: ChannelInboundInput,
  issuer: string,
  bot: string,
): Promise<void> {
  if (
    (!op.text.trim() && !op.files?.length) ||
    !(await validateBotFiles(deps.config.dataDir, member.id, op.files ?? []))
  ) {
    return sendJson(res, 400, {});
  }
  const config = await readBotProfile(deps.records.vault);
  if (!config) return sendJson(res, 503, {});
  // RFC 9562 v8 deterministic request UUID derived from the inbound message identity.
  const hash = createHash('sha256').update(JSON.stringify([issuer, bot, op.subject, op.platformId])).digest();
  hash[6] = (hash[6] & 15) | 0x80;
  hash[8] = (hash[8] & 63) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  const request = [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
  const result = await callBot(deps.config.dataDir, {
    owner: member.id,
    op: { action: 'inbound', request, text: op.text, files: op.files },
    config,
    route: { source: 'channel', issuer, subject: op.subject },
  });
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
    return sendJson(res, 403, {});
  }
  if (!(await deps.records.vault.has(channelProfileName))) {
    req.resume();
    return sendJson(res, 401, {});
  }
  const channel = await readChannel(deps.records.vault);
  const supplied = Buffer.from(req.headers.authorization ?? '');
  const expected = Buffer.from('Bearer ' + channel?.token);
  if (!channel?.enabled || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    req.resume();
    return sendJson(res, 401, {});
  }
  if (sha !== undefined) return handleChannelFile(req, res, deps, channel, sha);
  const hold = budget.hold();
  try {
    const data = await readJsonBody(req, res, hold, { busy: '', invalid: '' });
    if (data === undefined) return;
    const parsed = channelInput.safeParse(data);
    if (!parsed.success) return sendJson(res, 400, {});
    const identity = await readIdentity(deps.records.vault);
    if (!identity) return sendJson(res, 503, {});
    const issuer = identityIssuer(identity.tenant);
    const channelId = createHash('sha256').update(JSON.stringify([issuer, channel.bot])).digest('hex');
    const op = parsed.data;
    if (op.action === 'receipt') return handleChannelReceipt(res, deps, op, channelId);
    if (op.action === 'next') return handleChannelNext(res, deps, issuer, channelId);
    const member = await deps.records.principals.externalMember(issuer, op.subject);
    if (!member) return sendJson(res, 403, {});
    if (op.action === 'authorize') return sendJson(res, 200, { bound: true });
    return handleChannelInbound(res, deps, member, op, issuer, channel.bot);
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
