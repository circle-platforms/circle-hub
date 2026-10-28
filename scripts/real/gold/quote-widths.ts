// Independent strict quotation oracle. No Hub or pack code/data import.

export function goldQuoteHasText(quote: string): boolean {
  return /[^\p{White_Space}]/u.test(quote);
}

export function goldQuoteContains(fragment: string, quote: string): boolean {
  if (typeof fragment !== 'string' || typeof quote !== 'string' || !fragment.isWellFormed() || !quote.isWellFormed()) return false;
  return goldQuoteHasText(quote) && fragment.includes(quote);
}
