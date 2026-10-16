# Development Circle runtime profile

This page translates the [Chinese original](runtime-profile.md); where the two differ, the Chinese text is authoritative.

A skill run needs `CIRCLE_RUNTIME_CONFIG` pointing at a file outside the repository. The file stays out of Git, and hub does not approve it by itself. Without it, a run returns `RUNTIME_NOT_CONFIGURED` (409). The message names `CIRCLE_RUNTIME_CONFIG`, `npm run runtime:profile`, and the [quickstart](quickstart.en.md). Registration and approval still work.

`config/runtime-profile.development.example.json` documents the shape only. It contains a placeholder key and is not loaded automatically.

## Create one

From the circle-hub repository:

```bash
npm run runtime:profile -- \
  --out "$HOME/circle-hub-dev/runtime.json" \
  --circle-bin /path/to/circle/dist/cli.js \
  --circle-commit "$(git -C /path/to/circle rev-parse HEAD)" \
  --model-url http://127.0.0.1:9/v1
```

`--out` must be outside this repository. The command checks `circleBin --version` and, when that checkout is a Git repository, checks that `HEAD` matches `--circle-commit`. Omitting `--api-key` generates a key, stores it in the file, and does not print it. The file mode is `0600`.

These environment variables stand in for the matching flags: `CIRCLE_BIN`, `CIRCLE_COMMIT`, `CIRCLE_VERSION`, `CIRCLE_HUB_DEV_MODEL_URL`, `CIRCLE_HUB_DEV_MODEL_KEY`.

Then:

```bash
export CIRCLE_RUNTIME_CONFIG="$HOME/circle-hub-dev/runtime.json"
npm run dev:stack
```

`dev:stack`'s second administrator approves the observed `circle-runtime` profile. If `CIRCLE_BIN`, `CIRCLE_COMMIT` and `CIRCLE_HUB_DEV_MODEL_URL` are set and `CIRCLE_RUNTIME_CONFIG` is not, `dev:stack` writes the same shape into its own scratch directory and continues. A write failure prints a notice and does not stop the stack. The model URL must be HTTPS, or HTTP on loopback (`127.0.0.1`, `localhost`, or `[::1]`).

Running a skill on Linux also needs bubblewrap. An approved loopback endpoint also needs landlock ABI 4 or newer and `gcc` or `cc`, which compile the landlock helper shipped with this repository. A missing `bwrap` returns an install hint. Hub does not run the command without isolation.
