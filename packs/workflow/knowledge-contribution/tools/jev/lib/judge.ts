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
export interface Work { state: Record<string, string>; questions: Record<string, JevQuestion>; pieces: Piece[] }
export class Judge {
  stopped:string|null=null;
  attempts=0; sentFragments=new Map<string,string>(); failures=new Map<string,string>(); unanswered=new Map<string,{code:string;estimate:number;message:string}>();
  model: string; client: HttpJev; store: LocalStore; send: string[]; cache = new Map<string, JevJudgmentRecord>();
  constructor(model: string, key: () => string, baseUrl: string | undefined, store: LocalStore, send: string[], options: Partial<HttpJevOptions> = {}) {
    this.model = model; this.store = store; this.send = send;
    this.client = new HttpJev({ ...options, apiKey: key, model, baseUrl, onAttempt: async (event) => {
      this.attempts++;
      const fragments = Object.entries(event.request.state).map(([id, value]) => ({ id, sha256: sha(typeof value === 'string' ? value : JSON.stringify(value)), bytes: Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)), ...this.activePieces.get(id) }));
      for(const fragment of fragments){if(fragment.reference&&fragment.kind)this.sentFragments.set(fragment.reference,fragment.kind);}
      await store.append('requests.jsonl', { at: new Date().toISOString(), request_digest: inputDigest(event.request), fragments, send, questions: Object.keys(event.request.questions), attempts: event.attempt, http_status: event.status, request_id: event.requestId, result: event.result });
    } });
  }
  activePieces = new Map<string, { reference: string; kind: string }>();
  async load() { for (const value of await this.store.records('judgments.jsonl')) if (record(value) && typeof value.reuse_key === 'string' && value.requested_model === this.model && value.returned_model === this.model && value.exact_model === this.model && value.reuse_key === reuseKey({ model: this.model, stateDigest: value.state_digest, question: { type: value.question_type, instructions: value.instructions, ...(value.question_type === 'choice' ? {criteria:Object.fromEntries(value.candidates.map((v:any)=>[v.name,v.description]))} : value.question_type === 'score' ? {criteria:value.candidates.map((v:any)=>v.description)} : {criteria:Object.fromEntries(value.candidates.map((v:any)=>[v.name,v.description]))}) } as JevQuestion })) this.cache.set(value.reuse_key, value as JevJudgmentRecord); }
  async ask(work: Work): Promise<{ answers: Record<string, JevJudgmentRecord>; failed: string[] }> {
    for (const piece of work.pieces) this.activePieces.set(piece.id, { reference: piece.reference, kind: piece.kind });
    const request: JevRequest = { model: this.model, state: work.state, questions: work.questions }; this.store.guard(request);
    for(const question of Object.values(work.questions))egressQuestion(question);
    const checked = checkRequest(request, { pinnedModel: this.model, maxRequestBytes: 16 * 1024 * 1024 });
    const stateTokens = estimateTokens(JSON.stringify(work.state)) + 256;
    const oversized:string[]=[];const eligible:Record<string,JevQuestion>={};
    for(const [id,q] of Object.entries(work.questions)){const estimate=stateTokens+estimateTokens(JSON.stringify(q))+32;if(estimate>24000){const message=`${id}：片段和节点选项估算 ${estimate} 令牌，超过单题 24,000 上限，没有提问；下一步拆分该条目或从 --pieces 去掉；选项过多时缩小节点或选项说明`;this.failures.set(id,message);this.unanswered.set(id,{code:'oversized',estimate,message});oversized.push(id);}else eligible[id]=q;}
    need(Object.keys(eligible).length<=10&&stateTokens+estimateTokens(JSON.stringify(eligible))+32*Object.keys(eligible).length<=48000||Object.keys(eligible).length===0,'整批超过 48,000 令牌；拆成更小批次重跑');
    const stateDigest = inputDigest(work.state); const answers: Record<string, JevJudgmentRecord> = {}; const pending: Record<string, JevQuestion> = {};
    for (const [id, question] of Object.entries(eligible)) { const key = reuseKey({ model: this.model, question, stateDigest })!; const old = this.cache.get(key); if (old) answers[id] = old; else pending[id] = question; }
    if (Object.keys(pending).length === 0) return { answers, failed: oversized };
    if(this.stopped){for(const id of Object.keys(pending))this.failures.set(id,this.stopped);return {answers,failed:[...oversized,...Object.keys(pending)]};}
    const send = async (questions: Record<string, JevQuestion>, split: boolean): Promise<string[]> => {
      const actual = { ...checked.request, questions };
      try {
        const response = await this.client.ask(actual); this.store.guard(response);
        for (const id of Object.keys(questions)) {
          const references = [...questions[id]!.instructions.matchAll(/`([A-Za-z0-9_-]+)(?:[^`]*)`/g)].map((m) => m[1]!); const piece = references.find((key) => Object.hasOwn(work.state, key));
          const value = judgmentRecord({ request: actual, response, questionId: id, input: piece ? work.state[piece] : work.state, at: new Date().toISOString() });
          await this.store.append('judgments.jsonl', value); answers[id] = value; this.cache.set(value.reuse_key!, value);
        }
        return [];
      } catch (error) {
        const typed = error as { code?: string };
        if (split && typed.code === 'JEV_TOO_LARGE' && Object.keys(questions).length > 1) { const ids = Object.keys(questions); const middle = Math.ceil(ids.length / 2); return [...await send(Object.fromEntries(ids.slice(0, middle).map((id) => [id, questions[id]!])), false), ...await send(Object.fromEntries(ids.slice(middle).map((id) => [id, questions[id]!])), false)]; }
        if (error instanceof Refusal) throw error;
        if(!(error instanceof JevError))throw error;
        const status=error.status;const badQuestion=error.code==='JEV_BAD_REQUEST'&&(status===400||status===422||status===null);const badPlan=error.code==='JEV_BAD_REQUEST'&&!badQuestion;
        const action=error.code==='JEV_UNAUTHORIZED'?'密钥被拒；所有者换密钥后重跑':error.code==='JEV_RATE_LIMITED'?'服务限流；等几秒或 Retry-After 指定时间后重跑':error.code==='JEV_TOO_LARGE'?'请求太大；少放片段后重跑':error.code==='JEV_BAD_RESPONSE'?'应答未通过校验；核对确切模型版本和服务端后重跑':badQuestion?`服务拒收这道题（HTTP ${status??'未发送'}）；改题后重跑`:badPlan?`端点或账户被拒（HTTP ${status}）；核对 --base-url 或账户`:status!==null?`服务不可用（HTTP ${status}），对方未处理；稍后重跑，已有回答复用`:`${error.message}；稍后重跑，已有回答复用；本地超时或连接中断不证明对方没处理，可能已计费`;
        if(badPlan||error.code==='JEV_UNAUTHORIZED'||error.code==='JEV_RATE_LIMITED'||error.code==='JEV_BAD_RESPONSE'||error.code==='JEV_UNAVAILABLE')this.stopped=action;
        for(const id of Object.keys(questions))this.failures.set(id,action);
        return Object.keys(questions);
      }
    };
    return { answers, failed: [...oversized,...await send(pending, true)] };
  }
}
export function questionWork(input: unknown, pieces: Piece[], model: string): Work[] {
  need(record(input) && input.schema === 'jev-ask@1' && record(input.questions), '需要 jev-ask@1 的 pieces 和 questions；按技能合成样例填写');
  const all = Object.fromEntries(pieces.map((p) => [p.id, p.text])); const grouped = new Map<string, { state: Record<string, string>; questions: Record<string, JevQuestion> }>();
  for (const [id, raw] of Object.entries(input.questions)) {
    need(isQuestionId(id), '题目标识不合格；用字母数字下划线或连字符'); const question = checkQuestion(id, raw);
    egressQuestion(question);
    const refs = [...JSON.stringify(question).matchAll(/`([^`]+)`/g)].map((m) => m[1]!.split(/[.\[]/)[0]!).filter((key) => Object.hasOwn(all, key));
    const ids = refs.length ? [...new Set(refs)].sort() : Object.keys(all); const key = JSON.stringify(ids); const group = grouped.get(key) ?? { state: Object.fromEntries(ids.map((key) => [key, all[key]!])), questions: {} }; group.questions[id] = question; grouped.set(key, group);
  }
  need(grouped.size > 0, '至少填写一道题；按 ask 样例重跑');
  const out: Work[] = [];
  for (const group of grouped.values()) {
    const base=estimateTokens(JSON.stringify(group.state))+256;let questions:Record<string,JevQuestion>={};let tokens=base;
    const close=()=>{if(Object.keys(questions).length)out.push({state:group.state,questions,pieces:pieces.filter(p=>Object.hasOwn(group.state,p.id))});questions={};tokens=base;};
    for(const [id,question]of Object.entries(group.questions)){const cost=estimateTokens(JSON.stringify({[id]:question}))+32;need(base+cost<=24000,'单题和片段超过令牌预算；减少片段或选项说明后重跑');if(Object.keys(questions).length>=10||tokens+cost>48000)close();questions[id]=question;tokens+=cost;}close();
  }
  for (const work of out) {checkRequest({model,state:work.state,questions:work.questions},{pinnedModel:model,maxRequestBytes:16*1024*1024});const base=estimateTokens(JSON.stringify(work.state))+256;need(base+estimateTokens(JSON.stringify(work.questions))+32*Object.keys(work.questions).length<=48000&&Object.values(work.questions).every(q=>base+estimateTokens(JSON.stringify(q))+32<=24000),'题目或片段超过令牌预算；减少片段和选项说明后重跑');} return out;
}
