# 任务：PLM 构建列表投影在真实应答上失败

依据：真实层 T4-4（2026-10-27 晚）：Circle 为找问题单读 `plm:builds:<产品编号>`，得到 `SOURCE_READ_FAILED`，管理员理由是 `PROJECTION_FAILED：投影函数报错 plm.no_records：构建列表不是数组；重新读取该产品的构建原件`。重新读也一样，是确定性的。

## 根因（集成者已查清）

真实的构建列表应答带信封：`{"code": 1000, "data": [ {id, product, branch, project, name, scmPath, filePath, date, builder, desc, …} … ], "msg": "success"}`（`code` 1000 是该系统的成功码，`data` 是构建数组）。连接器对 `builds` 路由的 `envelope: when_present` 只核对信封码，把**整个信封**原样交给投影函数（`hub/connectors/http.ts` 的 `#envelope` 处理，`return { ...exchange, json, text }`）。`packs/system/plm/functions/plm.ts` 里 `detailProject` 等都读 `json.data`，只有 `buildsProject`（约 302 行）把 `responses[original].json` 直接当数组用，合成测试和夹具恰好都是裸数组，真实应答一直没被覆盖到。README 里"原件仍保留原样数组"也要核对：原件是整个信封，数组是其中的 `data`。

## 要做的

1. `buildsProject`：构建数组取自 `json` 本身（裸数组，保持兼容）**或** `json.data`（信封，真实形状）；两者都不是数组，才报 `plm.no_records`，说明里写清"应答既不是数组也没有数组形的 data"和下一步。`chooseProduct` 里读产品列表的地方一并核对是否同样只认裸数组（产品列表路由是 `envelope: true`，应已读 `data`，确认并加测试）。
2. 测试（合成，名字用合成的，**不要复制真实构建名和路径**）：新增信封形夹具 `{code:1000, data:[{id, product, branch, project, name, scmPath, filePath, date, builder, desc}], msg:"success"}`，断言：按产品编号读出的 `builds` 与同内容裸数组读出的逐字段相同；`data` 不是数组、`data` 缺失、`json` 是空对象各自仍报 `plm.no_records`（现有的 `badBuilds` 断言保持）；`name` 缺失、需求字段配置等现有 builds 测试全部保持通过（只许加法）。
3. 版本与签名：`packs/system/plm` 升版本并重签（`node packs/system/plm/api.ts check` 看是否需要，按提示 sign）；`README.md` 加一段：构建列表应答带信封，投影从 `data` 取数组，原件保存整个信封。
4. 全量：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2 "packs/**/*.test.ts" "hub/**/*.test.ts" "contracts/**/*.test.ts" ".github/checks/*.test.ts"`（必须是全部，不是只跑 plm），报每一组的数量。

## 分支、路径和规矩

- 分支和工作树：`plm-builds-envelope`，目录 `agy-trees/plm-builds-envelope`（集成者已从 hub-redesign 开出，依赖已链接）。
- 可以改的路径：`packs/system/plm/**`（含测试、README、pack.json 签名）。别的路径要改先说明理由。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰线上 Hub、钥匙串、环境配置文件和真实系统；测试只用合成数据；`git commit -s`，只暂存明确路径；提交说明一句英文祈使句，无前缀无句号）。旧断言不许放松。

完成后在终端里回报：提交号、改了什么、各组测试数量、没做完或拿不准的地方。
