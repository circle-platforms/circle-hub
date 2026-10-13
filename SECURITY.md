# Security policy

circle-hub is under development and is not a supported production release. The sign-in is a development sign-in, acceptance runs on synthetic sources and a temporary PostgreSQL, and the archived references and old experiments are no assurance for an enterprise deployment. Before you run it anywhere that matters, check your configuration against the roles, approvals and enforcement chain in the [design](docs/design/README.md).

## Report a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**. If that option is not available, open an issue that says only that you have a security report and ask for a private way to send it. Do not put details in the issue.

Include the path that is affected (server, worker, a connector, the admin CLI or the Circle extension), the smallest reproduction, the impact, the commit or version, and the files involved. Do not upload passwords, tokens, business originals or whole user sessions. Keep a risk in the frozen references (`references/`) apart from a risk in a runtime entry point.

Reports are handled on a best-effort basis. There is no guaranteed response time at this stage.

## Supported versions

Fixes go into the latest commit on `main` and the next release. Nothing older is patched.

## What counts

These are in scope:

- A way for a change set to take effect, or for an execution to run, without the approval the [design](docs/design/approvals-and-enforcement.md) says it needs.
- A way past the enforcement chain: a device command dispatched without the hub re-verifying it, or an error code or `waitingReason` that hides a refusal.
- A credential, token or operation token leaking into a record, a log, an evidence file or a response it should not reach.
- A role or a scope granting more than the [roles](docs/design/roles.md) say, including around the two-person rule.
- Anything that lets text from a source, a tool result or a pack change approvals, roles or settings.

Out of scope, by design: runtime addresses, credentials and certificates are kept by the deployer outside the repository, and this project does not host or rotate them. Connectors are read-only; writes to external systems go through execution resources only, under the enforcement chain.

## How the repository is protected

- Secret scanning and push protection: a commit that contains a key is rejected.
- Dependabot alerts and updates.
- `main` cannot be force-pushed or deleted.
- The workflows run with the least permissions they need and touch no secrets.
