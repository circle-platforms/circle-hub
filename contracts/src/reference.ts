// References (B03): the only form of a claim's grounds. Textual forms live in contracts/generated/protocol.ts (REFERENCE_FORMS).
import { z } from 'zod';
import { Sha256 } from './common.ts';

export const SrcReference = z.object({
  scheme: z.literal('src'),
  sha256: Sha256,
  parser: z.string().regex(/^[a-z][a-z0-9_.-]*@[0-9]+$/).optional().describe('parser@version that locates the fragment'),
  selector: z.string().optional().describe('fragment locator, grammar declared by the parser'),
  range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional().describe('byte range inside the fragment, [from, to)'),
});

export const TreeReference = z.object({
  scheme: z.literal('tree'),
  root: Sha256,
  path: z.string().startsWith('/'),
  entry: Sha256.optional().describe('pins the content of one entry at that path'),
});

export const EntryReference = z.object({ scheme: z.literal('entry'), entry: Sha256 });

export const RecReference = z.object({
  scheme: z.literal('rec'),
  record: Sha256,
  pointer: z.string().startsWith('/').optional().describe('JSON Pointer into the record body'),
});

export const Reference = z.discriminatedUnion('scheme', [SrcReference, TreeReference, EntryReference, RecReference]);
export type Reference = z.infer<typeof Reference>;

/** Canonical textual form, e.g. `src:<sha256>/kityminder@1/n3a9/root.children.2`. Parsing and formatting live in hub/refs. */
export const ReferenceUri = z.string().regex(/^(src|tree|entry|rec):[0-9a-f]{64}/, 'reference URI');
export type ReferenceUri = z.infer<typeof ReferenceUri>;

/** External object identity `system:type:id[@revision]`, a provenance field and target key, never a reference scheme (B03 R[5]). */
export const ExternalObjectId = z.string().regex(/^[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*:[^\s@]+(@[^\s]+)?$/, 'system:type:id[@revision]');
export type ExternalObjectId = z.infer<typeof ExternalObjectId>;
