// The console's management actions run the very commands of the `circle-hub` CLI, in this process: the same argument
// checks, the same records and decisions, the same messages. An action is one invocation of the CLI's main() with the
// serving process's own CIRCLE_HUB_* configuration and the signed-in administrator's token as CIRCLE_HUB_TOKEN, so the
// command acts as that administrator exactly as `CIRCLE_HUB_TOKEN="$T" circle-hub …` would; a secret value a form carries
// reaches `secret set` through the command's readSecret option, never through argv or the environment. Each invocation
// opens and closes its own records, like a CLI process. Platform commands (backup, restore, deploy, …) stop the server
// and are refused here: they stay on the command line.
import type { AssemblyModule, CliCommand } from './api.ts';
import { OPERATOR_TOKEN_VARIABLE } from './assemble/operator-token.ts';

export interface CommandRun {
  /** The command's exit code: 0 ok, 1 refused or failed, 2 usage. */
  code: number;
  stdout: string[];
  stderr: string[];
}

export interface CommandInput {
  /** The signed-in administrator's token; the command acts as its account. */
  token: string;
  /** Values `secret set --name <name>` reads, by name; never put into argv. */
  secrets?: Readonly<Record<string, string>>;
}

export interface CommandBridge {
  run(argv: readonly string[], input: CommandInput): Promise<CommandRun>;
}

export { BRIDGED_COMMANDS } from './command-registry.ts';
import { BRIDGED_COMMANDS } from './command-registry.ts';

type CliMain = (argv: readonly string[], overrides: Record<string, unknown>) => Promise<number>;

export interface BridgeOptions {
  /** The serving process's environment (its CIRCLE_HUB_* configuration); copied, never changed. */
  env: NodeJS.ProcessEnv;
  cwd: string;
  /** What serve itself was given (its vault key provider), so a command reads the same key; tests add their own. */
  overrides?: Readonly<Record<string, unknown>>;
  /** Tests only: the CLI entry and the assembly module; default hub/server/cli.ts and hub/server/assemble.ts. */
  main?: CliMain;
  assembly?: () => Promise<AssemblyModule>;
  adminCommands?: (options: { readSecret: (label: string) => Promise<string> }) => CliCommand[];
}

export function createCommandBridge(options: BridgeOptions): CommandBridge {
  return {
    async run(argv, input) {
      const stdout: string[] = [];
      const stderr: string[] = [];
      if (argv.length === 0 || !BRIDGED_COMMANDS.has(argv[0])) return { code: 2, stdout, stderr: ['控制台不执行这个命令'] };
      // Reset is handled by the authenticated HTTP launch/finish/ACK path, never by synchronous CLI dispatch.
      if (argv[0] === 'reset') return { code: 2, stdout, stderr: ['请使用控制台重建预览和确认入口；不能在服务进程同步执行 reset'] };
      // Imported here, not at the top: the CLI imports serve, and serve builds the app that holds this bridge.
      const main = options.main ?? ((await import('./cli.ts')).main as unknown as CliMain);
      const loadAssembly = options.assembly ?? (() => import('./assemble.ts') as Promise<AssemblyModule>);
      const secrets = input.secrets ?? {};
      const assembly = async (): Promise<AssemblyModule> => {
        const module = await loadAssembly();
        const adminCommands = options.adminCommands ?? (await import('./cli-admin.ts')).adminCommands;
        return {
          ...module,
          registerCommands: (register) => {
            for (const command of adminCommands({
              readSecret: async (name: string) => {
                if (!Object.hasOwn(secrets, name)) throw new Error(`表单没有给出 ${name} 的值`);
                return secrets[name];
              },
            })) register(command);
          },
        };
      };
      const env: NodeJS.ProcessEnv = { ...options.env, [OPERATOR_TOKEN_VARIABLE]: input.token };
      const code = await main(argv, {
        ...options.overrides,
        io: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line), env, cwd: options.cwd },
        assembly,
      });
      return { code, stdout, stderr };
    },
  };
}
