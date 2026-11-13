import type { SecretUse } from '../../contracts/src/variables.ts';

/** A vault-authenticated name and version, never a record reference or a digest of material. */
export function secretVersionKey(secret: Pick<SecretUse, 'name' | 'version'>): string {
  return JSON.stringify([secret.name, secret.version]);
}
