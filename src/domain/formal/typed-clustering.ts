/** Nonvacuous typed sample equivalence; single samples never claim measured stability. */
import type { LogicIrClaim } from "../logic-ir.js";
import type { Finding } from "../findings.js";
import type { ClusteredClaim, PairwiseImplicationResult } from "./clustering.js";
import { buildEquivalenceClusters } from "./clustering.js";
import { mergeExpressionSignatures } from "./signature.js";
import { conjunction, negation } from "./predicate-lowering.js";
import { QueryExecutor } from "./query-executor.js";
import { DEFAULT_ANALYSIS } from "./analysis-config.js";
import { assessRepresentative } from "./interpretation-assessment.js";

/** Compare compatible satisfiable interpretations. Composed callers must supply
 * the same executor to share run-wide process and actual-script budgets.
 */
export async function clusterTypedSamples(input: {
  readonly claimId: string; readonly samples: readonly LogicIrClaim[]; readonly stabilityThreshold: number;
  readonly z3Path?: string; readonly executor?: QueryExecutor; readonly group?: string;
}): Promise<{ clustered: ClusteredClaim; findings: readonly Finding[] }> {
  const findings: Finding[] = [];
  const report = (category: string, message: string): void => {
    findings.push({ severity: "warning", category, provenance: { file: input.group ?? "<formalization>", heading: input.claimId },
      description: message, rationale: "Interpretation agreement is conditional on the checked signature and premises; a single sample is not measured agreement.",
      evidence: [{ kind: "claim", value: input.claimId }], relatedClaimIdentifiers: [input.claimId] });
  };
  const first = input.samples[0]!;
  if (input.samples.length === 1) return { clustered: { representative: assessRepresentative(first, input.samples, "single", [{ members: [0] }]), clusters: [{ members: [0] }], pairwise: [], ambiguous: false, stability: "single" }, findings };
  const signature = mergeExpressionSignatures(input.samples.flatMap((sample) => sample.signature === undefined ? [] : [sample.signature]));
  const executor = input.executor ?? new QueryExecutor(DEFAULT_ANALYSIS.limits, undefined, input.z3Path);
  const group = input.group ?? `<clustering/${input.claimId}>`;
  const B = first.background ?? [];
  const canonicalBackground = JSON.stringify(B.map((value) => executor.render(value)));
  const formulas = input.samples.map((sample) => sample.staticScenario !== undefined
    ? conjunction([sample.staticScenario.input, sample.staticScenario.outcome])
    : sample.staticRule?.kind === "permission" ? conjunction([sample.staticRule.guard, sample.staticRule.response])
      : conjunction(sample.assertions.flatMap((assertion) => assertion.node === undefined ? [] : [assertion.node])));
  const pairwise: PairwiseImplicationResult[] = [];
  const satisfiable = new Set<number>();
  if (!signature.ok || input.samples.some((sample) => sample.signature === undefined || sample.registryHash !== first.registryHash
    || (sample.background !== B && JSON.stringify((sample.background ?? []).map((value) => executor.render(value))) !== canonicalBackground))) report("formalization.incompatible", signature.ok ? "Sample registry/signature/premises are incompatible" : signature.error);
  else {
    const background = await executor.execute(group, `cluster:${input.claimId}:background`, signature.value, B);
    if (background.result?.kind !== "sat") {
      report("formalization.inconclusive", "Background is inconsistent or unestablished; equivalence blocked");
      executor.unissued(group, `cluster:${input.claimId}:premises`, "blocked", "Background consistency is unestablished", formulas.length);
      executor.unissued(group, `cluster:${input.claimId}:directions`, "blocked", "Background consistency is unestablished", formulas.length * (formulas.length - 1));
    }
    else {
      for (let index = 0; index < formulas.length; index += 1) {
        const premise = await executor.execute(group, `cluster:${input.claimId}:premise:${index}`, signature.value, [...B, formulas[index]!]);
        if (premise.result?.kind === "sat") satisfiable.add(index);
        else report(premise.status === "skipped" ? "formalization.unassessed_sample" : premise.result?.kind === "unsat" ? "formalization.inconsistent_sample" : "formalization.inconclusive_sample",
          `Sample ${index} premise is ${premise.result?.kind ?? premise.reason ?? "unestablished"}; it cannot establish stable agreement`);
      }
      let blockedDirections = 0;
      for (let left = 0; left < formulas.length; left += 1) for (let right = left + 1; right < formulas.length; right += 1) {
        if (!satisfiable.has(left) || !satisfiable.has(right)) { blockedDirections += 2; continue; }
        const forward = await executor.execute(group, `cluster:${input.claimId}:${left}:${right}:forward`, signature.value, [...B, formulas[left]!, negation(formulas[right]!)]);
        const reverse = await executor.execute(group, `cluster:${input.claimId}:${left}:${right}:reverse`, signature.value, [...B, formulas[right]!, negation(formulas[left]!)]);
        const verdict = (kind?: string): "yes" | "no" | "inconclusive" => kind === "unsat" ? "yes" : kind === "sat" ? "no" : "inconclusive";
        pairwise.push({ leftIndex: left, rightIndex: right, leftImpliesRight: verdict(forward.result?.kind), rightImpliesLeft: verdict(reverse.result?.kind),
          evidence: { leftToRightQuery: forward.script ?? "", rightToLeftQuery: reverse.script ?? "", leftToRightResult: forward.result?.stdout ?? forward.reason ?? "", rightToLeftResult: reverse.result?.stdout ?? reverse.reason ?? "" } });
      }
      executor.unissued(group, `cluster:${input.claimId}:directions`, "blocked", "Sample premise satisfiability is unestablished", blockedDirections);
    }
  }
  const clusters = buildEquivalenceClusters(input.samples.length, pairwise);
  const ranked = [...clusters].sort((a, b) => b.members.length - a.members.length || a.members[0]! - b.members[0]!);
  const stable = ranked.find((cluster) => cluster.members.every((index) => satisfiable.has(index)) && cluster.members.length / input.samples.length >= input.stabilityThreshold);
  const members = stable?.members ?? [...satisfiable];
  const selected = [...members].sort((a, b) => {
    const left = input.samples[a]!.interpretationQuality; const right = input.samples[b]!.interpretationQuality;
    return Number((left?.proposed ?? 1) > 0) - Number((right?.proposed ?? 1) > 0) || (right?.slots ?? 0) - (left?.slots ?? 0) || a - b;
  })[0] ?? 0;
  if (stable === undefined) report("formalization.ambiguity", "No compatible nonvacuous cluster meets the stability threshold");
  const stability = stable === undefined ? "unstable" : "stable";
  return { clustered: { representative: assessRepresentative(input.samples[selected]!, input.samples, stability, clusters), clusters, pairwise, ambiguous: stable === undefined, stability }, findings };
}
