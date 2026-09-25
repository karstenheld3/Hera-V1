// Minimal Node.js API surface used by Hera under Bun (HERAV1-PR-0019: no @types/node).

declare interface NodeWritable {
  write(chunk: string | Uint8Array, cb?: (err?: Error | null) => void): boolean;
  end(chunk?: string | Uint8Array): void;
  on(event: string, listener: (...args: any[]) => void): NodeWritable;
  once(event: string, listener: (...args: any[]) => void): NodeWritable;
  readonly isTTY?: boolean;
  readonly columns?: number;
}

declare interface NodeReadable {
  on(event: "data", listener: (chunk: Buffer | string) => void): NodeReadable;
  on(event: "end" | "close", listener: () => void): NodeReadable;
  on(event: string, listener: (...args: any[]) => void): NodeReadable;
  once(event: string, listener: (...args: any[]) => void): NodeReadable;
  removeListener(event: string, listener: (...args: any[]) => void): NodeReadable;
  setEncoding(encoding: string): NodeReadable;
  resume(): NodeReadable;
  pause(): NodeReadable;
  readonly isTTY?: boolean;
  setRawMode?(mode: boolean): NodeReadable;
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer | string>;
}

declare interface NodeProcess {
  readonly argv: string[];
  readonly env: Record<string, string | undefined>;
  readonly pid: number;
  readonly ppid: number;
  readonly execPath: string;
  readonly platform: "win32" | "linux" | "darwin" | string;
  readonly arch: string;
  readonly version: string;
  exitCode: number | undefined;
  title: string;
  readonly stdout: NodeWritable;
  readonly stderr: NodeWritable;
  readonly stdin: NodeReadable;
  readonly connected?: boolean;
  send?(message: unknown, callback?: (error: Error | null) => void): boolean;
  disconnect?(): void;
  cwd(): string;
  exit(code?: number): never;
  kill(pid: number, signal?: string | number): boolean;
  on(event: "message", listener: (message: unknown) => void): NodeProcess;
  on(event: "disconnect" | "exit" | "beforeExit", listener: (code?: number) => void): NodeProcess;
  on(event: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGBREAK", listener: () => void): NodeProcess;
  on(event: "uncaughtException" | "unhandledRejection", listener: (error: unknown) => void): NodeProcess;
  on(event: string, listener: (...args: any[]) => void): NodeProcess;
  once(event: string, listener: (...args: any[]) => void): NodeProcess;
  off(event: string, listener: (...args: any[]) => void): NodeProcess;
  removeListener(event: string, listener: (...args: any[]) => void): NodeProcess;
  hrtime: { bigint(): bigint };
  memoryUsage(): { rss: number; heapUsed: number; heapTotal: number };
  uptime(): number;
}

declare const process: NodeProcess;

declare class Buffer extends Uint8Array {
  static from(data: string, encoding?: string): Buffer;
  static from(data: ArrayBuffer | ArrayBufferView | number[]): Buffer;
  static concat(list: Uint8Array[], totalLength?: number): Buffer;
  static alloc(size: number, fill?: number | string): Buffer;
  static isBuffer(value: unknown): value is Buffer;
  static byteLength(value: string | ArrayBufferView, encoding?: string): number;
  toString(encoding?: string, start?: number, end?: number): string;
  equals(other: Uint8Array): boolean;
  readonly length: number;
}

// Timers come from the DOM lib (number handles); Bun's unref() is reached through unrefTimer() in src/util.

declare module "node:path" {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string, ext?: string): string;
  export function extname(path: string): string;
  export function isAbsolute(path: string): boolean;
  export function relative(from: string, to: string): string;
  export function normalize(path: string): string;
  export const sep: string;
  export const delimiter: string;
  export function parse(path: string): { root: string; dir: string; base: string; ext: string; name: string };
}

declare module "node:fs" {
  export interface Stats {
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
    size: number;
    mtimeMs: number;
    mode: number;
  }
  export interface Dirent {
    name: string;
    isFile(): boolean;
    isDirectory(): boolean;
    isSymbolicLink(): boolean;
  }
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): string | undefined;
  export function readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
  export function readFileSync(path: string): Buffer;
  export function writeFileSync(path: string, data: string | Uint8Array, options?: { encoding?: string; flag?: string; mode?: number } | string): void;
  export function appendFileSync(path: string, data: string | Uint8Array, options?: { encoding?: string; flag?: string } | string): void;
  export function readdirSync(path: string): string[];
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function statSync(path: string): Stats;
  export function statSync(path: string, options: { throwIfNoEntry: false }): Stats | undefined;
  export function lstatSync(path: string): Stats;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function renameSync(from: string, to: string): void;
  export function copyFileSync(from: string, to: string): void;
  export function realpathSync(path: string): string;
  export function readSync(fd: number, buffer: Uint8Array, offset?: number, length?: number, position?: number | null): number;
  export function symlinkSync(target: string, path: string, type?: "dir" | "file" | "junction"): void;
  export function chmodSync(path: string, mode: number | string): void;
  export function openSync(path: string, flags: string | number, mode?: number): number;
  export function closeSync(fd: number): void;
  export function writeSync(fd: number, data: string | Uint8Array): number;
  export function fsyncSync(fd: number): void;
  export function unlinkSync(path: string): void;
  export function mkdtempSync(prefix: string): string;
  export function cpSync(from: string, to: string, options?: { recursive?: boolean }): void;
  export function utimesSync(path: string, atime: number | Date, mtime: number | Date): void;
}

declare module "node:fs/promises" {
  import type { Stats, Dirent } from "node:fs";
  export function readFile(path: string, encoding: "utf8" | "utf-8"): Promise<string>;
  export function readFile(path: string): Promise<Buffer>;
  export function writeFile(path: string, data: string | Uint8Array, options?: { encoding?: string; flag?: string } | string): Promise<void>;
  export function appendFile(path: string, data: string | Uint8Array): Promise<void>;
  export function mkdir(path: string, options?: { recursive?: boolean }): Promise<string | undefined>;
  export function readdir(path: string): Promise<string[]>;
  export function readdir(path: string, options: { withFileTypes: true }): Promise<Dirent[]>;
  export function stat(path: string): Promise<Stats>;
  export function lstat(path: string): Promise<Stats>;
  export function rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void>;
  export function rename(from: string, to: string): Promise<void>;
  export function access(path: string, mode?: number): Promise<void>;
  export function realpath(path: string): Promise<string>;
  export function copyFile(from: string, to: string): Promise<void>;
  export function mkdtemp(prefix: string): Promise<string>;
}

declare module "node:child_process" {
  export interface ChildProcessStdin extends NodeWritable {
    readonly destroyed: boolean;
  }
  export interface ChildProcess {
    readonly pid: number | undefined;
    readonly stdin: ChildProcessStdin | null;
    readonly exitCode: number | null;
    kill(signal?: string | number): boolean;
    unref(): void;
    on(event: "exit", listener: (code: number | null, signal: string | null) => void): ChildProcess;
    on(event: "error", listener: (error: Error) => void): ChildProcess;
    on(event: string, listener: (...args: any[]) => void): ChildProcess;
  }
  export interface SpawnOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio?: Array<"pipe" | "ignore" | "inherit" | number>;
    detached?: boolean;
    windowsHide?: boolean;
    shell?: boolean | string;
  }
  export function spawn(command: string, args?: string[], options?: SpawnOptions): ChildProcess;
}

declare module "node:os" {
  export function tmpdir(): string;
  export function homedir(): string;
  export function platform(): string;
  export function release(): string;
  export function hostname(): string;
  export function cpus(): Array<{ model: string }>;
  export const EOL: string;
}

declare module "node:crypto" {
  export interface Hash {
    update(data: string | ArrayBufferView, encoding?: string): Hash;
    digest(encoding: "hex" | "base64"): string;
  }
  export function createHash(algorithm: string): Hash;
  export function randomBytes(size: number): Buffer;
  export function randomUUID(): string;
}

declare module "node:util" {
  export function inspect(value: unknown, options?: { depth?: number | null; colors?: boolean; breakLength?: number }): string;
  export function format(fmt: string, ...args: unknown[]): string;
}

declare module "node:readline" {
  export interface Interface {
    on(event: "line", listener: (line: string) => void): Interface;
    on(event: "close", listener: () => void): Interface;
    on(event: string, listener: (...args: any[]) => void): Interface;
    close(): void;
    setPrompt(prompt: string): void;
    prompt(preserveCursor?: boolean): void;
    question(query: string, callback: (answer: string) => void): void;
    pause(): Interface;
    resume(): Interface;
  }
  export function createInterface(options: { input: NodeReadable; output?: NodeWritable; terminal?: boolean; prompt?: string }): Interface;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
  export function pathToFileURL(path: string): URL;
}
