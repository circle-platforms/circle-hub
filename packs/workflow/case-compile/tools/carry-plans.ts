// Safely carries unchanged case-compile plan files and valid fidelity artifacts from a superseded plan run
// to a newly opened plan run under five fail-closed gates and post-write byte-for-byte SHA-256 verification.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson } from '../functions/canonical-json.ts';
import { fidelityBrief, fidelityProblems } from '../functions/fidelity.ts';
import { RUN_ID } from '../functions/generated/skills/run-tools/hub-client/index.ts';
import { planDataOf } from '../functions/subject.ts';
import { assertToolCliStdin, formatCallError, isRecord, parseCliOptions } from '../functions/text.ts';
import cli from './carry-plans.cli.json' with { type: 'json' };
import { briefFile, verdictFile } from './fidelity-brief.ts';
import { parsedPlanFile } from './submit-plans.ts';
import {
  resolveCwdRoots,
  resolveExistingDirInsideCwd,
  resolveExistingFileInsideCwd,
  resolveInsideCwd,
  type ResolvedCwd,
} from './workspace-path.ts';

const OPTIONS: Record<string, boolean> = {
  source: true,
  target: true,
  plans: true,
  'source-plans': false,
  briefs: false,
  'source-briefs': false,
  rework: false,
  exclude: false,
};

const USAGE =
  "node '<技能目录>/tools/carry-plans.ts' --source '<上一轮脚本编写目录>' --target '<新脚本编写目录>' --plans '<自动化用例目录>' [--source-plans '<上一轮自动化用例目录>'] [--source-briefs '<上一轮核对目录>' --briefs '<核对目录>'] [--rework '<逗号分隔autoid>'] [--exclude '<逗号分隔autoid>']";

const SHARED_SLOTS = ['subject', 'contract', 'inventory', 'profile'] as const;

export interface CarryIo {
  readBack?: (path: string) => Promise<Uint8Array>;
  writeExclusive?: (path: string, bytes: Uint8Array) => Promise<void>;
}

interface RunItemEntry {
  id: string;
  autoid: string | null;
  fields: Record<string, unknown>;
}

interface ParsedRun {
  run: string;
  product: string | null;
  build: string | null;
  root: string | null;
  sources: Array<{ slot: string; reference: string }>;
  scopeCases: Set<string> | null;
  excluded: Set<string>;
  items: RunItemEntry[];
  byId: Map<string, RunItemEntry>;
}

interface PlannedWrite {
  canonical: string;
  relative: string;
  bytes: Buffer;
  sha256: string;
  dirCanonical: string;
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

function parseCommaList(raw: string | undefined, flag: string): Set<string> {
  if (raw === undefined) return new Set();
  const tokens = raw.split(',').map((s) => s.trim());
  if (!tokens.length || tokens.some((s) => !s)) {
    throw new Error(`参数无效：${flag} 必须是英文逗号分隔的非空标识列表`);
  }
  return new Set(tokens);
}

function optionalStringField(obj: Record<string, unknown>, key: string): string | null {
  const val = obj[key];
  if (val === undefined || val === null) return null;
  if (typeof val !== 'string' || !val.trim()) {
    throw new Error(`参数无效：run.json 字段 ${key} 格式无效`);
  }
  return val;
}

function sharedSourcesOf(raw: unknown): Array<{ slot: string; reference: string }> {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) throw new Error('参数无效：run.json 字段 sources 必须是数组');
  const picked: Array<{ slot: string; reference: string }> = [];
  for (const row of raw) {
    if (!isRecord(row)) continue;
    if (typeof row.slot === 'string' && (SHARED_SLOTS as readonly string[]).includes(row.slot)) {
      if (typeof row.reference !== 'string' || !row.reference) {
        throw new Error(`参数无效：run.json sources 槽位 ${row.slot} 缺少 reference`);
      }
      picked.push({ slot: row.slot, reference: row.reference });
    }
  }
  return picked.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : a.reference.localeCompare(b.reference)));
}

async function readRunRecord(cwd: ResolvedCwd, dirRel: string, label: string): Promise<ParsedRun> {
  const file = resolveExistingFileInsideCwd(cwd, join(dirRel, 'run.json'), `${label}/run.json`);
  const raw = parsedPlanFile(`${label}/run.json`, await readFile(file.canonical));
  if (!isRecord(raw) || typeof raw.run !== 'string' || !RUN_ID.test(raw.run) || !Array.isArray(raw.items)) {
    throw new Error(`参数无效：${label}/run.json 不是有效的运行记录`);
  }
  const params = isRecord(raw.parameters) ? raw.parameters : {};
  const excluded = new Set<string>(
    Array.isArray(params.exclude) ? params.exclude.filter((v): v is string => typeof v === 'string' && v.length > 0) : [],
  );
  let scopeCases: Set<string> | null = null;
  if (params.scope !== undefined) {
    if (excluded.size > 0) {
      throw new Error(`参数无效：${label}/run.json 同时存在 parameters.scope 与 parameters.exclude`);
    }
    if (
      !isRecord(params.scope) ||
      !Array.isArray(params.scope.cases) ||
      !params.scope.cases.length ||
      params.scope.cases.some((c) => typeof c !== 'string' || !c)
    ) {
      throw new Error(`参数无效：${label}/run.json 的 parameters.scope 无效`);
    }
    scopeCases = new Set(params.scope.cases as string[]);
  }
  const items: RunItemEntry[] = [];
  const byId = new Map<string, RunItemEntry>();
  const seenAutoids = new Set<string>();
  for (const item of raw.items) {
    if (!isRecord(item) || typeof item.id !== 'string' || !item.id) {
      throw new Error(`参数无效：${label}/run.json 中存在缺少 id 的条目`);
    }
    if (byId.has(item.id)) {
      throw new Error(`参数无效：${label}/run.json 存在重复条目 ${item.id}`);
    }
    const fields = isRecord(item.fields) ? item.fields : {};
    const autoid =
      typeof fields.autoid === 'string' && fields.autoid
        ? fields.autoid
        : typeof fields.case_id === 'string' && fields.case_id
          ? fields.case_id
          : null;
    if (autoid) {
      if (seenAutoids.has(autoid)) {
        throw new Error(`参数无效：${label}/run.json 存在重复 autoid ${autoid}`);
      }
      seenAutoids.add(autoid);
    }
    const entry = { id: item.id, autoid, fields };
    items.push(entry);
    byId.set(item.id, entry);
  }
  return {
    run: raw.run,
    product: optionalStringField(raw, 'product'),
    build: optionalStringField(raw, 'build'),
    root: optionalStringField(raw, 'root'),
    sources: sharedSourcesOf(raw.sources),
    scopeCases,
    excluded,
    items,
    byId,
  };
}

function assertCompatibleRuns(source: ParsedRun, target: ParsedRun): void {
  if (source.run === target.run) {
    throw new Error(`参数无效：--source 与 --target 指向同一个运行 ${source.run}，同一运行直接重交即可，无需结转`);
  }
  if (source.product !== target.product) {
    throw new Error(`参数无效：--source（product=${source.product ?? '无'}）与 --target（product=${target.product ?? '无'}）产品不一致，拒绝结转`);
  }
  if (source.build !== target.build) {
    throw new Error(`参数无效：--source（build=${source.build ?? '无'}）与 --target（build=${target.build ?? '无'}）构建不一致，拒绝结转`);
  }
  if (source.root !== target.root) {
    throw new Error(`参数无效：--source（root=${source.root ?? '无'}）与 --target（root=${target.root ?? '无'}）知识根不一致，拒绝结转`);
  }
  if (canonicalJson(source.sources) !== canonicalJson(target.sources)) {
    throw new Error('参数无效：--source 与 --target 绑定的输入（subject/contract/inventory/profile）不一致，拒绝结转');
  }
}

function recompositionOf(item: RunItemEntry): unknown {
  return isRecord(item.fields.recomposition) ? item.fields.recomposition.record : undefined;
}

function itemSpecEqual(source: RunItemEntry, target: RunItemEntry): boolean {
  return (
    canonicalJson(recompositionOf(source) ?? null) === canonicalJson(recompositionOf(target) ?? null) &&
    canonicalJson(source.fields.steps ?? null) === canonicalJson(target.fields.steps ?? null) &&
    canonicalJson(source.fields.expected_nodes ?? null) === canonicalJson(target.fields.expected_nodes ?? null)
  );
}

function cloneWithoutFidelity(data: unknown): Record<string, unknown> {
  if (!isRecord(data)) return {};
  const { fidelity: _dropped, ...rest } = data;
  return rest;
}

function stripFidelityFromPlan(parsed: Record<string, unknown>): Buffer {
  const slots = isRecord(parsed.slots) ? parsed.slots : {};
  const planList = Array.isArray(slots.plan) ? slots.plan : [];
  const nextPlan = planList.map((entry, idx) => {
    if (idx !== 0 || !isRecord(entry) || !isRecord(entry.data)) return entry;
    const { fidelity: _dropped, ...cleanData } = entry.data;
    return { ...entry, data: cleanData };
  });
  return Buffer.from(JSON.stringify({ ...parsed, slots: { ...slots, plan: nextPlan } }, null, 2) + '\n');
}

async function verifySourceBriefPair(
  cwd: ResolvedCwd,
  sourceBriefsRel: string,
  base: string,
  brief: NonNullable<ReturnType<typeof fidelityBrief>>,
): Promise<{ briefBytes: Buffer; verdictBytes: Buffer; briefName: string; verdictName: string } | null> {
  const briefPathStr = briefFile(sourceBriefsRel, base, brief.brief_sha256);
  const verdictPathStr = verdictFile(sourceBriefsRel, base, brief.brief_sha256);
  let resolvedBrief: ReturnType<typeof resolveExistingFileInsideCwd>;
  let resolvedVerdict: ReturnType<typeof resolveExistingFileInsideCwd>;
  try {
    resolvedBrief = resolveExistingFileInsideCwd(cwd, briefPathStr, '--source-briefs');
    resolvedVerdict = resolveExistingFileInsideCwd(cwd, verdictPathStr, '--source-briefs');
  } catch {
    return null;
  }
  const briefBytes = await readFile(resolvedBrief.canonical);
  const verdictBytes = await readFile(resolvedVerdict.canonical);
  let parsedBrief: unknown;
  let parsedVerdict: unknown;
  try {
    parsedBrief = parsedPlanFile(basename(briefPathStr), briefBytes);
    parsedVerdict = parsedPlanFile(basename(verdictPathStr), verdictBytes);
  } catch {
    return null;
  }
  if (canonicalJson(parsedBrief) !== canonicalJson(brief)) return null;
  if (fidelityProblems(brief, parsedVerdict).problems.length > 0) return null;
  return {
    briefBytes: Buffer.from(briefBytes),
    verdictBytes: Buffer.from(verdictBytes),
    briefName: basename(briefPathStr),
    verdictName: basename(verdictPathStr),
  };
}

async function stageWrite(
  cwd: ResolvedCwd,
  dirRelative: string,
  dirCanonical: string,
  fileName: string,
  bytes: Buffer,
  stagedPaths: Set<string>,
): Promise<PlannedWrite> {
  const relArg = join(dirRelative, fileName);
  const target = resolveInsideCwd(cwd, relArg, '输出目标');
  if (stagedPaths.has(target.canonical)) {
    throw new Error(`已被占用：两个条目要写同一个输出文件 ${target.relative}。请核对来源条目后重试`);
  }
  stagedPaths.add(target.canonical);
  const existing = await lstat(target.lexical).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (existing !== null) {
    throw new Error(`已被占用：输出文件 ${target.relative} 已存在，不覆盖。请另选新目录或清理后再结转`);
  }
  return {
    canonical: target.canonical,
    relative: target.relative,
    bytes,
    sha256: sha256Hex(bytes),
    dirCanonical,
  };
}

async function resolveDestDir(cwd: ResolvedCwd, arg: string, label: string): Promise<{ canonical: string; relative: string }> {
  const checked = resolveInsideCwd(cwd, arg, label);
  const st = await lstat(checked.lexical).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (st !== null) {
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new Error(`参数无效：${label} ${arg} 必须是普通目录且不能是符号链接`);
    }
  }
  return { canonical: checked.canonical, relative: checked.relative };
}

/**
 * Carries eligible plan files and valid fidelity artifacts from `--source` to `--target`
 * after checking compatibility, scope/exclusion/rework filters, spec equivalence, fidelity digest,
 * workspace path containment, and post-write byte-for-byte SHA-256 verification.
 */
export async function main(argv: string[], io: CarryIo = {}): Promise<number> {
  try {
    assertToolCliStdin(cli, []);
    const args = parseCliOptions(argv, OPTIONS, USAGE);
    if ((args.briefs !== undefined) !== (args['source-briefs'] !== undefined)) {
      throw new Error('参数无效：传入 --briefs 与 --source-briefs 时必须成对提供');
    }

    const cwd = resolveCwdRoots();
    const sourceDir = resolveExistingDirInsideCwd(cwd, args.source!, '--source');
    const targetDir = resolveExistingDirInsideCwd(cwd, args.target!, '--target');
    if (sourceDir.canonical === targetDir.canonical) {
      throw new Error('参数无效：--source 与 --target 不能是同一个目录');
    }

    const sourcePlansArg = args['source-plans'] ?? join(sourceDir.relative, 'plans');
    const sourcePlans = resolveExistingDirInsideCwd(cwd, sourcePlansArg, '--source-plans');
    const destPlans = await resolveDestDir(cwd, args.plans!, '--plans');
    if (sourcePlans.canonical === destPlans.canonical) {
      throw new Error('参数无效：--source-plans 与 --plans 不能是同一个目录');
    }

    const sourceBriefs = args['source-briefs']
      ? resolveExistingDirInsideCwd(cwd, args['source-briefs'], '--source-briefs')
      : null;
    const destBriefs = args.briefs ? await resolveDestDir(cwd, args.briefs, '--briefs') : null;
    if (sourceBriefs && destBriefs && sourceBriefs.canonical === destBriefs.canonical) {
      throw new Error('参数无效：--source-briefs 与 --briefs 不能是同一个目录');
    }

    const sourceRun = await readRunRecord(cwd, sourceDir.relative, '--source');
    const targetRun = await readRunRecord(cwd, targetDir.relative, '--target');
    assertCompatibleRuns(sourceRun, targetRun);

    const cliExcluded = parseCommaList(args.exclude, '--exclude');
    const excluded = new Set([...targetRun.excluded, ...cliExcluded]);
    const rework = parseCommaList(args.rework, '--rework');

    const names = (await readdir(sourcePlans.canonical)).filter((n) => n.endsWith('.json')).sort();
    if (!names.length) {
      throw new Error(`不存在：${sourcePlans.relative} 中没有任何自动化用例 .json 文件`);
    }

    const seenSourceItems = new Set<string>();
    const stagedPaths = new Set<string>();
    const plannedWrites: PlannedWrite[] = [];
    const needsRecheck: string[] = [];
    const skipped = {
      rework: [] as string[],
      excluded: [] as string[],
      out_of_scope: [] as string[],
      spec_changed: [] as string[],
      missing_in_target: [] as string[],
    };

    interface StagedRecord {
      item: string;
      autoid: string | null;
      sourceFile: string;
      planWrite: PlannedWrite;
      fidelity: 'reused' | 'stripped' | 'not_needed';
      briefWrite?: PlannedWrite;
      verdictWrite?: PlannedWrite;
    }
    const records: StagedRecord[] = [];

    for (const fileName of names) {
      const planRel = join(sourcePlans.relative, fileName);
      const srcFile = resolveExistingFileInsideCwd(cwd, planRel, '--source-plans');
      const rawBytes = Buffer.from(await readFile(srcFile.canonical));
      const parsed = parsedPlanFile(fileName, rawBytes);
      if (!isRecord(parsed) || typeof parsed.item !== 'string' || !parsed.item || typeof parsed.handling !== 'string') {
        throw new Error(`参数无效：${srcFile.relative} 不是合法的单条自动化用例 JSON`);
      }
      if (seenSourceItems.has(parsed.item)) {
        throw new Error(`参数无效：--source-plans 中条目 ${parsed.item} 存在多份自动化用例文件。请只保留一份后重试`);
      }
      seenSourceItems.add(parsed.item);

      const sourceItem = sourceRun.byId.get(parsed.item);
      const targetItem = targetRun.byId.get(parsed.item);
      if (!targetItem) {
        skipped.missing_in_target.push(sourceItem?.autoid ?? parsed.item);
        continue;
      }
      if (sourceItem && sourceItem.autoid !== targetItem.autoid) {
        throw new Error(`参数无效：条目 ${parsed.item} 在源/目标运行间的 autoid 不一致`);
      }
      const key = targetItem.autoid ?? targetItem.id;

      if (excluded.has(key) || excluded.has(targetItem.id)) {
        skipped.excluded.push(key);
        continue;
      }
      if (targetRun.scopeCases && (!targetItem.autoid || !targetRun.scopeCases.has(targetItem.autoid))) {
        skipped.out_of_scope.push(key);
        continue;
      }
      if (rework.has(key) || rework.has(targetItem.id)) {
        skipped.rework.push(key);
        continue;
      }
      if (!sourceItem || !itemSpecEqual(sourceItem, targetItem)) {
        skipped.spec_changed.push(key);
        continue;
      }

      if (parsed.handling === 'skipped') {
        const planWrite = await stageWrite(cwd, destPlans.relative, destPlans.canonical, fileName, rawBytes, stagedPaths);
        records.push({ item: parsed.item, autoid: targetItem.autoid, sourceFile: srcFile.relative, planWrite, fidelity: 'not_needed' });
        plannedWrites.push(planWrite);
        continue;
      }

      const data = planDataOf(parsed);
      const cleanData = cloneWithoutFidelity(data);
      const brief = fidelityBrief(targetItem.id, recompositionOf(targetItem), cleanData);
      if (brief === null) {
        const hadStrayFidelity = isRecord(data) && data.fidelity !== undefined;
        const outBytes = hadStrayFidelity ? stripFidelityFromPlan(parsed) : rawBytes;
        const planWrite = await stageWrite(cwd, destPlans.relative, destPlans.canonical, fileName, outBytes, stagedPaths);
        records.push({
          item: parsed.item,
          autoid: targetItem.autoid,
          sourceFile: srcFile.relative,
          planWrite,
          fidelity: hadStrayFidelity ? 'stripped' : 'not_needed',
        });
        plannedWrites.push(planWrite);
        continue;
      }

      const embeddedFidelity = isRecord(data) ? data.fidelity : undefined;
      let fidelityOk =
        isRecord(embeddedFidelity) &&
        embeddedFidelity.brief_sha256 === brief.brief_sha256 &&
        fidelityProblems(brief, embeddedFidelity).problems.length === 0;

      let briefPair: Awaited<ReturnType<typeof verifySourceBriefPair>> = null;
      if (fidelityOk && sourceBriefs) {
        const base = basename(fileName, '.json');
        briefPair = await verifySourceBriefPair(cwd, sourceBriefs.relative, base, brief);
        if (!briefPair) fidelityOk = false;
      }

      if (fidelityOk) {
        const planWrite = await stageWrite(cwd, destPlans.relative, destPlans.canonical, fileName, rawBytes, stagedPaths);
        plannedWrites.push(planWrite);
        let briefWrite: PlannedWrite | undefined;
        let verdictWrite: PlannedWrite | undefined;
        if (briefPair && destBriefs) {
          briefWrite = await stageWrite(cwd, destBriefs.relative, destBriefs.canonical, briefPair.briefName, briefPair.briefBytes, stagedPaths);
          verdictWrite = await stageWrite(cwd, destBriefs.relative, destBriefs.canonical, briefPair.verdictName, briefPair.verdictBytes, stagedPaths);
          plannedWrites.push(briefWrite, verdictWrite);
        }
        records.push({
          item: parsed.item,
          autoid: targetItem.autoid,
          sourceFile: srcFile.relative,
          planWrite,
          fidelity: 'reused',
          briefWrite,
          verdictWrite,
        });
      } else {
        const strippedBytes = stripFidelityFromPlan(parsed);
        const planWrite = await stageWrite(cwd, destPlans.relative, destPlans.canonical, fileName, strippedBytes, stagedPaths);
        plannedWrites.push(planWrite);
        needsRecheck.push(planWrite.relative);
        records.push({
          item: parsed.item,
          autoid: targetItem.autoid,
          sourceFile: srcFile.relative,
          planWrite,
          fidelity: 'stripped',
        });
      }
    }

    const dirsToEnsure = new Set(plannedWrites.map((w) => w.dirCanonical));
    for (const dir of dirsToEnsure) {
      await mkdir(dir, { recursive: true });
    }

    const writeExclusive = io.writeExclusive ?? (async (path: string, bytes: Uint8Array) => {
      await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
    });
    const readBack = io.readBack ?? (async (path: string) => readFile(path));

    for (const write of plannedWrites) {
      await writeExclusive(write.canonical, write.bytes);
      const st = await lstat(write.canonical);
      if (st.isSymbolicLink() || !st.isFile()) {
        throw new Error(`暂时不可用：写入后重读发现 ${write.relative} 不是普通文件。请检查目标磁盘与目录状态后重试`);
      }
      const diskBytes = await readBack(write.canonical);
      if (
        diskBytes.byteLength !== write.bytes.byteLength ||
        Buffer.compare(Buffer.from(diskBytes), write.bytes) !== 0 ||
        sha256Hex(diskBytes) !== write.sha256
      ) {
        throw new Error(`暂时不可用：写入后重读 ${write.relative} 的字节或 SHA-256 与预期不符。请检查目标磁盘与目录状态后重试`);
      }
    }

    const manifest = {
      schema: 'carry-plans@1',
      source_run: sourceRun.run,
      target_run: targetRun.run,
      carried: records.map((r) => ({
        item: r.item,
        autoid: r.autoid,
        source_file: r.sourceFile,
        file: r.planWrite.relative,
        bytes: r.planWrite.bytes.byteLength,
        sha256: r.planWrite.sha256,
        verified: true,
        fidelity: r.fidelity,
        ...(r.briefWrite ? { brief_file: r.briefWrite.relative, brief_sha256: r.briefWrite.sha256, brief_verified: true } : {}),
        ...(r.verdictWrite ? { verdict_file: r.verdictWrite.relative, verdict_sha256: r.verdictWrite.sha256, verdict_verified: true } : {}),
      })),
      needs_recheck: needsRecheck,
      skipped,
      written: plannedWrites.length,
    };
    process.stdout.write(JSON.stringify(manifest, null, 2) + '\n');
    return 0;
  } catch (error) {
    process.stderr.write(formatCallError(error) + '\n');
    return 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}
