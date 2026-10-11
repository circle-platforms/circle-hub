# 安全问题与当前支持范围

Circle Server 仍处于开发准备阶段，没有正式 server/API 启动入口，也没有受支持的生产软件发行。参考归档和旧实验不能作为企业部署的安全保证。

仓库目前私有。具有访问权限的协作者可以通过[本仓库私有 Issue](https://github.com/qingshanfeihu/circle-server/issues/new)报告问题，只提供最小复现、影响、版本与相关文件，避免上传口令、令牌、原始业务资料或完整用户会话。

若仓库公开且 Security 页面已经提供 **Report a vulnerability**，使用该入口私下报告安全问题，不在公开 Issue 披露漏洞细节或敏感内容。公开操作时需要启用并复核这个入口；当前没有宣称该功能已经开启。配置方式见 [GitHub 官方说明](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository)。

一般功能缺陷和不含敏感内容的建议可以使用普通 Issue。报告安全问题时说明可影响的实际运行路径；冻结参考中的风险与正式运行入口的风险分别说明。

维护者评估后按具体问题安排复现、修复、受影响使用者检查和披露，不在当前阶段承诺生产响应时限。基础开源检查只说明当时检查的内容和范围，详见[检查报告](docs/open-source-readiness.md)。
