// Minimal bun:test surface (HERAV1-PR-0019: no @types/bun).

declare module "bun:test" {
  export type TestFn = () => void | Promise<void>;
  export interface TestOptions {
    timeout?: number;
    retry?: number;
  }
  export interface TestFunction {
    (name: string, fn: TestFn, options?: TestOptions | number): void;
    skip(name: string, fn?: TestFn, options?: TestOptions | number): void;
    only(name: string, fn: TestFn, options?: TestOptions | number): void;
    todo(name: string, fn?: TestFn): void;
    skipIf(condition: boolean): (name: string, fn: TestFn, options?: TestOptions | number) => void;
    if(condition: boolean): (name: string, fn: TestFn, options?: TestOptions | number) => void;
    each<T>(cases: readonly T[]): (name: string, fn: (value: T) => void | Promise<void>, options?: TestOptions | number) => void;
  }
  export interface DescribeFunction {
    (name: string, fn: () => void): void;
    skip(name: string, fn: () => void): void;
    only(name: string, fn: () => void): void;
    skipIf(condition: boolean): (name: string, fn: () => void) => void;
    if(condition: boolean): (name: string, fn: () => void) => void;
  }
  export const test: TestFunction;
  export const it: TestFunction;
  export const describe: DescribeFunction;
  export function beforeAll(fn: TestFn, options?: TestOptions | number): void;
  export function afterAll(fn: TestFn, options?: TestOptions | number): void;
  export function beforeEach(fn: TestFn, options?: TestOptions | number): void;
  export function afterEach(fn: TestFn, options?: TestOptions | number): void;
  export function setDefaultTimeout(ms: number): void;

  export interface Matchers<T = unknown> {
    toBe(expected: T): void;
    toEqual(expected: unknown): void;
    toStrictEqual(expected: unknown): void;
    toBeTruthy(): void;
    toBeFalsy(): void;
    toBeNull(): void;
    toBeUndefined(): void;
    toBeDefined(): void;
    toBeNaN(): void;
    toBeGreaterThan(n: number | bigint): void;
    toBeGreaterThanOrEqual(n: number | bigint): void;
    toBeLessThan(n: number | bigint): void;
    toBeLessThanOrEqual(n: number | bigint): void;
    toBeCloseTo(n: number, digits?: number): void;
    toContain(item: unknown): void;
    toContainEqual(item: unknown): void;
    toHaveLength(n: number): void;
    toHaveProperty(path: string | string[], value?: unknown): void;
    toMatch(pattern: RegExp | string): void;
    toMatchObject(o: object): void;
    toBeInstanceOf(c: Function): void;
    toThrow(expected?: string | RegExp | Error | Function): void;
    toBeTypeOf(t: "string" | "number" | "boolean" | "object" | "function" | "undefined" | "symbol" | "bigint"): void;
    toStartWith(s: string): void;
    toEndWith(s: string): void;
    toInclude(s: string): void;
    toBeEmpty(): void;
    toBeArray(): void;
    toBeString(): void;
    toBeNumber(): void;
    toBeBoolean(): void;
    toBeObject(): void;
    toSatisfy(pred: (v: T) => boolean): void;
    toHaveBeenCalled(): void;
    toHaveBeenCalledTimes(n: number): void;
    toHaveBeenCalledWith(...args: unknown[]): void;
    resolves: Matchers<Awaited<T>>;
    rejects: Matchers<unknown>;
    not: Matchers<T>;
  }
  export interface Expect {
    <T>(value: T, message?: string): Matchers<T>;
    any(c: Function): unknown;
    anything(): unknown;
    stringContaining(s: string): unknown;
    stringMatching(p: string | RegExp): unknown;
    objectContaining(o: object): unknown;
    arrayContaining(a: unknown[]): unknown;
    assertions(n: number): void;
    unreachable(message?: string): never;
  }
  export const expect: Expect;

  export interface Mock<T extends (...args: any[]) => any> {
    (...args: Parameters<T>): ReturnType<T>;
    mock: { calls: Parameters<T>[]; results: Array<{ type: string; value: unknown }> };
    mockReturnValue(v: ReturnType<T>): Mock<T>;
    mockResolvedValue(v: Awaited<ReturnType<T>>): Mock<T>;
    mockImplementation(fn: T): Mock<T>;
    mockClear(): void;
    mockReset(): void;
  }
  export function mock<T extends (...args: any[]) => any>(fn?: T): Mock<T>;
  export function spyOn<T extends object, K extends keyof T>(obj: T, key: K): Mock<any>;
}
