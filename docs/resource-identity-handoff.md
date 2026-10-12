# 执行资源身份与原件分发

C 登记服务客户端、签发短期访问令牌和内省；客户端绑定一个 D 资源资产和 scope。资源资产可以是 connector-instance/environment-resource。B 保存已批准来源原件，平台不解释规则内容。

## 客户端管理

普通管理请求带平台 Bearer，要求 service-clients.manage；登记还须 assets.read。接口使用平台信封：

| 接口 | 请求与结果 |
|---|---|
| POST /v1/service-clients | `{scopeId,resourceAssetId,name,secret,scopes,resourceScopes}`，返回 clientId/principalId/scopeId/resourceAssetId/name/scopes/resourceScopes/secretVersion/revoked |
| GET /v1/service-clients | limit 默认20，范围1–100，after=clientId；返回 items/nextCursor，仅同 tenant 授权 scope |
| GET /v1/service-clients/{id} | 上述元数据，不返回密钥 |
| POST /v1/service-clients/{id}/rotate | `{secret}`，同 id、新 secretVersion；旧密钥不能认证，旧代次令牌 inactive |
| POST /v1/service-clients/{id}/revoke | `{}`，客户端身份和令牌失效，不能轮换重新启用 |

secret 由用户在仓库外产生，32–2048 字符，只保存盐化 scrypt 摘要，不进配置、日志、审计或普通 API 返回。scopeId 是平台范围；scopes 是该客户端的 OAuth 权限，resourceScopes 是 C 可委托给本资源的外部权限，两者不会自动授予平台用户权限。核验并读取规则的客户端 scopes=[introspect,bundles:read]；执行权限在 resourceScopes 另声明，由对应适配模块请求子集。返回的 principalId 用于显式加入原件资产 readers。

## 标准协议

`POST /token` 带 Basic，表单 `grant_type=client_credentials&scope=bundles:read`，返回顶层 `{access_token,token_type:"Bearer",expires_in,scope}`，最多300秒，无 refresh_token。请求 scope 必须是登记 scopes 的子集；该令牌不能访问平台 tasks/审批/资产管理。

`POST /v1/introspect` 带有 introspect 权限的客户端 Basic，表单 `token`（允许 token_type_hint）；返回顶层 `{active:true,sub,scope,exp}`，用户主体还带 C 身份源 username，服务主体省略。scope 为空格分隔，exp 为 Unix 秒。未知、过期、吊销、非本资源客户端、旧 fence、租约失效、输入换版、普通执行取消或主体禁用，均仅返回 `{active:false}`。

这两个端点不包 apiVersion/status/data。Content-Type=application/x-www-form-urlencoded；Basic 中 id/secret 各自 URL 编码后再 Base64，禁止重复表单字段。响应 no-store/no-cache。认证失败401且带 WWW-Authenticate=Basic，权限不足403，坏表单400；OAuth error 字符串包括 invalid_client/invalid_scope/unsupported_grant_type/invalid_request/server_error。协议依据 [RFC 7662](https://www.rfc-editor.org/rfc/rfc7662) 和 [RFC 6749](https://www.rfc-editor.org/rfc/rfc6749)。

执行令牌没有公共“指定 sub”接口。C 在已授权操作的当前 D 租约下签发，绑定调用者、tenant/scope、客户端/资源、operationId/fence、输入修订与截止时间；worker 得私有 vault 引用，值不进任务输入/输出/事件/审计。每次请求资源前重查 C/D，临期重签，无设备授权或个人刷新令牌。CIRCLE_SERVER_RESOURCE_TOKEN_TTL_SECONDS 默认300，范围1–300。独立核对使用新的 reconcile 操作、另一 worker 和 fence，不重新投递。资源端既有内省缓存最多30秒，平台失效不表示已有远端缓存已清除；平台自己的调用仍先重查权限。

## 原件与规则

依次 POST /v1/sources 上传原字节、POST /v1/assets 登记 knowledge-source、另一人 lifecycle approved。configuration 的例子：

```json
{
  "schema": "external-source-artifact/1",
  "metadata": {"bindings": {"build": "<资源使用的构建键>"}},
  "files": [{"path": "projections/domain_grammar.json", "role": "resource-rules", "sourceRevisionId": "<上传 id>", "sha256": "<原字节 SHA-256>"}]
}
```

资产声明 reads=[registered-source]、writes=[]、credentials=[]，readers 显式包含所有者、批准者和服务客户端 principalId。path/role 是消费者约定，bindings 是通用命名空间选择器，不解释产品语义；稳定 sourceArtifactId 也可直接作为选择器。多个可见来源使用同一选择器时拒绝，应明确传来源 id。

GET /v1/builds/{build}/bundle 带 bundles:read 客户端 Bearer，直接返回 `{sourceArtifactId,assetId,version,sha256,entries:[{path,sha256,size,mediaType}]}`。GET /v1/blobs/{sha} 同认证，返回原字节和 x-content-sha256；只在当前已批准且可读的来源中找，不开放全局 CAS。隐藏/缺失统一 SOURCE_FORBIDDEN，停用/权限收回使下载失效；回读再核 SHA，即使非 JSON 也按字节交付。命令树、函数契约和规则可放同一集合；buildName/bindings 只是声明，实际床构建仍须 env_prepare 核对。资源使用本地缓存是其既有行为，平台不判断缓存内容的语义。

## 执行接入与 HTTPS

资源资产 configuration.serviceClientId 引用客户端 id，以新资产版本独立批准；该模式 declaration.credentials 为空、执行 profile 不配外部 issuer。现有受理、命令证明、任务审批和投递前核对保留。客户端密钥给资源端用于 Basic 内省/读原件；平台调用资源使用自己签发的短期用户令牌。

CIRCLE_SERVER_TLS_CONFIG 可指向仓库外 `{certFile,keyFile}`，server 原生 HTTPS；证书、密钥和运行时路径不进 Git。仍仅监听 127.0.0.1。worker 和 admin CLI 接受 http://127.0.0.1 或 https://127.0.0.1，拒绝远端、URL 内嵌凭据和重定向。TLS 保留 Node 默认 CA 与主机名核验；自签 CA 通过启动进程时的 NODE_EXTRA_CA_CERTS 指向仓库外 CA 文件。仅设置 server 的证书/密钥不会自动让客户端信任它，也不在已运行进程中动态修改信任。

本机完整开发栈可以这样启动，示例路径须换成仓库外运行配置：

```sh
CIRCLE_SERVER_TLS_CONFIG=../runtime-config/server-tls.json \
NODE_EXTRA_CA_CERTS=../runtime-config/ca.pem \
npm run dev:stack
```

bootstrap 请求、两个 worker 及 admin 子进程使用相同的启动信任；无界面 Circle 的精简环境只补传 NODE_EXTRA_CA_CERTS，不复制 TLS 私钥或关闭校验。ready.url 是实际 HTTPS 地址。验收覆盖 PostgreSQL + server + worker 的登录/受理/原件下载/回报/产物 SHA、HTTPS 下优雅重启和固定 Circle 的真实工具操作；未信任 CA、主机名不匹配均拒绝，不能用只产生文件替代工具实际完成的证据。

用户已选择由 Mac 发起 SSH 反向隧道：网关主机的 127.0.0.1 端口转发到 Mac 的本机监听端口，转发 TLS 原字节，不在 server 开放外部监听，也不改为 HTTP 或增加反代。可按仓库外设置的用户/主机/端口准备命令：

```sh
ssh -N -T -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -R "127.0.0.1:${CIRCLE_TUNNEL_PORT}:127.0.0.1:${CIRCLE_LOCAL_PORT}" \
  "${CIRCLE_TUNNEL_USER}@${CIRCLE_TUNNEL_HOST}"
```

CIRCLE_LOCAL_PORT 取实际 server 端口，不取开发栈请求随机端口时的 0。隧道由用户建立；用户按维护者准备的内容修改网关配置，并核对远端仅监听回环。网关连接 https://127.0.0.1:<隧道端口> 时，server 证书需有 IP:127.0.0.1 的 SAN，网关进程另行信任同一 CA。资源端地址/client id/私有密钥文件/CA 都只在运行时提供。本代理未开隧道、未更新真实栈或网关，真实 env_prepare 和床构建仍待此部署后核对。
