# case-compile 3.8.8: normalize the KityMinder export head that real local exports carry

The client normalizer `tools/normalize-mindmap.ts` declared two byte-accounted normalizations: two leading U+FFFF and a
single-element wrapper array. Every real local KityMinder export in the owner's case folder (seven files, 2026-10-30) starts with
the bytes EF BF BF EF BB BF, that is U+FFFF followed by U+FEFF, which the platform's own exporter writes as its file head. 3.8.7
refused all of them ("脑图不是有效 JSON；只允许声明的两种规整"), so a local export could not be compiled, and the Hub's KityMinder
parser does not accept the head either (it strips a BOM only at byte 0).

Change (case-compile 3.8.7 → 3.8.8):

- `normalize-mindmap.ts` also removes the export head U+FFFF U+FEFF, recorded as its own declared transformation
  ("删除 KityMinder 导出文件头 U+FFFF U+FEFF"); two leading U+FFFF are still removed as before; anything else before the JSON is
  still refused.
- `tools/scripts.test.ts`: the real head with a wrapper array normalizes to the root object without rewriting the element; a BOM
  before U+FFFF, and a second BOM after the head, are refused.
- The generator identity follows the pack version (`case-compile@3.8.8`, asserted by the pack test), so the identity row of
  the generated workbook changes. The four typed samples carry that workbook: their recipe digest (G1) and, in the positive
  pair, the workbook digest were recomputed with the pack's own generator from each sample's frozen inputs (scratch script
  outside Git, rows below the identity row unchanged); the positive samples pass the pack's check and the negative ones still
  fail it on the byte digest, as they did.
- README: the declared normalizations; title 3.8.8. The manifest is rewritten (`pack-files.ts --write`).

Allowed paths: `packs/workflow/case-compile/**`, this page.

Verification: `npx tsc --noEmit`; all 49 case-compile test files through `node tools/run-unit-tests.ts files …` (508 passed);
`affected-tests.py --run`. Publishing 3.8.8 is needed for the real compile of a local export (owner's goal of 2026-10-30).
