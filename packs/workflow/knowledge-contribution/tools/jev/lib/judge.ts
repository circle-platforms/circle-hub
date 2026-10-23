import { HttpJev, type HttpJevOptions } from './http.ts';
import { checkRequest, checkQuestion, isQuestionId } from './validate.ts';
import { estimateTokens } from './tokens.ts';
import { judgmentRecord, inputDigest, reuseKey, type JevJudgmentRecord, type JevQuestion, type JevRequest } from './api.ts';
import { need, record, sha, Refusal, type LocalStore } from './local.ts';
import type { Piece } from './hub.ts';
export interface Work { state: Record<string, string>; questions: Record<string, JevQuestion>; pieces: Piece[] }
export class Judge {
  model: string; client: HttpJev; store: LocalStore; send: string[]; cache = new Map<string, JevJudgmentRecord>();
  constructor(model: string, key: () => string, baseUrl: string | undefined, store: LocalStore, send: string[], options: Partial<HttpJevOptions> = {}) {
    this.model = model; this.store = store; this.send = send;
    this.client = new HttpJev({ ...options, apiKey: key, model, baseUrl, onAttempt: async (event) => {
      const fragments = Object.entries(event.request.state).map(([id, value]) => ({ id, sha256: sha(typeof value === 'string' ? value : JSON.stringify(value)), bytes: Buffer.byteLength(typeof value === 'string' ? value : JSON.stringify(value)), ...this.activePieces.get(id) }));
      await store.append('requests.jsonl', { at: new Date().toISOString(), request_digest: inputDigest(event.request), fragments, send, questions: Object.keys(event.request.questions), attempts: event.attempt, http_status: event.status, request_id: event.requestId, result: event.result });
    } });
  }
  activePieces = new Map<string, { reference: string; kind: string }>();
  async load() { for (const value of await this.store.records('judgments.jsonl')) if (record(value) && typeof value.reuse_key === 'string' && value.requested_model === this.model && value.returned_model === this.model && value.exact_model === this.model && value.reuse_key === reuseKey({ model: this.model, stateDigest: value.state_digest, question: { type: value.question_type, instructions: value.instructions, ...(value.question_type === 'choice' ? {criteria:Object.fromEntries(value.candidates.map((v:any)=>[v.name,v.description]))} : value.question_type === 'score' ? {criteria:value.candidates.map((v:any)=>v.description)} : {criteria:Object.fromEntries(value.candidates.map((v:any)=>[v.name,v.description]))}) } as JevQuestion })) this.cache.set(value.reuse_key, value as JevJudgmentRecord); }
  async ask(work: Work): Promise<{ answers: Record<string, JevJudgmentRecord>; failed: string[] }> {
    for (const piece of work.pieces) this.activePieces.set(piece.id, { reference: piece.reference, kind: piece.kind });
    const request: JevRequest = { model: this.model, state: work.state, questions: work.questions }; this.store.guard(request);
    const checked = checkRequest(request, { pinnedModel: this.model, maxRequestBytes: 16 * 1024 * 1024 });
    const stateTokens = estimateTokens(JSON.stringify(work.state)) + 256;
    need(Object.keys(work.questions).length <= 10 && stateTokens + estimateTokens(JSON.stringify(work.questions)) + 32 * Object.keys(work.questions).length <= 48_000 && Object.values(work.questions).every((q) => stateTokens + estimateTokens(JSON.stringify(q)) + 32 <= 24_000), '片段或题目太大；减少片段后重跑');
    const stateDigest = inputDigest(work.state); const answers: Record<string, JevJudgmentRecord> = {}; const pending: Record<string, JevQuestion> = {};
    for (const [id, question] of Object.entries(work.questions)) { const key = reuseKey({ model: this.model, question, stateDigest })!; const old = this.cache.get(key); if (old) answers[id] = old; else pending[id] = question; }
    if (Object.keys(pending).length === 0) return { answers, failed: [] };
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
        const code = record(error) ? error.code : null; // Error properties are read directly below.
        const typed = error as { code?: string };
        if (split && typed.code === 'JEV_TOO_LARGE' && Object.keys(questions).length > 1) { const ids = Object.keys(questions); const middle = Math.ceil(ids.length / 2); return [...await send(Object.fromEntries(ids.slice(0, middle).map((id) => [id, questions[id]!])), false), ...await send(Object.fromEntries(ids.slice(middle).map((id) => [id, questions[id]!])), false)]; }
        if (error instanceof Refusal) throw error;
        return Object.keys(questions);
      }
    };
    return { answers, failed: await send(pending, true) };
  }
}
export function questionWork(input: unknown, pieces: Piece[], model: string): Work[] {
  need(record(input) && input.schema === 'jev-ask@1' && record(input.questions), '需要 jev-ask@1 的 pieces 和 questions；按技能合成样例填写');
  const all = Object.fromEntries(pieces.map((p) => [p.id, p.text])); const grouped = new Map<string, { state: Record<string, string>; questions: Record<string, JevQuestion> }>();
  for (const [id, raw] of Object.entries(input.questions)) {
    need(isQuestionId(id), '题目标识不合格；用字母数字下划线或连字符'); const question = checkQuestion(id, raw);
    need(Array.from(question.instructions).length <= 2000, 'instructions 超过 2000 字；缩短问题，不能夹带受限正文');
    if (question.type === 'choice') need(Object.values(question.criteria).every((v) => v === null || Array.from(v).length <= 160), '选项说明超过 160 字；缩短说明');
    const refs = [...question.instructions.matchAll(/`([^`]+)`/g)].map((m) => m[1]!.split(/[.\[]/)[0]!).filter((key) => Object.hasOwn(all, key));
    const ids = refs.length ? [...new Set(refs)].sort() : Object.keys(all); const key = JSON.stringify(ids); const group = grouped.get(key) ?? { state: Object.fromEntries(ids.map((key) => [key, all[key]!])), questions: {} }; group.questions[id] = question; grouped.set(key, group);
  }
  need(grouped.size > 0, '至少填写一道题；按 ask 样例重跑');
  const out: Work[] = [];
  for (const group of grouped.values()) { const ids = Object.keys(group.questions); for (let i = 0; i < ids.length; i += 10) out.push({ state: group.state, questions: Object.fromEntries(ids.slice(i, i + 10).map((id) => [id, group.questions[id]!])), pieces: pieces.filter((p) => Object.hasOwn(group.state, p.id)) }); }
  for (const work of out) checkRequest({model,state:work.state,questions:work.questions},{pinnedModel:model,maxRequestBytes:16*1024*1024}); return out;
}
