# Knowledge sync on the document host

These are host-side integration scripts for an existing OpenKM export and SVN manual mirror. They are deployment material,
not Hub runtime dependencies. The host provides the existing exporters and converters; this repository does not install or run them.
The added jobs keep their own configuration, state and output folders and share a lock.

## Deployment data stays on the host

All absolute paths, document-library directory names, branch names, version lines, source mappings, endpoints and credentials
are deployment data. Store their actual values only on the document host, outside Git. The owner or integrator configures and
runs these jobs. Reading this directory does not authorize connecting to the host or running a sync.

Export these variables in the host's job environment (there are no default host paths). These host-side variables use
`KNOWLEDGE_SYNC_*`; they are not Hub configuration and do not extend the Hub's closed environment namespace:

| Variable | Host-provided value |
| --- | --- |
| `KNOWLEDGE_SYNC_TOOLS_DIR` | Absolute directory containing the existing exporter and converter tools |
| `KNOWLEDGE_SYNC_UPLOAD_DIR` | Absolute staging root for exported documents and checked-out manuals |
| `KNOWLEDGE_SYNC_MIRROR_DIR` | Absolute mirror output root |
| `KNOWLEDGE_SYNC_DIR` | Absolute directory containing these scripts and private export properties |
| `KNOWLEDGE_SYNC_MANUAL_BRANCHES` | Space-separated manual checkout directory names (names contain no whitespace) |
| `KNOWLEDGE_SYNC_RELEASE_SET_1` through `KNOWLEDGE_SYNC_RELEASE_SET_4` | One `set upload-directory web-target` triplet per variable; each component contains no whitespace |

The four release sets retain their existing order and failure isolation. The private `export-<set>.properties` files name
the actual OpenKM subtrees and output directories. Replace every angle-bracket placeholder in the example before use; the
properties file is a template, not an environment-variable expansion mechanism. Keep private files mode 600 and out of Git.

## Source mappings

| Source configured on the host | Output relative to the mirror root | Notes |
| --- | --- | --- |
| Primary release-note subtree | `release/<primary-target>/` | Builds of the primary name family and the configured version lines |
| Alternate release-note subtree | `release/<alternate-target>/` | Builds of the alternate name family |
| OEM release-note subtree | `release/<oem-target>/` | OEM release notes |
| Critical-issue subtree | `release/<critical-target>/` | Critical issue notifications |
| Manual branches and company-specific source subdirectories | `<app-or-cli>/<branch>/<manual-subdirectory>/` | Markdown and the command catalog JSON written alongside it |

## Files and processing

- `stage_release.py` stages an export for the host's converters: local LibreOffice converts legacy `.doc` files to `.docx`;
  PDFs with a Word twin are left out. Only PDFs without a Word twin go to the host's PDF converter, which uploads them
  to an external cloud conversion service; Word files are converted locally.
- `release_pipeline.sh <set> <upload-directory> <web-target>` runs export, stage, document conversion and mirror deployment for one set.
- `run_release_all.sh` runs the four configured sets, preserving failure isolation.
- `run_manuals_extra.sh` updates and converts the configured manual branches when sources change.
- `manuals_first_run.sh` performs the first conversion after a fresh manual checkout.
- `export-release.properties.example` shows a subtree's exporter settings using placeholders.

Cron entries share `flock -n "$KNOWLEDGE_SYNC_DIR/pipeline.lock"` so these jobs never overlap. Configure the variables in the
host's private job environment. Illustrative schedules (script and log paths are placeholders):

```text
5 * * * *  flock -n <sync-directory>/pipeline.lock <sync-directory>/run_release_all.sh >> <log-directory>/release.log 2>&1
20 0 * * * flock -n <sync-directory>/pipeline.lock <sync-directory>/run_manuals_extra.sh >> <log-directory>/manuals.log 2>&1
```

## Adding sources and limits

For a subtree, copy a private export properties file, change its source and output mappings, and configure its release-set
triplet. For a manual branch, the host checks out its company-specific manual source into the configured upload layout,
adds the checkout directory name to the branch list, and runs the first conversion.

Lines with only built PDFs and no AsciiDoc sources are not converted by the manual jobs. English manuals and unconfigured
OpenKM roots are not synced. Older pipelines may still flatten development and QA documents by name; version information
then remains only in their text. Exact line coverage and directory mappings belong in the host's private deployment inventory.

## Roll back

The owner or integrator removes the two cron entries, the added sync directory, `release/` under the configured mirror root,
and the added manual output directories. This section describes the procedure; no rollback is performed by these scripts.

## Synthetic verification

`.github/checks/knowledge-sync.test.ts` runs with `npm run test:docs` and is type-checked by
`npx tsc --noEmit -p .github/checks`; the existing docs CI job runs both. Its executables and directories are synthetic,
and no conversion service or document host is contacted. Run it alone with
`node --test --test-concurrency=1 .github/checks/knowledge-sync.test.ts`.
