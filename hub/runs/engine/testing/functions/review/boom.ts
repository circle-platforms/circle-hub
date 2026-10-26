// Synthetic pack check function that fails: it throws (FUNCTION_THREW in the sandbox).

export default function boom(_input: unknown): unknown {
  throw new Error('合成的检查函数故障');
}
