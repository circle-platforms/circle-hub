import { readFileSync } from 'node:fs';
export { buildFixtures } from './write.ts';
export const RECOMPOSE_FIXTURES = ['pass', 'underdetermined', 'conflict', 'missing-prerequisite'] as const;
export type RecomposeFixture = typeof RECOMPOSE_FIXTURES[number];
export const fixtureText = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8');
export const fixtureJson = (name: string): any => JSON.parse(fixtureText(name));
export function recordFor(name: RecomposeFixture, receipt: string, predecessor?: string) { const record = fixtureJson('recompose-' + name + '.json'); for (const s of record.sources.states)
    if (s.state === 'settled')
        s.adjudicated_by = receipt; if (predecessor)
    record.predecessor = predecessor; return record; }
