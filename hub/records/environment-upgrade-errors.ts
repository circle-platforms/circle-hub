export const ENVIRONMENT_UPGRADE_NOTICE = '运行环境权限升级需要先只读预检保权；完成后最低安全级别为 2，不能直接降回未实施这套权限规则的旧版本。升级不会自动重建库';
export class EnvironmentUpgradeRequiredError extends Error {
  constructor(message = ENVIRONMENT_UPGRADE_NOTICE) { super(message); this.name = 'EnvironmentUpgradeRequiredError'; }
}
