// Plug factory - the single function that decides which plug runs (SECREMED-DD-07, HERAV1LGRD-SP01).
// `governed` refuses at startup (no ACOL plug bundled). `scripted` refuses without HERA_SCRIPTED_ADAPTER.
// `passthrough` returns PassThroughPlug (Turbo mode). `local` returns LocalGuardsPlug.

import { LocalGuardsPlug } from "./localguards.ts";
import { PassThroughPlug } from "./passthrough.ts";
import type { GateProvider } from "../provider.ts";
import { ProfileError } from "../../errors.ts";

export type ProfileName = "local" | "passthrough" | "scripted" | "governed";

export interface CreatePlugOptions {
  profile: ProfileName;
  denylist: readonly string[];
  workspace: string;
  read_allowlist?: readonly string[];
  protected_paths?: readonly string[];
  network_commands?: readonly string[];
  approval?: "unsafe" | "all" | "off";
  /** Environment for scripted-adapter check. Default: process.env */
  env?: Record<string, string | undefined>;
}

/**
 * The one function that decides which plug runs. Never hands `governed` a pass-through.
 * Throws ProfileError on refusal (governed without ACOL, scripted without adapter).
 */
export function createPlug(opts: CreatePlugOptions): GateProvider {
  const env = opts.env ?? process.env;
  switch (opts.profile) {
    case "local":
      return new LocalGuardsPlug({ denylist: opts.denylist, workspace: opts.workspace, read_allowlist: opts.read_allowlist, protected_paths: opts.protected_paths, network_commands: opts.network_commands, approval: opts.approval });
    case "passthrough":
      return new PassThroughPlug();
    case "scripted":
      if (env["HERA_SCRIPTED_ADAPTER"] === undefined || env["HERA_SCRIPTED_ADAPTER"] === "") {
        throw new ProfileError(
          `profile 'scripted' requires HERA_SCRIPTED_ADAPTER environment variable`,
          "Set HERA_SCRIPTED_ADAPTER to a scripted adapter script path or use a different profile.",
        );
      }
      return new PassThroughPlug();
    case "governed":
      throw new ProfileError(
        `profile 'governed' requires an ACOL plug; none is bundled in this build`,
        "Use 'local' profile or supply an ACOL plug artifact.",
      );
  }
}

/** Compute a stable hash for the plug. Same inputs → same hash. */
export function computePlugHash(profile: string, denylist: readonly string[]): string {
  if (profile === "local") return new Bun.CryptoHasher("sha256").update(`local:${denylist.join(",")}`).digest("hex").slice(0, 16);
  return new Bun.CryptoHasher("sha256").update(profile).digest("hex").slice(0, 16);
}
