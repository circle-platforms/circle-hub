# Security policy

circle-hub is being rebuilt and is not a supported production release. The task-and-approval server that came before was retired; the redesigned Hub, a standard MCP server, is under construction (see the [progress](docs/hub-r4-progress.md)). Tests run on synthetic fixtures, scripted models and a temporary PostgreSQL, and the archived references and old experiments are no assurance for any deployment. The planned deployment runs on a single machine and listens on loopback only; the Hub is not meant to be exposed to a network.

## Report a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's private reporting: open the repository's **Security** tab and choose **Report a vulnerability**. If that option is not available, open an issue that says only that you have a security report and ask for a private way to send it. Do not put details in the issue.

Include the part that is affected (an MCP tool, the console, the `circle-hub` command, a connector, the pack sandbox or the vault), the smallest reproduction, the impact, the commit or version, and the files involved. Do not upload passwords, tokens, business originals or whole user sessions. Keep a risk in the frozen references (`references/`) apart from a risk in a runtime entry point.

Reports are handled on a best-effort basis. There is no guaranteed response time at this stage.

## Supported versions

Fixes go into the latest commit on `main` and the next release. Nothing older is patched.

## What counts

These are in scope. They are properties the [generic model](docs/design/en/generic-model.md) and the [architecture brief](docs/hub-r4-architecture.md) require; most of the code that is meant to provide them is still planned.

- A result delivered, or a fact recorded, without the Hub's boundary validation: a quotation accepted that is not verbatim in its source, an exact value accepted that does not resolve, a pack check that was not re-run.
- Pack code escaping its sandbox: network access, file writes, child processes, or reads outside the extracted pack.
- A request reaching a business system on a route that is not allow-listed, any write to a business system, or a connector retrying a failed login.
- A credential, token or vault secret leaking into a record, a call log, a source artifact, a response or the console.
- A user seeing runs, uploads, packs or knowledge that are not theirs or not assigned to them, or being able to tell something absent from something forbidden.
- A console or MCP request accepted without a valid token, or with a wrong Host or Origin.
- Anything that lets text from a source, a tool result or a pack change permissions, pack assignments or settings.

Out of scope, by design: runtime addresses, credentials and certificates are kept by the deployer outside the repository, and this project does not host or rotate them. Connectors are read-only, and milestone 1 writes to no external system.

## How the repository is protected

- Secret scanning and push protection: a commit that contains a key is rejected.
- Dependabot alerts and updates.
- `main` cannot be force-pushed or deleted.
- The workflows run with the least permissions they need and touch no secrets.
