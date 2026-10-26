# 文本表格床面快照与基线收窄

分支 `bed-text-table`。通用能力：设备 CLI 原始文本的表头匹配与定长切列解析、按所属设备收窄地址基线、配置通道快照对比与基线声明门禁、FAMX 产品包通用 CLI 表格声明。

可改路径：

- `contracts/src/resources.ts`
- `contracts/generated/**`
- `hub/dispatch/bed-state.ts`
- `hub/dispatch/bed-state.test.ts`
- `hub/dispatch/service.ts`
- `hub/dispatch/README.md`
- `packs/workflow/test-bed/functions/surface.ts`
- `packs/workflow/test-bed/functions/surface.test.ts`
- `packs/workflow/test-bed/tables/bed-surface.json`
- `packs/workflow/test-bed/pack.json`
- `packs/workflow/test-bed/pack-files.ts`
- `packs/workflow/test-bed/README.md`
- `packs/product/famx/tables/bed-surface.json`
- `packs/product/famx/functions/bed-surface.test.ts`
- `packs/product/famx/pack.json`
- `docs/hub-r4-tasks/bed-text-table.md`

不连接真实台架，不读环境配置，不使用 7420 和钥匙串。地址只使用 192.0.2.0/24。核心不写产品名、公司名、地址或构建名。
