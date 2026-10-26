// Synthetic pack check function that never returns (the sandbox ends it at its time limit).

export default function spin(_input: unknown): unknown {
  let n = 0;
  for (;;) n = (n + 1) % 1_000_003;
}
