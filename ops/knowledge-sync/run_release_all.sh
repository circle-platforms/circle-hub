#!/bin/bash
# Hourly: every release-document set of the hub knowledge sync. A failure of one set does not stop the others.
cd "${KNOWLEDGE_SYNC_DIR:?Set the host sync directory}" || exit 1
# Slot fields are opaque names, never shell patterns or paths.
set -f
IFS=$' \t\n'
slot=0
malformed=0
for s in "${KNOWLEDGE_SYNC_RELEASE_SET_1-}" "${KNOWLEDGE_SYNC_RELEASE_SET_2-}" "${KNOWLEDGE_SYNC_RELEASE_SET_3-}" "${KNOWLEDGE_SYNC_RELEASE_SET_4-}"; do
  slot=$((slot + 1))
  set -- $s
  valid=true
  if [ "$#" -ne 3 ]; then
    valid=false
  else
    for field in "$@"; do
      if ! [[ "$field" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*$ ]]; then
        valid=false
      fi
    done
  fi
  if [ "$valid" = false ]; then
    echo "[$(date '+%F %T')] [fail] slot $slot malformed"
    malformed=1
    continue
  fi
  ./release_pipeline.sh "$1" "$2" "$3" || {
    exit_code=$?
    echo "[$(date '+%F %T')] [fail] $1 rc=$exit_code"
  }
done
exit "$malformed"
