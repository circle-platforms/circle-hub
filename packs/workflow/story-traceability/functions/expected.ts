import { isRecord } from './text.ts';
export default function expected(input: unknown): unknown {
  if (!isRecord(input) || !Array.isArray(input.items)) return { sources: [], warnings: [] };
  const ids = input.items.filter(isRecord).filter(i => isRecord(i.fields) && i.fields.scope === 'observed').map(i => String(i.id)).sort((a, b) => Number(a) - Number(b));
  const sources = [];
  for (let i = 0; i < ids.length; i += 50) sources.push({ external: `plm:stories:${ids.slice(i, i + 50).join('+')}`, role: 'expected', reason: '读取构建记录列出的需求的原样状态和阶段' });
  return { sources, warnings: [] };
}
