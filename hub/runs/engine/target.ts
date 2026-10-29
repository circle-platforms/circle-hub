// The run target (W03 R[0], R[5], W06 F[6], K01 R[6], R[10]): the product line (any of its names, one line), the version
// line and the build, each with its basis as a claim. A build the caller names is a declaration; otherwise the product pack's
// select_build rule chooses (projected), or, when the product has none, the newest released build of the line with a root
// (the documented default), with alternatives the caller may name instead. The run locks the root of the chosen build.
import type { ProvenanceType } from '../../../contracts/generated/vocabulary.ts';
import { Claim, type Warrant } from '../../../contracts/src/claim.ts';
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
const MAX_OPTIONS = 20;

function unresolved(path: string, message: string, options: string[], fix?: string): Refusal {
  return new Refusal([protocolError('REFERENCE_UNRESOLVED', message, { path, ...(options.length > 0 ? { options: options.slice(0, MAX_OPTIONS) } : {}), ...(fix ? { fix } : {}) })]);
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
    const ok = !unbound && named !== null && readable.has(named.product.id) && (binding.id !== undefined ? named.product.id === binding.id : provides(named, binding.catalogs));
    if (!ok) {
      const options = namesOf(await eligible());
      if (unbound) throw unresolved('/product', '这个任务包不绑定产品线，不能指定产品', [], '去掉 product 参数');
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
      throw new Refusal([protocolError('SUBMISSION_SCHEMA_VIOLATION', '这个任务包不绑定产品线，不能指定版本或构建', { path: input.build !== undefined ? '/build' : '/version', fix: '去掉 version 和 build 参数' })]);
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
    if (found === null) throw unresolved('/build', `产品线 ${pid} 里没有构建“${input.build}”`, (await withRoot()).map((b) => b.name), '改用下面列出的构建之一');
    if (input.version !== undefined && found.line !== input.version) {
      throw unresolved('/build', `构建“${input.build}”属于版本线 ${found.line}，不在版本线 ${input.version} 里`, (await withRoot()).map((b) => b.name));
    }
    build = found;
    buildName = input.build;
    buildText = `运行者指定构建 ${input.build}${found.base !== input.build ? `（使用构建 ${found.base} 的知识树）` : ''}`;
    buildWarrant = human;
  } else {
    const candidates = await withRoot();
    const line = input.version !== undefined ? `版本线 ${input.version} ` : '';
    if (candidates.length === 0) {
      const all = (await allKnown()).filter(b => input.version === undefined || b.line === input.version).map((b) => b.name);
      throw unresolved(input.version !== undefined ? '/version' : '/build', `产品线 ${pid} ${line}下没有已产出知识根的构建`, all, '先同步这条产品线的知识，或换一个版本线');
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
        throw unresolved('/build', '产品包的选构建规则没有给出可用的构建，请在 build 参数里写明构建', candidates.map((b) => b.name));
      }
      build = picked;
      buildName = picked.name;
      buildText = chosen.basis;
      alternatives = (chosen.alternatives ?? []).filter((a) => a !== picked.name && candidates.some((c) => c.name === a));
      buildWarrant = { producer: 'function', id: `${product.id}@${product.version}/${select.module}#${select.export ?? 'default'}` };
    } else {
      const released = candidates.filter((b) => b.released_at !== null).sort((a, b) => (b.released_at as string).localeCompare(a.released_at as string));
      if (released.length === 0) {
        throw unresolved('/build', `产品线 ${pid} ${line}下没有已发布、已产出知识根的构建，请在 build 参数里写明构建`, candidates.map((b) => b.name));
      }
      build = released[0];
      buildName = build.name;
      alternatives = released.slice(1, 6).map((b) => b.name);
      buildText = `按默认规则选定${line ? `${line}中` : ''}最新的已发布构建 ${build.name}（发布于 ${build.released_at}）${alternatives.length > 0 ? `；可用 build 参数改选：${alternatives.join('、')}` : ''}`;
      buildWarrant = { producer: 'function', id: DEFAULT_RULE };
    }
  }
  const root = knowledge.rootForRead
    ? (await knowledge.rootForRead(pid, { build: buildName, line: build.line }))?.info ?? null
    : await knowledge.seedlingRoot?.(pid, build.line) ?? await knowledge.rootOfBuild(pid, buildName);
  if (root === null) throw unresolved('/build', `构建 ${buildName} 还没有知识根`, (await withRoot()).map((b) => b.name), '换一个已产出知识根的构建');
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
    text: unversionedRoot === null ? '这条产品线还没有不分版本的根；下一步：同步这条产品线' : '产品线不分版本的当前根',
    data: { value: unversionedRoot?.root ?? null, root: unversionedRoot?.root ?? null, composition: unversionedRoot?.composition ?? null },
    provenance: 'projected', warrant: { producer: 'function', id: 'runs.unversioned_root@1' },
    grounds: unversionedRoot === null ? [] : [treeReference(unversionedRoot.root, '/')],
    bound: unversionedRoot === null ? [product.digest] : [product.digest, unversionedRoot.root, unversionedRoot.composition], at,
  }));
  return { product, build, buildName, line: build.line, root, unversionedRoot, basis, ...(knownBuilds?{knownBuilds:await knownBuilds}:{}) };
}
