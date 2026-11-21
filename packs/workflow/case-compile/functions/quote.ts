// Pack-local quotation normalization: no core imports are available inside sandboxed functions.
import { isQuotationWide } from './quote-width.ts';

/** Fold only quotation whitespace; preserve case, punctuation, width and normalization form. */
export function foldText(text:string):string {
  return text.replace(/\p{White_Space}+/gu,(run:string,at:number)=>{
    const end=at+run.length;
    if(at===0||end===text.length)return '';
    const left=Array.from(text.slice(Math.max(0,at-2),at)).at(-1)!;
    const right=String.fromCodePoint(text.codePointAt(end)!);
    return isQuotationWide(left)||isQuotationWide(right)?'':' ';
  });
}
/**
 * A quote is verbatim; display whitespace policies cannot manufacture source evidence. The rule of quoteMatches in hub/rules/text.ts, the
 * one the Hub's quote@1 applies: an exact contiguous substring of well-formed text, and a quote of white space only (Unicode White_Space,
 * the ideographic space among it) never matches, not even a fragment that is the same white space.
 */
export function quoteMatches(fragment:string,quote:string):boolean{return typeof fragment==='string'&&typeof quote==='string'&&quote.isWellFormed()&&/[^\p{White_Space}]/u.test(quote)&&fragment.includes(quote);}
