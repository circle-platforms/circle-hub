// The Jev side of the two judge tools (command check and scenario fidelity audit).
//
// Jev is a hosted judgment service. The calls are made on the client by the embedded client of the jev-judge skill;
// this file only turns the questions the tools already build for Plumb into Jev questions and turns Jev's answers
// back into the answer shape the tools consume. Nothing here runs inside the Hub.
//
// Jev answers carry no calibrated gate in this workflow, so every answer comes back with gate action "review"
// (calibrated: false), status "未确认" and decided_by "模型". No answer releases or refuses anything by itself:
// the command check discloses it as advice and a fidelity verdict goes to the blind audit.
//
// Jev bills every request, so what was answered is kept. Next to the tool's other outputs an answers file holds, for each question, a digest
// (of the exact model version, the state and the question: no text of either) and the answer the client validated; a later pass asks only what
// has no answer yet, and an answer is kept the moment it arrives, so a request that fails later in the batch costs nothing already paid for.
// A question the service rejects is neither an outage of the service nor a fault of the plan: there is no Jev opinion for that unit, the batch
// goes on with the others, and the tool says which units have none and why.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { CallErrorCategory as CallErrorCode } from './generated/vocabulary.ts';
import type { JevAnswer, JevQuestion, JevRequest, JevResponse } from './generated/skills/jev-judge/jev-client/index.ts';
import type { PlumbBatchAnswer, PlumbBatchQuestion, PlumbGate } from './generated/skills/plumb/plumb-client/index.ts';
import { CallFailure, isRecord } from './text.ts';

/** What this file needs of the embedded client of the jev-judge skill: its one call and, when it can say, how many requests it really sent. The skill's client fits it; tests hand in a scripted one. */
export interface JevAsker { ask(request: JevRequest): Promise<JevResponse>; sent?: () => number }

export const JEV_NAME = 'Jev';
/** The model the first request of an invocation asks for when nothing names one; the later ones ask for the exact version its answer named. */
export const JEV_FIRST_MODEL = 'jev-latest';
/** What an answered model name must look like to be recorded as a version: a name and three numbers. A moving alias such as jev-latest is not one. */
export const JEV_EXACT_VERSION = /^[A-Za-z][A-Za-z0-9_-]*-\d+\.\d+\.\d+$/u;
/**
 * The budget of one state put to Jev, in estimated tokens: the text of a fidelity step, or the context, the command and the syntax reference of a
 * command. The number is the budget InfoTest gives every state it puts to Jev. Its estimator counts one token per CJK character and one per four
 * other characters; the estimator of this pack (the Plumb client's estimateTokens) counts one per 3.5 other characters, so for the Chinese and ASCII
 * text of a case ours counts at least as many, and a text is no nearer the budget there than here.
 * It is a budget of ours, not a limit measured on the service. What the service itself refuses (max_tokens_exceeded, which the client reports as
 * context_too_long, and HTTP 413, request_too_large) is handled as it was: a command question is asked again with fewer earlier steps, any
 * other question that is turned down has no Jev opinion.
 */
export const JEV_STATE_BUDGET_EST_TOKENS = 32_768;
export const JEV_COMMAND_PROMPT = 'jev-noul@command-v1';
export const JEV_FIDELITY_PROMPT = 'jev-choice@fidelity-v1';
/** The verdict words of a fidelity question, as the audit's own rules name them. */
export const FIDELITY_CHOICES = ['preserved', 'changed', 'unrealized'] as const;
/** The codes of the client for a question the service (or the client's own check) turned down: no opinion for that question, and no fault of the plan. */
export const QUESTION_REJECTIONS: ReadonlySet<string> = new Set(['request_rejected', 'request_too_large', 'context_too_long', 'invalid_request']);
/** What the failure of the request log says first, so that a caller can tell it from a refusal of the question. */
export const JEV_LOG_FAILED = 'Jev 的请求记录没有写成';
const GATE: PlumbGate = { action: 'review', calibrated: false, calibration_source: 'uncalibrated' };
const QUESTION_ID = 'q1';

const COMMON_CONTEXT = [
  '`context` describes one automated test case: its title, the steps that were already executed with their command lines,',
  'and the current step with its intent and its candidate command.',
];
export const SINGLE_INSTRUCTIONS = [
  'The request state is an object with the fields `context`, `command` and, when present, `definition`.',
  ...COMMON_CONTEXT,
  'Judge whether `command` is a command line that the current step calls for, with the right arguments:',
  'it does what the step intends, it addresses what the step addresses, and its argument values are the ones',
  'this step and the earlier steps call for.',
  'When `definition` is present it is the syntax reference of the command; use it for the syntax and the meaning of the arguments.',
  'Answer yes only when the command line is right for the current step; answer no when it does something else,',
  'addresses something else or carries other values.',
].join('\n');
export const LIST_INSTRUCTIONS = [
  'The request state is an object with the fields `context`, `commands` (an ordered list of command lines) and, when present, `definition`.',
  ...COMMON_CONTEXT,
  'Judge whether `commands` is the correct list of command lines for the current step: the right commands, with the',
  'arguments this step and the earlier steps call for, nothing missing and nothing extra.',
  'When `definition` is present it is the syntax reference of the commands (several references are separated by a line of three hyphens).',
  'Answer yes only when the whole list is right for the current step; answer no when a command is wrong, missing or superfluous.',
].join('\n');
export const COMMAND_CRITERIA = { true: 'the command line (the list) is what the current step calls for', false: 'it is not' };
export const FIDELITY_CRITERIA: Record<(typeof FIDELITY_CHOICES)[number], string> = {
  preserved: "the bound blocks realize this step's scenario as the author wrote it",
  changed: 'the blocks realize a different scenario or alter a condition the author stated',
  unrealized: 'no block realizes this step',
};
export const fidelityInstructions = (step: string): string => `Do the blocks realize author step ${step}'s scenario as the author wrote it? Judge only scenario fidelity of this step; pick exactly one verdict.`;

const CODE_OF: Record<string, CallErrorCode> = { '参数无效': 'invalid_parameters', '无权限': 'permission_denied', '暂时不可用': 'temporarily_unavailable' };

/** A refusal of the Jev judge in the words the pipeline already reads: its category word stays in the printed text. */
export class JevJudgeFailure extends CallFailure {
  readonly status: number;
  /** What the client of the skill ended the call with (its closed set of codes); empty when the failure is the adapter's own. */
  readonly code: string;
  constructor(category: CallErrorCode, fact: string, nextAction: string, status = 0, code = '') {
    super(category, fact, nextAction);
    this.name = 'JevJudgeFailure';
    this.status = status;
    this.code = code;
  }
}

const clip = (text: string, chars: number): string => { const flat = text.replace(/\s+/gu, ' ').trim(); return [...flat].length > chars ? `${[...flat].slice(0, chars).join('')}…` : flat; };

/** The failure of the client of the skill, in the words the pipeline reads; anything else is returned as it is. The key never reaches the text. */
export function jevFailure(error: unknown, secret: string): unknown {
  if (error instanceof CallFailure) return error;
  if (!isRecord(error) || typeof error.category !== 'string' || !Object.hasOwn(CODE_OF, error.category)) return error;
  const status = typeof error.status === 'number' && Number.isFinite(error.status) ? error.status : 0;
  const named = typeof error.code === 'string' ? error.code : '';
  const where = [status > 0 ? `HTTP ${status}` : '', named].filter(Boolean).join('，') || '没有应答';
  // The client's own message is already in the call-error form (category word, fact, next step); its category word is the one this text starts with.
  const own = typeof error.message === 'string' ? error.message.replace(/^(?:参数无效|无权限|暂时不可用)：/u, '').trim() : '';
  const said = own ? `：${clip(secret ? own.split(secret).join('***') : own, 200)}` : '';
  const code = CODE_OF[error.category]!;
  // The request log is the caller's own file: when it cannot be written the service is not at fault and the question was not refused.
  if (named === 'audit_failed') return new JevJudgeFailure(code, `${JEV_LOG_FAILED}（${where}）${said}`, '先修好请求记录的位置和权限，再启动编写循环；计划不用改', status, named);
  // A key the client's own shape check turns down was never sent: it is not a key that Jev refused.
  if (named === 'invalid_key') return new JevJudgeFailure(code, `${JEV_NAME} 密钥照现在的写法用不了（密钥为空、太长或含不允许的字符），没有发出任何请求（${where}）`, '请使用者向管理员重新领取 Jev 密钥，保存为客户端密钥 JEV_API_KEY，再启动编写循环；计划不用改', status, named);
  if (code === 'permission_denied') return new JevJudgeFailure(code, `${JEV_NAME} 拒绝了密钥（${where}）${said}`, '请使用者向管理员重新领取 Jev 密钥，保存为客户端密钥 JEV_API_KEY，再启动编写循环；计划不用改', status, named);
  if (code === 'temporarily_unavailable') return new JevJudgeFailure(code, `${JEV_NAME} 暂时不可用（${where}）${said}`, '稍后再启动编写循环重试；计划不用改', status, named);
  return new JevJudgeFailure(code, `${JEV_NAME} 拒收了这道题（${where}）${said}`, '按这条说明缩短题面或改正后重跑', status, named);
}

const unusable = (fact: string): JevJudgeFailure => new JevJudgeFailure('temporarily_unavailable', fact, '稍后再启动编写循环重试；计划不用改');
const digestOf = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A question that got no answer because it was turned down: what the tool says of the unit, never a text of the question. */
export interface JevUnanswered { code: string; status: number; reason: string }
const REJECTION_WORDS: Record<string, string> = {
  request_too_large: '题面超过 Jev 服务的大小上限',
  context_too_long: '题面超过 Jev 模型的上下文上限',
  request_rejected: 'Jev 服务拒绝了这个请求',
  invalid_request: '这道题没有通过客户端的本地检查，没有发出',
};
export const unansweredOf = (failure: JevJudgeFailure): JevUnanswered => ({
  code: failure.code,
  status: failure.status,
  reason: `${REJECTION_WORDS[failure.code] ?? 'Jev 没有答复这道题'}（${[failure.status > 0 ? `HTTP ${failure.status}` : '', failure.code].filter(Boolean).join('，')}）`,
});

type Kind = 'command' | 'fidelity';
interface Job { id: string; kind: Kind; state: unknown; question: JevQuestion; key: string }
/** The key of an answer in the answers file: it holds the exact model version, the state and the question, and shows none of them. */
const entryKey = (job: Job, version: string): string => digestOf([version, job.state, job.question]);

export interface JevJudgeOptions {
  /** The model the first request asks for. */
  model?: string;
  /** Requests in flight after the exact version is known. */
  concurrency?: number;
  /** The key, so that no failure text can carry it. */
  secret?: string;
  /** The answers file (one line per answer): read before the first request and appended to as answers arrive. */
  answersFile?: string;
}
export interface JevBatchResponse {
  status: '未确认'; decided_by: '模型';
  /** The exact version the answers are of; null when no question was answered. */
  model_version: string | null;
  task?: string;
  answers: Record<string, PlumbBatchAnswer>;
  /** The questions that were turned down, with the reason: there is no Jev opinion for them. */
  unanswered: Record<string, JevUnanswered>;
}

const MAX_ANSWERS_FILE_BYTES = 16 * 1024 * 1024;

export class JevJudge {
  readonly judge = 'jev' as const;
  private readonly asker: JevAsker;
  private readonly firstModel: string;
  private readonly concurrency: number;
  private readonly secret: string;
  private readonly answersFile: string | null;
  private pinned: string | null = null;
  private sent = 0;
  private readonly store = new Map<string, JevAnswer>();
  private loading: Promise<void> | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** Questions the service turned down: the same text is not sent again, whoever asks. */
  private readonly rejected = new Map<string, JevJudgeFailure>();

  constructor(asker: JevAsker, options: JevJudgeOptions = {}) {
    this.asker = asker;
    this.firstModel = options.model?.trim() || JEV_FIRST_MODEL;
    this.concurrency = Math.max(1, Math.floor(options.concurrency ?? 2));
    this.secret = options.secret ?? '';
    this.answersFile = options.answersFile ?? null;
  }

  /** The exact version of the model the answers are of: the one that answered, or the one the answers file names; null before the first answer. */
  get modelVersion(): string | null { return this.pinned; }
  /** Requests that were really sent: what the client counted at its transport when it can say (a request it sent again counts again), else the asks. */
  get requests(): number { return this.asker.sent ? this.asker.sent() : this.sent; }

  async judgeBatched(params: { task?: string; questions: Record<string, PlumbBatchQuestion> }): Promise<JevBatchResponse> {
    const entries = Object.entries(params.questions);
    if (entries.length === 0) throw new JevJudgeFailure('invalid_parameters', '批量判别题目列表为空', '请至少传入 1 道待判题目');
    const jobs = entries.map(([id, question]) => this.job(id, question, params.task));
    await (this.loading ??= this.read());
    const answers: Record<string, PlumbBatchAnswer> = {};
    const unanswered: Record<string, JevUnanswered> = {};
    let failure: unknown = null;
    const attempt = async (job: Job): Promise<void> => {
      try { answers[job.id] = await this.run(job); }
      catch (error) {
        if (error instanceof JevJudgeFailure && QUESTION_REJECTIONS.has(error.code)) unanswered[job.id] = unansweredOf(error);
        else failure ??= error;
      }
    };
    const queue = [...jobs];
    // Until the exact version is known (the answers file may name it already) the requests go one at a time: the first answer names the version
    // every later request asks for, so one invocation has one model_version.
    while (this.pinned === null && queue.length > 0 && failure === null) await attempt(queue.shift()!);
    const worker = async (): Promise<void> => {
      for (let job = queue.shift(); job !== undefined && failure === null; job = queue.shift()) await attempt(job);
    };
    await Promise.all(Array.from({ length: Math.min(this.concurrency, queue.length) }, worker));
    if (failure !== null) throw failure;
    return { status: '未确认', decided_by: '模型', model_version: this.pinned, ...(params.task ? { task: params.task } : {}), answers, unanswered };
  }

  private job(id: string, question: PlumbBatchQuestion, fallbackTask: string | undefined): Job {
    const task = question.task ?? fallbackTask;
    const key = (kind: Kind, state: unknown, built: JevQuestion): Job => ({ id, kind, state, question: built, key: digestOf([kind, state, built]) });
    if (task === 'single_cmd_judge' || task === 'steplist_judge') {
      const context = question.state !== undefined ? question.state : question.node;
      if (context === undefined) throw new JevJudgeFailure('invalid_parameters', `题目 ${id} 缺少上下文（state 或 node）`, '请检查命令核验为这道题准备的上下文');
      const list = task === 'steplist_judge';
      const commands = Array.isArray(question.commands) ? question.commands : typeof question.commands === 'string' ? question.commands.split(/\r?\n/u).filter(Boolean) : [];
      const line = question.command;
      if (list ? commands.length === 0 : typeof line !== 'string' || !line.trim()) throw new JevJudgeFailure('invalid_parameters', `题目 ${id} 没有要判断的命令`, '请检查命令核验为这道题取出的命令');
      const state = { context, ...(list ? { commands } : { command: line }), ...(question.definition ? { definition: question.definition } : {}) };
      return key('command', state, { type: 'noul', instructions: list ? LIST_INSTRUCTIONS : SINGLE_INSTRUCTIONS, criteria: COMMAND_CRITERIA });
    }
    if (task === 'sequence') {
      if (typeof question.state !== 'string' || !question.state) throw new JevJudgeFailure('invalid_parameters', `题目 ${id} 缺少场景保真的题面`, '请检查场景保真为这道题准备的题面');
      const label = isRecord(question.metadata) && typeof question.metadata.author_step === 'string' && question.metadata.author_step ? question.metadata.author_step : String(question.step_n ?? '');
      return key('fidelity', question.state, { type: 'choice', instructions: fidelityInstructions(label), criteria: { ...FIDELITY_CRITERIA } });
    }
    throw new JevJudgeFailure('invalid_parameters', `Jev 判断只做命令核验（single_cmd_judge、steplist_judge）和场景保真（sequence），不做 ${task ?? '未写任务'}`, '请改用 Plumb，或检查调用方传的任务名');
  }

  private build(job: Job, raw: JevAnswer, version: string): PlumbBatchAnswer | null {
    return job.kind === 'command' ? noulAnswer(raw, version) : choiceAnswer(raw, version);
  }

  /** The answer this question already has, from this run or from an earlier pass; a line of the file that does not validate is no answer. */
  private kept(job: Job): PlumbBatchAnswer | null {
    if (this.pinned === null) return null;
    const raw = this.store.get(entryKey(job, this.pinned));
    return raw === undefined ? null : this.build(job, raw, this.pinned);
  }

  private async run(job: Job): Promise<PlumbBatchAnswer> {
    const already = this.kept(job);
    if (already) return already;
    const refused = this.rejected.get(job.key);
    if (refused) throw refused;
    let response: JevResponse;
    this.sent += 1;
    try {
      response = await this.asker.ask({ state: job.state, questions: { [QUESTION_ID]: job.question }, model: this.pinned ?? this.firstModel });
    } catch (error) {
      const failure = jevFailure(error, this.secret);
      if (failure instanceof JevJudgeFailure && QUESTION_REJECTIONS.has(failure.code)) this.rejected.set(job.key, failure);
      throw failure;
    }
    const version = typeof response?.model_version === 'string' ? response.model_version.trim() : '';
    if (!isRecord(response) || response.status !== '未确认' || response.decided_by !== '模型' || !version) throw unusable(`${JEV_NAME} 的回答缺少未确认的模型披露（status、decided_by、model_version）`);
    // A moving alias is no version: nothing of this answer is recorded, neither the version nor the answer.
    if (!JEV_EXACT_VERSION.test(version)) throw unusable(`${JEV_NAME} 答出来的模型名是 ${clip(version, 60)}，不是确切版本（要写成 名称-X.Y.Z）；这份答案没有记下，报告里也不写它`);
    if (this.pinned !== null && version !== this.pinned) throw unusable(`${JEV_NAME} 在一次核验里换了模型版本（${this.pinned}、${version}）`);
    const raw = response.answers?.[QUESTION_ID];
    const answer = raw === undefined ? null : this.build(job, raw, version);
    if (answer === null) throw unusable(`${JEV_NAME} 的回答里没有这道题的答案，或答案的形状不对`);
    this.pinned ??= version;
    await this.keep(job, version, raw!);
    return answer;
  }

  /** Reads the answers file once: its lines of one exact version (the first line's) are the answers of earlier passes, and that version is the one asked for. */
  private async read(): Promise<void> {
    if (this.answersFile === null) return;
    let text = '';
    try {
      const handle = await open(this.answersFile, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { if ((await handle.stat()).size <= MAX_ANSWERS_FILE_BYTES) text = await handle.readFile('utf8'); } finally { await handle.close(); }
    } catch { return; }
    let version: string | null = null;
    for (const line of text.split('\n')) {
      let row: unknown;
      try { row = JSON.parse(line); } catch { continue; }
      if (!isRecord(row) || typeof row.key !== 'string' || !/^[0-9a-f]{64}$/u.test(row.key) || typeof row.model_version !== 'string' || !JEV_EXACT_VERSION.test(row.model_version) || !isRecord(row.answer)) continue;
      // A line that does not validate is no answer, and does not take the place of an earlier line of the same question that does.
      const answer = row.answer as unknown as JevAnswer;
      if (noulAnswer(answer, row.model_version) === null && choiceAnswer(answer, row.model_version) === null) continue;
      version ??= row.model_version;
      if (row.model_version === version) this.store.set(row.key, answer);
    }
    this.pinned = version;
  }

  /** Keeps an answer the moment it is validated; a file that cannot be written only costs a later request, never this answer. */
  private keep(job: Job, version: string, raw: JevAnswer): Promise<void> {
    const key = entryKey(job, version);
    this.store.set(key, raw);
    const file = this.answersFile;
    if (file === null) return Promise.resolve();
    this.writing = this.writing.then(async () => {
      try {
        await mkdir(dirname(file), { recursive: true, mode: 0o700 });
        const handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | constants.O_NOFOLLOW, 0o600);
        try { await handle.writeFile(`${JSON.stringify({ key, model_version: version, answer: raw })}\n`, 'utf8'); } finally { await handle.close(); }
      } catch { /* the answer is in memory for this run */ }
    });
    return this.writing;
  }
}

const probability = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null);
const disclosed = (version: string) => ({ status: '未确认' as const, decided_by: '模型' as const, model_version: version, gate: { ...GATE } });

/** The yes/no answer, where normalizeJudgeAnswer and judgeStep read it: match and value, and probabilities.yes. */
function noulAnswer(raw: JevAnswer, version: string): PlumbBatchAnswer | null {
  if (raw.type !== 'noul') return null;
  const yes = probability(raw.noul);
  if (yes === null) return null;
  return { type: 'noul', value: yes, match: yes, confidence: yes, probabilities: { yes, no: Math.round((1 - yes) * 1e9) / 1e9 }, ...disclosed(version) };
}

/** The verdict answer; its probability is the one of the chosen verdict, not Jev's rescaled confidence. */
function choiceAnswer(raw: JevAnswer, version: string): PlumbBatchAnswer | null {
  if (raw.type !== 'choice' || !(FIDELITY_CHOICES as readonly string[]).includes(raw.choice) || !isRecord(raw.probabilities)) return null;
  if (Object.keys(raw.probabilities).some((name) => !(FIDELITY_CHOICES as readonly string[]).includes(name))) return null;
  const chosen = probability(raw.probabilities[raw.choice]);
  if (chosen === null || Object.values(raw.probabilities).some((value) => probability(value) === null)) return null;
  return { type: 'choice', choice: raw.choice, value: raw.choice, confidence: chosen, probabilities: { ...raw.probabilities }, ...disclosed(version) };
}
