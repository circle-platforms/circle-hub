// Open MCP sessions by declared client name. The Hub's MCP endpoint is stateless and a client may simply go away, so a
// session counts as open from its initialize until the client asks to end it (DELETE, which the specification allows it to
// send even to a server that answers 405) or until it has been silent for idleMs. Process-local: after a restart a session
// reappears at its next request, without the name it declared to the earlier process.
export const SESSION_IDLE_MS = 15 * 60 * 1000;
const MAX_SESSIONS = 10_000;
/** Names in one sample; a client's name is whatever it declares, so the row stays bounded whatever is declared. */
export const MAX_NAMES = 20;

export interface SessionCounts {
  total: number;
  /** Sessions by declared name, the most used first. `total` minus their sum declared no name, or a name past the bound. */
  byClient: Record<string, number>;
}

export interface SessionTracker {
  /** A session this Hub just issued, with the client name it declared. */
  opened(id: string, client: string | null): void;
  /** A request carried this session id. */
  seen(id: string | null): void;
  /** The client asked to end the session. */
  closed(id: string | null): void;
  counts(): SessionCounts;
}

export function createSessionTracker(options: { now: () => Date; idleMs?: number; maxSessions?: number }): SessionTracker {
  const idleMs = options.idleMs ?? SESSION_IDLE_MS;
  const maxSessions = options.maxSessions ?? MAX_SESSIONS;
  // Insertion order is last-seen order: a session seen again moves to the end, so the oldest are always first.
  const sessions = new Map<string, { client: string | null; seen: number }>();
  const put = (id: string, client: string | null): void => {
    sessions.delete(id);
    sessions.set(id, { client, seen: options.now().getTime() });
    if (sessions.size > maxSessions) sessions.delete(sessions.keys().next().value as string);
  };
  return {
    opened: put,
    seen(id) {
      if (id !== null) put(id, sessions.get(id)?.client ?? null);
    },
    closed(id) {
      if (id !== null) sessions.delete(id);
    },
    counts() {
      const oldest = options.now().getTime() - idleMs;
      for (const [id, session] of sessions) {
        if (session.seen >= oldest) break;
        sessions.delete(id);
      }
      const names = new Map<string, number>();
      for (const { client } of sessions.values()) if (client !== null) names.set(client, (names.get(client) ?? 0) + 1);
      const top = [...names].sort(([a, x], [b, y]) => y - x || a.localeCompare(b)).slice(0, MAX_NAMES);
      return { total: sessions.size, byClient: Object.fromEntries(top) };
    },
  };
}
