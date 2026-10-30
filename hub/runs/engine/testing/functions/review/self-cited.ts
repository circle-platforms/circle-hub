// Synthetic pack check function (toy-review, findings): reads the item's own text from the sources the Hub gives it and
// cites the item's location as the ground of a support, as a function may (round-eight review of the lease work, item 3).

interface Input {
  subject?: { location?: string };
  sources?: Record<string, string>;
}

export default function selfCited(input: unknown): unknown {
  const { subject, sources } = input as Input;
  const location = subject?.location;
  if (location === undefined || sources?.[location] === undefined) {
    return [{ verdict: 'unknown', reason: 'missing_input', missing: '条目原文', statement: '没有拿到条目原文', grounds: [], tier: 'advisory' }];
  }
  return [{ verdict: 'support', statement: '条目原文可读，引用它作根据', grounds: [location], tier: 'advisory' }];
}
