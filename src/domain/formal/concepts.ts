/** Deterministic, evidence-backed concept admission and immutable group registries. */
import { createHash } from "node:crypto";
import { err, ok, type Result } from "../result.js";
import type { Claim } from "../claim-graph.js";
import type { SourceReference, SourceSpan } from "../model.js";
import { isRecord, type AnalysisLimits } from "./analysis-config.js";
import { mergeExpressionSignatures } from "./signature.js";
import type { ExpressionSignature, ExpressionSort, ExpressionSymbol, UnitDefinition } from "./expression-types.js";

/** Static semantic role; role does not invent temporal occurrence/frame semantics. */
export type ConceptRole = "state" | "configuration" | "event" | "input" | "output" | "derived";

/** Claimed source grounding is validated against the selected merged source set. */
export interface ConceptCandidate extends ExpressionSymbol {
  readonly definition: string;
  readonly role: ConceptRole;
  readonly aliases: readonly string[];
  readonly source?: SourceReference;
  readonly term?: string;
}

/** Accepted concept with stable scoped identity and explicit origin/resolution evidence. */
export interface RegistryConcept extends ConceptCandidate {
  readonly id: string;
  readonly status: "explicit" | "grounded-proposal";
  readonly evidence: readonly SourceSpan[];
  readonly authority?: { readonly kind: "configuration"; readonly pointer: string; readonly file: string };
}

/** Explicit coverage metadata remains distinct from automatically suggested input gaps. */
export interface CoverageDefinition {
  readonly name: string;
  readonly applicability: string;
  readonly sources: readonly SourceReference[];
}

/** Explicit authored context; only its background expressions may become premises. */
export interface AuthoredModel {
  readonly concepts: readonly ConceptCandidate[];
  readonly enums: ExpressionSignature["enums"];
  readonly units: readonly UnitDefinition[];
  readonly background: readonly string[];
  readonly coverage: readonly CoverageDefinition[];
}

/** Frozen registry and rejected/unresolved material for deterministic audit. */
export interface FrozenRegistry {
  readonly group: string;
  readonly side: "specs_forward" | "generated_spec";
  readonly concepts: readonly RegistryConcept[];
  readonly signature: ExpressionSignature;
  readonly background: readonly string[];
  readonly coverage: readonly CoverageDefinition[];
  readonly proposedAssumptions: readonly unknown[];
  readonly unresolved: readonly string[];
  readonly issues: readonly string[];
  readonly hash: string;
  readonly sourceScope: { readonly extracted: number; readonly eligible: number; readonly excluded: number };
}

const ROLES = ["state", "configuration", "event", "input", "output", "derived"];

/** Validate a model/candidate concept without assigning semantic aliases by heuristics. */
export function decodeConcept(value: unknown): Result<ConceptCandidate, string> {
  if (!isRecord(value) || typeof value.name !== "string" || !value.name || typeof value.definition !== "string" || !value.definition.trim()
    || typeof value.role !== "string" || !ROLES.includes(value.role) || !isSort(value.sort)) return err("Concept requires name, definition, role and supported sort");
  if (Object.keys(value).some((key) => !["name", "definition", "role", "sort", "args", "unit", "argUnits", "aliases", "source", "term"].includes(key))) return err("Unsupported concept metadata or scope");
  if (value.args !== undefined && (!Array.isArray(value.args) || !value.args.every(isSort))) return err("Invalid concept function arguments");
  if (value.unit !== undefined && typeof value.unit !== "string") return err("Invalid concept unit");
  if (value.argUnits !== undefined && (!Array.isArray(value.argUnits) || value.argUnits.some((unit) => unit !== null && typeof unit !== "string"))) return err("Invalid argument units");
  if (value.aliases !== undefined && (!Array.isArray(value.aliases) || value.aliases.some((alias) => typeof alias !== "string"))) return err("Invalid concept aliases");
  if (value.source !== undefined && !isSourceReference(value.source)) return err("Invalid concept source reference");
  if (value.term !== undefined && typeof value.term !== "string") return err("Invalid source term");
  return ok(Object.freeze({ name: value.name, definition: value.definition.trim(), role: value.role as ConceptRole,
    sort: value.sort, aliases: Object.freeze([...(value.aliases ?? []) as string[]]),
    ...(value.args === undefined ? {} : { args: Object.freeze(value.args as ExpressionSort[]) }),
    ...(value.unit === undefined ? {} : { unit: value.unit as string }),
    ...(value.argUnits === undefined ? {} : { argUnits: Object.freeze((value.argUnits as (string | null)[]).map((unit) => unit ?? undefined)) }),
    ...(value.source === undefined ? {} : { source: Object.freeze({ ...(value.source as SourceReference) }) }),
    ...(value.term === undefined ? {} : { term: value.term as string }),
  }));
}

/** Decode only explicitly authored background/enums/units; malformed groups localize. */
export function decodeAuthoredModel(value: unknown, limits: AnalysisLimits): Result<AuthoredModel, string> {
  if (value === undefined) return ok(Object.freeze({ concepts: [], enums: [], units: [], background: [], coverage: [] }));
  if (!isRecord(value)) return err("Authored semantic group model must be an object");
  if (Object.keys(value).some((key) => !["concepts", "enums", "units", "background", "coverage"].includes(key))) return err("Unsupported authored model field or temporal meaning");
  const conceptsRaw = value.concepts ?? [];
  const enumsRaw = value.enums ?? [];
  const unitsRaw = value.units ?? [];
  const background = value.background ?? [];
  const coverageRaw = value.coverage ?? [];
  if (!Array.isArray(conceptsRaw) || conceptsRaw.length > limits.concepts || !Array.isArray(enumsRaw)
    || !Array.isArray(unitsRaw) || !Array.isArray(background) || background.some((item) => typeof item !== "string")
    || !Array.isArray(coverageRaw)) return err("Invalid or oversized authored model collections");
  const concepts: ConceptCandidate[] = [];
  for (const raw of conceptsRaw) {
    const concept = decodeConcept(raw); if (!concept.ok) return concept;
    if (concepts.some((item) => item.name === concept.value.name)) return err(`Duplicate explicit concept key: ${concept.value.name}`);
    concepts.push(concept.value);
  }
  const enums: ExpressionSignature["enums"][number][] = [];
  for (const raw of enumsRaw) {
    if (!isRecord(raw) || typeof raw.name !== "string" || !Array.isArray(raw.constructors) || raw.constructors.some((item) => typeof item !== "string")) return err("Invalid authored enum");
    enums.push({ name: raw.name, constructors: Object.freeze([...raw.constructors] as string[]) });
  }
  const units: UnitDefinition[] = [];
  for (const raw of unitsRaw) {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.dimension !== "string" || !isRecord(raw.scale)
      || typeof raw.scale.numerator !== "string" || typeof raw.scale.denominator !== "string") return err("Invalid authored exact unit scale");
    units.push({ name: raw.name, dimension: raw.dimension, scale: { numerator: raw.scale.numerator, denominator: raw.scale.denominator } });
  }
  const coverage: CoverageDefinition[] = [];
  for (const raw of coverageRaw) {
    if (!isRecord(raw) || typeof raw.name !== "string" || typeof raw.applicability !== "string" || !Array.isArray(raw.sources) || !raw.sources.every(isSourceReference)) return err("Invalid coverage scope or source references");
    coverage.push(Object.freeze({ name: raw.name, applicability: raw.applicability, sources: Object.freeze(raw.sources) }));
  }
  const signature = mergeExpressionSignatures([{ symbols: concepts, enums, units }]);
  if (!signature.ok) return signature;
  return ok(Object.freeze({ concepts: Object.freeze(concepts), enums: signature.value.enums, units: signature.value.units,
    background: Object.freeze(background as string[]), coverage: Object.freeze(coverage) }));
}

/** Freeze a complete discovery pass in source order, preserving unresolved collisions. */
export function freezeRegistry(
  group: string, side: FrozenRegistry["side"], claims: readonly Claim[], authored: AuthoredModel,
  rawCandidates: readonly unknown[], proposedAssumptions: readonly unknown[], limits: AnalysisLimits,
  configSource = "<analysis>",
  modelKey = group,
): FrozenRegistry {
  const concepts = new Map<string, RegistryConcept>();
  const unresolved = new Set<string>();
  const issues: string[] = [];
  const sourceKey = (source?: SourceReference): string => JSON.stringify([source?.file ?? null, source?.ordinal ?? null]);
  const sources = new Map<string, { readonly claim: Claim; readonly order: number }>();
  for (let index = 0; index < claims.length; index += 1) {
    const key = sourceKey(claims[index]!.surface?.source);
    if (!sources.has(key)) sources.set(key, { claim: claims[index]!, order: index });
  }
  const order = (source?: SourceReference): number => sources.get(sourceKey(source))?.order ?? -1;
  const candidates: ConceptCandidate[] = [];
  for (const raw of rawCandidates) { const decoded = decodeConcept(raw); if (decoded.ok) candidates.push(decoded.value); else issues.push(decoded.error); }
  candidates.sort((a, b) => order(a.source) - order(b.source) || a.name.localeCompare(b.name) || a.definition.localeCompare(b.definition));
  for (let index = 0; index < authored.concepts.length; index += 1) {
    const candidate = authored.concepts[index]!;
    const field = side === "specs_forward" ? "models" : "generatedModels";
    const key = modelKey.replace(/~/gu, "~0").replace(/\//gu, "~1");
    concepts.set(candidate.name, Object.freeze({ ...conceptRecord(group, side, candidate, "explicit", []),
      authority: Object.freeze({ kind: "configuration", pointer: `/analysis/${field}/${key}/concepts/${index}`, file: configSource }) }));
  }
  for (const candidate of candidates) {
    if (concepts.size >= limits.concepts && !concepts.has(candidate.name)) { issues.push("Concept registry bound exceeded"); unresolved.add(candidate.name); continue; }
    const old = concepts.get(candidate.name);
    if (old?.status === "explicit") { issues.push(`Model-proposed alias/meaning retained as a proposal for explicit concept: ${candidate.name}`); continue; }
    const selectedSource = sources.get(sourceKey(candidate.source))?.claim.surface;
    const evidence = sourceEvidence(candidate, selectedSource);
    if (evidence.length === 0) { issues.push(`Unresolved source grounding: ${candidate.name}`); unresolved.add(candidate.name); concepts.delete(candidate.name); continue; }
    if (unresolved.has(candidate.name)) continue;
    if (old !== undefined && !sameMeaning(old, candidate)) {
      concepts.delete(candidate.name); unresolved.add(candidate.name); issues.push(`Unresolved concept collision: ${candidate.name}`); continue;
    }
    const checked = mergeExpressionSignatures([{ symbols: [candidate], enums: authored.enums, units: authored.units }]);
    if (!checked.ok) { issues.push(`${candidate.name}: ${checked.error}`); unresolved.add(candidate.name); continue; }
    const canonicalSource = selectedSource?.source;
    concepts.set(candidate.name, conceptRecord(group, side, { ...(old ?? candidate), ...(canonicalSource === undefined ? {} : { source: canonicalSource }), aliases: [...new Set([...(old?.aliases ?? []), ...candidate.aliases])] }, "grounded-proposal", [...(old?.evidence ?? []), ...evidence]));
  }
  const accepted = [...concepts.values()];
  const signature = mergeExpressionSignatures([{ symbols: accepted, enums: authored.enums, units: authored.units }]);
  if (!signature.ok) { issues.push(signature.error); for (const concept of accepted) unresolved.add(concept.name); concepts.clear(); }
  for (const scope of authored.coverage) if (scope.sources.some((source) => order(source) < 0)) issues.push(`Unknown coverage source: ${scope.name}`);
  const body = Object.freeze({ group, side, concepts: Object.freeze([...concepts.values()]),
    sourceScope: Object.freeze({ extracted: claims.length, eligible: claims.filter((claim) => claim.surface?.disposition.kind !== "excluded").length, excluded: claims.filter((claim) => claim.surface?.disposition.kind === "excluded").length }),
    signature: signature.ok ? signature.value : Object.freeze({ symbols: [], enums: [], units: [] }),
    background: Object.freeze([...authored.background]), coverage: Object.freeze(authored.coverage.map((scope) => Object.freeze({
      ...scope, sources: Object.freeze(scope.sources.map((source) => Object.freeze({ file: source.file, ordinal: source.ordinal, ...(source.namespace === undefined ? {} : { namespace: source.namespace }) }))),
    }))),
    proposedAssumptions: Object.freeze(proposedAssumptions.map((value) => JSON.stringify(value) ?? "null").sort()), unresolved: Object.freeze([...unresolved].sort()), issues: Object.freeze(issues.sort()),
  });
  return Object.freeze({ ...body, hash: contentHash(body) });
}

/** Canonical registry hashing has no I/O, ambient clock, or mutable global state. */
export function contentHash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex"); }

/** Admit only explicit finite enum identities and scalar builtin sorts. */
function isSort(value: unknown): value is ExpressionSort { return value === "Bool" || value === "Int" || value === "Real" || (isRecord(value) && typeof value.enum === "string" && Object.keys(value).length === 1); }

/** Source-local provenance is exact, not an authored-ID or array-position match. */
function isSourceReference(value: unknown): value is SourceReference { return isRecord(value) && typeof value.file === "string" && typeof value.ordinal === "number" && Number.isSafeInteger(value.ordinal) && value.ordinal >= 0 && (value.namespace === undefined || typeof value.namespace === "string"); }

/** Stable source-scoped identity and accepted evidence are immutable snapshots. */
function conceptRecord(group: string, side: FrozenRegistry["side"], concept: ConceptCandidate, status: RegistryConcept["status"], evidence: readonly SourceSpan[]): RegistryConcept {
  return Object.freeze({ ...concept, id: contentHash([side, group, status === "explicit" ? "explicit" : concept.source, concept.name]), status,
    sort: typeof concept.sort === "string" ? concept.sort : Object.freeze({ enum: concept.sort.enum }),
    aliases: Object.freeze([...new Set(concept.aliases)].sort()), evidence: Object.freeze([...new Map(evidence.map((span) => [JSON.stringify(span), span])).values()].sort((a, b) => a.file.localeCompare(b.file) || a.start.offset - b.start.offset || a.end.offset - b.end.offset)),
    ...(concept.args === undefined ? {} : { args: Object.freeze(concept.args.map((sort) => typeof sort === "string" ? sort : Object.freeze({ enum: sort.enum }))) }),
    ...(concept.argUnits === undefined ? {} : { argUnits: Object.freeze([...concept.argUnits]) }),
  });
}

/** Ground a model proposal in selected source; grounding is not semantic proof. */
function sourceEvidence(candidate: ConceptCandidate, source: Claim["surface"]): readonly SourceSpan[] {
  if (!candidate.source || !candidate.term?.trim()) return [];
  if (source === undefined) return [];
  if (candidate.source.namespace !== undefined && candidate.source.namespace !== source.source.namespace) return [];
  const clauses = source.clauses;
  const term = candidate.term.toLowerCase();
  const fragments = [{ text: source.text, span: source.span }, ...Object.values(clauses ?? {}).filter((value): value is { text: string; span: SourceSpan } => isRecord(value) && typeof value.text === "string" && value.span !== undefined), ...Object.values(source.fields)];
  return fragments.filter((value) => value?.text.toLowerCase().includes(term)).map((value) => value!.span);
}

/** Conservative identity agreement; type-compatible names alone are not an ontology. */
function sameMeaning(a: ConceptCandidate, b: ConceptCandidate): boolean {
  return a.definition === b.definition && a.role === b.role && JSON.stringify(a.sort) === JSON.stringify(b.sort)
    && a.unit === b.unit && JSON.stringify(a.args) === JSON.stringify(b.args) && JSON.stringify(a.argUnits) === JSON.stringify(b.argUnits);
}
