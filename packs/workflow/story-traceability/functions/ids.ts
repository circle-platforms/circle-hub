// Exact numeric normalisation shared by both traceability contracts; only the stories index participates here.
export function normalizeId(id: string): string {
  return /^[0-9]+$/.test(id) ? id.replace(/^0+/, '') || '0' : id;
}
