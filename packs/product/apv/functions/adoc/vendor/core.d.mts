// Types of the pinned browser engine API used by this adapter; no runtime code.
export interface AstNode {
  context: string; level?: number; parent?: AstNode | null; attributes: Record<string, unknown>;
  sourceLocation?: { lineno: number }; title?: string | null; text?: string;
  rows?: { head: AstNode[][]; body: AstNode[][]; foot: AstNode[][] };
  getSource?(): string; getId(): string | undefined; getRole(): string | undefined;
  getItems?(): AstNode[]; subAttributes(text: string): string;
}
export interface EngineReader {
  cursor: { lineno: number }; processLine(line: string): Promise<string | undefined>;
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
