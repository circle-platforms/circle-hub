// Typed errors of the server package. Messages are Chinese; they never carry arguments, tokens or credential values.

/**
 * The assembly module in use does not wire what a command needs: a placeholder module (tests), or one without the part this
 * command uses (assembleCommand for `run show`). The default module, hub/server/assemble.ts, wires everything.
 */
export class AssemblyMissingError extends Error {
  constructor(message = '这个装配模块是占位，没有接上运行、知识、任务包和资源这几个包（默认的 hub/server/assemble.ts 会接上）：这时能用的只有 serve --migrate-only、用户与令牌管理、调用日志导出和平台命令') {
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
