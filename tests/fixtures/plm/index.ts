// Synthetic PLM query service answers (structure of the brief, section 8; everything invented): the envelope {code, msg, data}
// with HTTP 200, ids that are numbers in some answers and strings in others, dates in three spellings, HTML in the steps and
// specs, a build list that is a plain array, and a WRITE route under the read prefix that a read-only client must never reach.
// plmReply answers one request; a test wires it into a loopback stub (hub/connectors/testing startStub).

export const BUGS: Record<string, Record<string, unknown>> = {
  '31057': {
    id: 31057,
    title: '示例网关的 HTTP 探活在后端返回 500 时仍判定为健康',
    status: 'resolved',
    severity: 2,
    openedDate: '2026-01-02 09:30:00',
    resolvedDate: '2026/01/16',
    steps: '<p>1. 配置 http 探测，后端返回 <b>500</b></p><p>2. 执行 show health</p><p>预期：后端状态为 down</p>',
    resolution: 'fixed',
  },
  '70412': {
    id: '70412',
    title: '信标权重为 0 时仍被调度',
    status: 'closed',
    openedDate: '2026-01-05T08:00:00Z',
    resolvedDate: '0000-00-00 00:00:00',
    steps: '<ol><li>设置权重 0</li><li>发起连接</li></ol>',
  },
};

export const STORIES: Record<string, Record<string, unknown>> = {
  '31057': {
    id: '31057',
    title: '示例网关支持 HTTP 探活与权重联动',
    stage: 'developed',
    spec: '<p>健康检查支持 tcp 与 http 两种探测；探测间隔 1 到 60 秒，重试 1 到 10 次。</p><p>连续失败达到重试次数后摘除后端&nbsp;&amp;&nbsp;恢复后重新加入。</p>',
    openedDate: '2025-12-01 10:00:00',
  },
  '17206': { id: 17206, title: '信标组支持 TTL 权重继承', stage: 'developing', spec: '<p>信标组可包含 1 到 8 个信标，TTL 取 1 到 255 秒。</p>' },
};

export const PRODUCTS = [
  { id: 28, name: 'ORBIT/COMET', code: 'orbit' },
  { id: '31', name: '另一个演示产品', code: 'other' },
];

export const BUILDS: Record<string, unknown[]> = {
  '28': [
    { id: 501, name: 'Rel_ORBIT_7_1_0_30', date: '2026-05-04 10:00:00' },
    { id: '502', name: 'Rel_COMET_7_1_0_12', date: '2026/05/08' },
    { id: 503, name: 'Beta_ORBIT_7_2_0_1', date: '0000-00-00 00:00:00' },
  ],
};

/** The route that changes data on the real service; it shares the /plmquery/ prefix with the reads. */
export const WRITE_PATH = '/plmquery/testtask/edit/';

export interface PlmRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  json?: unknown;
}

export interface PlmReply {
  status: number;
  headers: Record<string, string>;
  body: string;
}

const reply = (value: unknown): PlmReply => ({ status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(value) });

function ids(json: unknown, member: string): string[] {
  const value = json !== null && typeof json === 'object' ? (json as Record<string, unknown>)[member] : undefined;
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * One answer of the synthetic service. `accepts` decides whether the Authorization header carries a valid token; an invalid
 * one gets the envelope code 401 (login expired) with HTTP 200. `onWrite` counts every request that reaches the write route.
 */
export function plmReply(request: PlmRequest, accepts: (token: string) => boolean, onWrite: () => void = () => {}): PlmReply {
  if (request.path === WRITE_PATH) {
    onWrite();
    return reply({ code: 1000, msg: '已修改', data: null });
  }
  if (!accepts(request.headers.authorization ?? '')) return reply({ code: 401, msg: '登录已过期', data: null });
  if (request.method === 'GET' && request.path === '/plmquery/product/all/') return reply({ code: 1000, msg: '', data: PRODUCTS });
  // A plain array, not an envelope and not paginated.
  if (request.method === 'GET' && request.path === '/plmquery/build/') return reply(BUILDS[request.query.product ?? ''] ?? []);
  if (request.method === 'POST' && request.path === '/plmquery/bug/detail/') return reply({ code: 1000, msg: '', data: ids(request.json, 'bug_ids').flatMap((id) => (BUGS[id] ? [BUGS[id]] : [])) });
  if (request.method === 'POST' && request.path === '/plmquery/story/detail/') return reply({ code: 1000, msg: '', data: ids(request.json, 'story_ids').flatMap((id) => (STORIES[id] ? [STORIES[id]] : [])) });
  return { status: 404, headers: { 'content-type': 'text/html' }, body: '<html><body>404 Not Found</body></html>' };
}
