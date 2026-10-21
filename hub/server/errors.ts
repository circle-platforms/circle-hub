// Typed errors of the server package. Messages are Chinese; they never carry arguments, tokens or credential values.

/** hub/server/assemble.ts is still the placeholder: the packages that serve runs, knowledge and resources are not wired yet. */
export class AssemblyMissingError extends Error {
  constructor(message = '服务器还没有装配：hub/server/assemble.ts 仍是占位，运行、知识、任务包和资源这几个包要由下一阶段的装配步骤接上。在那之前能用的只有 serve --migrate-only、用户与令牌管理、调用日志导出和平台命令') {
    super(message);
    this.name = 'AssemblyMissingError';
  }
}

export function isAssemblyMissing(error: unknown): boolean {
  return error instanceof AssemblyMissingError || (error instanceof Error && error.name === 'AssemblyMissingError');
}

/** A usage mistake on the command line: printed with the usage text, exit code 2. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** A refusal the operator can act on: printed as it is, exit code 1. */
export class CliError extends Error {
  readonly hint: string | null;
  constructor(message: string, hint: string | null = null) {
    super(message);
    this.name = 'CliError';
    this.hint = hint;
  }
}
