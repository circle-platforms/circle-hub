// The run target (W03 R[0], R[5], W06 F[6], K01 R[6], R[10]): the product line (any of its names, one line), the version
// line and the build, each with its basis as a claim. A build the caller names is a declaration; otherwise the product pack's
// select_build rule chooses (projected), or, when the product has none, the newest released build of the line with a root
// (the documented default), with alternatives the caller may name instead. The run locks the root of the chosen build.
import type { ProvenanceType } from '../../../contracts/generated/vocabulary.ts';
import { Claim, type Warrant } from '../../../contracts/src/claim.ts';
import type { ProtocolError } from '../../../contracts/src/common.ts';
import { SelectBuildInput, SelectBuildOutput, type KnownBuild } from '../../../contracts/src/product.ts';
import type { StartRunInput } from '../../../contracts/src/tools.ts';
import type { z } from 'zod';
import type { Principal } from '../../records/api.ts';
import type { LoadedWorkflow, ProductHandle, RootInfo } from '../../ports.ts';
import {parseReference} from '../../refs/api.ts';
import { treeReference } from '../../refs/api.ts';
import { callPackFunction } from '../../rules/api.ts';
import type { EngineContext } from './deps.ts';
import { Refusal, describe, protocolError } from './errors.ts';

export interface Target {
  product: ProductHandle | null;
  build: KnownBuild | null;
  /** The build name the run records: as the caller gave it, or the one the rule chose. */
  buildName: string | null;
  line: string | null;
  root: RootInfo | null;
  unversionedRoot?: RootInfo<null> | null;
  basis: Claim[];
  /** The unfiltered list already read to select a build, reused only inside this start call. */
  knownBuilds?: KnownBuild[];
}

type Input = z.infer<typeof StartRunInput>;

const DEFAULT_RULE = 'runs.newest_released@1';
const BINDING_RULE = 'runs.product_binding@1';
const LINE_RULE = 'runs.line_of_build@1';
/** The lookup of a build name: the name or an alias, case folded, followed along its aliases to the build it rests on. */
const NAME_RULE = 'runs.build_name@1';
/** The most options a refusal names; a longer list says how many it left out and where they are (A05 R[1]). */
const MAX_OPTIONS = 400;

/** The claim fields an unresolved target adds besides its options (D05 R[8]). */
type Extra = Pick<ProtocolError, 'options_coverage' | 'coverage' | 'warrant' | 'provenance' | 'collected_at' | 'missing'>;

function unresolved(path: string, message: string, options: string[], fix?: string, extra: Extra = {}): Refusal {
  const { options_coverage, ...claim } = extra;
  const listed = options.slice(0, MAX_OPTIONS);
  const list = options.length === 0 ? {} : { options: listed, options_coverage: options_coverage ?? { complete: listed.length === options.length, examined: listed.length, total: options.length } };
  return new Refusal([protocolError('REFERENCE_UNRESOLVED', message, { path, ...list, ...(fix ? { fix } : {}), ...claim })]);
}

/** A build list as unresolved() takes it: the options and, in the extra fields, their coverage and the lookup's claim. */
function withBuilds(builds: readonly KnownBuild[], what: string, claim: Omit<Extra, 'options_coverage'> = {}): [string[], Extra] {
  const { options, options_coverage } = buildOptions(builds, what);
  return [options, { ...claim, options_coverage }];
}

/** Version lines newest first: dotted parts compared as numbers when both are numbers, a missing part counting as 0. */
function compareLines(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    if (/^\d+$/.test(x) && /^\d+$/.test(y)) {
      if (Number(x) !== Number(y)) return Number(y) - Number(x);
    } else if (x !== y) return x < y ? 1 : -1;
  }
  return 0;
}

/**
 * Builds as the options of a refusal, with their coverage (A05 R[1]): version lines newest first and, inside a line, the
 * builds with a knowledge root of their own first. A list longer than MAX_OPTIONS names every build with a root of its own
 * first; the note counts every line, so the caller sees what was left out and how to list one line in full.
 */
function buildOptions(builds: readonly KnownBuild[], what: string): Required<Pick<ProtocolError, 'options' | 'options_coverage'>> {
  const lines = new Map<string, { own: KnownBuild[]; other: KnownBuild[] }>();
  for (const build of builds) {
    const row = lines.get(build.line) ?? { own: [], other: [] };
    (build.root !== null ? row.own : row.other).push(build);
    lines.set(build.line, row);
  }
  const ordered = [...lines.entries()].sort(([a], [b]) => compareLines(a, b));
  const byLine = ordered.flatMap(([, row]) => [...row.own, ...row.other]);
  const fits = byLine.length <= MAX_OPTIONS;
  const listed = fits ? byLine : [...ordered.flatMap(([, row]) => row.own), ...ordered.flatMap(([, row]) => row.other)].slice(0, MAX_OPTIONS);
  const counts = ordered.map(([line, row]) => `${line} ${row.own.length + row.other.length} 个${row.other.length > 0 ? `（有自己知识根的 ${row.own.length} 个）` : ''}`).join('、');
  const order = fits ? '按版本线从新到旧，每条线先列有自己知识根的' : '先按版本线从新到旧列出全部有自己知识根的，再列其余的';
  const rest = fits ? '' : '；没列出的：start_run 写上 version（版本线），这里就只列这条线的全部构建';
  return {
    options: listed.map((build) => build.name),
    options_coverage: { complete: fits, examined: listed.length, total: byLine.length, note: `${what}，${order}；各版本线：${counts}${rest}` },
  };
}

function basisClaim(input: {
  field: 'product' | 'version' | 'build' | 'unversioned_root';
  text: string;
  data: Record<string, unknown>;
  provenance: ProvenanceType;
  warrant: Warrant;
  grounds: string[];
  bound: string[];
  at: string;
}): Claim {
  return Claim.parse({
    statement: { text: input.text, data: { field: input.field, ...input.data } },
    qualifier: {
      nature: 'fact',
      provenance: input.provenance,
      ...(input.provenance === 'projected' ? { basis_rank: 'rule_over_claims' as const } : {}),
      marks: [],
      collected_at: input.at,
    },
    grounds: input.grounds,
    warrant: input.warrant,
    validity: { status: 'valid', bound: [...new Set(input.bound)].sort(), premises: [] },
  });
}

const provides = (product: ProductHandle, catalogs: readonly string[]): boolean => catalogs.every((id) => product.product.catalogs.some((c) => c.id === id));
const namesOf = (products: readonly ProductHandle[]): string[] => products.flatMap((p) => p.product.names);

/**
 * A build as select_build sees it (SelectBuildInput.candidates): its single sources only. A role that lists external objects
 * (BuildInfo.sources, for example every case document a build covers) can hold thousands of ids per build, which would make
 * the sandbox input of the choice grow with the knowledge base; a choice of build never needs them.
 */
export function selectCandidate(build: KnownBuild): KnownBuild {
  return { ...build, sources: Object.fromEntries(Object.entries(build.sources).filter(([, value]) => typeof value === 'string')) };
}

export async function resolveTarget(ctx: EngineContext, user: Principal, workflow: LoadedWorkflow, input: Input, at: string, traceId: string): Promise<Target> {
  const { packs, knowledge } = ctx.deps;
  const binding = workflow.workflow.product;
  const readable = await packs.readableProducts(user);
  const human: Warrant = { producer: 'human', id: user.id };
  // A workflow that names no product and requires no catalog is bound to no product line (see boundProducts in runs/packs).
  const unbound = binding.id === undefined && binding.catalogs.length === 0 && workflow.workflow.contribution === undefined;
  // It may still run for one build the caller names exactly, product and build together, among the products the caller can
  // read: the run then locks that build's root (W03 R[0]: a declared build), so what it reads feeds that product's layer.
  // A product alone would let the default rule lock an unrelated build, and stays refused.
  const declaredTarget = unbound && input.product !== undefined && input.build !== undefined;
  const eligible = async (): Promise<ProductHandle[]> => {
    if (unbound) return [];
    if (binding.id !== undefined) {
      const fixed = await packs.productById(binding.id);
      return fixed !== null && readable.has(fixed.product.id) ? [fixed] : [];
    }
    return (await packs.products()).filter((p) => provides(p, binding.catalogs) && readable.has(p.product.id));
  };

  // ---- product line
  let product: ProductHandle | null = null;
  let declaredProduct = false;
  if (input.product !== undefined) {
    const named = await packs.productByName(input.product);
    const ok = (!unbound || declaredTarget) && named !== null && readable.has(named.product.id) && (unbound || (binding.id !== undefined ? named.product.id === binding.id : provides(named, binding.catalogs)));
    if (!ok) {
      if (unbound && !declaredTarget) throw unresolved('/product', '这个任务包不绑定产品线，不写 build 时不能指定产品', [], '去掉 product 参数；要按某个构建读取并锁定它的知识根时，product 和 build 两项都写');
      const options = namesOf(unbound ? (await packs.products()).filter((p) => readable.has(p.product.id)) : await eligible());
      throw unresolved('/product', `产品“${input.product}”不是这个任务包能用的产品线`, options, options.length > 0 ? '改用下面列出的产品名称之一（同一产品线的任何名称都可以）' : undefined);
    }
    product = named;
    declaredProduct = true;
  } else if (binding.id !== undefined || binding.catalogs.length > 0) {
    const candidates = await eligible();
    if (candidates.length === 0) throw unresolved('/product', '没有能提供这个任务包所需目录的产品线', [], '请管理员安装对应的产品包');
    if (candidates.length > 1) throw unresolved('/product', `有 ${candidates.length} 条产品线都能用，请用 product 参数指定一条`, namesOf(candidates), '用 product 参数写明产品名称');
    product = candidates[0];
  }
  if (product === null) {
    if (input.version !== undefined || input.build !== undefined) {
      throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION', '这个任务包不绑定产品线，不能指定版本或构建', { path: input.build !== undefined ? '/build' : '/version', fix: unbound && input.build !== undefined ? '去掉 build 参数；要按这个构建读取时同时写 product' : '去掉 version 和 build 参数' })]);
    }
    return { product: null, build: null, buildName: null, line: null, root: null, basis: [] };
  }
  const pid = product.product.id;
  const basis: Claim[] = [
    basisClaim({
      field: 'product',
      text: `产品线 ${pid}（${product.product.names.join('、')}）`,
      data: { value: pid, names: product.product.names, ...(input.product !== undefined ? { requested: input.product } : {}) },
      provenance: declaredProduct ? 'declared' : 'projected',
      warrant: declaredProduct ? human : { producer: 'function', id: BINDING_RULE },
      grounds: [],
      bound: [workflow.pack.digest, product.digest],
      at,
    }),
  ];

  // ---- build and root
  let structuralLines:string[]=[];
  if(workflow.workflow.feeding?.require_version&&input.version===undefined&&input.build===undefined&&knowledge.feeding){
    for(const supplied of Object.values(input.inputs).flat()){
      if('reference'in supplied){const ref=parseReference(supplied.reference);if(ref.scheme==='src')structuralLines.push(...await knowledge.feeding.sourceLines(user,ref.sha256,{product:pid}));}
      else if('external'in supplied&&await ctx.deps.external.accepts(supplied.external,{principal:user,purpose:'按来源结构选择版本'})){
        const read=await ctx.deps.external.read(supplied.external,{principal:user,purpose:'按来源结构选择版本'});if(!read.ok)continue;const chosen=read.artifacts.find(row=>row.name==='content')??read.artifacts.find(row=>row.name==='original');if(chosen)structuralLines.push(...await knowledge.feeding.sourceLines(user,chosen.artifact.body.sha256,{product:pid,sourceRecord:chosen.artifact.digest,metaSource:read.artifacts.find(row=>row.name==='meta')?.artifact.body.sha256,metaRecord:read.artifacts.find(row=>row.name==='meta')?.artifact.digest,readManifest:read.manifest}));
      }
    }
    structuralLines=[...new Set(structuralLines)];if(structuralLines.length!==1)throw unresolved('/version',structuralLines.length?'来源结构存在多个版本层，不能自动选择':'来源结构未声明版本；缺版本事实，请在 start_run 指定版本', [...new Set((await knowledge.builds(pid)).map(build=>build.line))]);
  }
  const requestedLine=input.version??structuralLines[0];
  let knownBuilds: Promise<KnownBuild[]> | undefined;
  const allKnown = (): Promise<KnownBuild[]> => knownBuilds ??= knowledge.builds(pid);
  const seeds = new Map<string, Promise<Awaited<ReturnType<NonNullable<typeof knowledge.feeding>['seedFor']>>>>();
  const seed = (line:string) => {
    let value=seeds.get(line);
    if(!value){value=knowledge.feeding?.seedFor(pid,line)??Promise.resolve(null);seeds.set(line,value);}
    return value;
  };
  const seedlings = new Map<string, Promise<RootInfo | null>>();
  const seedling = (line:string) => {
    let value=seedlings.get(line);
    if(!value){value=knowledge.seedlingRoot?.(pid,line)??Promise.resolve(null);seedlings.set(line,value);}
    return value;
  };
  const withRoot = async (): Promise<KnownBuild[]> => {
    const out:KnownBuild[]=[];
    for(const build of await allKnown()){
      if(requestedLine!==undefined){const a=await seed(requestedLine),b=await seed(build.line);if(a&&b?a.root!==b.root:build.line!==requestedLine)continue;}
      if(build.root!==null||await seedling(build.line))out.push(build);
    }
    return out;
  };
  let build: KnownBuild;
  let buildName: string;
  let buildText: string;
  let buildWarrant: Warrant;
  let alternatives: string[] = [];
  if (input.build !== undefined) {
    const found = await knowledge.resolveBuild(pid, input.build);
    if (found === null) {
      // The statement is the result of one lookup over every build of the line: say the rule, the scope and when (B01).
      const all = await allKnown();
      const [options, extra] = withBuilds(await withRoot(), `可以锁定知识根的构建${requestedLine !== undefined ? `（版本线 ${requestedLine}）` : ''}`, {
        warrant: NAME_RULE,
        provenance: 'projected',
        collected_at: at,
        coverage: { complete: true, examined: all.length, total: all.length, note: '名字或别名不分大小写逐字相等才算，不按部分文字或版本号猜' },
      });
      throw unresolved('/build', `产品线 ${pid} 里没有名字或别名是“${input.build}”的构建`, options, '把 build 改成下面列出的一个名字，照原样抄写', extra);
    }
    if (input.version !== undefined && found.line !== input.version) {
      const [options, extra] = withBuilds(await withRoot(), `版本线 ${input.version} 里可以锁定知识根的构建`, { warrant: NAME_RULE, provenance: 'projected', collected_at: at });
      throw unresolved('/build', `构建“${input.build}”属于版本线 ${found.line}，不在版本线 ${input.version} 里`, options, '去掉 version，或把 build 改成下面列出的一个名字', extra);
    }
    build = found;
    buildName = input.build;
    buildText = `运行者指定构建 ${input.build}${found.base !== input.build ? `（使用构建 ${found.base} 的知识树）` : ''}`;
    buildWarrant = human;
  } else {
    const candidates = await withRoot();
    const line = input.version !== undefined ? `版本线 ${input.version} ` : '';
    if (candidates.length === 0) {
      const [all, extra] = withBuilds((await allKnown()).filter(b => input.version === undefined || b.line === input.version), `${line}已知的构建（都还没有知识根）`, { provenance: 'projected', collected_at: at });
      throw unresolved(input.version !== undefined ? '/version' : '/build', `产品线 ${pid} ${line}下没有已产出知识根的构建`, all, '换一个版本线；要这条版本线的知识，请管理员同步这条产品线（circle-hub knowledge sync）', extra);
    }
    const select = product.product.select_build;
    if (select !== undefined) {
      const request = SelectBuildInput.safeParse({ line: input.version ?? null, candidates: candidates.map(selectCandidate), request: input.parameters ?? {} });
      let chosen: z.infer<typeof SelectBuildOutput> | null = null;
      try {
        if (!request.success) throw new TypeError(`the build candidates are not select-build-input@1: ${request.error.message.slice(0, 500)}`);
        const out = await callPackFunction({ packDir: product.directory, module: select.module, export: select.export }, request.data, ctx.deps.sandboxLimits, ctx.deps.sandbox);
        const parsed = SelectBuildOutput.safeParse(out.output);
        if (parsed.success) chosen = parsed.data;
        else ctx.log({ traceId, run: null, what: 'select_build', detail: `output is not select-build-output@1: ${parsed.error.message.slice(0, 500)}` });
      } catch (error) {
        ctx.log({ traceId, run: null, what: 'select_build', detail: describe(error) });
      }
      const picked = chosen === null ? undefined : candidates.find((c) => c.name === chosen.build);
      if (chosen === null || picked === undefined) {
        const [options, extra] = withBuilds(candidates, '可以锁定知识根的构建');
        throw unresolved('/build', '产品包的选构建规则没有给出可用的构建，请在 build 参数里写明构建', options, '把 build 写成下面列出的一个名字', extra);
      }
      build = picked;
      buildName = picked.name;
      // The rule's own basis, then the scope it chose from (A05 R[1]): how many builds could be locked and how many were released.
      buildText = `${chosen.basis}（规则从 ${candidates.length} 个可以锁定知识根的构建里选，其中已发布的 ${candidates.filter((b) => b.released_at !== null).length} 个）`;
      alternatives = (chosen.alternatives ?? []).filter((a) => a !== picked.name && candidates.some((c) => c.name === a));
      buildWarrant = { producer: 'function', id: `${product.id}@${product.version}/${select.module}#${select.export ?? 'default'}` };
    } else {
      const released = candidates.filter((b) => b.released_at !== null).sort((a, b) => (b.released_at as string).localeCompare(a.released_at as string));
      if (released.length === 0) {
        const [options, extra] = withBuilds(candidates, '可以锁定知识根的构建（都还没有发布）');
        throw unresolved('/build', `产品线 ${pid} ${line}下没有已发布、已产出知识根的构建，请在 build 参数里写明构建`, options, '把 build 写成下面列出的一个名字', extra);
      }
      build = released[0];
      buildName = build.name;
      alternatives = released.slice(1, 6).map((b) => b.name);
      const unreleased = candidates.length - released.length;
      buildText = `按默认规则选定${line ? `${line}中` : ''}最新的已发布构建 ${build.name}（发布于 ${build.released_at}）${alternatives.length > 0 ? `；可用 build 参数改选：${alternatives.join('、')}（列出 ${alternatives.length} 个，已发布的共 ${released.length - 1} 个）` : ''}${unreleased > 0 ? `；另有 ${unreleased} 个可以锁定知识根的未发布构建不参加默认选择，要用它们就在 build 里写名字` : ''}`;
      buildWarrant = { producer: 'function', id: DEFAULT_RULE };
    }
  }
  const read = knowledge.rootForRead ? await knowledge.rootForRead(pid, { build: buildName, line: build.line }) : null;
  const root = knowledge.rootForRead
    ? read?.info ?? null
    : await knowledge.seedlingRoot?.(pid, build.line) ?? await knowledge.rootOfBuild(pid, buildName);
  // Which tree the run reads (B01 qualifier): the line's seedling root or the build's own sync root, and the build it was produced from.
  if (root !== null && read !== null) {
    const from = root.build !== null && root.build.name !== buildName && root.build.name !== build.base ? `，这个根产自构建 ${root.build.name}` : '';
    buildText += read.source === 'seedling'
      ? `；锁定的是版本线 ${build.line} 的树苗根 ${root.root.slice(0, 12)}${from}${read.sync ? `；这个构建另有同步根 ${read.sync.root.slice(0, 12)}，没有锁定` : ''}`
      : `；锁定的是这个构建的同步根 ${root.root.slice(0, 12)}${from}`;
  }
  if (root === null) {
    const [options, extra] = withBuilds(await withRoot(), '可以锁定知识根的构建', { provenance: 'projected', collected_at: at });
    throw unresolved('/build', `构建 ${buildName} 还没有知识根`, options, '换下面列出的一个构建；要这个构建的知识，请管理员同步这条产品线（circle-hub knowledge sync）', extra);
  }
  const ground = treeReference(root.root, '/');
  basis.push(
    basisClaim({
      field: 'version',
      text: `版本线 ${build.line}`,
      data: { value: build.line },
      provenance: input.version !== undefined ? 'declared' : 'projected',
      warrant: input.version !== undefined ? human : { producer: 'function', id: structuralLines.length?'hub.feeding.source_structure@1':LINE_RULE },
      grounds: [ground],
      bound: [root.root, root.composition],
      at,
    }),
    basisClaim({
      field: 'build',
      text: buildText,
      data: {
        value: buildName,
        base: build.base,
        family: build.family,
        line: build.line,
        root: root.root,
        composition: root.composition,
        ...(alternatives.length > 0 ? { alternatives } : {}),
      },
      provenance: input.build !== undefined ? 'declared' : 'projected',
      warrant: buildWarrant,
      grounds: [ground],
      bound: [root.root, root.composition, product.digest],
      at,
    }),
  );
  const unversionedRoot = await knowledge.unversionedRoot?.(pid) ?? null;
  if (unversionedRoot !== null && (unversionedRoot.product !== pid || unversionedRoot.build !== null)) throw unresolved('/product', '不分版本的根与产品范围不符', [], '请管理员修复产品根指针后重开运行');
  basis.push(basisClaim({
    field: 'unversioned_root',
    text: unversionedRoot === null ? '这条产品线还没有不分版本的根；下一步：管理员同步这条产品线（circle-hub knowledge sync）' : '产品线不分版本的当前根',
    data: { value: unversionedRoot?.root ?? null, root: unversionedRoot?.root ?? null, composition: unversionedRoot?.composition ?? null },
    provenance: 'projected', warrant: { producer: 'function', id: 'runs.unversioned_root@1' },
    grounds: unversionedRoot === null ? [] : [treeReference(unversionedRoot.root, '/')],
    bound: unversionedRoot === null ? [product.digest] : [product.digest, unversionedRoot.root, unversionedRoot.composition], at,
  }));
  return { product, build, buildName, line: build.line, root, unversionedRoot, basis, ...(knownBuilds?{knownBuilds:await knownBuilds}:{}) };
}
