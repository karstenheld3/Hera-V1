// Allow-all gate helper for tests (HERAV1TOOL-TP01 section 8).

import { Gate } from "../../src/harness/gate.ts";
import { ScriptedPlug } from "../../src/harness/plugs/scripted.ts";

/** A Gate whose plug answers "allow" for every effect, indefinitely. */
export function allowAllGate(): Gate {
  return new Gate(new ScriptedPlug([{ answer: "allow" }]));
}
