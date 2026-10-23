#!/bin/bash
# Hourly: every release-document set of the hub knowledge sync. A failure of one set does not stop the others.
cd "${KNOWLEDGE_SYNC_DIR:?Set the host sync directory}" || exit 1
for s in "${KNOWLEDGE_SYNC_RELEASE_SET_1:?Set release set 1}" "${KNOWLEDGE_SYNC_RELEASE_SET_2:?Set release set 2}" "${KNOWLEDGE_SYNC_RELEASE_SET_3:?Set release set 3}" "${KNOWLEDGE_SYNC_RELEASE_SET_4:?Set release set 4}"; do
  set -- $s
  ./release_pipeline.sh "$1" "$2" "$3" || echo "[$(date '+%F %T')] [fail] $1 rc=$?"
done
