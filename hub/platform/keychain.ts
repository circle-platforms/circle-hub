// Generic-password items of the macOS keychain, through /usr/bin/security: the vault master key and the operator token of
// a deployment, under its keychain service, each 32 bytes stored as 64 hexadecimal characters. A value goes only through
// stdin of `security -i`, never on a command line, never over an existing item, and is read back to check; it is never
// printed or logged. Reading never creates an item: a missing or malformed item is a fatal error.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { PLATFORM_VARIABLES, variable } from './environment.ts';
import { PlatformError } from './errors.ts';
import { OPERATOR_TOKEN_ITEM, UNNAMED_ITEM, VAULT_KEY_ITEM, type KeychainItem } from './keychain-items.ts';
import { resolveLayout } from './layout.ts';
import { runCommand, TIMEOUT_CODE, toolEnvironment, type CommandRunner } from './process.ts';
import {
  DEFAULT_KEYCHAIN_ACCOUNT,
  DEFAULT_KEYCHAIN_SERVICE,
  KeychainName,
  OPERATOR_TOKEN_ACCOUNT,
  readSettingsFile,
  resolveSettings,
  settingsPath,
  type PlatformSettings,
} from './settings.ts';

export { OPERATOR_TOKEN_ITEM, VAULT_KEY_ITEM, type KeychainItem } from './keychain-items.ts';

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
  /**
   * What the item holds, for messages. Default: the operator token for OPERATOR_TOKEN_ACCOUNT, else a neutral name
   * without advice. VAULT_KEY_ITEM is refused on OPERATOR_TOKEN_ACCOUNT.
   */
  item?: KeychainItem;
  /** A keychain file to use instead of the user's default keychain (tests use a temporary one). */
  keychain?: string;
  runner?: CommandRunner;
  security?: string;
}

export interface KeychainStore {
  readonly service: string;
  readonly account: string;
  /** Creates a new random value of KEY_BYTES; refuses when the item exists. */
  init(): Promise<void>;
  /**
   * Stores `value` (exactly KEY_BYTES bytes) in the form read() returns, 64 hexadecimal characters; refuses when the item
   * exists, then reads it back and compares. `value` itself is left as it is; the store's own copies are zeroed.
   */
  write(value: Uint8Array): Promise<void>;
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

/** The vault master key on the operator token's account: the two would be one keychain item. */
function reservedForVaultKey(service: string): PlatformError {
  return new PlatformError(
    `钥匙串账户 ${OPERATOR_TOKEN_ACCOUNT} 留给${OPERATOR_TOKEN_ITEM.label}，${VAULT_KEY_ITEM.label}不能用它（服务 ${service}）：两者会成为同一个钥匙串项，不执行`,
    `给${VAULT_KEY_ITEM.label}另选一个账户（默认 ${DEFAULT_KEYCHAIN_ACCOUNT}）`,
  );
}

/**
 * A copy of exactly the bytes `value` views, or undefined when it is not a Uint8Array of KEY_BYTES. A new array copies a
 * view's real contents: size getters a subclass overrides (byteLength, length) are not consulted.
 */
function keyBytes(value: unknown): Buffer | undefined {
  if (!(value instanceof Uint8Array)) return undefined;
  const bytes = Buffer.from(new Uint8Array(value).buffer);
  if (bytes.length === KEY_BYTES) return bytes;
  bytes.fill(0);
  return undefined;
}

export function keychainStore(options: KeychainOptions = {}): KeychainStore {
  const service = options.service ?? DEFAULT_KEYCHAIN_SERVICE;
  const account = options.account ?? DEFAULT_KEYCHAIN_ACCOUNT;
  const item = options.item ?? (account === OPERATOR_TOKEN_ACCOUNT ? OPERATOR_TOKEN_ITEM : UNNAMED_ITEM);
  const { label } = item;
  const runner = options.runner ?? runCommand;
  const security = options.security ?? '/usr/bin/security';
  const keychain = options.keychain;
  for (const [name, value] of [['服务名', service], ['账户名', account]] as const) {
    if (!KeychainName.safeParse(value).success) throw new PlatformError(`钥匙串${name}只能含字母、数字、点、下划线和连字符：${value}`);
  }
  if (item === VAULT_KEY_ITEM && account === OPERATOR_TOKEN_ACCOUNT) throw reservedForVaultKey(service);
  if (keychain !== undefined && (!isAbsolute(keychain) || /["\\\n\r\0]/.test(keychain))) {
    throw new PlatformError(`钥匙串文件必须是绝对路径，且不含双引号、反斜杠或换行：${keychain}`);
  }
  const target = keychain === undefined ? [] : [keychain];
  const where = keychain === undefined ? '默认钥匙串' : `钥匙串 ${keychain}`;
  const names = `服务 ${service}，账户 ${account}`;
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
    if (result.code === ITEM_NOT_FOUND) throw new PlatformError(`${where}里没有${label}（${names}）`, item.missingHint);
    if (result.code !== 0) throw failure(`读取${label}`, result.code, result.stderr);
    const text = result.stdout.trim();
    if (!KEY_TEXT.test(text)) throw new PlatformError(`${where}里的${label}格式不对（应为 ${KEY_BYTES} 字节的十六进制）`, '不要手改这个钥匙串项');
    // The decoded bytes are copied out and zeroed; the tool's text output is a string, which cannot be.
    const decoded = Buffer.from(text, 'hex');
    try {
      return Uint8Array.from(decoded);
    } finally {
      decoded.fill(0);
    }
  };

  const write = async (value: Uint8Array): Promise<void> => {
    // The bytes are checked after the copy, so the size checked is the size written.
    const bytes = keyBytes(value);
    if (bytes === undefined) throw new PlatformError(`${label}必须正好是 ${KEY_BYTES} 字节（钥匙串项里存成 ${KEY_BYTES * 2} 个十六进制字符），没有写入`);
    try {
      if ((await status()).present) throw new PlatformError(`${where}里已有${label}（${names}），不覆盖`, item.keepHint);
      const path = keychain === undefined ? '' : ` "${keychain}"`;
      // Only stdin carries the value: ps shows every process's arguments to every user. Without -U an item that appeared
      // meanwhile is never replaced: security refuses the duplicate (exit 45). The input line is a string: not zeroable.
      const result = await runner(security, ['-i'], { ...call, input: `add-generic-password -s ${service} -a ${account} -w ${bytes.toString('hex')}${path}\n` });
      if (result.code !== 0) throw failure(`写入${label}`, result.code, result.stderr);
      let stored: Uint8Array;
      try {
        stored = await read();
      } catch (error) {
        throw new PlatformError(`写入${label}后读不回来：${(error as Error).message}`, '检查钥匙串里这个项', { cause: error });
      }
      try {
        if (stored.length !== bytes.length || !timingSafeEqual(stored, bytes)) throw new PlatformError(`写入钥匙串后读回的${label}与写入的不一致`, '检查钥匙串里这个项');
      } finally {
        stored.fill(0);
      }
    } finally {
      bytes.fill(0);
    }
  };

  return {
    service,
    account,
    status,
    read,
    write,

    async init() {
      const value = randomBytes(KEY_BYTES);
      try {
        await write(value);
      } finally {
        value.fill(0);
      }
    },

    async delete() {
      const result = await runner(security, ['delete-generic-password', '-s', service, '-a', account, ...target], call);
      if (result.code === 0) return true;
      if (result.code === ITEM_NOT_FOUND) return false;
      throw failure(`删除${label}`, result.code, result.stderr);
    },
  };
}

/**
 * KeyProvider over the vault master key's item; the key is read once per process and kept in memory. Whatever `item`
 * calls it, the provider reads the vault master key, so the operator token's account is refused before any call.
 */
export function keychainKeyProvider(options: KeychainOptions = {}): Required<KeyProvider> {
  const store = keychainStore({ ...options, item: options.item ?? VAULT_KEY_ITEM });
  if (store.account === OPERATOR_TOKEN_ACCOUNT) throw reservedForVaultKey(store.service);
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

/** One keychain item of a deployment: what keychainStore needs to reach it and to name it. */
export interface KeychainItemName {
  service: string;
  account: string;
  item: KeychainItem;
}

/** The keychain items of one deployment, under its one keychain service. */
export interface DeploymentKeychainNames {
  vaultKey: KeychainItemName;
  /** Beside the vault master key: the same service, account OPERATOR_TOKEN_ACCOUNT. */
  operatorToken: KeychainItemName;
}

function namesOf(service: string, account: string, reserved: () => PlatformError): DeploymentKeychainNames {
  if (account === OPERATOR_TOKEN_ACCOUNT) throw reserved();
  return {
    vaultKey: { service, account, item: VAULT_KEY_ITEM },
    operatorToken: { service, account: OPERATOR_TOKEN_ACCOUNT, item: OPERATOR_TOKEN_ITEM },
  };
}

/** The items named by resolved deployment settings (their file is `path`); a vault key account that is reserved is refused. */
export function settingsKeychainNames(settings: Pick<PlatformSettings, 'keychainService' | 'keychainAccount'>, path: string): DeploymentKeychainNames {
  return namesOf(
    settings.keychainService,
    settings.keychainAccount,
    () =>
      new PlatformError(
        `部署设置（${path}）里${VAULT_KEY_ITEM.label}的钥匙串账户是 ${OPERATOR_TOKEN_ACCOUNT}：这个账户留给${OPERATOR_TOKEN_ITEM.label}，两者会成为同一个钥匙串项，不执行`,
        `把部署设置里的 keychain_account 改成另一个名字（例如 ${DEFAULT_KEYCHAIN_ACCOUNT}）；钥匙串里已有这个账户的${VAULT_KEY_ITEM.label}时，先在“钥匙串访问”里把那一项的账户改成同一个名字`,
      ),
  );
}

/** A keychain name from a variable, else `fallback`; one that keychainStore would refuse is refused here, by name. */
function keychainVariable(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = variable(env, name);
  if (value === undefined) return fallback;
  if (!KeychainName.safeParse(value).success) throw new PlatformError(`${name} 的写法不对：钥匙串名只能含字母、数字、点、下划线和连字符，最长 64 个字符`);
  return value;
}

/**
 * The keychain items of the deployment CIRCLE_HUB_DATA_DIR names, as hubKeyProvider resolves the vault master key's: the
 * deployment settings of that data root when it has them (a CIRCLE_HUB_KEYCHAIN_SERVICE or _ACCOUNT that disagrees is
 * refused), with the same rule as the platform's own commands (settingsKeychainNames); a data root without settings (a
 * development root) takes those variables, else the defaults. Without CIRCLE_HUB_DATA_DIR it refuses: platform commands
 * would act on the default data root, whose settings may name other items, so nothing is guessed (ensureHubDatabase
 * refuses the same). The operator token sits beside the vault master key (the same service, account
 * OPERATOR_TOKEN_ACCOUNT, which the vault master key may not use). Only the settings file is read; the keychain is not asked.
 */
export async function deploymentKeychainNames(env: NodeJS.ProcessEnv = process.env): Promise<DeploymentKeychainNames> {
  if (variable(env, PLATFORM_VARIABLES.dataDir) === undefined) {
    throw new PlatformError(
      `没有设置 ${PLATFORM_VARIABLES.dataDir}：钥匙串项由部署的数据根里的部署设置决定，不猜默认数据根`,
      `服务的环境由 circle-hub service install 写好；在 shell 里运行时把 ${PLATFORM_VARIABLES.dataDir} 设成部署的数据根`,
    );
  }
  const layout = resolveLayout(env);
  const file = await readSettingsFile(layout);
  if (file) return settingsKeychainNames(resolveSettings(file, env, layout), settingsPath(layout));
  const service = keychainVariable(env, PLATFORM_VARIABLES.keychainService, DEFAULT_KEYCHAIN_SERVICE);
  const account = keychainVariable(env, PLATFORM_VARIABLES.keychainAccount, DEFAULT_KEYCHAIN_ACCOUNT);
  return namesOf(
    service,
    account,
    () =>
      new PlatformError(
        `${PLATFORM_VARIABLES.keychainAccount} 是 ${OPERATOR_TOKEN_ACCOUNT}：这个账户留给${OPERATOR_TOKEN_ITEM.label}，${VAULT_KEY_ITEM.label}用它就和${OPERATOR_TOKEN_ITEM.label}成了同一个钥匙串项，不执行`,
        `给 ${PLATFORM_VARIABLES.keychainAccount} 另选一个名字，或删掉它（默认 ${DEFAULT_KEYCHAIN_ACCOUNT}）`,
      ),
  );
}
