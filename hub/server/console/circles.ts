import type { Principals, TokenInfo } from '../../records/api.ts';

/** A device uses its registered client name; directly issued credentials use their own label. */
export async function circleName(principals: Pick<Principals, 'client'>, token: TokenInfo): Promise<string> {
  const client = token.client === null ? null : await principals.client(token.client);
  return client?.name || token.label || '名称未提供';
}
