// The client name and version on the rows of a connection's traces: what MCP initialize declared (decision 137), a
// declaration and nothing more. The records hold it; a process keeps what it has read here, so a call costs no extra read
// once its connection is known. Bounded: the oldest connection goes first.
import type { ServerDeps } from './api.ts';

export interface DeclaredClient {
  name: string;
  version: string | null;
}

const MAX_CONNECTIONS = 1000;

export class DeclaredClients {
  readonly #deps: Pick<ServerDeps, 'records'>;
  readonly #known = new Map<string, DeclaredClient | null>();

  constructor(deps: Pick<ServerDeps, 'records'>) {
    this.#deps = deps;
  }

  #set(key: string, client: DeclaredClient | null): void {
    this.#known.delete(key);
    this.#known.set(key, client);
    if (this.#known.size > MAX_CONNECTIONS) this.#known.delete(this.#known.keys().next().value!);
  }

  /** An initialize this process answered: its session, and what its token reported last. */
  remember(user: string, token: string | null, session: string | null, client: DeclaredClient): void {
    if (token === null) return;
    this.#set(`${user}/${token}/`, client);
    if (session !== null) this.#set(`${user}/${token}/${session}`, client);
  }

  /** What this connection declared, else what its token reported last; null when neither said. A failed read says nothing. */
  async of(user: string, token: string | null, session: string | null): Promise<DeclaredClient | null> {
    if (token === null) return null;
    const key = `${user}/${token}/${session ?? ''}`;
    const known = this.#known.get(key);
    if (known !== undefined) return known;
    try {
      const log = this.#deps.records.callLog;
      const found = (await log.declaredClient?.(user, session, token)) ?? (await log.latestDeclaredClient?.(user, token)) ?? null;
      const client = found === null ? null : { name: found.name, version: found.version };
      this.#set(key, client);
      return client;
    } catch {
      return null;
    }
  }
}
