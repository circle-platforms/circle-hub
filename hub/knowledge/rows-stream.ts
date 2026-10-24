// Visit a rows part one JSON row at a time. The envelope digest is checked by records before this parser sees text.
// Native JSON.parse validates each retained token; no whole part graph and no whole part schema clone is retained.
export function visitRowsPart(text: string, consume: (row: unknown) => void): void {
  let at = 0;
  const whitespace = (code: number): boolean => code === 32 || code === 9 || code === 10 || code === 13;
  const space = (): void => { while (whitespace(text.charCodeAt(at))) at++; };
  const stack: number[] = [];
  const stringEnd = (): void => {
    if (text[at++] !== '"') throw new SyntaxError('expected JSON string');
    while (at < text.length) {
      const quote = text.indexOf('"', at);
      if (quote < 0) break;
      let before = quote - 1;
      while (text[before] === '\\') before--;
      at = quote + 1;
      if ((quote - before - 1) % 2 === 0) return;
    }
    throw new SyntaxError('unterminated JSON string');
  };
  const valueEnd = (): void => {
    space();
    if (text[at] === '"') { stringEnd(); return; }
    if (text[at] !== '{' && text[at] !== '[') {
      const start = at;
      while (at < text.length) {
        const code = text.charCodeAt(at);
        if (whitespace(code) || code === 44 || code === 125 || code === 93) break;
        at++;
      }
      if (at === start) throw new SyntaxError('expected JSON value');
      return;
    }
    stack.length = 0;
    do {
      const char = text[at];
      if (char === '"') { stringEnd(); continue; }
      at++;
      if (char === '{') stack.push(125);
      else if (char === '[') stack.push(93);
      else if (char === '}' || char === ']') {
        if (stack.pop() !== char.charCodeAt(0)) throw new SyntaxError('mismatched JSON container');
      }
    } while (stack.length && at < text.length);
    if (stack.length) throw new SyntaxError('unterminated JSON container');
  };
  space();
  if (text[at++] !== '{') throw new SyntaxError('rows part must be an object');
  const spans: Array<{ start: number; end: number; }> = [];
  let hasRows = false;
  space();
  if (text[at] !== '}') for (; ;) {
    space(); const keyStart = at; stringEnd();
    const key: unknown = JSON.parse(text.slice(keyStart, at));
    space(); if (text[at++] !== ':') throw new SyntaxError('expected colon');
    space(); const start = at; valueEnd(); const end = at;
    if (key === 'rows') { spans.push({ start, end }); hasRows = true; }
    else {
      // Unknown top-level keys are refused by the same strict rows-part contract, even when their values are valid JSON.
      JSON.parse(text.slice(start, end));
      throw new SyntaxError('unexpected rows-part member');
    }
    space();
    if (text[at] !== ',') break;
    at++;
  }
  if (text[at++] !== '}') throw new SyntaxError('expected object end');
  space(); if (at !== text.length || !hasRows) throw new SyntaxError('invalid rows part');
  // JSON.parse keeps the last duplicate member. Earlier arrays still have to be valid JSON, but their row shapes do not win.
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index]; at = span.start;
    if (text[at++] !== '[') { JSON.parse(text.slice(span.start, span.end)); if (index === spans.length - 1) throw new SyntaxError('rows must be an array'); continue; }
    space(); let count = 0;
    if (text[at] !== ']') for (; ;) {
      space(); const start = at; valueEnd();
      const row: unknown = JSON.parse(text.slice(start, at));
      if (index === spans.length - 1) consume(row);
      count++;
      space(); if (text[at] !== ',') break;
      at++;
      space(); if (text[at] === ']') throw new SyntaxError('trailing array comma');
    }
    if (text[at++] !== ']') throw new SyntaxError('expected array end');
    if (at !== span.end) throw new SyntaxError('invalid rows array');
    if (index === spans.length - 1 && count === 0) throw new SyntaxError('rows cannot be empty');
  }
}
