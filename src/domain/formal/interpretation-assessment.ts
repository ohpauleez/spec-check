/** Immutable publication of measured sample selection on either source side. */
import type { InterpretationAssessment, LogicIrClaim } from "../logic-ir.js";

/** Retain sample/cluster provenance and mark unstable rules without losing identity dependence.
 * @remarks Inputs are a nonempty bounded sample set and its selected member; no I/O/mutation.
 * @returns The same semantic artifact with immutable assessment metadata.
 */
export function assessRepresentative(representative: LogicIrClaim, samples: readonly LogicIrClaim[],
  stability: InterpretationAssessment["stability"], clusters: readonly { readonly members: readonly number[] }[]): LogicIrClaim {
  return Object.freeze({ ...representative, interpretationAssessment: Object.freeze({ stability, sampleCount: samples.length,
    selectedSample: samples.indexOf(representative), clusters: Object.freeze(clusters.map((cluster) => Object.freeze([...cluster.members]))) }),
    ...(stability !== "unstable" || representative.staticRule === undefined ? {} : {
      staticRule: Object.freeze({ ...representative.staticRule, interpretationDependent: true }),
    }),
  });
}

/** Describe selected sample evidence before early solver exits, without conflating mapping scope.
 * @remarks Bounded pure traversal; no measured agreement is inferred for single samples.
 */
export function interpretationNotes(claims: readonly LogicIrClaim[]): string {
  const notes = new Set<string>();
  for (const claim of claims) {
    if (claim.interpretationAssessment?.stability === "unstable") notes.add("unstable interpretation; diagnostic selected-sample analysis");
    if (claim.interpretationAssessment?.stability === "single") notes.add("single sample; no measured agreement");
  }
  return [...notes].join("; ");
}
