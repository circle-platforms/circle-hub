#!/bin/bash
# First conversion of the manual lines added by the hub knowledge sync (later runs: svn_update_and_convert.py from cron).
set -u
U=/root/infotest_server/uploads
W=/var/www/data
cd /root/Openkm_download
for br in rel_apv_10_4_2 rel_apv_10_4_5; do
  for kind in app cli; do
    d=${kind}_cn
    echo "[$(date '+%F %T')] adoc2md $kind/$br/$d"
    mkdir -p "$W/$kind/$br/$d"
    python3 adoc2md.py "$U/$kind/$br/$d" "$W/$kind/$br/$d" || echo "[fail] $kind/$br/$d rc=$?"
  done
done
echo "[$(date '+%F %T')] manuals first run finished"
