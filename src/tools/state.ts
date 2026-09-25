// State, skill, and interaction tools: todo_list, skill, ask_user_question (HERAV1TOOL-SP01 FR-07, FR-08; IS-07).

import { ToolError } from "../errors.ts";
import type { TodoItem } from "../models.ts";
import { findSkill } from "../prompt/loader.ts";
import type { ToolContext, ToolResult } from "./registry.ts";

const TODO_STATUSES = new Set(["pending", "in_progress", "completed"]);
const TODO_PRIORITIES = new Set(["high", "medium", "low"]);

export async function todoList(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const raw = args["todos"] as Array<Record<string, unknown>>;
  const seen = new Set<string>();
  const items: TodoItem[] = [];
  for (const [i, item] of raw.entries()) {
    const id = String(item["id"]);
    if (id.trim().length === 0) throw new ToolError(`todo_list: item ${i + 1} has an empty id.`, "Give every item a unique id.");
    if (seen.has(id)) throw new ToolError(`todo_list: duplicate id '${id}'.`, "Ids must be unique.");
    seen.add(id);
    const status = String(item["status"]);
    const priority = String(item["priority"]);
    if (!TODO_STATUSES.has(status)) throw new ToolError(`todo_list: item '${id}' has status '${status}'; expected pending, in_progress, or completed.`, "Fix the status.");
    if (!TODO_PRIORITIES.has(priority)) throw new ToolError(`todo_list: item '${id}' has priority '${priority}'; expected high, medium, or low.`, "Fix the priority.");
    items.push({ id, content: String(item["content"]), status: status as TodoItem["status"], priority: priority as TodoItem["priority"] });
  }
  ctx.state.todo = items;
  await Promise.resolve();
  return { status: "ok", text: JSON.stringify({ todos: items }, null, 2) };
}

export async function skill(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const name = String(args["SkillName"]);
  const system = ctx.promptSystem;
  const names = system?.skills.map((s) => s.name).sort() ?? [];
  const found = system !== undefined ? findSkill(system, name) : undefined;
  if (found === undefined) throw new ToolError(`Unknown skill '${name}'. Available skills: ${names.join(", ") || "(none)"}.`, "Use one of the listed names (case-sensitive).");
  const files = found.supportingFiles.length > 0 ? `\n\nSupporting files (relative to ${found.path}):\n${found.supportingFiles.map((f) => `- ${f}`).join("\n")}` : "";
  await Promise.resolve();
  return { status: "ok", text: `${found.content}${files}` };
}

export async function askUserQuestion(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const question = String(args["question"]);
  const options = args["options"] as Array<{ label: string; description?: string }>;
  if (options.length < 1 || options.length > 4) throw new ToolError(`ask_user_question: ${options.length} options given; provide 1 to 4.`, "Reduce or add options.");
  const allowMultiple = args["allowMultiple"] === true;
  let answer;
  try {
    answer = await ctx.askUser({ question, options: options.map((o) => (o.description !== undefined ? { label: o.label, description: o.description } : { label: o.label })), allowMultiple });
  } catch (error) {
    if (ctx.signal.aborted) return { status: "cancelled", text: "question cancelled before an answer arrived." };
    throw new ToolError(`ask_user_question: no answer - ${error instanceof Error ? error.message : String(error)}`, "Continue without the answer.");
  }
  if (answer.selected !== undefined && answer.selected.length > 0) return { status: "ok", text: answer.selected.join("\n") };
  return { status: "ok", text: answer.text ?? "" };
}
