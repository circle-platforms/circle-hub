// The pinned engine decides attributes and conditional semantics. The adapter never renders HTML or invokes include I/O.
import { load, getVersion, MemoryLogger, LoggerManager, type EngineDocument } from './vendor/core.mjs';
import { ENGINE, fail } from './input.ts';

// One producer call already owns a fresh sandbox. Serialize host-side calls as well, so the public global logger API
// cannot mix two parses; no async_hooks import and no change to the pinned bundle or sandbox allowlist.
let pending = Promise.resolve();
export async function engineSession<T>(work: () => Promise<T>): Promise<T> {
  const before = pending;
  let release!: () => void;
  pending = new Promise<void>((resolve) => { release = resolve; });
  await before;
  const previous = LoggerManager.getLogger();
  LoggerManager.setLogger(new MemoryLogger());
  try { return await work(); }
  finally { LoggerManager.setLogger(previous); release(); }
}

export async function document(text: string, main: string, attributes: Record<string, unknown>, parse = true): Promise<{ doc: EngineDocument; logger: MemoryLogger }> {
  if (getVersion() !== ENGINE.version) fail('engine_version', '引擎版本与组成策略不符');
  const logger = LoggerManager.getLogger() as MemoryLogger;
  const doc = await load(text, { safe: 'secure', sourcemap: true, parse, doctype: 'book', attributes: { ...attributes, reproducible: '', docfile: main } });
  return { doc, logger };
}
/** The current engine attribute state, including body assignments restored through the public playback API. */
export async function attributesAfter(text: string, main: string, attributes: Record<string, unknown>): Promise<Record<string, unknown>> {
  const previous = LoggerManager.getLogger();
  LoggerManager.setLogger(new MemoryLogger());
  try {
    // A prefix can end inside a valid open block. Its temporary diagnostics do not describe the full book.
    // A trailing body assignment has no playback carrier yet; a fixed neutral paragraph flushes pending entries.
    const { doc } = await document(text + '\n\nhub_adoc_attribute_state_probe\n', main, attributes);
    for (const block of doc.findBy()) doc.playbackAttributes(block.attributes);
    return { ...doc.getAttributes() };
  } finally { LoggerManager.setLogger(previous); }
}
/** A tiny predicate probe, not a parse of discarded source content and not a second implementation of ifdef/ifndef. */
export async function conditionValue(directive: string, main: string, attributes: Record<string, unknown>): Promise<boolean> {
  const match = /^(ifdef|ifndef)::([^\[]+)\[/.exec(directive);
  if (!match) fail('conditional_syntax', '不支持的条件指令');
  const marker = 'hub_adoc_condition_selected';
  const source = `${match[1]}::${match[2]}[]\n\n${marker}\n\nendif::${match[2]}[]`;
  const { doc } = await document(source, main, attributes);
  return doc.findBy({ context: 'paragraph' }).some((block) => block.getSource?.() === marker);
}
