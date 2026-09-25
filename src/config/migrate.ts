// V1-shaped configuration detection and in-memory migration (HERAV1PRCF-SP01 FR-02, HERAV1PRCF-IP01 IS-02).
// The five literal V1 keys are recognized here and nowhere else. The file on disk is never rewritten (DD-06).

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { ConfigError } from "../errors.ts";

/** Literal V1 identifiers (dotted for nested keys). */
export const V1_KEYS = ["roles.generator", "roles.summarizer", "execution_policy", "command_denylist", "unified_file_search_tool"] as const;
const V2_MARKERS = ["roles.generating", "supervisor", "ipc"] as const;

export const MIGRATION_NOTICE =
  "NOTICE: agent-config.json is V1-shaped -> migrated in memory (generator -> generating, summarizer -> compacting, execution_policy dropped, command_denylist -> supervisor.denylist). Hera V1 runs in Turbo mode; the file was not modified.";

export type Raw = Record<string, unknown>;

function has(raw: Raw, dotted: string): boolean {
  const [head, tail] = dotted.split(".", 2);
  if (head === undefined) return false;
  if (tail === undefined) return Object.prototype.hasOwnProperty.call(raw, head);
  const inner = raw[head];
  return typeof inner === "object" && inner !== null && Object.prototype.hasOwnProperty.call(inner, tail);
}

export function presentV1Keys(raw: Raw): string[] {
  return V1_KEYS.filter((k) => has(raw, k));
}

/** V1-shaped: at least one V1 key present AND none of the V2 markers. */
export function isV1Shaped(raw: Raw): boolean {
  return presentV1Keys(raw).length > 0 && !V2_MARKERS.some((m) => has(raw, m));
}

/** A V2-shaped file that still contains a V1 key is a typo, not a migration case (FR-02). */
export function detectMixed(raw: Raw, fileLabel: string): void {
  const v1 = presentV1Keys(raw);
  if (v1.length > 0 && V2_MARKERS.some((m) => has(raw, m))) {
    throw new ConfigError(`${fileLabel}: V2-shaped file contains the V1 key '${v1[0]}'.`, "Remove the V1 key (or convert the whole file back to the V1 shape, which Hera migrates in memory).");
  }
}

/** Removed keys from V2 config that trigger a NOTICE. */
const REMOVED_KEYS = ["supervisor.guard_timeout_ms", "roles.communicator"] as const;

const REMOVED_KEY_REASONS: Record<string, string> = {
  "supervisor.guard_timeout_ms": "removed D-17; the guard protocol was replaced by the harness gate socket",
  "roles.communicator": "removed U14; the communicator process no longer has a model role",
};

/** Detects removed keys in a V2-shaped config and emits one NOTICE per key found. */
export function detectRemovedKeys(raw: Raw, notices: string[]): void {
  for (const dotted of REMOVED_KEYS) {
    if (has(raw, dotted)) {
      const [head, tail] = dotted.split(".", 2);
      const reason = REMOVED_KEY_REASONS[dotted] ?? "no longer used";
      notices.push(`NOTICE: config key '${dotted}' is no longer used (${reason}).`);
      if (head !== undefined && tail !== undefined) {
        const inner = raw[head];
        if (typeof inner === "object" && inner !== null) {
          delete (inner as Record<string, unknown>)[tail];
        }
      }
    }
  }
}

/** Applies the eight FR-02 mapping rules; returns a V2-shaped raw object and the fixed notice line. */
export function migrateV1(raw: Raw): { config: Raw; notice: string } {
  const out: Raw = { ...raw };
  const roles = typeof raw["roles"] === "object" && raw["roles"] !== null ? { ...(raw["roles"] as Raw) } : {};
  if ("generator" in roles) {
    roles["generating"] = roles["generator"];
    delete roles["generator"];
  }
  if ("summarizer" in roles) {
    roles["compacting"] = roles["summarizer"];
    delete roles["summarizer"];
  }
  // rule 3: websearch kept as the alias entry; rule 7: missing roles are filled by the schema defaults (NOTICE per role)
  out["roles"] = roles;
  delete out["execution_policy"]; // rule 4
  delete out["unified_file_search_tool"]; // rule 6
  if ("command_denylist" in raw) {
    const supervisor = typeof raw["supervisor"] === "object" && raw["supervisor"] !== null ? { ...(raw["supervisor"] as Raw) } : {};
    supervisor["denylist"] = raw["command_denylist"]; // rule 5: the user's list wins, even when empty (EC-16)
    out["supervisor"] = supervisor;
    delete out["command_denylist"];
  }
  return { config: out, notice: MIGRATION_NOTICE };
}

/** U12: HMAC-SHA256 (hex) over the canonical JSON of a line without `mac`. */
export function computeMac(lineWithoutMac: Record<string, unknown>, secret: Buffer): string {
  return new Bun.CryptoHasher("sha256", secret).update(JSON.stringify(lineWithoutMac)).digest("hex");
}

/** U12: Tag legacy lines without `mac` with `migrated: true` and a valid `mac`. Returns count migrated. */
export function migrateMemoryFile(file: string, secret: Buffer): number {
  if (!existsSync(file)) return 0;
  const raw = readFileSync(file, "utf8").split(/\r?\n/);
  let migrated = 0;
  let changed = false;
  const out: string[] = [];
  for (const line of raw) {
    if (line.trim().length === 0) continue;
    try {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      if (parsed["mac"] === undefined) {
        const tagged = { ...parsed, migrated: true };
        const mac = computeMac(tagged, secret);
        out.push(JSON.stringify({ ...tagged, mac }));
        migrated++;
        changed = true;
      } else {
        out.push(line);
      }
    } catch {
      out.push(line);
    }
  }
  if (changed) writeFileSync(file, out.join("\n") + "\n");
  return migrated;
}
