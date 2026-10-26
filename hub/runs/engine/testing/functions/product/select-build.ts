// Synthetic product pack function (select_build): the newest released build of the requested line in the product's first
// name family; the other released builds of that family are the alternatives.

interface Candidate {
  name: string;
  family: string;
  line: string;
  released_at: string | null;
}

export default function selectBuild(input: unknown): unknown {
  const { line, candidates } = input as { line: string | null; candidates: Candidate[] };
  const pool = candidates.filter((c) => c.released_at !== null && (line === null || c.line === line) && c.family === 'Meadow');
  pool.sort((a, b) => (b.released_at as string).localeCompare(a.released_at as string));
  if (pool.length === 0) return { build: 'no-such-build', basis: '没有符合规则的构建' };
  return { build: pool[0].name, basis: `按产品包规则选定 Meadow 名称族最新的已发布构建 ${pool[0].name}`, alternatives: pool.slice(1).map((c) => c.name) };
}
