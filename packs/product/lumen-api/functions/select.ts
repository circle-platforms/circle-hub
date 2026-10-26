// The build choice of the Lumen API product (product@1 select_build, SelectBuildInput -> SelectBuildOutput): the newest
// released build of the line (the line asked for, else the line of the newest released build); a line without a release gets
// its newest build, said so in the basis. The other candidates of the line are listed, best first.
import type { SelectBuildInput, SelectBuildOutput } from '../../../../contracts/src/product.ts';
import { asArray, compareVersions, isRecord } from './common.ts';

type Candidate = { name: string; line: string; built_at: string | null; released_at: string | null };

const newest = (a: Candidate, b: Candidate): number => {
  const ra = a.released_at ?? '';
  const rb = b.released_at ?? '';
  if (ra !== rb) return ra < rb ? 1 : -1;
  const ba = a.built_at ?? '';
  const bb = b.built_at ?? '';
  if (ba !== bb) return ba < bb ? 1 : -1;
  return -compareVersions(a.name, b.name);
};

export function selectBuild(input: SelectBuildInput): SelectBuildOutput {
  const candidates = asArray(isRecord(input) ? input.candidates : undefined).filter((c): c is Candidate => isRecord(c) && typeof c.name === 'string' && typeof c.line === 'string') as Candidate[];
  const asked = isRecord(input) && typeof input.line === 'string' && input.line !== '' ? input.line : null;
  const released = candidates.filter((c) => c.released_at !== null).sort(newest);
  const line = asked ?? released[0]?.line ?? [...candidates].sort(newest)[0]?.line ?? null;
  const ofLine = candidates.filter((c) => c.line === line);
  const pool = ofLine.filter((c) => c.released_at !== null).sort(newest);
  const chosen = pool[0] ?? [...ofLine].sort(newest)[0];
  if (chosen === undefined) return { build: '(没有可选的构建)', basis: line === null ? '知识库里没有这个产品的构建' : `版本线 ${line} 没有已产生知识根的构建`, alternatives: [] };
  const basis = chosen.released_at !== null ? `版本线 ${line} 最新发布的构建 ${chosen.name}（${chosen.released_at.slice(0, 10)} 发布）` : `版本线 ${line} 还没有发布的构建，取最新的构建 ${chosen.name}（未发布）`;
  return { build: chosen.name, basis, alternatives: [...ofLine].sort(newest).map((c) => c.name).filter((n) => n !== chosen.name) };
}

export default function (input: unknown): unknown {
  try {
    return selectBuild(input as SelectBuildInput);
  } catch {
    return { build: '(没有可选的构建)', basis: '选择构建的函数内部出错（任务包的缺陷）', alternatives: [] };
  }
}
