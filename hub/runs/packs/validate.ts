// Validation of a pack read from its directory (T01, W02, W03, W05, C05, C07, A03): every declaration file parsed with its
// contract shape, then the rules that hold ACROSS files. Messages are Chinese, name the file and the field and say how to
// fix; nothing is published while one problem remains. Product dialect never appears here: only the shapes and the rules.
import { packSchema } from '../engine/slots.ts';
import type { z } from 'zod';
import { CORE_VIOLATION_CODES, PROTOCOL_CODES } from '../../../contracts/generated/protocol.ts';
import { ERROR_HANDLING, isCheckTier, labelOf, TARGET, VERDICT, type CheckTier, type PackKind } from '../../../contracts/generated/vocabulary.ts';
import {
  ChecksFile,
  KnowledgeFile,
  LedgerFile,
  MAX_CHECK_READ_BYTES,
  PackSample,
  REQUIRED_FILES,
  PublishableRequirementsFile,
  SlotsFile,
  SkillDeclaration,
  WorkflowFile,
  type CheckEntry,
} from '../../../contracts/src/pack.ts';
import { ProductDeclaration, ProductId, type PackFunctionRef } from '../../../contracts/src/product.ts';
import { SystemProfile } from '../../../contracts/src/resources.ts';
import { scanForCredentials, sha256Hex } from '../../records/api.ts';
import { getInterpreter, INTERPRETERS } from '../../rules/api.ts';
import { scanTools, scanFunctions, SANDBOX_IMPORT_POLICY, type FunctionEntry, type ImportPolicy } from './imports.ts';
import { fieldText, isRecord, pointerOf, problem, readJsonFile, shapeProblems, utf8 } from './problems.ts';
import { dispatchCountOf, repetitionSummary } from '../engine/repetition.ts';
import type {
  LoadedSample,
  PackDeclarations,
  PackDirectory,
  PackProblem,
  PackValidation,
  SamplePolarity,
  WorkflowDeclarations,
} from './types.ts';
import { isCanonicalVersion, MAX_PACK_REF_LENGTH, packVersionKey, parsePackRef } from './versions.ts';

export interface ValidateOptions {
  /** Import policy of the static scan; default the sandbox's (SANDBOX_IMPORT_POLICY). */
  policy?: ImportPolicy;
}

const SKILL = 'SKILL.md';
const KNOWLEDGE = 'knowledge.json';
/** Declaration files and the kind they belong to: the required files of REQUIRED_FILES plus the optional knowledge.json. */
const DECLARATION_KIND: ReadonlyMap<string, PackKind> = new Map([
  ...Object.entries(REQUIRED_FILES).flatMap(([kind, files]) => files.filter((f) => f !== SKILL).map((f) => [f, kind as PackKind] as const)),
  [KNOWLEDGE, 'workflow'],
  ['ledger.json', 'workflow'],
]);
/** The two sample folders, by polarity. */
const SAMPLE_FOLDERS: Readonly<Record<SamplePolarity, string>> = { positive: 'samples/positive/', negative: 'samples/negative/' };
const TABLE_PLACES = ['tables/', 'policies/'];
/** A pack code after `<pack id>.` */
const PACK_CODE_TAIL = /^[a-z0-9_][a-z0-9_.-]*$/;

const hasText = (value: unknown): boolean => typeof value === 'string' && value.trim() !== '';
/** Credential findings reported per file; the rest are counted. */
const MAX_CREDENTIAL_PROBLEMS = 5;

const tierText = (tier: CheckTier): string => `${labelOf('check_tier', tier)}档`;

/**
 * Problems with the version of a manifest, also for the registry before anything is written: one spelling per number, and
 * `id@x.y.z` short enough to be named (a version no reference can name could never be found once published).
 */
export function versionProblems(manifest: { id: string; version: string }): PackProblem[] {
  const ref = packVersionKey(manifest.id, manifest.version);
  if (ref.length > MAX_PACK_REF_LENGTH) {
    return [
      problem('manifest.version', 'pack.json', `包号加版本号（${manifest.id}@${manifest.version.slice(0, 24)}…）有 ${ref.length} 个字符，超过 ${MAX_PACK_REF_LENGTH} 个；这样的版本无法引用`, `把版本号改短：包号、@ 和版本号合起来不超过 ${MAX_PACK_REF_LENGTH} 个字符`, {
        field: '/version',
      }),
    ];
  }
  if (!isCanonicalVersion(manifest.version)) {
    return [problem('manifest.version', 'pack.json', `版本号 ${manifest.version} 的某一段有前导零，同一个版本会有两种写法`, `写成 ${manifest.version.split('.').map((part) => String(BigInt(part))).join('.')}`, { field: '/version' })];
  }
  // Whatever else parsePackRef refuses: an empty answer here promises that the reference parses.
  if (parsePackRef(ref) === null) return [problem('manifest.version', 'pack.json', `${ref} 不是可以引用的包版本`, '核对包号和版本号的写法', { field: '/version' })];
  return [];
}

/**
 * Credentials in pack content: every file and the manifest's title and description, as the records scanner finds them. Pack
 * content reaches every assigned user (SKILL.md the model), and secrets enter the Hub only through the vault. A problem names
 * the file and the line, never the text that was found.
 */
function credentialProblems(directory: PackDirectory): PackProblem[] {
  const out: PackProblem[] = [];
  const fix = '删掉这一处；读取需要的凭据由管理员存进保管库，资源配置引用它';
  for (const [field, text] of [['/title', directory.manifest.title], ['/description', directory.manifest.description]] as const) {
    if (scanForCredentials(new TextEncoder().encode(text)).findings.length > 0) out.push(problem('file.credential', 'pack.json', `pack.json 的 ${field} 像是含有凭据`, fix, { field }));
  }
  for (const file of directory.files) {
    const scan = scanForCredentials(file.bytes);
    for (const finding of scan.findings.slice(0, MAX_CREDENTIAL_PROBLEMS)) {
      out.push(problem('file.credential', file.path, `${file.path} 第 ${finding.line} 行像是凭据（${finding.detector}）；包的内容会交给每个分到包的用户和模型，凭据只经保管库进入 Hub`, fix, { line: finding.line }));
    }
    const more = scan.findings.length - MAX_CREDENTIAL_PROBLEMS;
    if (more > 0 || scan.truncated) out.push(problem('file.credential', file.path, `${file.path} 还有${scan.truncated ? '更多' : ` ${more} 处`}像是凭据的地方，没有一一列出`, fix));
  }
  return out;
}

/**
 * Named closed sets a table reaches with `{ name }` (membership@1 `set`, coverage@1 `required`: the ClosedSet of the table
 * language), by pointer.
 */
function namedSets(table: Record<string, unknown>): { pointer: string; name: string }[] {
  const out: { pointer: string; name: string }[] = [];
  for (const [key, value] of Object.entries(table)) {
    if (isRecord(value) && Object.keys(value).length === 1 && typeof value.name === 'string') out.push({ pointer: pointerOf([key, 'name']), name: value.name });
  }
  return out;
}

/** Pack codes are namespaced by the pack id (`<pack>.<code>`); core and protocol codes come from the registry. */
export function isKnownCode(code: string, packId: string): boolean {
  if (code === '*') return true;
  if (Object.hasOwn(CORE_VIOLATION_CODES, code) || Object.hasOwn(PROTOCOL_CODES, code)) return true;
  return code.startsWith(`${packId}.`) && PACK_CODE_TAIL.test(code.slice(packId.length + 1));
}

/** The tier a check's outcomes get, as runCheck decides it: the declaration's, else the table's, else by the basis. */
export function effectiveTier(check: CheckEntry, table: unknown): CheckTier {
  if (check.tier !== undefined) return check.tier;
  if (check.interpreter !== undefined) {
    const declared = isRecord(table) ? table.tier : undefined;
    if (isCheckTier(declared)) return declared;
    return isRecord(table) && hasText(table.basis) ? 'blocking' : 'advisory';
  }
  return hasText(check.basis) ? 'blocking' : 'advisory';
}

/** A blocking check names its contract clause (C05 R[1]): its own basis, or for an interpreter the table's. */
function hasBasis(check: CheckEntry, table: unknown): boolean {
  return hasText(check.basis) || (check.interpreter !== undefined && isRecord(table) && hasText(table.basis));
}

/**
 * Closed sets the pack declares in slots.schema.json, named `<requirement>.codes` and `<requirement>.ranks`: what
 * membership@1 and coverage@1 tables reach with `{ name }` (CheckContext.sets).
 */
export function closedSetsOf(slots: SlotsFile): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const scope of [slots.item, slots.run]) {
    for (const [key, declaration] of Object.entries(scope)) {
      if (declaration.codes) out[`${key}.codes`] = declaration.codes.map((c) => c.code);
      if (declaration.ranks) out[`${key}.ranks`] = declaration.ranks.map((c) => c.code);
    }
  }
  return out;
}

class Collector {
  readonly problems: PackProblem[] = [];
  readonly warnings: PackProblem[] = [];
  readonly files: ReadonlyMap<string, Uint8Array>;
  constructor(files: ReadonlyMap<string, Uint8Array>) {
    this.files = files;
  }
  add(p: PackProblem): void {
    this.problems.push(p);
  }
  warn(p: PackProblem): void {
    this.warnings.push(p);
  }
  /** Parses a declaration file with its contract shape; null (with problems) when absent, not JSON or off the shape. */
  parse<T>(rule: string, file: string, schema: z.ZodType<T>, id: string, source = 'contracts/src/pack.ts'): T | null {
    const bytes = this.files.get(file);
    if (bytes === undefined) return null;
    const json = readJsonFile(file, bytes);
    if (!json.ok) {
      this.add(json.problem);
      return null;
    }
    const parsed = schema.safeParse(json.value);
    if (!parsed.success) {
      this.problems.push(...shapeProblems(rule, file, id, parsed.error.issues, source));
      return null;
    }
    return parsed.data;
  }
}

function functionEntry(ref: PackFunctionRef, file: string, field: string): FunctionEntry {
  return { module: ref.module, export: ref.export ?? 'default', file, field };
}

// ---------------------------------------------------------------- workflow packs

function readSamples(c: Collector, paths: readonly string[]): LoadedSample[] {
  const samples: LoadedSample[] = [];
  const ids = new Map<string, string>();
  for (const path of paths) {
    if (!path.startsWith('samples/')) continue;
    const polarity = (Object.keys(SAMPLE_FOLDERS) as SamplePolarity[]).find((p) => path.startsWith(SAMPLE_FOLDERS[p]));
    if (polarity === undefined) {
      c.add(problem('samples.place', path, `${path} 不在 samples/positive/ 或 samples/negative/ 下`, '正例放 samples/positive/，反例放 samples/negative/'));
      continue;
    }
    if (!path.endsWith('.json')) {
      c.add(problem('samples.format', path, `${path} 不是 .json 文件；样例是 pack-sample@1 的 JSON`, '把样例写成 .json，或者把这个文件移出 samples/'));
      continue;
    }
    const json = readJsonFile(path, c.files.get(path) as Uint8Array);
    if (!json.ok) {
      c.add(json.problem);
      continue;
    }
    const parsed = PackSample.safeParse(json.value);
    if (!parsed.success) {
      c.problems.push(...shapeProblems('samples.shape', path, 'pack-sample@1', parsed.error.issues));
      continue;
    }
    const sample = parsed.data;
    const earlier = ids.get(sample.id);
    if (earlier !== undefined) c.add(problem('samples.duplicate_id', path, `样例号 ${sample.id} 已经用在 ${earlier}`, '给每个样例各自的 id', { field: '/id' }));
    ids.set(sample.id, path);
    if (sample.expect.length === 0) {
      c.add(problem('samples.expect_empty', path, `样例 ${sample.id} 的 expect 是空的；检查至少给出一个结果`, '按顺序写出检查应给的每个结果', { field: '/expect' }));
    }
    const verdict = (v: (typeof VERDICT)[number]): string => labelOf('verdict', v);
    sample.expect.forEach((e, i) => {
      if (e.verdict === 'abstain') {
        c.add(problem('samples.abstain', path, `样例 ${sample.id} 的第 ${i + 1} 个期望是${verdict('abstain')}；检查从不${verdict('abstain')}（V01）`, `改成 ${VERDICT.filter((v) => v !== 'abstain').join('、')} 之一`, { field: `/expect/${i}/verdict` }));
      }
    });
    if (polarity === 'positive' && sample.expect.some((e) => e.verdict !== 'support')) {
      c.add(problem('samples.polarity', path, `正例 ${sample.id} 期望了${verdict('support')}以外的结果；正例只期望${verdict('support')}`, `期望${verdict('refute')}的样例放进 samples/negative/`, { field: '/expect' }));
    }
    if (polarity === 'negative' && !sample.expect.some((e) => e.verdict === 'refute')) {
      c.add(problem('samples.polarity', path, `反例 ${sample.id} 没有期望任何${verdict('refute')}；反例至少期望一次${verdict('refute')}`, `写出检查应给的${verdict('refute')}，或者把样例放进 samples/positive/`, { field: '/expect' }));
    }
    samples.push({ file: path, polarity, sample });
  }
  return samples;
}

function judgmentRequirement(r: { accepted_producer: string }): boolean {
  return r.accepted_producer !== 'fact';
}

async function validateWorkflow(c: Collector, directory: PackDirectory, policy: ImportPolicy): Promise<{ declarations: WorkflowDeclarations; samples: LoadedSample[] } | null> {
  const { manifest } = directory;
  const workflow = c.parse('workflow.shape', 'workflow.json', WorkflowFile, 'workflow@1');
  const requirements = c.parse('requirements.shape', 'requirements.json', PublishableRequirementsFile, 'requirements@1');
  const checks = c.parse('checks.shape', 'checks.json', ChecksFile, 'checks@1');
  const slots = c.parse('slots.shape', 'slots.schema.json', SlotsFile, 'slots@1');
  const knowledgePresent = c.files.has(KNOWLEDGE);
  const knowledge = knowledgePresent ? c.parse('knowledge.shape', KNOWLEDGE, KnowledgeFile, 'knowledge@1') : null;

  const ledger = c.files.has('ledger.json') ? c.parse('ledger.shape', 'ledger.json', LedgerFile, 'ledger@1') : null;
  if(workflow?.predecessor_access==='view'&&requirements){
    if(!requirements.requirements.length||requirements.requirements.some(row=>row.independent_of!=='predecessor'))c.add(problem('workflow.predecessor_access','workflow.json','只读前驱要求每个要求项都独立于前驱','所有要求项声明 independent_of: predecessor，或移除 predecessor_access',{field:'/predecessor_access'}));
    if(workflow.criterion_review&&workflow.inputs.some(row=>row.default_from_predecessor!==undefined||row.from_runs!==undefined))c.add(problem('workflow.predecessor_default','workflow.json','判据复核前驱不能缺省绑定已受理结果','显式绑定声明提交的 rec:，不要绑定前驱结果',{field:'/inputs'}));
  }
  if(workflow?.criterion_review&&requirements&&(workflow.predecessor_access!=='view'||requirements.requirements.length!==1||requirements.requirements.some(row=>!row.independence_by_account)))c.add(problem('workflow.criterion_review','workflow.json','判据复核需要只读前驱和一个按账号独立的要求项','声明 predecessor_access: view 和 independence_by_account: true',{field:'/criterion_review'}));
  if (requirements) {
    for (const [i, row] of (ledger?.shapes ?? []).entries()) {
      const requirement = requirements.requirements.find(r => r.key === row.requirement);
      const field = `/shapes/${i}`;
      if (!requirement) c.add(problem('ledger.requirement', 'ledger.json', `要求项 ${row.requirement} 没有声明`, '改成 requirements.json 中的要求项', {field:field+'/requirement'}));
      else if (!requirement.run_table) c.add(problem('ledger.run_table', 'ledger.json', `要求项 ${row.requirement} 不接受运行内的表`, '先在该要求项声明 run_table: true', {field:field+'/requirement'}));
      if (!getInterpreter(row.interpreter)) c.add(problem('ledger.interpreter', 'ledger.json', `解释器 ${row.interpreter} 没有安装`, '使用已安装的核心解释器', {field:field+'/interpreter'}));
      if (ledger!.shapes.findIndex(r => r.requirement === row.requirement && r.interpreter === row.interpreter) !== i) c.add(problem('ledger.duplicate', 'ledger.json', '同一判定形状重复裁定', '删除重复的形状', {field}));
    }
    requirements.requirements.forEach((r,i) => {
      if (r.run_table && !ledger?.shapes.some(shape=>shape.requirement===r.key)) c.warn(problem('ledger.unruled','requirements.json',`要求项 ${r.key} 的台账为空，带来的表都会是未裁定`, '由包作者在下一版 ledger.json 裁定允许的解释器', {field:`/requirements/${i}/run_table`}));
    });
  }

  let instructions: string | null = null;
  const skill = c.files.get(SKILL);
  if (skill !== undefined) {
    instructions = utf8(skill);
    if (instructions === null) c.add(problem('skill.encoding', SKILL, 'SKILL.md 不是 UTF-8 文本', '把 SKILL.md 存成 UTF-8 编码'));
    else if (instructions.trim() === '') c.add(problem('skill.empty', SKILL, 'SKILL.md 是空的；start_run 要把规程交给模型', '写出给模型的规程（纯文本）'));
  }
  const samples = readSamples(c, manifest.files.map((f) => f.path));

  // Catalogs the workflow requires: syntax is the shapes' (Versioned); here duplicates and the product line id.
  const declaredCatalogs = new Set<string>();
  if (workflow) {
    workflow.product.catalogs.forEach((id, i) => {
      if (declaredCatalogs.has(id)) c.add(problem('workflow.duplicate_catalog', 'workflow.json', `目录 ${id} 在 workflow.json 的 product.catalogs 里列了两次`, '删掉重复的一项', { field: `/product/catalogs/${i}` }));
      declaredCatalogs.add(id);
    });
    if (workflow.product.id !== undefined && !ProductId.safeParse(workflow.product.id).success) {
      c.add(problem('workflow.product_id', 'workflow.json', `product.id ${JSON.stringify(workflow.product.id)} 不是产品线号（小写字母、数字和连字符）`, `写${labelOf('pack_kind', 'product')} product.json 里的 id`, { field: '/product/id' }));
    }
  }
  if (knowledge) {
    const seen = new Set<string>();
    knowledge.requires.forEach((r, i) => {
      if (seen.has(r.catalog)) c.add(problem('knowledge.duplicate_catalog', KNOWLEDGE, `目录 ${r.catalog} 在 knowledge.json 里列了两次`, '删掉重复的一项', { field: `/requires/${i}/catalog` }));
      seen.add(r.catalog);
      declaredCatalogs.add(r.catalog);
    });
  }

  // Checks: the interpreter is installed, the table exists under tables/ or policies/, parses and is admitted (C04 R[0]); a
  // table that consults a catalog or a named closed set gets one at run time.
  const blockingOnArtifact = new Set<string>();
  const sets = slots ? closedSetsOf(slots) : null;
  if (checks) {
    for (const [k, check] of checks.checks.entries()) {
      const at = (field: string) => ({ field: `/checks/${k}/${field}` });
      // Every check must declare an explicit tier upon publication.
      if (check.tier === undefined) {
        c.add(problem('checks.tier_missing', 'checks.json', `任务包 ${manifest.id} 的检查 ${check.id} 没有声明 tier`, '声明 blocking、advisory 或模型里的其他档名', at('tier')));
      }
      const interpreter = check.interpreter === undefined ? undefined : getInterpreter(check.interpreter);
      if (check.interpreter !== undefined && interpreter === undefined) {
        c.add(problem('checks.interpreter_missing', 'checks.json', `检查 ${check.id} 用的解释器 ${check.interpreter} 没有安装（已安装：${[...INTERPRETERS.keys()].join('、')}）`, '改用已安装的解释器，或者写成包内函数', at('interpreter')));
      }
      let table: unknown;
      const path = check.table;
      if (path !== undefined) {
        if (!TABLE_PLACES.some((place) => path.startsWith(place))) {
          c.add(problem('checks.table_place', 'checks.json', `检查 ${check.id} 的表 ${path} 不在 tables/ 或 policies/ 下`, '把表移到 tables/（或 policies/）并改正路径', at('table')));
        } else if (!c.files.has(path)) {
          c.add(problem('checks.table_missing', 'checks.json', `检查 ${check.id} 的表 ${path} 在包里没有`, '补上这个表并写进 pack.json，或者改正路径', at('table')));
        } else {
          const json = readJsonFile(path, c.files.get(path) as Uint8Array);
          if (!json.ok) c.add(json.problem);
          else {
            table = json.value;
            for (const issue of interpreter?.validateTable(table) ?? []) {
              c.add(problem('checks.table_admission', path, `${path} 的 ${fieldText(issue.path)} 不能被 ${check.interpreter} 接受：${issue.message}`, `按 ${check.interpreter} 的表格式改正（contracts/src/tables.ts）`, { field: issue.path }));
            }
          }
        }
      }
      if (check.catalog !== undefined && !declaredCatalogs.has(check.catalog)) {
        c.add(problem('checks.catalog_undeclared', 'checks.json', `检查 ${check.id} 要查目录 ${check.catalog}，但 workflow.json 的 product.catalogs 和 knowledge.json 都没有声明它`, `在 workflow.json 的 product.catalogs（或 knowledge.json）里声明 ${check.catalog}`, at('catalog')));
      }
      if (check.interpreter !== undefined && interpreter !== undefined && isRecord(table)) {
        // The table language names the catalog the caller binds (catalog@1); a run binds one only where checks.json says which.
        if (typeof table.catalog === 'string' && check.catalog === undefined) {
          c.add(
            problem('checks.catalog_missing', 'checks.json', `检查 ${check.id} 的表 ${path} 按目录 ${table.catalog} 核对，checks.json 却没有给这个检查写 catalog；运行时不会绑定目录，每个结果都是${labelOf('verdict', 'unknown')}（缺输入）`, `给检查 ${check.id} 写 catalog：workflow.json 的 product.catalogs 或 knowledge.json 声明的目录号`, at('catalog')),
          );
        }
        for (const named of sets === null ? [] : namedSets(table)) {
          if (Object.hasOwn(sets as Record<string, string[]>, named.name)) continue;
          const declared = Object.keys(sets as Record<string, string[]>);
          c.add(
            problem('checks.set_unknown', path as string, `${path} 的 ${named.pointer} 指向闭集 ${named.name}，slots.schema.json 没有声明这个闭集；运行时这个检查只能给出${labelOf('verdict', 'unknown')}（缺输入）`, declared.length > 0 ? `改成 slots.schema.json 声明的闭集之一：${declared.join('、')}` : '在 slots.schema.json 里声明这个闭集（<要求项>.codes 或 <要求项>.ranks），或者在表里直接列出成员', { field: named.pointer }),
          );
        }
      }
      const tier = effectiveTier(check, table);
      if (tier === 'blocking' && !hasBasis(check, table)) {
        c.add(problem('checks.blocking_without_basis', 'checks.json', `检查 ${check.id} 是${tierText('blocking')}，却没有写明所依据的验收合同条款`, `在 checks.json（或解释器的表）里写 basis，或者改成${tierText('advisory')}（C05 R[1]）`, at('tier')));
      }
      if (check.reads?.narrow !== undefined) {
        const narrow = check.reads.narrow;
        const slot = workflow?.inputs.find(input => input.slot === narrow.slot);
        if (check.applies !== 'item' || !slot || !slot.accepts.includes('knowledge:index') ||
          !check.reads.roles.includes(slot.role) || (check.reads.types !== undefined && !check.reads.types.includes('knowledge:index'))) {
          c.add(problem('checks.narrow_binding', 'checks.json', `检查 ${check.id} 的收窄读取必须是条目检查，且 reads.narrow.slot 必须声明接受 knowledge:index 的输入，读取角色和类型须覆盖该输入`, '改为条目检查，并声明同一索引输入槽位、读取角色和 knowledge:index 类型', at('reads/narrow')));
        }
      }
      if (check.reads?.max_bytes !== undefined && check.reads.max_bytes > MAX_CHECK_READ_BYTES) {
        c.add(
          problem(
            'checks.max_bytes_exceeded',
            'checks.json',
            `检查 ${check.id} 的 reads.max_bytes 为 ${check.reads.max_bytes} 字节，超过了核心上限 ${MAX_CHECK_READ_BYTES} 字节（1 MiB）`,
            `把 reads.max_bytes 改为不超过 ${MAX_CHECK_READ_BYTES} 字节，或者不写（默认 1 MiB）`,
            at('reads/max_bytes'),
          ),
        );
      }
      if (tier === 'blocking' && check.judges === 'artifact_under_verification') blockingOnArtifact.add(check.id);
    }
  }

  // Requirements: listed checks exist; error handling and expected outcomes name known codes.
  if (requirements) {
    const ids = new Set((checks?.checks ?? []).map((x) => x.id));
    const interpreterOf = new Map((checks?.checks ?? []).map((x) => [x.id, x.interpreter?.split('@')[0]]));
    const used = new Set<string>();
    for (const [i, r] of requirements.requirements.entries()) {
      if(r.accepted_producer==='fact'&&r.layers.includes('static')&&r.checks.length===0)c.add(problem('requirements.no_check','requirements.json',`要求项 ${r.key} 声明静态事实却没有检查`,'给它安装检查后重新发布',{field:`/requirements/${i}/checks`}));
      if(r.accepted_producer==='fact'&&r.layers.includes('dynamic')&&!r.observation)c.add(problem('requirements.no_observation','requirements.json',`要求项 ${r.key} 声明动态事实却没有观察合同`,'声明 observation 后重新发布',{field:`/requirements/${i}/observation`}));
      const seen = new Set<string>();
      r.checks.forEach((id, j) => {
        const field = `/requirements/${i}/checks/${j}`;
        if (seen.has(id)) c.add(problem('requirements.duplicate_check', 'requirements.json', `要求项 ${r.key} 两次列出检查 ${id}`, '删掉重复的一项', { field }));
        seen.add(id);
        used.add(id);
        if (checks && !ids.has(id)) c.add(problem('requirements.unknown_check', 'requirements.json', `要求项 ${r.key} 列出的检查 ${id} 在 checks.json 里没有`, `在 checks.json 里声明检查 ${id}，或者从这个要求项的 checks 里删掉它`, { field }));
      });
      const interpreters = new Set(r.checks.map((id) => interpreterOf.get(id)).filter((x): x is string => x !== undefined));
      r.error_handling.forEach((row, k) => {
        const field = `/requirements/${i}/error_handling/${k}/${row.reason!==undefined?'reason':'code'}`;
        const selector=row.reason!==undefined?'原因 '+labelOf('reason',row.reason):row.code;
        if(row.reason!==undefined && row.action==='reject'){
          c.add(problem('requirements.reject_scope','requirements.json','原因行不能处理为进已拒收；进已拒收只用于待判定产物上的阻断检查码','按原因声明修复或其他允许动作，按检查码声明已拒收',{field:'/requirements/'+i+'/error_handling/'+k+'/action'}));
          return;
        }
        if (row.action === 'reject' && !r.checks.some((id) => blockingOnArtifact.has(id))) {
          const artifact = labelOf('source_role', 'artifact_under_verification');
          const others = ERROR_HANDLING.filter((a) => a !== 'reject').map((a) => labelOf('error_handling', a));
          c.warn(
            problem(
              'requirements.reject_scope',
              'requirements.json',
              `要求项 ${r.key} 把 ${selector} 处理为${labelOf('error_handling', row.action)}，但它没有判定${artifact}的${tierText('blocking')}检查；${labelOf('error_handling', 'reject')}只用于${artifact}上的${tierText('blocking')}检查码（W02 F[7]）`,
              `改成${others.join('、')}之一，或者让这个要求项带一个判定${artifact}的${tierText('blocking')}检查`,
              { field: `/requirements/${i}/error_handling/${k}/action` },
            ),
          );
        }
        // Cause selectors were checked by the generated ReasonSchema, not an installed interpreter.
        if(row.code===undefined)return;
        if (!isKnownCode(row.code, manifest.id)) {
          c.add(problem('requirements.unknown_code', 'requirements.json', `要求项 ${r.key} 的错误处理行用了未知的码 ${row.code}`, `用 *、核心违规码、协议码，或者包自己的码（${manifest.id}.<码>）`, { field }));
        } else if (Object.hasOwn(CORE_VIOLATION_CODES, row.code)) {
          const emitter=CORE_VIOLATION_CODES[row.code as keyof typeof CORE_VIOLATION_CODES].interpreter;
          const contribution=emitter==='contribution';
          const applicable=contribution?workflow?.contribution?.requirement===r.key:interpreters.has(emitter);
          if(!applicable){
            const reason=contribution
              ?workflow?.contribution===undefined?'工作流没有声明回注准入':'回注准入绑定的是要求项 '+workflow.contribution.requirement
              :'它的检查里没有 '+emitter+' 解释器';
            const fix=contribution?'删掉这一行，或者将回注准入绑定到对应要求项':'删掉这一行，或者给要求项加上对应的检查';
            c.warn(problem('requirements.code_unused', 'requirements.json', '要求项 '+r.key+' 的错误处理行处理 '+row.code+'，但'+reason+'，这一行用不上',fix,{field}));
          }
        }
      });
      (r.expected?.overrides ?? []).forEach((o, k) => {
        o.codes.forEach((code, m) => {
          if (!isKnownCode(code, manifest.id) || code === '*') {
            c.add(problem('requirements.unknown_code', 'requirements.json', `要求项 ${r.key} 的期望结局用了未知的码 ${code}`, `用核心违规码、协议码，或者包自己的码（${manifest.id}.<码>）`, { field: `/requirements/${i}/expected/overrides/${k}/codes/${m}` }));
          }
        });
      });
    }
    for (const [k, check] of (checks?.checks ?? []).entries()) {
      if (!used.has(check.id)) c.warn(problem('checks.unused', 'checks.json', `检查 ${check.id} 没有被任何要求项列出，运行时不会用到`, '在要求项的 checks 里列出它，或者删掉它', { field: `/checks/${k}/id` }));
    }
  }

  // Slots and requirements (W05): judgments have an entry under their target, facts have none, and nothing else does.
  if (requirements && slots) {
    const byKey = new Map(requirements.requirements.map((r, i) => [r.key, { r, i }]));
    for (const { r, i } of byKey.values()) {
      const inItem = Object.hasOwn(slots.item, r.key);
      const inRun = Object.hasOwn(slots.run, r.key);
      const own = r.target === 'item' ? inItem : inRun;
      const other = r.target === 'item' ? inRun : inItem;
      if (!judgmentRequirement(r)) {
        if (inItem || inRun) {
          c.add(problem('slots.fact_entry', 'slots.schema.json', `要求项 ${r.key} 是${labelOf('accepted_producer', 'fact')}，由检查判定，模型不填它的槽位；slots.schema.json 却给它留了槽位`, `从 slots.schema.json 的 ${inItem ? 'item' : 'run'} 里删掉 ${r.key}`, { field: `/${inItem ? 'item' : 'run'}/${r.key}` }));
        }
        continue;
      }
      if (own) continue;
      if (other) {
        c.add(problem('slots.wrong_target', 'slots.schema.json', `要求项 ${r.key} 的对象是${r.target === 'item' ? '每个条目' : '整个运行'}，槽位却写在 ${r.target === 'item' ? 'run' : 'item'} 下`, `把 ${r.key} 移到 slots.schema.json 的 ${r.target} 下`, { field: `/${r.target === 'item' ? 'run' : 'item'}/${r.key}` }));
      } else if (r.independent_of !== undefined) {
        c.add(problem('slots.independent_entry', 'slots.schema.json', `要求项 ${r.key} 是${labelOf('accepted_producer', r.accepted_producer)}（independent_of ${r.independent_of}），slots.schema.json 却没有它的槽位，独立的判断者无处可填`, `在 slots.schema.json 的 ${r.target} 下声明 ${r.key}`, { field: `/${r.target}/${r.key}` }));
      } else {
        c.add(problem('slots.missing_entry', 'slots.schema.json', `要求项 ${r.key} 是${labelOf('accepted_producer', r.accepted_producer)}，slots.schema.json 却没有它的槽位，模型无处可填（requirements.json /requirements/${i}）`, `在 slots.schema.json 的 ${r.target} 下声明 ${r.key}`, { field: `/${r.target}/${r.key}` }));
      }
    }
    for (const scope of TARGET) {
      for (const key of Object.keys(slots[scope])) {
        if (!byKey.has(key)) c.add(problem('slots.unknown_requirement', 'slots.schema.json', `slots.schema.json 的 ${scope} 下有 ${key}，但 requirements.json 没有这个要求项`, `删掉它，或者在 requirements.json 里声明要求项 ${key}`, { field: `/${scope}/${key}` }));
      }
    }
    // A cross-item claim is assigned to its run-level requirement by its code: those codes are used by nothing else.
    const itemCodes = new Map<string, string>();
    for (const [key, declaration] of Object.entries(slots.item)) for (const code of declaration.codes ?? []) if (!itemCodes.has(code.code)) itemCodes.set(code.code, key);
    const runCodes = new Map<string, string>();
    for (const [key, declaration] of Object.entries(slots.run)) {
      (declaration.codes ?? []).forEach((code, n) => {
        const field = `/run/${key}/codes/${n}/code`;
        const runOwner = runCodes.get(code.code);
        if (runOwner !== undefined && runOwner !== key) c.add(problem('slots.code_overlap', 'slots.schema.json', `码 ${code.code} 同时标识整体要求项 ${runOwner} 和 ${key}`, '每个整体要求项用自己的码', { field }));
        runCodes.set(code.code, key);
        const itemOwner = itemCodes.get(code.code);
        if (itemOwner !== undefined) c.add(problem('slots.code_overlap', 'slots.schema.json', `码 ${code.code} 标识整体要求项 ${key}，又是条目要求项 ${itemOwner} 的码；跨条目主张靠码认出它属于哪个要求项`, `给 ${key} 换一个只属于它的码`, { field }));
      });
    }
  }

  // Samples exercise declared checks, and bind a catalog exactly where a run binds one.
  const checkById = new Map((checks?.checks ?? []).map((x) => [x.id, x]));
  if (checks) {
    for (const s of samples) {
      const check = checkById.get(s.sample.check);
      if (check === undefined) c.add(problem('samples.unknown_check', s.file, `样例 ${s.sample.id} 要验的检查 ${s.sample.check} 在 checks.json 里没有`, '改成 checks.json 里的检查号，或者删掉这个样例', { field: '/check' }));
      else if (s.sample.catalog !== undefined && check.catalog === undefined) {
        c.add(problem('samples.catalog_unused', s.file, `样例 ${s.sample.id} 带了目录，但检查 ${check.id} 不查目录（checks.json 没有给它写 catalog）；运行时不会绑定目录，样例要和运行一样判定`, `删掉样例的 catalog，或者给检查 ${check.id} 写 catalog`, { field: '/catalog' }));
      }
    }
  }

  if(requirements && checks)for(const [index,row] of (requirements.effects??[]).entries()) {
    const names=new Set([...row.policy_checks,...('policy' in row.parameters?[row.parameters.check]:[])]);
    for(const id of names) {
      const check=checks.checks.find(check=>check.id===id);
      if(!check || !check.table?.startsWith('policies/')) {
        c.add(problem('effects.policy_binding','requirements.json',`效果 ${row.id} 的政策检查 ${id} 没有绑定 policies/ 下的表`,'在 checks.json 点名同一脚本和政策表，并提供正反例',{field:`/effects/${index}`}));continue;
      }
      if('policy' in row.parameters && id===row.parameters.check && check.table!==row.parameters.policy)c.add(problem('effects.policy_binding','requirements.json',`效果 ${row.id} 的参数政策表与检查 ${id} 用表不一致`,'指向编译时同一个检查与同一张表',{field:`/effects/${index}/parameters`}));
      if(!samples.some(sample=>sample.sample.check===id && sample.polarity==='positive') || !samples.some(sample=>sample.sample.check===id && sample.polarity==='negative'))c.add(problem('effects.policy_samples','requirements.json',`效果 ${row.id} 的政策检查 ${id} 缺正例或反例`,'为该检查提供正反例并在发布时运行',{field:`/effects/${index}/policy_checks`}));
    }
  }

  // V07: the frozen repetition policy of every requirement, and the rounds its effect rows authorize. A count above the
  // row's declared repetition refuses publication with a deterministic diagnosis (integrator decision 5, 2026-10-24);
  // budget.count stays a pure bound on writes and never authorizes rounds.
  if (requirements && workflow) {
    const effects = requirements.effects ?? [];
    for (const [index, template] of requirements.requirements.entries()) {
      let count: number;
      try {
        count = repetitionSummary({ workClass: workflow.work_class, layers: template.layers, declared: template.repetition, dispatchCount: dispatchCountOf(effects, template.key) }).count;
      } catch (error) {
        c.add(problem('requirements.repetition', 'requirements.json', `要求项 ${template.key} 的重复策略不成立：${(error as Error).message}`, '按 V07 改正次数、聚合方式或 k（次数 1 到 10，k 只用于 k-of-n 且不大于次数）；只有声明动态层的要求项能写重复策略', { field: `/requirements/${index}/repetition` }));
        continue;
      }
      if (count <= 1) continue;
      const rows = effects.filter((effect) => effect.release.requirements.includes(template.key));
      if (rows.length === 0) {
        c.add(problem('effects.repetition_budget', 'requirements.json', `要求项 ${template.key} 冻结为 ${count} 轮，但没有任何效果行发布它`, '在 requirements.json 的 effects 里为它写一行并声明 repetition，或把次数降到 1', { field: `/requirements/${index}/repetition/count` }));
        continue;
      }
      rows.forEach((row) => {
        if (row.repetition === undefined || row.repetition < count) {
          c.add(problem('effects.repetition_budget', 'requirements.json', `效果 ${row.id} 授权的轮数（${row.repetition === undefined ? '未声明' : row.repetition}）少于要求项 ${template.key} 冻结的 ${count} 轮`, '把该效果行的 repetition 提到不少于次数，或把要求项的次数调低', { field: `/effects/${effects.indexOf(row)}/repetition` }));
        }
      });
    }
  }

  // Functions: every reference names a module inside functions/ whose imports the sandbox admits, with that export.
  const entries: FunctionEntry[] = [];
  if (workflow) {
    entries.push(functionEntry(workflow.projection, 'workflow.json', '/projection'));
    if (workflow.expected_sources) entries.push(functionEntry(workflow.expected_sources, 'workflow.json', '/expected_sources'));
  }
  for (const [k, check] of (checks?.checks ?? []).entries()) {
    if (check.function) entries.push(functionEntry(check.function, 'checks.json', `/checks/${k}/function`));
    if (check.subject) entries.push(functionEntry(check.subject, 'checks.json', `/checks/${k}/subject`));
    if (check.catalog_select) entries.push(functionEntry(check.catalog_select, 'checks.json', `/checks/${k}/catalog_select`));
  }
  for (const p of await scanFunctions(c.files, entries, policy)) c.add(p);

  if (!workflow || !requirements || !checks || !slots || (knowledgePresent && !knowledge) || instructions === null || instructions.trim() === '') return null;
  const declarations: WorkflowDeclarations = {
    kind: 'workflow',
    workflow,
    requirements,
    checks,
    slots,
    knowledge,
    ...(ledger ? {ledger} : {}),
    instructions,
    instructionsDigest: sha256Hex(c.files.get(SKILL) as Uint8Array),
  };
  return { declarations, samples };
}

// ---------------------------------------------------------------- product and system packs

async function validateProduct(c: Collector, policy: ImportPolicy): Promise<PackDeclarations | null> {
  const product = c.parse('product.shape', 'product.json', ProductDeclaration, 'product@1', 'contracts/src/product.ts');
  if (!product) return null;
  for (const [i, variable] of (product.variables ?? []).entries()) {
    const compiled = packSchema(variable.schema);
    if (!compiled.ok || !compiled.schema.safeParse(variable.default).success) c.add(problem('variables.schema', 'product.json', `变量 ${variable.name} 的模式不能执行或默认值不合模式`, '按 Hub 支持的 JSON Schema 2020-12 写模式并提供合成默认值', {field:`/variables/${i}`}));
  }
  product.names.forEach((name, i) => {
    if (name.trim() !== name) c.add(problem('product.name_space', 'product.json', `产品名 ${JSON.stringify(name)} 首尾有空白，调用方写的名字对不上`, '去掉首尾空白', { field: `/names/${i}` }));
  });
  const entries: FunctionEntry[] = [];
  if (product.sync) entries.push(functionEntry(product.sync.plan, 'product.json', '/sync/plan'));
  if (product.select_build) entries.push(functionEntry(product.select_build, 'product.json', '/select_build'));
  if(product.feeding)for(const [key,fn]of Object.entries(product.feeding))if(fn)entries.push(functionEntry(fn,'product.json','/feeding/'+key));
  product.producers.forEach((p, i) => entries.push(functionEntry(p.function, 'product.json', `/producers/${i}/function`)));
  for (const p of await scanFunctions(c.files, entries, policy)) c.add(p);
  return { kind: 'product', product };
}

async function validateSystem(c: Collector, policy: ImportPolicy): Promise<PackDeclarations | null> {
  const system = c.parse('system.shape', 'system.json', SystemProfile, 'system@1', 'contracts/src/resources.ts');
  if (!system) return null;
  const entries: FunctionEntry[] = [];
  system.reads.forEach((read, i) => {
    if (read.plan) entries.push(functionEntry(read.plan, 'system.json', `/reads/${i}/plan`));
    if (read.project) entries.push(functionEntry(read.project, 'system.json', `/reads/${i}/project`));
  });
  for (const p of await scanFunctions(c.files, entries, policy)) c.add(p);
  return { kind: 'system', system };
}

/**
 * Validates a pack read by readPackDirectory: the declaration files of its kind with their contract shapes, then the rules
 * across files. The pack is publishable only when `ok`; warnings never stop it.
 */
export async function validatePack(directory: PackDirectory, options: ValidateOptions = {}): Promise<PackValidation> {
  const policy = options.policy ?? SANDBOX_IMPORT_POLICY;
  const c = new Collector(new Map(directory.files.map((f) => [f.path, f.bytes])));
  const { manifest } = directory;
  for (const p of await scanTools(c.files)) c.add(p);
  for (const p of versionProblems(manifest)) c.add(p);
  for (const p of credentialProblems(directory)) c.add(p);
  for (const file of directory.files) {
    if (manifest.kind === 'product' && file.path === 'product.json') continue;
    const text = utf8(file.bytes);
    if (text && /\$\{(?:var|secret):/i.test(text)) c.add(problem('variables.reference',file.path,'这里不能引用变量或密钥','只在产品包 product.json 的 sync.options 或生产器 params 里引用已声明的普通变量'));
  }
  for (const [i, file] of manifest.files.entries()) {
    const owner = DECLARATION_KIND.get(file.path);
    if (owner !== undefined && owner !== manifest.kind && !(manifest.kind === 'skill' && owner === 'workflow')) {
      c.add(
        problem('manifest.foreign_file', 'pack.json', `${file.path} 是${labelOf('pack_kind', owner)}的声明文件，这个包是${labelOf('pack_kind', manifest.kind)}，它不会被读到`, `删掉 ${file.path}，或者改正 pack.json 的 kind`, {
          field: pointerOf(['files', i, 'path']),
        }),
      );
    }
  }
  if (manifest.kind !== 'workflow' && manifest.kind !== 'skill') {
    for (const file of manifest.files) {
      if (file.path.startsWith('samples/')) c.add(problem('samples.unknown_check', file.path, `${file.path} 是样例，但只有${labelOf('pack_kind', 'workflow')}有检查和样例`, '删掉这个样例'));
    }
  }
  let declarations: PackDeclarations | null;
  let samples: LoadedSample[] = [];
  if (manifest.kind === 'workflow') {
    const workflow = await validateWorkflow(c, directory, policy);
    declarations = workflow?.declarations ?? null;
    samples = workflow?.samples ?? [];
  } else if (manifest.kind === 'skill') {
    const instructions=c.files.get('SKILL.md');
    if(instructions!==undefined&&(utf8(instructions)===null||utf8(instructions)!.trim()===''))c.add(problem('skill.empty','SKILL.md','技能包规程必须是非空 UTF-8 文本','写明能力与边界'));
    const skill = c.parse('skill.shape', 'skill.json', SkillDeclaration, 'skill@1', 'contracts/src/pack.ts');
    let method: WorkflowDeclarations | null = null;
    if (c.files.has('workflow.json')) {
      const result = await validateWorkflow(c, directory, policy);
      method = result?.declarations ?? null;
      samples = result?.samples ?? [];
    }
    if (skill) {
      const functions=skill.parsers.flatMap((row,i)=>[functionEntry(row.function,'skill.json',`/parsers/${i}/function`),...(row.locate?[functionEntry(row.locate,'skill.json',`/parsers/${i}/locate`)]:[] )]);
      for (const p of await scanFunctions(c.files, functions, policy)) c.add(p);
      declarations = { kind: 'skill', skill, method };
    } else declarations = null;
  } else if (manifest.kind === 'product') declarations = await validateProduct(c, policy);
  else declarations = await validateSystem(c, policy);
  if (c.problems.length > 0 || declarations === null) {
    if (c.problems.length === 0) c.add(problem('manifest.kind', 'pack.json', `种类 ${manifest.kind} 的声明文件读不出来`, '补全这个种类要求的文件'));
    return { ok: false, problems: c.problems, warnings: c.warnings };
  }
  return { ok: true, pack: { directory, declarations, samples, warnings: c.warnings } };
}
