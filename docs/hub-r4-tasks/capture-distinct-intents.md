# Distinguish operation-capture submission intents

The capture skill makes a work manifest from item count and hashes only that manifest, the session, source references, product and build into `client_key`. Two different proposals with the same session, captures and item count therefore open the same run, even though the skill says each integration is an independent run. A later submission can replace the earlier run's visible result.

Include the exact validated proposal structure in the key via a content digest. A byte-identical validated intent in the same session and context must retain the same key, while a change to the observation, procedure, pitfall, path, quote or item order must change it. Do not put raw captured content or a credential in a key or log. Keep the existing quote, credential, authorization and submission checks intact.

Compatibility: previously published skill bytes and their existing runs stay unchanged. The new key cannot prove whether a submission made by an older skill was accepted when its response was lost; users must reconcile that old run or retry with the original skill before using the new version, rather than blindly creating a new run. Record this limit in the skill and README.

Scope: `packs/workflow/knowledge-contribution/tools/operation-capture/lib/integrate.ts`, its skill instructions and synthetic tests, the pack's generated snapshots, pack manifest/signing tool, README, one new synthetic acceptance test and this task page. Use synthetic data only; bump above the known pending 1.3.6 branch and regenerate/sign with `pack-files.ts --write`.
