import {blockReviewIdentity} from './block-review-identity.ts';
import {assertionTarget,assertionCells,runtimeBlocks} from './block-runtime.ts';
import {blockMeta,identifier,sourcePlan} from './blocks.ts';
import {selectedExpectedNodes} from './expected-nodes.ts';
// Independent semantic interpretation of xlsx@1. Only the final identity check calls the client generator.
import { createHash } from 'node:crypto';
import FORMAT from '../tables/workbook-format.json' with { type: 'json' };
import { readWorkbookModel, type WorkbookRow } from './xlsx-model.ts';
import { decodeG } from './g-syntax.ts';
import { canonicalJson } from './canonical-json.ts';
import { readSlots, type PlanSlots } from './slots.ts';
import { parseRuntimeContract, runtimeMethod } from './runtime-contract.ts';
import { parseManifest } from './manifest.ts';
import { parseProfile, allowedCall } from './profile.ts';
import { bindArguments } from './binding.ts';
import { checkContractShape, checkAddresses, checkExpectedSources } from './checks.ts';
import { generateWorkbookSet, caseRecipe, recipeDigest, type GenerationInput, type GenerationFields } from './generate.ts';
import { isRecord, markers, type Outcome } from './text.ts';
export interface WorkbookProblem { rule: string; pointer: string; message: string }
export interface ReadExecution { row: number; object: string; method: string; args: string[]; keywords: Record<string, string | number>; assertion: boolean;h?:string;i?:string }
export type WorkbookRead = { ok: true; executions: ReadExecution[]; autoids: string[] } | { ok: false; problems: WorkbookProblem[] };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
/** Does not call the generator or use generated rows to interpret the uploaded model. Several recipes are the cases of one
 * run in workbook order (decision 104); one recipe is the single-case layout. */
export function readWorkbook(input: unknown, recipes: GenerationInput | GenerationInput[]): WorkbookRead {
  const problems: WorkbookProblem[] = []; const issue = (rule: string, pointer: string, message: string) => problems.push({ rule, pointer, message });
  const model = readWorkbookModel(input); if (!model) return { ok: false, problems: [{ rule: 'model', pointer: '', message: '不是完整的 xlsx@1 模型' }] };
  const set = Array.isArray(recipes) ? recipes : [recipes]; if (!set.length) return { ok: false, problems: [{ rule: 'slots', pointer: '/slots', message: '没有可回读的用例计划' }] };
  const plans: PlanSlots[] = [];
  for (const recipe of set) { const slots = readSlots(recipe.slots); if (!slots.ok) return { ok: false, problems: [{ rule: 'slots', pointer: '/slots', message: '当前计划槽位不合式' }] }; plans.push(slots.slots); }
  if (new Set(plans.map((plan) => !!blockMeta(plan))).size !== 1) return { ok: false, problems: [{ rule: 'slots', pointer: '/slots', message: '同一份工作簿里块计划与普通计划不能混用' }] };
  const recipe = set[0]; const plan = plans[0]; const profile = recipe.profile; const book = profile.workbook;
  if (JSON.stringify(model.members.map((v) => v.name).sort()) !== JSON.stringify([...FORMAT.members].sort()) || new Set(model.members.map((v) => v.name)).size !== FORMAT.members.length) issue('members', '/members', '成员必须恰好是同版生成器的六个部件');
  if(model.nulRemoved>0)issue('subset','/nulRemoved','解析移除了 NUL，不属于生成器原字节子集');
  const relation='http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const expected=[{source:'',id:'rId1',type:relation+'officeDocument',target:'xl/workbook.xml',external:false},{source:'xl/workbook.xml',id:'rId1',type:relation+'worksheet',target:'worksheets/sheet1.xml',external:false},{source:'xl/workbook.xml',id:'rId2',type:relation+'styles',target:'styles.xml',external:false}];
  if(model.relationships.length!==expected.length||expected.some(e=>!model.relationships.some(r=>Object.entries(e).every(([k,v])=>r[k as keyof typeof r]===v))))issue('subset','/relationships','六个部件的关系类型、来源、目标或身份不属于生成子集');
  if (model.sharedStrings.length || model.relationships.some((v) => v.external || v.type.endsWith('/sharedStrings'))) issue('subset', '/relationships', '不接受共享字符串或外部关系');
  if (model.sheets.length !== 1) issue('sheets', '/sheets', '只接受一张工作表');
  const sheet = model.sheets[0]; if (!sheet) return { ok: false, problems };
  if (sheet.relationshipType!==relation+'worksheet' || sheet.name !== book.sheet || sheet.part !== FORMAT.worksheet_part || sheet.state !== 'visible') issue('sheets', '/sheets/0', '表名、部件或可见性不符合生成子集');
  const rows = new Map<number, WorkbookRow>(); const values = new Map<number, string[]>(); let previous = 0;
  for (const [r, row] of sheet.rows.entries()) {
    if (row.number <= previous || row.number > FORMAT.max_rows || row.hidden) issue('subset', `/sheets/0/rows/${r}`, '行号重复、乱序、过大或有隐藏行'); previous = row.number; rows.set(row.number, row);
    const grid = Array<string>(9).fill(''); const columns = new Set<number>();
    for (const [c, cell] of row.cells.entries()) {
      const at = `/sheets/0/rows/${r}/cells/${c}`; const match = /^([A-I])([1-9][0-9]*)$/.exec(cell.reference);
      if (!match || Number(match[2]) !== row.number) { issue('subset', at, '单元格超出 A–I 或与行号不符'); continue; }
      const column = match[1].charCodeAt(0) - 65;
      if (columns.has(column)) issue('subset', at, '单元格坐标重复'); columns.add(column); grid[column] = cell.text;
      if (cell.formula || cell.text.startsWith('=')) issue('formula', at, '不接受公式或以等号开头的值');
      if (!FORMAT.cell_types.includes(cell.type) || cell.type === 'n' && !(column === 2 && row.number > 2) || cell.style !== (column === 0 ? 1 : null)) issue('subset', at, '只接受内联字符串及 C 列数字，样式须符合同版子集');
      if (cell.text.length > FORMAT.max_cell_chars) issue('subset', at, '单元格超出文字上限');
      if (row.number > 2 && column === 2 && (cell.type !== 'n' || !/^[0-9]+$/.test(cell.text) || Number(cell.text) === 1)) issue('initialization', at, 'C 列必须是非初始化的数字类型');
    }
    values.set(row.number, grid);
  }
  const grid = (number: number) => values.get(number) ?? Array<string>(9).fill('');
  const headers = [...values].filter(([, cells]) => JSON.stringify(cells) === JSON.stringify(book.header));
  if (headers.length !== 1 || headers[0][0] !== 2) issue('header', '/sheets/0', '必须恰好一个九列表头，且位于生成器固定的第 2 行');
  const identities = [...values].filter(([, cells]) => cells[0] === book.identity_marker);
  if (identities.length !== 1 || identities[0][0] !== 1) issue('identity', '/sheets/0', '必须恰好一行身份标记，位于表头上方');
  const identity = grid(1);
  if (identity[1] !== recipe.contract.runtimeVersion || identity[2] !== recipe.contract.pinned.identity || identity[3] || identity[4]) issue('identity', '/sheets/0/rows/0', '运行时/合约身份不符，或认证请求 D/E 格不为空');
  if (identity[FORMAT.identity_generator_column - 1] !== FORMAT.generator) issue('generator', '/sheets/0/rows/0', '工作簿生成器版本与本运行锁定包的生成器版本不符');
  if (identity[FORMAT.identity_recipe_column - 1] !== recipeDigest(set.map((value, k) => caseRecipe({ ...value, generator: FORMAT.generator }, plans[k])))) issue('recipe', '/sheets/0/rows/0', '工作簿没有绑定当前完整槽位、来源字段及配置');
  const reference = `'${book.sheet.replaceAll("'", "''")}'!$A$2:$I$2`;
  if (model.definedNames.length !== 1 || model.definedNames[0].name !== book.range_name || model.definedNames[0].scope !== null || model.definedNames[0].reference !== reference) issue('range', '/definedNames', '范围名必须是工作簿级，唯一且正好指向九列表头');
  const expectedLast = 4 + plans.reduce((sum, value) => sum + value.steps.length + value.expects.length + 1, 0);
  if (sheet.lastRow !== expectedLast || rows.size !== expectedLast || [...rows.keys()].some((number, i) => number !== i + 1)) issue('closing', '/sheets/0', '收尾行必须是最后一个有单元格的行，不能夹行、漏行或追加样式行');
  if (JSON.stringify(grid(expectedLast)) !== JSON.stringify(book.closing_row)) issue('closing', '/sheets/0', '收尾行与配置不符');
  if (grid(expectedLast - 1).some(Boolean) || grid(3)[2] !== '0' || grid(3)[3] !== `计划运行 ${recipe.plan_run}；构建 ${recipe.build}` || grid(3).some((v, i) => i !== 2 && i !== 3 && v !== '')) issue('description', '/sheets/0', '说明或空行不符合冻结的 plan_run/构建，说明行 E–I 必须为空');
  const defaultAssertion=assertionTarget(recipe.contract,profile);
  if (!defaultAssertion) issue('assertion', '/profile/allowed', '缺少唯一的允许字面断言组合');
  // Scan every post-header E–I row, including description, blank and closing rows. Registers live within one case, as in
  // InfoTest's runner (lib/test_xlsx.py): its static preflight of a workbook resets them, at every row that starts a case
  // (an autoid in A on a row whose C is not the init type 1), to the registers its init rows captured, and the run clears
  // them before each case's init ("寄存器和当前结果仅在单个 case 内有效"). This generator writes no init rows, so every case
  // starts without registers; inside a case a name is still captured once.
  const initRegisters=new Set<string>(),caps=runtimeBlocks(recipe.contract); let registers=new Set<string>();
  const executions: ReadExecution[] = []; const executionByRow = new Map<number, ReadExecution>();
  for (const [number, cells] of values) {
    if (number <= 2) continue;
    const init = cells[2] === '1';
    if (cells[0] !== '' && !init) registers = new Set(initRegisters);
    if (!cells.slice(4).some(Boolean)) continue;
    const at = `/sheets/0/rows/${number - 1}`; const [object, method, g, h, variable] = cells.slice(4);
    const entry = runtimeMethod(recipe.contract, object, method); const allowed = allowedCall(profile, object, method);
    if (!object || !method || !entry || !allowed || !blockMeta(plan)&&(!g||h||variable)) { issue('execution', at, 'E/F/G 必须是启用且角色配置完整的调用，H/I 必须为空'); continue; }
    const seat = profile.seats.find((v) => v.object === object); if (seat && seat.ordinal >= profile.device_count) issue('seat', at, '座位序号不小于预检设备数');
    const assertion = Object.values(allowed.parameters).some((role) => role === 'literal_assertion');
    const wait = Object.values(allowed.parameters).length > 0 && Object.values(allowed.parameters).every((role) => role === 'wait');
    if (!assertion && !variable && (/[\r\n\v\f\u0085\u2028\u2029]/.test(g) || g.trim() !== g || /\{(?:0)?\}/.test(g))) issue('execution', at, '普通调用 G 必须是单行最终文字，没有占位符或首尾空白');
    try {
      const decoded = decodeG(g, { literalAssertion: assertion, wait, foldNewlines: profile.fold_newlines.some((v) => v.object === object && v.method === method) });
      if (!assertion) for (const problem of bindArguments(entry, { object, method, ...decoded,...(variable?{input_register:variable,restore_for:0}:{}) }, at).problems) issue('signature', problem.pointer, problem.message);
      if(blockMeta(plan)){
        if(assertion){
          if(h&&!registers.has(h))issue('register',at,'检查点期望寄存器未先捕获');
          const countMethod=Array.isArray(caps?.operators)&&caps.operators.some((row:any)=>row.op==='found_times'&&row.object===object&&row.method===method);
          if(countMethod){if(h||!recipe.contract||!variable||!Array.from(variable).every(char=>char>='0'&&char<='9')||!Number.isSafeInteger(Number(variable))||Number(variable)<1)issue('register',at,'次数检查点需要 H 空及 I 正整数');}
          else if(variable&&!registers.has(variable))issue('register',at,'检查点实际原文寄存器未先捕获');
          if(!g&&!h)issue('assertion',at,'检查点缺字面或期望寄存器');
        }else{
          if(!g)issue('execution',at,'普通调用 G 不能为空');
          if(variable&&(!registers.has(variable)||!Array.isArray(caps?.restore_methods)||!caps.restore_methods.some((row:any)=>row.object===object&&row.method===method)||decoded.args.length!==1||decoded.args[0]!=='{}'))issue('register',at,'普通 I 仅用于已捕获原文的声明还原守卫');
          if(h){if(!identifier(h)||registers.has(h)||!Array.isArray(caps?.output_methods)||!caps.output_methods.some((row:any)=>row.object===object&&row.method===method&&row.output==='raw_text'))issue('register',at,'H 捕获必须在本用例内命名唯一并由声明的原文观察产生');else{registers.add(h);if(init)initRegisters.add(h);}}
        }
      }
      const execution = { row: number, object, method, ...decoded, assertion,...(blockMeta(plan)?{h,i:variable}:{}) }; executions.push(execution); executionByRow.set(number, execution);
    } catch (error) { issue('G', at, error instanceof Error ? error.message : 'G 无法按运行器规则读取'); }
  }
  const cases = [...values].filter(([number, cells]) => number > 2 && number < expectedLast && cells[0] !== '');
  const starts: number[] = []; { let at = 4; for (const value of plans) { starts.push(at); at += value.steps.length + value.expects.length + 1; } }
  if (cases.length !== set.length || cases.some(([number, cells], k) => number !== starts[k] || cells[0] !== set[k].fields.autoid || !new RegExp(book.autoid_pattern, 'u').test(cells[0]) || !cells[4]) || new Set(set.map((value) => value.fields.autoid)).size !== set.length) issue('autoid', '/sheets/0', set.length === 1 ? '必须只有一个文本 autoid，等于条目且符合形状，首行 E 不能为空' : '每个用例的首行必须依序是它的文本 autoid，符合形状且互不重复，首行 E 不能为空，用例之间不能夹别的 autoid');
  let row = 4;
  for (const [k, recipe] of set.entries()) { const plan = plans[k];
  for (const [i, step] of plan.steps.entries()) {
    const actual = executionByRow.get(row); const cells = grid(row);
    if (!actual || actual.assertion || actual.object !== step.object || actual.method !== step.method || canonicalJson(actual.args) !== canonicalJson(step.args) || canonicalJson(actual.keywords) !== canonicalJson(step.keywords) || cells[2] !== String(FORMAT.statement_type) || cells[1] !== (recipe.fields.priority ?? '') || cells[3] !== (recipe.fields.title)||blockMeta(plan)&&(cells[7]!== (step.save_as??'')||cells[8]!== (step.input_register??''))) issue('step', `/sheets/0/rows/${row - 1}`, '执行行逐个回读后与槽位或原文字段不一致');
    row++;
    const allowed = allowedCall(profile, step.object, step.method);
    for (const expect of plan.expects.filter((v) => v.after === i + 1)) {
      const actual = executionByRow.get(row); const cells = grid(row);
      const target=assertionTarget(recipe.contract,profile,expect),expected=target?assertionCells(expect,target):null;
      if (!actual?.assertion || !target||!expected||actual.object!==target.call.object||actual.method!==target.call.method||actual.args.length!==1||cells[6]!==expected.g||Object.keys(actual.keywords).length||cells[3]!==expect.text||cells[2]!==String(FORMAT.statement_type)||!blockMeta(plan)&&!Object.values(allowed?.parameters??{}).some(role=>role==='device_cli'||role==='host_shell')||blockMeta(plan)&&(cells[7]!==expected.h||cells[8]!==expected.i))issue('assertion',`/sheets/0/rows/${row-1}`,'断言的算子、字面、输出寄存器或次数不等于冻结块计划');
      row++;
    }
  }
  if (!plan.expects.length || grid(row).some(Boolean)) issue('execution', `/sheets/0/rows/${row - 1}`, '每个用例之后必须恰好是一行空行，执行行或断言数与计划不一致');
  row++;
  }
  if (row !== expectedLast || executions.length !== plans.reduce((sum, value) => sum + value.steps.length + value.expects.length, 0)) issue('execution', '/sheets/0', '执行行或断言数与本运行用例计划不一致，可能漏行或多行');
  return problems.length ? { ok: false, problems } : { ok: true, executions, autoids: set.map((value) => value.fields.autoid) };
}
function generationFields(value: unknown): GenerationFields | null {
  if (!isRecord(value) || typeof value.autoid !== 'string' || typeof value.title !== 'string' || !Array.isArray(value.steps) || value.steps.some((v) => !isRecord(v) || typeof v.text !== 'string') || value.priority !== null && typeof value.priority !== 'string') return null;
  return { autoid: value.autoid, title: value.title, priority: value.priority, steps: value.steps as Array<{ text: string }> };
}
export default function check(input: unknown): Outcome[] {
  const s = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const item = typeof s.item === 'string' ? s.item : undefined;
  const unknown = (reason: NonNullable<Outcome['reason']>, statement: string): Outcome[] => [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (statement), reason, statement, grounds: [], tier: 'blocking', ...(item ? { item } : {}) }];
  if (!s.workbook) {
    const identity = parseRuntimeContract(s.contract);
    const basis = identity.ok && isRecord(s.profile) && typeof s.profile.synthetic === 'boolean' ? markers(s.profile.synthetic, identity.contract) : '（不证明在真实设备上跑得通）';
    return unknown('missing_input', '缺少客户端生成的工作簿。先将计划要求项修到满足，再自动运行本包脚本、上传并以计划为前驱开新运行绑定 workbook 和 plan_run' + basis);
  }
  const raw = isRecord(s.workbook) ? s.workbook : {}; const generation = isRecord(s.generation) ? s.generation : {};
  const contract = parseRuntimeContract(s.contract); const inventory = parseManifest(s.manifest); const slots = readSlots(s.data); const fields = generationFields(s.fields);
  const profile = contract.ok && inventory.ok ? parseProfile(s.profile, contract.contract, inventory.beds) : null;
  if (!contract.ok || !inventory.ok || !profile?.ok || !slots.ok || !fields || typeof generation.plan_run !== 'string' || typeof generation.build !== 'string' || generation.generator !== FORMAT.generator || typeof s.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(s.manifest_sha256)) return unknown('check_error', '缺少可重算的冻结输入、生成器版本或清单字节摘要；客户端须重新导出已满足计划及绑定原件，以匹配版本重开核验运行。不证明在真实设备上跑得通。');
  const qualifier = markers(profile.profile.synthetic, contract.contract); const pointer = '/workbook';
  const grounds = typeof raw.sha256 === 'string' && /^[a-f0-9]{64}$/.test(raw.sha256) ? [`src:${raw.sha256}`, `src:${s.manifest_sha256}`] : [];
  const fail = (message: string, at = pointer): Outcome[] => [{ verdict: 'refute', code: 'case-compile.workbook_invalid', statement: message + qualifier, grounds, tier: 'blocking', ...(item ? { item } : {}), pointer: at }];
  const checked = [checkContractShape, checkAddresses, checkExpectedSources].flatMap((fn) => fn({ subject: s }));
  if (checked.some(v => v.verdict === 'refute')) return fail('计划的调用、地址或期望尚未满足，不能核验工作簿；先修计划，再由同版客户端脚本重生成');
  const unverified = checked.find(v => v.verdict === 'unknown');
  if (unverified) return [{ ...unverified, statement: '工作簿未核对：' + unverified.statement, grounds, ...(item ? { item } : {}) }];
  fields.source_atoms=isRecord(s.fields)?s.fields.source_atoms:undefined;fields.bed_services=s.bed_services;fields.manifest_sha256=s.manifest_sha256 as string;fields.criteria_review=s.criteria_review;fields.expected_nodes=isRecord(s.fields)?s.fields.expected_nodes:undefined;fields.command_identities=isRecord(s.fields)?s.fields.command_identities:undefined;fields.command_catalog=isRecord(s.fields)?s.fields.command_catalog:undefined;
  const own: GenerationInput = { slots: slots.slots, fields, contract: contract.contract, profile: profile.profile, plan_run: generation.plan_run, build: generation.build };
  // Several cases (decision 104): the run froze, from the plan run's accepted result, every case's accepted plan and catalog
  // receipt; this item's resubmitted plan must be exactly its frozen one, and the workbook is regenerated from all of them.
  let recipes: GenerationInput[] = [own];
  if (s.plan_set !== undefined && s.plan_set !== null) {
    const frozen = Array.isArray(s.plan_set) ? s.plan_set : null;
    const mine = frozen?.filter((entry) => isRecord(entry) && entry.item === item) ?? [];
    if (!frozen || !frozen.length || mine.length !== 1 || !isRecord(mine[0]) || canonicalJson(mine[0].plan ?? null) !== canonicalJson(s.data ?? null)) return fail('本条重交的计划不等于计划运行受理的计划；整份工作簿只能由计划运行受理的全部计划生成，按原样重交或从新的计划运行重新生成', '/data');
    recipes = [];
    for (const entry of frozen) {
      const case_fields = isRecord(entry) ? generationFields(entry.fields) : null; const plan = isRecord(entry) ? readSlots(entry.plan) : null;
      if (!case_fields || !plan?.ok || !isRecord(entry)) return unknown('check_error', '冻结的用例计划集合不完整，无法重算整份工作簿；以计划运行号绑定 plan_result 重开核验运行。不证明在真实设备上跑得通。');
      const extra = isRecord(entry.fields) ? entry.fields : {};
      recipes.push({ slots: plan.slots, fields: { ...case_fields, source_atoms: extra.source_atoms, bed_services: s.bed_services, manifest_sha256: s.manifest_sha256 as string, criteria_review: s.criteria_review, expected_nodes: extra.expected_nodes, command_identities: entry.command_identities, command_catalog: entry.command_catalog }, contract: contract.contract, profile: profile.profile, plan_run: generation.plan_run, build: generation.build });
    }
  }
  try {
    const read = readWorkbook(raw.model, recipes); if (!read.ok) return read.problems.map((v) => fail(`${v.rule}：${v.message}；按修复行重生成并开后继运行`, `/workbook/model${v.pointer}`)[0]);
    const regenerated = generateWorkbookSet(recipes);
    if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256) || hash(regenerated) !== raw.sha256) return fail('bytes：绑定的工作簿原字节摘要与本运行同版生成器重算不同；不能仅凭单元格相同受理');
    return [{ verdict: 'support', statement: '工作簿经独立逐行回读并由本运行生成器重算，绑定原字节完全一致；plan_run 与 predecessor 的一致性由派发核验' + qualifier, grounds, tier: 'blocking', ...(item ? { item } : {}), data: { sha256: raw.sha256, autoids: read.autoids, bed: { id: profile.profile.bed, manifest_sha256: s.manifest_sha256 }, build: generation.build, generator: FORMAT.generator, plan_run: generation.plan_run } }];
  } catch (error) { return fail('当前槽位无法按本运行生成器写成工作簿：' + (error instanceof Error ? error.message : '无法重算')); }
}
