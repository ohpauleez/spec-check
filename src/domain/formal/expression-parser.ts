/** Bounded single S-expression parser; literals are lexed before symbol handling. */
import { err, ok, type Result } from "../result.js";
import { EXPRESSION_LIMITS, type ExpressionIssue, type ExpressionLimits } from "./expression-types.js";

/** Untrusted syntax nodes, never accepted without signature/type/fragment validation. */
export type ExpressionSyntax =
  | { readonly kind: "atom"; readonly text: string; readonly offset: number }
  | { readonly kind: "quoted-symbol"; readonly text: string; readonly offset: number }
  | { readonly kind: "string"; readonly text: string; readonly offset: number }
  | { readonly kind: "list"; readonly items: readonly ExpressionSyntax[]; readonly offset: number };

/** Local parser frame bounded by the effective depth limit. */
interface Frame { readonly offset: number; readonly items: ExpressionSyntax[] }

/** Parse exactly one complete expression with explicit byte/node/depth limits.
 * @returns Frozen untrusted syntax, or a syntax/limit issue with an offset where available.
 * @remarks Limits must be positive safe integers; invalid controls are also Result errors.
 * Parsing does not establish type/fragment validity or execute commands. No I/O/input mutation;
 * stack depth and node count are bounded before growth. No expected exceptions.
 * @example parseExpressionSyntax("(and Enabled true)");
 */
export function parseExpressionSyntax(text: string, limits: ExpressionLimits = EXPRESSION_LIMITS): Result<ExpressionSyntax, ExpressionIssue> {
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value < 1)) return err({ code: "expression-limit", message: "Expression bounds must be positive safe integers" });
  if (Buffer.byteLength(text, "utf8") > limits.bytes) return err({ code: "expression-limit", message: "Expression byte limit exceeded" });
  const frames: Frame[] = [{ offset: 0, items: [] }];
  // The root frame is never removed; array indexes below are length-checked or loop-bounded.
  let nodes = 0;
  for (let offset = 0; offset < text.length;) {
    const char = text[offset]!;
    if (/\s/u.test(char)) { offset += 1; continue; }
    if (char === ";") { const next = text.indexOf("\n", offset); offset = next < 0 ? text.length : next; continue; }
    if (char === "(") {
      if (++nodes > limits.nodes || frames.length > limits.depth) return err({ code: "expression-limit", message: "Expression node/depth limit exceeded", offset });
      frames.push({ offset: offset++, items: [] });
      continue;
    }
    if (char === ")") {
      if (frames.length === 1) return err({ code: "expression-syntax", message: "Unexpected closing parenthesis", offset });
      const frame = frames.pop()!; // A closing delimiter is accepted only with a non-root frame.
      if (frame.items.length === 0) return err({ code: "expression-syntax", message: "Empty application", offset: frame.offset });
      frames[frames.length - 1]!.items.push(Object.freeze({ kind: "list", items: Object.freeze(frame.items), offset: frame.offset }));
      offset += 1;
      continue;
    }
    const token = readToken(text, offset);
    if (!token.ok) return token;
    if (++nodes > limits.nodes) return err({ code: "expression-limit", message: "Expression node limit exceeded", offset });
    frames[frames.length - 1]!.items.push(token.value.node);
    offset = token.value.end;
  }
  if (frames.length !== 1) return err({ code: "expression-syntax", message: "Unclosed application", offset: frames[frames.length - 1]!.offset });
  const roots = frames[0]!.items;
  if (roots.length !== 1) return err({ code: "expression-syntax", message: "Expected exactly one complete expression" });
  return ok(roots[0]!); // Exactly one root was established immediately above.
}

/** Read atoms, quoted symbols, and SMT-LIB strings with doubled-quote escaping. */
function readToken(text: string, offset: number): Result<{ node: ExpressionSyntax; end: number }, ExpressionIssue> {
  const start = offset;
  const delimiter = text[offset];
  if (delimiter === "\"" || delimiter === "|") {
    offset += 1;
    let value = "";
    for (; offset < text.length; offset += 1) {
      if (text[offset] === delimiter) {
        if (delimiter === "\"" && text[offset + 1] === "\"") { value += "\""; offset += 1; continue; }
        return ok({ node: Object.freeze({ kind: delimiter === "\"" ? "string" : "quoted-symbol", text: value, offset: start }), end: offset + 1 });
      }
      value += text[offset];
    }
    return err({ code: "expression-syntax", message: "Unclosed quoted token", offset: start });
  }
  while (offset < text.length && !/[\s();]/u.test(text[offset]!)) offset += 1;
  if (offset === start) return err({ code: "expression-syntax", message: "Invalid expression token", offset });
  return ok({ node: Object.freeze({ kind: "atom", text: text.slice(start, offset), offset: start }), end: offset });
}
