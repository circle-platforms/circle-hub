// Synthetic system pack (tests only): buildsite:hub:<page> reads a hub page and every listing page it links (links with
// unquoted attributes, resolved by the Hub against the hub page), tolerating dead links; the projection lists what was read.
type Response = { ok: boolean; status: number | null; sha256: string | null; model?: { links?: { href: string | null }[] } };
type Input = { round: number; external: { key: string }; responses: Record<string, Response> };

export function hubPlan(input: unknown): unknown {
  const { round, external, responses } = input as Input;
  if (round === 1) return { requests: [{ key: 'hub', route: 'page', params: { page: external.key } }], done: false };
  const links = responses.hub?.model?.links ?? [];
  const requests = links
    .map((link) => link.href)
    .filter((href): href is string => typeof href === 'string' && /\.html?$/i.test(href))
    .slice(0, 20)
    .map((href, i) => ({ key: `listing-${i + 1}`, route: 'page', href, against: 'hub' }));
  return { requests, done: true };
}

export function hubProject(input: unknown): unknown {
  const { responses } = input as Input;
  const listings = Object.entries(responses)
    .filter(([key]) => key.startsWith('listing-'))
    .map(([key, response]) => ({ key, ok: response.ok, status: response.status, sha256: response.sha256 }));
  return { artifacts: [{ name: 'content', media_type: 'application/json', json: { listings } }] };
}
