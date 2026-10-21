#!/bin/bash
# Hourly: every release-document set of the hub knowledge sync. A failure of one set does not stop the others.
cd /root/hub_sync || exit 1
for s in "rel-infosec REL_INFOSEC infosec" "rel-array REL_ARRAY array" "rel-oem REL_OEM oem" "rel-critical REL_CRITICAL critical"; do
  set -- $s
  ./release_pipeline.sh "$1" "$2" "$3" || echo "[$(date '+%F %T')] [fail] $1 rc=$?"
done
