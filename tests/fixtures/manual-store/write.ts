// Writes the synthetic manual-store fixture files: a WebDAV document store with spec/ (Markdown converted from Word in the
// pandoc style: headings with attribute blocks, pipe and grid tables, escaped brackets, HTML comments), cli/ and app/ with one
// folder per version line (rel_<name>_<numbers>, both name families of the invented product ORBIT / COMET), the CLI manual
// with NUL bytes in it (which PostgreSQL text cannot hold), and product/ and qa/ documents whose names carry version tokens.
// Everything is invented: the feature of the spec search (beacon groups with a TTL and weight inheritance), its terms and
// every file name. Run `node tests/fixtures/manual-store/write.ts` after a change; packs/system/manual-store/webdav.test.ts
// fails while the files differ.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const NUL = String.fromCharCode(0);

const SPEC_GROUP = `---
title: 信标组(TTL)权重继承
---

# 概述 {#overview}

本规格说明信标组的 TTL 与权重继承。信标组可以包含 1 到 8 个信标，组内信标继承信标组的权重。

# 功能描述 {#function}

## 命令 {#commands}

**orbit group ttl** *\\<group\\> \\<seconds\\>* **\\[inherit** *\\<on|off\\>***\\]**

- TTL 的取值为 1 到 255 秒。
- 信标组超过 8 个信标时，命令报错“信标组成员超出上限”。

| 参数    | 取值           | 默认值 |
|---------|----------------|--------|
| group   | 1 到 32 个字符 | 无     |
| seconds | 1 到 255       | 60     |

<!-- -->

## 约束 {#constraints}

+----------+-------------------------------+
| 项目     | 说明                          |
+==========+===============================+
| 继承     | 新加入的信标继承信标组的权重  |
+----------+-------------------------------+
| 大小写   | 信标组名称不区分大小写        |
+----------+-------------------------------+
`;

const SPEC_GROUP_TTL = `# 信标组 TTL 的配置

配置信标组的 TTL 后，查看命令 **show orbit group** 显示每个信标组的 TTL。

TTL 为空时会被拒绝，提示“TTL 不能为空”。
`;

const SPEC_DISTRACTORS: Record<string, string> = {
  '权重继承的限制.md': '# 权重继承的限制\n\n权重继承只在同一个环里生效。\n',
  '告警级别配置.md': '# 告警级别配置\n\n告警分三个级别。\n',
  '日志导出配置.md': '# 日志导出配置\n\n日志按天导出。\n',
  '系统状态查询.md': '# 系统状态查询\n\n**show orbit status** 显示系统状态。\n',
  'TTLOG模式说明.md': '# TTLOG 模式说明\n\nTTLOG 模式只用于演示，与信标组无关。\n',
  '环之间的负载分配.md': '# 环之间的负载分配\n\n**orbit mode** 设置分配方式：rr、lc 或 hash。\n',
  '信标端口说明.md': '# 信标端口说明\n\n信标端口取 1 到 65535。\n',
  'design-notes.txt': '这不是 Markdown 文件，检索不读它。\n',
};

/** The CLI manual of one line: command anchors (bold head, italic parameters), parameter tables, examples, NUL bytes. */
function cliManual(line: string): string {
  return [
    `# ORBIT ${line} 命令行手册（合成）`,
    '',
    '# 信标配置',
    '',
    '**orbit beacon add** *\\<ring\\> \\<address\\> \\<port\\> \\[weight\\]*',
    '',
    `该命令用于向环添加信标。${NUL}${NUL}`,
    '',
    '|         |                                    |',
    '|---------|------------------------------------|',
    '| ring    | 该参数指定环的名称，长度 1–32。     |',
    '| address | 该参数指定信标的地址。             |',
    '| port    | 该参数指定信标的端口。             |',
    '| weight  | 可选。该参数指定权重，取值 1 到 100，默认值为 10。 |',
    '',
    '示例：',
    '',
    '    Box(config)#orbit beacon add r1 192.0.2.5 8080 20',
    '',
    `**orbit mode** *\\<mode\\>*${NUL}`,
    '',
    '该命令用于设置环的分配方式，取值 rr、lc 或 hash，默认 rr。',
    '',
    '# 显示命令',
    '',
    '**show orbit status** *\\[ring\\]*',
    '',
    '该命令用于显示环的状态；不给环名时显示全部环。',
    '',
  ].join('\n');
}

function appManual(line: string): string {
  return `# ORBIT ${line} 应用手册（合成）\n\n## 信标页面\n\n在“信标”页面可以添加、删除信标；权重留空时按 10 处理。\n`;
}

/** Every file of the store by its path below the store root. */
export function storeFiles(): Record<string, string> {
  const files: Record<string, string> = {
    '/spec/信标组(TTL)权重继承.md': SPEC_GROUP,
    '/spec/信标组TTL的配置.md': SPEC_GROUP_TTL,
    '/cli/rel_orbit_7_1_0/cli_cn/cli_cn.md': cliManual('7.1'),
    '/cli/rel_comet_7_2/cli_cn/cli_cn.md': cliManual('7.2'),
    '/app/rel_orbit_7_1_0/app_cn/app_cn.md': appManual('7.1'),
    '/product/ORBIT_V7.1.0产品说明.md': '# ORBIT V7.1.0 产品说明\n\n环与信标的产品定位。\n',
    '/qa/COMET 7.2 测试策略.md': '# COMET 7.2 测试策略\n\n反向用例覆盖每个取值范围的两端。\n',
    '/qa/信标组测试策略.md': '# 信标组测试策略\n\n信标组的用例覆盖成员上限、TTL 两端和权重继承。\n',
  };
  for (const [name, text] of Object.entries(SPEC_DISTRACTORS)) files[`/spec/${name}`] = text;
  return files;
}

if (import.meta.main) {
  const root = fileURLToPath(new URL('./files', import.meta.url));
  for (const [path, text] of Object.entries(storeFiles())) {
    const target = `${root}${path}`;
    mkdirSync(dirname(target), { recursive: true });
    // Keep publication fixtures textual; the fixture reader restores synthetic NUL bytes.
    writeFileSync(target, text.replaceAll(NUL, '\\u0000'), 'utf8');
  }
  console.log(`wrote ${Object.keys(storeFiles()).length} files`);
}
