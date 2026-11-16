/** Deterministic source-owned predicate slots and lowering into typed static behavior. */
import { err, ok, type Result } from "../result.js";
import { toClaimId } from "../branded.js";
import type { Claim } from "../claim-graph.js";
import type { LogicIrClaim } from "../logic-ir.js";
import { isRecord, type AnalysisLimits } from "./analysis-config.js";
import type { FrozenRegistry } from "./concepts.js";
import { validateExpression, ExpressionValidationContext } from "./expressions.js";
import { ImmutableObjects } from "./immutable.js";
import { renderExpression } from "./expression-render.js";
import { EXPRESSION_LIMITS, type ExpressionLimits, type LogicExpression, type StaticCoverage, type StaticRule } from "./expression-types.js";
import { expressionReferences } from "./dependencies.js";

/** Clause text establishes exact slots before the LLM is asked to interpret content. */
export function predicateSlots(claim: Claim): Readonly<Record<string, string>> {
  const surface = claim.surface;
  if (surface === undefined) return {};
  if (surface.scenarioKind !== "refinement") return Object.freeze({ input: surface.fields.input?.text ?? "",
    outcome: (surface.scenarioKind === "example" ? surface.fields.expected?.text : surface.fields.forbidden?.text) ?? "",
    ...(surface.fields.postcondition === undefined ? {} : { postcondition: surface.fields.postcondition.text }),
  });
  const clauses = surface.clauses;
  return Object.freeze(Object.fromEntries(["state", "trigger", "condition", "feature", "response", "postcondition"].flatMap((slot) => {
    const text = slot === "postcondition" ? surface.fields.postcondition?.text : clauses?.[slot as "state" | "trigger" | "condition" | "feature" | "response"]?.text;
    return text === undefined ? [] : [[slot, text]];
  })));
}

/** Compose validated Boolean predicates; empty conjunction is explicitly true. */
export function conjunction(args: readonly LogicExpression[]): LogicExpression {
  if (args.length === 0) return Object.freeze({ kind: "bool", value: true, sort: "Bool" });
  if (args.length === 1) return args[0]!;
  return Object.freeze({ kind: "operator", op: "and", args: Object.freeze([...args]), sort: "Bool" });
}

/** Negation is constructed by the source/modal compiler, never guessed by a model. */
export function negation(value: LogicExpression): LogicExpression { return Object.freeze({ kind: "operator", op: "not", args: Object.freeze([value]), sort: "Bool" }); }

interface PredicateContext { readonly background: readonly LogicExpression[]; readonly coverage: readonly StaticCoverage[] }

/** Parse shared predicates once per immutable registry/effective-limit tuple.
 * @example const preparation = new PredicatePreparation(); preparation.prepare(registry, limits);
 */
export class PredicatePreparation {
  readonly validation = new ExpressionValidationContext();
  private readonly immutable = new ImmutableObjects();
  private readonly contexts = new WeakMap<FrozenRegistry, { readonly key: string; readonly result: Result<PredicateContext, string> }>();

  /** Prepare background and coverage with the same byte/node/depth limits as source slots.
   * @returns Frozen typed context or a background/coverage validation reason.
   * @remarks Input must be a decoded registry. No mutation/I/O; only immutable graphs are cached,
   * and the exact limits participate in reuse. Invalid expressions are Result errors, not throws.
   * @example preparation.prepare(registry, { bytes: 65536, nodes: 8192, depth: 128 });
   */
  prepare(registry: FrozenRegistry, limits: ExpressionLimits = EXPRESSION_LIMITS): Result<PredicateContext, string> {
    const key = JSON.stringify([limits.bytes, limits.nodes, limits.depth]);
    const cached = this.contexts.get(registry);
    if (cached?.key === key) return cached.result;
    const result = this.parse(registry, limits);
    if (this.immutable.accepts(registry)) this.contexts.set(registry, { key, result });
    return result;
  }

  /** Validate shared expressions in authored order; stop at the first error without publication. */
  private parse(registry: FrozenRegistry, limits: ExpressionLimits): Result<PredicateContext, string> {
    const background: LogicExpression[] = [];
    for (const expression of registry.background) {
      const value = validateExpression(expression, registry.signature, limits, this.validation);
      if (!value.ok || value.value.sort !== "Bool") return err("Invalid explicit background predicate");
      background.push(value.value);
    }
    const coverage: StaticCoverage[] = [];
    for (const definition of registry.coverage) {
      const value = validateExpression(definition.applicability, registry.signature, limits, this.validation);
      if (!value.ok || value.value.sort !== "Bool") return err(`Invalid coverage applicability: ${definition.name}`);
      coverage.push(Object.freeze({ name: definition.name, applicability: value.value, sources: definition.sources, explicit: true }));
    }
    return ok(Object.freeze({ background: Object.freeze(background), coverage: Object.freeze(coverage) }));
  }
}

/** Lower one untrusted entry using source authority and frozen declarations.
 * @returns Accepted typed IR, or an identity/slot/source/expression/context validation reason.
 * @remarks Source structure must come from admission; absent structure is a validation error.
 * No I/O or mutation; guards, NOT, scenario kind and modality cannot be supplied by the model.
 * All predicates use effective limits. Logically inconsistent but type-valid nodes remain valid IR.
 * @example lowerPredicates(raw, claim, index, registry, limits, runPreparation);
 */
export function lowerPredicates(raw: unknown, claim: Claim, index: number, registry: FrozenRegistry, limits: AnalysisLimits, preparation = new PredicatePreparation()): Result<LogicIrClaim, string> {
  const surface = claim.surface;
  if (surface === undefined) return err("Source predicate lowering requires parsed source structure");
  if (!isRecord(raw) || raw.index !== index || raw.registryHash !== registry.hash || !isRecord(raw.predicates)) return err("Predicate entry index, registry hash, or object shape mismatch");
  if (Object.keys(raw).some((key) => !["index", "registryHash", "predicates", "claimId"].includes(key))) return err("Model cannot override source modality/declarations or add assertion fields");
  if (raw.claimId !== undefined && raw.claimId !== claim.id) return err("Model claim identifier does not match source display metadata");
  const slots = predicateSlots(claim);
  if (Object.keys(slots).length === 0 || Object.keys(raw.predicates).length !== Object.keys(slots).length) return err("Missing or extra source predicate slots");
  const values: Record<string, LogicExpression> = {};
  for (const slot of Object.keys(slots)) {
    const expression = raw.predicates[slot];
    if (typeof expression !== "string") return err(`Missing expression string for source slot ${slot}`);
    const parsed = validateExpression(expression, registry.signature, { bytes: limits.expressionBytes, nodes: limits.expressionNodes, depth: limits.expressionDepth }, preparation.validation);
    if (!parsed.ok) return err(`${slot}: ${parsed.error.message}`);
    if (parsed.value.sort !== "Bool") return err(`${slot}: source predicate must have Bool sort`);
    values[slot] = parsed.value;
  }
  const context = preparation.prepare(registry, { bytes: limits.expressionBytes, nodes: limits.expressionNodes, depth: limits.expressionDepth });
  if (!context.ok) return context;
  const { background, coverage } = context.value;
  const references = expressionReferences(Object.values(values));
  const used = registry.concepts.filter((concept) => references.has(concept.name));
  const interpretationQuality = Object.freeze({ explicit: used.filter((concept) => concept.status === "explicit").length, proposed: used.filter((concept) => concept.status === "grounded-proposal").length, slots: Object.keys(values).length });
  const common = { claimId: claim.id ?? toClaimId(`SOURCE-${index}`), obligation: claim.obligation, variables: [], functions: [],
    signature: registry.signature, registryHash: registry.hash, registry, interpretationQuality, background, coverage };
  if (surface.scenarioKind !== "refinement") {
    const outcome = conjunction([values.outcome!, ...(values.postcondition === undefined ? [] : [values.postcondition])]);
    return ok(Object.freeze({ ...common, assertions: [], staticScenario: Object.freeze({ source: surface.source, kind: surface.scenarioKind, input: values.input!, outcome }) }));
  }
  let response = values.response!;
  if (surface.clauses?.negatedResponse) response = negation(response);
  response = conjunction([response, ...(values.postcondition === undefined ? [] : [values.postcondition])]);
  const guard = conjunction(["state", "trigger", "condition", "feature"].flatMap((slot) => values[slot] === undefined ? [] : [values[slot]!]));
  const kind: StaticRule["kind"] = claim.obligation === "mandatory" ? "mandatory" : claim.obligation === "advisory" ? "advisory" : "permission";
  const rule: StaticRule = Object.freeze({ source: surface.source, claimId: common.claimId, kind, guard, response,
    interpretationDependent: interpretationQuality.proposed > 0 || registry.issues.length > 0 });
  const assertion: LogicExpression = Object.freeze({ kind: "operator", op: "=>", args: Object.freeze([guard, response]), sort: "Bool" });
  return ok(Object.freeze({ ...common, staticRule: rule, assertions: kind === "permission" ? [] : Object.freeze([{ id: "SOURCE-RULE", node: assertion, expr: renderExpression(assertion) }]) }));
}
