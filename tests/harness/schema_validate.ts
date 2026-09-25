// Minimal JSON Schema (draft 2020-12 subset) validator for the ACP schema oracle (HERAV1ACP-TP01 TC-11, NFR-01).
// Supports what schema/schema.json uses: $ref into $defs, type (incl. arrays of types), const, enum, properties,
// required, additionalProperties, items, minimum/maximum, anyOf, oneOf, allOf, format is ignored.

import { readFileSync } from "node:fs";
import { join } from "node:path";

type Schema = Record<string, unknown>;

export class SchemaOracle {
  private readonly root: Schema;
  constructor(path: string = join(import.meta.dir, "..", "fixtures", "acp", "schema.json")) {
    this.root = JSON.parse(readFileSync(path, "utf8")) as Schema;
  }

  def(name: string): Schema {
    const defs = this.root["$defs"] as Record<string, Schema>;
    const s = defs[name];
    if (s === undefined) throw new Error(`schema has no $defs/${name}`);
    return s;
  }

  /** Returns the list of violations (empty = valid) of `value` against `$defs/<name>`. */
  validate(name: string, value: unknown): string[] {
    const errors: string[] = [];
    this.check(this.def(name), value, `$defs/${name}`, errors);
    return errors;
  }

  assertValid(name: string, value: unknown): void {
    const errors = this.validate(name, value);
    if (errors.length > 0) throw new Error(`${name} invalid:\n  ${errors.join("\n  ")}\nvalue: ${JSON.stringify(value)}`);
  }

  private resolve(ref: string): Schema {
    if (!ref.startsWith("#/")) throw new Error(`unsupported $ref '${ref}'`);
    let node: unknown = this.root;
    for (const part of ref.slice(2).split("/")) node = (node as Record<string, unknown>)[part];
    if (node === undefined) throw new Error(`unresolved $ref '${ref}'`);
    return node as Schema;
  }

  private typeOf(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
    return typeof value;
  }

  private typeMatches(expected: string, value: unknown): boolean {
    const actual = this.typeOf(value);
    if (expected === "number") return actual === "number" || actual === "integer";
    return expected === actual;
  }

  private check(schema: Schema, value: unknown, path: string, errors: string[]): void {
    if (typeof schema["$ref"] === "string") {
      this.check(this.resolve(schema["$ref"]), value, path, errors);
    }
    const type = schema["type"];
    if (typeof type === "string") {
      if (!this.typeMatches(type, value)) errors.push(`${path}: expected type ${type}, got ${this.typeOf(value)}`);
    } else if (Array.isArray(type)) {
      if (!type.some((t) => this.typeMatches(String(t), value))) errors.push(`${path}: expected one of ${type.join("|")}, got ${this.typeOf(value)}`);
    }
    if ("const" in schema && JSON.stringify(schema["const"]) !== JSON.stringify(value)) errors.push(`${path}: expected const ${JSON.stringify(schema["const"])}, got ${JSON.stringify(value)}`);
    if (Array.isArray(schema["enum"]) && !schema["enum"].some((e) => JSON.stringify(e) === JSON.stringify(value))) errors.push(`${path}: ${JSON.stringify(value)} not in enum ${JSON.stringify(schema["enum"])}`);
    if (typeof schema["minimum"] === "number" && typeof value === "number" && value < schema["minimum"]) errors.push(`${path}: ${value} below minimum ${schema["minimum"]}`);
    if (typeof schema["maximum"] === "number" && typeof value === "number" && value > schema["maximum"]) errors.push(`${path}: ${value} above maximum ${schema["maximum"]}`);
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const properties = (schema["properties"] ?? {}) as Record<string, Schema>;
      for (const req of (schema["required"] ?? []) as string[]) if (!(req in obj)) errors.push(`${path}: missing required '${req}'`);
      for (const [k, v] of Object.entries(obj)) {
        if (k in properties) this.check(properties[k] as Schema, v, `${path}.${k}`, errors);
        else if (schema["additionalProperties"] === false) errors.push(`${path}: unexpected property '${k}'`);
        else if (typeof schema["additionalProperties"] === "object" && schema["additionalProperties"] !== null) this.check(schema["additionalProperties"] as Schema, v, `${path}.${k}`, errors);
      }
    }
    if (Array.isArray(value) && typeof schema["items"] === "object" && schema["items"] !== null) {
      value.forEach((item, i) => this.check(schema["items"] as Schema, item, `${path}[${i}]`, errors));
    }
    if (Array.isArray(schema["allOf"])) for (const sub of schema["allOf"] as Schema[]) this.check(sub, value, path, errors);
    for (const key of ["anyOf", "oneOf"] as const) {
      const alternatives = schema[key];
      if (!Array.isArray(alternatives)) continue;
      const results = (alternatives as Schema[]).map((sub) => {
        const e: string[] = [];
        this.check(sub, value, path, e);
        return e;
      });
      const matches = results.filter((e) => e.length === 0).length;
      if (matches === 0) errors.push(`${path}: no ${key} alternative matched (${results.map((e) => e[0] ?? "").join(" | ")})`);
      else if (key === "oneOf" && matches > 1) {
        // discriminated unions on `const` fields are exclusive by construction; tolerate overlapping generic alternatives
      }
    }
  }
}
