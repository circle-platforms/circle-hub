// A PLM-query-service-like stub (architecture brief section 8, structure only, invented content): the envelope {code, msg,
// data} with HTTP 200, the token in the Authorization header without a prefix, reads by GET and by POST, one answer that is a
// plain array without an envelope, ids that are numbers in some answers and strings in others, dates in several spellings,
// HTML in text fields, and a WRITE route under the same prefix as the reads, which counts every request that reaches it.
import { extend, json, notFound, startStub, type RecordedRequest, type StubServer } from './stub.ts';

export interface PlmOptions {
  /** Whether a token is valid (the PLM-like stub shares the agile-like stub's tokens). */
  accepts: (token: string) => boolean;
  expiredCode?: number;
}

export interface PlmStub extends StubServer {
  /** Requests that reached the write route. Must stay 0. */
  readonly writes: number;
}

export const PLM_PRODUCTS = [
  { id: 28, name: '演示/DEMO/ALT', code: 'demo' },
  { id: '31', name: '另一个演示产品', code: 'other' },
];

export const PLM_BUILDS: Record<string, unknown[]> = {
  '28': [
    { id: 501, name: 'Rel_DEMO_2_1_0_5', date: '2026-01-15 10:00:00' },
    { id: '502', name: 'Rel_ALT_2_1_0_5', date: '2026/01/16' },
    { id: 503, name: 'Beta_DEMO_2_2_0_1', date: '0000-00-00 00:00:00' },
  ],
};

export const PLM_BUGS: Record<string, Record<string, unknown>> = {
  '4242': { id: 4242, title: '组件参数超出范围时没有报错', status: 'resolved', openedDate: '2026-01-02 09:30:00', steps: '<p>设置参数 <b>99999</b></p><p>预期：报错</p>' },
  '4343': { id: '4343', title: '组件列表为空时显示异常', status: 'active', openedDate: '2026-01-05T08:00:00Z', steps: '<ol><li>清空列表</li></ol>' },
};

export const PLM_STORIES: Record<string, Record<string, unknown>> = {
  '777': { id: '777', title: '组件支持参数范围检查', spec: '<p>参数范围 1 到 100。</p>', stage: 'developed' },
};

export async function startPlmStub(options: PlmOptions): Promise<PlmStub> {
  const expired = options.expiredCode ?? 1001;
  let writes = 0;
  const authorized = (request: RecordedRequest): boolean => options.accepts(request.headers.authorization ?? '');
  const ids = (request: RecordedRequest, key: string): string[] => {
    const value = (request.json as Record<string, unknown> | undefined)?.[key];
    return Array.isArray(value) ? value.map(String) : [];
  };
  const stub = await startStub((request) => {
    if (request.path === '/plmquery/testtask/edit/') {
      writes += 1;
      return json({ code: 1000, msg: '已修改', data: null });
    }
    if (!authorized(request)) return json({ code: expired, msg: '登录已过期', data: null });
    if (request.method === 'GET' && request.path === '/plmquery/product/all/') return json({ code: 1000, msg: '', data: PLM_PRODUCTS });
    // A plain array, not an envelope and not paginated.
    if (request.method === 'GET' && request.path === '/plmquery/build/') return json(PLM_BUILDS[request.query.product ?? ''] ?? []);
    if (request.method === 'POST' && request.path === '/plmquery/bug/detail/') return json({ code: 1000, msg: '', data: ids(request, 'bug_ids').flatMap((id) => (PLM_BUGS[id] ? [PLM_BUGS[id]] : [])) });
    if (request.method === 'POST' && request.path === '/plmquery/story/detail/') return json({ code: 1000, msg: '', data: ids(request, 'story_ids').flatMap((id) => (PLM_STORIES[id] ? [PLM_STORIES[id]] : [])) });
    return notFound();
  });
  return extend(stub, {
    get writes() {
      return writes;
    },
  });
}
