---
name: meridian-source-review
description: Report a literal fact from a pinned document of the fictional Meridian line
---

Read inputs.json. Call meridian_docs.get using inputs.file. Save the returned base64 original and its evidence SHA to source.json as {base64,sha256,query}. Run `node .circle/skills/meridian-source-review/scripts/report.ts source.json out/findings.json` using inputs.query. Preserve the source evidence. A literal match proves only that text appears in that source revision; an absent match is unknown. Do not use another product's commands or knowledge.
