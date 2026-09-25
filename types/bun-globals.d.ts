// Local declarations for the Bun runtime surface Hera uses. Kept deliberately small:
// HERAV1-PR-0019 - type-only packages are outside the dependency list, so this shim
// replaces @types/bun. Extend only when new runtime calls appear in src/ or tests/.

declare type BunStdio = "pipe" | "inherit" | "ignore" | null;

declare interface BunSubprocess {
  readonly pid: number;
  readonly exited: Promise<number>;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly killed: boolean;
  readonly stdout: ReadableStream<Uint8Array> | number | undefined;
  readonly stderr: ReadableStream<Uint8Array> | number | undefined;
  readonly stdin: BunFileSink | number | undefined;
  kill(signal?: number | string): void;
  unref(): void;
  ref(): void;
  send(message: unknown): void;
  disconnect(): void;
}

declare interface BunSpawnOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  stdin?: BunStdio | ReadableStream | Blob | Uint8Array | string;
  stdout?: BunStdio;
  stderr?: BunStdio;
  stdio?: [BunStdio, BunStdio, BunStdio];
  serialization?: "json" | "advanced";
  windowsHide?: boolean;
  windowsVerbatimArguments?: boolean;
  ipc?(message: unknown, subprocess: BunSubprocess): void;
  onExit?(subprocess: BunSubprocess, exitCode: number | null, signalCode: string | null, error?: Error): void | Promise<void>;
  timeout?: number;
  killSignal?: string | number;
  signal?: AbortSignal;
}

declare interface BunFileSink {
  write(chunk: string | ArrayBufferView | ArrayBuffer): number;
  flush(): number | Promise<number>;
  end(error?: Error): number | Promise<number>;
}

declare interface BunFile extends Blob {
  readonly name?: string;
  readonly lastModified: number;
  exists(): Promise<boolean>;
  text(): Promise<string>;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  writer(options?: { highWaterMark?: number }): BunFileSink;
}

declare namespace Bun {
  const version: string;
  const main: string;
  const isStandaloneExecutable: boolean;
  const argv: string[];
  const env: Record<string, string | undefined>;
  const embeddedFiles: ReadonlyArray<Blob & { name: string }>;
  function spawn(cmd: string[], options?: BunSpawnOptions): BunSubprocess;
  function spawnSync(cmd: string[], options?: BunSpawnOptions): { exitCode: number; stdout: Uint8Array; stderr: Uint8Array; success: boolean };
  function file(path: string | URL, options?: { type?: string }): BunFile;
  function write(destination: string | URL | BunFile, data: string | ArrayBuffer | ArrayBufferView | Blob | Response): Promise<number>;
  function sleep(ms: number): Promise<void>;
  function sleepSync(ms: number): void;
  function which(command: string, options?: { PATH?: string; cwd?: string }): string | null;
  interface BunServer {
    readonly port: number;
    readonly hostname: string;
    stop(closeActiveConnections?: boolean): void;
  }
  function serve(options: { port?: number; hostname?: string; fetch(request: Request): Response | Promise<Response> }): BunServer;
  interface Socket<Data = undefined> {
    data: Data;
    readonly localPort: number;
    readonly remoteAddress: string;
    write(data: string | ArrayBufferView | ArrayBuffer): number;
    flush(): void;
    end(): void;
    terminate(): void;
    shutdown(): void;
  }
  interface SocketHandler<Data = undefined> {
    open?(socket: Socket<Data>): void;
    data?(socket: Socket<Data>, data: Uint8Array): void;
    close?(socket: Socket<Data>, error?: Error): void;
    error?(socket: Socket<Data>, error: Error): void;
    drain?(socket: Socket<Data>): void;
    connectError?(socket: Socket<Data>, error: Error): void;
    end?(socket: Socket<Data>): void;
  }
  interface TCPSocketListener<Data = undefined> {
    readonly port: number;
    readonly hostname: string;
    stop(closeActiveConnections?: boolean): void;
    unref(): void;
  }
  function listen<Data = undefined>(options: { hostname: string; port: number; socket: SocketHandler<Data>; data?: Data }): TCPSocketListener<Data>;
  function connect<Data = undefined>(options: { hostname: string; port: number; socket: SocketHandler<Data>; data?: Data; tls?: boolean | { serverName?: string } }): Promise<Socket<Data>>;
  function nanoseconds(): number;
  function inspect(value: unknown, options?: { depth?: number; colors?: boolean }): string;
  function stringWidth(text: string): string;
  const stdin: BunFile & { stream(): ReadableStream<Uint8Array> };
  const stdout: BunFile;
  const stderr: BunFile;
  class CryptoHasher {
    constructor(algorithm: "sha256" | "sha1" | "md5" | "sha512", hmacKey?: Buffer | Uint8Array);
    update(data: string | ArrayBufferView | ArrayBuffer): CryptoHasher;
    digest(encoding: "hex" | "base64"): string;
  }
  class Glob {
    constructor(pattern: string);
    match(path: string): boolean;
    toString(): string;
  }
}

declare interface ImportMeta {
  readonly dir: string;
  readonly path: string;
  readonly file: string;
  readonly url: string;
  readonly main: boolean;
}

declare module "*.exe" {
  const path: string;
  export default path;
}
