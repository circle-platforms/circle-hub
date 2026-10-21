# Knowledge sync on the document host

The Hub reads product documents from a WebDAV mirror that a document host builds (anonymous read, plain HTTP). The host already
ran two pipelines: an OpenKM export of the development and QA document roots converted to Markdown (every 30 minutes), and a daily
SVN update plus AsciiDoc conversion of the product manuals for three version lines. Neither covered the version-specific material
for both name families of the product (APV and NSAE are one product with two names). This directory holds what was added on
2026-10-21. Nothing existing was changed: the new jobs have their own configuration, state, output folders and a shared lock.

## What was added

| Source | Output on the mirror | Notes |
| --- | --- | --- |
| OpenKM `APV_Release/Infosec_Release_Notes` | `release/infosec/` | release notes of the Infosec-branded builds (10.4.2, 10.4.3, 10.5) |
| OpenKM `APV_Release/Array_Release_Note` | `release/array/` | release notes of the Array-branded builds (6.5 to 8.3 lines) |
| OpenKM `APV_Release/OEM_Release_Notes` | `release/oem/` | release notes of OEM builds, including the NSAE-named ones |
| OpenKM `APV_Release/Critical_Issue` | `release/critical/` | critical issue notifications |
| SVN branches `rel_apv_10_4_2`, `rel_apv_10_4_5` (company `infosec`, `source/app_cn`, `source/cli_cn`) | `app/rel_apv_<line>/app_cn/`, `cli/rel_apv_<line>/cli_cn/` | Markdown plus the command catalog JSON the converter writes next to it |

Release notes exist as a legacy `.doc` plus a PDF twin. The stock converters only take `.docx` and send PDFs to a cloud
converter, so `stage_release.py` first converts `.doc` with the host's local LibreOffice and leaves out PDFs that have a Word twin;
only PDFs without a Word twin go to the PDF converter.

## Files

- `stage_release.py` stages an export for the stock converters (`.doc` to `.docx`, PDFs without a Word twin).
- `release_pipeline.sh <set> <upload dir> <web target>` runs export, stage, `docx2md.py`, `pdf2md.py` and `deploy_md.sh` for one set.
- `run_release_all.sh` runs the four sets (hourly, minute 5). `run_manuals_extra.sh` updates the two added manual lines (daily, 00:20).
- `manuals_first_run.sh` is the first conversion after a fresh SVN checkout (the daily job only converts when the update brought changes).
- `export-release.properties.example` shows the exporter configuration of one subtree (real files hold credentials and stay on the host).

Cron entries, serialized with `flock -n /root/<sync dir>/pipeline.lock` so they never overlap with each other:

```
5 * * * *  flock -n .../pipeline.lock .../run_release_all.sh   >> logs/cron-release.log 2>&1
20 0 * * * flock -n .../pipeline.lock .../run_manuals_extra.sh >> logs/cron-manuals.log 2>&1
```

## Adding a subtree or a version line

- OpenKM subtree: copy an export properties file, change `okm.davRoot` and `okm.outDir`, add a line to `run_release_all.sh`.
- Manual line of a branch that has `tools/company/<company>/source/<manual>_cn`: `svn checkout` it to `uploads/<app|cli>/rel_apv_<line>/<manual>_cn`, run `manuals_first_run.sh` for it, add it to `run_manuals_extra.sh`.

## Not covered yet

- Version lines up to 10.4.3 keep their manuals only as built PDFs in SVN (no AsciiDoc source), so they are not converted.
- English manuals (`app_en`, `cli_en`) and the other OpenKM roots (`Release_Status`, installation, configuration and application guides) are not synced.
- The older pipelines keep flattening `spec`, `product` and `qa` documents by name; version information there is only in the text.

## Roll back

Remove the two cron lines, delete the sync directory, `rm -r /var/www/data/release`, and delete the added `app`/`cli` folders of the two lines.
