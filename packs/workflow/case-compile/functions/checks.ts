// The case-compile function checks (compile design section 2): (object, method) against the contract, literal
// addresses against the bed facts and the lineage leases, an explicit source on every expected result, and the
// deterministic re-read of the plan. Every statement closes with the two markers — never "可以运行".
import { isRecord, markers, type Outcome } from './text.ts';
import { isForbidden, lookupMethod, orderedParams, paramProblem, parseContract, type Contract } from './contract.ts';
import { parseManifest, type ManifestBed } from './manifest.ts';
import { bedFacts, isBackend, isBlind, listenerOf, readAddress, type BedFacts } from './bed.ts';
import { generatePlanJson, diffPlan, parsePlan, readSlots, sha256Hex } from './plan.ts';

/** The subject as the checks read it: the item, its plan data, and the raw contract and manifest documents re-parsed here. */
export interface CheckSubject {
  item: string;
  location: string | null;
  data: unknown;
  contract: Contract | null;
  beds: ManifestBed[];
  leases: Array<{ key: string; until: string; mine?: boolean }>;
  now: string;
}

const TIER = 'blocking' as const;
const MAX_PROBLEMS = 10;

function subjectOf(input: unknown): CheckSubject {
  const raw = isRecord(input) ? input : {};
  const subject = isRecord(raw.subject) ? raw.subject : {};
  const contractRead = isRecord(subject.contract) ? parseContract(subject.contract) : null;
  const manifestRead = isRecord(subject.manifest) ? parseManifest(subject.manifest) : null;
  return {
    item: typeof subject.item === 'string' ? subject.item : '',
    location: typeof subject.location === 'string' ? subject.location : null,
    data: subject.data,
    contract: contractRead !== null && contractRead.ok ? contractRead.contract : null,
    beds: manifestRead !== null && manifestRead.ok ? manifestRead.beds : [],
    leases: Array.isArray(subject.leases) ? (subject.leases as CheckSubject['leases']) : [],
    now: typeof subject.now === 'string' ? subject.now : new Date(0).toISOString(),
  };
}

function mark(subject: CheckSubject): string {
  return markers(subject.contract?.synthetic === true);
}

function groundsOf(subject: CheckSubject): string[] {
  return subject.location === null ? [] : [subject.location];
}

function support(subject: CheckSubject, statement: string, data?: { [key: string]: unknown }): Outcome {
  return { verdict: 'support', statement: `${statement}${mark(subject)}`, grounds: groundsOf(subject), tier: TIER, item: subject.item, ...(data === undefined ? {} : { data }) };
}

function refute(subject: CheckSubject, code: string, statement: string, data?: { [key: string]: unknown }): Outcome {
  return { verdict: 'refute', code: `case-compile.${code}`, statement: `${statement}${mark(subject)}`, grounds: groundsOf(subject), tier: TIER, item: subject.item, ...(data === undefined ? {} : { data }) };
}

function unknown(subject: CheckSubject, reason: NonNullable<Outcome['reason']>, statement: string): Outcome {
  return { verdict: 'unknown', reason, statement: `${statement}${mark(subject)}`, grounds: [], tier: TIER, item: subject.item };
}

function noContract(subject: CheckSubject): Outcome[] {
  return [unknown(subject, 'check_error', '合约读不出来（任务包缺陷），无法核对')];
}

function unreadableSlots(subject: CheckSubject): Outcome[] {
  return [unknown(subject, 'missing_input', '槽位形状读不出来（形状问题由合约检查报告），本项无法核对')];
}

/** (object, method) in the contract, not forbidden, parameter count and types right. */
export function checkContractShape(input: unknown): Outcome[] {
  const subject = subjectOf(input);
  if (subject.contract === null) return noContract(subject);
  const contract = subject.contract;
  const read = readSlots(subject.data);
  if (!read.ok) {
    return read.problems.slice(0, MAX_PROBLEMS).map((problem) => {
      const code = problem.pointer.startsWith('/blocks/') ? 'block_unknown' : 'slots_invalid';
      return refute(subject, code, `槽位 ${problem.pointer === '' ? '整体' : problem.pointer}：${problem.message}`);
    });
  }
  const slots = read.slots;
  const out: Outcome[] = [];
  for (const [i, step] of slots.steps.entries()) {
    const at = `第 ${i + 1} 步（${step.object}.${step.method}）`;
    const method = lookupMethod(contract, step.object, step.method);
    if (method === null) {
      out.push(refute(subject, 'method_unknown', `${at} 不在合约里`));
      continue;
    }
    if (isForbidden(contract, step.object, step.method)) {
      out.push(refute(subject, 'method_forbidden', `${at} 是合约禁用的组合`));
      continue;
    }
    const undeclared = Object.keys(step.params).filter((name) => !method.params.some((param) => param.name === name));
    if (undeclared.length > 0) out.push(refute(subject, 'param_arity', `${at} 写了合约没有声明的参数 ${undeclared.join('、')}`));
    const missing = method.params.filter((param) => !param.optional && param.default === null && step.params[param.name] === undefined);
    if (missing.length > 0) out.push(refute(subject, 'param_arity', `${at} 缺必填参数 ${missing.map((param) => param.name).join('、')}`));
    for (const param of method.params) {
      const value = step.params[param.name];
      if (value === undefined) continue;
      const problem = paramProblem(param, value);
      if (problem !== null) out.push(refute(subject, problem.kind === 'range' ? 'param_range' : 'param_type', `${at}：${problem.text}`));
    }
    if (out.length >= MAX_PROBLEMS) break;
  }
  if (out.length === 0) out.push(support(subject, `${slots.steps.length} 步调用符合合约`));
  return out.slice(0, MAX_PROBLEMS);
}

/** Literal addresses resolve against the bed (facts and lineage leases), per their contract roles. */
export function checkAddresses(input: unknown): Outcome[] {
  const subject = subjectOf(input);
  if (subject.contract === null) return noContract(subject);
  const read = readSlots(subject.data);
  if (!read.ok) return unreadableSlots(subject);
  const slots = read.slots;
  const bed = subject.beds.find((candidate) => candidate.name === slots.bucket);
  if (bed === undefined) return [refute(subject, 'bed_unknown', `桶 ${slots.bucket} 不是清单里的台架名（清单有 ${subject.beds.map((candidate) => candidate.name).join('、') || '（无）'}）`)];
  const facts: BedFacts = bedFacts(bed);
  const out: Outcome[] = [];
  let addresses = 0;
  for (const [i, step] of slots.steps.entries()) {
    const at = `第 ${i + 1} 步（${step.object}.${step.method}）`;
    const method = lookupMethod(subject.contract, step.object, step.method);
    if (method === null) continue;
    for (const param of method.params) {
      if (param.address === null) continue;
      const value = step.params[param.name] ?? param.default;
      if (value === undefined || value === null) continue;
      if (typeof value !== 'string') continue;
      addresses++;
      const role = param.address;
      const reading = readAddress(bed, subject.leases, subject.now, value);
      if (reading.kind === 'off_bed') {
        out.push(refute(subject, 'address_off_bed', `${at} 的地址 ${value} 不是台架 ${bed.name} 上的设备接口地址，也不是这次运行血缘里分配到的地址`));
        continue;
      }
      if (role === 'listen') {
        if (reading.kind !== 'interface' || reading.type !== 'load-balancer') out.push(refute(subject, 'listen_not_dut', `${at} 的监听地址 ${value} 不是被测设备的接口地址`));
        else if (listenerOf(facts, value) === undefined) out.push(refute(subject, 'listen_blind', `${at} 的监听地址 ${value} 所在的网段上没有触发设备（盲地址）`));
      } else if (role === 'backend') {
        if (!isBackend(facts, value)) out.push(refute(subject, 'backend_not_server', `${at} 的后端地址 ${value} 不是服务器设备的接口地址`));
      } else if (role === 'virtual') {
        if (isBlind(facts, value)) out.push(refute(subject, 'address_blind', `${at} 的虚拟地址 ${value} 是盲地址（所在网段没有触发设备）`));
      }
    }
    if (out.length >= MAX_PROBLEMS) break;
  }
  if (out.length === 0) out.push(support(subject, `${addresses} 个字面地址都对得上台架 ${bed.name}`));
  return out.slice(0, MAX_PROBLEMS);
}

/** Every expected result carries an explicit verbatim source. */
export function checkExpectedSources(input: unknown): Outcome[] {
  const subject = subjectOf(input);
  const read = readSlots(subject.data);
  if (!read.ok) return unreadableSlots(subject);
  const expects = read.slots.expects;
  if (expects.length === 0) return [refute(subject, 'expect_without_source', '这份执行计划一个期望结果都没有')];
  const out: Outcome[] = [];
  for (const [i, expect] of expects.entries()) {
    if (expect.quote.reference === '' || expect.quote.text === '') out.push(refute(subject, 'expect_without_source', `第 ${i + 1} 个期望结果「${expect.text}」没有逐字来源`));
    if (out.length >= MAX_PROBLEMS) break;
  }
  if (out.length === 0) out.push(support(subject, `${expects.length} 个期望结果都带有逐字来源`));
  return out;
}

/** The plan is generated from the slots here, then read back by a second reader and compared item by item (P05). */
export function checkDeterministic(input: unknown): Outcome[] {
  const subject = subjectOf(input);
  if (subject.contract === null) return noContract(subject);
  // The restricted structure holds no plan of the model's own: a plan_json in the slots is the model playing generator.
  if (isRecord(subject.data) && subject.data.plan_json !== undefined) {
    return [refute(subject, 'plan_in_slots', '槽位里写了 plan_json：执行计划由 Hub 从槽位生成，不由模型写或改写')];
  }
  const read = readSlots(subject.data);
  if (!read.ok) return unreadableSlots(subject);
  const generated = generatePlanJson(subject.item, read.slots, subject.contract);
  if (generated === null) return [unknown(subject, 'output_failed', '从槽位生成执行计划失败，出件失败（步骤或必填参数的问题由合约检查报告）')];
  const digest = sha256Hex(generated);
  const reread = parsePlan(generated);
  if (reread === null) return [unknown(subject, 'output_failed', `生成的执行计划回读解析失败，出件失败（sha256 ${digest}）`)];
  const diffs = diffPlan(read.slots, reread, subject.contract);
  if (diffs.length > 0) return [unknown(subject, 'output_failed', `生成的执行计划与槽位回读不一致，出件失败（sha256 ${digest}）：${diffs.slice(0, 3).join('；')}`)];
  return [support(subject, `执行计划由槽位确定性生成并回读一致（sha256 ${digest}）`, { plan: generated, sha256: digest })];
}
