#!/bin/bash
# Daily: update the extra manual lines added by the hub knowledge sync and convert them when the sources changed.
cd "${CIRCLE_HUB_SYNC_TOOLS_DIR:?Set the host converter directory}" || exit 1
U="${CIRCLE_HUB_SYNC_UPLOAD_DIR:?Set the host upload directory}"
W="${CIRCLE_HUB_SYNC_MIRROR_DIR:?Set the host mirror directory}"
for br in ${CIRCLE_HUB_SYNC_MANUAL_BRANCHES:?Set the space-separated manual branches}; do
  for kind in app cli; do
    d=${kind}_cn
    python3 svn_update_and_convert.py "$U/$kind/$br/$d" "$W/$kind/$br/$d" || echo "[$(date '+%F %T')] [fail] $kind/$br/$d rc=$?"
  done
done
