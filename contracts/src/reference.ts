// References (B03): the only form of a claim's grounds. Textual forms: REFERENCE_FORMS in contracts/generated/protocol.ts.
// Parsing and formatting live in hub/refs; these shapes fix what a well-formed reference looks like.
import { z } from 'zod';
import { REFERENCE_SCHEME, type ReferenceScheme } from '../generated/vocabulary.ts';
import { Sha256 } from './common.ts';

/** Longest reference text, in UTF-16 code units (hub/refs refuses longer ones). */
export const MAX_REFERENCE_LENGTH = 8192;

const HEX64 = '[0-9a-f]{64}';
/**
 * The BMP code points of \p{Cc}, \p{Cf} and \p{Z} (Unicode 17): controls, format characters (zero-width and bidi marks)
 * and every space or separator. hub/refs percent-encodes them; they are written out so that no \p{} reaches a published
 * pattern. The astral ones and unpaired surrogates are refused by a refinement (NEVER_RAW).
 */
export const NEVER_RAW_BMP =
  '\\u0000-\\u0020\\u007F-\\u00A0\\u00AD\\u0600-\\u0605\\u061C\\u06DD\\u070F\\u0890-\\u0891\\u08E2\\u1680\\u180E\\u2000-\\u200F' +
  '\\u2028-\\u202F\\u205F-\\u2064\\u2066-\\u206F\\u3000\\uFEFF\\uFFF9-\\uFFFB';
const NEVER_RAW = /[\p{Cc}\p{Cf}\p{Z}\uD800-\uDFFF]/u;
/** A percent escape: two upper-case hex digits, as hub/refs writes them. */
const ESCAPE = '%[0-9A-F]{2}';
/** One character of a part: raw unless structural in that part, `%`, or never raw. */
const charOf = (structural: string): string => `(?:[^%${structural}${NEVER_RAW_BMP}]|${ESCAPE})`;
const SELECTOR_SEGMENT = `${charOf('/:')}+`;
const PATH_SEGMENT = `${charOf('/@')}+`;
const POINTER_TOKEN = `(?:[^%~/#${NEVER_RAW_BMP}]|${ESCAPE}|~[01])*`;
const PARSER = '[a-z][a-z0-9_.-]{0,63}@(?:0|[1-9][0-9]{0,8})';
const DECIMAL = '(?:0|[1-9][0-9]{0,15})';

const SELECTOR = `${SELECTOR_SEGMENT}(?:/${SELECTOR_SEGMENT})*`;
const PATH = `/(?:${PATH_SEGMENT}(?:/${PATH_SEGMENT})*)?`;
const POINTER = `(?:/${POINTER_TOKEN})+`;

/** Grammar of each URI after `<scheme>:`, following REFERENCE_FORMS. Keyed by the generated scheme vocabulary. */
const URI_TAIL = {
  // src:<sha256>[/<parser>@<major>/<selector>[:<from>-<to>]]; the selector grammar belongs to the parser.
  src: `${HEX64}(?:/${PARSER}/${SELECTOR}(?::${DECIMAL}-${DECIMAL})?)?`,
  // tree:<root>/<path>[@<entry>]; `/` alone is the root node.
  tree: `${HEX64}${PATH}(?:@${HEX64})?`,
  entry: HEX64,
  // rec:<record>[#<JSON Pointer>]
  rec: `${HEX64}(?:#${POINTER})?`,
} as const satisfies Record<ReferenceScheme, string>;

function uriPattern(schemes: readonly ReferenceScheme[]): RegExp {
  const alternatives = schemes.map((s) => {
    // A scheme added to the model without a grammar here must stop the generator, not publish `<scheme>:undefined`.
    if (!Object.hasOwn(URI_TAIL, s)) throw new Error(`reference scheme ${s} has no URI grammar in contracts/src/reference.ts`);
    return `${s}:${URI_TAIL[s]}`;
  });
  return new RegExp(`^(?:${alternatives.join('|')})$`);
}

/** What the published pattern cannot say: astral format characters, unpaired surrogates and the order of a byte range. */
function refineUri(uri: string, ctx: z.core.$RefinementCtx<string>): void {
  if (NEVER_RAW.test(uri)) {
    ctx.addIssue({ code: 'custom', message: 'control, format and space characters and unpaired surrogates are percent-encoded in a reference' });
  }
  const range = /^src:[0-9a-f]{64}\/[^:]*:([0-9]{1,16})-([0-9]{1,16})$/.exec(uri);
  if (range && BigInt(range[1]) >= BigInt(range[2])) ctx.addIssue({ code: 'custom', message: 'a byte range :from-to needs from < to' });
}

// The length check aborts, so the patterns never run on text longer than MAX_REFERENCE_LENGTH: on megabytes they would
// overflow the regular expression stack instead of failing.
const uriOf = (schemes: readonly ReferenceScheme[], message: string) =>
  z.string().max(MAX_REFERENCE_LENGTH, { abort: true }).regex(uriPattern(schemes), message).superRefine(refineUri);

/** Canonical text of one part of the object form (selector, path or pointer), checked like the URI. */
const partOf = (pattern: string, message: string) =>
  z
    .string()
    .max(MAX_REFERENCE_LENGTH, { abort: true })
    .regex(new RegExp(`^${pattern}$`), message)
    .refine((text) => !NEVER_RAW.test(text), 'control, format and space characters and unpaired surrogates are percent-encoded');

/** Canonical text of a knowledge tree path: `/` is the root; segments are non-empty, `/`, `@` and `%` inside them are escaped. */
export const TreePath = partOf(PATH, 'absolute tree path in canonical text: / is the root, no empty segment, no trailing slash').describe(
  'Knowledge tree path in canonical text, as the Hub writes it (percent escapes kept verbatim); / is the root',
);
export type TreePath = z.infer<typeof TreePath>;

// Object fields hold the same canonical text as the URI form (percent-encoded where needed); hub/refs converts between them.
export const SrcReference = z
  .strictObject({
    scheme: z.literal('src' satisfies ReferenceScheme),
    sha256: Sha256,
    parser: z
      .string()
      .regex(new RegExp(`^${PARSER}$`))
      .optional()
      .describe('parser@version that locates the fragment'),
    selector: partOf(SELECTOR, 'canonical selector text').optional().describe('fragment locator in canonical text, grammar declared by the parser'),
    range: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional().describe('byte range inside the fragment, [from, to)'),
  })
  .refine((r) => (r.parser === undefined) === (r.selector === undefined), { message: 'parser and selector go together', path: ['selector'] })
  .refine((r) => r.range === undefined || (r.selector !== undefined && r.range[0] < r.range[1]), {
    message: 'a range needs a selector and from < to',
    path: ['range'],
  });

export const TreeReference = z.strictObject({
  scheme: z.literal('tree' satisfies ReferenceScheme),
  root: Sha256,
  path: TreePath,
  entry: Sha256.optional().describe('pins the content of one entry at that path'),
});

export const EntryReference = z.strictObject({ scheme: z.literal('entry' satisfies ReferenceScheme), entry: Sha256 });

export const RecReference = z.strictObject({
  scheme: z.literal('rec' satisfies ReferenceScheme),
  record: Sha256,
  pointer: partOf(POINTER, 'JSON Pointer in canonical text').optional().describe('JSON Pointer into the record body, in canonical text'),
});

export const Reference = z.discriminatedUnion('scheme', [SrcReference, TreeReference, EntryReference, RecReference]);
export type Reference = z.infer<typeof Reference>;

/**
 * Canonical textual form, e.g. `src:<sha256>/<parser>@1/<selector>` or `rec:<sha256>#/partitions/delivered/2`. Raw
 * control, format and space characters never appear: the formatter percent-encodes them with upper-case hex.
 */
export const ReferenceUri = uriOf(REFERENCE_SCHEME, 'reference URI, see REFERENCE_FORMS');
export type ReferenceUri = z.infer<typeof ReferenceUri>;

/** A reference URI restricted to some schemes, for example `referenceUriOf('rec')` for a Hub record reference. */
export const referenceUriOf = (...schemes: ReferenceScheme[]) => {
  if (schemes.length === 0) throw new Error('referenceUriOf needs at least one scheme');
  return uriOf(schemes, `${schemes.join(' or ')} reference URI, see REFERENCE_FORMS`);
};

/**
 * A reference that can be a claim's ground. A knowledge entry is never a ground on its own: it is cited by its tree
 * address, `tree:<root>/<path>@<entry>`, so that resolution brings in the source fragment behind it (B01 R[5], B03 F[2]).
 */
export const Ground = referenceUriOf('src', 'tree', 'rec').describe('reference a claim rests on: src, tree or rec; a knowledge entry is cited by its tree address');
export type Ground = z.infer<typeof Ground>;

/** External object identity `system:type:id[@revision]`, a provenance field and target key, never a reference scheme (B03 R[5]). */
export const ExternalObjectId = z
  .string()
  .max(MAX_REFERENCE_LENGTH, { abort: true })
  .regex(new RegExp(`^[a-z][a-z0-9-]*:[a-z][a-z0-9_-]*:[^@${NEVER_RAW_BMP}]+(?:@[^${NEVER_RAW_BMP}]+)?$`), 'system:type:id[@revision]')
  // Refinements rather than lookaheads keep the published pattern simple for MCP clients.
  .refine((id) => !NEVER_RAW.test(id), 'no control, format or space character in an external object identity')
  .refine((id) => !(REFERENCE_SCHEME as readonly string[]).includes(id.slice(0, id.indexOf(':'))), 'the system of an external object is never a reference scheme');
export type ExternalObjectId = z.infer<typeof ExternalObjectId>;
