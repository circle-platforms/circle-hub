// Synthetic system pack (tests only): reads of plm:bug:<id> and plm:story:<id> by the POST read routes, and their projection
// (the one record of the id from the array in the envelope; ids are numbers or strings in the answers). The `evil*` planners
// try what a planner must never get through: a route that is not listed, a write path under a read route, a body the route
// does not allow, a link to another origin, a path that climbs out with dot segments.
type Response = { ok: boolean; json?: unknown };
type Input = { external: { key: string }; responses: Record<string, Response>; original: string };

export function bugPlan(input: unknown): unknown {
  const { external } = input as Input;
  return { requests: [{ key: 'detail', route: 'bug-detail', body: { bug_ids: [Number(external.key)] } }], done: true };
}

export function storyPlan(input: unknown): unknown {
  const { external } = input as Input;
  return { requests: [{ key: 'detail', route: 'story-detail', body: { story_ids: [external.key] } }], done: true };
}

export function project(input: unknown): unknown {
  const { external, responses, original } = input as Input;
  const data = (responses[original]?.json as { data?: unknown } | undefined)?.data;
  if (!Array.isArray(data)) return { error: { code: 'plm-test.no_array', message: '详情应答里没有数组' } };
  const record = (data as { id?: unknown }[]).find((item) => String(item?.id) === external.key);
  if (record === undefined) return { error: { code: 'plm-test.absent', message: `没有编号 ${external.key}` } };
  const title = (record as { title?: unknown }).title;
  return {
    artifacts: [
      { name: 'content', media_type: 'application/json', json: record },
      { name: 'meta', media_type: 'application/json', json: { title: typeof title === 'string' ? title : null } },
    ],
  };
}

export function evilRoute(): unknown {
  return { requests: [{ key: 'write', route: 'testtask-edit', body: { id: 1 } }], done: true };
}

export function evilPath(): unknown {
  return { requests: [{ key: 'write', route: 'bug-detail', path: '/plmquery/testtask/edit/', body: { bug_ids: [1] } }], done: true };
}

export function evilBody(): unknown {
  return { requests: [{ key: 'detail', route: 'bug-detail', body: { bug_ids: [1], status: 'closed' } }], done: true };
}

export function evilHref(): unknown {
  return { requests: [{ key: 'away', route: 'products', href: 'http://192.0.2.77/plmquery/product/all/' }], done: true };
}

export function evilDots(): unknown {
  return { requests: [{ key: 'climb', route: 'products', path: '/plmquery/product/all/../../testtask/edit/' }], done: true };
}

export function loop(input: unknown): unknown {
  const { round } = input as { round: number };
  return { requests: [{ key: `products-${round}`, route: 'products' }], done: false };
}

export function broken(): unknown {
  return { requests: 'not a list', done: true };
}

export function throws(): unknown {
  throw new Error('planner failed on purpose');
}
