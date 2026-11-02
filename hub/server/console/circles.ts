import type { Principals, TokenInfo } from '../../records/api.ts';

/** A device uses its registered client name; directly issued credentials use their own label. */
export async function circleName(principals: Pick<Principals, 'client'>, token: TokenInfo): Promise<string> {
  const client = token.client === null ? null : await principals.client(token.client);
  return client?.name || token.label || '名称未提供';
}

/** Resolve client metadata once for the displayed credentials; no token value is read. */
export async function circleNames(principals:Pick<Principals,'client'|'clientsMany'>,tokens:readonly TokenInfo[]):Promise<Map<string,string>>{
 const ids=[...new Set(tokens.flatMap(token=>token.client?[token.client]:[]))];
 const clients=principals.clientsMany?await principals.clientsMany(ids):new Map((await Promise.all(ids.map(async id=>[id,await principals.client(id)] as const))).filter((row):row is readonly [string,NonNullable<typeof row[1]>]=>row[1]!==null));
 return new Map(await Promise.all(tokens.map(async token=>[token.id,await circleName({client:async id=>clients.get(id)??null},token)] as const)));
}
