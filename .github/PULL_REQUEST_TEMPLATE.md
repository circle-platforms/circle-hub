## What and why

<!-- One paragraph. The problem, then what this changes. Link the issue if there is one. Say which users are affected. -->

## How it was checked

- [ ] `npm run typecheck` and `npm test` pass, on synthetic sources and a temporary PostgreSQL
- [ ] Every commit is signed off (`git commit -s`), as the contributor terms in CONTRIBUTING.md require
- [ ] An interface change updates `packages/contracts` and `docs/client-api-handoff.md` in the same pull request
- [ ] A user-facing change has a line under `## Unreleased` in `CHANGELOG.md`
- [ ] Nothing in `foundation/circle` or `references/` changed

<!-- The design in docs/design is the standard. A change that needs to go around it changes the design first. -->
