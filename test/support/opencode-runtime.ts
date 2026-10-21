/** Explicit v1 injection for historical adapter-response fixtures. */
import { callOpencode as invoke, type OpencodeCallOptions } from "../../src/adapters/opencode.js";

/** Preserve historical response mocks without adding an unrelated probe call.
 * @param options - Test invocation options, including an optional selected binary.
 * @returns Actual adapter result with a matching explicit v1 runtime.
 * @remarks Production detection and scope behavior are tested separately.
 */
export async function callOpencode(options: OpencodeCallOptions): ReturnType<typeof invoke> {
  return await invoke({ ...options, runtime: options.runtime ?? {
    binaryPath: options.binaryPath ?? "opencode", version: "1.19.3", major: 1,
  } });
}
