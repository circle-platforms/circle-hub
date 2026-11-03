// Process-local, bounded maintenance diagnostics. No body text is retained or exposed here.
export const NONCANONICAL_EXPLANATION='正文不是规范写法、内容与摘要一致';
export interface RecordIntegrityNote { record: string; digest: string; explanation: string; readings: number; }
const notes = new Map<string, RecordIntegrityNote>();
let readings = 0; let truncated = false;
export function noteNoncanonical(record: string, digest: string): void {
  noteRecordIntegrity(record,digest,NONCANONICAL_EXPLANATION);
}
/** Trusted integrity incidents retain identifiers and a fixed explanation, never body text. */
export function noteRecordIntegrity(record:string,digest:string,explanation:string):void {
  readings++;
  const key=JSON.stringify([digest,explanation]);
  const previous = notes.get(key);
  if (previous) { previous.readings++; return; }
  if (notes.size >= 1000) { truncated = true; return; }
  notes.set(key, { record, digest, explanation, readings: 1 });
}
/** Trusted maintenance only; a detached snapshot of this process's integrity diagnostics. */
export function recordIntegrityNotes(): { readings: number; entries: RecordIntegrityNote[]; truncated: boolean } {
  return { readings, entries: [...notes.values()].map(note => ({ ...note })), truncated };
}
