import type { SecretCipherIdentity } from '../../contracts/src/variables.ts';

export function secretVersionKey(secret: SecretCipherIdentity): string {
  return JSON.stringify([secret.name, secret.version, secret.sealed_sha256]);
}
