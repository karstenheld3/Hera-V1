// Plug factory tests (SECREMED-DD-07; HERAV1LGRD-TP01).
// Tests: governed refuses with exit code; scripted without env refuses;
// passthrough returns PassThroughPlug; local returns LocalGuardsPlug;
// plug hash stable.

import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_DENYLIST } from "../../src/config/schema.ts";
import { ProfileError } from "../../src/errors.ts";
import { computePlugHash, createPlug } from "../../src/harness/plugs/factory.ts";
import { LocalGuardsPlug } from "../../src/harness/plugs/localguards.ts";
import { PassThroughPlug } from "../../src/harness/plugs/passthrough.ts";
import { makeTempDir, removeDir } from "../harness/procs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) removeDir(d);
});

describe("SECREMED-DD-07 Plug factory", () => {
  test("governed refuses with ProfileError and exit code 5", () => {
    expect(() => createPlug({ profile: "governed", denylist: DEFAULT_DENYLIST, workspace: "/tmp" })).toThrow(ProfileError);
    try {
      createPlug({ profile: "governed", denylist: DEFAULT_DENYLIST, workspace: "/tmp" });
    } catch (e) {
      expect(e).toBeInstanceOf(ProfileError);
      expect((e as ProfileError).exitCode).toBe(5);
      expect((e as ProfileError).message).toContain("governed");
      expect((e as ProfileError).message).toContain("ACOL");
    }
  });

  test("scripted without HERA_SCRIPTED_ADAPTER refuses with ProfileError", () => {
    expect(() => createPlug({ profile: "scripted", denylist: DEFAULT_DENYLIST, workspace: "/tmp", env: {} })).toThrow(ProfileError);
    try {
      createPlug({ profile: "scripted", denylist: DEFAULT_DENYLIST, workspace: "/tmp", env: {} });
    } catch (e) {
      expect(e).toBeInstanceOf(ProfileError);
      expect((e as ProfileError).exitCode).toBe(5);
      expect((e as ProfileError).message).toContain("scripted");
      expect((e as ProfileError).message).toContain("HERA_SCRIPTED_ADAPTER");
    }
  });

  test("scripted with HERA_SCRIPTED_ADAPTER returns PassThroughPlug", () => {
    const plug = createPlug({ profile: "scripted", denylist: DEFAULT_DENYLIST, workspace: "/tmp", env: { HERA_SCRIPTED_ADAPTER: "/path/to/script.jsonl" } });
    expect(plug).toBeInstanceOf(PassThroughPlug);
  });

  test("passthrough returns PassThroughPlug", () => {
    const plug = createPlug({ profile: "passthrough", denylist: DEFAULT_DENYLIST, workspace: "/tmp" });
    expect(plug).toBeInstanceOf(PassThroughPlug);
  });

  test("local returns LocalGuardsPlug with the config lists", () => {
    const ws = makeTempDir("factory");
    dirs.push(ws);
    const plug = createPlug({ profile: "local", denylist: DEFAULT_DENYLIST, workspace: ws });
    expect(plug).toBeInstanceOf(LocalGuardsPlug);
  });

  test("plug hash is stable for same inputs", () => {
    const h1 = computePlugHash("local", DEFAULT_DENYLIST);
    const h2 = computePlugHash("local", DEFAULT_DENYLIST);
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(16);
  });

  test("plug hash differs for different profiles", () => {
    const hLocal = computePlugHash("local", DEFAULT_DENYLIST);
    const hPass = computePlugHash("passthrough", DEFAULT_DENYLIST);
    expect(hLocal).not.toBe(hPass);
  });

  test("plug hash differs for different denylists", () => {
    const h1 = computePlugHash("local", ["rm"]);
    const h2 = computePlugHash("local", ["rm", "del"]);
    expect(h1).not.toBe(h2);
  });
});
