# 任务：SVN 只读系统包，给 adoc 生产器按修订号成批取原件

依据：

- `docs/hub-r4-kb-direction.md` 第一节：作者结构由 Hub 直接读 adoc；
- `docs/hub-r4-research/kb-real-sources.md` 的 adoc 一节：真实服务器的形状和按修订号读的核实；
- B04：读外部系统记为观察，响应原样存为原件；
- `hub/connectors/README.md`：网络只由核心做，包里只放请求模板和解析函数；
- 先例：`packs/system/openkm`（WebDAV 加 Basic 认证，只读）。

真实的 SVN 服务器是 mod_dav_svn（HTTP 上的 WebDAV/DeltaV），支持 HTTP v2：

- 每个目录在 `DAV:version-name` 里带最后修改的修订号；
- `<仓库根>/!svn/rvr/<修订号>/<路径>` 按修订号读；按目录的修订号读到的字节和直接读最新的相同。

服务器地址、仓库路径和账号都是部署数据，不进 Git。

- 分支和工作树：`kb-svn`，目录 `circle-hub-kb-svn`（依赖已装好）
- 可以改的路径：`packs/system/svn/**`（新包）和它的测试、README。`hub/connectors/**` 只在方法或认证确实不够用时才改，先回报；`contracts/` 缺什么先回报。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用本机回环上的合成假服务；`git commit -s`）。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=1` 对 `packs/system/**`、`hub/connectors/**`。

## 要做的

1. 系统包 `system@1`，一个角色：仓库根地址，由资源记录给出。认证照 openkm：`static_header`，Basic，凭据只在密钥库。只有读路由：
   - 目录的修订号：在最新版本上对一个目录 `PROPFIND`，`Depth: 0`，取 `version-name`；
   - 按修订号列目录：`PROPFIND /!svn/rvr/{rev}/{dir*}/`，`Depth: 1`，取每个成员的名字、是否目录、大小和修订号；
   - 按修订号读文件：`GET /!svn/rvr/{rev}/{path*}`。

   修订号只收数字；路径参数的约束照 openkm；不跟随列表里的链接。PUT、MKCOL、MERGE、CHECKOUT、POST 等写方法一律不在路由里。
2. 读类型，照 openkm 的 `reads` 写：
   - 一个目录：先取修订号，再在这个修订号上列出；
   - 按修订号读一个文件。

   产品包的同步计划会组合它们：同一组文件在同一个修订号上读。外部标识里带修订号，原件记请求摘要和修订号。
3. 解析：PROPFIND 的 XML 用 xml@1。真实服务器的元素带命名空间前缀（`D:`），`response` 元素还带 `xmlns` 属性，两种都要认；href 可能有百分号编码，按解码后的路径比较；目录带尾斜杠。
4. 测试：本机回环上的假服务按上面的真实形状应答。要覆盖：
   - 白名单外的方法和路径被拒；
   - 修订号不是数字被拒；
   - 401 就停，不重试；静态头没有登录流程；
   - 凭据不出现在日志、原件和错误信息里；
   - 列表里的修订号比目录的大时报错，不悄悄接受；
   - 同一修订号读两次，字节相同。
5. README：读法、批次身份、怎样配置（资源记录和密钥的名字，不写值）。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。接真实服务器由集成者做。
