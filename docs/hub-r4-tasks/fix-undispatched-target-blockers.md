# Release physical occupancy after a proven no-send terminal

Owner scope: Hub dispatch journal occupancy selection, synthetic dispatch regressions and dispatch documentation. No real data, execution, deployment or history rewrite.

The blockers query omitted boundary_refused, so it observed only the reservation of a completed no-send job. Discover reservations, match physical scope using the existing identity rules, and read complete candidate-job histories in batches of at most 128 jobs. Do not enumerate terminal phases. Only structured terminal/outcome evidence can release occupancy. Frozen effects, unknown effects, active reservations and unfinished intents remain blockers; an old terminal cannot hide a newer intent. Confirmed risk disposition keeps its existing meaning and does not become proof of non-execution.

The synthetic integration fails clause 6 after physical reservation, records not_dispatched with no intent, then creates a new verification run on the same target and proves one successful submission. Negative controls retain blocking for unknown/frozen/active work and missing no-send proof after an intent. A 300-job synthetic history pins batch sizes and verifies arbitrary no-send terminal phases are honored. Existing dispatch lifecycle, concurrency and disposition tests remain required.
