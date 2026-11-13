# Third-party notices

The project's own code, documentation, synthetic samples and interface assets are released under the [Apache License 2.0](LICENSE) in the root of the repository; until 2026-10-13 they were under the MIT License, as [NOTICE](NOTICE) records. The content holder has confirmed the right to publish the complete platform archive that is the project's own. Third-party content is not relicensed by the root license.

## The shared Circle baseline

Code adapted from the Circle baseline derives from the public [Circle repository](https://github.com/qingshanfeihu/circle) at commit `9d23c09a0f8de2f71920b32b23db9af6c9a41100` (previously mirrored locally under `foundation/circle`, removed from the working tree on 2026-11-13). Its [MIT license](https://github.com/qingshanfeihu/circle/blob/9d23c09a0f8de2f71920b32b23db9af6c9a41100/LICENSE) and [third-party notices](https://github.com/qingshanfeihu/circle/blob/9d23c09a0f8de2f71920b32b23db9af6c9a41100/THIRD_PARTY_NOTICES.md) remain in effect for adapted and historical content.

The compressed model catalogs in `src/data/` of that upstream baseline (and earlier Git history) contain metadata derived from models.dev; the original MIT notice and copyright are in the third-party notices linked above. Keep that notice when adopting or distributing that content.

Circle's earlier Git history is kept as well. The licenses and notices of each historical version belong to their source; the current root files do not replace them.

## The platform references

The archive of the platform that preceded the hub was removed from this repository on 2026-10-30 and is no longer distributed with it.

External products, project names, source links, trademarks and method descriptions in the research documents keep their own ownership. Linking to a public repository or studying how it works confers no trademark right and does not bring that product into this project's license.

## Asciidoctor.js

Asciidoctor.js (`@asciidoctor/core`) version `4.1.1`, as recorded in `core.mjs`, is bundled in `packs/product/famx/functions/adoc/vendor/` for the FAMX pack's AsciiDoc producer. The engine is in `core.mjs`, with the adapter's type declarations in `core.d.mts`.

The engine is used under the MIT License. Its complete license and copyright notice are kept in [LICENSE.txt](packs/product/famx/functions/adoc/vendor/LICENSE.txt); the root license does not replace them.

## Dependencies and the actual artifacts

The root package's current direct dependencies are `@modelcontextprotocol/sdk@1.32.2`, `pg@8.23.1`, `zod@4.6.7`, `exceljs@4.4.0`, `fflate@0.8.3`, `read-excel-file@9.3.14` and `parse5@8.1.0`, each used under the MIT license of its published package, `saxes@6.0.0` under its ISC license, and `typescript@6.0.3` under the Apache License 2.0. Development dependencies are `embedded-postgres@18.4.0-beta.17` (MIT) and type declarations (MIT). The actual PostgreSQL binaries and their upstream components follow their own licenses, which the wrapper's MIT license does not replace.

Exact versions, download integrity and transitive dependencies are in the root `package-lock.json`. ExcelJS's uuid dependency is pinned by an override to `11.1.1`, which supports the same CommonJS v4 API and fixes the out-of-bounds advisory that npm audit reported; the lockfile currently has no reported vulnerability. A composition check describes the dependencies of this moment and promises nothing about future advisories. No `node_modules` and no server artifact is included.

The historical lockfiles of the shared baseline and of the reference packages in earlier Git history recorded their original dependencies; they were removed from the working tree and are not used by the Hub's entry points.

When adopting a module, check the dependencies actually used, and ship the corresponding licenses and notices with the artifact. Special cases in the current root `package-lock.json` are `jszip@3.10.2`'s license choice (`MIT OR GPL-3.0-or-later`) and `pako@1.0.11`'s `MIT AND Zlib` (both pulled transitively by `exceljs@4.4.0`); historical reference lockfiles removed from the working tree also recorded `lightningcss`'s `MPL-2.0`, `caniuse-lite`'s `CC-BY-4.0`, and `unionfs@4.6.0` (whose lockfile lacked a license field while its npm tarball contained an Unlicense LICENSE). None of them can be turned into the project's license.

No license field or `LICENSE` file is present in the npm metadata, lockfile entry or installed files of `buffers@0.1.1`, which is an active transitive dependency of the root package (`exceljs@4.4.0` -> `unzipper@0.10.14` -> `binary@0.3.0` -> `buffers@0.1.1`), rather than being limited to the removed reference packages. Obtain a license basis or replace or remove that dependency path before distributing an artifact that bundles `exceljs@4.4.0`.

This page is not a file-by-file notice list of every dependency. The first software release needs a composition and notice list generated from the actual artifact.
