// Selftest report and results writer (HERAV1STST-SP01 FR-01, FR-14, section 10; HERAV1STST-IP01 IS-02). Script-level
// output: menu, progress lines, category summaries, RESULT line; results.json written atomically on every exit path.

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatUsd } from "../cost.ts";
import { VERSION } from "../version.ts";

export type TestStatus = "pass" | "fail" | "skip" | "error" | "budget_exceeded";

export interface TestResult {
  category: string;
  check: string;
  status: TestStatus;
  duration_seconds: number;
  detail?: string | null;
  error_message: string | null;
  warning?: string;
  model_id?: string;
  provider?: string;
  method?: string;
  effort?: string;
  usage?: { uncached_input: number; cache_write: number; cache_read: number; output: number };
  cost_usd?: number;
}

export interface Summary {
  pass: number;
  fail: number;
  skip: number;
  error: number;
  budget_exceeded: number;
  interrupted?: boolean;
}

export interface CategoryInfo {
  code: string;
  name: string;
  costClass: "offline" | "live";
  /** menu estimate, e.g. `~$0.15 (35 models)` or `free` */
  estimate: string;
}

export const USAGE_LINE = "Usage: hera selftest <codes...> | all | offline | live [--provider P] [--model M] [--budget N] [--timeout S] [--deadline S]";

export function menuText(categories: CategoryInfo[], scripted = false): string {
  const lines = [scripted ? "SELFTEST MENU [SCRIPTED]" : "SELFTEST MENU"];
  for (const c of categories) lines.push(`  ${c.code}  ${c.name.padEnd(20)} ${c.costClass.padEnd(8)} ${c.estimate}`);
  lines.push(USAGE_LINE);
  return `${lines.join("\n")}\n`;
}

export function summarize(tests: TestResult[]): Summary {
  const s: Summary = { pass: 0, fail: 0, skip: 0, error: 0, budget_exceeded: 0 };
  for (const t of tests) s[t.status]++;
  return s;
}

/** IG-03: exit 0 only with zero fail and zero error (skips and budget stops are not failures); usage errors exit 2 elsewhere. */
export function exitCodeFor(summary: Summary): 0 | 1 {
  return summary.fail === 0 && summary.error === 0 ? 0 : 1;
}

export function checkLine(name: string, detail: string, status: TestStatus, warning?: string): string {
  const mark = status === "pass" ? (warning !== undefined ? "OK (warning)" : "OK") : status === "skip" ? "SKIP" : status === "budget_exceeded" ? "BUDGET" : "FAIL";
  return `  ${name}: ${detail}...${mark}`;
}

export function categorySummaryLine(code: string, name: string, tests: TestResult[]): string {
  const s = summarize(tests);
  const parts = [`${s.pass} passed`];
  if (s.fail > 0) parts.push(`${s.fail} failed`);
  if (s.error > 0) parts.push(`${s.error} errors`);
  if (s.skip > 0) parts.push(`${s.skip} skipped`);
  if (s.budget_exceeded > 0) parts.push(`${s.budget_exceeded} over budget`);
  return `  ${code} ${name}: ${parts.join(", ")}.`;
}

export function resultLine(summary: Summary, costUsd: number, durationSeconds: number): string {
  const extra = summary.error > 0 ? `, ${summary.error} errors` : "";
  const budget = summary.budget_exceeded > 0 ? `, ${summary.budget_exceeded} over budget` : "";
  const interrupted = summary.interrupted === true ? " | INTERRUPTED" : "";
  return `RESULT: ${summary.pass} passed, ${summary.fail} failed, ${summary.skip} skipped${extra}${budget} | ${formatUsd(costUsd)} | ${durationSeconds.toFixed(1)} secs${interrupted}`;
}

export interface ResultsDocument {
  timestamp: string;
  hera_version: string;
  bun_version: string;
  standalone: boolean;
  scripted: boolean;
  categories_run: string[];
  budget_usd: number;
  cost_usd: number;
  duration_seconds: number;
  summary: Summary;
  tests: TestResult[];
}

const stampDir = (now: Date): string => {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}_${p(now.getHours())}-${p(now.getMinutes())}-${p(now.getSeconds())}`;
};

/** Accumulates results; `flush()` writes results.json atomically (temp + rename), falling back to the OS temp dir (EC-17). */
export class ResultsWriter {
  readonly tests: TestResult[] = [];
  readonly categoriesRun: string[] = [];
  path: string;
  fallbackWarning: string | undefined;
  private readonly startedAt = performance.now();

  constructor(
    dataDir: string,
    readonly budgetUsd: number,
    readonly scripted: boolean,
    now: Date = new Date(),
  ) {
    const preferred = join(dataDir, "selftest", stampDir(now));
    this.path = join(preferred, "results.json");
    try {
      mkdirSync(preferred, { recursive: true });
      writeFileSync(join(preferred, ".probe"), "");
    } catch (error) {
      const fallbackDir = join(tmpdir(), "hera-selftest", stampDir(now));
      mkdirSync(fallbackDir, { recursive: true });
      this.fallbackWarning = `WARNING: ${join(dataDir, "selftest")} not writable (${error instanceof Error ? error.message : String(error)}) - results.json written to ${join(fallbackDir, "results.json")}`;
      this.path = join(fallbackDir, "results.json");
    }
  }

  add(result: TestResult): void {
    this.tests.push(result);
  }

  get costUsd(): number {
    return Math.round(this.tests.reduce((sum, t) => sum + (t.cost_usd ?? 0), 0) * 1e6) / 1e6;
  }

  get durationSeconds(): number {
    return Math.round((performance.now() - this.startedAt) / 100) / 10;
  }

  document(interrupted = false): ResultsDocument {
    const summary = summarize(this.tests);
    if (interrupted) summary.interrupted = true;
    return {
      timestamp: new Date().toISOString().slice(0, 19).replace("T", " "),
      hera_version: VERSION,
      bun_version: Bun.version,
      standalone: Bun.isStandaloneExecutable,
      scripted: this.scripted,
      categories_run: [...this.categoriesRun],
      budget_usd: this.budgetUsd,
      cost_usd: this.costUsd,
      duration_seconds: this.durationSeconds,
      summary,
      tests: [...this.tests],
    };
  }

  /** Always valid JSON on disk: write to a temp file, then rename over the target (IG-05). */
  flush(interrupted = false): ResultsDocument {
    const doc = this.document(interrupted);
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
    if (existsSync(this.path)) {
      try {
        renameSync(tmp, this.path);
        return doc;
      } catch {
        /* fall through to copy */
      }
    }
    renameSync(tmp, this.path);
    return doc;
  }
}
