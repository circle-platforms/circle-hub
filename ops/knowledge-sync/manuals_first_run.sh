#!/bin/bash
# First conversion of the manual lines added by the hub knowledge sync (later runs: svn_update_and_convert.py from cron).
set -u
U="${KNOWLEDGE_SYNC_UPLOAD_DIR:?Set the host upload directory}"
W="${KNOWLEDGE_SYNC_MIRROR_DIR:?Set the host mirror directory}"
cd "${KNOWLEDGE_SYNC_TOOLS_DIR:?Set the host converter directory}"
for br in ${KNOWLEDGE_SYNC_MANUAL_BRANCHES:?Set the space-separated manual branches}; do
  for kind in app cli; do
    d=${kind}_cn
    echo "[$(date '+%F %T')] adoc2md $kind/$br/$d"
    mkdir -p "$W/$kind/$br/$d"
    python3 adoc2md.py "$U/$kind/$br/$d" "$W/$kind/$br/$d" || echo "[fail] $kind/$br/$d rc=$?"
  done
done
echo "[$(date '+%F %T')] manuals first run finished"
