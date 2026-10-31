# 任务：把"台架"改称"自动化测试环境"

依据：所有者 2026-10-31「改成自动化测试环境」，是对"产品里的写法要不要统一改"的答复。"台架"是 10-22 起草文档时对 bed 的译名，不是所有者的说法；所有者自己的说法是"自动化 103 环境"。

- 分支和工作树：`rename-test-environment`（从 hub-redesign 94b1f8dea 开出）。
- 改动：
  - 面向人的中文里，"台架"一律改成"自动化测试环境"；指整个环境的"整台"改成"整个自动化测试环境"或"全部设备"。量词跟着改，例如"这台台架""每台台架"改成"这个/每个自动化测试环境"。
  - 英文标识不动：包名 test-bed、租约键 `bed/<名>/<设备>`、清单 schema、字段名 bed。Hub 已存的记录只追加，不改。
  - 引号里的原话不动：进度页决定 95 的来源是所有者原话，决定 103 的来源引了当时问题的标题。
  - references/ 和 foundation/ 不动。
  - 通用模型 `contracts/model.json` 里 7 处只改措辞，不改语义；生成物里没有这个词，`npm run gen:contracts` 之后生成物应当不变。
  - 包升版：
    - case-compile 3.9.6→3.9.7。3.9.6 没发布过，3.9.7 包含 3.9.6 的全部改动；
    - test-bed 1.2.9→1.2.10；
    - knowledge-contribution 1.3.12→1.3.13；
    - source-read 0.1.1→0.1.2；
    - recompose、recompose-authority、recompose-adjudication 一起从 1.0.1 升到 1.0.2。`testing/gen-recompose.ts` 复制进阶段包的副本里有两条改名的提示；`functions/recompose-evidence.ts` 只认同一版本的阶段证据，所以照 3.8.10 的先例，这个写死的版本也改到 1.0.2。涉及父目录的这个文件、三份副本、`testing/recompose.ts` 和 recompose 的样例。三个包各自用 `api.ts sign` 签名。生产上没有重组运行。

    版本文件、case-compile 的样例（`testing/samples.ts`）和清单（`tools/prepare-packs.ts`）都要重新生成。case-compile 的 SKILL.md 要保持在 8000 字以内，靠压缩说了两遍的话，不删规则。
- 可以改的路径：含这个词的文件（`docs/`、`packs/`、`scripts/`、`hub/`、`tests/`、`contracts/model.json`）、四个包的版本文件、样例和清单、本页。
- 规则：用合成数据；`git commit -s`。生产上的包发布和 Hub 部署要所有者逐次同意（G3）。
- 验证：
  - `npx tsc --noEmit`、`npm run verify:contracts`、`npm run test:docs`；
  - 四个包的测试和 `packs/workflow/case-review/packs.test.ts`；
  - `hub/dispatch`、`hub/knowledge`、`hub/server` 的受影响测试，验收场景 25、28、42；
  - 部署前跑整套检查。
