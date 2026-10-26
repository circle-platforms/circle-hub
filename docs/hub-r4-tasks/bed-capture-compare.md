# 床态快照原文抓取与基线对比（capture + compare same）

分支 `bed-capture-compare`。通用能力：设备 CLI 回显原文抓取、首尾命令行与提示符字面去除、跑前登记基线字节比对与未登记基线门禁、跑后 pre/post 原文逐字节恢复核验、基线管理命令 `circle-hub bed baseline record/list/show`。

可改路径：

- `contracts/src/resources.ts`
- `contracts/generated/**`
- `hub/dispatch/bed-state.ts`
- `hub/dispatch/bed-state.test.ts`
- `hub/dispatch/cli.test.ts`
- `hub/dispatch/service.ts`
- `hub/dispatch/api.ts`
- `hub/dispatch/README.md`
- `hub/server/cli-job.ts`
- `hub/server/cli-admin.ts`
- `hub/server/cli.ts`
- `hub/server/cli-commands.test.ts`
- `docs/hub-r4-tasks/bed-capture-compare.md`

不连接真实台架，不读环境配置，不使用 7420 和钥匙串。地址只使用 192.0.2.0/24。核心不写产品名、公司名、地址或构建名。
