import {Versioned} from './common.ts';
// Shapes owned by the tables work package (the rules package): the table kinds read by the Hub's core interpreters (C04, C05),
// the catalog entry the catalog interpreter matches against (C07) and the outcome every check returns (V01).
// Register every record or pack-file schema in `schemas`; contracts/src/index.ts merges them into SCHEMA_REGISTRY, which
// tools/gen-contracts.ts turns into contracts/generated/schemas/*.json. Keys are `name@major`.
// Table admission (C04 R[0]): every shape is closed (strict objects), carries no embedded expression except the declared, length
// limited pattern language of pattern@1 with mandatory, size-limited samples, and names the source or decision that produced it
// (`origin`). A blocking table names the contract clause it relies on (`basis`, C05 R[1]); without one its tier is advisory.
// Missing is not empty (C04 R[4]): a location is missing when the member it names, up to its first wildcard, does not exist.
// The option names of the table language (unicode, case, whitespace, value and parameter types, within, scope, flags,
// mode) are written here, not in the model vocabulary (measure comes from the model vocabulary): see hub/rules/README.md,
// "Needs from other packages".
import { z } from 'zod';
import { CheckTierSchema, MeasureSchema, ReasonSchema, VerdictSchema, TypeDeclarationStatusSchema } from '../generated/vocabulary.ts';
import {MissingFact,UnknownExit,recoveryCondition} from './validation.ts';
import { ReferenceUri,Ground } from './reference.ts';

/** Limits of the pattern@1 samples, so validating a table stays cheap (the matcher also caps its work on them). */
export const PATTERN_LIMITS = { rules: 64, samples: 32, sampleLength: 1000 } as const;

/** RFC 6901 JSON Pointer. The empty string is the whole value. */
export const JsonPointer = z
  .string()
  .regex(/^(?:\/(?:[^~/]|~[01])*)*$/, 'RFC 6901 JSON Pointer')
  .describe('RFC 6901 JSON Pointer; the empty string is the whole value');
export type JsonPointer = z.infer<typeof JsonPointer>;

/**
 * RFC 9535 JSONPath restricted to the root, member names (`.name`, `['name']`), indexes (`[0]`, `[-1]`) and wildcards (`.*`, `[*]`).
 * No descendant segments, filters or slices.
 */
export const JsonPath = z
  .string()
  .max(512)
  .regex(
    /^\$(?:\.(?:\*|[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)|\[(?:\*|-?(?:0|[1-9][0-9]*)|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")\])*$/,
    'RFC 9535 JSONPath with member names, indexes and wildcards only',
  )
  .describe('RFC 9535 JSONPath selecting values of the subject; only member names, indexes and wildcards are allowed');
export type JsonPath = z.infer<typeof JsonPath>;

/** Representation used for matching (C04 R[2]): values are normalized this way before they are compared. */
export const MatchRepresentation = z
  .strictObject({
    unicode: z.enum(['none', 'nfc', 'nfkc']).optional().describe('Unicode normalization form applied first; default nfc'),
    case: z.enum(['sensitive', 'insensitive']).optional().describe('insensitive compares lower-cased values; default sensitive'),
    whitespace: z
      .enum(['exact', 'trim', 'collapse'])
      .optional()
      .describe('trim removes leading and trailing whitespace, collapse also turns every inner whitespace run into one space; default trim'),
  })
  .describe('How values are normalized before matching (C04 R[2]); every table that compares text declares it');
export type MatchRepresentation = z.infer<typeof MatchRepresentation>;

const common = {
  origin: z
    .string()
    .min(1)
    .describe('The source file (a reference) or the decision that produced this table (C04 R[0]); a table without it is code'),
  description: z.string().optional().describe('What the table checks, in the pack language'),
  tier: CheckTierSchema.optional().describe('Tier of the outcomes (C05 R[1]); default blocking when a basis is given, else advisory. Blocking needs a basis'),
  basis: z.string().min(1).optional().describe('The acceptance contract clause a blocking check relies on (C05 R[1])'),
  item: JsonPointer.optional().describe('Pointer to the item identity in the subject (or in each node); copied into outcomes'),
  location: JsonPointer.optional().describe('Pointer to the reference URI of the item in the judged source; becomes a ground of the outcomes'),
};

// structure@1 ----------------------------------------------------------------------------------------------------------------

/** JSON value types (RFC 8259 data model, with integer as in JSON Schema). */
export const ValueType = z.enum(['string', 'integer', 'number', 'boolean', 'array', 'object', 'null']).describe('JSON value type, named as in JSON Schema');
export type ValueType = z.infer<typeof ValueType>;

const ValueConstraints = {
  type: ValueType.optional().describe('Required JSON type; a value of another type is core.structure.type_mismatch'),
  minimum: z.number().optional().describe('Inclusive lower bound of a number; violations are core.structure.type_mismatch'),
  maximum: z.number().optional().describe('Inclusive upper bound of a number; violations are core.structure.type_mismatch'),
  minLength: z.number().int().nonnegative().optional().describe('Minimum string length in code points'),
  maxLength: z.number().int().nonnegative().optional().describe('Maximum string length in code points'),
};

export const StructureFieldRule = z
  .strictObject({
    path: JsonPointer.describe('Location of the field relative to the node'),
    required: z
      .boolean()
      .optional()
      .describe('A missing field, null, a string that is empty after trimming or an empty array is core.structure.required_empty'),
    ...ValueConstraints,
    minItems: z.number().int().nonnegative().optional().describe('Minimum array length; violations are core.structure.cardinality'),
    maxItems: z.number().int().nonnegative().optional().describe('Maximum array length; violations are core.structure.cardinality'),
    items: z
      .strictObject({
        required: z.boolean().optional().describe('Every element must be non-empty (core.structure.required_empty)'),
        ...ValueConstraints,
      })
      .optional()
      .describe('Constraints on every element of an array field'),
  })
  .describe('Constraints on one field of a node');

export const StructureUniqueRule = z
  .strictObject({
    key: z.array(JsonPointer).min(1).describe('Fields that together form the key; nodes with an equal key are core.structure.duplicate_key'),
    within: z
      .enum(['all', 'siblings', 'group'])
      .optional()
      .describe('all: among every selected node of the rule; siblings: among children of one parent; group: among nodes with equal `group` fields. Default all'),
    group: z.array(JsonPointer).optional().describe('Fields that define the groups when within is group'),
    match: MatchRepresentation.optional(),
  })
  .describe('A uniqueness key');

export const StructureKindRule = z
  .strictObject({
    kinds: z.array(z.string().min(1)).optional().describe('Node kinds the rule applies to (values at the `kind` pointer); absent means every node'),
    fields: z.array(StructureFieldRule).optional(),
    children: z
      .strictObject({
        min: z.number().int().nonnegative().optional(),
        max: z.number().int().nonnegative().optional(),
        kinds: z.array(z.string().min(1)).optional().describe('Count only children of these kinds'),
      })
      .optional()
      .describe('Bounds on the number of children; violations are core.structure.cardinality'),
    unique: z.array(StructureUniqueRule).optional(),
  })
  .describe('Rules for nodes of some kinds');

export const StructureTable = z
  .strictObject({
    schema: z.literal('structure@1'),
    ...common,
    nodes: JsonPath.optional().describe('The nodes the rules apply to; default $ (the subject is one node); $[*] for an array of items'),
    kind: JsonPointer.optional().describe('Pointer to the node kind inside a node'),
    children: JsonPointer.optional().describe('Pointer to the child array inside a node; children are visited recursively'),
    rules: z.array(StructureKindRule).min(1),
  })
  .meta({
    title: 'structure@1',
    description:
      'Structure table: required fields, uniqueness keys, child cardinality bounds, value types and numeric ranges, rules per node kind. Codes: core.structure.*',
  });
export type StructureTable = z.infer<typeof StructureTable>;

// catalog@1 ------------------------------------------------------------------------------------------------------------------

export const CatalogTable = z
  .strictObject({
    schema: z.literal('catalog@1'),
    ...common,
    catalog: z.string().min(1).describe('Name of the catalog in the pack knowledge declaration (knowledge.json) that the caller binds'),
    strict_signatures:z.boolean().optional().describe('Membership claims require a complete executable signature; a menu or a bare head with required arguments is not membership'),
    commands: z
      .array(JsonPath)
      .optional()
      .describe('Subject locations holding command text: a string, or an array of strings, one phrase each'),
    scope: z
      .enum(['resolved', 'first_word', 'all'])
      .optional()
      .describe(
        'Which phrases are checked. resolved (default): only phrases whose head resolves to an entry; first_word: phrases whose first word starts some entry, a head that does not resolve is core.catalog.not_member; all: every phrase must resolve',
      ),
    match: MatchRepresentation.optional().describe('Normalization of command text before tokenizing; case applies to words, enum values and keywords'),
    quotes: z.boolean().optional().describe('Single and double quotes group words into one argument; default true'),
    required: z
      .boolean()
      .optional()
      .describe('A required missing location refutes core.structure.required_empty with data.missing, attributed to the subject provider; an optional missing location is listed in data.missing, never unknown'),
    claims: z
      .strictObject({
        select: JsonPath.describe('Statements that a command exists or does not exist; a missing location means no statements'),
        command: JsonPointer.describe('Pointer to the command text inside a statement'),
        present: JsonPointer.describe('Pointer to a boolean inside a statement: true claims the command exists, false that it does not'),
      })
      .optional()
      .describe(
        'Membership statements; a statement the catalog contradicts is core.catalog.membership_contradicted. A command exists when its words are a head, a menu, or a head followed by arguments that fit one of its signatures',
      ),
    negative: z
      .strictObject({
        flag: JsonPointer.describe('Pointer to a boolean in the subject that marks a negative case'),
        expect: z.array(z.string().min(1)).min(1).describe('Violation codes a negative case is expected to produce; the caller compares'),
        tier: CheckTierSchema.optional().describe('Tier of the outcomes on a negative case, kept whatever tier the check declares; default advisory. Blocking needs a basis'),
      })
      .optional()
      .describe('Negative-case handling: the interpreter still refutes, marks the outcome and applies this tier'),
  })
  .meta({
    title: 'catalog@1',
    description:
      'Catalog table: which subject fields hold command text, which statements claim membership, tier and negative-case handling. Commands are matched by longest head against the bound catalog. Codes: core.catalog.*',
  });
export type CatalogTable = z.infer<typeof CatalogTable>;

/** Parameter types of a catalog signature. */
export const CatalogParamType = z
  .enum(['string', 'int', 'enum', 'ipv4', 'ipv6', 'mask', 'port', 'keyword', 'hostname', 'ip_or_hostname'])
  .describe('string: any word (minLength/maxLength); int: decimal integer (minimum/maximum); enum: one of values; ipv4, ipv6: address; mask: dotted IPv4 netmask; port: 0-65535 (minimum/maximum narrow it); keyword: the literal keyword; hostname: bounded ASCII DNS labels (single-label and trailing-dot names allowed, no URL/IP coercion); ip_or_hostname: IPv4, IPv6 or that hostname according to the bound catalog contract');
export type CatalogParamType = z.infer<typeof CatalogParamType>;

/** A source constraint whose semantics are not yet declared; it is never silently treated as satisfied. */
export const CatalogUncheckedConstraint=z.strictObject({
  path:z.string().regex(/\S/),reason:ReasonSchema,missing:MissingFact,next_action:MissingFact,source_value:z.string().optional(),
});
export type CatalogUncheckedConstraint=z.infer<typeof CatalogUncheckedConstraint>;

export const CatalogParam = z
  .strictObject({
    name: z.string().min(1),
    native_type:z.strictObject({name:z.string().min(1),declaration:Ground,grammar:Versioned}).optional(),
    type: CatalogParamType.optional(),
    type_declaration_status: TypeDeclarationStatusSchema.optional(),
    unchecked_constraints:z.array(CatalogUncheckedConstraint).min(1).optional(),
    address_role:z.string().regex(/\S/).optional().describe('Role identifier from the bound published runtime/bed contract, not an inferred core role'),
    optional: z.boolean().optional().describe('The argument may be omitted'),
    default: z.string().optional().describe('Value used when the argument is omitted, as documented by the source'),
    minimum: z.number().optional().describe('int and port: inclusive lower bound'),
    maximum: z.number().optional().describe('int and port: inclusive upper bound'),
    minLength: z.number().int().nonnegative().optional().describe('string: minimum length in code points'),
    maxLength: z.number().int().nonnegative().optional().describe('string: maximum length in code points'),
    values: z.array(z.string().min(1)).optional().describe('enum: the allowed values'),
    keyword: z.string().min(1).optional().describe('keyword: the literal word; defaults to the parameter name'),
    description: z.string().optional().describe('Descriptive text; descriptive content is excluded when an impact view compares catalog members by syntax'),
  })
  .superRefine((param,ctx)=>{
    if(param.type===undefined&&(param.type_declaration_status!=='undeclared'||!param.unchecked_constraints?.length))ctx.addIssue({code:'custom',message:'an absent native type requires undeclared status and a recovery-bearing unchecked constraint'});
    if(param.type!==undefined&&param.type_declaration_status==='undeclared')ctx.addIssue({code:'custom',message:'an undeclared native type cannot be replaced with a guessed type'});
  })
  .describe('One typed parameter of a signature. A producer interprets a scalar source limit by that source format and emits generic constraints: an exact numeric value uses equal minimum/maximum, a ceiling uses maximum, a member uses values, a length uses maxLength; raw limit is not guessed by the core');
export type CatalogParam = z.infer<typeof CatalogParam>;

export const CatalogSignature = z
  .strictObject({
    id: z.string().min(1).optional().describe('Stable identity of the overload; derived from the position when absent. Per root: excluded when an impact view compares catalog members by syntax (overloads compare as a set)'),
    params: z.array(CatalogParam).describe('Positional parameters in order'),
    reference: ReferenceUri.optional().describe('Where this argument list is defined; references differ per root and are excluded when an impact view compares catalog members by syntax'),
  })
  .describe('One overload of a catalog entry');
export type CatalogSignature = z.infer<typeof CatalogSignature>;

export const CatalogEntry = z
  .strictObject({
    words: z.array(z.string().min(1)).min(1).describe('The command head, word by word'),
    signatures: z.array(CatalogSignature).describe('Overloads; an entry without signatures takes no arguments'),
    reference: ReferenceUri.describe('Tree reference of the node that holds the entry; references differ per root and are excluded when an impact view compares catalog members by syntax'),
    summary: z.string().optional().describe('Descriptive text; descriptive content is excluded when an impact view compares catalog members by syntax'),
  })
  .meta({
    title: 'catalog-entry@1',
    description:
      'One member of a closed catalog (C07): the command head, its overloads with typed parameters and the tree reference of its node. An impact view asked for catalog=<id> compares members by syntax: the words and the signatures as a set, each signature without its id and reference and each parameter without its description, the entry summary left out',
  });
export type CatalogEntry = z.infer<typeof CatalogEntry>;

// membership@1 ---------------------------------------------------------------------------------------------------------------

export const ClosedSet = z
  .union([
    z.strictObject({ values: z.array(z.string()).min(1).describe('The members, by value') }),
    z.strictObject({ reference: ReferenceUri.describe('A bound source whose content is a JSON array of strings') }),
    z.strictObject({ name: z.string().min(1).describe('A closed set the pack declares (slots.schema.json), passed by the caller') }),
  ])
  .describe('A closed set by value, by reference or by the name of a pack-declared set');
export type ClosedSet = z.infer<typeof ClosedSet>;

export const MembershipTable = z
  .strictObject({
    schema: z.literal('membership@1'),
    ...common,
    values: z.array(JsonPath).min(1).describe('Subject locations whose values must be members (strings, or arrays of strings)'),
    set: ClosedSet,
    match: MatchRepresentation.optional(),
    required: z
      .boolean()
      .optional()
      .describe('A required missing location refutes core.structure.required_empty with data.missing, attributed to the subject provider; an optional missing location is listed in data.missing, never unknown'),
  })
  .meta({ title: 'membership@1', description: 'Membership table: values must belong to a closed set. Code: core.membership.not_in_set' });
export type MembershipTable = z.infer<typeof MembershipTable>;

// pattern@1 ------------------------------------------------------------------------------------------------------------------

export const PatternRule = z
  .strictObject({
    values: JsonPath.describe('Subject locations whose string values are matched'),
    pattern: z.string().min(1).max(256).describe('Pattern in the declared language, at most 256 characters'),
    flags: z.enum(['', 'i']).optional().describe('i: case-insensitive'),
    mode: z.enum(['full', 'search']).optional().describe('full (default): the whole value must match; search: some part of it'),
    negate: z.boolean().optional().describe('The value must not match'),
    samples: z
      .strictObject({
        match: z
          .array(z.string().max(PATTERN_LIMITS.sampleLength))
          .min(1)
          .max(PATTERN_LIMITS.samples)
          .describe(`Values the pattern must accept; at most ${PATTERN_LIMITS.samples}, each at most ${PATTERN_LIMITS.sampleLength} characters`),
        reject: z
          .array(z.string().max(PATTERN_LIMITS.sampleLength))
          .min(1)
          .max(PATTERN_LIMITS.samples)
          .describe(`Values the pattern must refuse; at most ${PATTERN_LIMITS.samples}, each at most ${PATTERN_LIMITS.sampleLength} characters`),
      })
      .describe('Samples checked when the table is validated (C04 R[0]); their total matching work is capped'),
  })
  .describe('One pattern and the values it applies to');

export const PatternTable = z
  .strictObject({
    schema: z.literal('pattern@1'),
    ...common,
    language: z
      .literal('regexp')
      .describe(
        'ECMAScript regular expression syntax restricted to literals, escapes, classes, the dot, anchors, groups, alternation and quantifiers (bounds at most 100); no backreferences, lookaround or named groups. Matched in linear time',
      ),
    rules: z.array(PatternRule).min(1).max(PATTERN_LIMITS.rules),
    match: MatchRepresentation.optional(),
    required: z
      .boolean()
      .optional()
      .describe('A required missing location refutes core.structure.required_empty with data.missing, attributed to the subject provider; an optional missing location is listed in data.missing, never unknown'),
  })
  .meta({ title: 'pattern@1', description: 'Pattern table: values must (or must not) match declared patterns. Code: core.pattern.no_match' });
export type PatternTable = z.infer<typeof PatternTable>;

// range@1 --------------------------------------------------------------------------------------------------------------------

const Bounds = {
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  exclusiveMinimum: z.number().optional(),
  exclusiveMaximum: z.number().optional(),
};

export const RangeCheck = z
  .union([
    z.strictObject({
      values: JsonPath,
      range: z.strictObject({ ...Bounds, integer: z.boolean().optional().describe('The value must be an integer') }).describe('Every selected value must lie in the bounds'),
    }),
    z.strictObject({
      values: JsonPath,
      prefix: z
        .strictObject({
          values: z.array(z.string().min(1)).min(1).describe('Allowed prefixes'),
          separator: z.string().min(1).optional().describe('Compare whole segments split at this separator, for example "."'),
        })
        .describe('Every selected value must start with one of the prefixes'),
    }),
    z.strictObject({
      values: JsonPath,
      threshold: z
        .strictObject({ measure: MeasureSchema.describe('Aggregate of the selected values'), ...Bounds, empty:VerdictSchema.extract(['refute','support']).optional().meta({default:'refute'}).describe('Only min/max on an empty set: support or refute, omission means refute; count and sum keep their defined numeric zero') })
        .superRefine((value,ctx)=>{if(value.empty!==undefined&&value.measure!=='min'&&value.measure!=='max')ctx.addIssue({code:'custom',path:['empty'],message:'empty is declared only for min and max'});})
        .describe('The aggregate of all selected values must lie in the bounds'),
    }),
  ])
  .describe('One range, prefix or threshold check');

export const RangeTable = z
  .strictObject({
    schema: z.literal('range@1'),
    ...common,
    checks: z.array(RangeCheck).min(1),
    match: MatchRepresentation.optional().describe('Normalization of strings before prefix comparison'),
    required: z
      .boolean()
      .optional()
      .describe('A required missing location refutes core.structure.required_empty with data.missing, attributed to the subject provider; an optional missing location is listed in data.missing, never unknown'),
  })
  .meta({
    title: 'range@1',
    description:
      'Range table: numeric ranges, prefixes and thresholds. Numbers are JSON numbers (by their shortest decimal text) or decimal strings, compared exactly. Code: core.range.out_of_bounds',
  });
export type RangeTable = z.infer<typeof RangeTable>;

// coverage@1 -----------------------------------------------------------------------------------------------------------------

export const CoverageTable = z
  .strictObject({
    schema: z.literal('coverage@1'),
    ...common,
    required: z
      .union([ClosedSet, z.strictObject({ select: JsonPath.describe('Members taken from the subject itself; a missing required location refutes core.structure.required_empty and names it in data.missing') })])
      .describe('The members that must be covered'),
    covered: z.array(JsonPath).min(1).describe('Subject locations listing the covered members; missing required locations refute core.structure.required_empty with data.missing'),
    skipped: z
      .strictObject({
        select: JsonPath.describe('Declared skips'),
        member: JsonPointer.describe('Pointer to the skipped member inside a skip'),
        reason: JsonPointer.describe('Pointer to the reason inside a skip; a skip without a non-empty reason does not count'),
      })
      .optional(),
    match: MatchRepresentation.optional(),
  })
  .meta({
    title: 'coverage@1',
    description: 'Coverage table: the covered set must contain every required member, or name a reason for skipping it. Code: core.coverage.shortfall',
  });
export type CoverageTable = z.infer<typeof CoverageTable>;

// quote@1 --------------------------------------------------------------------------------------------------------------------

export const QuoteTable = z
  .strictObject({
    schema: z.literal('quote@1'),
    ...common,
    quotes: z
      .array(
        z.strictObject({
          select: JsonPath.describe('Quotation objects in the subject'),
          text: JsonPointer.describe('Pointer to the quoted text inside a quotation'),
          reference: JsonPointer.describe('Pointer to the reference URI the quotation cites'),
        }),
      )
      .min(1),
  })
  .meta({
    title: 'quote@1',
    description:
      'Quotation table: every quotation must appear verbatim in the fragment its reference resolves to. Only white space differences are ignored: every run of Unicode White_Space collapses to one space and both ends are trimmed; case, punctuation, character width and normalization form stay significant, and an empty quotation never matches. A mismatch refutes with QUOTE_MISMATCH',
  });
export type QuoteTable = z.infer<typeof QuoteTable>;

// Outcome of a check -----------------------------------------------------------------------------------------------------------

export const CheckOutcome = z
  .strictObject({
    missing:MissingFact.optional().describe('Required for unknown; the Hub must not guess it from statement or data.missing'),
    exit:UnknownExit.optional().describe('An optional fully bound exit intent; the Hub resolves a missing exit from the cause before writing a layer result'),
    // Checks support, refute or stay unknown; only judges may abstain (V01).
    verdict: VerdictSchema.exclude(['abstain']),
    code: z.string().min(1).optional().describe('Violation code when refuted: core.*, a protocol code, or a pack code under the pack name'),
    statement: z.string().min(1).describe('What the check found, in Chinese'),
    grounds: z.array(ReferenceUri).describe('References the outcome rests on'),
    tier: CheckTierSchema,
    reason: ReasonSchema.optional().describe('Why the verdict is unknown'),
    item: z.string().optional().describe('Item the outcome is about, when the subject holds several'),
    pointer: JsonPointer.optional().describe('Location inside the subject'),
    data: z.record(z.string(), z.unknown()).optional().describe('Machine-readable parts of the statement'),
    judgment_sources:z.array(JsonPointer).max(128).optional().describe('Explicit pointers relative to this item slots into submitted model judgment objects with text; Hub binds model identity and records judgment premises, never treats their semantics as facts'),
  })
  .superRefine((outcome,ctx)=>{if(outcome.verdict==='unknown'){if(outcome.missing===undefined)ctx.addIssue({code:'custom',path:['missing'],message:'an unknown check outcome names its missing fact'});if(outcome.reason===undefined)ctx.addIssue({code:'custom',path:['reason'],message:'an unknown check outcome names its reason'});}})
  .meta({ ...recoveryCondition('verdict',['unknown'],['missing','reason']), title: 'check-outcome@1', description: 'One outcome of a core interpreter or a pack check function (V01)' });
export type CheckOutcome = z.infer<typeof CheckOutcome>;

/** Every table kind by its interpreter id. */
export const TABLE_SCHEMAS = {
  'structure@1': StructureTable,
  'catalog@1': CatalogTable,
  'membership@1': MembershipTable,
  'pattern@1': PatternTable,
  'range@1': RangeTable,
  'coverage@1': CoverageTable,
  'quote@1': QuoteTable,
} as const;
export type TableKind = keyof typeof TABLE_SCHEMAS;

export const schemas: Record<string, z.ZodType> = {
  ...TABLE_SCHEMAS,
  'catalog-entry@1': CatalogEntry,
  'check-outcome@1': CheckOutcome,
};
