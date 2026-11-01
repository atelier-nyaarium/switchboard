// A Router plane's lineage, shared by the inbox and hold wires.

import { z } from "zod";

/** Where a Router plane stands. `epoch` is a random tag compared for equality only; `version` orders inside it. */
export const PlaneLineageSchema = z
	.object({ epoch: z.number().int().positive(), version: z.number().int().nonnegative() })
	.meta({ id: "PlaneLineage" });

export type PlaneLineage = z.infer<typeof PlaneLineageSchema>;
