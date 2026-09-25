// The complete tool set wired to one registry (HERAV1TOOL-SP01 FR-01).

import type { ToolDefinition } from "../models.ts";
import { edit, multiEdit, writeToFile } from "./edit.ts";
import { listDir, readFile, search } from "./file.ts";
import { ToolRegistry, type ToolExecutor } from "./registry.ts";
import { commandStatus, runCommand } from "./shell.ts";
import { askUserQuestion, skill, todoList } from "./state.ts";
import { trajectorySearch } from "./trajectory.ts";
import { readUrlContent, searchWeb, viewContentChunk } from "./web.ts";

export function createToolRegistry(definitions: readonly ToolDefinition[]): ToolRegistry {
  const registry = new ToolRegistry(definitions);
  const present = new Set(definitions.map((d) => d.name));
  const registerIfPresent = (name: string, executor: ToolExecutor) => {
    if (present.has(name)) registry.register(name, executor);
  };
  registerIfPresent("read_file", readFile);
  registerIfPresent("list_dir", listDir);
  registerIfPresent("search", search);
  registerIfPresent("edit", edit);
  registerIfPresent("multi_edit", multiEdit);
  registerIfPresent("write_to_file", writeToFile);
  registerIfPresent("run_command", runCommand);
  registerIfPresent("command_status", commandStatus);
  registerIfPresent("search_web", searchWeb);
  registerIfPresent("read_url_content", readUrlContent);
  registerIfPresent("view_content_chunk", viewContentChunk);
  registerIfPresent("trajectory_search", trajectorySearch);
  registerIfPresent("todo_list", todoList);
  registerIfPresent("skill", skill);
  registerIfPresent("ask_user_question", askUserQuestion);
  return registry;
}

export { buildDefinitions, filterDefinitions, definitionsHash, EXCLUDED_DIRECTORIES, TOOL_NAMES } from "./definitions.ts";
export { ToolRegistry, type ToolContext, type ToolResult } from "./registry.ts";
export { commandTableOf, CommandTable } from "./shell.ts";
export { documentStoreOf } from "./web.ts";
export { ledgerOf } from "./file.ts";
