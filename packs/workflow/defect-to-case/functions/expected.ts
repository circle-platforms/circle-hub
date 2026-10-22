// Expected sources function for defect-to-case.
import type { ExpectedSource, ExpectedSourcesOutput } from '../../../../contracts/src/pack.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function expectedSources(input: unknown): ExpectedSourcesOutput {
  if (!isRecord(input)) return { sources: [], warnings: [] };
  const context = isRecord(input.context) ? input.context : {};
  const product = typeof context.product === 'string' ? context.product : null;
  const build = typeof context.build === 'string' ? context.build : null;
  const line = typeof context.line === 'string' ? context.line : null;

  const sources: ExpectedSource[] = [];

  // Bind command/case index view if product and build are known
  if (product && build) {
    sources.push({
      external: `knowledge:index:${product}:${build}?kind=case&key=commands`,
      role: 'expected',
      reason: '已索引的用例清单，用来核对起草的用例是否重复',
    });
  }

  // Bind CLI manual if line is known
  if (line) {
    sources.push({
      external: `manual:cli:${line}`,
      role: 'expected',
      reason: '版本线的命令行手册，作为期望结果和命令依据',
    });
  }

  return { sources, warnings: [] };
}

export default function (input: unknown): unknown {
  return expectedSources(input);
}
