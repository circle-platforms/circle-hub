// Types of the pinned browser engine API used by this adapter; no runtime code.
export interface AstNode {
  context: string; level?: number; parent?: AstNode | null; attributes: Record<string, unknown>;
  /** The block style the author's declaration or the delimiter gives (`example`, `listing`, `arabic`, …). */
  style?: string | null;
  sourceLocation?: { lineno: number }; title?: string | null; text?: string;
  rows?: { head: AstNode[][]; body: AstNode[][]; foot: AstNode[][] };
  getSource?(): string; getId(): string | undefined; getRole(): string | undefined;
  /** The engine's own inline output of this node's content (a paragraph's converted text); a promise in this build. */
  getContent?(): Promise<string>;
  getItems?(): AstNode[]; subAttributes(text: string): string;
}
export interface EngineReader {
  cursor: { lineno: number }; processLine(line: string): Promise<string | undefined>;
  /** The engine's own flag: a delimited block was still open when the source ended. Null before any read. */
  unterminated?: boolean | null;
}
export interface EngineDocument extends AstNode {
  parse(): Promise<EngineDocument>; findBy(selector?: Record<string, unknown>): AstNode[];
  getAttributes(): Record<string, unknown>; getReader(): EngineReader;
  playbackAttributes(attributes: Record<string, unknown>): void;
}
export class MemoryLogger {
  messages: Array<{ severity: string; text: string; sourceLocation?: { lineno: number } | null }>;
}
export function getVersion(): string;
export function load(source: string, options?: Record<string, unknown>): Promise<EngineDocument>;

export const LoggerManager: { getLogger(): unknown; setLogger(logger: unknown): void };
