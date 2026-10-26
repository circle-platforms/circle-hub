# 床面声明与环境不可达

分支 `bed-declarations`。床面语义是 test-bed 的声明形状；产品包填写探针和清理命令。编译期拒绝盲网段和台架外地址。

可改路径：

- `packs/workflow/test-bed/functions/surface.ts`
- `packs/workflow/test-bed/functions/surface.test.ts`
- `packs/workflow/test-bed/functions/facts.ts`
- `packs/workflow/test-bed/functions/conclude.ts`
- `packs/workflow/test-bed/functions/check-bed.ts`
- `packs/workflow/test-bed/functions/project.ts`
- `packs/workflow/test-bed/tables/bed-surface.json`
- `packs/workflow/test-bed/api.ts`
- `packs/workflow/test-bed/pack-files.ts`
- `packs/workflow/test-bed/pack.json`
- `packs/workflow/test-bed/pack.test.ts`
- `packs/workflow/test-bed/README.md`
- `packs/product/famx/tables/bed-surface.json`
- `packs/product/famx/functions/bed-surface.test.ts`
- `packs/product/famx/pack.json`
- `packs/workflow/case-compile/functions/bed.ts`
- `packs/workflow/case-compile/functions/bed.test.ts`
- `packs/workflow/case-compile/functions/checks.ts`
- `packs/workflow/case-compile/tables/codes.json`
- `packs/workflow/case-compile/tables/workbook-format.json`
- `packs/workflow/case-compile/requirements.json`
- `packs/workflow/case-compile/pack-files.ts`
- `packs/workflow/case-compile/pack.json`
- `packs/workflow/case-compile/pack.test.ts`
- `packs/workflow/case-compile/publish.test.ts`
- `hub/dispatch/bed-state.ts`
- `hub/dispatch/bed-state.test.ts`
- `hub/dispatch/service.ts`
- `hub/dispatch/README.md`
- `docs/hub-r4-tasks/bed-declarations.md`

不连接真实台架，不读环境配置，不使用 7420 和钥匙串。地址只使用 192.0.2.0/24。清理命令只出现在声明里，Hub 不执行。
