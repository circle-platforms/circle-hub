import type { SecretCipherIdentity } from '../../contracts/src/variables.ts';

/** A vault-authenticated name, version and ciphertext identity, never a record reference or a digest of material. */
export function secretVersionKey(secret: SecretCipherIdentity): string {
  return JSON.stringify([secret.name, secret.version, secret.sealed_sha256]);
}
