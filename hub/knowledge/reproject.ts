// `circle-hub knowledge reproject <product> <line>`: re-projects a version line's existing fed cases onto the line's current
// seedling root, the same step `knowledge seed` takes before it moves the pointer (FeedingLayer.reproject). It is for a
// backlog written before seeding did this: cases fed under an earlier root or without a root that a view over the current
// seedling would count as missing a projection. The admin is the principal; each row is grounded in the seedling record.
import type { PacksPort } from '../ports.ts';
import type { Principal } from '../records/api.ts';
import { KnowledgeError } from './errors.ts';
import type { ReprojectionReport } from './feeding.ts';
import type { Knowledge } from './service.ts';
import { seedlingOfRoot } from './seedling.ts';

export const KNOWLEDGE_REPROJECT_USAGE = 'knowledge reproject <产品> <版本线>';

export interface KnowledgeReprojectArgs {
  product: string;
  line: string;
}

export interface ReprojectCommandReport {
  ok: boolean;
  product: string;
  line: string;
  root: string | null;
  seedling: string | null;
  reprojection: ReprojectionReport | null;
  reason: string | null;
}

/** Parses the arguments after `knowledge reproject`: exactly the product and the line. */
export function parseKnowledgeReprojectArgs(argv: readonly string[]): KnowledgeReprojectArgs {
  const flag = argv.find((arg) => arg.startsWith('--'));
  if (flag !== undefined) throw new KnowledgeError(`不认识的参数 ${flag.slice(0, 80)}；用法：${KNOWLEDGE_REPROJECT_USAGE}`);
  if (argv.length !== 2) throw new KnowledgeError(`要给出产品和版本线两项；用法：${KNOWLEDGE_REPROJECT_USAGE}`);
  const [product, line] = argv.map((arg) => arg.trim());
  if (product === '' || line === '') throw new KnowledgeError(`产品和版本线不能为空；用法：${KNOWLEDGE_REPROJECT_USAGE}`);
  return { product, line };
}

/** Runs `knowledge reproject` for an admin onto the line's current seedling (the one a view over the line reads). */
export async function knowledgeReproject(knowledge: Knowledge, packs: PacksPort, by: Principal, args: KnowledgeReprojectArgs): Promise<ReprojectCommandReport> {
  const product = (await packs.productByName(args.product)) ?? (await packs.productById(args.product));
  if (product === null) throw new KnowledgeError(`没有叫 ${args.product.slice(0, 80)} 的已发布产品包`);
  const productId = product.product.id;
  const report: ReprojectCommandReport = { ok: false, product: productId, line: args.line, root: null, seedling: null, reprojection: null, reason: null };
  const context = knowledge.__context;
  const layer = context.feeding;
  if (layer === undefined) { report.reason = '这个 Hub 没有喂入层，没有可重投影的用例'; return report; }
  const seed = await layer.seedFor(productId, args.line);
  if (seed === null) {
    report.reason = `版本线 ${args.line} 没有当前树苗；先由管理员育苗（circle-hub knowledge seed --product ${args.product.slice(0, 80)} --line ${args.line} --basis <一句理由>），育苗本身会重投影`;
    return report;
  }
  report.root = seed.root;
  report.seedling = await seedlingOfRoot(context, productId, seed.root);
  report.reprojection = await layer.reproject(by, productId, seed.line, { root: seed.root, composition: seed.composition }, report.seedling === null ? [] : [`rec:${report.seedling}`]);
  report.ok = true;
  return report;
}

/** The re-projection facts as report lines, shared by `knowledge seed` and `knowledge reproject`. */
export function reprojectionLines(reprojection: ReprojectionReport | null, error: string | null = null): string[] {
  if (error !== null) return [`重投影没有完成：${error}；指针照常移动，视图会列出缺投影的原件。下一步：circle-hub knowledge reproject <产品> <版本线>`];
  if (reprojection === null) return [];
  const lines = [`重投影到根 ${reprojection.root}：版本线 ${reprojection.line} 现有 ${reprojection.selected} 个喂入用例，已在该根 ${reprojection.already} 个；重读 ${reprojection.originals} 份原件，投影 ${reprojection.projected} 个`];
  const shown = reprojection.pending.slice(0, 20);
  for (const gap of shown) lines.push(`  缺 ${gap.source}：${gap.missing}；下一步：${gap.next_action}`);
  if (reprojection.pending.length > shown.length) lines.push(`  另有 ${reprojection.pending.length - shown.length} 项缺失事实未列出`);
  return lines;
}

/** The report as Chinese text for the terminal. */
export function formatReprojectReport(report: ReprojectCommandReport): string {
  const lines = [`重投影：产品 ${report.product}，版本线 ${report.line}${report.seedling === null ? '' : `，树苗 rec:${report.seedling}`}`];
  lines.push(...reprojectionLines(report.reprojection));
  if (report.reason !== null) lines.push(`失败：${report.reason}`);
  return `${lines.join('\n')}\n`;
}
