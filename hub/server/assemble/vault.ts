// The vault at start-up and the typed-judgment service's key. The vault master key comes from the key provider the records
// were opened with (hub/platform hubKeyProvider in a deployment): it is only read here, never created, and a missing or
// wrong key stops `serve` (or refuses the one CLI command that needs it). The key of the typed-judgment service (K04) is a
// vault entry of its own; when it is absent the knowledge package runs without model placement and the assembly says so.
import type { HubConfig } from '../../config/index.ts';
import { HttpJev, isJevApiKey, type JevClient } from '../../jev/api.ts';
import { checkVaultKey, type RecordsKit } from '../../records/api.ts';
import { AssemblyError, hintOf, messageOf } from './errors.ts';

/** Vault entry of the typed-judgment service's API key. */
export const JEV_KEY_ENTRY = 'jev.api-key';
/** How `secret set` names it: the service as the resource, the key as the entry (`circle-hub secret set jev api-key`). */
export const JEV_SECRET = { resource: 'jev', entry: 'api-key' } as const;
/** The key form HttpJev sends (hub/jev), checked when the key is set so that a wrong value is refused at once. */
export const isJevKey = isJevApiKey;

/** What to do when the key is unavailable and the vault holds nothing yet (the first deployment, or a key that went missing). */
const FIRST_KEY_HINT = '第一次部署时用 circle-hub key init 建立主密钥；已有密钥库时恢复原来的钥匙串项，不要新建';
/** The vault holds entries sealed with the original key: only that key opens them, so a new key would lose them. */
const RESTORE_KEY_HINT = '密钥库里已有用原来的主密钥封存的条目：恢复原来的钥匙串项；不要运行 circle-hub key init，新建的主密钥打不开这些条目';

/**
 * The operator's next step when the key is unavailable. A vault that holds entries proves a key existed (listing names needs
 * no key), so the key provider's own advice (hub/platform says `key init` for a missing item) is used only for an empty vault.
 */
async function keyHint(records: Pick<RecordsKit, 'vault'>, error: unknown): Promise<string> {
  let entries: number | null = null;
  try {
    entries = (await records.vault.list()).length;
  } catch {
    // An unreadable vault directory: give the advice that loses nothing.
    return RESTORE_KEY_HINT;
  }
  if (entries > 0) return RESTORE_KEY_HINT;
  return hintOf(error) ?? FIRST_KEY_HINT;
}

/**
 * Reads the vault master key once (and checks it against the vault); throws AssemblyError when it is missing or wrong.
 * `command`: the key is needed by one CLI command, which is refused, rather than by `serve`, which does not start.
 */
export async function requireVaultKey(records: Pick<RecordsKit, 'vault'>, options: { command?: boolean } = {}): Promise<void> {
  try {
    await checkVaultKey(records.vault);
  } catch (error) {
    const refused = options.command === true ? '这个命令要用密钥库，没有执行' : 'Hub 不启动';
    throw new AssemblyError(`密钥库主密钥不可用，${refused}：${messageOf(error)}`, await keyHint(records, error), { cause: error });
  }
}

/** Null when the vault master key opens the vault, else why not (for a listing that shows what it cannot read). */
export async function vaultKeyProblem(records: Pick<RecordsKit, 'vault'>): Promise<string | null> {
  try {
    await checkVaultKey(records.vault);
    return null;
  } catch (error) {
    return messageOf(error);
  }
}

export interface JevOptions {
  /** Base URL of the service (tests: a loopback stub); default the client's. */
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
}

/**
 * HttpJev pinned to the configured model, with its key read from the vault on every attempt (never kept in memory between
 * calls); null when the vault has no key for the service.
 */
export async function jevFromVault(records: Pick<RecordsKit, 'vault'>, config: Pick<HubConfig, 'jev'>, options: JevOptions = {}): Promise<JevClient | null> {
  if (!(await records.vault.has(JEV_KEY_ENTRY))) return null;
  return new HttpJev({
    apiKey: async () => (await records.vault.getText(JEV_KEY_ENTRY)) ?? '',
    model: config.jev.model,
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

/** What the operator is told when the Hub runs without the typed-judgment service. */
export const NO_JEV_NOTICE = `密钥库里没有类型化判断服务的密钥（条目 ${JEV_KEY_ENTRY}）：知识同步不做模型归类，代码挂不上的片段留在根下、标为未归类；用 circle-hub secret set ${JEV_SECRET.resource} ${JEV_SECRET.entry} 设置后重启 Hub`;
