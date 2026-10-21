// The core interpreters by id (`name@major`). Adding a table kind means a new interpreter here and a new shape in tables.ts.
import type { Interpreter } from '../types.ts';
import { catalogInterpreter } from './catalog.ts';
import { coverageInterpreter } from './coverage.ts';
import { membershipInterpreter } from './membership.ts';
import { patternInterpreter } from './pattern.ts';
import { quoteInterpreter } from './quote.ts';
import { rangeInterpreter } from './range.ts';
import { structureInterpreter } from './structure.ts';

export const INTERPRETERS: ReadonlyMap<string, Interpreter> = new Map(
  [structureInterpreter, catalogInterpreter, membershipInterpreter, patternInterpreter, rangeInterpreter, coverageInterpreter, quoteInterpreter].map((i) => [i.id, i]),
);

export function getInterpreter(id: string): Interpreter | undefined {
  return INTERPRETERS.get(id);
}
