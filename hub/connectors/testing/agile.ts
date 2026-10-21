// An agile-test-platform-like stub (architecture brief section 8, structure only, invented content): login by POST with
// Base64(SHA-512(password)), an envelope {code, msg, data} with HTTP 200 for every answer (1000 ok, 1005 wrong password, an
// "expired" code for a missing or stale token), the token in the Authorization header without a prefix, a paged root
// listing (10 per page with a total; pages past the end repeat page 1), the whole subtree of a root, and mind-map documents
// whose data is the KityMinder JSON encoded once more as a string.
import { createHash, randomBytes } from 'node:crypto';
import { extend, json, notFound, startStub, type RecordedRequest, type StubReply, type StubServer } from './stub.ts';

export interface AgileTreeNode {
  label: string;
  id: string;
  cases: string[];
  children: AgileTreeNode[];
}

export interface AgileOptions {
  username: string;
  password: string;
  roots: { id: string; label: string }[];
  trees: Record<string, AgileTreeNode[]>;
  /** Document id -> the KityMinder document (an object; the stub encodes it once more). */
  documents: Record<string, unknown>;
  /** Envelope code for a missing or stale token; default 1001. */
  expiredCode?: number;
  /** Lifetime the login answer states, in seconds; default 30 days (negative: an expiry in the past). */
  tokenLifetimeSeconds?: number;
  /** Clock for the expiry the login answer states (the Hub's test clock), default the system clock. */
  now?: () => number;
  /** The login answer waits this long (to test timeouts and logins in flight). */
  loginDelayMs?: number;
}

export interface AgileStub extends StubServer {
  readonly logins: number;
  /** Tokens the stub accepts now; the PLM-like stub shares them. */
  readonly tokens: Set<string>;
  /** Every token issued so far becomes stale. */
  expireTokens(): void;
  setPassword(password: string): void;
  /** When true, tokens issued from now on are answered "expired" at once. */
  refuseNewTokens: boolean;
  /** Requests per route path, for cache assertions. */
  count(path: string): number;
}

export const PAGE_SIZE = 10;

export function passwordDigest(password: string): string {
  return createHash('sha512').update(password, 'utf8').digest('base64');
}

export async function startAgileStub(options: AgileOptions): Promise<AgileStub> {
  const expired = options.expiredCode ?? 1001;
  const lifetime = options.tokenLifetimeSeconds ?? 30 * 24 * 3600;
  let digest = passwordDigest(options.password);
  let logins = 0;
  const tokens = new Set<string>();
  const state = { refuseNewTokens: false };

  const authorized = (request: RecordedRequest): boolean => tokens.has(request.headers.authorization ?? '');
  const stale = (): StubReply => json({ code: expired, msg: '登录已过期，请重新登录', data: null });
  const body = (request: RecordedRequest): Record<string, unknown> => (typeof request.json === 'object' && request.json !== null ? (request.json as Record<string, unknown>) : {});

  const stub = await startStub((request) => {
    if (request.method !== 'POST') return notFound();
    switch (request.path) {
      case '/oauth/login/': {
        logins += 1;
        const delayMs = options.loginDelayMs ?? 0;
        const { username, password } = body(request);
        if (username !== options.username || password !== digest) return { ...json({ code: 1005, msg: '用户名或密码错误', data: null }), delayMs };
        const token = randomBytes(24).toString('hex');
        if (!state.refuseNewTokens) tokens.add(token);
        return { ...json({ code: 1000, msg: '登录成功', data: { token, expire: Math.floor((options.now ?? Date.now)() / 1000) + lifetime } }), delayMs };
      }
      case '/agile/get_root_node/': {
        if (!authorized(request)) return stale();
        const page = Number(body(request).page);
        const pages = Math.max(1, Math.ceil(options.roots.length / PAGE_SIZE));
        // Pages past the end repeat page 1, as the real listing does.
        const shown = Number.isInteger(page) && page >= 1 && page <= pages ? page : 1;
        const list = options.roots.slice((shown - 1) * PAGE_SIZE, shown * PAGE_SIZE);
        return json({ code: 1000, msg: '', data: { total: options.roots.length, list } });
      }
      case '/agile/get_child_node_task/': {
        if (!authorized(request)) return stale();
        const id = String(body(request).id);
        const tree = options.trees[id];
        if (tree === undefined) return json({ code: 1004, msg: '节点不存在', data: null });
        return json({ code: 1000, msg: '', data: tree });
      }
      case '/agile/get_case_data/': {
        if (!authorized(request)) return stale();
        const id = String(body(request).id);
        const document = options.documents[id];
        if (document === undefined) return json({ code: 1004, msg: '用例不存在', data: null });
        // The real answer separates members with ", " inside the encoded string.
        return json({ code: 1000, msg: '', data: JSON.stringify(document).replaceAll('","', '", "') });
      }
      default:
        return notFound();
    }
  });

  return extend(stub, {
    get logins() {
      return logins;
    },
    tokens,
    expireTokens() {
      tokens.clear();
    },
    setPassword(password: string) {
      digest = passwordDigest(password);
    },
    get refuseNewTokens() {
      return state.refuseNewTokens;
    },
    set refuseNewTokens(value: boolean) {
      state.refuseNewTokens = value;
    },
    count(path: string) {
      return stub.requests.filter((r) => r.path === path).length;
    },
  });
}

/** A small invented KityMinder document: one group, two cases (one negative), expected results as leaves. */
export function mindMap(documentId: string, title: string): unknown {
  const node = (id: string, text: string, extra: Record<string, unknown>, children: unknown[] = []) => ({ data: { id, created: 1767225600000, text, ...extra }, children });
  return {
    root: node(`${documentId}r0`, title, {}, [
      node('k3m9q2x7a1b4', '基本功能', { priority: 1 }, [
        node('p8s2d5f1g7h3', '设置组件参数后查看结果', { priority: 2, resource: ['Function'] }, [node('t4y6u8i0o2p1', '参数立即生效', {})]),
        node('z9x7c5v3b1n2', '参数超出范围时报错', { priority: 2, resource: ['Negative'] }, [node('m1q3e5r7t9y0', '提示取值范围', {})]),
      ]),
    ]),
    template: 'default',
    theme: 'fresh-blue',
    version: '1.4.43',
  };
}

/** Invented roots (more than one page) and a tree for one of them, with the document `documentId` four levels down. */
export function agileFixture(documentId: string, options: { username?: string; password?: string } = {}): AgileOptions {
  const roots = Array.from({ length: 23 }, (_, i) => ({ id: String(7000 + i), label: `合成根 ${i}` }));
  roots[14] = { id: '7714', label: '演示产品' };
  const tree: AgileTreeNode[] = [
    {
      label: '030：演示测试项目',
      id: '8100',
      cases: [],
      children: [
        {
          label: '101：2.1.0',
          id: '8110',
          cases: [],
          children: [
            {
              label: '201: 2.1.0-R1-2026/1',
              id: '8111',
              cases: [],
              children: [{ label: '组件', id: '8112', cases: [documentId], children: [{ label: '需求 4242 组件参数', id: documentId, cases: [], children: [] }] }],
            },
          ],
        },
      ],
    },
  ];
  return {
    username: options.username ?? 'reader',
    password: options.password ?? 'Synthetic#Pass42',
    roots,
    trees: { '7714': tree },
    documents: { [documentId]: mindMap(documentId, '需求 4242 组件参数') },
  };
}
