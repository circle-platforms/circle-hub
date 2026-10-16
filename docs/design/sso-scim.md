# 企业登录与目录

开发身份只用于显式打开的合成环境。企业登录用 OIDC。目录同步用 SCIM 的映射说明；本仓库不提供 SCIM 服务。

## OIDC

配置 `CIRCLE_HUB_OIDC_CONFIG`，JSON 含 `issuer`、`clientId`、`clientSecret`、`authorizationUrl`、`tokenUrl`、`redirectUri`、`publicKeyPem`。四个地址都只能是回环上的 `http` 或 `https`（`127.0.0.1`、`localhost`、`[::1]`），不能带用户信息，令牌请求不跟随重定向。

`GET /v1/auth/oidc/start` 返回授权地址和 `state`。`POST /v1/auth/oidc/callback` 用授权码换 `id_token`，只接受配置公钥能验过的 RS256。`iss`、`aud`、`nonce` 和 `exp` 必须吻合。`sub` 先对 `policies.oidc_sub`，没有再对用户名等于 `email`。没有对应的人，或对应到多于一个人，都是 `UNAUTHENTICATED`。通过后签发与开发登录相同形状的会话令牌。

未配置时，开始登录是 `TARGET_NOT_FOUND`。

## SCIM

SCIM 2.0 的 Users 和 Groups 只作为以后的目录映射，当前没有 SCIM 端点。

| SCIM | hub |
|---|---|
| User.id | `policies.oidc_sub` |
| User.userName | `policies.username` |
| User.active = false | `policies.disabled` |
| Group 的显示名 `manager`、`security`、`dpo`、`legal`、`finance`、`hr`、`it` | 该范围的审批角色 |
| 其他 Group | 不授予管理员、成员或访客 |

基础角色仍由范围变更集决定。SCIM 组不直接写成管理员。审批角色的授予在实现目录同步时也要留下变更记录，而不是由目录推送静默生效。

---

本文是 circle-hub 的设计规范之一，按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hans) 授权：引用、借鉴须署名 Circle Hub 与 qingshanfeihu 并注明原始出处链接。见[设计规范索引](README.md#许可)。
