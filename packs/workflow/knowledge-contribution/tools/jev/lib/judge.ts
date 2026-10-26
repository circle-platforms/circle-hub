import { JevError } from './errors.ts';
import { HttpJev, type HttpJevOptions } from './http.ts';
import { checkRequest, checkQuestion, isQuestionId } from './validate.ts';
import { estimateTokens } from './tokens.ts';
import { judgmentRecord, inputDigest, reuseKey, type JevJudgmentRecord, type JevQuestion, type JevRequest } from './api.ts';
import { EGRESS } from './pieces.ts';
import { need, record, sha, Refusal, type LocalStore } from './local.ts';
import type { Piece } from './hub.ts';
function egressQuestion(question:JevQuestion):void {
  need(Array.from(question.instructions).length<=EGRESS.max_instructions_chars,'instructions 超过外发长度上限；缩短问题，不能夹带受限正文');
  const descriptions=question.type==='score'?question.criteria:Object.values(question.criteria??{});
  need(descriptions.every(value=>value===null||typeof value==='string'&&Array.from(value).length<=EGRESS.max_description_chars),'选项或等级说明超过外发长度上限；缩短说明后重跑');
}
/** One batch of questions and the state they are asked against. */
export interface Work {
  state: Record<string, string>;
  questions: Record<string, JevQuestion>;
  pieces: Piece[];
  /**
   * The state keys each question is about, as the caller declares them: question id -> state keys, every key present in
   * `state`. Nothing here is read out of a question's text (owner rule 2026-10-24, sweep A82); a question without a
   * declaration, or declaring a key outside this batch, is a structural problem and is not asked.
   */
  bindings: Record<string, readonly string[]>;
  action?:'ask'|'calibrate'|'place';
  node?:string;
}

/** The declared pieces of one question, checked against the state of its batch. */
function declaredPieces(work: Work, id: string): readonly string[] {
  const declared = work.bindings === undefined ? undefined : work.bindings[id];
  need(
    Array.isArray(declared) && declared.length > 0 && declared.every((key) => typeof key === 'string'),
    `问题 ${id} 没有显式声明它判断的片段（缺的事实：这道题的片段声明；下一步：在 jev-ask@1 的这道题上写 pieces:["<片段 id>"]，id 取自本次 pieces 列表；不从题目文字里找）`,
  );
  for (const key of declared) {
    need(
      Object.hasOwn(work.state, key),
      `问题 ${id} 声明的片段 ${key} 不在这次请求的 state 里（缺的事实：该片段在本批作用域内的原文；下一步：把该片段加进本批 pieces，或改用本批已声明的片段 id）`,
    );
  }
  return declared;
}

/** What one question was judged against: its single declared piece, or the object of its declared pieces. */
function judgedInput(work: Work, id: string): unknown {
  const declared = declaredPieces(work, id);
  return declared.length === 1 ? work.state[declared[0]] : Object.fromEntries(declared.map((key) => [key, work.state[key]]));
}
export class Judge {
  stopped:string|null=null;
  attempts=0; sentFragments=new Map<string,string>(); failures=new Map<string,string>(); oversized=new Map<string,{code:string;estimate:number;message:string}>();
  model: string; client: HttpJev; store: LocalStore; send: string[]; cache = new Map<string, JevJudgmentRecord>();
  constructor(model: string, key: () => string, baseUrl: string | undefined, store: LocalStore, send: string[], options: Partial<HttpJevOptions> = {}) {
    this.model = model; this.store = store; this.send = send;
    this.client = new HttpJev({ ...options, apiKey: key, model, baseUrl, onSending:async(event)=>{
      this.attempts++;const fragments=Object.entries(event.request.state).map(([id,value])=>({id,sha256:sha(typeof value==='string'?value:JSON.stringify(value)),bytes:Buffer.byteLength(typeof value==='string'?value:JSON.stringify(value)),...this.activePieces.get(id)}));for(const fragment of fragments)if(fragment.reference&&fragment.kind)this.sentFragments.set(fragment.reference,fragment.kind);await store.append('requests.jsonl',{phase:'sending',at:new Date().toISOString(),request_digest:inputDigest(event.request),fragments,send,questions:Object.keys(event.request.questions),attempts:event.attempt});
    },onAttempt: async (event) => {
      const fragments = Object.entries(event.request.state).map(([id, value]) => ({ id, sha256: sha(typeof value === 'string' ? value : JSON.stringify(value)), bytes: Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)), ...this.activePieces.get(id) }));
      for(const fragment of fragments){if(fragment.reference&&fragment.kind)this.sentFragments.set(fragment.reference,fragment.kind);}
      await store.append('requests.jsonl', { phase:'completed', at: new Date().toISOString(), request_digest: inputDigest(event.request), fragments, send, questions: Object.keys(event.request.questions), attempts: event.attempt, http_status: event.status, request_id: event.requestId, result: event.result });
    } });
  }
  activePieces = new Map<string, { reference: string; kind: string }>();
  async load() { for (const value of await this.store.records('judgments.jsonl')) if (record(value) && typeof value.reuse_key === 'string' && value.requested_model === this.model && value.returned_model === this.model && value.exact_model === this.model && value.reuse_key === reuseKey({ model: this.model, stateDigest: value.state_digest, question: { type: value.question_type, instructions: value.instructions, ...(value.question_type === 'choice' ? {criteria:Object.fromEntries(value.candidates.map((v:any)=>[v.name,v.description]))} : value.question_type === 'score' ? {criteria:value.candidates.map((v:any)=>v.description)} : {criteria:Object.fromEntries(value.candidates.map((v:any)=>[v.name,v.description]))}) } as JevQuestion })) this.cache.set(value.reuse_key, value as JevJudgmentRecord); }
  async ask(work: Work): Promise<{ answers: Record<string, JevJudgmentRecord>; failed: string[]; oversized:string[] }> {
    for (const piece of work.pieces) this.activePieces.set(piece.id, { reference: piece.reference, kind: piece.kind });
    // Every question names the pieces it is about before anything is sent: a missing or out-of-scope declaration stops
    // the batch instead of falling back to the first id a question's text happens to mention.
    for (const id of Object.keys(work.questions)) declaredPieces(work, id);
    const request: JevRequest = { model: this.model, state: work.state, questions: work.questions }; this.store.guard(request);
    for(const question of Object.values(work.questions))egressQuestion(question);
    const checked = checkRequest(request, { pinnedModel: this.model, maxRequestBytes: 16 * 1024 * 1024 });
    const stateTokens = estimateTokens(JSON.stringify(work.state)) + 256;
    const oversized:string[]=[];const eligible:Record<string,JevQuestion>={};
    for(const [id,q] of Object.entries(work.questions)){
      const questionTokens=estimateTokens(JSON.stringify(q))+32;const estimate=stateTokens+questionTokens;
      if(estimate>24000){const reference=work.pieces.find(p=>p.id===id)?.reference??work.pieces[0]?.reference??id;const location=`条目 ${reference}，节点 ${work.node??'未提供'}`;const wide=questionTokens+256>24000;const reason=wide?`节点 ${work.node??'未提供'} 的选项超出单题预算，该层不能提问`:'片段与选项超过单题预算';const next=work.action==='calibrate'?'该条目不作校准样例，已跳过':wide?'本条不作提议；由集成者调整节点粒度，或使用已确认的更小 --under 后重跑':'本条不作提议；从 --pieces 去掉该条目，--from 模式可改用 --pieces 选择其余条目';const message=`${location}：${reason}，估算 ${estimate} 令牌，上限 24,000，没有提问；${next}`;this.oversized.set(id,{code:'oversized',estimate,message});oversized.push(id);}else eligible[id]=q;
    }

    need(Object.keys(eligible).length<=10&&stateTokens+estimateTokens(JSON.stringify(eligible))+32*Object.keys(eligible).length<=48000||Object.keys(eligible).length===0,'整批超过 48,000 令牌；拆成更小批次重跑');
    const stateDigest = inputDigest(work.state); const answers: Record<string, JevJudgmentRecord> = {}; const pending: Record<string, JevQuestion> = {};
    for (const [id, question] of Object.entries(eligible)) { const key = reuseKey({ model: this.model, question, stateDigest })!; const old = this.cache.get(key); if (old) answers[id] = old; else pending[id] = question; }
    if (Object.keys(pending).length === 0) return { answers, failed: [],oversized };
    if(this.stopped){for(const id of Object.keys(pending))this.failures.set(id,this.stopped);return {answers,failed:Object.keys(pending),oversized};}
    const send = async (questions: Record<string, JevQuestion>, split: boolean): Promise<string[]> => {
      const actual = { ...checked.request, questions };
      try {
        const response = await this.client.ask(actual); this.store.guard(response);
        for (const id of Object.keys(questions)) {
          const value = judgmentRecord({ request: actual, response, questionId: id, input: judgedInput(work, id), at: new Date().toISOString() });
          await this.store.append('judgments.jsonl', value); answers[id] = value; this.cache.set(value.reuse_key!, value);
        }
        return [];
      } catch (error) {
        const typed = error as { code?: string };
        if (split && typed.code === 'JEV_TOO_LARGE' && Object.keys(questions).length > 1) { const ids = Object.keys(questions); const middle = Math.ceil(ids.length / 2); return [...await send(Object.fromEntries(ids.slice(0, middle).map((id) => [id, questions[id]!])), false), ...await send(Object.fromEntries(ids.slice(middle).map((id) => [id, questions[id]!])), false)]; }
        if (error instanceof Refusal) throw error;
        if(!(error instanceof JevError))throw error;
        const status=error.status;const redirect=status!==null&&status>=300&&status<400;const badQuestion=error.code==='JEV_BAD_REQUEST'&&(status===400||status===422||status===null);const badPlan=error.code==='JEV_BAD_REQUEST'&&!badQuestion;const generated=work.action==='place'||work.action==='calibrate';
        const action=redirect?`服务要求重定向（HTTP ${status}），没有跟随；核对 --base-url`:error.code==='JEV_UNAUTHORIZED'?'密钥被拒；所有者换密钥后重跑':error.code==='JEV_RATE_LIMITED'?`服务限流或过载（HTTP ${status}）；等几秒或 Retry-After 指定时间后重跑`:error.code==='JEV_TOO_LARGE'?(generated?'服务拒收技能生成的题目：超过服务预算；报告集成者核对接口':'请求太大；少放片段后重跑'):error.code==='JEV_BAD_RESPONSE'?'应答未通过校验；核对确切模型版本和服务端后重跑':badQuestion?(generated?`服务拒收技能生成的题目（HTTP ${status??'未发送'}）；报告集成者核对接口`:`服务拒收这道题（HTTP ${status??'未发送'}）；改题后重跑`):badPlan?`端点或账户被拒（HTTP ${status}）；核对 --base-url 或账户`:status!==null?`服务不可用（HTTP ${status}）；对方是否已处理不确定，可能已计费；稍后重跑，已有回答复用`:`${error.message}；稍后重跑，已有回答复用；本地超时或连接中断不证明对方没处理，可能已计费`;
        if(redirect||badPlan||error.code==='JEV_UNAUTHORIZED'||error.code==='JEV_RATE_LIMITED'||error.code==='JEV_BAD_RESPONSE'||error.code==='JEV_UNAVAILABLE')this.stopped=action;
        for(const id of Object.keys(questions))this.failures.set(id,action);
        return Object.keys(questions);
      }
    };
    return { answers, failed: await send(pending, true),oversized };
  }
}
export function questionWork(input: unknown, pieces: Piece[], model: string): Work[] {
  need(record(input) && input.schema === 'jev-ask@1' && record(input.questions), '需要 jev-ask@1 的 pieces 和 questions；按技能合成样例填写');
  const all = Object.fromEntries(pieces.map((p) => [p.id, p.text]));
  const grouped = new Map<string, { state: Record<string, string>; questions: Record<string, JevQuestion>; bindings: Record<string, string[]> }>();
  for (const [id, raw] of Object.entries(input.questions)) {
    need(isQuestionId(id), '题目标识不合格；用字母数字下划线或连字符');
    need(record(raw), `问题 ${id} 必须是对象`);
    // The pieces a question is about are declared by its author, never found in its text: an undeclared or unknown id is
    // a structural problem (owner rule 2026-10-24, sweep A82), not a reason to send every piece with the question.
    const declared = raw.pieces;
    need(
      Array.isArray(declared) && declared.length > 0 && declared.every((key) => typeof key === 'string' && key !== ''),
      `问题 ${id} 缺少显式片段声明 pieces（缺的事实：这道题判断哪些片段；下一步：写成 "pieces": ["<片段 id>"]，id 取自本次 pieces 列表）`,
    );
    const unique = [...new Set(declared as string[])];
    const unknown = unique.filter((key) => !Object.hasOwn(all, key));
    need(unknown.length === 0, `问题 ${id} 声明的片段不在本次 pieces 里：${unknown.join('、')}（下一步：改用本次 pieces 列表里的 id，或补齐该片段后重跑）`);
    const question = checkQuestion(id, Object.fromEntries(Object.entries(raw).filter(([key]) => key !== 'pieces')));
    egressQuestion(question);
    const ids = [...unique].sort(); const key = JSON.stringify(ids);
    const group = grouped.get(key) ?? { state: Object.fromEntries(ids.map((pieceId) => [pieceId, all[pieceId]!])), questions: {}, bindings: {} };
    group.questions[id] = question; group.bindings[id] = ids; grouped.set(key, group);
  }
  need(grouped.size > 0, '至少填写一道题；按 ask 样例重跑');
  const out: Work[] = [];
  for (const group of grouped.values()) {
    const base=estimateTokens(JSON.stringify(group.state))+256;let questions:Record<string,JevQuestion>={};let bindings:Record<string,string[]>={};let tokens=base;
    const close=()=>{if(Object.keys(questions).length)out.push({state:group.state,questions,bindings,pieces:pieces.filter(p=>Object.hasOwn(group.state,p.id))});questions={};bindings={};tokens=base;};
    for(const [id,question]of Object.entries(group.questions)){const cost=estimateTokens(JSON.stringify({[id]:question}))+32;need(base+cost<=24000,'单题和片段超过令牌预算；减少片段或选项说明后重跑');if(Object.keys(questions).length>=10||tokens+cost>48000)close();questions[id]=question;bindings[id]=group.bindings[id]!;tokens+=cost;}close();
  }
  for (const work of out) {checkRequest({model,state:work.state,questions:work.questions},{pinnedModel:model,maxRequestBytes:16*1024*1024});const base=estimateTokens(JSON.stringify(work.state))+256;need(base+estimateTokens(JSON.stringify(work.questions))+32*Object.keys(work.questions).length<=48000&&Object.values(work.questions).every(q=>base+estimateTokens(JSON.stringify(q))+32<=24000),'题目或片段超过令牌预算；减少片段和选项说明后重跑');} return out;
}
