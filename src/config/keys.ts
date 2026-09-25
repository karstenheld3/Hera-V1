// API key resolution (HERAV1PRCF-SP01 FR-01, IG-03; HERAV1PRCF-IP01 IS-03).
// Values never appear in logs, events, errors, or IPC: KeyHandle serializes redacted and reveals only to adapter factories.

import type { ProviderId } from "../models.ts";

export type KeyedProvider = Exclude<ProviderId, "scripted">;

export const KEY_VARS: Readonly<Record<KeyedProvider, string>> = Object.freeze({ openai: "OPENAI_API_KEY", anthropic: "ANTHROPIC_API_KEY", zai: "ZAI_API_KEY" });

export const PROVIDER_DISPLAY: Readonly<Record<KeyedProvider, string>> = Object.freeze({ openai: "OpenAI", anthropic: "Anthropic", zai: "Z.ai" });

export const KEY_FILE_NAME = ".api-keys.txt";

export const KEY_FILE_TEMPLATE = `# Hera API keys - one KEY=value line per provider. Lines starting with # are ignored.
# Alternative: set the same names as environment variables.
# OPENAI_API_KEY=
# ANTHROPIC_API_KEY=
# ZAI_API_KEY=
`;

export interface KeyFileParse {
  entries: Record<string, string>;
  warnings: string[];
}

/** `KEY=value` lines, `#` comments; quotes stripped; malformed or empty-value lines ignored with one WARNING (line number only, EC-07). */
export function parseKeyFile(text: string, fileLabel = KEY_FILE_NAME): KeyFileParse {
  const entries: Record<string, string> = {};
  const malformed: number[] = [];
  const lines = text.split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) {
      malformed.push(index + 1);
      continue;
    }
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
      malformed.push(index + 1);
      continue;
    }
    if (value.length === 0) continue; // an empty value is "not set", not malformed
    entries[name] = value;
  }
  const warnings = malformed.length > 0 ? [`WARNING: ${fileLabel}: ${malformed.length === 1 ? "line" : "lines"} ${malformed.join(", ")} ignored (expected KEY=value).`] : [];
  return { entries, warnings };
}

export type KeySource = "env" | "file";

/** Opaque handle: `reveal()` is the only way to the value; JSON and string conversions are redacted. */
export class KeyHandle {
  readonly provider: KeyedProvider;
  readonly variable: string;
  readonly source: KeySource;
  readonly #value: string;

  constructor(provider: KeyedProvider, source: KeySource, value: string) {
    this.provider = provider;
    this.variable = KEY_VARS[provider];
    this.source = source;
    this.#value = value;
  }

  reveal(): string {
    return this.#value;
  }

  toJSON(): { provider: KeyedProvider; source: KeySource; variable: string } {
    return { provider: this.provider, source: this.source, variable: this.variable };
  }

  toString(): string {
    return `[${this.variable} from ${this.source}]`;
  }
}

export function resolveKey(provider: KeyedProvider, env: Record<string, string | undefined>, fileEntries: Record<string, string>): KeyHandle | undefined {
  const variable = KEY_VARS[provider];
  const fromEnv = env[variable];
  if (fromEnv !== undefined && fromEnv.trim().length > 0) return new KeyHandle(provider, "env", fromEnv.trim());
  const fromFile = fileEntries[variable];
  if (fromFile !== undefined && fromFile.length > 0) return new KeyHandle(provider, "file", fromFile);
  return undefined;
}

/** `Keys: Z.ai (Environment variable: ZAI_API_KEY), OpenAI (.agent-data\config\.api-keys.txt: OPENAI_API_KEY)` */
export function keySourceLine(handles: KeyHandle[], keyFileRel = `.agent-data\\config\\${KEY_FILE_NAME}`): string {
  if (handles.length === 0) return "Keys: none resolved";
  return `Keys: ${handles.map((h) => `${PROVIDER_DISPLAY[h.provider]} (${h.source === "env" ? "Environment variable" : keyFileRel}: ${h.variable})`).join(", ")}`;
}

export function missingKeyMessage(provider: KeyedProvider, keyFilePath: string, allowFile: boolean = true): { message: string; action: string } {
  const variable = KEY_VARS[provider];
  if (allowFile) {
    return {
      message: `${variable} not found in the environment or in '${keyFilePath}'.`,
      action: `Set the variable or add a '${variable}=' line to the file.`,
    };
  }
  return {
    message: `${variable} not found in the environment.`,
    action: `Set the ${variable} environment variable.`,
  };
}

/** U11: WARNING text when any key handle has `source === "file"`. Returns undefined when no file-sourced keys. */
export function fileSourceWarning(handles: KeyHandle[]): string | undefined {
  const fileCount = handles.filter((h) => h.source === "file").length;
  if (fileCount === 0) return undefined;
  return `WARNING: ${fileCount} key(s) loaded from .api-keys.txt - prefer environment variables`;
}
