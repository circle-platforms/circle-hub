// What the keychain items of a deployment hold, as messages name them. The settings (init refuses the reserved account)
// and the keychain store build their texts from these constants; keychain.ts re-exports them.

/** What a keychain item holds, as its messages name it, and the next steps that belong to it. */
export interface KeychainItem {
  /** Chinese name of what the item holds. */
  readonly label: string;
  /** The next step when the item is missing; none when the caller decides. */
  readonly missingHint?: string;
  /** Why an existing item is never replaced; none when the caller decides. */
  readonly keepHint?: string;
}

/** The vault master key. 密钥库 is the design standard's term for the vault (docs/design/object-standard.md). */
export const VAULT_KEY_ITEM: KeychainItem = Object.freeze({
  label: '密钥库主密钥',
  missingHint: '先运行 circle-hub key init',
  keepHint: '换钥匙会让已加密的密钥库条目无法解开',
});

/** The admin token the server's state-changing commands act with; the server decides what to advise about it. */
export const OPERATOR_TOKEN_ITEM: KeychainItem = Object.freeze({ label: '操作令牌' });

/** An item the caller did not name: it may be neither of the two, so it gets a neutral name and no advice. */
export const UNNAMED_ITEM: KeychainItem = Object.freeze({ label: '钥匙串项' });
