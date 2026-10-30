# Put Windows support in TBD and say that the release is macOS and Linux only

The owner put the Hub's Windows support entirely in TBD, with the existing release and publication covering macOS and Linux only, and asked that code be annotated rather than deleted. The trunk already branches on macOS and Linux only, so the change is a platforms section in the compatibility page (both languages), two comments at the platform decision points, and decision 92 with the deferred list.

Allowed paths: `docs/compatibility.md`, `docs/compatibility.en.md`, `docs/hub-r4-progress.md`, `hub/rules/sandbox/isolation.ts` and `hub/rules/sandbox/sandbox.ts` (comments only), this page.

Verification: `npx tsc --noEmit`, `npm run test:docs`, the sandbox tests of `hub/rules`.
