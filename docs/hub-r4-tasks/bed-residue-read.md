# 上机验证前读取设备残留

分支 `it-bed-residue`。按所有者 2026-11-12 任务书 A2 整理已有改动，执行器可声明只读命令及整行匹配规则。发现残留或读取结果未知时停止上机验证，设备输出只保存在受限证据里。Hub 不清理设备。

可改路径：

- `contracts/src/resources.ts`
- `contracts/generated/schemas/executor.v1.schema.json`
- `hub/dispatch/README.md`
- `hub/dispatch/residue.ts`
- `hub/dispatch/residue.test.ts`
- `hub/dispatch/probes.ts`
- `hub/dispatch/probes.test.ts`
- `hub/dispatch/rounds.test.ts`
- `hub/dispatch/service.ts`
- `hub/dispatch/testing/probes.ts`
- `docs/compatibility.md`
- `docs/compatibility.en.md`
- `docs/hub-r4-tasks/bed-residue-read.md`

检查仅运行 `node --test hub/dispatch/residue.test.ts`。不连接真实设备，不采集真实设备输出，不读取运行环境配置。
