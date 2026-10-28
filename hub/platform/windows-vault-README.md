# Windows 用户范围密钥存储（待 Windows 验证）

此分支实现独立适配，未接入默认密钥工厂，未证明 Windows 部署可用。依赖由集成任务固定为 Circle 现用的 `koffi` 3.3.3；仅 Windows 原生适配模块在运行时加载它。没有 Electron 依赖，没有 Linux 或 macOS 回退。

## 已核对的 Circle 调用链

只读核对了 Circle 的 `apps/desktop/src/encrypted-credentials.ts`、`main.ts`、`runtime-supervisor.ts`、`runtime-private-channel.ts`，以及 `src/settings.ts` 和 `src/extension_secrets.ts`。不存在 `src/credentials/` 目录，不能把它当作已读实现。

桌面主进程在启动 runtime 时把 `EncryptedCredentialStore` 注入 `RuntimeSupervisor.onCredentials`。utility runtime 的私有 `credential-request` 经校验后交给 store，reply 不把异常原文传回；renderer 没有读取密钥的 IPC。store 将身份 SHA-256 用作文件名，`safeStorage.encryptString` 的结果存为二进制文件，并对同一身份串行、临时文件加 rename；它拒绝不可用加密和 Linux `basic_text`。`main.ts` 的 cipher 实际来自 Electron safeStorage，不能在无头 Node 服务中直接调用。CLI `settings.ts` 的 credentials JSON 和 extension secrets JSON 是不同路径，不能冒充相同的 OS 密文机制。

本实现复用 OS cipher 与密文文件分层、身份哈希命名、加密失败拒绝读取的做法。未复制 Circle 代码或其文件内容。没有声称原生 DPAPI 密文与 Electron safeStorage 的字节格式相同；本实现封套为版本 1 JSON，含 SID/service/account 与 base64 DPAPI 密文。密文内部再绑定这些身份的 SHA-256 和 32 字节 key，防止换名、换账户、跨用户复制被接收。它不是 Circle 原有二进制 envelope 的兼容读取器。

## 原生边界与服务身份

- `windows-dpapi.ts` 直接调用 `CryptProtectData` / `CryptUnprotectData`，只设置 `CRYPTPROTECT_UI_FORBIDDEN`，不设置 `CRYPTPROTECT_LOCAL_MACHINE`。不弹窗、不加载/创建用户 profile、不以机器范围或明文回退。输出分配在释放前原地清零；返回副本归调用者清零。
- `windows-files.ts` 用进程 token 的 SID 确定身份，不采信 USERNAME、HOME 或配置里的用户名。线程存在 impersonation token 时拒绝。`GetUserProfileDirectoryW` 获取 profile 路径，`HKEY_USERS/<SID>` 必须已加载；这两个条件不是 DPAPI 可用性的替代证明，写前还会原生加解密合成 probe。
- 目录必须是当前服务用户 profile 下的本地盘路径，拒绝 UNC、设备名、ADS、路径别名分量。父目录必须已存在。仅末级目录可由原生 `CreateDirectoryW` 创建；不会递归放宽父目录权限。
- 每次操作保留逐级目录 OS 句柄，直到结束；打开时不共享写或删除，并用 `GetFileInformationByHandle` 拒绝 reparse point。最后目录及文件以句柄查询 owner 和 DACL：owner 必须当前 SID，DACL 必须 protected、只有当前 SID 的一个显式 full-control ACE。未继承管理员、SYSTEM 或 Everyone 访问。其他 ACL 一律拒绝，绝不自动修补或把 Node chmod 当 Windows 边界。文件硬链接数量必须为 1。
- `CreateFileW` 的 `CREATE_NEW` 是拒覆盖边界；status 不是锁。write 完整写入并 `FlushFileBuffers` 后再读回比较。初始化中断可能留下格式无效的已占用条目，后续失败关闭，不能覆盖或重新生成 key。删除通过已验证的独占句柄设置 disposition。
- 服务与管理命令必须以同一个已加载 profile 的用户运行。更换服务用户会遇到不同 SID/profile 和 DPAPI 身份；不能自动找到旧用户密钥。ACL 对其他普通身份的限制不构成对管理员提权、所有者主动改 ACL 或同一用户恶意程序的隔离承诺。

现有 Hub `FileVault` 的 AES-256-GCM `.sealed` 条目没有改动。只有原始 32 字节 master key 一致，原条目才可能继续打开；更换 key 会失去解密能力。此分支没有把 Windows `.sealed` 目录的现有 Node 模式位认作 Windows ACL 证明；Windows 全部 vault 路径的持久化访问控制仍需集成审核，不能凭 master-key adapter 宣称整个密库安全完成。

## 迁移

没有自动迁移，没有读取真实 Circle/Hub 密钥、环境文件或用户凭据目录。macOS keychain、Circle safeStorage 文件、明文开发 key 文件和其他用户的 DPAPI 文件均不被接受为此 envelope。原样迁移本 envelope 必须保留相同 service/account、用户 DPAPI 上下文与受限 ACL；换机器、换用户、只复制文件或只重建用户名均无成功保证。需要操作者设计显式的原 key 转交、身份/ACL 复核和实际旧 vault 解密验收，不能默认生成新 key。迁移命令未实现。

## 验证与未证实内容

遵照所有者本轮限制，没有运行测试、typecheck、原生 API、钥匙串或真实系统操作。仅检查源码与 Git diff。`windows-keychain.test.ts` 有纯合成边界测试；错误注入只证明 adapter 传播失败，不证明 OS 已执行相应拒绝。Windows 原生测试只在 Windows 的 GitHub runner 上启用，使用新建临时合成目录和随机字节，包含 fresh-process 读取、重复创建、硬链接、junction 和 ACL 放宽反例。`windows-dpapi.test.ts` 的 Windows 合成往返也未运行。

尚待 Windows x64/ARM64 runner 实证：koffi ABI、结构体布局、DLL 加载、目录共享约束、完整读写和删除、并发 create-only、服务非交互登录与 profile 加载/未加载两种情形、跨用户 DPAPI 失败、跨机迁移、完整 vault 旧 key 解密。当前测试没有伪造跨用户或卸载用户 hive；这些反例仍未实证。默认工厂必须保持不可用，直到集成方核对这些缺口与可用性口径。

## 原始依据

- [Microsoft CryptProtectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptprotectdata)
- [Microsoft CryptUnprotectData](https://learn.microsoft.com/en-us/windows/win32/api/dpapi/nf-dpapi-cryptunprotectdata)
- [Microsoft CreateFileW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-createfilew)
- [Microsoft GetSecurityInfo](https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-getsecurityinfo)
- [Microsoft GetUserProfileDirectoryW](https://learn.microsoft.com/en-us/windows/win32/api/userenv/nf-userenv-getuserprofiledirectoryw)
- [Koffi output parameters](https://koffi.dev/output)

本任务没有发现需改动模型的规则冲突；Windows 服务/ACL/迁移可用性不足是明确保留的实现与证据缺口。
