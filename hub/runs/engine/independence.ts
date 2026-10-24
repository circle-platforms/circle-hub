// Independence (A04) of a judgment from the author of the work it judges, as far as the Hub can tell: the client session ids it
// observed (Circle-Session-Id at start_run and at submit) and the model each submission declares. The author is everyone who
// produced the work under verification (lineage.ts). A known shared session or a model of the same family is not independent
// (A04 F[2], R[1]); every session and model known and told apart is independent, declared by the client (model_family_declared);
// anything else is unknown, and so is a run whose author the Hub does not know (A04 R[5]).
import type { Independence } from '../../../contracts/generated/vocabulary.ts';
import type { IndependenceFinding } from './terminals.ts';

/** Who produced a set of judgments: the sessions observed for it and the model it declared (null when unknown). */
export interface ProducerOrigin {
  sessions: (string | null)[];
  model: string | null;
}

/** Everyone known to have produced the work a judgment is about: their sessions and declared models. */
export interface AuthorOrigin {
  sessions: ReadonlySet<string>;
  models: ReadonlySet<string>;
  /** Every producer of that work is known: no unobserved session, no undeclared model, no artifact of unknown origin. */
  complete: boolean;
}

/** The declared model's name: the text before any configuration, without case or width differences. */
export function modelFamily(model: string): string {
  return (model.normalize('NFKC').trim().split(/\s+/u)[0] ?? '').toLowerCase();
}

/** The words of a declared model's name: runs of two or more letters. Versions, dates and single letters are not words. */
export function familyWords(model: string): string[] {
  return [...new Set(modelFamily(model).match(/\p{L}{2,}/gu) ?? [])];
}

/**
 * Whether two declared models belong to one family (A04 F[2]: the same family with another configuration is not independent).
 * The contracts give no declared family, so the Hub compares names conservatively: one family when the names share a word (a
 * dated alias, another version or a hosting prefix of the same model), two when both have words and share none, null when a
 * name has no word to compare (the Hub cannot tell them apart).
 */
export function sameModelFamily(a: string, b: string): boolean | null {
  const left = familyWords(a);
  const right = new Set(familyWords(b));
  if (left.length === 0 || right.size === 0) return null;
  return left.some((word) => right.has(word));
}

export function independenceOf(current: ProducerOrigin, author: AuthorOrigin | null): IndependenceFinding {
  if (author === null) return 'unknown';
  const mine = current.sessions.filter((s): s is string => s !== null);
  if (mine.some((s) => author.sessions.has(s))) return 'not_independent';
  let toldApart = current.model !== null;
  if (current.model !== null) {
    for (const model of author.models) {
      const same = sameModelFamily(current.model, model);
      if (same === true) return 'not_independent';
      if (same === null) toldApart = false;
    }
  }
  const known = mine.length > 0 && mine.length === current.sessions.length && toldApart && author.complete && author.sessions.size > 0 && author.models.size > 0;
  return known ? 'independent' : 'unknown';
}

/** The warrant's independence value for a finding. */
export function warrantIndependence(finding: IndependenceFinding,byAccount=false): Independence {
  if (finding === 'independent') return byAccount?'human_non_author':'model_family_declared';
  if (finding === 'not_independent') return 'not_independent';
  return 'unknown';
}

/** W10 account identity, including Hub-side configured runs and delegated executions. */
export function authorAccount(run:Pick<import('../../../contracts/src/run.ts').RunRecord,'runner'|'configurer'>):string|null{return run.runner??run.configurer??null;}
export interface AccountAuthors {accounts:ReadonlySet<string>;complete:boolean}
export function accountIndependenceOf(account:string,author:AccountAuthors|null):IndependenceFinding{
 if(author?.accounts.has(account))return 'not_independent';
 return author?.complete&&author.accounts.size>0&&account.length>0?'independent':'unknown';
}
