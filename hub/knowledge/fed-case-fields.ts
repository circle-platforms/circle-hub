// Which fields of a fed-case@1 projection do not depend on the knowledge root the case is projected onto. The schema is
// core's (contracts/generated/shared-interfaces.ts, FedCaseSchema): stories and defects are author-declared identities of
// the source, document is the source's own document and title is the exact case-node text, so a root-less projection of
// the same source already carries their values. Commands, command_tree_root and path are resolved against the locked
// command tree and the tree placement, so they do depend on the root. This is core knowledge of a core schema; it names
// no product and changes no contract.

/** fed-case@1 fields whose values are the same under every root, keyed to how a requested `only=` value matches them. */
export const ROOT_INDEPENDENT_CASE_FIELDS = {
  stories: 'id',
  defects: 'id',
  document: 'exact',
  title: 'exact',
} as const satisfies Record<string, 'id' | 'exact'>;

export type RootIndependentCaseField = keyof typeof ROOT_INDEPENDENT_CASE_FIELDS;

export function rootIndependentField(key: string | undefined): key is RootIndependentCaseField {
  return key !== undefined && Object.hasOwn(ROOT_INDEPENDENT_CASE_FIELDS, key);
}

/**
 * The normalized form of an identity: an all-digit literal loses its leading zeros (00021 and 21 are one identity), any
 * other literal stays as written. The exact literal stays in the source and in the index key.
 */
export function normalizedId(value: string): string {
  return /^[0-9]+$/.test(value) ? value.replace(/^0+/, '') || '0' : value;
}

/** How an index field compares a requested `only=` value with a stored key: identity fields by normalized id. */
export function onlyMatcher(key: string, only: readonly string[] | ReadonlySet<string> | null): ((value: string) => boolean) | null {
  if (only === null) return null;
  const values = [...only];
  if (rootIndependentField(key) && ROOT_INDEPENDENT_CASE_FIELDS[key] === 'id') {
    const wanted = new Set(values.map(normalizedId));
    return (value) => wanted.has(normalizedId(value));
  }
  const wanted = new Set(values);
  return (value) => wanted.has(value);
}

/**
 * The values of a root-independent field as a fed-case@1 body states them, or null when the body does not state the
 * field (a legacy projection without it): absence of the field is unknown, never an empty value.
 */
export function rootIndependentValues(body: Record<string, unknown>, key: RootIndependentCaseField): string[] | null {
  if (key === 'document') {
    const source = body.source;
    const document = source !== null && typeof source === 'object' && !Array.isArray(source) ? (source as Record<string, unknown>).document : undefined;
    return typeof document === 'string' ? [document] : null;
  }
  if (key === 'title') return typeof body.title === 'string' ? [body.title] : null;
  const list = body[key];
  return Array.isArray(list) && list.every((value) => typeof value === 'string') ? list as string[] : null;
}
