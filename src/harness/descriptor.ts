// EffectDescriptor - the sole input to the gate (HERAV1HRNS-SP01 FR-02).
// Immutable after request(); a changed parameter is a new descriptor.
// Lazy hash() and context_digest() computed only when a plug calls them.

/** The six effect kinds (D-14). agent.delegate is reserved and never emitted. */
export type EffectKind = "tool.invoke" | "model.invoke" | "memory.write" | "net.egress" | "process.spawn" | "agent.delegate";

export interface EffectDescriptorInit {
  effect_id: string;
  kind: EffectKind;
  target: string;
  parameters: Record<string, unknown>;
  origin_refs?: string[];
  run_ctx?: Uint8Array;
  prompt_id?: string;
}

export class EffectDescriptor {
  readonly effect_id: string;
  readonly kind: EffectKind;
  readonly target: string;
  readonly parameters: Record<string, unknown>;
  readonly origin_refs: string[];
  readonly run_ctx: Uint8Array;
  readonly prompt_id: string;

  private _hash: string | undefined;
  private _context_digest: string | undefined;
  private _frozen = false;

  constructor(init: EffectDescriptorInit) {
    this.effect_id = init.effect_id;
    this.kind = init.kind;
    this.target = init.target;
    this.parameters = init.parameters;
    this.origin_refs = init.origin_refs ?? [];
    this.run_ctx = init.run_ctx ?? new Uint8Array(0);
    this.prompt_id = init.prompt_id ?? "";
  }

  /** Lazy hash of the descriptor content. Cached after first call. */
  hash(): string {
    if (this._hash === undefined) {
      this._hash = computeDescriptorHash(this);
    }
    return this._hash;
  }

  /** Lazy context digest. Cached after first call. */
  context_digest(): string {
    if (this._context_digest === undefined) {
      this._context_digest = computeContextDigest(this);
    }
    return this._context_digest;
  }

  /** Freeze the descriptor after request(). Mutations to parameters throw. */
  freeze(): void {
    if (this._frozen) return;
    this._frozen = true;
    Object.freeze(this.parameters);
    this._hash = computeDescriptorHash(this);
  }

  get frozen(): boolean {
    return this._frozen;
  }

  /** Verify the descriptor hasn't been mutated since freeze(). Returns true if intact. */
  verifyIntegrity(): boolean {
    if (!this._frozen) return true;
    const currentHash = computeDescriptorHash(this);
    return currentHash === this._hash;
  }
}

function computeDescriptorHash(d: EffectDescriptor): string {
  const content = JSON.stringify({
    effect_id: d.effect_id,
    kind: d.kind,
    target: d.target,
    parameters: d.parameters,
    origin_refs: d.origin_refs,
    run_ctx: Array.from(d.run_ctx),
    prompt_id: d.prompt_id,
  });
  return simpleHash(content);
}

function computeContextDigest(d: EffectDescriptor): string {
  const content = JSON.stringify({
    kind: d.kind,
    target: d.target,
    parameters: d.parameters,
    origin_refs: d.origin_refs,
  });
  return simpleHash(content);
}

/** Fast non-cryptographic hash (FNV-1a 32-bit). Sufficient for integrity checks. */
function simpleHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}
