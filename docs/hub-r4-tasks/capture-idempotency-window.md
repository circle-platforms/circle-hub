# Clarify operation capture retry lifetime

The operation-capture instructions must describe the Hub's existing client-key lifetime: a retry can reuse its run only within the window recorded by the Hub, which defaults to 24 hours. After that window an identical request can create a new run, so an unknown prior outcome needs reconciliation before resubmission.

Change only the knowledge-contribution documentation, versioned generated skill snapshots and signed pack manifest. This clarification does not alter the retry implementation or historical records.
