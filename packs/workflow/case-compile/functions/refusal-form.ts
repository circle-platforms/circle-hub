// The shared form of a refusal the program can decide (owner's rule, 2026-11-17): what is wrong, where it sits, the value that was
// seen, the allowed set when the rule has a closed one, and the next step. A refusal written by hand leaves one of these out and
// sends a writer to the tool's source (round 36: the recomposition refusals, the frozen-run refusal and the unknown-field refusal
// each did). Pure TypeScript with no imports, so the Hub's check functions use it as the local tools do.

/**
 * Where the plan's data sits in the plan file: the one requirement of slots.schema.json (plan) holds exactly one statement, and the
 * statement holds the data. The structure refusals of the slot record use pointers that start here, so every refusal about the
 * plan names its place the same way. A literal, not read from the schema: this module is imported by the projection function of
 * the run, which should not load the schema for a pointer; refusal-form.test.ts ties the literal to the schema.
 */
export const PLAN_DATA='/slots/plan/0/data';

/** The most entries of a closed set that a refusal prints; the rest is counted, never dropped silently. */
export const LISTED_LIMIT=12;
/** The longest a value read from the plan is shown, in characters. */
export const SHOWN_LIMIT=120;

export interface RefusalForm {
 /** What is wrong, one clause. */
 what:string;
 /** Where the fault sits: a JSON Pointer into the file the writer edits, or the name of an input. Left out when the caller's own pointer already shows it. */
 place?:string;
 /** The value found there, as {@link shownValue} writes it. */
 seen?:string;
 /** The closed set the value had to come from. Left out when the set is open. */
 allowed?:readonly string[];
 /** Anything else the program knows that the writer needs, one clause each (the values to copy, where they are disclosed). */
 also?:readonly string[];
 /** What the writer does next. */
 next:string;
}

/** A closed set for a refusal: in full up to the limit, then counted. */
export function listed(values:readonly string[],limit:number=LISTED_LIMIT):string{
 if(!values.length)return '无';
 return values.slice(0,limit).join('、')+(values.length>limit?`…（共 ${values.length} 个）`:'');
}

/** A value the way the writer wrote it (strings quoted, objects as JSON), clipped when long; an absent value is said to be absent. */
export function shownValue(value:unknown):string{
 if(value===undefined)return '没有';
 const text=JSON.stringify(value)??String(value);
 return [...text].length>SHOWN_LIMIT?[...text].slice(0,SHOWN_LIMIT-1).join('')+'…':text;
}

/** The text of a refusal: what, place, seen, allowed, the rest, next step; each part one clause, joined by 「；」. */
export function refusalText(form:RefusalForm):string{
 return [
  form.what,
  ...(form.place!==undefined?[`位置：${form.place}`]:[]),
  ...(form.seen!==undefined?[`看到：${form.seen}`]:[]),
  ...(form.allowed!==undefined?[`允许：${listed(form.allowed)}`]:[]),
  ...(form.also??[]),
  `下一步：${form.next}`,
 ].join('；');
}
