// Synthetic system pack (tests only): a read of two answers and one nested read; the projection copies every view it is given
// into the content, so a test sees what a function is told of an answer held from it.
type Input = { responses: Record<string, unknown>; reads: Record<string, unknown> };

export function sidePlan(): unknown {
  return { requests: [{ key: 'main', route: 'one' }, { key: 'side', route: 'two' }], reads: [{ external: 'fixture:other:held' }], done: true };
}

export function sideProject(input: unknown): unknown {
  const { responses, reads } = input as Input;
  return { artifacts: [{ name: 'content', media_type: 'application/json', json: { responses, reads } }] };
}
