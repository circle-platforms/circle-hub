// The masking dictionary's store (B02 R[11], decision 159, issue 194 step two). Like a resource or a named variable, the
// dictionary is content-addressed canonical JSON in the object store, put in force by a resource-configuration decision
// bound to its digest: every change is a new definition and a new decision, the history is the chain of decisions, and no
// table is added. Only an administrator changes it. What it replaces in a business system's answer is decided where the
// answer is read (hub/connectors); this file only keeps the rules and hands out the compiled dictionary.
import { MASKING_DICTIONARY_SCHEMA, MaskingDictionary, MaskingRuleError, checkMaskingRule, compileMasking, MAX_MASKING_RULES, type CompiledMasking, type MaskingCount, type MaskingRule } from '../../contracts/src/masking.ts';
import type { AuthorizationRecord, Authorizations, ObjectStore, Principal, Principals } from './api.ts';
import { canonicalBytes } from './canonical.ts';
import { parseStrictJson } from './strict-json.ts';
import { AccessError, IntegrityError } from './errors.ts';
import { validateChangeReason } from './variables.ts';
import { WHOLE_HUB } from './constants.ts';

/** The one object of the decisions that put a dictionary in force (`resource_config`, the whole Hub). */
export const MASKING_DICTIONARY_KEY = 'masking-dictionary';
/** How long the serving process uses a compiled dictionary before it looks for a newer decision: a change made from the command line reaches the server within this time. */
export const MASKING_REFRESH_MS = 2000;

export interface MaskingPorts {
  objects: Pick<ObjectStore, 'get' | 'put'>;
  principals: Pick<Principals, 'get'>;
  authorizations: Pick<Authorizations, 'configureResource' | 'latest'>;
  now?: () => Date;
}
export interface MaskingState {
  rules: MaskingRule[];
  /** The decision in force, null before the first rule was ever set. */
  decision: AuthorizationRecord | null;
}

export class MaskingRules {
  readonly #p: MaskingPorts;
  readonly #now: () => Date;
  #cached: { at: number; decision: string | null; compiled: CompiledMasking } | null = null;
  constructor(ports: MaskingPorts) { this.#p = ports; this.#now = ports.now ?? (() => new Date()); }

  async #admin(by: Principal): Promise<void> {
    const actual = await this.#p.principals.get(by.id);
    if (!actual || actual.disabled || actual.role !== 'admin') throw new AccessError('只有管理员可以查看或修改遮盖字典');
  }

  async #read(): Promise<MaskingState> {
    const decision = await this.#p.authorizations.latest('resource_config', WHOLE_HUB, MASKING_DICTIONARY_KEY);
    if (decision === null) return { rules: [], decision: null };
    if (decision.body.revoked) return { rules: [], decision };
    if (!decision.body.bound) throw new IntegrityError('遮盖字典的决定缺少绑定内容');
    const bytes = await this.#p.objects.get(decision.body.bound);
    if (!bytes) throw new IntegrityError('遮盖字典的决定绑定的对象不可读');
    const parsed = MaskingDictionary.safeParse(parseStrictJson(Buffer.from(bytes).toString('utf8')));
    if (!parsed.success) throw new IntegrityError('遮盖字典的绑定内容不合记录模式');
    return { rules: parsed.data.rules, decision };
  }

  /** The rules in force, for an administrator. */
  async list(by: Principal): Promise<MaskingState> { await this.#admin(by); return this.#read(); }

  async #write(by: Principal, rules: MaskingRule[], reason: string): Promise<MaskingState> {
    const dictionary = MaskingDictionary.safeParse({ schema: MASKING_DICTIONARY_SCHEMA, rules });
    if (!dictionary.success) throw new MaskingRuleError(dictionary.error.issues[0]?.message ?? '遮盖字典不合格式');
    const stored = await this.#p.objects.put(canonicalBytes(dictionary.data), 'application/json');
    const decision = await this.#p.authorizations.configureResource(by, MASKING_DICTIONARY_KEY, stored.sha256, reason);
    this.#cached = null;
    return { rules: dictionary.data.rules, decision };
  }

  /** Adds a rule, or replaces the rule of the same name where it stands. The rule is checked before anything is written. */
  async set(by: Principal, input: unknown, reason: string): Promise<MaskingState & { created: boolean }> {
    await this.#admin(by);
    const rule = checkMaskingRule(input);
    reason = validateChangeReason(reason);
    const current = (await this.#read()).rules, at = current.findIndex((existing) => existing.name === rule.name);
    if (at < 0 && current.length >= MAX_MASKING_RULES) throw new MaskingRuleError(`规则至多 ${MAX_MASKING_RULES} 条；先删除不用的规则`);
    const rules = at < 0 ? [...current, rule] : current.map((existing, index) => (index === at ? rule : existing));
    return { ...(await this.#write(by, rules, reason)), created: at < 0 };
  }

  async remove(by: Principal, name: string, reason: string): Promise<MaskingState> {
    await this.#admin(by);
    reason = validateChangeReason(reason);
    const current = (await this.#read()).rules;
    if (!current.some((rule) => rule.name === name)) throw new MaskingRuleError(`没有名为 ${String(name).slice(0, 80)} 的规则`);
    return this.#write(by, current.filter((rule) => rule.name !== name), reason);
  }

  /**
   * The dictionary compiled, for the reader of a business system. It is looked up again after MASKING_REFRESH_MS, by the
   * digest of the decision in force, so a serving process picks up a change made by another process (the command line)
   * without compiling on every answer.
   */
  async compiled(): Promise<{ masking: CompiledMasking; dictionary: string | null }> {
    const at = this.#now().getTime();
    if (this.#cached !== null && at - this.#cached.at < MASKING_REFRESH_MS && at >= this.#cached.at) return { masking: this.#cached.compiled, dictionary: this.#cached.decision };
    const decision = await this.#p.authorizations.latest('resource_config', WHOLE_HUB, MASKING_DICTIONARY_KEY);
    const digest = decision === null || decision.body.revoked ? null : decision.body.bound;
    if (this.#cached !== null && this.#cached.decision === digest) { this.#cached.at = at; return { masking: this.#cached.compiled, dictionary: digest }; }
    const state = digest === null ? { rules: [] } : await this.#read();
    const compiled = compileMasking(state.rules.length === 0 ? null : { schema: MASKING_DICTIONARY_SCHEMA, rules: state.rules });
    this.#cached = { at, decision: digest, compiled };
    return { masking: compiled, dictionary: digest };
  }
}

export { MaskingRuleError };
export type { MaskingCount, MaskingRule };
