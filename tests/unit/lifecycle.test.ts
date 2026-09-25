import { describe, expect, test } from "bun:test";
import { RestartBudget, decideOnExit, reapOrphans, shutdownAll, type ShutdownTarget } from "../../src/process/lifecycle.ts";

describe("HERAV1PROC-TP01 lifecycle", () => {
  test("RestartBudget per-turn counter: default 1 restart per turn, reset on turnStarted", () => {
    const budget = new RestartBudget(1);
    budget.turnStarted();
    expect(budget.tryConsumeTurn()).toBe(true);
    expect(budget.tryConsumeTurn()).toBe(false);
    budget.turnStarted();
    expect(budget.tryConsumeTurn()).toBe(true);
    const zero = new RestartBudget(0);
    zero.turnStarted();
    expect(zero.tryConsumeTurn()).toBe(false);
  });

  test("RestartBudget idle counter: 3 exits within 60 s stop respawn until reset (EC-05)", () => {
    const budget = new RestartBudget(1, 3, 60000);
    let now = 1000;
    expect(budget.tryConsumeIdle(now)).toBe(true);
    now += 1000;
    expect(budget.tryConsumeIdle(now)).toBe(true);
    now += 1000;
    expect(budget.tryConsumeIdle(now)).toBe(true);
    now += 1000;
    expect(budget.tryConsumeIdle(now)).toBe(false);
    expect(budget.idleExhausted).toBe(true);
    budget.resetIdle();
    expect(budget.tryConsumeIdle(now)).toBe(true);
    // exits older than the window fall out
    const windowed = new RestartBudget(1, 3, 60000);
    expect(windowed.tryConsumeIdle(0)).toBe(true);
    expect(windowed.tryConsumeIdle(1)).toBe(true);
    expect(windowed.tryConsumeIdle(2)).toBe(true);
    expect(windowed.tryConsumeIdle(70000)).toBe(true);
  });

  test("decideOnExit maps exit context to the FR-06 action", () => {
    const budget = new RestartBudget(1);
    budget.turnStarted();
    expect(decideOnExit({ turnActive: true, budget, now: 0 })).toBe("respawn_resume");
    expect(decideOnExit({ turnActive: true, budget, now: 0 })).toBe("end_turn");
    const idle = new RestartBudget(1, 3, 60000);
    expect(decideOnExit({ turnActive: false, budget: idle, now: 0 })).toBe("respawn_idle");
    expect(decideOnExit({ turnActive: false, budget: idle, now: 1 })).toBe("respawn_idle");
    expect(decideOnExit({ turnActive: false, budget: idle, now: 2 })).toBe("respawn_idle");
    expect(decideOnExit({ turnActive: false, budget: idle, now: 3 })).toBe("stop_idle");
    expect(decideOnExit({ turnActive: false, budget: idle, now: 4 })).toBe("stop_idle");
  });

  test("shutdownAll: Executor first, then Supervisor; kill after timeout; orphans reaped and survivors named", async () => {
    const order: string[] = [];
    const sleeper = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 60000)"], { stdout: "ignore", stderr: "ignore" });
    const fake = (role: "executor" | "supervisor", exitsOnShutdown: boolean): ShutdownTarget => {
      let resolveExit: ((code: number | null) => void) | undefined;
      const exited = new Promise<number | null>((res) => {
        resolveExit = res;
      });
      let killed = false;
      return {
        role,
        alive: () => !killed,
        sendShutdown() {
          order.push(`shutdown → ${role}`);
          if (exitsOnShutdown) setTimeout(() => resolveExit?.(0), 10);
        },
        waitExit: (timeoutMs: number) => Promise.race([exited, Bun.sleep(timeoutMs).then(() => undefined)]),
        kill() {
          killed = true;
          order.push(`kill ${role}`);
          resolveExit?.(null);
        },
        lastChildren: role === "executor" ? [sleeper.pid] : [],
      };
    };
    const executor = fake("executor", false);
    const supervisor = fake("supervisor", true);
    const result = await shutdownAll([executor, supervisor], 100);
    expect(order).toEqual(["shutdown → executor", "kill executor", "shutdown → supervisor"]);
    expect(result.killed).toEqual(["executor"]);
    expect(result.exitCodes).toEqual({ executor: null, supervisor: 0 });
    await Bun.sleep(100);
    expect(sleeper.exitCode !== null || sleeper.signalCode !== null).toBe(true);
    expect(result.orphansSurvived).toEqual([]);
    expect(reapOrphans([999999])).toEqual([]);
  });
});
