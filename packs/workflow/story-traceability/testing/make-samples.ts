import { writeFile } from 'node:fs/promises';
import project from '../functions/project.ts';
import { boundView, caseEntry, indexViewOf } from '../../traceability/functions/test-support.ts';
const p = project({ inputs: [boundView('stories', { stories: [{ id: '21', status: 'synthetic', stage: null, title: '合成需求' }], unread: [] }, 'plm:stories:21'),
  boundView('cases', { ...indexViewOf('case', 'stories', [caseEntry({ stories: ['21'], defects: [], case: 'c1' })]), key_space_complete: true })] }) as { items: unknown[]; groups: unknown[] };
const subject = { items: p.items, context: { groups: p.groups } };
for (const [check, code] of [['traced', 'join_mismatch'], ['counts', 'count_mismatch']] as const) {
  for (const positive of [true, false]) {
    const value = structuredClone(subject) as any;
    if (!positive && check === 'traced') value.items[0].fields.cases[0].stories = ['22'];
    if (!positive && check === 'counts') value.context.groups[0].view.total_entries++;
    const sample = { id: `${check}_${positive ? 'support' : 'refute'}`, source: 'author', check, note: '合成完整性样例', subject: value,
      expect: [positive ? { verdict: 'support', tier: 'advisory' } : { verdict: 'refute', code: `story-traceability.${code}`, tier: 'advisory' }] };
    await writeFile(new URL(`../samples/${positive ? 'positive' : 'negative'}/${check}.json`, import.meta.url), JSON.stringify(sample, null, 2) + '\n');
  }
}
