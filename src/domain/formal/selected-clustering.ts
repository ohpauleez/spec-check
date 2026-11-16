/** Shared selection publication on both sides, admitted before solver work. */
import { clusterFormalizationSamples } from "./clustering.js";
import { assessRepresentative } from "./interpretation-assessment.js";
import type { Finding } from "../findings.js";

const SELECTION_RECORD_MARGIN_BYTES = 16_384;

/** Reserve bounded assessment evidence, then cluster and publish before exposing a representative.
 * @remarks Samples are a bounded nonempty admitted set; the executor owns process/script limits.
 * Expected evidence refusal returns an unassessed diagnostic representative; required write failures
 * propagate. Single samples are selected, never measured stable. No extra solver query is added.
 */
export async function clusterWithSelection(input: Parameters<typeof clusterFormalizationSamples>[0]): ReturnType<typeof clusterFormalizationSamples> {
  const recorder = input.executor?.evidence;
  const scope = recorder?.nextRecordScope(`${input.group ?? "<formalization>"}:selection:${input.claimId}`);
  const bytes = SELECTION_RECORD_MARGIN_BYTES + Buffer.byteLength(input.claimId, "utf8") + input.samples.length * 32;
  if (scope !== undefined && !recorder?.reserve(scope, bytes)) {
    const first = input.samples[0];
    if (first === undefined) throw new Error("Selection requires a nonempty admitted sample set");
    const clusters = input.samples.map((_, index) => ({ members: [index] }));
    input.executor?.unissued(input.group ?? "<formalization>", "clustering-selection", "skipped", "Required selection evidence capacity");
    const finding: Finding = { severity: "warning", category: "formalization.unassessed_selection", provenance: { file: input.group ?? "<formalization>", heading: input.claimId },
      description: "Selection evidence capacity exhausted; representative is diagnostic only", rationale: "No clustering solver work was issued; scope cannot establish stable agreement.", evidence: [] };
    return { clustered: { representative: assessRepresentative(first, input.samples, "unstable", clusters), clusters, pairwise: [], ambiguous: true, stability: "unstable" }, findings: [finding] };
  }
  try {
    const result = await clusterFormalizationSamples(input);
    if (scope !== undefined) await recorder?.json(scope, "selection", { claimId: input.claimId, registryHash: result.clustered.representative.registryHash,
      assessment: result.clustered.representative.interpretationAssessment }, "formalization", scope);
    return result;
  } finally { if (scope !== undefined) recorder?.release(scope); }
}
