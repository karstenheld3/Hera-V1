// Minimal js-yaml surface (HERAV1-PR-0019: no @types/js-yaml).

declare module "js-yaml" {
  export interface LoadOptions {
    filename?: string;
    json?: boolean;
  }
  export interface DumpOptions {
    indent?: number;
    lineWidth?: number;
    noRefs?: boolean;
    sortKeys?: boolean;
  }
  export function load(text: string, options?: LoadOptions): unknown;
  export function dump(value: unknown, options?: DumpOptions): string;
  export class YAMLException extends Error {}
}
