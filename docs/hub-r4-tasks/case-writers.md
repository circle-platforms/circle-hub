# Case writers

Owner scope: task A5 of the November 12 brief.

Allowed paths: `packs/workflow/case-compile/tools/case-writers/**`, `packs/workflow/case-compile/{SKILL.md,README.md,pack.json,pack.test.ts}`, and this page.

The Circle extension starts one writer per case and returns their files and reports. Content checks stay at the Hub. The extension reads the client task tool through model middleware; that client interface is not a documented extension API. Installation and real-client verification remain pending.

Check: `node --test packs/workflow/case-compile/tools/case-writers/extension.test.ts`.

Follow-up scope: narrow only the local `setStatus` lamp type to its used value. No test or manifest change; the integrator versions and signs the published bytes.
