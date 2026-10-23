#!/bin/bash
# Release-document pipeline for one OpenKM subtree (hub knowledge sync).
# Usage: release_pipeline.sh <set> <upload dir name> <web target name>
#   e.g. release_pipeline.sh sample-set SAMPLE_EXPORT sample-target
# Steps: export (incremental) -> stage (.doc -> .docx locally, PDFs without a Word twin) -> docx2md -> pdf2md -> deploy.
# Existing pipelines and settings are not touched; outputs go to $KNOWLEDGE_SYNC_MIRROR_DIR/release/<web target>.
set -euo pipefail
# Validate before reading deployment paths or invoking an exporter or converter.
if [ "$#" -ne 3 ]; then
  echo '[fail] release triplet malformed' >&2
  exit 2
fi
for field in "$@"; do
  if ! [[ "$field" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
    echo '[fail] release triplet malformed' >&2
    exit 2
  fi
done
W="${KNOWLEDGE_SYNC_MIRROR_DIR:?Set the host mirror directory}"
SET="$1"; DIR="$2"; TARGET="$3"
BASE="${KNOWLEDGE_SYNC_UPLOAD_DIR:?Set the host upload directory}"
SYNC="${KNOWLEDGE_SYNC_DIR:?Set the host sync directory}"
cd "${KNOWLEDGE_SYNC_TOOLS_DIR:?Set the host converter directory}"
echo "[$(date '+%F %T')] export $SET"
java -Dokm.config="$SYNC/export-$SET.properties" OkmExport
echo "[$(date '+%F %T')] stage $DIR"
python3 "$SYNC/stage_release.py" "$BASE/$DIR" "$BASE/${DIR}_stage_docx" "$BASE/${DIR}_stage_pdf"
mkdir -p "$BASE/${DIR}_md"
echo "[$(date '+%F %T')] docx2md"
python3 docx2md.py "$BASE/${DIR}_stage_docx" "$BASE/${DIR}_md"
if [ -n "$(find "$BASE/${DIR}_stage_pdf" -type f -name '*.pdf' -print -quit 2>/dev/null)" ]; then
  echo "[$(date '+%F %T')] pdf2md (PDFs without a Word twin)"
  python3 pdf2md.py "$BASE/${DIR}_stage_pdf" "$BASE/${DIR}_md"
fi
mkdir -p "$W/release/$TARGET"
echo "[$(date '+%F %T')] deploy -> release/$TARGET"
./deploy_md.sh "$BASE/${DIR}_md" "$W/release/$TARGET"
echo "[$(date '+%F %T')] done $SET"
