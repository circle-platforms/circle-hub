## What and why

<!-- One paragraph. The problem, then what this changes. Link the issue if there is one. Say which users are affected. -->

## How it was checked

- [ ] `npm run typecheck` and `npm test` pass, on synthetic fixtures, scripted models and a temporary PostgreSQL; skipped tests are named here, because a skip is not a pass (tests that need macOS or libpq skip on Ubuntu)
- [ ] A change to `docs/`, the root Markdown files or `.github/` passes the docs checks, `node --test ".github/checks/*.test.ts"`
- [ ] Every commit is signed off (`git commit -s`), as the contributor terms in CONTRIBUTING.md require
- [ ] A contract change edits `contracts/model.json`, `contracts/codes.json` or `contracts/src` and regenerates `contracts/generated` with `npm run gen:contracts` in the same pull request
- [ ] A user-facing change has a line under `## Unreleased` in `CHANGELOG.md`
- [ ] Nothing in `foundation/circle` or `references/` changed

<!-- The generic model in contracts/model.json is the design authority. A change that needs to go around it changes the model first. -->
