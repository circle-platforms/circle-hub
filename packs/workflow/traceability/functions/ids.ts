// The id normalisation of the matrix: ids compare as exact strings after it. A pure run of ASCII digits loses its leading
// zeros ('0074001' and '74001' are one defect; '000' is '0'); anything else compares exactly as written. The bug and the
// story numberings never meet: the case view is keyed by the defects field, which holds bug ids only.
export function normalizeId(id: string): string {
  return /^[0-9]+$/.test(id) ? id.replace(/^0+/, '') || '0' : id;
}
