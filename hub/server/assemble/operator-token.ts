// The operator token: the admin token the CLI's state-changing commands act with. It comes from CIRCLE_HUB_TOKEN or, when
// that is not set, from a generic-password item of the macOS keychain (the deployment's keychain service, resolved as the
// vault master key's is, account operator-token). The item is read through hub/platform keychainStore; it holds the token's
// 32 random bytes as 64 hexadecimal characters, the form keychainStore reads. `init-admin`, `operator-token set` and
// `operator-token reissue` write it, through stdin of `security -i`, never on a command line, and read it back to confirm.
// No message ever carries the token or its bytes.
import { spawn } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { OPERATOR_TOKEN_ITEM, PLATFORM_VARIABLES, fileKeyStore, keychainStore, readSettingsFile, resolveLayout, resolveSettings, type CommandRunner } from '../../platform/api.ts';
import { hintOf, messageOf } from './errors.ts';

/** The environment variable a shell or a script gives the operator token in. */
export const OPERATOR_TOKEN_VARIABLE = 'CIRCLE_HUB_TOKEN';
/** Keychain account of the operator token item (beside the vault master key's account of the same service). */
export const OPERATOR_TOKEN_ACCOUNT = 'operator-token';
/** Time limit of a security call: a locked keychain waits for its unlock dialog (hub/platform keychain). */
const SECURITY_TIMEOUT_MS = 60_000;
const TIMEOUT_CODE = 124;
const OUTPUT_LIMIT = 64 * 1024;

export interface OperatorTokenStore {
  /** Where the token is kept, for messages (never the token). */
  readonly where: string;
  present(): Promise<boolean>;
  /** The token, or null when none is stored. */
  read(): Promise<string | null>;
  /** Stores a token; refuses when one is stored already. */
  write(token: string): Promise<void>;
  /** Removes only the local operator-token item, when supported by the storage backend. */
  remove?(): Promise<boolean>;
}

/** A failure of the operator token item, with the operator's next step (`hint`, printed by the CLI after the message). */
export class OperatorTokenError extends Error {
  readonly hint: string | null;
  constructor(message: string, hint: string | null = null, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'OperatorTokenError';
    this.hint = hint;
  }
}

/**
 * An error of hub/platform keychainStore about this item, with the platform's own hint. The store is made with the
 * platform's OPERATOR_TOKEN_ITEM, so its messages name the operator token themselves and carry no vault key advice.
 */
function aboutToken(error: unknown): OperatorTokenError {
  return new OperatorTokenError(messageOf(error), hintOf(error), { cause: error });
}

/**
 * The keychain service of the deployment, resolved as hub/platform hubKeyProvider resolves the vault master key's: the
 * deployment settings of the data root CIRCLE_HUB_DATA_DIR names, when it has them (a CIRCLE_HUB_KEYCHAIN_SERVICE that
 * disagrees is refused there, as for every platform command); otherwise `fallback` (hub/config's: the variable, else the
 * default). So the operator token item always sits beside the vault key of the same deployment.
 */
export async function deploymentKeychainService(env: NodeJS.ProcessEnv, fallback: string): Promise<string> {
  const root = env[PLATFORM_VARIABLES.dataDir];
  if (root === undefined || root === '') return fallback;
  const layout = resolveLayout(env);
  const file = await readSettingsFile(layout);
  if (file === undefined) return fallback;
  return resolveSettings(file, env, layout).keychainService;
}

/** The 32 bytes of a Hub token (records issues base64url of 32 random bytes); null for anything else. */
export function tokenBytes(token: string): Buffer | null {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const bytes = Buffer.from(token, 'base64url');
  return bytes.length === 32 && bytes.toString('base64url') === token ? bytes : null;
}

/** Reads CIRCLE_HUB_TOKEN and removes it from the environment object (no child process or configuration check sees it). */
export function takeEnvironmentToken(env: NodeJS.ProcessEnv): string | null {
  if (!Object.hasOwn(env, OPERATOR_TOKEN_VARIABLE)) return null;
  const value = env[OPERATOR_TOKEN_VARIABLE];
  try {
    delete env[OPERATOR_TOKEN_VARIABLE];
  } catch {
    // A frozen environment keeps it; the configuration check then names the variable.
  }
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Removes anything shaped like a key or the token from tool output before it reaches a message. */
function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length > 0) out = out.split(secret).join('[已隐去]');
  return out.replace(/[0-9a-fA-F]{32,}/g, '[已隐去]').replace(/[A-Za-z0-9_-]{40,}/g, '[已隐去]').trim().slice(0, 500);
}

/** A minimal environment for security: no inherited variables (a CIRCLE_HUB_TOKEN never reaches it). */
function securityEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C', LC_ALL: 'C' };
  if (process.env.HOME) env.HOME = process.env.HOME;
  if (process.env.USER) env.USER = process.env.USER;
  return env;
}

/** Runs a tool without a shell; stdin carries the input (it may hold a secret and is never logged). */
export const runTool: CommandRunner = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    const child = spawn(command, [...args], { env: options.env ?? securityEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, options.timeoutMs ?? SECURITY_TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk;
    });
    child.stdin.on('error', () => {});
    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`无法运行 ${command}：${error.message}`));
    });
    child.once('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: timedOut ? TIMEOUT_CODE : (code ?? 1), stdout, stderr });
    });
    child.stdin.end(options.input ?? '');
  });

export interface KeychainTokenOptions {
  /** Keychain service of the deployment (the vault master key's). */
  service: string;
  account?: string;
  /** A keychain file instead of the user's default keychain (tests use a temporary one). */
  keychain?: string;
  /** Replaces the security tool for every call (tests). */
  runner?: CommandRunner;
  security?: string;
}

/** The operator token in the macOS keychain: read through hub/platform keychainStore, written through stdin only. */
export function keychainOperatorTokens(options: KeychainTokenOptions): OperatorTokenStore {
  const account = options.account ?? OPERATOR_TOKEN_ACCOUNT;
  const security = options.security ?? '/usr/bin/security';
  const store = keychainStore({
    service: options.service,
    account,
    // Named as the operator token whatever the account (the platform's default name follows the account only).
    item: OPERATOR_TOKEN_ITEM,
    security,
    ...(options.keychain === undefined ? {} : { keychain: options.keychain }),
    ...(options.runner === undefined ? {} : { runner: options.runner }),
  });
  const runner = options.runner ?? runTool;
  const where = `钥匙串${options.keychain === undefined ? '' : ` ${options.keychain}`}（服务 ${options.service}，账户 ${account}）`;

  const present = async (): Promise<boolean> => {
    try {
      return (await store.status()).present;
    } catch (error) {
      throw aboutToken(error);
    }
  };

  const read = async (): Promise<string | null> => {
    if (!(await present())) return null;
    let bytes: Buffer;
    try {
      bytes = Buffer.from(await store.read());
    } catch (error) {
      throw aboutToken(error);
    }
    try {
      return bytes.toString('base64url');
    } finally {
      bytes.fill(0);
    }
  };

  return {
    where,
    present,
    read,
    async write(token: string) {
      const bytes = tokenBytes(token);
      if (bytes === null) throw new Error('这个令牌不是 Hub 签发的格式，不能存入钥匙串');
      const hex = bytes.toString('hex');
      try {
        if (await present()) throw new Error(`${where}里已经有操作令牌，不覆盖`);
        const path = options.keychain === undefined ? '' : ` "${options.keychain}"`;
        // The token travels in stdin of `security -i` only, never on a command line (ps shows arguments to every user).
        const result = await runner(security, ['-i'], { input: `add-generic-password -s ${options.service} -a ${account} -w ${hex}${path}\n`, timeoutMs: SECURITY_TIMEOUT_MS });
        if (result.code !== 0) {
          throw new Error(
            result.code === TIMEOUT_CODE
              ? `写入${where}超时：钥匙串可能已锁定，正在等解锁`
              : `写入${where}失败（security 退出码 ${result.code}）：${scrub(result.stderr, [token, hex]) || '没有输出'}`,
          );
        }
        const back = await read();
        const same = back !== null && back.length === token.length && timingSafeEqual(Buffer.from(back), Buffer.from(token));
        if (!same) throw new Error(`写入${where}后读回的令牌与写入的不一致`);
      } finally {
        bytes.fill(0);
      }
    },
  };
}

/** Linux operator item, stored separately from the vault master key and never included in backups. */
export function fileOperatorTokens(root: string, service: string): OperatorTokenStore {
  const store = fileKeyStore({root, service, account: OPERATOR_TOKEN_ACCOUNT, item: OPERATOR_TOKEN_ITEM});
  const where = '密钥文件中的操作令牌';
  return {
    where,
    async present() { return (await store.status()).present; },
    async remove() { return store.delete(); },
    async read() {
      if (!(await store.status()).present) return null;
      const bytes = await store.read();
      const copy = Buffer.from(bytes);
      try { return copy.toString('base64url'); } finally { bytes.fill(0); copy.fill(0); }
    },
    async write(token: string) {
      const bytes = tokenBytes(token);
      if (bytes === null) throw new Error('这个令牌不是 Hub 签发的格式，不能保存');
      try { await store.write(bytes); } finally { bytes.fill(0); }
    },
  };
}

/** An operator token store in memory (tests, and callers that keep the token themselves). */
export function memoryOperatorTokens(initial: string | null = null, where = '内存'): OperatorTokenStore & { value: string | null } {
  const state = {
    value: initial,
    where,
    async present() {
      return state.value !== null;
    },
    async read() {
      return state.value;
    },
    async write(token: string) {
      if (tokenBytes(token) === null) throw new Error('这个令牌不是 Hub 签发的格式，不能保存');
      if (state.value !== null) throw new Error(`${where}里已经有操作令牌，不覆盖`);
      state.value = token;
    },
  };
  return state;
}
