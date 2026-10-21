#!/bin/bash
# Daily: update the extra manual lines added by the hub knowledge sync and convert them when the sources changed.
cd /root/Openkm_download || exit 1
U=/root/infotest_server/uploads
W=/var/www/data
for br in rel_apv_10_4_2 rel_apv_10_4_5; do
  for kind in app cli; do
    d=${kind}_cn
    python3 svn_update_and_convert.py "$U/$kind/$br/$d" "$W/$kind/$br/$d" || echo "[$(date '+%F %T')] [fail] $kind/$br/$d rc=$?"
  done
done
