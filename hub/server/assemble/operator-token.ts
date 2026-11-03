// The operator token: the admin token the CLI's state-changing commands act with. It comes from CIRCLE_HUB_TOKEN or, when
// that is not set, from the deployment's private key file (hub/platform fileKeyStore under <data root>/keys, the deployment's
// key service resolved as the vault master key's is, account operator-token), on every platform: the Hub no longer uses
// the macOS keychain (decision 137). The file holds the token's 32 random bytes. `init-admin`, `operator-token set` and
// `operator-token reissue` write it, never over an existing file, and read it back to confirm. No message ever carries the
// token or its bytes.
import { DEFAULT_KEY_SERVICE, OPERATOR_TOKEN_ACCOUNT, OPERATOR_TOKEN_ITEM, PLATFORM_VARIABLES, fileKeyStore, keyDirectory, readSettingsFile, resolveLayout, resolveSettings } from '../../platform/api.ts';
import { hintOf, messageOf } from './errors.ts';

/** The environment variable a shell or a script gives the operator token in. */
export const OPERATOR_TOKEN_VARIABLE = 'CIRCLE_HUB_TOKEN';
/** Account of the operator token's key file (beside the vault master key's account of the same service). */
export { OPERATOR_TOKEN_ACCOUNT };

export interface OperatorTokenStore {
  /** Where the token is kept, for messages (never the token). */
  readonly where: string;
  present(): Promise<boolean>;
  /** The token, or null when none is stored. */
  read(): Promise<string | null>;
  /** Stores a token; refuses when one is stored already. */
  write(token: string): Promise<void>;
  /** Removes only the local operator token; true when there was one. The vault master key and the records are untouched. */
  remove(): Promise<boolean>;
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
 * An error of hub/platform fileKeyStore about this file, with the platform's own hint. The store is made with the
 * platform's OPERATOR_TOKEN_ITEM, so its messages name the operator token themselves and carry no vault key advice.
 */
function aboutToken(error: unknown): OperatorTokenError {
  return new OperatorTokenError(messageOf(error), hintOf(error), { cause: error });
}

/**
 * The key service of the deployment, resolved as hub/platform hubKeyProvider resolves the vault master key's: the
 * deployment settings of the data root CIRCLE_HUB_DATA_DIR names, when it has them; otherwise the default. So the operator
 * token's file always sits beside the vault key of the same deployment.
 */
export async function deploymentKeyService(env: NodeJS.ProcessEnv): Promise<string> {
  const root = env[PLATFORM_VARIABLES.dataDir];
  if (root === undefined || root === '') return DEFAULT_KEY_SERVICE;
  const layout = resolveLayout(env);
  const file = await readSettingsFile(layout);
  if (file === undefined) return DEFAULT_KEY_SERVICE;
  return resolveSettings(file, env, layout).keyService;
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

/**
 * The operator token's key file of the data root `root`, on every platform: beside the vault master key's under the same
 * service, never included in backups. Errors of the platform store keep their hint (OperatorTokenError).
 */
export function fileOperatorTokens(root: string, service: string): OperatorTokenStore {
  const store = fileKeyStore({root, service, account: OPERATOR_TOKEN_ACCOUNT, item: OPERATOR_TOKEN_ITEM});
  const where = `私有密钥文件（${keyDirectory(root)}，服务 ${service}，账户 ${OPERATOR_TOKEN_ACCOUNT}）`;
  const about = async <T>(action: () => Promise<T>): Promise<T> => {
    try { return await action(); } catch (error) { throw aboutToken(error); }
  };
  return {
    where,
    present: () => about(async () => (await store.status()).present),
    remove: () => about(() => store.delete()),
    read: () => about(async () => {
      if (!(await store.status()).present) return null;
      const bytes = await store.read();
      const copy = Buffer.from(bytes);
      try { return copy.toString('base64url'); } finally { bytes.fill(0); copy.fill(0); }
    }),
    async write(token: string) {
      const bytes = tokenBytes(token);
      if (bytes === null) throw new Error('这个令牌不是 Hub 签发的格式，不能保存');
      try { await about(() => store.write(bytes)); } finally { bytes.fill(0); }
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
    async remove() {
      const had = state.value !== null;
      state.value = null;
      return had;
    },
  };
  return state;
}
