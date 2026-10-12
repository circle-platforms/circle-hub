# 第二阶段对象存储接口

这是通用 B 存储的当前切片，使用认证 API 和真实 PostgreSQL。连接器与 PLM 字段映射尚未接入；当前观察来自具备管理权限的手工导入，`provenance.origin` 为 `manual-observation`。SHA 证明原件字节与引用一致，结构校验不代替来源鉴权、业务映射或修复结论。

所有请求使用平台 `Authorization: Bearer <token>`，成功信封的 `data` 为下表形状。开发身份的权限从 Git 外配置或策略表显式授予；既有 dev:stack 尚未集成新对象目录的示例数据或 objects 权限。对象存储验收在临时环境显式授予测试身份这些权限。

| 路由 | 权限与输入 | data |
|---|---|---|
| `POST /v1/admin/object-types` | `admin.manage` + `objects.manage`；`ObjectTypePackage` | 原定义、SHA、deduplicated |
| `GET /v1/object-types` | `objects.read` | 当前 tenant 注册的类型包数组，附 SHA |
| `POST /v1/admin/objects/observe` | `admin.manage` + 目标 scope 的 `objects.ingest` / `sources.write`；`ObjectObservation` | entity、observation、deduplicated |
| `POST /v1/admin/objects/relations` | `admin.manage` + 关联 scope/两端 scope 的 `objects.ingest`，关联 scope 的 `sources.write`；`RelationObservation` | relationId、relationRevisionId、deduplicated |
| `GET /v1/objects` | `objects.read`；limit、after、typeId、system 可选 | `{items:EntityView[],total,nextCursor}` |
| `GET /v1/objects/{entityId}` | `objects.read`，两层 ACL 与授权 scope 的交集 | `EntityView` |
| `GET /v1/objects/{entityId}/observations` | 当前对象与历史观察各自满足上述权限 | 可见观察数组，按观察时间/修订 ID 倒序 |
| `GET /v1/objects/{entityId}/relations` | 当前对象、关联自身、两端当前观察都可见；limit、after 可选 | `{items,total,nextCursor}`，每项含两端 ID/修订和出处 |
| `GET /v1/sources/{sourceRevisionId}/content` | `sources.read`；关联到对象/关系的原件另外核对其当前与历史 ACL、`objects.read` | 原件字节，继续核对 SHA |

读取目录中的 total 只计可见记录；过滤在截取页之前执行。limit 缺省 20，范围 1–100；after 为上一页 nextCursor，实体与关联分别按自身 ID 倒序；空页 nextCursor 为 null。计数和页内容使用同一个只读重复读快照，避免并发权限/观察变化产生不一致的页。

类型包为 `{id,version,types:[{id,attributes,required}]}`。字段类型可声明 string、number、boolean、string[]、object、any；必填字段必须已声明，输入里的未声明字段被拒绝。同一 tenant/id/version 的不同内容拒绝为 `IDEMPOTENCY_MISMATCH`，改变词表需发布新版本。内置专业词表位于 `packages/object-types/src/enterprise-v1.ts`，存储引擎按声明校验，支持注册自定义类型而无需改核心。

ObjectObservation 包含 scopeId、observationKey、type、attributes、source、acl。type 是 `{packageId,version,typeId}`；source 是 `{system,objectType,externalId,revision,contentBase64,sha256?}`；acl 是 `{sourceReaders,platformReaders}`，每层为平台 principal ID 数组。`*` 表示该层对 scope 内已具备读取权限的身份开放；空数组拒绝所有读取。当前 trusted 管理导入提供这两层 ACL，后续连接器负责据真实来源权限建立来源层，当前没有调用镜像来实时核验。

对象身份由 tenant/scope/system/来源类型/外部编号共同确定；来源不同或对象类型不同的同号记录不会合并。每个新 observationKey 生成不可变 entityRevisionId，保留来源修订、类型包版本、原件引用与观察时间；重复相同键和内容复用观察，改变内容为 `IDEMPOTENCY_MISMATCH`。数据库中的来源登记、观察、当前指针和审计同事务提交；原件文件按内容地址不可变保存。没有修改历史观察的 API。

EntityView 含 entityId、entityRevisionId、scopeId、type、source、attributes、provenance。provenance 含 observationKey、observedAt、observerId、origin、raw；raw 沿用 SourceReference 的 sourceRevisionId、sha256、size、fileName、scopeId。观察数组另外直接返回 observationKey 与 raw。权限数组不出现在普通读取结果中。

RelationObservation 除 scopeId、observationKey、source、acl 外，声明 type、fromEntityId、toEntityId。每次观察保留 relationRevisionId 与原件。相同来源关联身份不允许改配到另一组端点；需要新来源身份表达另一条关联。

对象不存在、范围不可见和 ACL 不允许对普通读取统一返回 404 `OBJECT_NOT_VISIBLE`，相同 code/message/details；缺 `objects.read` 为 403 `FORBIDDEN_ACTION`，平台 token 无效为 401。输入结构错误为 400 `INVALID_PAYLOAD`；管理导入的未知类型版本为 404 `TARGET_NOT_FOUND`，原件 SHA 不符为 409 `SOURCE_HASH_MISMATCH`。管理写入仍按明确 scope 检查，拒绝为 `FORBIDDEN_SCOPE`。

这个切片没有实现 PLM、Bugzilla 或 HTML 来源桩、个人 JWT 存储/注入、来源缺失缓存、账号映射、三种业务阅读方法、订阅或能力转正。后续以简报的更新范围和已脱敏来源探测为准。
