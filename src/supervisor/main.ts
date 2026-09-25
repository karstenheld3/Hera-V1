// Supervisor role entry (HERAV1SUPV-SP01; HERAV1SUPV-IP01 IS-02, IS-06). Guards, watchdog, review, and memory are wired
// here; the Supervisor never spawns, never sends cancel, and never writes the session JSONL (FR-07, IG-02).

import type { ParsedArgs } from "../args.ts";
import { assertSpawnedByCommunicator } from "../process/child.ts";
import { createSupervisor } from "./core.ts";

export async function supervisorMain(args: ParsedArgs): Promise<number> {
  assertSpawnedByCommunicator("supervisor");
  const { runtime } = createSupervisor(args.epoch);
  runtime.start();
  await new Promise<never>(() => {});
  return 0;
}
