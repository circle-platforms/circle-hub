# Reuse the reviewed unit runner

The owner requested reuse of the existing unit-test-time work instead of repeatedly running the slow full suite.
This branch incorporates that existing work; it adds no new optimization. Antigravity's two parser-bounds findings are
addressed by sending that partition directly to one test worker, without starting the shared PostgreSQL cluster.
Existing assertions, time limits and skip conditions remain unchanged.

The runner's own tests and TypeScript check passed locally. Full runs are reserved for MODE: full, deployment and CI;
ordinary changes use the integrator's affected-tests script. The optimized runner is not production availability evidence.
