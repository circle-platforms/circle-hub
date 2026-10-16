# 开发用 Circle 运行配置

英文译文在 [runtime-profile.en.md](runtime-profile.en.md)，两者有出入以中文为准。

技能运行需要仓库外的 `CIRCLE_RUNTIME_CONFIG`。文件不进 Git，hub 也不会自行批准它。未配置时，运行返回 `RUNTIME_NOT_CONFIGURED`（409），消息里带 `CIRCLE_RUNTIME_CONFIG`、`npm run runtime:profile` 和 [快速开始](quickstart.md)；登记和审批仍然可用。

`config/runtime-profile.development.example.json` 只说明形状，含占位密钥，不会被自动加载。

## 生成

在 circle-hub 仓库里：

```bash
npm run runtime:profile -- \
  --out "$HOME/circle-hub-dev/runtime.json" \
  --circle-bin /path/to/circle/dist/cli.js \
  --circle-commit "$(git -C /path/to/circle rev-parse HEAD)" \
  --model-url http://127.0.0.1:9/v1
```

`--out` 必须在本仓库之外。命令核对 `circleBin --version`，并在该检出是 Git 仓库时核对 `HEAD` 与 `--circle-commit`。省略 `--api-key` 时生成密钥，只写入文件，不打印。文件模式为 `0600`。

也可以用环境变量代替对应旗标：`CIRCLE_BIN`、`CIRCLE_COMMIT`、`CIRCLE_VERSION`、`CIRCLE_HUB_DEV_MODEL_URL`、`CIRCLE_HUB_DEV_MODEL_KEY`。

然后：

```bash
export CIRCLE_RUNTIME_CONFIG="$HOME/circle-hub-dev/runtime.json"
npm run dev:stack
```

`dev:stack` 的第二位管理员会批准观察到的 `circle-runtime`。若同时设置了 `CIRCLE_BIN`、`CIRCLE_COMMIT` 和 `CIRCLE_HUB_DEV_MODEL_URL`，而 `CIRCLE_RUNTIME_CONFIG` 还没设置，`dev:stack` 会在自己的临时目录里写同一形状的文件再启动；写失败只打印说明，不让整栈退出。模型地址必须是 HTTPS，或者回环上的 HTTP（`127.0.0.1`、`localhost`、`[::1]`）。

Linux 上实际跑技能还需要 bubblewrap。批准了回环端点时，还需要 landlock ABI 4 或更新，以及 `gcc` 或 `cc`，用来编译随仓库提供的 landlock 辅助程序。缺 `bwrap` 时错误会给出安装提示，hub 不会去掉隔离直接运行。
