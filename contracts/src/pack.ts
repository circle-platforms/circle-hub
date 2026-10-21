// Shapes owned by the pack work package. Register every record or pack-file schema in `schemas`; contracts/src/index.ts merges them
// into SCHEMA_REGISTRY, which tools/gen-contracts.ts turns into contracts/generated/schemas/*.json. Keys are `name@major`.
import type { z } from 'zod';

export const schemas: Record<string, z.ZodType> = {};
