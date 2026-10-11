export interface UseCase {
  id: string;
  text: string;
}

/**
 * Split a Markdown use-case collection (`## UC-01 ...` headings, the
 * SMP-V04-01 form) into individual cases. Text before the first heading
 * (titles, coverage notes) is not a case.
 */
export function parseUseCaseMarkdown(md: string): UseCase[] {
  const parts = md.split(/^##\s+(UC-\d+)\b.*$/m);
  const cases: UseCase[] = [];
  for (let i = 1; i + 1 <= parts.length - 1; i += 2) {
    const id = parts[i] as string;
    const body = (parts[i + 1] ?? "").trim();
    cases.push({ id, text: body });
  }
  return cases;
}
