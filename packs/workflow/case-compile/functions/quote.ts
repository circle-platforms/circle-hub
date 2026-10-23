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
export function quoteMatches(fragment:string,quote:string):boolean {
  if(!quote.isWellFormed())return false;
  const text=foldText(quote);
  return text.length>0&&foldText(fragment).includes(text);
}
