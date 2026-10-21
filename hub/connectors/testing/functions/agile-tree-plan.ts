// Synthetic system pack (tests only): planner of agile:tree:<root>. Round 1 reads the subtree of the root and the first page
// of the root listing; round 2 reads the remaining pages when the root was not on page 1 (pages past the end repeat page 1,
// so only the pages the total announces are read).
type Response = { ok: boolean; json?: unknown };
type Input = { round: number; external: { key: string }; responses: Record<string, Response> };

const PAGE = 10;
const MAX_PAGES = 20;

function listing(response: Response | undefined): { total: number; list: { id: unknown }[] } {
  const data = (response?.json as { data?: { total?: unknown; list?: unknown } } | undefined)?.data;
  return { total: typeof data?.total === 'number' ? data.total : 0, list: Array.isArray(data?.list) ? (data.list as { id: unknown }[]) : [] };
}

export default function (input: unknown): unknown {
  const { round, external, responses } = input as Input;
  if (round === 1) {
    return {
      requests: [
        { key: 'subtree', route: 'subtree', body: { id: external.key } },
        { key: 'page-1', route: 'roots', body: { page: 1 } },
      ],
      done: false,
      original: 'subtree',
    };
  }
  const first = listing(responses['page-1']);
  const found = first.list.some((root) => String(root.id) === external.key);
  const pages = Math.min(Math.ceil(first.total / PAGE), MAX_PAGES);
  const requests = [];
  if (!found) for (let page = 2; page <= pages; page++) requests.push({ key: `page-${page}`, route: 'roots', body: { page } });
  return { requests, done: true };
}
