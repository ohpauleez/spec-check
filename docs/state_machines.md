# State Machines in TypeScript

State machines are a strong foundational construction pattern in software.
They are useful in production systems because they make legal behavior explicit and easier to
enforce, debug, and test.

Instead of scattering lifecycle rules across conditionals, a state machine
names the valid states, the allowed transitions, and the actions that move the
system forward.

## Why use state machines?

- They make workflows explicit. A reader can see the lifecycle directly instead of inferring it from flags and `if` statements.
- They reduce invalid states. When the model says an object is `Draft`, `Paid`, or `Shipped`, the code can avoid impossible combinations.
- They improve maintainability. Adding a new state or transition becomes a focused change to the model instead of a hunt across the codebase.
- They support better testing. It is easier to enumerate expected transitions, terminal states, and known failure-modes.
- They align well with formal reasoning. Preconditions, postconditions, and invariants often map naturally onto state transitions.
- They localize critical properties. A state machine concentrates the rules in one place, making them checkable by contracts, tests, and verification tools.

## Quick comparison

| Approach | Compile-time transition safety | Best for | Main tradeoff |
|---|---|---|---|
| Discriminated union | Partial (via narrowing) | Most business workflows | Runtime-checked transitions unless caller narrows first |
| Distinct state types with factory functions | Yes | Clear domain models, spec-driven development | More types to define |
| Branded typestate | Yes | APIs, protocols, capability-style workflows | Requires type assertions at brand boundaries |

For specialized hot-path scenarios, see the [appendix](#appendix-specialized-patterns).

## Common patterns

### 1. Discriminated-union state machines

This is the most idiomatic TypeScript approach. States are members of a discriminated union, and transition logic lives in functions that switch on the discriminant.

**Simple string-union variant:**

```typescript
type OrderState = "draft" | "paid" | "shipped";

interface Order {
  readonly id: string;
  readonly cents: number;
  state: OrderState;
  readonly trackingId?: string; // present only in "shipped" — not enforced by the type
}

function createOrder(id: string, cents: number): Order {
  return { id, cents, state: "draft" };
}

function advance(order: Order): Order {
  switch (order.state) {
    case "draft":
      return { ...order, state: "paid" };
    case "paid":
      return { ...order, state: "shipped" };
    case "shipped":
      throw new Error("SHIPPED is terminal");
    default: {
      const _exhaustive: never = order.state;
      throw new Error(`Unknown state: ${_exhaustive}`);
    }
  }
}

// Transitions can also be encoded as dedicated "Event" types if the state machine requires a richer set of transition paths

type OrderEvent =
  | { readonly type: "PAY" }
  | { readonly type: "SHIP"; readonly trackingId: string };

function transition(order: Order, event: OrderEvent): Order {
  switch (order.state) {
    case "draft":
      if (event.type === "PAY") return { ...order, state: "paid" };
      break;
    case "paid":
      if (event.type === "SHIP") return { ...order, state: "shipped", trackingId: event.trackingId };
      break;
    case "shipped":
      throw new Error("SHIPPED is terminal");
    default: {
      const _exhaustive: never = order.state;
      throw new Error(`Unknown state: ${_exhaustive}`);
    }
  }
  throw new Error(`Invalid event "${event.type}" in state "${order.state}"`);
```

**Rich tagged-union variant** — each state carries state-specific data and transitions are narrowed by input type:

```typescript
type OrderState =
  | { readonly kind: "draft"; readonly id: string; readonly cents: number }
  | { readonly kind: "paid"; readonly id: string; readonly cents: number; readonly paidAt: Date }
  | { readonly kind: "shipped"; readonly id: string; readonly cents: number; readonly trackingId: string };

function pay(order: Extract<OrderState, { kind: "draft" }>): Extract<OrderState, { kind: "paid" }> {
  return { kind: "paid", id: order.id, cents: order.cents, paidAt: new Date() };
}

function ship(
  order: Extract<OrderState, { kind: "paid" }>,
  trackingId: string
): Extract<OrderState, { kind: "shipped" }> {
  return { kind: "shipped", id: order.id, cents: order.cents, trackingId };
}
```

This gives some compile-time safety: calling `ship` on a `"draft"` order is a type error. However, narrowing typically requires the caller to have already discriminated via a `switch` or `if`.

**When to use:**

- The lifecycle is simple or moderately complex.
- Serialization, logging, and inspection matter.
- Runtime checks are acceptable for transition guards.
- You want the most familiar TypeScript idiom.

### 2. Distinct state types with factory functions

Each legal transition is a standalone function with explicit input and output types. Illegal transitions simply do not exist in the API surface.

**Generic interface variant** — a single generic interface parameterized by the state literal, with transition functions that constrain input and output:

```typescript
interface Order<S extends string> {
  readonly kind: S;
  readonly id: string;
  readonly cents: number;
}

function createOrder(id: string, cents: number): Order<"draft"> {
  return { kind: "draft", id, cents };
}

function pay(order: Order<"draft">): Order<"paid"> {
  return { ...order, kind: "paid" };
}

function ship(order: Order<"paid">): Order<"shipped"> {
  return { ...order, kind: "shipped" };
}

// Does not compile:
// ship(createOrder("o-123", 2500));
```

The compiler enforces transitions without type assertions — the literal value of `kind` in the returned object satisfies the generic parameter directly. A union type is still available when needed: `type AnyOrder = Order<"draft"> | Order<"paid"> | Order<"shipped">`.

**Separate interface variant** — when different states carry different data or you want maximum explicitness, define each state as its own interface:

```typescript
interface DraftOrder {
  readonly kind: "draft";
  readonly id: string;
  readonly cents: number;
}

interface PaidOrder {
  readonly kind: "paid";
  readonly id: string;
  readonly cents: number;
}

interface ShippedOrder {
  readonly kind: "shipped";
  readonly id: string;
  readonly cents: number;
}

type Order = DraftOrder | PaidOrder | ShippedOrder;

function createOrder(id: string, cents: number): DraftOrder {
  return { kind: "draft", id, cents };
}

function pay(order: DraftOrder): PaidOrder {
  return { kind: "paid", id: order.id, cents: order.cents };
}

function ship(order: PaidOrder): ShippedOrder {
  return { kind: "shipped", id: order.id, cents: order.cents };
}
```

This variant is preferable when each state carries state-specific fields (e.g., `PaidOrder` has `paidAt`, `ShippedOrder` has `trackingId`) or when you want the most explicit domain model for code review and formal verification.

**When to use:**

- You want compile-time enforcement that only legal transitions can be called.
- No type assertions are needed — the compiler verifies transitions from the runtime discriminant.
- Each state may carry different data or support different operations (use the separate interface variant).
- You want the clearest domain model for code review, specifications, and formal verification.
- The union type is still available for exhaustive handling where needed.

This pattern is the strongest combination of clarity, compiler checking, and verifiability. It maps naturally to LemmaScript contracts and Dafny's `datatype` system.

### 3. Branded typestate

This is an approximation of state machines using phantom types. The state appears in the TypeScript type via brands — unique symbol properties that exist only at the type level. A value like `Order & Brand<"Draft">` can only be passed to operations that accept the `Draft` state, and each transition returns a value branded with the next state.

```typescript
declare const __brand: unique symbol;
type Brand<T extends string> = { readonly [__brand]: T };

type Draft = Brand<"Draft">;
type Paid = Brand<"Paid">;
type Shipped = Brand<"Shipped">;

interface OrderData {
  readonly id: string;
  readonly cents: number;
}

type Order<State extends Brand<string>> = OrderData & State;

function createOrder(id: string, cents: number): Order<Draft> {
  return { id, cents } as Order<Draft>;
}

function pay(order: Order<Draft>): Order<Paid> {
  return order as unknown as Order<Paid>;
}

function ship(order: Order<Paid>): Order<Shipped> {
  return order as unknown as Order<Shipped>;
}

// Usage
const draft = createOrder("o-123", 2500);
const paid = pay(draft);
const shipped = ship(paid);

// Does not compile:
// ship(draft);  // Argument of type 'Order<Draft>' is not assignable to parameter of type 'Order<Paid>'
```

The brand is erased at compile time — it has zero runtime representation. The runtime value is unchanged across transitions; only the type narrows.

**Composing brands** for tighter invariants:

```typescript
type Validated = Brand<"Validated">;
type Authorized = Brand<"Authorized">;

type Request<S extends Brand<string>> = { readonly body: string } & S;

function validate(req: Request<Draft>): Request<Validated> {
  return req as unknown as Request<Validated>;
}

function authorize(req: Request<Validated>): Request<Validated & Authorized> {
  return req as unknown as Request<Validated & Authorized>;
}

function execute(req: Request<Validated & Authorized>): void {
  // only reachable if both validated AND authorized
}
```

**When to use:**

- Illegal transitions must be caught by the compiler, not at runtime.
- The runtime value should not change shape across transitions (zero allocation).
- The workflow is part of an API contract or protocol.
- You accept type assertions (`as unknown as`) at brand boundaries.

**Tradeoffs:**

- Requires careful use of type assertions where brands are minted.
- Less familiar to developers new to branded types.
- Can become awkward for highly branching or cyclic graphs.

## Coupled machines: product-state encoding

Some systems are not a single state machine but several machines whose states
must stay consistent. Model the combined system directly as a product state machine
instead of keeping separate mutable machines and synchronizing them with runtime checks.

Example: a traffic light intersection where the legal combined states are:

- `GR`: north-south green, east-west red
- `YR`: north-south yellow, east-west red
- `RR`: both red (transition buffer)
- `RG`: north-south red, east-west green
- `RY`: north-south red, east-west yellow
- `FF`: both flashing red (fault)

The key idea is that the type represents the whole intersection, not each light independently. Illegal combinations are unrepresentable.

```typescript
interface GR { readonly kind: "GR" }
interface YR { readonly kind: "YR" }
interface RR { readonly kind: "RR" }
interface RG { readonly kind: "RG" }
interface RY { readonly kind: "RY" }
interface FF { readonly kind: "FF" }

type IntersectionState = GR | YR | RR | RG | RY | FF;

// Only legal transitions exist
function grNext(_state: GR): YR { return { kind: "YR" }; }
function yrNext(_state: YR): RR { return { kind: "RR" }; }
function rrNorthSouthFirst(_state: RR): GR { return { kind: "GR" }; }
function rrEastWestFirst(_state: RR): RG { return { kind: "RG" }; }
function rgNext(_state: RG): RY { return { kind: "RY" }; }
function ryNext(_state: RY): RR { return { kind: "RR" }; }
function fault(_state: IntersectionState): FF { return { kind: "FF" }; }
function restore(_state: FF): RR { return { kind: "RR" }; }
```

**When to use product-state encoding:**

- Invariants span more than one entity.
- Two actors must transition in lockstep.
- A coordinator must enforce safety across several subsystems.
- Illegal combinations must be impossible to construct.

**Controlled branching:** When a state has multiple legal successors (like `RR` above), expose named transition functions for each branch. The compiler rejects impossible transitions while the caller selects among the legal ones.

## Capabilities as state machines

Capabilities are a specialized form of typestate. Instead of saying an object is in state `Draft` or `Paid`, we say a value carries a capability such as `Authenticated` or `MfaVerified`. Each transition grants, refines, or revokes what the caller is allowed to do next.

```typescript
declare const __brand: unique symbol;
type Brand<T extends string> = { readonly [__brand]: T };

type Anonymous = Brand<"Anonymous">;
type Authenticated = Brand<"Authenticated">;
type MfaVerified = Brand<"MfaVerified"> & Authenticated;

interface Session { readonly userId: string }
type BrandedSession<Cap extends Brand<string>> = Session & Cap;

function begin(userId: string): BrandedSession<Anonymous> {
  return { userId } as BrandedSession<Anonymous>;
}

function login(session: BrandedSession<Anonymous>, _password: string): BrandedSession<Authenticated> {
  return session as unknown as BrandedSession<Authenticated>;
}

function verifyMfa(session: BrandedSession<Authenticated>, _code: string): BrandedSession<MfaVerified> {
  return session as unknown as BrandedSession<MfaVerified>;
}

// Capability-gated operations
function readProfile(session: BrandedSession<Authenticated>): string {
  return `profile for ${session.userId}`;
}

function transferMoney(session: BrandedSession<MfaVerified>, cents: number): void {
  if (cents <= 0) throw new Error("cents must be positive");
  // process transfer
}

// Does not compile:
// const s = login(begin("alice"), "pw");
// transferMoney(s, 5000);  // requires MfaVerified, not just Authenticated
```

The function signature declares what proof of authority is required. The capability brand is the transition guard.

**Trust and witnesses:** Plain branding is enough inside a trusted module. If the capability must be protected against forgery across trust boundaries, pair the brand with a runtime witness (a private `WeakSet` or `Symbol`):

```typescript
const TRUSTED = new WeakSet<object>();

function mintAuthenticated(session: BrandedSession<Anonymous>): BrandedSession<Authenticated> {
  const result = session as unknown as BrandedSession<Authenticated>;
  TRUSTED.add(result);
  return result;
}

function requireTrusted(session: BrandedSession<Authenticated>): void {
  if (!TRUSTED.has(session)) throw new Error("Untrusted capability");
}
```

## Choosing an approach

For most TypeScript systems, the practical progression is:

1. **Start with a discriminated union** if the lifecycle is simple and runtime checks are acceptable.
2. **Move to distinct state types** when state-specific behavior grows, you want the clearest domain model, or you want the best surface for formal verification.
3. **Use branded typestate** when illegal transitions must be caught by the compiler but zero-sized and allocation-free or the workflow requires a 'capability'-like state machine or contract.
4. **Use product-state encoding** when invariants span multiple entities and illegal combinations must be structurally impossible.

## Using LemmaScript with state machines

[LemmaScript](https://lemmascript.com/) can formally verify state machine implementations. Each transition can be described by preconditions and postconditions, and the state model becomes a natural place to express guarantees.

### Recommended pattern: distinct state types

Distinct state types are the best match for LemmaScript. Each legal transition is a standalone function with explicit input/output types, giving Dafny the clearest reasoning surface:

```typescript
interface DraftOrder {
  readonly kind: "draft";
  readonly id: string;
  readonly cents: number;
}

interface PaidOrder {
  readonly kind: "paid";
  readonly id: string;
  readonly cents: number;
}

interface ShippedOrder {
  readonly kind: "shipped";
  readonly id: string;
  readonly cents: number;
}

function pay(order: DraftOrder): PaidOrder {
  //@ verify
  //@ requires order.cents >= 0
  //@ ensures \result.id === order.id
  //@ ensures \result.cents === order.cents
  return { kind: "paid", id: order.id, cents: order.cents };
}

function ship(order: PaidOrder): ShippedOrder {
  //@ verify
  //@ ensures \result.id === order.id
  return { kind: "shipped", id: order.id, cents: order.cents };
}
```

### Guidance

- Use `//@ requires` for preconditions on the current state.
- Use `//@ ensures` for the destination state and preserved data properties.
- Use `//@ invariant` in loops that process state sequences.
- Prefer distinct state types or discriminated unions for LemmaScript — they map most naturally to Dafny's `datatype` system.
- Branded types provide strong TypeScript-level protocol safety but may require `//@ declare-type` annotations to model in LemmaScript.
- Keep transition functions small — small bodies are easier for Dafny to verify.
- If a transition can fail, model the error path with a union return type (`Result<S, E>`) rather than exceptions, since LemmaScript reasons about return values.
- Use `//@ ghost let` for proof-only tracking of state history in multi-step protocols.

## Performance considerations

State-machine performance in TypeScript depends on object shape stability and allocation patterns.

### Key principles

- **Branded typestate is zero-cost.** The brand exists only in the type system — it is erased at compile time. Transitions that reuse the same object via `as unknown as` allocate nothing.
- **Spread creates allocations.** `{ ...order, state: "paid" }` allocates a new object on every transition. When this matters on a hot path, mutate in place instead or use branded typestate.
- **Keep object shapes stable.** If different states carry different properties, V8 tracks them as different hidden classes. Mixing them through the same variable makes call sites polymorphic and slower. If performance matters, keep all states with the same runtime shape (use `undefined` for absent fields).
- **Avoid `delete`.** Deleting a property changes an object's hidden class and de-optimizes downstream code.
- **Class instances have stable shapes.** Each class produces a consistent hidden class, making method calls fast. But creating a new instance per transition is still an allocation.
- **Discriminated unions with mutation** (mutating the `kind` field in place) are a single property write — no allocation, no shape change. This sacrifices immutability for speed.

### Practical ladder for performance-sensitive code

From fastest/most constrained to most readable:

1. **Packed numeric state** (SMI-range) — absolute speed, minimal readability. See [appendix](#packed-numeric-state-machines).
2. **Singleton typestate** — near-zero allocation with compiler-checked transitions. See [appendix](#singleton-typestate).
3. **Branded typestate with in-place rebranding** — zero overhead for the brand; the cost is only whatever the payload does.
4. **Distinct state types** — one allocation per transition (new object literal), but the clearest domain model.

For most application code, branded typestate or distinct state types provide sufficient performance. Reserve packed numerics and singleton typestate for protocol parsers, stream processors, and tight schedulers.

## Production concerns

- **Persist logical state, not implementation details.** Store state names or stable numeric codes. A discriminated union's `kind` field makes a natural persistence key.
- **Validate external input at runtime** before converting it into typed internal representations. Use `zod`, `io-ts`, or manual validation at the boundary.
- **Be explicit about async boundaries.** Immutable designs are easier to reason about across `await` points; mutable designs require careful ownership tracking.
- **Add structured logging around transitions** so failures can be traced in domain terms, not internal types or bit patterns.
- **Plan for evolution.** Adding a new state is easier when handling is centralized and exhaustive. TypeScript's `never` trick in `default` branches catches unhandled states at compile time when a new variant is added.

---

## Appendix: Specialized patterns

These patterns are useful in performance-critical hot paths but are not recommended as a default choice.

### Packed numeric state machines

State is stored in one or a few numeric values. Transitions decode, update, and re-encode bits. JavaScript bitwise operators work on 32-bit signed integers; V8 keeps values under 2^30 as unboxed SMIs (Small Integers).

```typescript
// Layout: [state: 2 bits][revision: 16 bits][cents: 14 bits]
const STATE_MASK = 0x3;
const REVISION_SHIFT = 2;
const CENTS_SHIFT = 18;

const DRAFT = 0;
const PAID = 1;
const SHIPPED = 2;

function create(cents: number, revision: number): number {
  return ((cents & 0x3FFF) << CENTS_SHIFT)
    | ((revision & 0xFFFF) << REVISION_SHIFT)
    | DRAFT;
}

function pay(order: number): number {
  return (order & ~STATE_MASK) | PAID;
}

function ship(order: number): number {
  return (order & ~STATE_MASK) | SHIPPED;
}

function getState(order: number): number {
  return order & STATE_MASK;
}
```

For wider packed state, use `BigInt` — but it is substantially slower than SMI arithmetic.

**When to use:** Protocol engines, binary stream processors, tight schedulers where allocation pressure and throughput are the dominant concerns.

### Singleton typestate

Legal states are singleton objects whose types encode allowed transitions. Runtime data lives in a separate mutable carrier. Transitions return existing singleton references — no allocation.

```typescript
interface OrderData {
  id: string;
  cents: number;
  revision: number;
}

class Draft {
  private static readonly instance = new Draft();
  private constructor() {}
  static get(): Draft { return Draft.instance; }

  pay(_data: OrderData): Paid { return Paid.get(); }
}

class Paid {
  private static readonly instance = new Paid();
  private constructor() {}
  static get(): Paid { return Paid.instance; }

  ship(_data: OrderData): Shipped { return Shipped.get(); }
}

class Shipped {
  private static readonly instance = new Shipped();
  private constructor() {}
  static get(): Shipped { return Shipped.instance; }
}

// Usage
const data: OrderData = { id: "o-123", cents: 2500, revision: 0 };
let state: Draft | Paid | Shipped = Draft.get();
state = (state as Draft).pay(data);
state = (state as Paid).ship(data);
```

**When to use:** Hot paths that need compiler-checked transitions with near-zero allocation, and where a mutable data carrier is acceptable.
