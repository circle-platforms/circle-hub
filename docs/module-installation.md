# 独立模块的冻结与受治理安装

> **历史文档**（2026-10-21 标注）：本文描述已退役服务器的模块安装（`modules.json`），现行代码里已不存在，只作记录保留；现在的分发单位是任务包，见[通用模型](design/generic-model.md)。

技能和产品线可以来自独立仓库。平台读取 `circle-packs/modules/1` 清单及模块原字节，不执行清单生成器、安装脚本、测试或其他模块代码。安装是提交待批定义，不能代替试跑或独立批准。

## 清单与本地入口

根 `modules.json` 的形状为 `{schema:"circle-packs/modules/1",modules:[{id,kind,root,manifestPath,version,files:[{path,sha256}],digest}]}`。skill-pack 的 root/manifestPath 为 `skills/<id>` / `skills/<id>/skillpack.json`，product-line 为 `products/<id>` / `products/<id>/product-line.json`。id 必须与目录和自身清单一致，version 必须与自身清单一致；产品线声明使用 `product-line/1`。

files 是模块目录下全部非隐藏文件，包含 references 和 tests，path 相对模块根。顺序使用清单生成器的字符串排序，不依赖本机语言区域。digest 为每行 `<sha256>  <path>\n` 拼接后的 SHA-256。检查精确文件集、全部原字节摘要和 digest，拒绝未列文件、缺失文件、重复路径、隐藏路径、不安全相对路径和符号链接。单个模块最多 100 个文件、1000 个子目录，总原字节最多 16 MiB；本地读取前按剩余预算检查文件大小。清单中的空文件原样保留，公开 sources 上传接口仍要求非空。

在 server 仓库中用 Node.js 24 执行：

```sh
node apps/server/src/cli.ts modules check --catalog ../circle-packs/modules.json --module <id>
node apps/server/src/cli.ts modules install --catalog ../circle-packs/modules.json --module <id> --scope <scopeId> --trial <runtime-trial.json>
```

check 只读并打印 moduleId/kind/version/digest/fileCount。install 在本地一次冻结并校验文件，再发送封存内容；后续运行从 B 取已批准的原件，不重新读本地仓库。CLI 不修改模块仓库，输出不包含本机路径或令牌。

运行时提供 `CIRCLE_HUB_URL`、`CIRCLE_HUB_TOKEN` 或 `CIRCLE_HUB_TOKEN_FILE`；scope 可用 `--scope` 或 `CIRCLE_HUB_SCOPE`。远端地址要求 HTTPS，回环开发地址可用 HTTP。自签证书信任可用仓库外 `CIRCLE_HUB_CA_FILE` / `CIRCLE_HUB_CA_SHA256`，不绕过证书核验、不跟随重定向。地址、凭据、试跑原件和业务文件不得提交进公开 server 仓库。

## HTTP 与批准

`POST /v1/modules/install` 用既有 Bearer 身份，body：

```json
{
  "module": {"id":"<id>","kind":"skill-pack","root":"skills/<id>","manifestPath":"skills/<id>/skillpack.json","version":"<version>","files":[{"path":"<模块内路径>","sha256":"<原字节 SHA>"}],"digest":"<清单 digest>"},
  "files": [{"path":"<模块内路径>","base64":"<原字节 base64>","sha256":"<原字节 SHA>"}],
  "trial": {"toolCalls":[{"name":"<规范工具名>","argsSha256":"<参数 SHA>","ok":true}],"outputs":[{"path":"<输出路径>","sha256":"<输出 SHA>"}]}
}
```

`X-Scope-Id` 与技能包提交相同：只有一个授权 scope 时可省略，多 scope 必须明确。F 契约为 ModuleCatalog/ModuleEntry/ModuleBytes/ModuleInstallRequest，路由在 CLIENT_ROUTES.moduleInstall。成功使用既有信封，HTTP 201；错误格式及 scope/权限规则沿用第一阶段。

skill-pack 必须带真实试跑记录，复用技能提交、工具目录检查、独立审批任务和后续 RPC 运行。响应含 moduleId/kind/version/digest、skillPackId、skillPackDigest、status、check、approvalTaskId、assetId/assetVersion/lifecycle。digest 是模块文件清单摘要，skillPackDigest 是既有技能提交摘要，后者同时绑定 manifest、文件、试跑和 module 定义；审批任务使用后者。status 是技能登记状态，lifecycle 来自当前资产，重复安装不会把已停用资产自动启用。试跑记录是客户端声明，机械核验不证明业务正确。新增可选 module 也可随原 `POST /v1/skillpacks` body 提交，服务端同样重新验证；不带 module 的原接口及摘要行为保持兼容。

product-line 不要求技能试跑；全部文件作为普通 knowledge-source 的封存原件登记，metadata 保存 module 与 manifest。响应含 moduleId/kind/version/digest、assetId/assetVersion/lifecycle/assetSha256，初始 draft。同 scope 的 assets.approve 审批人可发现并独立批准。此入口不激活产品线、不 import 可执行代码、不修改运行配置；运行时选择产品线仍由已授权的部署操作配置 `CIRCLE_HUB_PRODUCT_LINES`。资产批准只确认定义和字节绑定，不保证产品语义，也不批准其声明的技能运行。

批准后的技能继续通过 `POST /v1/skillpacks/{id}/runs` 受理。提交、批准和运行再次核对目录、修订及权限。安装不会自动批准、授权、启动 bot、花费模型费用或执行真实系统操作。

FAMX 编译技能的权威来源是独立 circle-packs，server 内旧 `packs/famx/skills` 副本已删除。现存第一阶段编译能力及接口继续兼容；其剩余产品方法适配器与技能模块的治理入口分开。
