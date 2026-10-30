# Let the capture skill reach a Hub without TLS when the user says so

The operation-capture skill only accepted HTTPS or a loopback address, so it could not talk to the shared Hub that listens on an internal address without TLS (the owner accepted that deployment). Acceptance had to go through a temporary local proxy and an SSH forward.

Change (knowledge-contribution 1.3.12): `enable` takes an optional `--allow-plaintext-host <host>`; the host must equal the host of `--hub`, is stored in the session's settings as the optional field `plaintext_host`, and is the only non-loopback host the session may reach over plain HTTP. Without it nothing changes. Old settings files without the field read as before. The skill text says plainly that the token and the uploaded content then cross the network unencrypted, which is the user's decision.

Allowed paths: `packs/workflow/knowledge-contribution/` (tools/operation-capture/**, testing/operation-plaintext.test.ts, README.md, pack-files.ts, pack.json and the generated files), this page.

Verification: `testing/operation-plaintext.test.ts`; `affected-tests.py --run`.
