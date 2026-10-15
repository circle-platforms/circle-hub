# APV product-line pack

The remaining first-phase compatible methods and declaration data live here, outside the server core. The compilation skill is maintained and released in the independent circle-packs repository. Its source and tests are no longer copied into this server tree.

| Path | What it is |
|---|---|
| `contracts.ts`, `methods/`, `runtime/` | Preserve the first-phase mindmap compilation API |
| `runtime/execution-history-*.ts` | The unchanged deployed migration and the read-only legacy receipt guard; no native execution driver |
| `product-line.json` | Connector aliases, parsing policy and knowledge mappings; future module migration remains separate |

Install the independently versioned compilation module using the generic installer:

```
node apps/server/src/cli.ts modules check --catalog ../circle-packs/modules.json --module apv-mindmap-compile
node apps/server/src/cli.ts modules install --catalog ../circle-packs/modules.json --module apv-mindmap-compile --scope scp_lab --trial <runtime-trial.json>
```

The CLI freezes and checks every listed module file and digest, then submits through ordinary trial and independent approval. Installation does not automatically approve or run it. See [module installation](../../docs/module-installation.md). Runtime sources, credentials and real workbooks remain outside Git.

Native `apv-case-execute` and its `cases.*` operations are retired. Execute APV work through the separately versioned products/apv module and `module-execute`; historical tasks keep their original method and result bindings.
