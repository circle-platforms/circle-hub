// A task's page shows one tab at a time (decision 151). Checks that are about what the page says of a task, wherever it
// says it, read every tab through these helpers; checks about one tab ask for that tab.
export const TASK_TAB_QUERIES = ['', 'tab=items', 'tab=requests', 'tab=process', 'tab=sources', 'tab=record'] as const;

/** The path of each tab of a task page, a query the path already has kept. */
export function taskTabPaths(path: string): string[] {
  return TASK_TAB_QUERIES.map((query) => (query === '' ? path : path + (path.includes('?') ? '&' : '?') + query));
}

/** Every tab of a task page as one text, in tab order; the first answer that is not 200 is returned as it is. */
export async function everyTaskTab<T extends { status: number; body: unknown }>(path: string, render: (path: string) => Promise<T>): Promise<{ status: number; body: string }> {
  const bodies: string[] = [];
  for (const each of taskTabPaths(path)) {
    const view = await render(each);
    if (view.status !== 200) return { status: view.status, body: String(view.body) };
    bodies.push(String(view.body));
  }
  return { status: 200, body: bodies.join('\n') };
}
