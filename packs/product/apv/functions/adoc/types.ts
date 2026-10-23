// Intermediate package-local data only. This is not the K1 document model or a registered producer output.
export interface SourceFile { text: string; revision: string; sha256: string }
export interface AdocInput { main: string; revision: string; files: Record<string, SourceFile>; attributes?: Record<string, string | boolean> }
export interface Limits { files: number; inputBytes: number; expandedBytes: number; includeDepth: number; includes: number; lines: number; conditions: number; blocks: number }
export interface MappedLine { file: string; line: number; text: string }
export interface VerifiedRange { file: string; from: number; to: number; selector: string; reference: string; verbatim: string }
export interface Section { level: number; title: string; id: string | null }
export interface Block {
  kind: string; level: number; title: string | null; id: string | null; role: string | null;
  path: Section[]; raw: string; expanded: string; origin: VerifiedRange | null; origins: VerifiedRange[];
  /** The line the engine reported for this block: a candidate only, `origins` is what was verified against the original. */
  reportedLine: number | null;
  /** Why this block has no verified origin ('' when it has one, or has no text of its own to verify). */
  unverifiedReason: string;
  /** For a list item, the index in `blocks` of the list container it belongs to; null for every other block. */
  listAt: number | null;
  rows?: Record<string, Array<Array<{ raw: string; expanded: string; origins: VerifiedRange[] }>>>;
}
export interface SourceRange { file: string; from: number; to: number; lines: number }
export interface Condition {
  id: number; directive: string; file: string; line: number; retained: boolean; parent: number | null;
  removed: SourceRange[]; removed_lines: number;
}
export interface Report {
  files: Array<{ file: string; nul_bytes: number; utf8_bom_bytes?: number; crlf: number; lf: number; cr: number }>;
  unused_files: string[]; conditions: Condition[];
  unverified_count: number; unverified_examples_truncated: boolean;
  unverified: Array<{ block: number; kind: string; reported_line: number | null; reason: string; next_action: string }>;
  /** Blocks and cells whose text sits on more than one candidate line: the engine's own cursor chose the cited line. */
  disambiguated_count: number; disambiguated_examples_truncated: boolean;
  disambiguated: Array<{ block: number; kind: string; reported_line: number | null; candidates: number }>;
  remapped: Array<{ block: number; reported_line: number; verified_line: number }>;
  engine_messages: Array<{ severity: string; text: string }>;
  invalid_headings: Array<{ file: string; line: number; text: string }>;
}
export interface Composition {
  schema: 'apv-adoc-composition@1'; main: string; revision: string;
  files: Array<{ file: string; sha256: string }>; attributes: Record<string, string | boolean>;
  engine: { version: string; sha256: string }; policy: string; limits: Limits; sha256: string;
}
export interface ExpandedModel {
  schema: 'apv-adoc-expanded@1';
  expanded_text: string;
  line_map: Array<{ file: string; line: number }>;
  blocks: Block[];
}
export type AdocResult = { ok: true; composition: Composition; model: ExpandedModel; report: Report }
  | { ok: false; error: { code: string; message: string; next_action: string; file?: string; line?: number } };
