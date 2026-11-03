import type { CallLog, Principals, TokenInfo } from '../../records/api.ts';
import { UNNAMED_CLIENT } from '../oauth.ts';
import { UNREPORTED_CLIENT } from './client-provenance.ts';
import { html, type Html } from './html.ts';
import { evidence } from './presentation.ts';

/** The name an OAuth client registered, or null when it registered none (the Hub then records UNNAMED_CLIENT). */
const registered = (name: string | undefined | null): string | null => name && name !== UNNAMED_CLIENT ? name : null;

/** A device uses its registered client name; directly issued credentials use their own label; neither is 客户端. */
export async function circleName(principals: Pick<Principals, 'client'>, token: TokenInfo): Promise<string> {
  const client = token.client === null ? null : await principals.client(token.client);
  return registered(client?.name) || token.label || UNREPORTED_CLIENT;
}

/** Resolve client metadata once for the displayed credentials; no token value is read. */
export async function circleNames(principals:Pick<Principals,'client'|'clientsMany'>,tokens:readonly TokenInfo[]):Promise<Map<string,string>>{
 const ids=[...new Set(tokens.flatMap(token=>token.client?[token.client]:[]))];
 const clients=principals.clientsMany?await principals.clientsMany(ids):new Map((await Promise.all(ids.map(async id=>[id,await principals.client(id)] as const))).filter((row):row is readonly [string,NonNullable<typeof row[1]>]=>row[1]!==null));
 return new Map(await Promise.all(tokens.map(async token=>[token.id,await circleName({client:async id=>clients.get(id)??null},token)] as const)));
}

/**
 * One connection as the Hub recorded it: the name and version the client last reported in MCP initialize (clientInfo),
 * how it connected (the OAuth registration and its client_name, or a token an administrator issued and labelled) and
 * when the token was last used. Every name is a declaration and is shown exactly as recorded.
 */
export interface ConnectedClient {
  token: TokenInfo;
  owner: string;
  /** The name to show: reported in initialize, else registered or labelled, else 客户端. */
  name: string;
  version: string | null;
  reported: { name: string; version: string | null; at: string } | null;
  connection: { kind: 'oauth'; name: string | null; client: string } | { kind: 'token'; label: string };
}

export async function connectedClients(records: { principals: Pick<Principals, 'client' | 'clientsMany'>; callLog: Pick<CallLog, 'latestDeclaredClient'> }, rows: readonly { token: TokenInfo; owner: string }[]): Promise<ConnectedClient[]> {
  const ids = [...new Set(rows.flatMap((row) => row.token.client ? [row.token.client] : []))];
  const principals = records.principals;
  const clients = principals.clientsMany ? await principals.clientsMany(ids) : new Map((await Promise.all(ids.map(async (id) => [id, await principals.client(id)] as const))).filter((row): row is readonly [string, NonNullable<typeof row[1]>] => row[1] !== null));
  return Promise.all(rows.map(async ({ token, owner }) => {
    const reported = (await records.callLog.latestDeclaredClient?.(token.user, token.id)) ?? null;
    const connection: ConnectedClient['connection'] = token.client !== null ? { kind: 'oauth', name: registered(clients.get(token.client)?.name), client: token.client } : { kind: 'token', label: token.label };
    const fallback = connection.kind === 'oauth' ? connection.name || registered(token.label) : token.label;
    return { token, owner, name: reported?.name ?? (fallback || UNREPORTED_CLIENT), version: reported?.version ?? null, reported, connection };
  }));
}

/** How a connection was made, in words: the standard authorization's registration or an issued token, with its own name. */
export function connectionText(client: ConnectedClient): Html {
  if (client.connection.kind === 'oauth') return client.connection.name ? html`标准连接确认 · ${evidence(client.connection.name)}` : html`标准连接确认`;
  return client.connection.label ? html`访问令牌 · ${evidence(client.connection.label)}` : html`访问令牌`;
}

/** The reported name with its version, marked as recorded evidence. */
export function clientLabel(client: ConnectedClient): Html {
  return evidence(client.version ? client.name + ' ' + client.version : client.name);
}

/** Where the shown name came from, for the technical details only. */
export function nameOrigin(client: ConnectedClient): string {
  if (client.reported) return 'MCP initialize clientInfo';
  if (client.connection.kind === 'oauth' && client.connection.name) return 'OAuth client_name（' + client.connection.client + '）';
  if (client.token.label) return '管理员命名的令牌';
  return '未报告';
}
