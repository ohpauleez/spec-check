/** Locate a standalone top-level solver verdict without matching strings/comments. */
export interface SolverVerdict {
  readonly kind: "sat" | "unsat" | "unknown";
  readonly end: number;
}

/** Multiple verdicts or malformed response framing are not one query result. */
export function locateSolverVerdict(stdout: string): SolverVerdict | undefined {
  let depth = 0;
  let quoted: "string" | "symbol" | undefined;
  let verdict: SolverVerdict | undefined;
  let offset = 0;
  for (const line of stdout.split(/(?<=\n)/u)) {
    const text = line.trim();
    if (depth === 0 && quoted === undefined && ["sat", "unsat", "unknown"].includes(text)) {
      if (verdict !== undefined) return undefined;
      verdict = { kind: text as SolverVerdict["kind"], end: offset + line.length };
    } else {
      for (let index = 0; index < line.length; index += 1) {
        const char = line[index];
        if (quoted === "string") {
          if (char === '"') {
            if (line[index + 1] === '"') index += 1;
            else quoted = undefined;
          }
        } else if (quoted === "symbol") { if (char === "|") quoted = undefined; }
        else if (char === ";") break;
        else if (char === '"') quoted = "string";
        else if (char === "|") quoted = "symbol";
        else if (char === "(") {
          if (depth === 0 && /^\(\s*error(?:\s|\))/u.test(line.slice(index))) return undefined;
          depth += 1;
        }
        else if (char === ")") { if (--depth < 0) return undefined; }
        else if (depth === 0 && !/\s/u.test(char ?? "")) return undefined;
      }
    }
    offset += line.length;
  }
  return depth === 0 && quoted === undefined ? verdict : undefined;
}
