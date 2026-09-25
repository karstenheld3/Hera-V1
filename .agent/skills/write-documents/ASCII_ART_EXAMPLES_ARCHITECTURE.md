# ASCII Art Example: Architecture

Demonstrates system architecture, component diagrams, and layer diagrams using Unicode box-drawing characters.

## Context

Architecture diagrams show parts, connections, and layers. Component diagrams answer "what are the parts and how do they connect?" Layer diagrams answer "which tier sits on which?" Use Tier 2 light box-drawing as default. Max 7 containers; above that, split into context and detail diagrams.

## Document

### Component Diagram

```
[COMPONENT DIAGRAM - WEB SHOP, CONTAINER LEVEL]

┌─[ Trust boundary: company network ]─────────────────────────────────┐
│                                                                     │
│  ┌──────────────┐      ┌──────────────────┐      ┌───────────────┐  │
│  │ Web Frontend │─────>│ Shop API         │─────>│ Shop DB       │  │
│  │ [SPA]        │      │ [SERVICE]        │      │ [POSTGRES]    │  │
│  └──────────────┘      └──────────────────┘      └───────────────┘  │
│                               │                                     │
│                               │ publish                             │
│                               v                                     │
│                        ┌──────────────────┐      ┌───────────────┐  │
│                        │ Order Queue      │─────>│ Fulfilment    │  │
│                        │ [BROKER]         │      │ [WORKER]      │  │
│                        └──────────────────┘      └───────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
                               │
                               │ HTTPS
                               v
                        ┌──────────────────┐
                        │ Payment Provider │
                        │ [EXTERNAL]       │
                        └──────────────────┘

Legend: ───> sync call   publish = async message   [KIND] = container type
Notes: outer dashed box = trust boundary; Payment Provider is third-party
```

### Layer Diagram

```
[LAYER DIAGRAM - REQUEST HANDLING STACK]

┌───────────────────────────────────────────────────────────────┐
│  Presentation                                                 │
│  ├─> HTTP routes            # parse request, pick handler     │
│  └─> Response formatter     # JSON / HTML envelope            │
├───────────────────────────────────────────────────────────────┤
│  Application                                                  │
│  ├─> Use cases              # one class per user action       │
│  └─> Validation             # schema + business rules         │
├───────────────────────────────────────────────────────────────┤
│  Domain                                                       │
│  ├─> Entities               # Order, Customer, Product        │
│  └─> Domain events          # OrderPlaced, PaymentFailed      │
├───────────────────────────────────────────────────────────────┤
│  Infrastructure                                               │
│  ├─> Repositories           # SQL adapters                    │
│  └─> Message bus client     # publish / subscribe             │
└───────────────────────────────────────────────────────────────┘

Legend: calls flow downward only; a tier never calls the tier above
```

### Process Topology

```
[PROCESS TOPOLOGY - THREE COOPERATING PROCESSES ON ONE HOST]

┌─[ Host: workstation ]──────────────────────────────────────────────┐
│                                                                    │
│  ┌───────────────┐   stdio/IPC   ┌───────────────┐                 │
│  │ Frontend      │<─────────────>│ Coordinator   │                 │
│  │ [PROCESS 1]   │               │ [PROCESS 2]   │                 │
│  └───────────────┘               └───────┬───────┘                 │
│                                          │                         │
│                                          │ spawn + IPC             │
│                                          v                         │
│                                  ┌───────────────┐                 │
│                                  │ Worker        │                 │
│                                  │ [PROCESS 3]   │                 │
│                                  └───────────────┘                 │
└────────────────────────────────────────────────────────────────────┘

Legend: <───> bidirectional IPC   ───> one-way   [PROCESS n] = OS process
Notes: only Worker writes events.jsonl (single-writer rule)
```

## Key Decisions

- Component diagram uses dashed outer box for trust boundary, external system outside
- Kind tags (`[SPA]`, `[SERVICE]`, `[DB]`) on line 2 of every box for LLM and image consumers
- Layer diagram: highest abstraction on top, calls flow downward only, max 5 tiers
- Process topology: outer box = host, inner boxes = processes, edges labeled with transport
- Sync vs async distinguished by line style, stated in legend
