# kw-location-grammar：40 行定位表期望的逐行复核（2026-10-25）

所有者已追认三个判断：点分数字整段标签按声明语法读作版本线（地址形状要靠更窄的声明语法或改目录名排除）；带名字前缀的版本标签只认绑定名、大小写精确；超长标签按声明截断后读取。

`functions/locate.test.ts` 的行表里有 40 行的期望仍按已退役的关键词规则写。下面每行给出：新答案的判定依据（声明语法的哪一条），以及核对过的答案字段。这些值是按 `functions/convention.ts` 文件头声明的 famx-directory@1 逐行核过的，不是把实际输出倒写；实现若有出入，以声明为准改实现。

- **full-famy** — 编号只来自显式声明字段（famx-id-fields@1）：标题里的 “bug to case 90101” 不是编号字段，不抽取。判定 support。改动字段：defects: []（原 ["90101"]）。
- **customer-train** — 同上：标题里的 “需求20931” 不是编号字段。判定 support。改动字段：requirements: []（原 ["20931"]）。
- **deeper-quote** — 同上：标题里的 “bug 61234” 不是编号字段。判定 support。改动字段：defects: []（原 ["61234"]）。
- **famx-root-direct** — 同上：标题里的 “bug to case 90220” 不是编号字段；这一层也没有版本/火车/模块层，故未知。判定 unknown/missing_input，摘要“没有版本层，发布火车层未知，模块层未知”。改动字段：defects: []（原 ["90220"]）。
  - 说明：目录里没有版本线节点（NNN：版本线）；目录和标题里都没有版本，版本未知
- **requirement-in-a-deeper-folder** — 同上：更深层目录名里的 “需求20931” 不是编号字段。判定 support。改动字段：requirements: []（原 ["20931"]）。
- **same-id-in-the-title-and-a-folder** — 同上：标题与目录里的 “bug 61001” 都不是编号字段。判定 support。改动字段：defects: []（原 ["61001"]）。
- **train-without-line** — 同上：标题 “61001-会话保持” 不是编号字段。判定 support。改动字段：unclassified: []（原 ["61001"]）。
  - 说明：发布火车上面没有版本线节点，版本线取自发布火车 10.6.1-R2-2026/7
- **document-folder-is-no-module** — 模块层不再语义排除：火车下面整段单行标签就是模块名；编号仍不从目录名抽取。判定 support。改动字段：module: "bug to case 61001"（原 null）；defects: []（原 ["61001"]）。
- **document-folder-with-a-leading-id** — 同上：以编号开头的目录名也是模块名，且不再从中抽编号。判定 support。改动字段：module: "61002-会话保持"（原 null）；unclassified: []（原 ["61002"]）。
- **activity-folder-is-no-module** — 模块层不再语义排除：“回归测试” 是作者写的模块名（R6）。判定 support。改动字段：module: "回归测试"（原 null）。
- **case-item** — 编号只来自显式声明字段：用例路径里的编号不是声明字段。判定 support。改动字段：defects: []（原 ["61500"]）。
- **case-path-marked-ids** — 同上。判定 support。改动字段：requirements: []（原 ["20931"]）。
- **id-ranges** — 声明的编号范围只能给显式声明的编号定种类；标题散文里的数字不抽取，缺火车层故未知。判定 unknown/missing_input，摘要“发布火车层未知，模块层未知”。改动字段：verdict: "unknown"（原 "support"）；defects: []（原 ["90101"]）；unclassified: []（原 ["33001"]）；ranged: {"requirements": [], "defects": []}（原 {"requirements": ["33001"], "defects": []}）。
  - 说明：版本线下面没有发布火车节点（NNN：版本线-火车）
- **story-range-alone** — 同上：范围声明没有可分类的显式编号。判定 support。改动字段：defects: []（原 ["74001"]）；unclassified: []（原 ["33001"]）；ranged: {"requirements": [], "defects": []}（原 {"requirements": ["33001"], "defects": []}）。
- **inner-marker-wins** — 编号不再从标题的词与数字里读；缺火车层故未知。判定 unknown/missing_input，摘要“发布火车层未知，模块层未知”。改动字段：verdict: "unknown"（原 "support"）；requirements: []（原 ["20931"]）。
  - 说明：版本线下面没有发布火车节点（NNN：版本线-火车）
- **listed-defects** — 同上：标题里的并列编号不是编号字段。判定 unknown/missing_input，摘要“发布火车层未知，模块层未知”。改动字段：verdict: "unknown"（原 "support"）；defects: []（原 ["118000", "118001"]）。
  - 说明：版本线下面没有发布火车节点（NNN：版本线-火车）
- **dates-and-versions-are-no-ids** — 标题里的日期与版本号既不是编号也不是版本（都不是整段声明形式）；缺火车层故未知。判定 unknown/missing_input，摘要“发布火车层未知，模块层未知”。改动字段：verdict: "unknown"（原 "support"）。
  - 说明：版本线下面没有发布火车节点（NNN：版本线-火车）
- **full-width** — 不折叠：全角数字与全角连字符不在声明的前缀码/版本语法内，整层不可读，记未知并给作者出口。判定 unknown/missing_input，摘要“没有版本层，发布火车层未知，模块层未知”。改动字段：version: null（原 "10.6.1"）；line: null（原 "10.6.1"）；train: null（原 "10.6.1-R1-2026/7"）；module: null（原 "认证"）；source: "none"（原 "folders"）；confidence: "none"（原 "high"）；verdict: "unknown"（原 "support"）；requirements: []（原 ["20777"]）。
  - 说明：目录里没有版本线节点（NNN：版本线）；目录和标题里都没有版本，版本未知
- **root-full-width-lower-case** — 不折叠、不同义：小写全角根名不等于声明的产品名（U23），产品线定不出。判定 unknown/missing_input，摘要“根“ｎｓａｅ”不是产品名称”。改动字段：product: [null, "ｎｓａｅ"]（原 ["famx", "FAMY"]）；verdict: "unknown"（原 "support"）。
  - 说明：目录树的根“ｎｓａｅ”不是这条产品线的名称（FAMX、FAMY），产品线定不出
- **line-only** — 缺发布火车层与模块层：层级缺失记未知，不进已定位分组（R6）。判定 unknown/missing_input，摘要“发布火车层未知，模块层未知”。改动字段：verdict: "unknown"（原 "support"）。
  - 说明：版本线下面没有发布火车节点（NNN：版本线-火车）
- **pure-version-label** — 版本标签给出版本，但缺火车/模块层，仍记未知。判定 unknown/missing_input，摘要“发布火车层未知，模块层未知”。改动字段：verdict: "unknown"（原 "support"）。
  - 说明：目录里没有版本线节点（NNN：版本线）
- **pure-version-label-with-a-name** — 同上（绑定名 + 分隔符 + 数字是声明的版本标签形式）。判定 unknown/missing_input，摘要“发布火车层未知，模块层未知”。改动字段：verdict: "unknown"（原 "support"）。
  - 说明：目录里没有版本线节点（NNN：版本线）
- **build-date-in-a-deeper-folder** — build 日期方案已退役，且缺火车/模块层，记未知。判定 unknown/missing_input，摘要“发布火车层未知，模块层未知”。改动字段：verdict: "unknown"（原 "support"）。
  - 说明：版本线下面没有发布火车节点（NNN：版本线-火车）
- **invalid-build-date** — 同上：无效 build 日期不再作为拒绝理由被读出，缺层记未知。判定 unknown/missing_input，摘要“发布火车层未知，模块层未知”。改动字段：verdict: "unknown"（原 "support"）。
  - 说明：版本线下面没有发布火车节点（NNN：版本线-火车）
- **written-build-name** — 构建名按声明语法在标签开头读出并给版本，但缺火车/模块层，记未知。判定 unknown/missing_input，摘要“发布火车层未知，模块层未知”。改动字段：verdict: "unknown"（原 "support"）。
  - 说明：目录里没有版本线节点（NNN：版本线）；版本取自目录名里的构建名 Rel_FAMY_10_6_1_57
- **older-line-build-name** — 同上：另一条线的构建名照样只给版本，缺火车层记未知。判定 unknown/missing_input，摘要“发布火车层未知，模块层未知”。改动字段：verdict: "unknown"（原 "support"）。
  - 说明：版本线下面没有发布火车节点（NNN：版本线-火车）
- **declared-line-beside-title-version** — 声明的版本线是调用方给的事实；标题散文里的版本不再抽取；缺火车/模块层记未知。判定 unknown/missing_input，摘要“版本是声明的，发布火车层未知，模块层未知”。改动字段：version: "10.6.2"（原 "10.6.2.31"）；source: "parameter"（原 "title"）；declared: ["line", "version"]（原 ["line"]）。
  - 说明：目录里没有版本线节点（NNN：版本线）；目录和标题里都没有版本，版本未知；版本线取自调用方声明（参数 line）10.6.2，未经目录树核对
- **declared-product-fills-a-missing-root** — 声明的产品名按完全相等核对：小写 famy 不是声明的产品名（U23），产品线仍定不出。判定 unknown/missing_input，摘要“声明的产品“famy”不是产品名称”。改动字段：product: [null, "famy"]（原 ["famx", "FAMY"]）；declared: ["product_name"]（原 ["product_name", "product_line"]）。
  - 说明：没有目录树的根，产品线定不出；产品取自调用方声明（参数 product）famy，未经目录树核对
- **folder-with-build-number** — 整段标签不是声明的版本形式（名字 + 版本 + 后缀），版本层未知。判定 unknown/missing_input，摘要“没有版本层，发布火车层未知，模块层未知”。改动字段：version: null（原 "10.6.1.57"）；source: "none"（原 "folders"）；confidence: "none"（原 "low"）。
  - 说明：目录里没有版本线节点（NNN：版本线）；目录和标题里都没有版本，版本未知
- **v-prefix-among-words** — 版本写在词中间不读：整段标签不是版本形式。判定 unknown/missing_input，摘要“没有版本层，发布火车层未知，模块层未知”。改动字段：version: null（原 "10.7.0"）；source: "none"（原 "folders"）；confidence: "none"（原 "low"）。
  - 说明：目录里没有版本线节点（NNN：版本线）；目录和标题里都没有版本，版本未知
- **title-only** — 标题是散文，不抽取版本；目录里没有版本层，记未知。判定 unknown/missing_input，摘要“没有版本层，发布火车层未知，模块层未知”。改动字段：version: null（原 "10.6.2.31"）；source: "none"（原 "title"）；confidence: "none"（原 "low"）。
  - 说明：目录里没有版本线节点（NNN：版本线）；目录和标题里都没有版本，版本未知
- **standard-number-in-a-folder** — 整段标签不是版本形式（“802.1Q VLAN”），不按含义猜测。判定 unknown/missing_input，摘要“没有版本层，发布火车层未知，模块层未知”。改动字段：version: null（原 "802.1"）；source: "none"（原 "folders"）；confidence: "none"（原 "low"）。
  - 说明：目录里没有版本线节点（NNN：版本线）；目录和标题里都没有版本，版本未知
- **software-version-in-a-folder** — 同上（“Chrome 120.0 兼容”）。判定 unknown/missing_input，摘要“没有版本层，发布火车层未知，模块层未知”。改动字段：version: null（原 "120.0"）；source: "none"（原 "folders"）；confidence: "none"（原 "low"）。
  - 说明：目录里没有版本线节点（NNN：版本线）；目录和标题里都没有版本，版本未知
- **library-version-in-a-folder** — 同上（“OpenSSL 1.1.1 升级”）。判定 unknown/missing_input，摘要“没有版本层，发布火车层未知，模块层未知”。改动字段：version: null（原 "1.1.1"）；source: "none"（原 "folders"）；confidence: "none"（原 "low"）。
  - 说明：目录里没有版本线节点（NNN：版本线）；目录和标题里都没有版本，版本未知
- **dotted-patch-is-no-version** — patch 方案已退役；整段标签也不是版本形式，版本层未知。判定 unknown/missing_input，摘要“没有版本层，发布火车层未知，模块层未知”。改动字段：patch: null（原 "1.2"）；patch_source: "none"（原 "folders"）。
  - 说明：目录里没有版本线节点（NNN：版本线）；目录和标题里都没有版本，版本未知
- **patch-beside-a-mentioned-version** — 同上：“FAMY_10.7.3_patch3” 整段不是版本形式，版本与 patch 都不读。判定 unknown/missing_input，摘要“没有版本层，发布火车层未知，模块层未知”。改动字段：version: null（原 "10.7.3"）；source: "none"（原 "folders"）；confidence: "none"（原 "low"）；patch: null（原 "3"）；patch_source: "none"（原 "folders"）。
  - 说明：目录里没有版本线节点（NNN：版本线）；目录和标题里都没有版本，版本未知
- **build-date-beside-a-mentioned-version** — 同上：“FAMX 10.7.0 build20260110” 整段不是版本形式。判定 unknown/missing_input，摘要“没有版本层，发布火车层未知，模块层未知”。改动字段：version: null（原 "10.7.0"）；source: "none"（原 "folders"）；confidence: "none"（原 "low"）；build: null（原 "20260110"）；build_source: "none"（原 "folders"）。
  - 说明：目录里没有版本线节点（NNN：版本线）；目录和标题里都没有版本，版本未知
- **title-build-date-beside-a-title-version** — 标题里的版本与 build 日期都不抽取。判定 unknown/missing_input，摘要“没有版本层，发布火车层未知，模块层未知”。改动字段：version: null（原 "10.6.2.31"）；source: "none"（原 "title"）；confidence: "none"（原 "low"）；build: null（原 "20260315"）；build_source: "none"（原 "title"）。
  - 说明：目录里没有版本线节点（NNN：版本线）；目录和标题里都没有版本，版本未知
- **build-date-in-the-train** — build 日期方案已退役：火车层照语法读出，build 字段不再产出。判定 support。改动字段：build: null（原 "20260402"）；build_source: "none"（原 "folders"）。
- **patch-in-the-train** — patch 方案已退役：火车层照语法读出，patch 字段不再产出。判定 support。改动字段：patch: null（原 "2"）；patch_source: "none"（原 "folders"）。

其余 8 处失败不是行表：`says why an answer is uncertain…`、`gives one summary line…`、`the same path under another root name…`、`adding a deeper folder that mentions another version…`、`a version mentioned above the version level is a quote…`、`bounds what it reads and what it returns`、`declared-product-fills-a-missing-root` 之外的两个 metamorphic/bad-input 断言，按同一声明逐条改写。

行表之外还剩：case-location 的 `ids/expected/conventions/project/candidates/check` 共 39 行、famx 106 条、case-review 30 条；包级三个测试在 Cursor 修完 `hub/knowledge/produce.ts`（339c311a）后应能加载，需重跑。
