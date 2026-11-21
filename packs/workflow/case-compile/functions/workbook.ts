import {blockReviewIdentity} from './block-review-identity.ts';
import {assertionTarget,assertionCells,runtimeBlocks} from './block-runtime.ts';
import {blockMeta,identifier,sourcePlan} from './blocks.ts';
import {cellTemplate} from './cell-selection.ts';
import {selectedExpectedNodes} from './expected-nodes.ts';
// Independent semantic interpretation of xlsx@1. Only the final identity check calls the client generator.
import { createHash } from 'node:crypto';
import FORMAT from '../tables/workbook-format.json' with { type: 'json' };
import { readWorkbookModel, type WorkbookRow } from './generated/skills/runner-workbook/workbook-writer/xlsx-model.ts';
import { decodeG } from './generated/skills/runner-workbook/workbook-writer/g-syntax.ts';
import { canonicalJson } from './canonical-json.ts';
import { readSlots, type PlanSlots } from './slots.ts';
import { parseRuntimeContract, runtimeMethod } from './runtime-contract.ts';
import { parseManifest } from './manifest.ts';
import { parseProfile, allowedCall } from './profile.ts';
import { bindArguments } from './binding.ts';
import { checkContractShape, checkAddresses, checkExpectedSources } from './checks.ts';
import { generateWorkbookSet, caseRecipe, recipeDigest, pathCell, type GenerationInput, type GenerationFields } from './generate.ts';
import { CONFLICT_FIX, conflictText, movedText, volumeOrder, volumeProblems } from './channels.ts';
import { readTemplate, TemplateError, type WorkbookTemplate } from './generated/skills/runner-workbook/workbook-writer/workbook-template.ts';
import { isRecord, markers, type Outcome, opened } from './text.ts';
export interface WorkbookProblem { rule: string; pointer: string; message: string }
export interface ReadExecution { row: number; object: string; method: string; args: string[]; keywords: Record<string, string | number>; assertion: boolean;h?:string;i?:string }
export type WorkbookRead = { ok: true; executions: ReadExecution[]; autoids: string[] } | { ok: false; problems: WorkbookProblem[] };
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
/** Interpret uploaded rows independently in the same declared case order as the generator. */
export function readWorkbook(input: unknown, recipes: GenerationInput | GenerationInput[]): WorkbookRead {
  const problems: WorkbookProblem[] = []; const issue = (rule: string, pointer: string, message: string) => problems.push({ rule, pointer, message });
  const model = readWorkbookModel(input); if (!model) return { ok: false, problems: [{ rule: 'model', pointer: '', message: '不是完整的 xlsx@1 模型' }] };
  const set = volumeOrder(Array.isArray(recipes) ? recipes : [recipes]).ordered; if (!set.length) return { ok: false, problems: [{ rule: 'slots', pointer: '/slots', message: '没有可核对的自动化用例' }] };
  const plans: PlanSlots[] = [];
  for (const recipe of set) { const slots = readSlots(recipe.slots); if (!slots.ok) return { ok: false, problems: [{ rule: 'slots', pointer: '/slots', message: '自动化用例不完整' }] }; plans.push(slots.slots); }
  // Block plans and flat plans may share one workbook: the runner reads every row alike (H and I are simply empty on a flat row), and the
  // generator writes each case with its own plan. The contract, profile, build and generator are the set's (generateWorkbookSet), the rows are each case's.
  const recipe = set[0]; const profile = recipe.profile; const book = profile.workbook;
  let template: WorkbookTemplate;
  try { template = readTemplate(book); } catch (error) { if (error instanceof TemplateError) return { ok: false, problems: [{ rule: 'template', pointer: '/profile/workbook/template', message: error.message }] }; throw error; }
  const headerRow = template.headerRow;
  if (JSON.stringify(model.members.map((v) => v.name).sort()) !== JSON.stringify(template.members.map((v) => v.name).sort())) issue('members', '/members', '成员必须恰好是运行器模板的部件');
  if(model.nulRemoved>0)issue('subset','/nulRemoved','解析移除了 NUL，不属于生成器原字节子集');
  const relation='http://schemas.openxmlformats.org/officeDocument/2006/relationships/';
  const relationKey = (value: { source: string; id: string; type: string; target: string }) => JSON.stringify([value.source, value.id, value.type, value.target]);
  if (JSON.stringify(model.relationships.map(relationKey).sort()) !== JSON.stringify(template.relationships.map(relationKey).sort())) issue('subset', '/relationships', '部件的关系与运行器模板不一致');
  if (model.sharedStrings.length || model.relationships.some((v) => v.external || v.type.endsWith('/sharedStrings'))) issue('subset', '/relationships', '不接受共享字符串或外部关系');
  if (model.sheets.length !== 1) issue('sheets', '/sheets', '只接受一张工作表');
  const sheet = model.sheets[0]; if (!sheet) return { ok: false, problems };
  if (sheet.relationshipType!==relation+'worksheet' || sheet.name !== book.sheet || sheet.part !== FORMAT.worksheet_part || sheet.state !== 'visible') issue('sheets', '/sheets/0', '表名、部件或可见性不符合生成子集');
  const rows = new Map<number, WorkbookRow>(); const values = new Map<number, string[]>(); let previous = 0;
  for (const [r, row] of sheet.rows.entries()) {
    if (row.number <= previous || row.number > FORMAT.max_rows || row.hidden && row.number !== 1) issue('subset', `/sheets/0/rows/${r}`, '行号重复、乱序、过大或有隐藏行'); previous = row.number; rows.set(row.number, row);
    const grid = Array<string>(9).fill(''); const columns = new Set<number>();
    for (const [c, cell] of row.cells.entries()) {
      const at = `/sheets/0/rows/${r}/cells/${c}`; const match = /^([A-Z])([1-9][0-9]*)$/.exec(cell.reference);
      if (!match || Number(match[2]) !== row.number || match[1] > 'I' && row.number > headerRow) { issue('subset', at, '表头以下的单元格超出 A–I，或与行号不符'); continue; }
      const column = match[1].charCodeAt(0) - 65;
      if (column > 8) continue; // The template's own lists; the bytes are compared below.
      if (columns.has(column)) issue('subset', at, '单元格坐标重复'); columns.add(column); grid[column] = cell.text;
      if (cell.formula || cell.text.startsWith('=')) issue('formula', at, '不接受公式或以等号开头的值');
      if (row.number > headerRow && (!FORMAT.cell_types.includes(cell.type) || cell.type === 'n' && cell.text !== '' && column !== 2)) issue('subset', at, '只接受内联字符串及 C 列数字');
      if (cell.text.length > FORMAT.max_cell_chars) issue('subset', at, '单元格超出文字上限');
      if (row.number > headerRow && column === 2 && cell.text !== '' && (cell.type !== 'n' || !/^[0-9]+$/.test(cell.text) || Number(cell.text) === 1)) issue('initialization', at, 'C 列必须是非初始化的数字类型');
    }
    values.set(row.number, grid);
  }
  const grid = (number: number) => values.get(number) ?? Array<string>(9).fill('');
  const headers = [...values].filter(([, cells]) => JSON.stringify(cells) === JSON.stringify(book.header));
  if (headers.length !== 1 || headers[0][0] !== headerRow) issue('header', '/sheets/0', `必须恰好一个九列表头，且在运行器模板的第 ${headerRow} 行`);
  const identities = [...values].filter(([, cells]) => cells[0] === book.identity_marker);
  if (identities.length !== 1 || identities[0][0] !== 1) issue('identity', '/sheets/0', '必须恰好一行身份标记，位于表头上方');
  const identity = grid(1);
  if (identity[1] !== recipe.contract.runtimeVersion || identity[2] !== recipe.contract.pinned.identity || identity[3] || identity[4]) issue('identity', '/sheets/0/rows/0', '运行时/合约身份不符，或认证请求 D/E 格不为空');
  if (identity[FORMAT.identity_generator_column - 1] !== FORMAT.generator) issue('generator', '/sheets/0/rows/0', '工作簿生成器版本与本运行锁定包的生成器版本不符');
  if (identity[FORMAT.identity_recipe_column - 1] !== recipeDigest(set.map((value, k) => caseRecipe({ ...value, generator: FORMAT.generator }, plans[k])))) issue('recipe', '/sheets/0/rows/0', '工作簿没有绑定当前完整槽位、来源字段及配置');
  const reference = `'${book.sheet.replaceAll("'", "''")}'!$A$${headerRow}:$I$${headerRow}`;
  const ranges = model.definedNames.filter((value) => value.name === book.range_name);
  if (ranges.length !== 1 || ranges[0].scope !== null || ranges[0].reference !== reference) issue('range', '/definedNames', '范围名必须是工作簿级，唯一且正好指向九列表头');
  const expectedLast = headerRow + 2 + plans.reduce((sum, value) => sum + value.steps.length + value.expects.length + 1, 0);
  // Where each case's rows begin, from the plans alone: below the description row, each case's steps and expectations and a blank row. A row is
  // read with the plan of the case it falls in, so each case keeps the rules of its own form (a flat row has empty H and I, a block row may
  // carry registers); rows above the first case or below the last (which the closing and description checks refuse when they hold anything)
  // are read with the nearest case's plan.
  const starts: number[] = []; { let at = headerRow + 2; for (const value of plans) { starts.push(at); at += value.steps.length + value.expects.length + 1; } }
  const planAt = (number: number): PlanSlots => { let k = 0; while (k + 1 < starts.length && number >= starts[k + 1]) k++; return plans[k]; };
  if (sheet.lastRow !== template.lastRow || [...values].some(([number, cells]) => number > expectedLast && cells.some(Boolean))) issue('closing', '/sheets/0', '收尾行之后不能再有内容，模板的行数不能变');
  if (JSON.stringify(grid(expectedLast)) !== JSON.stringify(book.closing_row)) issue('closing', '/sheets/0', '收尾行与配置不符');
  const description = headerRow + 1;
  if (grid(expectedLast - 1).some(Boolean) || grid(description)[2] !== '0' || grid(description)[3] !== `Author         : ${FORMAT.generator}\n计划运行 ${recipe.plan_run}；构建 ${recipe.build}` || grid(description).some((v, i) => i !== 2 && i !== 3 && v !== '')) issue('description', '/sheets/0', '自动化用例 Excel 的说明与脚本编写或构建号不符，说明行的执行内容必须为空');
  // Scan every post-header E–I row, including description, blank and closing rows. Registers live within one case, as in
  // the reference runner: it resets them at every row that starts a case (an autoid in A on a row whose C is not the init
  // type 1) to the registers its init rows captured, and clears them before each case's init. This generator writes no init rows, so every case
  // starts without registers; inside a case a name is still captured once.
  const initRegisters=new Set<string>(),initCells=new Set<string>(),caps=runtimeBlocks(recipe.contract); let registers=new Set<string>(),cellRegisters=new Set<string>();
  const executions: ReadExecution[] = []; const executionByRow = new Map<number, ReadExecution>();
  for (const [number, cells] of values) {
    if (number <= headerRow || number === expectedLast) continue;
    const init = cells[2] === '1';
    if (cells[0] !== '' && !init) {registers = new Set(initRegisters);cellRegisters=new Set(initCells);}
    if (!cells.slice(4).some(Boolean)) continue;
    const at = `/sheets/0/rows/${number - 1}`; const [object, method, g, h, variable] = cells.slice(4); const block = !!blockMeta(planAt(number));
    const entry = runtimeMethod(recipe.contract, object, method); const allowed = allowedCall(profile, object, method);
    if (!object || !method || !entry || !allowed || !block&&(!g||h||variable)) { issue('execution', at, 'E/F/G 必须是启用且角色配置完整的调用，H/I 必须为空'); continue; }
    const seat = profile.seats.find((v) => v.object === object); if (seat && seat.ordinal >= profile.device_count) issue('seat', at, '座位序号不小于预检设备数');
    const assertion = Object.values(allowed.parameters).some((role) => role === 'literal_assertion');
    const wait = Object.values(allowed.parameters).length > 0 && Object.values(allowed.parameters).every((role) => role === 'wait');
    if (!assertion && !variable && (/[\r\n\v\f\u0085\u2028\u2029]/.test(g) || g.trim() !== g || /\{(?:0)?\}/.test(g))) issue('execution', at, '普通调用 G 必须是单行最终文字，没有占位符或首尾空白');
    try {
      const decoded = decodeG(g, { literalAssertion: assertion, wait, foldNewlines: profile.fold_newlines.some((v) => v.object === object && v.method === method) });
      const selection=Array.isArray(caps?.cell_methods)&&caps.cell_methods.some((row:any)=>row.object===object&&row.method===method);
      const restore=Array.isArray(caps?.restore_methods)&&caps.restore_methods.some((row:any)=>row.object===object&&row.method===method);
      const cellBound=!!variable&&(selection||cellRegisters.has(variable));
      if (!assertion) for (const problem of bindArguments(entry, { object, method, ...decoded,...(variable?{input_register:variable,...(restore?{restore_for:0}:cellBound?{cell_input:true}:{}),...(selection?{block_kind:'SELECT_CELL'}:{})}:{}) }, at).problems) issue('signature', problem.pointer, problem.message);
      if(block){
        if(assertion){
          if(h&&!registers.has(h))issue('register',at,'检查点期望寄存器未先捕获');
          const countMethod=Array.isArray(caps?.operators)&&caps.operators.some((row:any)=>row.op==='found_times'&&row.object===object&&row.method===method);
          if(countMethod){if(h||!recipe.contract||!variable||!Array.from(variable).every(char=>char>='0'&&char<='9')||!Number.isSafeInteger(Number(variable))||Number(variable)<1)issue('register',at,'次数检查点需要 H 空及 I 正整数');}
          else if(variable&&!registers.has(variable))issue('register',at,'检查点实际原文寄存器未先捕获');
          if(!g&&!h)issue('assertion',at,'检查点缺字面或期望寄存器');
        }else{
          if(!g)issue('execution',at,'普通调用 G 不能为空');
          if(selection){
            if(!variable||!registers.has(variable)||cellRegisters.has(variable)||caps?.cell_inputs!==true||decoded.args[0]!=='{}')issue('register',at,'取格输入必须是本条先前保存的完整设备输出');
          }else if(variable&&cellRegisters.has(variable)){
            if(caps?.cell_inputs!==true||!decoded.args.length||!cellTemplate(decoded.args[0]))issue('register',at,'普通回填必须使用已声明的单格输入和首位置参数模板');
          }else if(variable&&(!registers.has(variable)||!restore||decoded.args.length!==1||decoded.args[0]!=='{}'))issue('register',at,'普通 I 仅用于已捕获原文的声明还原守卫或已取出的单格');
          if(h){if(!identifier(h)||registers.has(h)||!Array.isArray(caps?.output_methods)||!caps.output_methods.some((row:any)=>row.object===object&&row.method===method&&row.output===(selection?'cell_text':'raw_text')))issue('register',at,'H 保存名必须在本条唯一，且方法声明完整原文或单格返回');else{registers.add(h);if(selection){cellRegisters.add(h);if(init)initCells.add(h);}if(init)initRegisters.add(h);}}
        }
      }
      const execution = { row: number, object, method, ...decoded, assertion,...(block?{h,i:variable}:{}) }; executions.push(execution); executionByRow.set(number, execution);
    } catch (error) { issue('G', at, error instanceof Error ? error.message : 'G 无法按运行器规则读取'); }
  }
  const cases = [...values].filter(([number, cells]) => number > headerRow && number < expectedLast && cells[0] !== '');
  if (cases.length !== set.length || cases.some(([number, cells], k) => number !== starts[k] || cells[0] !== set[k].fields.autoid || !new RegExp(book.autoid_pattern, 'u').test(cells[0]) || !cells[4]) || new Set(set.map((value) => value.fields.autoid)).size !== set.length) issue('autoid', '/sheets/0', set.length === 1 ? '必须只有一个原始用例 ID，与原始用例一致，第一步执行内容不能为空' : '每条自动化用例的原始用例 ID 必须依次填写且互不重复，第一步执行内容不能为空，用例之间不能夹入其他原始用例 ID');
  let row = headerRow + 2;
  for (const [k, recipe] of set.entries()) { const plan = plans[k]; let statement = FORMAT.statement_type;
  for (const [i, step] of plan.steps.entries()) {
    const actual = executionByRow.get(row); const cells = grid(row);
    if (!actual || actual.assertion || actual.object !== step.object || actual.method !== step.method || canonicalJson(actual.args) !== canonicalJson(step.args) || canonicalJson(actual.keywords) !== canonicalJson(step.keywords) || cells[2] !== String(statement++) || cells[1] !== (i === 0 ? FORMAT.case_priority : '') || cells[3] !== [i === 0 ? pathCell(recipe.fields.path) : null, step.description].filter((value) => value !== null && value !== undefined).join('\n')||blockMeta(plan)&&(cells[7]!== (step.save_as??'')||cells[8]!== (step.input_register??''))) issue('step', `/sheets/0/rows/${row - 1}`, '执行行逐个回读后与槽位或原文字段不一致');
    row++;
    const allowed = allowedCall(profile, step.object, step.method);
    for (const expect of plan.expects.filter((v) => v.after === i + 1)) {
      const actual = executionByRow.get(row); const cells = grid(row);
      const target=assertionTarget(recipe.contract,profile,expect),expected=target?assertionCells(expect,target):null;
      if (!actual?.assertion || !target||!expected||actual.object!==target.call.object||actual.method!==target.call.method||actual.args.length!==1||cells[6]!==expected.g||Object.keys(actual.keywords).length||cells[3]!==''||cells[1]!==''||cells[2]!==String(statement++)||!blockMeta(plan)&&!Object.values(allowed?.parameters??{}).some(role=>role==='device_cli'||role==='host_shell')||blockMeta(plan)&&(cells[7]!==expected.h||cells[8]!==expected.i))issue('assertion',`/sheets/0/rows/${row-1}`,'自动化用例 Excel 中的期望或检查设备输出的写法与自动化用例不一致');
      row++;
    }
  }
  if (!plan.expects.length || grid(row).some(Boolean)) issue('execution', `/sheets/0/rows/${row - 1}`, '每条自动化用例之后必须留一行空行，步骤或期望数量与自动化用例不一致');
  row++;
  }
  if (row !== expectedLast || executions.length !== plans.reduce((sum, value) => sum + value.steps.length + value.expects.length, 0)) issue('execution', '/sheets/0', '步骤或期望数量与自动化用例不一致，请核对是否漏写或多写');
  return problems.length ? { ok: false, problems } : { ok: true, executions, autoids: set.map((value) => value.fields.autoid) };
}
function generationFields(value: unknown): GenerationFields | null {
  if (!isRecord(value) || typeof value.autoid !== 'string' || typeof value.title !== 'string' || !Array.isArray(value.steps) || value.steps.some((v) => !isRecord(v) || typeof v.text !== 'string') || value.priority !== null && typeof value.priority !== 'string') return null;
  return { autoid: value.autoid, title: value.title, ...(Array.isArray(value.path) ? { path: value.path as string[] } : {}), priority: value.priority, steps: value.steps as Array<{ text: string }> };
}
export default function check(input: unknown): Outcome[] {
  const given = isRecord(input) && isRecord(input.subject) ? input.subject : {};
  const s: Record<string, unknown> = { ...given, plan_set: opened(given.plan_set), fields: isRecord(given.fields) ? { ...given.fields, command_catalog: opened(given.fields.command_catalog) } : given.fields };
  const item = typeof s.item === 'string' ? s.item : undefined;
  const unknown = (reason: NonNullable<Outcome['reason']>, statement: string): Outcome[] => [{ verdict: 'unknown', missing: '尚未取得本检查所需的事实：' + (statement), reason, statement, grounds: [], tier: 'blocking', ...(item ? { item } : {}) }];
  if (!s.workbook) {
    const identity = parseRuntimeContract(s.contract);
    const basis = identity.ok && isRecord(s.profile) && typeof s.profile.synthetic === 'boolean' ? markers(s.profile.synthetic, identity.contract) : '（不证明在真实设备上跑得通）';
    return unknown('missing_input', '缺少自动化用例 Excel。下一步由编写模型把自动化用例核对正确，生成并上传自动化用例 Excel，再继续脚本合并' + basis);
  }
  const raw = isRecord(s.workbook) ? s.workbook : {}; const generation = isRecord(s.generation) ? s.generation : {};
  const contract = parseRuntimeContract(s.contract); const inventory = parseManifest(s.manifest); const slots = readSlots(s.data); const fields = generationFields(s.fields);
  const profile = contract.ok && inventory.ok ? parseProfile(s.profile, contract.contract, inventory.beds) : null;
  if (!contract.ok || !inventory.ok || !profile?.ok || !slots.ok || !fields || typeof generation.plan_run !== 'string' || typeof generation.build !== 'string' || generation.generator !== FORMAT.generator || typeof s.manifest_sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(s.manifest_sha256)) return unknown('check_error', '缺少执行器规则、测试环境或自动化用例的原始资料；下一步由编写模型重新下载已核对正确的自动化用例和原始资料，再做脚本合并。');
  const qualifier = markers(profile.profile.synthetic, contract.contract); const pointer = '/workbook';
  const grounds = typeof raw.sha256 === 'string' && /^[a-f0-9]{64}$/.test(raw.sha256) ? [`src:${raw.sha256}`, `src:${s.manifest_sha256}`] : [];
  const fail = (message: string, at = pointer): Outcome[] => [{ verdict: 'refute', code: 'case-compile.workbook_invalid', statement: message + qualifier, grounds, tier: 'blocking', ...(item ? { item } : {}), pointer: at }];
  const checked = [checkContractShape, checkAddresses, checkExpectedSources].flatMap((fn) => fn({ subject: s }));
  if (checked.some(v => v.verdict === 'refute')) return fail('自动化用例中的步骤、地址或期望有错误；下一步由编写模型改好自动化用例，再生成自动化用例 Excel');
  const unverified = checked.find(v => v.verdict === 'unknown');
  if (unverified) return [{ ...unverified, statement: '自动化用例 Excel 尚未核对。' + unverified.statement, grounds, ...(item ? { item } : {}) }];
  fields.source_atoms=isRecord(s.fields)?s.fields.source_atoms:undefined;fields.bed_services=s.bed_services;fields.manifest_sha256=s.manifest_sha256 as string;fields.criteria_review=s.criteria_review;fields.expected_nodes=isRecord(s.fields)?s.fields.expected_nodes:undefined;fields.command_identities=isRecord(s.fields)?s.fields.command_identities:undefined;fields.command_catalog=isRecord(s.fields)?s.fields.command_catalog:undefined;
  const own: GenerationInput = { slots: slots.slots, fields, contract: contract.contract, profile: profile.profile, plan_run: generation.plan_run, build: generation.build };
  // Several cases (decision 104): the run froze, from the plan run's accepted result, every case's accepted plan and catalog
  // receipt; this item's resubmitted plan must be exactly its frozen one, and the workbook is regenerated from all of them.
  let recipes: GenerationInput[] = [own];
  if (s.plan_set !== undefined && s.plan_set !== null) {
    const frozen = Array.isArray(s.plan_set) ? s.plan_set : null;
    const mine = frozen?.filter((entry) => isRecord(entry) && entry.item === item) ?? [];
    if (!frozen || !frozen.length || mine.length !== 1 || !isRecord(mine[0]) || canonicalJson(mine[0].plan ?? null) !== canonicalJson(s.data ?? null)) return fail(`自动化用例与本次脚本合并核对的脚本编写运行 ${generation.plan_run} 中已受理版本不一致；若你修改或返工了自动化用例，禁止往已锁定的 ${generation.plan_run} 或当前脚本合并运行重交，必须先用 start_run 新开一次脚本编写运行（predecessor 填 test-bed 预订号）提交并核对、重新生成自动化用例 Excel 再新开脚本合并运行；只有内容完全未改时才按 ${generation.plan_run} 原样再交一次`, '/data');
    recipes = [];
    for (const entry of frozen) {
      const case_fields = isRecord(entry) ? generationFields(entry.fields) : null; const plan = isRecord(entry) ? readSlots(entry.plan) : null;
      if (!case_fields || !plan?.ok || !isRecord(entry)) return unknown('check_error', '自动化用例不完整，无法重新生成自动化用例 Excel；请重新下载已核对正确的自动化用例，再做脚本合并。');
      const extra = isRecord(entry.fields) ? entry.fields : {};
      recipes.push({ slots: plan.slots, fields: { ...case_fields, source_atoms: extra.source_atoms, bed_services: s.bed_services, manifest_sha256: s.manifest_sha256 as string, criteria_review: s.criteria_review, expected_nodes: extra.expected_nodes, command_identities: entry.command_identities, command_catalog: entry.command_catalog }, contract: contract.contract, profile: profile.profile, plan_run: generation.plan_run, build: generation.build });
    }
  }
  try {
    const forbidden = volumeProblems(recipes).filter((row) => [...row.side_a, ...row.side_b].some((placed) => placed.autoid === fields.autoid));
    if (forbidden.length) return [{ verdict: 'refute', code: 'case-compile.combination_forbidden', statement: `${forbidden.map(conflictText).join('；')}。${CONFLICT_FIX}。这份自动化用例 Excel 未做上机验证，尚未向设备发送命令${qualifier}`, grounds, tier: 'blocking', ...(item ? { item } : {}), pointer: '/data', data: { conflicts: forbidden } }];
    const read = readWorkbook(raw.model, recipes); if (!read.ok) return read.problems.map((v) => fail(`${v.message}；下一步由编写模型改好自动化用例，重新生成自动化用例 Excel 后继续脚本合并`, `/workbook/model${v.pointer}`)[0]);
    const regenerated = generateWorkbookSet(recipes);
    if (typeof raw.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(raw.sha256) || hash(regenerated) !== raw.sha256) return fail('自动化用例 Excel 与重新生成的文件不一致，请重新生成并上传后继续脚本合并');
    const moved = volumeOrder(recipes).moved, titles = new Map(recipes.map((recipe) => [recipe.fields.autoid, recipe.fields.title] as const));
    return [{ verdict: 'support', statement: '自动化用例 Excel 与自动化用例逐行一致，重新生成的文件也一致，状态已确认，判断正确。决定者程序。' + (moved.length ? `；${movedText(moved, titles)}` : '') + qualifier, grounds, tier: 'blocking', ...(item ? { item } : {}), data: { sha256: raw.sha256, autoids: read.autoids, bed: { id: profile.profile.bed, manifest_sha256: s.manifest_sha256 }, build: generation.build, generator: FORMAT.generator, plan_run: generation.plan_run, ...(moved.length ? { moved_tail: moved } : {}) } }];
  } catch (error) { return fail('自动化用例无法生成自动化用例 Excel。' + (error instanceof Error ? error.message : '无法重算')); }
}
