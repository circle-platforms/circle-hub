# B5：子文件夹空态上下文

来源：所有者批准B5共用方向，#217；基线aded2ffd，fix/console-child-empty-context。

允许路径：`hub/server/console/{knowledge-directory.ts,README.md}`、`hub/server/console-child-empty-context.test.ts`、本任务页、`CHANGELOG.md`。

父页展开的空子节点只给包含完整可读路径的紧凑入口，不重复大空态/新建框；进入该文件夹后，空标题明确文件夹名称，私人拥有者有原新建入口，其他读取者不获得写动作。保留root/path/space/scope/cursor，所有既有条目/引用/状态/选择/分页/权限不变。空态说明不再承诺每条知识必有来源，遵守待验证笔记可无来源的原规则。

验证：真实临时路由的父目录非空+多个空子目录、独立空子目录、共享只读、不共享子目录隐藏、team/member、精确链接上下文和watermark。深浅主题×五宽度实际浏览器检查原内容先于子空态、无大面积重复、精确下一步/键盘/包含路径/不溢出。#264仅改spaces/memory编辑前景，此批仅改knowledge-directory，应能同#252/#264共同使用；在合成组合验证不做分支merge。不扩大成全知识列表布局改造。

## 实际验证

- 最终实际路由+console-clients：8通过、0失败/跳过；父有条目/空子节点、精确space/root/path/scope、共享读者不可见隐藏目录/写动作、team/member、根目录名称、GET watermark均保留。新增测试最初写错真实harness知识服务路径，后来修正为hub.hub.knowledge；链接按实际HTML &amp;比较，panel按实际data-view限定，避免把独立“原文为空”误判为知识空态。watermark放在创建两个认证session之后测量，先前13≠11来自认证记录，不是GET写入，未弱化读取不写断言。
- 125/500条知识的现有query-bound控制通过：home 61/61 SQL、entry 50/50 SQL。该次全命令8通过/1失败（上述认证watermark fixture），随后修正后8专项全通过；不把旧失败命令说成整套通过。传入不存在knowledge-directory.test.ts没有额外测试，未计入。
- `npm run typecheck`：最终退出0。`npm run test:docs`：333通过、0失败/跳过。
- 实际临时HTTP浏览器20案例/40捕获：owner/共享读者×深浅主题×1440/1180/1024/760/390，父页6条知识+3个空子目录，进入子目录键盘Enter/原scope和snapshot完整，新建入口仅owner、读取watermark不增；两张代表人工查看，非全部逐张审查。
- #252+#264既有detached组合树干净apply本批runtime。实际form-recovery+child控制7通过、editor控制另2通过、0失败/跳过；typecheck退出0。最初误写post-recovery文件/未拷贝editor测试，不计入，随后用实际form-recovery.test.ts并从#264拷入editor测试验证。组合浏览器同样20案例/40捕获完整通过，并确认子目录新建进入独立编辑页且path仍为所选子目录。组合树未提交/推送/merge，未重跑之前所有POST故障矩阵。
- 未做部署、全仓npm test、真实数据、Linux或完整知识宽表阅读改造；只修改本任务允许的目录渲染。#194未变。
