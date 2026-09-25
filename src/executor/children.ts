// Tool child registry (HERAV1EXEC-SP01 FR-07, IG-07; HERAV1EXEC-IP01 IS-07). Every pid the tools spawn is known here;
// register/deregister trigger an extra heartbeat so the Communicator's `children` view is fresh (HERAV1PROC-SP01 FR-04).

import type { ChildRegistryHooks } from "../tools/registry.ts";

export interface ChildEntry {
  pid: number;
  label: string;
  since: number;
}

export class ChildRegistry implements ChildRegistryHooks {
  private readonly entries = new Map<number, ChildEntry>();

  constructor(private readonly onChange: () => void = () => {}) {}

  register(pid: number, description: string): void {
    this.entries.set(pid, { pid, label: description, since: performance.now() });
    this.onChange();
  }

  deregister(pid: number): void {
    if (this.entries.delete(pid)) this.onChange();
  }

  list(): number[] {
    return [...this.entries.keys()];
  }

  size(): number {
    return this.entries.size;
  }

  /** Kills every registered pid, waits up to `waitMs`, and returns the survivors (named by the caller in one WARNING). */
  async terminateAll(waitMs = 1000): Promise<{ terminated: number[]; survivors: number[] }> {
    const pids = this.list();
    for (const pid of pids) kill(pid, "SIGTERM");
    const deadline = performance.now() + waitMs;
    const survivors = new Set(pids);
    while (survivors.size > 0 && performance.now() < deadline) {
      for (const pid of [...survivors]) if (!alive(pid)) survivors.delete(pid);
      if (survivors.size > 0) await Bun.sleep(25);
    }
    for (const pid of survivors) kill(pid, "SIGKILL");
    const remaining = [...survivors].filter(alive);
    for (const pid of pids) this.entries.delete(pid);
    this.onChange();
    return { terminated: pids.filter((p) => !remaining.includes(p)), survivors: remaining };
  }
}

function kill(pid: number, signal: "SIGTERM" | "SIGKILL"): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Best-effort termination of orphan pids from the previous Executor's last heartbeat; returns the pids that were reaped. */
export function reapOrphans(pids: readonly number[]): number[] {
  const reaped: number[] = [];
  for (const pid of pids) {
    if (!alive(pid)) continue;
    kill(pid, "SIGKILL");
    reaped.push(pid);
  }
  return reaped;
}
