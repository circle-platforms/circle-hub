# APV product-line pack

Everything specific to the APV product line lives here, outside the server core: its skill packs, and the product data they use. Another product line gets a folder of its own beside this one; the core does not change.

| Path | What it is |
|---|---|
| `skills/apv-mindmap-compile/` | Compile a test mindmap into the execution workbook for one build. A Circle skill (`SKILL.md`, scripts with Node built-ins only) and a skill pack (`skillpack.json`). It reads the build's command tree, the manuals and ZenTao through circle-server tools. |

Run the skill's tests with:

```
node --test packs/apv/skills/apv-mindmap-compile/tests/compile.test.mjs
```

All test data is made up. Real mindmaps, commands and workbooks stay out of this repository.
