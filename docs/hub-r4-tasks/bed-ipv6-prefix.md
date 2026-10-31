# IPv6 前缀长度写法（R5 A2b）

分支 `bed-ipv6-prefix`。设备回显里的 IPv6 地址可以写成地址和前缀长度两段（`2001:db8::70 64`）。自动化测试环境清单里同一地址写成 `2001:db8::70/64`。两处 `toCIDR` 把这两种写法收成同一个地址。前缀越界、含字母或地址族对不上时仍返回空，不放行。IPv4 的点分掩码和斜杠写法保持原样。

只按两段拆开判断。第一段是 IPv6 地址，第二段是 0–128 的十进制整数。不用正则或关键词猜测整行含义。

可改路径：

- `hub/dispatch/bed-state.ts`
- `hub/dispatch/bed-state.test.ts`
- `packs/workflow/test-bed/functions/surface.ts`
- `packs/workflow/test-bed/functions/surface.test.ts`
- `packs/workflow/test-bed/pack-files.ts`
- `packs/workflow/test-bed/pack.json`
- `packs/workflow/test-bed/pack.test.ts`
- `packs/workflow/test-bed/README.md`
- `docs/hub-r4-tasks/bed-ipv6-prefix.md`

合成床清单和合成回显。地址只用 2001:db8::/32 与 192.0.2.0/24。不连接真实自动化测试环境，不读环境配置，不使用钥匙串。
