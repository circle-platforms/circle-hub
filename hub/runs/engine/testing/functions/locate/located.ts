// Synthetic pack check function (toy-locate, a fact-only pack): reports where a case sits as the data of a support outcome.

interface Subject {
  item?: string;
  fields?: { path?: string[]; document?: string };
  location?: string;
}

export default function located(input: unknown): unknown {
  const subject = ((input as { subject?: Subject }).subject ?? {}) as Subject;
  const path = subject.fields?.path ?? [];
  if (path.length < 2) return [{ verdict: 'unknown', missing: '用例上级分组的路径', reason: 'missing_input', statement: '用例上面没有分组，定位不出', grounds: subject.location ? [subject.location] : [], tier: 'advisory' }];
  return [{ verdict: 'support', statement: `用例在 ${path.slice(1).join(' / ')} 下`, grounds: subject.location ? [subject.location] : [], tier: 'advisory', data: { document: subject.fields?.document ?? null, group: path[path.length - 1] } }];
}
