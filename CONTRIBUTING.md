# 怎样参与 circle-hub

先读 [README](README.zh-CN.md) 和[设计](docs/design/README.md)。设计是约束：四个对象各由五样组成；一切可插的东西都是资产；审批只在变更集；运行走执行链；平台不是审批人；产品内容不进核心。一项改动如果要绕过其中一条，先改设计，再改代码。

## 开始之前

- 一般问题和建议写 Issue，说明输入、预期、实际观察和提交号。
- 可能涉及安全或敏感信息的问题按 [SECURITY](SECURITY.md) 处理。
- Circle 的客户端与连接扩展在 [Circle 仓库](https://github.com/qingshanfeihu/circle)维护；技能包和产品线包在各自的 packs 仓库，按[产品线包典范](docs/design/product-line-pack.md)写。

## 环境

Node.js 24。

```sh
npm ci
npm run dev:stack     # 临时 PostgreSQL + server + worker，只绑定本机
```

不需要安装 PostgreSQL：测试和 dev:stack 用嵌入式的临时实例。

## 测试

```sh
npm test              # contracts、methods、acceptance、references
npm run typecheck
```

- 每项行为改变需要能复现原问题的独立样本；不要把旧测试记录或源码摘要当成当前功能通过。
- 验收一律用合成来源、合成设备和开发身份；不连真实系统，不调付费模型，不碰真实设备。真实来源的只读观察单独记录，不写进通过数字。
- 核心守卫测试会扫 `apps/` 和 `packages/` 里的产品名和系统名；连接器层可以出现系统名，不能出现产品线名。

## 改动怎么做

- 新自维护代码使用 TypeScript；依赖写精确版本。
- `foundation/circle` 和 `references/` 的字节冻结：不修改，不从运行入口导入；采用其中的行为要记录来源、许可、修改和新验收。
- 接口改动同时更新 `packages/contracts` 和 `docs/client-api-handoff.md`，写清新旧两种形状；固定版本的 Circle 真实 RPC 测试要继续通过。
- 文档使用自然的中文，接口和代码标识使用清楚的英文。区分已实现行为、已确认方向、提案和未验证范围。

## 提交与 PR

- 明确 stage 要提交的路径；不用 `git add -A`、`git add .` 或 `git commit -a`。
- 提交信息是一句首字母大写的英文祈使句，没有前缀，没有句号。
- 不提交口令、令牌、内网地址、真实业务日志、用户会话或本机绝对路径。
- PR 说明改了什么、为何需要、哪些使用者受影响、实际验证范围。合并、功能验收与发布分开记录。
- 贡献按项目 [MIT](LICENSE) 许可提供；第三方内容附来源、原许可和必要通知。
