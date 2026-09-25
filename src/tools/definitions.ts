// Tool definitions (HERAV1TOOL-SP01 FR-01, DD-02, IG-01; HERAV1TOOL-IP01 IS-01).
// Byte source: V1 definitions.py templates (authority chain in spec 05 section 5). Generated once from
// tests/fixtures/tools/tool_definitions.json; the unit test diffs this constant against that fixture on every run.
// Placeholders filled at build time: {OS} and {SHELL} in run_command, {SKILL_LIST} in skill, {EXCLUDED_DIRECTORIES} in search.

import type { ToolDefinition } from "../models.ts";

/** One excluded-directory list for the search tool and the workspace tree (spec 05 FR-03, HERAV1-IN01 DR-07). */
export const EXCLUDED_DIRECTORIES = [".git", ".hg", ".svn", "node_modules", "__pycache__", ".venv", "venv", ".pytest_cache", ".mypy_cache", ".agent", ".agent-data", "dist", "build"] as const;

export interface DefinitionTemplate {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

export const DEFINITION_TEMPLATES: readonly DefinitionTemplate[] = [
  {
    name: "read_file",
    description: "Reads a file at the specified relative path.\nThis tool is only able to read files in the workspace that are not gitignored.\nIf the User provides a path to a file assume that path is valid. It is okay to read a file that does not exist; an error will be returned.\n\nUsage:\n- The file_path parameter must be an absolute path, not a relative path\n- You can optionally specify a line offset and limit to read files that are larger than 1000 lines. For other files, do not provide these parameters to read the whole file.\n- Any lines longer than 2000 characters will be truncated\n- Text files are returned with 1-indexed line numbers in cat -n format\n- Image files (jpg, jpeg, png, gif, bmp, webp, svg, tiff, ico, heic, heif) are automatically presented visually\n- You have the capability to call multiple tools in a single response. It is always better to speculatively read multiple files as a batch that are potentially useful.\n- You will regularly be asked to read screenshots. If the user provides a path to a screenshot ALWAYS use this tool to view the file at the path. This tool will work with all temporary file paths like /var/folders/123/abc/T/TemporaryItems/NSIRD_screencaptureui_ZfB1tD/Screenshot.png\n- If you read a file that exists but has empty contents you will receive a system reminder warning in place of file contents.",
    schema: {"type":"object","additionalProperties":false,"properties":{"file_path":{"type":"string"},"offset":{"type":"integer"},"limit":{"type":"integer"}},"required":["file_path"]},
  },
  {
    name: "list_dir",
    description: "Lists files and directories in a given path. The path parameter must be an absolute path to a directory that exists. For each item in the directory, output will have: relative path to the file or directory, and size in bytes if file or number of items (recursive) if directory. You should generally prefer the search tool, if you know which directories to search.",
    schema: {"type":"object","additionalProperties":false,"properties":{"DirectoryPath":{"type":"string"}},"required":["DirectoryPath"]},
  },
  {
    name: "search",
    description: "Search for files, directories, or file content within a directory tree.\n\nTwo modes:\n- Mode='content' (default): Search file content for a regex or literal pattern. Returns matching files with counts, or matching lines when MatchPerLine=true.\n- Mode='name': Search for files or directories by name pattern (glob format). Set Type to filter results.\n\nExcluded directories (hardcoded): {EXCLUDED_DIRECTORIES}.\nHidden files (starting with .) ARE searched. Binary files are skipped.\n\nUsage:\n- DO NOT USE MatchPerLine for initial searches. Use it only for specific, targeted searches.\n- Query is regex in content mode, glob in name mode. Set FixedStrings=true for literal content search.\n- Use Includes to filter by file glob (e.g. '*.py'). Use MaxDepth to limit traversal depth.\n- Results capped at 50 (name mode) or 200 lines (content mode).\n- If truncated, narrow your search with a more specific query or more filters.",
    schema: {"type":"object","additionalProperties":false,"properties":{"Query":{"type":"string"},"SearchPath":{"type":"string"},"Mode":{"type":"string","enum":["content","name"]},"MatchPerLine":{"type":"boolean"},"Type":{"type":"string","enum":["file","directory","any"]},"MaxDepth":{"type":"integer"},"Includes":{"type":"array","items":{"type":"string"}},"CaseSensitive":{"type":"boolean"},"FixedStrings":{"type":"boolean"}},"required":["Query","SearchPath"]},
  },
  {
    name: "edit",
    description: "Performs exact string replacements in files.\n\nUsage:\n- You must use your `Read` tool at least once in the conversation before editing. This tool will error if you attempt an edit without reading the file.\n- When editing text from Read tool output, ensure you preserve the exact indentation (tabs/spaces) as it appears AFTER the line number prefix. The line number prefix format is: spaces + line number + tab. Everything after that tab is the actual file content to match. Never include any part of the line number prefix in the old_string or new_string.\n- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.\n- Only use emojis if the user explicitly requests it. Avoid adding emojis to files unless asked.\n- The edit will FAIL if `old_string` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use `replace_all` to change every instance of `old_string`.\n- Use `replace_all` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.\n- The edit will FAIL if `old_string` and `new_string` are identical. This is considered a no-op and will throw an error.\n- Include an `explanation` field to describe the change you are making.\nIMPORTANT: You must generate the following arguments first, before any others: [file_path]",
    schema: {"type":"object","additionalProperties":false,"properties":{"explanation":{"type":"string"},"file_path":{"type":"string"},"old_string":{"type":"string"},"new_string":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["file_path","old_string","new_string"]},
  },
  {
    name: "multi_edit",
    description: "This is a tool for making multiple edits to a single file in one operation. It is built on top of the Edit tool and allows you to perform multiple find-and-replace operations efficiently. Prefer this tool over the Edit tool when you need to make multiple edits to the same file.\n\nBefore using this tool:\n\n1. Use the Read tool to understand the file's contents and context\n2.Verify the directory path is correct\n\nTo make multiple file edits, provide the following: \n1.file_path: The path to the file to modify, relative to the root of the repository\n2.edits: An array of edit operations to perform, where each edit contains: \n   - old_string: The text to replace(must match the file contents exactly, including all whitespace and indentation) \n - new_string: The edited text to replace the old_string\n - replace_all: Replace all occurrences of old_string.This parameter is optional and defaults to false.\n3.explanation: A description of the change to be made\n\nIMPORTANT: \n - All edits are applied in sequence, in the order they are provided\n - Each edit operates on the result of the previous edit\n - All edits must be valid for the operation to succeed - if any edit fails, none will be applied\n - This tool is ideal when you need to make several changes to different parts of the same file\n - For Jupyter notebooks(.ipynb files), use the NotebookEdit instead\n\nCRITICAL REQUIREMENTS: \n1.All edits follow the same requirements as the single Edit tool\n2.The edits are atomic - either all succeed or none are applied\n3.Plan your edits carefully to avoid conflicts between sequential operations\n\nWARNING: \n - The tool will fail if edits.old_string doesn't match the file contents exactly (including whitespace)\n- The tool will fail if edits.old_string and edits.new_string are the same\n- Since edits are applied in sequence, ensure that earlier edits don't affect the text that later edits are trying to find\n\nWhen making edits: \n - Ensure all edits result in idiomatic, correct code\n - Do not leave the code in a broken state\n - Always use absolute file paths(starting with /) \n - Only use emojis if the user explicitly requests it.Avoid adding emojis to files unless asked.\n - Use replace_all for replacing and renaming strings across the file.This parameter is useful if you want to rename a variable for instance.\n\nIf you want to create a new file, use: \n - A new file path, including dir name if needed\n - First edit: empty old_string and the new file's contents as new_string\n- Subsequent edits: normal edit operations on the created content\nIMPORTANT: You must generate the following arguments first, before any others: [file_path]",
    schema: {"type":"object","additionalProperties":false,"properties":{"explanation":{"type":"string"},"file_path":{"type":"string"},"edits":{"type":"array","minItems":1,"items":{"type":"object","additionalProperties":false,"properties":{"old_string":{"type":"string"},"new_string":{"type":"string"},"replace_all":{"type":"boolean"}},"required":["old_string","new_string"]}}},"required":["file_path","edits"]},
  },
  {
    name: "write_to_file",
    description: "Use this tool to create new files. The file and any parent directories will be created for you if they do not already exist.\n\t\tFollow these instructions:\n\t\t1. NEVER use this tool to modify or overwrite existing files. Always first confirm that TargetFile does not exist before calling this tool.\n\t\t2. You MUST specify the full TargetFile before any of the code contents.\nIMPORTANT: You must generate the following arguments first, before any others: [TargetFile]",
    schema: {"type":"object","additionalProperties":false,"properties":{"TargetFile":{"type":"string"},"CodeContent":{"type":"string"},"EmptyFile":{"type":"boolean"}},"required":["TargetFile","CodeContent","EmptyFile"]},
  },
  {
    name: "run_command",
    description: "PROPOSE a command to run on behalf of the user. Operating System: {OS}. Shell: {SHELL}.\n**NEVER PROPOSE A cd COMMAND**.\nIf you have this tool, note that you DO have the ability to run commands directly on the USER's system.\nMake sure to specify CommandLine exactly as it should be run in the shell.\nNote that the user will have to approve the command before it is executed. The user may reject it if it is not to their liking.\nThe actual command will NOT execute until the user approves it. The user may not approve it immediately.\nIf the step is WAITING for user approval, it has NOT started running.\nCommands will be run with PAGER=cat. You may want to limit the length of output for commands that usually rely on paging and may contain very long output (e.g. git log, use git log -n <N>).",
    schema: {"type":"object","additionalProperties":false,"properties":{"CommandLine":{"type":"string"},"Cwd":{"type":"string"},"Blocking":{"type":"boolean"},"SafeToAutoRun":{"type":"boolean"},"WaitMsBeforeAsync":{"type":"integer"}},"required":["CommandLine"]},
  },
  {
    name: "command_status",
    description: "Check the status of a previously started terminal command by its ID. Returns the current status (running or done), output lines as specified by output priority, and any error if present. If WaitDurationSeconds is specified, this tool will also wait up to that many seconds for the command to finish. Otherwise, this tool will directly return the current status of the command. Do not try to check the status of any IDs other than Background command IDs.",
    schema: {"type":"object","additionalProperties":false,"properties":{"CommandId":{"type":"string"},"OutputCharacterCount":{"type":"integer"},"WaitDurationSeconds":{"type":"integer","default":0}},"required":["CommandId","OutputCharacterCount"]},
  },
  {
    name: "search_web",
    description: "Performs a web search to get a list of relevant web documents for the given query and optional domain filter.",
    schema: {"type":"object","additionalProperties":false,"properties":{"query":{"type":"string"},"domain":{"type":"string"}},"required":["query"]},
  },
  {
    name: "read_url_content",
    description: "Read content from a URL. URL must be an HTTP or HTTPS URL that points to a valid internet resource accessible via web browser.\nNote that the user will have to approve the web request before it is fetched. The user may reject it if it is not to their liking.\nThe actual fetch will NOT execute until the user approves it. The user may not approve it immediately.",
    schema: {"type":"object","additionalProperties":false,"properties":{"Url":{"type":"string"}},"required":["Url"]},
  },
  {
    name: "view_content_chunk",
    description: "View a specific chunk of a web or knowledge base document content using its DocumentId and chunk position. The DocumentId must have already been read by the read_url_content tool before this can be used on that particular DocumentId.",
    schema: {"type":"object","additionalProperties":false,"properties":{"document_id":{"type":"string"},"position":{"type":"integer"}},"required":["document_id","position"]},
  },
  {
    name: "trajectory_search",
    description: "Semantic search or retrieve trajectory. Trajectories are one of conversations. Returns chunks from the trajectory, scored, sorted, and filtered by relevance. Maximum number of chunks returned is 50. Call this tool when the user @mentions a @conversation. Do NOT call this tool with SearchType: 'user'. IGNORE @activity mentions.",
    schema: {"type":"object","additionalProperties":false,"properties":{"ID":{"type":"string","description":"The ID of the trajectory to search or retrieve: conversation ID for conversations, trajectory ID for user activities."},"Query":{"type":"string","description":"The query string to search for within the trajectory. An empty query will return all trajectory steps."},"SearchType":{"type":"string","enum":["conversation","user"],"description":"The type of item to search or retrieve: 'conversation' for conversations, or 'user' for user activities."}},"required":["ID","Query","SearchType"]},
  },
  {
    name: "todo_list",
    description: "Use this tool to create, update, or manage a todo list. This tool helps you organize tasks with different statuses and priorities. You can add new todos, update existing ones, mark them as completed, or reorganize the entire list.\n\nThe tool accepts a list of todo items, each with:\n- content: The task description\n- status: pending, in_progress, or completed\n- priority: high, medium, or low\n- id: A unique identifier for the todo item\n\nUse this tool when you need to:\n- Create a new todo list (mark the first item as in_progress to indicate what you're currently working on)\n- Add items to an existing todo list\n- Update the status of todo items\n- Change priorities of tasks\n- Mark tasks as completed\n- Reorganize or restructure the todo list",
    schema: {"type":"object","additionalProperties":false,"properties":{"todos":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string"},"content":{"type":"string"},"status":{"type":"string","enum":["pending","in_progress","completed"]},"priority":{"type":"string","enum":["high","medium","low"]}},"required":["id","content","status","priority"]}}},"required":["todos"]},
  },
  {
    name: "skill",
    description: "Invoke a skill to get detailed instructions or knowledge for a task.\nUse this when a task matches a skill's description.\nAvailable skills:\n{SKILL_LIST}",
    schema: {"type":"object","additionalProperties":false,"properties":{"SkillName":{"type":"string"}},"required":["SkillName"]},
  },
  {
    name: "ask_user_question",
    description: "Ask the user a question with predefined options. Use this when you need the user to make a choice between specific options.\nYou can provide up to 4 options, each with a label and description.\nNEVER include \"other\" as an option - the user can always automatically provide a custom response.\nSet allowMultiple to true if the user should be able to select more than one option.",
    schema: {"type":"object","additionalProperties":false,"properties":{"question":{"type":"string"},"options":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"label":{"type":"string"},"description":{"type":"string"}},"required":["label","description"]}},"allowMultiple":{"type":"boolean"}},"required":["question","options","allowMultiple"]},
  },
];

export interface DefinitionContext {
  os: string;
  shell: string;
  skills: ReadonlyArray<{ name: string; description: string; supportingFiles: readonly string[] }>;
}

export function renderSkillList(skills: DefinitionContext["skills"]): string {
  return skills
    .map((s) => {
      const n = s.supportingFiles.length;
      const suffix = n > 0 ? ` (${n} supporting file${n === 1 ? "" : "s"})` : "";
      return `- ${s.name}: ${s.description}${suffix}`;
    })
    .join("\n");
}

export function excludedDirectoriesSentence(): string {
  return EXCLUDED_DIRECTORIES.join(", ");
}

/** The 15 definitions with the host placeholders, the skill list, and the excluded-directory sentence filled. */
export function buildDefinitions(ctx: DefinitionContext): ToolDefinition[] {
  return DEFINITION_TEMPLATES.map((t) => {
    let description = t.description;
    if (t.name === "run_command") description = description.replace("{OS}", ctx.os).replace("{SHELL}", ctx.shell);
    else if (t.name === "skill") description = description.replace("{SKILL_LIST}", renderSkillList(ctx.skills));
    else if (t.name === "search") description = description.replace("{EXCLUDED_DIRECTORIES}", excludedDirectoriesSentence());
    return { name: t.name, description, parameters: structuredClone(t.schema) };
  });
}

/** Filter tool definitions by the admit() exposure list. Undefined exposure = all tools (backward compatible). */
export function filterDefinitions(definitions: readonly ToolDefinition[], exposure?: readonly string[]): ToolDefinition[] {
  if (exposure === undefined) return [...definitions];
  const set = new Set(exposure);
  return definitions.filter((d) => set.has(d.name));
}

export const TOOL_NAMES: readonly string[] = DEFINITION_TEMPLATES.map((t) => t.name);

export function definitionByName(definitions: readonly ToolDefinition[], name: string): ToolDefinition | undefined {
  return definitions.find((d) => d.name === name);
}

/** Deterministic serialization (sorted keys) so the session_started snapshot check is stable across processes. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function definitionsHash(definitions: readonly ToolDefinition[]): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(stableJson(definitions));
  return hasher.digest("hex").slice(0, 16);
}
