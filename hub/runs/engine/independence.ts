import type {Submission} from '../../../contracts/src/submission.ts';
// Independence (A04) of a judgment from the author of the work it judges, as far as the Hub can tell: the client session ids
// it observed (Circle-Session-Id at start_run and at submit), the model identity each submission declares, and the accounts
// the Hub itself keeps. The author is everyone who produced the work under verification (lineage.ts). A known shared session
// or a declared model family of the same name is not independent (A04 F[2], R[1]).
//
// A family is only what a client declared as `model_family_id` (model-identity@1), compared by exact equality: the Hub never
// derives one from the words of a model name, its case, its width, a version or a hosting prefix (owner rule 2026-10-24,
// sweep A76). Different names therefore do not make two models different families. Without a declared family on both sides
// independence is unknown and stays unknown: nothing is back-filled for an old record, and `independenceGap` names the
// missing declaration and who supplies it. So is a run whose author the Hub does not know (A04 R[5]).
import type { Independence } from '../../../contracts/generated/vocabulary.ts';
import type { IndependenceFinding } from './terminals.ts';

/** Who produced a set of judgments: the sessions observed for it and the model identity it declared. */
export interface ProducerOrigin {
  sessions: (string | null)[];
  /**
   * The exact model id the client declared (`model_id` of model-identity@1), or the model text a submission declared
   * before that shape existed. Kept for records, warrants and display; it never decides independence.
   */
  model: string | null;
  /** The declared model family id (`model_family_id` of model-identity@1); null or absent when none was declared. */
  family?: string | null;
}

/** New declarations are structured inputs; legacy display text never supplies a family. */
export function submissionOrigin(submission:Pick<Submission,'model'|'model_identity'>,sessions:ProducerOrigin['sessions']):ProducerOrigin {
  return {sessions,model:submission.model_identity?.model_id??submission.model,family:submission.model_identity?.model_family_id??null};
}

/** Everyone known to have produced the work a judgment is about: their sessions and declared model identities. */
export interface AuthorOrigin {
  sessions: ReadonlySet<string>;
  models: ReadonlySet<string>;
  /**
   * The family ids those producers declared, and whether every producer of the work declared one. A producer that
   * declared none contributes none: the Hub does not read a family out of its model id, so an incomplete declaration
   * leaves the comparison impossible.
   */
  families?: ReadonlySet<string>;
  familiesComplete?: boolean;
  /** Every producer of that work is known: no unobserved session, no undeclared model, no artifact of unknown origin. */
  complete: boolean;
}

/** A declared family id, or null when there is none. An absent or empty declaration is not a family; no name is read. */
export function declaredFamily(value: string | null | undefined): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/**
 * Whether the judgment is independent of the author of the work it judges, as far as declared identities tell:
 * 'not_independent' on a shared observed session, an exactly equal declared model id or an equal declared family,
 * 'independent' when every identity needed for the comparison is declared and known and none of them matches, 'unknown'
 * otherwise. Only identities the client declared and the Hub observed are compared, each by exact equality.
 */
export function independenceOf(current: ProducerOrigin, author: AuthorOrigin | null): IndependenceFinding {
  if (author === null) return 'unknown';
  const mine = current.sessions.filter((s): s is string => s !== null);
  if (mine.some((s) => author.sessions.has(s))) return 'not_independent';
  // The same declared model id is the same model: one exact comparison of what the client declared, with no folding, no
  // case or width normalization and no word two names happen to share. It can only tighten (never grant independence).
  if (current.model !== null && author.models.has(current.model)) return 'not_independent';
  const family = declaredFamily(current.family);
  // No declared family on this side: there is nothing to compare, and a differing model id proves nothing.
  if (family === null) return 'unknown';
  const theirs = author.families ?? new Set<string>();
  // An author side without a complete family declaration cannot be told apart either.
  if (author.familiesComplete !== true || theirs.size === 0) return 'unknown';
  // The same family with another configuration, version or hosting prefix is not independent (A04 F[2]).
  if (theirs.has(family)) return 'not_independent';
  const known = mine.length > 0 && mine.length === current.sessions.length && author.complete && author.sessions.size > 0 && author.models.size > 0;
  return known ? 'independent' : 'unknown';
}

/**
 * What is missing for a model-family independence and who supplies it: the exit that belongs to an 'unknown' finding, so
 * an unknown is a transition and not a verdict (A04 R[4], owner rule 2026-10-24). Null when the finding does not rest on a
 * missing declaration.
 */
export function independenceGap(current: ProducerOrigin, author: AuthorOrigin | null): { missing: string; next: string } | null {
  const declare = '客户端按 model-identity@1 显式声明 model_id 与 model_family_id，再以同一工作开新修订重跑';
  if (author === null) {
    return { missing: '缺少被判工作的作者来源（没有前驱，或前驱的产出者不可解析）', next: '由运行者以被判工作为 predecessor 开复核运行，或由管理员补齐记录后重开' };
  }
  if (declaredFamily(current.family) === null) {
    return { missing: '本次提交没有声明模型族 model_family_id（只有模型名不足以判断族）', next: `${declare}；不从模型名推族，也不给旧记录补造族` };
  }
  if (author.familiesComplete !== true || (author.families?.size ?? 0) === 0) {
    return { missing: '被判工作的作者没有完整声明模型族 model_family_id', next: `${declare}（由原作者一侧补声明并重产被判工作），再对新修订开复核运行` };
  }
  const mine = current.sessions.filter((s): s is string => s !== null);
  if (mine.length === 0 || mine.length !== current.sessions.length) {
    return { missing: '缺少本次运行的观察会话（有提交没有带 Circle-Session-Id）', next: '由运行者带 Circle-Session-Id 重新提交后重开复核' };
  }
  if (!author.complete) {
    return { missing: '被判工作的产出者不完整（有不可解析的来源或未知出处的产物）', next: '由管理员补齐被判工作的来源记录后重开复核' };
  }
  return null;
}

/** The warrant's independence value for a finding. */
export function warrantIndependence(finding: IndependenceFinding,byAccount=false): Independence {
  if (finding === 'independent') return byAccount?'human_non_author':'model_family_declared';
  if (finding === 'not_independent') return 'not_independent';
  return 'unknown';
}

/** W10 account identity, including Hub-side configured runs and delegated executions. */
export function authorAccount(run:Pick<import('../../../contracts/src/run.ts').RunRecord,'runner'|'configurer'>):string|null{return run.runner??run.configurer??null}
export interface AccountAuthors {accounts:ReadonlySet<string>;complete:boolean}
/**
 * Independence by the accounts the Hub itself keeps (W10, A04 F[0], R[3]): the reviewer's account is none of the author
 * accounts. A client-declared model family never satisfies this (A04 R[4]); an unknown account stays unknown and is not
 * back-filled.
 */
export function accountIndependenceOf(account:string,author:AccountAuthors|null):IndependenceFinding{
 if(author?.accounts.has(account))return 'not_independent';
 return author?.complete&&author.accounts.size>0&&account.length>0?'independent':'unknown';
}
