import type { CapabilityName } from "../branded.js";
import { precondition, postcondition } from "../assert.js";
import type { Finding } from "../findings.js";
import type {
  CatalogDocument,
  MergedCapabilitySpec,
  ParsedRequirement,
  ParsedScenario,
  ParsedSpec,
} from "../model.js";

interface RequirementBlock {
  readonly requirement: ParsedRequirement;
  readonly scenarios: readonly ParsedScenario[];
}

interface MergePerCapabilityResult {
  readonly merged: MergedCapabilitySpec;
}

/**
 * Merge finalized and selected delta specs into one active merged capability view.
 */
export function mergeSpecsByCapability(
  catalogDocuments: readonly CatalogDocument[],
  parsedSpecs: readonly ParsedSpec[],
): readonly MergedCapabilitySpec[] {
  const parsedByPath = new Map<string, ParsedSpec>();
  for (const parsed of parsedSpecs) {
    parsedByPath.set(parsed.file, parsed);
  }

  const capabilityOrder: CapabilityName[] = [];
  const docsByCapability = new Map<CapabilityName, CatalogDocument[]>();
  for (const document of catalogDocuments) {
    if (document.type !== "spec" || document.capability === undefined) {
      continue;
    }
    const existing = docsByCapability.get(document.capability);
    if (existing === undefined) {
      capabilityOrder.push(document.capability);
      docsByCapability.set(document.capability, [document]);
    } else {
      existing.push(document);
    }
  }

  for (const capability of capabilityOrder) {
    const docs = docsByCapability.get(capability) ?? [];
    const deltaCount = docs.filter((d) => d.source === "delta").length;
    precondition(deltaCount <= 1, `mergeSpecsByCapability received more than one delta for capability ${capability}`);
  }

  const merged: MergedCapabilitySpec[] = [];
  for (const capability of capabilityOrder) {
    const docs = docsByCapability.get(capability) ?? [];
    const baseDoc = docs.find((d) => d.source === "final");
    const deltaDoc = docs.find((d) => d.source === "delta");
    const baseParsed = baseDoc === undefined ? undefined : parsedByPath.get(baseDoc.path);
    const deltaParsed = deltaDoc === undefined ? undefined : parsedByPath.get(deltaDoc.path);
    if (baseDoc !== undefined) {
      precondition(baseParsed !== undefined, `missing parsed spec for ${baseDoc.path}`);
    }
    if (deltaDoc !== undefined) {
      precondition(deltaParsed !== undefined, `missing parsed spec for ${deltaDoc.path}`);
    }
    const result = mergeCapability(capability, baseParsed, deltaParsed);
    merged.push(result.merged);
  }

  // Postcondition: no more merged specs than capabilities observed.
  postcondition(
    merged.length <= capabilityOrder.length,
    `merged count (${merged.length}) exceeds capability count (${capabilityOrder.length})`,
  );

  // Postcondition: no duplicate logicalFile values in the output — each capability
  // maps to exactly one merged view.
  const logicalFiles = new Set(merged.map((m) => m.logicalFile));
  postcondition(
    logicalFiles.size === merged.length,
    "duplicate logicalFile in merged output",
  );

  return merged;
}

function mergeCapability(
  capability: CapabilityName,
  baseSpec: ParsedSpec | undefined,
  deltaSpec: ParsedSpec | undefined,
): MergePerCapabilityResult {
  const logicalFile = `<merged-spec/${capability}>`;
  const findings: Finding[] = [];

  if (baseSpec !== undefined && baseSpec.deltaSections.length > 0) {
    findings.push(makeFinding("warning", "spec_merge.finalized_spec_delta_heading_ignored", baseSpec.file, "finalized specs should not have Delta Spec Headings"));
  }
  // RENAMED per-item findings are emitted in partitionDelta (D-13 compliance:
  // every skipped merge operation produces exactly one finding).

  let workingBlocks = deduplicateBaseBlocks(baseSpec, findings);

  const delta = deltaSpec === undefined ? undefined : partitionDelta(deltaSpec, findings);
  if (delta !== undefined) {
    workingBlocks = applyRemoved(workingBlocks, delta.removed, findings);
    workingBlocks = applyModified(workingBlocks, delta.modified, findings);
    workingBlocks = applyAdded(workingBlocks, delta.added, findings);
  }

  const mergedRequirements = workingBlocks.map((block) => block.requirement);
  const mergedScenarios = workingBlocks.flatMap((block) => block.scenarios);

  if (mergedRequirements.length === 0) {
    findings.push(makeFinding("warning", "spec_merge.empty_capability_skipped", logicalFile, `Capability ${capability} has zero surviving merged requirements`));
  }

  return {
    merged: {
      capability,
      sourceFiles: [
        ...(baseSpec === undefined ? [] : [baseSpec.file]),
        ...(deltaSpec === undefined ? [] : [deltaSpec.file]),
      ],
      logicalFile,
      requirements: mergedRequirements,
      scenarios: mergedScenarios,
      findings,
    },
  };
}

function deduplicateBaseBlocks(baseSpec: ParsedSpec | undefined, findings: Finding[]): readonly RequirementBlock[] {
  if (baseSpec === undefined) {
    return [];
  }

  const { blocks } = groupBlocks(baseSpec);
  const seen = new Set<string>();
  const deduped: RequirementBlock[] = [];

  for (const block of blocks) {
    const identifier = block.requirement.identifier;
    if (identifier === undefined) {
      deduped.push(block);
      continue;
    }
    if (seen.has(identifier)) {
      findings.push(makeFinding("error", "spec_merge.duplicate_base_identifier", block.requirement.provenance.file, `Duplicate base requirement identifier: ${identifier}`));
      continue;
    }
    seen.add(identifier);
    deduped.push(block);
  }

  return deduped;
}

function partitionDelta(
  deltaSpec: ParsedSpec,
  findings: Finding[],
): {
  readonly added: readonly RequirementBlock[];
  readonly modified: readonly RequirementBlock[];
  readonly removed: readonly RequirementBlock[];
} {
  const { blocks, standaloneScenarios } = groupBlocks(deltaSpec);

  for (const block of blocks) {
    if (block.requirement.deltaOperation === "pre-section") {
      findings.push(makeFinding("error", "spec_merge.pre_section_content", block.requirement.provenance.file, `Delta content before first section heading: ${block.requirement.title}`));
    }
  }
  for (const scenario of standaloneScenarios) {
    if (scenario.deltaOperation === "pre-section") {
      findings.push(makeFinding("error", "spec_merge.pre_section_content", scenario.provenance.file, `Delta scenario before first section heading: ${scenario.title}`));
      continue;
    }
    findings.push(makeFinding("error", "spec_merge.standalone_scenario_unsupported", scenario.provenance.file, `Standalone scenario is not supported: ${scenario.title}`));
  }

  const addedRaw = blocks.filter((b) => b.requirement.deltaOperation === "ADDED");
  const modifiedRaw = blocks.filter((b) => b.requirement.deltaOperation === "MODIFIED");
  const removedRaw = blocks.filter((b) => b.requirement.deltaOperation === "REMOVED");

  // D-13: every skipped merge operation produces exactly one finding.
  // RENAMED blocks are intentionally not applied — rename semantics (identifier
  // rewriting across all references) are not defined in v1. Emit one finding per
  // RENAMED requirement so that no discard is silent.
  const renamedRaw = blocks.filter((b) => b.requirement.deltaOperation === "RENAMED");
  for (const block of renamedRaw) {
    const id = block.requirement.identifier ?? block.requirement.title;
    findings.push(makeFinding(
      "warning",
      "spec_merge.rename_unsupported",
      block.requirement.provenance.file,
      `RENAMED requirement "${id}" was not applied (rename semantics not supported in v1)`,
    ));
  }

  return {
    added: excludeDuplicateDeltaIdentifiers(addedRaw, "ADDED", findings),
    modified: excludeDuplicateDeltaIdentifiers(modifiedRaw, "MODIFIED", findings),
    removed: excludeDuplicateDeltaIdentifiers(removedRaw, "REMOVED", findings),
  };
}

function excludeDuplicateDeltaIdentifiers(
  blocks: readonly RequirementBlock[],
  operation: "ADDED" | "MODIFIED" | "REMOVED",
  findings: Finding[],
): readonly RequirementBlock[] {
  const grouped = new Map<string, RequirementBlock[]>();
  for (const block of blocks) {
    const identifier = block.requirement.identifier;
    // Design decision: blocks without identifiers intentionally bypass collision
    // detection. Only identified blocks participate in duplicate checking per the
    // merge spec — unidentified blocks always pass through to the output.
    if (identifier === undefined) {
      continue;
    }
    const existing = grouped.get(identifier);
    if (existing === undefined) {
      grouped.set(identifier, [block]);
    } else {
      existing.push(block);
    }
  }

  const excluded = new Set<RequirementBlock>();
  for (const [identifier, group] of grouped) {
    if (group.length <= 1) {
      continue;
    }
    for (const block of group) {
      excluded.add(block);
      findings.push(makeFinding("error", "spec_merge.duplicate_delta_identifier", block.requirement.provenance.file, `Duplicate ${operation} identifier in delta section: ${identifier}`));
    }
  }

  return blocks.filter((block) => !excluded.has(block));
}

function applyRemoved(
  workingBlocks: readonly RequirementBlock[],
  removedBlocks: readonly RequirementBlock[],
  findings: Finding[],
): readonly RequirementBlock[] {
  const next = [...workingBlocks];

  for (const block of removedBlocks) {
    const identifier = block.requirement.identifier;
    if (identifier === undefined) {
      findings.push(makeFinding("error", "spec_merge.removed_missing_identifier", block.requirement.provenance.file, "REMOVED requirement block must include an identifier"));
      continue;
    }
    const index = next.findIndex((candidate) => candidate.requirement.identifier === identifier);
    if (index < 0) {
      findings.push(makeFinding("error", "spec_merge.removed_target_not_found", block.requirement.provenance.file, `REMOVED target not found: ${identifier}`));
      continue;
    }
    next.splice(index, 1);
  }

  return next;
}

/**
 * Build requirement and scenario identifier namespace sets from a list of blocks.
 *
 * @param blocks - requirement blocks whose identifiers populate the namespaces
 * @returns paired namespace sets for requirement and scenario identifiers
 *
 * @remarks
 * Precondition: each block is a valid `RequirementBlock`.
 * Postcondition: `reqNs` contains all non-undefined requirement identifiers from
 * `blocks`; `scenNs` contains all non-undefined scenario identifiers from `blocks`.
 * Used by `applyModified` and `applyAdded` to detect identifier collisions
 * incrementally as blocks are replaced or appended.
 */
function buildNamespaceSets(blocks: readonly RequirementBlock[]): {
  readonly reqNs: Set<string>;
  readonly scenNs: Set<string>;
} {
  const reqNs = new Set<string>();
  const scenNs = new Set<string>();
  for (const candidate of blocks) {
    if (candidate.requirement.identifier !== undefined) reqNs.add(candidate.requirement.identifier);
    for (const s of candidate.scenarios) {
      if (s.identifier !== undefined) scenNs.add(s.identifier);
    }
  }
  return { reqNs, scenNs };
}

function applyModified(
  workingBlocks: readonly RequirementBlock[],
  modifiedBlocks: readonly RequirementBlock[],
  findings: Finding[],
): readonly RequirementBlock[] {
  const next = [...workingBlocks];

  // Build namespace sets once; maintained incrementally across modifications.
  const { reqNs, scenNs } = buildNamespaceSets(next);

  for (const block of modifiedBlocks) {
    const identifier = block.requirement.identifier;
    if (identifier === undefined) {
      findings.push(makeFinding("error", "spec_merge.modified_missing_identifier", block.requirement.provenance.file, "MODIFIED requirement block must include an identifier"));
      continue;
    }

    const targetIndex = next.findIndex((candidate) => candidate.requirement.identifier === identifier);
    if (targetIndex < 0) {
      findings.push(makeFinding("error", "spec_merge.modified_target_not_found", block.requirement.provenance.file, `MODIFIED target not found: ${identifier}`));
      continue;
    }

    const targetBlock = next[targetIndex]!;
    // Temporarily remove target identifiers to check for external collisions.
    const targetReqId = targetBlock.requirement.identifier;
    if (targetReqId !== undefined) reqNs.delete(targetReqId);
    const removedScenIds: string[] = [];
    for (const s of targetBlock.scenarios) {
      if (s.identifier !== undefined) { scenNs.delete(s.identifier); removedScenIds.push(s.identifier); }
    }

    const replacementRequirementIdentifier = block.requirement.identifier;
    if (replacementRequirementIdentifier !== undefined && reqNs.has(replacementRequirementIdentifier)) {
      findings.push(makeFinding("error", "spec_merge.duplicate_modified_identifier", block.requirement.provenance.file, `MODIFIED replacement collision for identifier ${replacementRequirementIdentifier} in requirement namespace`));
      if (targetReqId !== undefined) reqNs.add(targetReqId);
      for (const id of removedScenIds) scenNs.add(id);
      continue;
    }

    const replacementScenarioIdentifier = block.scenarios
      .map((scenario) => scenario.identifier)
      .find((value): value is string => value !== undefined && scenNs.has(value));
    if (replacementScenarioIdentifier !== undefined) {
      findings.push(makeFinding("error", "spec_merge.duplicate_modified_identifier", block.requirement.provenance.file, `MODIFIED replacement collision for identifier ${replacementScenarioIdentifier} in scenario namespace`));
      if (targetReqId !== undefined) reqNs.add(targetReqId);
      for (const id of removedScenIds) scenNs.add(id);
      continue;
    }

    // Commit: add replacement identifiers and apply modification.
    if (replacementRequirementIdentifier !== undefined) reqNs.add(replacementRequirementIdentifier);
    for (const s of block.scenarios) {
      if (s.identifier !== undefined) scenNs.add(s.identifier);
    }
    next[targetIndex] = block;
  }

  return next;
}

function applyAdded(
  workingBlocks: readonly RequirementBlock[],
  addedBlocks: readonly RequirementBlock[],
  findings: Finding[],
): readonly RequirementBlock[] {
  const next = [...workingBlocks];

  // Build namespace sets once; update incrementally as blocks are added.
  const { reqNs, scenNs } = buildNamespaceSets(next);

  for (const block of addedBlocks) {
    const requirementIdentifier = block.requirement.identifier;
    if (requirementIdentifier !== undefined && reqNs.has(requirementIdentifier)) {
      findings.push(makeFinding("error", "spec_merge.duplicate_added_identifier", block.requirement.provenance.file, `ADDED identifier collision for ${requirementIdentifier} in requirement namespace`));
      continue;
    }

    const scenarioIdentifier = block.scenarios
      .map((scenario) => scenario.identifier)
      .find((value): value is string => value !== undefined && scenNs.has(value));
    if (scenarioIdentifier !== undefined) {
      findings.push(makeFinding("error", "spec_merge.duplicate_added_identifier", block.requirement.provenance.file, `ADDED identifier collision for ${scenarioIdentifier} in scenario namespace`));
      continue;
    }

    next.push(block);
    if (requirementIdentifier !== undefined) reqNs.add(requirementIdentifier);
    for (const s of block.scenarios) {
      if (s.identifier !== undefined) scenNs.add(s.identifier);
    }
  }

  return next;
}

/**
 * Group a spec's requirements and scenarios into requirement blocks by provenance order.
 *
 * Each scenario is assigned to the closest preceding requirement by line number
 * via binary search. Scenarios that appear before any requirement are returned as
 * standalone (orphaned) scenarios.
 *
 * @param spec - parsed spec whose requirements and scenarios are to be grouped
 * @returns blocks (requirement + owned scenarios) and standalone scenarios
 *
 * @remarks
 * Precondition: no two requirements in `spec.requirements` share the same
 * `provenance.line` value. The binary search relies on strict line ordering to
 * assign each scenario to exactly one parent requirement. TypeScript's
 * `Array.sort` is stable (ES2019+), so equal-line items would retain insertion
 * order, but the semantic correctness of parent assignment depends on unique
 * requirement lines.
 * Postcondition: every requirement appears in exactly one block. Every scenario
 * appears either in a block's `scenarios` array or in `standaloneScenarios`,
 * but never both.
 * Invariant: block order matches the sorted requirement line order.
 */
function groupBlocks(spec: ParsedSpec): {
  readonly blocks: readonly RequirementBlock[];
  readonly standaloneScenarios: readonly ParsedScenario[];
} {
  const requirements = [...spec.requirements].sort((left, right) => left.provenance.line - right.provenance.line);
  const scenarios = [...spec.scenarios].sort((left, right) => left.provenance.line - right.provenance.line);

  const scenarioByRequirementIndex = new Map<number, ParsedScenario[]>();
  const standaloneScenarios: ParsedScenario[] = [];

  for (const scenario of scenarios) {
    // Binary search: find the last requirement with line < scenario line.
    let lo = 0;
    let hi = requirements.length - 1;
    let parentIndex = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (requirements[mid]!.provenance.line < scenario.provenance.line) {
        parentIndex = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (parentIndex < 0) {
      standaloneScenarios.push(scenario);
      continue;
    }
    const existing = scenarioByRequirementIndex.get(parentIndex);
    if (existing === undefined) {
      scenarioByRequirementIndex.set(parentIndex, [scenario]);
    } else {
      existing.push(scenario);
    }
  }

  const blocks: RequirementBlock[] = requirements.map((requirement, index) => ({
    requirement,
    scenarios: scenarioByRequirementIndex.get(index) ?? [],
  }));

  return { blocks, standaloneScenarios };
}

function makeFinding(
  severity: "error" | "warning",
  category: string,
  file: string,
  description: string,
): Finding {
  return {
    severity,
    category,
    provenance: { file },
    description,
    rationale: "Merge semantics surface malformed or conflicting delta content without silently changing active capability behavior.",
    evidence: [{ kind: "merge", value: description }],
  };
}
