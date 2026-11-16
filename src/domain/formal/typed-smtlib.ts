/** Compile checked typed semantic artifacts; SMT text is an output, not interchange. */
import { toSanitizedClaimId, toSmtlibContent } from "../branded.js";
import type { LogicIrClaim } from "../logic-ir.js";
import type { CompiledSmtlib, CompiledSpecSmtlib } from "./smtlib.js";
import { sanitizeIdentifier } from "./identifiers.js";
import { ExpressionRenderer } from "./expression-render.js";
import { mergeExpressionSignatures, SignaturePreparation } from "./signature.js";
import { classifyFragment } from "./fragment.js";

/** Preserve comment data on one inert line. */
function comment(value: string): string { return value.replace(/[\r\n]+/gu, " "); }

/** Share checked declarations and bounded expression roots across a compilation work unit. */
export class TypedCompilationPreparation {
  readonly signatures = new SignaturePreparation();
  readonly expressions = new ExpressionRenderer();
}

/** Standalone artifact keeps modality explicit and never hardens permissions/examples. */
export function compileTypedClaim(claim: LogicIrClaim, preparation = new TypedCompilationPreparation()): CompiledSmtlib {
  if (claim.signature === undefined) throw new Error("Typed compilation requires a checked signature");
  const declarations = preparation.signatures.render(claim.signature);
  const renderExpression = preparation.expressions.render.bind(preparation.expressions);
  if (!declarations.ok) throw new Error(declarations.error);
  const expressions = claim.assertions.map((assertion) => {
    if (assertion.node === undefined) throw new Error("Typed artifact has an untyped assertion");
    return renderExpression(assertion.node);
  });
  const lines = [`; claim ${comment(claim.claimId)}`, `; obligation ${claim.obligation}`, `; registry ${claim.registryHash ?? "unrecorded"}`, declarations.value.trimEnd()];
  if (claim.interpretationAssessment !== undefined) lines.splice(3, 0, `; interpretation ${comment(JSON.stringify(claim.interpretationAssessment))}`);
  if (claim.staticRule?.kind === "permission") {
    lines.push(`; permission guard ${renderExpression(claim.staticRule.guard)}`, `; permission response ${renderExpression(claim.staticRule.response)}`);
  }
  if (claim.staticScenario !== undefined) lines.push(`; ${claim.staticScenario.kind} input ${renderExpression(claim.staticScenario.input)}`, `; scenario outcome ${renderExpression(claim.staticScenario.outcome)}`);
  for (const expression of expressions) lines.push(`(assert ${expression})`);
  return { claimId: claim.claimId, sanitizedClaimId: toSanitizedClaimId(sanitizeIdentifier(claim.claimId)), smtlib: toSmtlibContent(lines.join("\n") + "\n"), assertionExprs: expressions };
}

/** Mandatory-only aggregate; failed signature/dependency validation performs no query. */
export function compileTypedGroup(specFile: string, claims: readonly LogicIrClaim[], preparation = new TypedCompilationPreparation()): CompiledSpecSmtlib {
  const renderExpression = preparation.expressions.render.bind(preparation.expressions);
  const sanitizedSpecId = toSanitizedClaimId(sanitizeIdentifier(specFile));
  const invalid = (message: string): CompiledSpecSmtlib => ({ specFile, sanitizedSpecId, smtlib: toSmtlibContent(""), claimIds: [], assertionNameMap: new Map(), conflicts: [], invalidReason: message });
  if (claims.some((claim) => claim.signature === undefined)) return invalid("Mixed typed/untyped signature artifacts are incompatible");
  const signatures = [...new Set(claims.map((claim) => claim.signature!))];
  const signature = mergeExpressionSignatures(signatures);
  if (!signature.ok) return invalid(signature.error);
  const declarations = preparation.signatures.render(signature.value);
  if (!declarations.ok) return invalid(declarations.error);
  const background = claims[0]?.background ?? [];
  const renderedBackground = background.map(renderExpression);
  const canonicalBackground = JSON.stringify(renderedBackground);
  if (claims.some((claim) => claim.background !== background && JSON.stringify((claim.background ?? []).map(renderExpression)) !== canonicalBackground)) return invalid("Group assumptions are incompatible");
  const mandatory = claims.filter((claim) => claim.staticRule?.kind === "mandatory");
  const expressions = [...background, ...mandatory.flatMap((claim) => claim.assertions.flatMap((assertion) => assertion.node === undefined ? [] : [assertion.node]))];
  if (mandatory.some((claim) => claim.assertions.some((assertion) => assertion.node === undefined))) return invalid("Typed assertion dependency is unresolved");
  const fragment = classifyFragment(signature.value, expressions);
  if (!fragment.ok) return invalid(fragment.error);
  const map = new Map<string, string>();
  const lines = [`; spec ${comment(specFile)}`, `; mode static: mandatory constraints only`, declarations.value.trimEnd()];
  for (let index = 0; index < background.length; index += 1) lines.push(`(assert (! ${renderedBackground[index]} :named bg__${index}))`);
  for (const claim of mandatory) for (let index = 0; index < claim.assertions.length; index += 1) {
    const label = `${sanitizeIdentifier(claim.claimId)}__a${index}`;
    map.set(label, claim.claimId);
    lines.push(`; claim ${comment(claim.claimId)}`, `(assert (! ${renderExpression(claim.assertions[index]!.node!)} :named ${label}))`);
  }
  return { specFile, sanitizedSpecId, smtlib: toSmtlibContent(lines.join("\n") + "\n"), claimIds: claims.map((claim) => claim.claimId), assertionNameMap: map, conflicts: [] };
}
