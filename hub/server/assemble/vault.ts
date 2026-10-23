// The vault at start-up. The vault master key comes from the key provider the records were opened with (hub/platform
// hubKeyProvider in a deployment): it is only read here, never created, and a missing or wrong key stops `serve` (or
// refuses the one CLI command that needs it). The Hub calls no model (owner decision 2026-10-22): there is no service
// key of the Hub's own in the vault any more, and an entry left over from before the removal is never read.
import { checkVaultKey, type RecordsKit } from '../../records/api.ts';
import { AssemblyError, hintOf, messageOf } from './errors.ts';

/** What to do when the key is unavailable and the vault holds nothing yet (the first deployment, or a key that went missing). */
const FIRST_KEY_HINT = '第一次部署时用 circle-hub key init 建立主密钥；已有密钥库时恢复原来的钥匙串项，不要新建';
/** The vault holds entries sealed with the original key: only that key opens them, so a new key would lose them. */
const RESTORE_KEY_HINT = '密钥库里已有用原来的主密钥封存的条目：恢复原来的钥匙串项；不要运行 circle-hub key init，新建的主密钥打不开这些条目。找不回原来的钥匙串项时：停服务，运行 circle-hub key init --set-aside-vault；操作令牌也丢失时先运行 circle-hub operator-token reissue；然后 circle-hub secret import，最后起服务';

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
