/** Comparison qualifications remain separate from concept mapping completeness. */
import type { LogicIrClaim, InterpretationAssessment } from "../logic-ir.js";

/** Each contributing source artifact retains sample selection and proposed-identity evidence. */
export interface ComparisonQualification {
  readonly side: "original" | "generated";
  readonly claimId: string;
  readonly assessment?: InterpretationAssessment;
  readonly identityDependent: boolean;
}

/** Gather contributing artifact assessments in deterministic side/input order. No I/O/mutation. */
export function comparisonQualifications(original: readonly LogicIrClaim[], generated: readonly LogicIrClaim[]): readonly ComparisonQualification[] {
  return ([ ["original", original], ["generated", generated] ] as const).flatMap(([side, claims]) => [...new Set(claims)].map((claim) => ({ side,
    claimId: claim.claimId, ...(claim.interpretationAssessment === undefined ? {} : { assessment: claim.interpretationAssessment }),
    identityDependent: (claim.interpretationQuality?.proposed ?? 0) > 0 || (claim.staticRule?.interpretationDependent === true && claim.interpretationAssessment?.stability !== "unstable"),
  })));
}

/** Only unstable selection blocks matching credit; singleton/proposed identity remain explicit. */
export function unstableComparison(result: { readonly qualifications?: readonly ComparisonQualification[] }): boolean {
  return result.qualifications?.some((item) => item.assessment?.stability === "unstable") ?? false;
}

/** Inert readable qualifications for reports/final-assessment input, not logical-strength promotion. */
export function qualificationText(result: { readonly qualifications?: readonly ComparisonQualification[] }): string {
  const values = new Set<string>();
  for (const item of result.qualifications ?? []) {
    if (item.assessment?.stability === "unstable") values.add("unstable interpretation; diagnostic selected-sample relation");
    if (item.assessment?.stability === "single") values.add("single sample; no measured agreement");
    if (item.identityDependent) values.add("conditional on proposed identity");
  }
  return values.size === 0 ? "" : `; ${[...values].join("; ")}`;
}
