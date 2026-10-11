# 来源与第三方范围

本项目自有代码、文档、合成样本和自有界面资产按根目录 [MIT 许可](LICENSE)提供。内容持有人已确认完整 platform 自有归档具有公开权利。第三方内容不因根许可而被重新授权。

## Circle 共享基础

`foundation/circle` 来自公开 Circle 提交 `9d23c09a0f8de2f71920b32b23db9af6c9a41100`，保留原字节、[MIT 许可](foundation/circle/LICENSE)及[第三方说明](foundation/circle/THIRD_PARTY_NOTICES.md)。

其中 `src/data/` 的压缩模型资料包含 models.dev 衍生元数据，原 MIT 说明和版权通知位于上述第三方说明。采用或分发这部分内容时保留该说明。

Circle 的旧 Git 历史也被保留，历史各版本的许可和通知仍属于相应来源，不能用当前根文件覆盖它们。

## Platform 参考

`references/platform/snapshot` 来自 infosec-platform 提交 `4ab6c5ea593eb1b1d71bed92374b3a013ba61ad9`。其中自有内容包含在根 MIT 授权范围内。原件中的 `private`、未声明许可的旧 package 元数据及历史范围记录保持原样，作为来源证据；当前授权范围以本页和根 LICENSE 为准。

研究文档中的外部产品、项目名称、源码链接、商标和方法说明保留各自归属。链接到公开仓库或研究其机制，不代表取得该产品的商标权或把整套产品纳入本项目授权。

## 依赖记录与实际制品

根 package 没有外部依赖。共享基础及参考包的锁文件记录了各自的依赖，但本仓库没有收录 node_modules，也没有以这些依赖构建或发行 server 制品。

采用模块时核对实际使用的依赖，分发时随制品提供相应许可与通知。当前锁文件中的特别范围包括 jszip 的许可选项、pako 的 MIT/Zlib、lightningcss 的 MPL-2.0 和 caniuse-lite 的 CC-BY-4.0。它们不能一概改成项目 MIT。

`buffers@0.1.1` 的原 npm 包与元数据中未找到许可依据，相关 chain-v05 目前只作为参考保存；正式采用并分发该依赖前取得依据或替换。`unionfs@4.6.0` 虽缺少锁文件许可字段，原 npm 发布包包含 Unlicense LICENSE。

本页不是全部依赖的逐文件通知清单。首次软件发行需根据实际制品生成组成与通知清单。具体来源、核对范围和剩余发行要求见[开源检查](docs/open-source-readiness.md)。
