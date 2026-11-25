import { createHash } from 'node:crypto';
import { createTestParserRegistry } from '../../../../hub/testing/parsers.ts';
import { recognize } from '../../../../hub/refs/api.ts';

export interface SyntheticCase { id: string; autoid?: unknown; auto?: string; title: string; step: string; expect: string }

export function mindmapSubject(cases: SyntheticCase[]) {
  const children = cases.map((c, i) => ({
    data: { id: c.id, text: c.title, priority: 2, resource: ['合成'], auto: c.auto ?? 'YES', ...(c.autoid === undefined ? {} : { autoid: c.autoid }) },
    children: [{ data: { id: `step-${i}`, text: c.step }, children: [{ data: { id: `expected-${i}`, text: c.expect } }] }],
  }));
  const bytes = Buffer.from(JSON.stringify({ root: { data: { id: 'synthetic-map', text: '合成用例' }, children } }));
  const parsed = recognize(createTestParserRegistry(), bytes, 'application/json')!;
  return { sha256: createHash('sha256').update(bytes).digest('hex'), parser: 'kityminder@1', model: parsed.document.model };
}
