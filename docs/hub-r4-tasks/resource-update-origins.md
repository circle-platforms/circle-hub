# 任务：资源更新地址时自动清理失效明文放行与新增 --clear-plaintext

依据：

- 真实层 T9-1a 阻塞排查：`circle-hub resource update` 更换 `--origin` 时，旧的 `allow-plaintext` 条目会挡住更新（`ResourceRecord` 要求 `allow_plaintext` 必须匹配现行 origin 的基础地址，但旧条目留在资源定义中，此前又无命令清空旧条目）。
- 规则：
  1. `--origin` 整项替换时，`--allow-plaintext` 也按“整项替换”处理：给了就用给的（必须与新 origin 匹配）；没给且旧条目对应的角色在新 origin 里已不存在或地址变了，就清掉这些旧条目（并在输出里写明清掉了哪些角色）；没给且角色与地址未变则保持。
  2. 新增 `--clear-plaintext` 显式清空所有明文放行。
  3. 规则不变：凭据不经明文 HTTP 发送，任何放行都必须与现行 origin 精确匹配。
- 分支和工作树：`resource-update-origins`，目录 `circle-trees/resource-update-origins`。
- 本任务可修改路径：
  - `hub/connectors/resources.ts`
  - `hub/connectors/resources.test.ts`
  - `hub/server/cli-admin.ts`
  - `hub/server/assemble/README.md`
  - `hub/server/assemble/cli-admin.test.ts`
  - `docs/hub-r4-tasks/resource-update-origins.md`
- 验证要求：
  - 换 origin 后旧放行被清掉并告知；
  - 只改名字或设置时放行不变；
  - `--clear-plaintext` 显式清空；
  - 新 origin 为明文且给了匹配的 `--allow-plaintext` 成功；
  - 不匹配被拒并写明缺什么；
  - 旧测试一个字不改；
  - 合入前全量测试（contracts, docs, hub, packs, acceptance 并发 2）。
