# Adoc unterminated-block recovery

Owner authorization: accept the pinned engine recovery for `reader.unterminated`, retain its actual block structure,
and report opening file/line, delimiter kind and inclusive ending file/line. Do not repair source or guess intent.
Unrelated ERROR/FATAL remains fail-closed.

## Allowed paths

- `packs/product/famx/functions/adoc/engine.ts`
- `packs/product/famx/functions/adoc/index.ts`
- `packs/product/famx/functions/adoc/types.ts`
- `packs/product/famx/functions/adoc/failures.test.ts`
- `packs/product/famx/functions/adoc/unterminated.test.ts`
- `packs/product/famx/README.md`
- `packs/product/famx/pack.json`
- This task page

## Basis and changes

The previous group refusal for a structured unterminated flag was stricter than the engine's supported recovery;
its former rejection expectation is updated to the owner's recovery rule. The adapter observes native reader calls
and cursor positions, including nested bounded readers, rather than warning words or a new delimiter parser.
Existing block interpretation is unchanged. Synthetic fixtures demonstrate literal/example recovery, swallowed
signature-looking content, cross-file ranges and unrelated errors. Pinned vendor bytes are unchanged.

Latest main was integrated before bumping FAMX from 1.7.27 to 1.7.28 and re-signing its manifest.

## Synthetic validation

- `npm run typecheck`: passed.
- `node --test --test-concurrency=2 "packs/product/famx/functions/adoc/*.test.ts" "hub/knowledge/**/*.test.ts"`: 534 passed, zero failed/skipped.
- Seven new recovery tests include native container/file ends, nested blocks, cross-file positions, determinism,
  reference-only/literal interpretation, unrelated ERROR refusal and restored observer methods.
- `node packs/product/famx/api.ts check`: manifest current for FAMX 1.7.28.

These checks use synthetic sources only; they do not claim a real-source production or deployment result.
