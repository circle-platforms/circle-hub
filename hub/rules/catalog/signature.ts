// Matching arguments against the overloads of a catalog entry. Each signature is solved by dynamic programming over
// (argument, parameter), where optional parameters may be skipped; the cheapest assignment wins (an out-of-range value costs
// less than a value of the wrong type), ties go to the overload declared first. No assignment at all is an arity mismatch.
import type { CatalogEntry, CatalogParam, CatalogSignature } from '../../../contracts/src/tables.ts';
import { checkParam, type ParamCheck, type ParamProblem } from './params.ts';

export interface ArgumentBinding {
  param: string;
  value?: string;
  /** The argument was omitted; `default` is what the source documents for it. */
  omitted?: boolean;
  default?: string;
}

export interface ArgumentViolation {
  param: string;
  /** 1-based position of the argument after the head. */
  position: number;
  value: string;
  code: ParamProblem;
  expected: string;
}

export interface SignatureMatch {
  signature: CatalogSignature;
  /** 1-based position of the overload in the entry. */
  overload: number;
  cost: number;
  unchecked:Array<{param:string;position:number;constraint:NonNullable<CatalogParam['unchecked_constraints']>[number]}>;
  violations: ArgumentViolation[];
  bindings: ArgumentBinding[];
}

export type SignatureResult =
  | { kind: 'match'; best: SignatureMatch }
  | { kind: 'unchecked'; best: SignatureMatch; missing:string; exit:{next_action:string;audience:string;due:string} }
  | { kind: 'violations'; best: SignatureMatch }
  | { kind: 'arity'; arities: { min: number; max: number }[] };

const NO_ARGUMENTS: CatalogSignature = { id: 'no-arguments', params: [] };

function solve(signature: CatalogSignature, overload: number, args: readonly string[], fold: boolean): SignatureMatch | undefined {
  const params: CatalogParam[] = signature.params;
  const m = args.length;
  const n = params.length;
  // Every argument needs its own parameter: more arguments than parameters can never match (and bounds the work).
  if (m > n) return undefined;
  const optionalFrom = new Array<boolean>(n + 1).fill(true);
  for (let j = n - 1; j >= 0; j--) optionalFrom[j] = optionalFrom[j + 1] && params[j].optional === true;
  const memo = new Map<number, number>();
  const pick = new Map<number, 'take' | 'skip'>();
  const checks = new Map<number, ParamCheck>();
  const check = (i: number, j: number): ParamCheck => {
    const key = i * (n + 1) + j;
    let result = checks.get(key);
    if (!result) {
      result = checkParam(params[j], args[i], fold);
      checks.set(key, result);
    }
    return result;
  };
  const cost = (i: number, j: number): number => {
    if (j === n) return i === m ? 0 : Number.POSITIVE_INFINITY;
    if (i === m) return optionalFrom[j] ? params.slice(j).filter(param=>(param.type===undefined||param.default!==undefined)&&param.unchecked_constraints?.length).length/(n+1) : Number.POSITIVE_INFINITY;
    const key = i * (n + 1) + j;
    const known = memo.get(key);
    if (known !== undefined) return known;
    const c = check(i, j);
    const own = c.ok ? (params[j].unchecked_constraints?.length?1/(n+1):0) : c.code === 'core.catalog.param_out_of_range' ? 1 : 2;
    let best = own + cost(i + 1, j + 1);
    let choice: 'take' | 'skip' = 'take';
    if (params[j].optional === true) {
      const skip = cost(i, j + 1);
      if (skip < best) {
        best = skip;
        choice = 'skip';
      }
    }
    memo.set(key, best);
    pick.set(key, choice);
    return best;
  };
  const total = cost(0, 0);
  if (!Number.isFinite(total)) return undefined;
  const bindings: ArgumentBinding[] = [];
  const violations: ArgumentViolation[] = [];
  const unchecked:SignatureMatch['unchecked']=[];
  let i = 0;
  for (let j = 0; j < n; j++) {
    const p = params[j];
    if (i < m && pick.get(i * (n + 1) + j) === 'take') {
      bindings.push({ param: p.name, value: args[i] });
      const c = check(i, j);
      if (!c.ok) violations.push({ param: p.name, position: i + 1, value: args[i], code: c.code, expected: c.expected });
      for(const constraint of p.unchecked_constraints??[])unchecked.push({param:p.name,position:i+1,constraint});
      i += 1;
    } else {
      if(p.type===undefined||p.default!==undefined)for(const constraint of p.unchecked_constraints??[])unchecked.push({param:p.name,position:j+1,constraint});
      bindings.push({ param: p.name, omitted: true, ...(p.default !== undefined ? { default: p.default } : {}) });
    }
  }
  return { signature, overload, cost: total, violations, bindings, unchecked };
}

export function matchSignatures(entry: CatalogEntry, args: readonly string[], fold: boolean): SignatureResult {
  const signatures = entry.signatures.length > 0 ? entry.signatures : [NO_ARGUMENTS];
  let best: SignatureMatch | undefined;
  signatures.forEach((signature, index) => {
    const found = solve(signature, index + 1, args, fold);
    if (found && (!best || found.cost < best.cost)) best = found;
  });
  if (!best) {
    return { kind: 'arity', arities: signatures.map((s) => ({ min: s.params.filter((p) => p.optional !== true).length, max: s.params.length })) };
  }
  return best.violations.length>0?{kind:'violations',best}:best.unchecked.length>0?{kind:'unchecked',best,missing:[...new Set(best.unchecked.map(g=>g.constraint.missing))].join('；'),exit:{next_action:[...new Set(best.unchecked.map(g=>g.constraint.next_action))].join('；'),audience:'包作者',due:'补结构化类型并重产之前'}}:{kind:'match',best};
}
