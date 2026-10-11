# @infosec/contracts

平台共享契约层（对象边界中的 F）：FZ-01–FZ-09 冻结版，与 [共同契约 V1](../../docs/common-contracts-v1.md)、[ADR 0007](../../docs/decisions/0007-wire-and-tasks-baseline.md) 与 [P1-2 冻结记录](../../docs/p1-2-freeze-record.md) 对应。

- **单一事实源**：`src/` 中的 Zod schema 同时产生 TypeScript 类型、运行时校验与导出的 JSON Schema（`contractJsonSchemas()`）。生成的 JSON Schema 不手工维护。
- **范围**：只有契约与词表，没有业务逻辑、没有传输实现、没有 B/C/D/E 服务。信封的 `payload` 按操作另行以 schema 定义（随各链实现进入），本包只冻结信封与公共结构。
- **版本**：契约版本 `1.2.0`（`CONTRACT_VERSION`；v1.1 由 ADR 0009 增补 `cancelled`，v1.2 增补 `IDEMPOTENCY_MISMATCH`），冻结标识 `FZ-2026-10-10-v1.2`。破坏性变更必须升版本并同步三路对拍记录（COM-05）。

## 使用

```bash
npm install
npm run typecheck   # tsc，含测试文件
npm run build       # 产出 dist/（已 gitignore）
npm test            # vitest：FZ-01–09 的契约测试
```

文件映射：`ids.ts` = FZ-07；`vocab.ts` = FZ-01/02/03；`envelope.ts` = FZ-04；`bindings.ts` = FZ-05；`effects.ts` = FZ-06；`records.ts` = FZ-08；`pending.ts` = FZ-09。
