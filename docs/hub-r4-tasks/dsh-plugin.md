# Add the DeepSeek Harness client setup page and compatibility row

DSH becomes a Hub client beside Circle: the plugin `circle-hub-dsh` (separate repository, local commit `f4ad856`) connects to the deployed Hub over the ordinary `/mcp` entry and registers the six tools at runtime. This task changes documentation only: a DSH counterpart of the Circle setup page, one compatibility row in both language versions, and this task page. The plugin code, its tests and the spike evidence live in the plugin repository, not here.

Scope: `docs/hub-dsh-setup.md`, `docs/compatibility.md`, `docs/compatibility.en.md`, this task page.

What the page states and what was verified on 2026-11-02 against main `8dbbef2` (temporary PostgreSQL, synthetic fixtures, no real systems or model keys):

- protocol negotiation reaches `2025-11-25` and the six tools arrive with their annotations; server instructions are 855 bytes;
- an upload through the plugin and through a direct MCP client of the same bytes produces the same `src:<sha256>`;
- `start_run` freezes 67 items and the full `submit_result` is accepted with 67/67 delivered; a submission with an unknown item gets a visible "not accepted" receipt; the `rec:` result reference reads back through `get_nodes`;
- plugin unit tests: 15/15; the install path `dsh plugin --profile circle-hub-dsh add <checkout>` produced the `# == circle-hub-dsh` layer in the composed profile.

Not changed: contracts, `hub/**`, packs, and `docs/hub-r4-progress.md` (the integrator records the decision and the verification counts). The Circle arm of the client comparison is pending an owner-provided Circle build and Hub connection; the control arm and the DSH arm are on the plugin repository's `spike/REPORT.md`.
