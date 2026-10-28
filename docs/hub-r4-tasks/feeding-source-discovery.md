# Avoid repeated source authorization when discovering a product

An unbound source read may have thousands of visible feeding entries under the same source digest. Product discovery currently checks every entry's current visibility even after a visible record has already established that product. It needs one currently readable witness per distinct product; an unreadable record must never establish a product, and a later readable record of the same product must still be considered.

Scan the same records and exact structured product fields, but stop checking further witnesses for an already established product. Keep all source, account, product and current read-tier checks for every witness actually used; do not reuse one record's authorization to expose another record. Do not guess product, normalize names or alter stored records. Metadata selection retains its existing path and ordering.

Scope: `hub/knowledge/feeding.ts`, synthetic tests and this task page. Reproduce the scaling problem with a multi-thousand-record synthetic source and check that hidden and later visible witnesses preserve the old result. Run affected checks and the relevant feeding tests; real performance remains unproven until the updated Hub is deployed and observed.
