// The vault master key as a generic password item in the macOS keychain, through /usr/bin/security.
// The key is written only through stdin of `security -i`, never on a command line, and never printed or logged.
// Reading never creates a key: a missing or malformed item is a fatal error.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { PlatformError } from './errors.ts';
import { runCommand, TIMEOUT_CODE, toolEnvironment, type CommandRunner } from './process.ts';
import { DEFAULT_KEYCHAIN_ACCOUNT, DEFAULT_KEYCHAIN_SERVICE, KeychainName } from './settings.ts';

/** Same structural interface as the records package's vault key source (hub/records/api.ts KeyProvider). */
export interface KeyProvider {
  /** Throws when no key exists; never creates one. */
  getKey(): Promise<Uint8Array>;
  /** Creates a key when none exists; refuses to replace an existing one. */
  initKey?(): Promise<void>;
}

export interface KeychainOptions {
  service?: string;
  account?: string;
  /** A keychain file to use instead of the user's default keychain (tests use a temporary one). */
  keychain?: string;
  runner?: CommandRunner;
  security?: string;
}

export interface KeychainStore {
  readonly service: string;
  readonly account: string;
  /** Creates a new random key; refuses when one exists. */
  init(): Promise<void>;
  status(): Promise<{ present: boolean }>;
  read(): Promise<Uint8Array>;
  /** True when an item was deleted. */
  delete(): Promise<boolean>;
}

export const KEY_BYTES = 32;
/**
 * Time limit of every security call. A locked keychain makes security wait for the unlock dialog; without a limit a
 * starting server would hang there for good, and launchd never restarts a process that is still alive.
 */
export const SECURITY_TIMEOUT_MS = 60_000;
const ITEM_NOT_FOUND = 44;
const KEY_TEXT = /^[0-9a-f]{64}$/;

/** Removes anything shaped like a key from tool output before it reaches a message. */
function scrub(text: string): string {
  return text.replace(/[0-9a-fA-F]{32,}/g, '[已隐去]').trim().slice(0, 500);
}

export function keychainStore(options: KeychainOptions = {}): KeychainStore {
  const service = options.service ?? DEFAULT_KEYCHAIN_SERVICE;
  const account = options.account ?? DEFAULT_KEYCHAIN_ACCOUNT;
  const runner = options.runner ?? runCommand;
  const security = options.security ?? '/usr/bin/security';
  const keychain = options.keychain;
  for (const [name, value] of [['服务名', service], ['账户名', account]] as const) {
    if (!KeychainName.safeParse(value).success) throw new PlatformError(`钥匙串${name}只能含字母、数字、点、下划线和连字符：${value}`);
  }
  if (keychain !== undefined && (!isAbsolute(keychain) || /["\\\n\r\0]/.test(keychain))) {
    throw new PlatformError(`钥匙串文件必须是绝对路径，且不含双引号、反斜杠或换行：${keychain}`);
  }
  const target = keychain === undefined ? [] : [keychain];
  const where = keychain === undefined ? '默认钥匙串' : `钥匙串 ${keychain}`;
  const env = toolEnvironment();
  const call = { env, timeoutMs: SECURITY_TIMEOUT_MS };
  const failure = (action: string, code: number, stderr: string) =>
    code === TIMEOUT_CODE
      ? new PlatformError(`${action}超时（${SECURITY_TIMEOUT_MS / 1000} 秒没有结果）：${where}可能已锁定，正在等解锁`, '在这台 Mac 的登录会话里解锁钥匙串（钥匙串访问，或 security unlock-keychain），再重试')
      : new PlatformError(`${action}失败（security 退出码 ${code}）：${scrub(stderr) || '没有输出'}`);

  const status = async (): Promise<{ present: boolean }> => {
    // Without -w or -g, security prints only the item's attributes, never the secret.
    const result = await runner(security, ['find-generic-password', '-s', service, '-a', account, ...target], call);
    if (result.code === 0) return { present: true };
    if (result.code === ITEM_NOT_FOUND) return { present: false };
    throw failure('查询钥匙串', result.code, result.stderr);
  };

  const read = async (): Promise<Uint8Array> => {
    const result = await runner(security, ['find-generic-password', '-s', service, '-a', account, '-w', ...target], call);
    if (result.code === ITEM_NOT_FOUND) {
      throw new PlatformError(`${where}里没有保险库主密钥（服务 ${service}，账户 ${account}）`, '先运行 circle-hub key init');
    }
    if (result.code !== 0) throw failure('读取保险库主密钥', result.code, result.stderr);
    const text = result.stdout.trim();
    if (!KEY_TEXT.test(text)) throw new PlatformError(`${where}里的保险库主密钥格式不对（应为 ${KEY_BYTES} 字节的十六进制）`, '不要手改这个钥匙串项');
    return Uint8Array.from(Buffer.from(text, 'hex'));
  };

  return {
    service,
    account,
    status,
    read,

    async init() {
      if ((await status()).present) {
        throw new PlatformError(`${where}里已有保险库主密钥（服务 ${service}，账户 ${account}），不覆盖`, '换钥匙会让已加密的保险库条目无法解开');
      }
      const key = randomBytes(KEY_BYTES);
      const text = key.toString('hex');
      const path = keychain === undefined ? '' : ` "${keychain}"`;
      const result = await runner(security, ['-i'], { ...call, input: `add-generic-password -s ${service} -a ${account} -w ${text}${path}\n` });
      if (result.code !== 0) throw failure('写入保险库主密钥', result.code, result.stderr);
      const stored = Buffer.from(await read());
      const same = stored.length === key.length && timingSafeEqual(stored, key);
      stored.fill(0);
      key.fill(0);
      if (!same) throw new PlatformError('写入钥匙串后读回的主密钥与写入的不一致', '检查钥匙串里这个项');
    },

    async delete() {
      const result = await runner(security, ['delete-generic-password', '-s', service, '-a', account, ...target], call);
      if (result.code === 0) return true;
      if (result.code === ITEM_NOT_FOUND) return false;
      throw failure('删除保险库主密钥', result.code, result.stderr);
    },
  };
}

/** KeyProvider over the keychain item; the key is read once per process and kept in memory. */
export function keychainKeyProvider(options: KeychainOptions = {}): Required<KeyProvider> {
  const store = keychainStore(options);
  let cached: Promise<Uint8Array> | undefined;
  return {
    getKey() {
      cached ??= store.read().catch((error: unknown) => {
        cached = undefined;
        throw error;
      });
      return cached.then((key) => Uint8Array.from(key));
    },
    initKey() {
      return store.init();
    },
  };
}
