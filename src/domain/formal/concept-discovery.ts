/** Bounded discovery orchestration with injected effects and a source-order freeze barrier. */
import type { Claim } from "../claim-graph.js";
import { err, type Result } from "../result.js";
import { DEFAULT_ANALYSIS, isRecord, type AnalysisConfig } from "./analysis-config.js";
import { contentHash, decodeAuthoredModel, freezeRegistry, type FrozenRegistry } from "./concepts.js";

/** Exact deterministic context supplied to one discovery model invocation. */
export interface DiscoveryRequest {
  readonly group: string;
  readonly side: FrozenRegistry["side"];
  readonly ordinal: number;
  readonly context: string;
  readonly sources: readonly { readonly file: string; readonly ordinal: number }[];
}

/** Effect boundary can preserve raw requests/responses before returning parsed data. */
export interface DiscoveryResponse { readonly payload: unknown; readonly warnings: readonly string[] }
export type DiscoveryInvoker = (request: DiscoveryRequest) => Promise<Result<DiscoveryResponse, string>>;

/** Attempt outcome retained even when a chunk fails; completion does not imply coverage. */
export interface DiscoveryAttempt {
  readonly request: DiscoveryRequest;
  readonly response: Result<DiscoveryResponse, string>;
}

/** Complete pass output, including partial discovery and authored-model failures. */
export interface DiscoveryOutput {
  readonly registry: FrozenRegistry;
  readonly attempts: readonly DiscoveryAttempt[];
  readonly issues: readonly string[];
  readonly authoredModelValid: boolean;
}

/** Discover once per semantic group; chunks finish before the immutable registry exists. */
export async function discoverGroup(input: {
  readonly group: string; readonly side: FrozenRegistry["side"]; readonly claims: readonly Claim[];
  readonly invoke: DiscoveryInvoker; readonly analysis?: AnalysisConfig; readonly configSource?: string;
}): Promise<DiscoveryOutput> {
  const analysis = input.analysis ?? DEFAULT_ANALYSIS;
  const modelMap = input.side === "specs_forward" ? analysis.models : analysis.generatedModels;
  const capability = input.claims.find((claim) => claim.capability !== undefined)?.capability;
  const modelKey = Object.hasOwn(modelMap, input.group) ? input.group : capability ?? input.group;
  const rawModel = Object.hasOwn(modelMap, modelKey) ? modelMap[modelKey] : undefined;
  const decoded = decodeAuthoredModel(rawModel, analysis.limits);
  const authored = decoded.ok ? decoded.value : { concepts: [], enums: [], units: [], background: [], coverage: [] };
  const issues: string[] = decoded.ok ? [] : [`Invalid authored model: ${decoded.error}`];
  const requests: DiscoveryRequest[] = [];
  if (decoded.ok) {
    const pack = new DiscoveryContext(input.group, input.side, authored);
    const records = input.claims.map((claim, index) => pack.record(claim, index));
    if (pack.bytes(records) > analysis.limits.discoveryContextBytes) issues.push("Discovery group context byte bound exceeded");
    else {
      let chunk: DiscoveryRecord[] = [];
      let bytes = pack.nonemptyBytes;
      for (let index = 0; index < input.claims.length; index += 1) {
        const claim = input.claims[index]!;
        let record = claim.surface === undefined && index !== chunk.length ? pack.record(claim, chunk.length) : records[index]!;
        if (bytes + record.bytes + (chunk.length > 0 ? 2 : 0) > analysis.limits.discoveryChunkBytes) {
          if (chunk.length > 0) requests.push(pack.request(chunk, requests.length));
          chunk = []; bytes = pack.nonemptyBytes;
          if (claim.surface === undefined) record = pack.record(claim, 0);
          if (bytes + record.bytes > analysis.limits.discoveryChunkBytes) { issues.push(`Discovery statement cannot fit chunk: ${claim.id ?? claim.provenance.file}`); continue; }
        }
        bytes += record.bytes + (chunk.length > 0 ? 2 : 0); chunk.push(record);
      }
      if (chunk.length > 0) requests.push(pack.request(chunk, requests.length));
    }
  }
  if (requests.length > analysis.limits.discoveryChunks) issues.push("Discovery chunk-count bound exceeded");
  const attempts: DiscoveryAttempt[] = [];
  const candidates: unknown[] = [];
  const assumptions: unknown[] = [];
  for (const item of requests.slice(0, analysis.limits.discoveryChunks)) {
    // Effect failures such as required evidence persistence propagate. Expected
    // model/transport failures are Result errors and remain localized evidence.
    const response = await input.invoke(item);
    attempts.push(Object.freeze({ request: item, response }));
    if (!response.ok) { issues.push(response.error); continue; }
    issues.push(...response.value.warnings);
    const payload = response.value.payload;
    if (!isRecord(payload) || !Array.isArray(payload.concepts)) { issues.push("Discovery response requires concepts array"); continue; }
    if (payload.concepts.length > analysis.limits.concepts || Buffer.byteLength(JSON.stringify(payload), "utf8") > analysis.limits.decodedBytes) { issues.push("Discovery response exceeds decoded/concept bounds"); continue; }
    candidates.push(...payload.concepts);
    if (Array.isArray(payload.proposedAssumptions)) assumptions.push(...payload.proposedAssumptions);
  }
  const registry = freezeRegistry(input.group, input.side, input.claims, authored, candidates, assumptions, analysis.limits, input.configSource, modelKey);
  const result = issues.length === 0 ? registry : Object.freeze({ ...registry, issues: Object.freeze([...registry.issues, ...issues].sort()), hash: contentHash([registry.hash, issues]) });
  return Object.freeze({ registry: result, attempts: Object.freeze(attempts), issues: Object.freeze(issues), authoredModelValid: decoded.ok });
}

/** Serialize only selected clause/field text, never large duplicated position maps. */
interface DiscoveryRecord { readonly source: DiscoveryRequest["sources"][number]; readonly text: string; readonly bytes: number }

/** Exact JSON.stringify indentation/framing, with linear record serialization and sizing. */
class DiscoveryContext {
  private readonly empty: string;
  private readonly prefix: string;
  private readonly suffix = "\n  ]\n}\n";
  readonly nonemptyBytes: number;
  constructor(private readonly group: string, private readonly side: FrozenRegistry["side"], authored: unknown) {
    this.empty = JSON.stringify({ schemaVersion: 1, group, side, authored, claims: [] }, null, 2) + "\n";
    this.prefix = this.empty.slice(0, -'  "claims": []\n}\n'.length) + '  "claims": [\n';
    this.nonemptyBytes = Buffer.byteLength(this.prefix, "utf8") + Buffer.byteLength(this.suffix, "utf8");
  }
  record(claim: Claim, index: number): DiscoveryRecord {
    const source = claim.surface?.source ?? { file: claim.provenance.file, ordinal: index };
    const value = { source, kind: claim.surface?.scenarioKind ?? "refinement",
      clauses: Object.fromEntries(Object.entries(claim.surface?.clauses ?? {}).filter(([, slot]) => isRecord(slot) && typeof slot.text === "string").map(([key, slot]) => [key, (slot as { text: string }).text])),
      fields: Object.fromEntries(Object.entries(claim.surface?.fields ?? {}).map(([key, field]) => [key, field?.text])), text: claim.text };
    const text = JSON.stringify(value, null, 2).split("\n").map((line) => `    ${line}`).join("\n");
    return { source, text, bytes: Buffer.byteLength(text, "utf8") };
  }
  bytes(records: readonly DiscoveryRecord[]): number {
    return records.length === 0 ? Buffer.byteLength(this.empty, "utf8") : this.nonemptyBytes + records.reduce((sum, record) => sum + record.bytes, 0) + 2 * (records.length - 1);
  }
  request(records: readonly DiscoveryRecord[], ordinal: number): DiscoveryRequest {
    return Object.freeze({ group: this.group, side: this.side, ordinal,
      context: records.length === 0 ? this.empty : this.prefix + records.map((record) => record.text).join(",\n") + this.suffix,
      sources: Object.freeze(records.map((record) => record.source)) });
  }
}

/** No-op transport for callers explicitly choosing authored-only interpretation. */
export const unavailableDiscovery: DiscoveryInvoker = async () => err("Concept discovery transport unavailable");
