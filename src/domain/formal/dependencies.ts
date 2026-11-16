/** Conservative constraint-dependency components for bounded co-activation selection. */
import type { LogicExpression, StaticRule } from "./expression-types.js";

/** Collect resolved concept/function references without regex or literal token matching. */
export function expressionReferences(expressions: readonly LogicExpression[]): ReadonlySet<string> {
  const names = new Set<string>();
  const pending = [...expressions];
  while (pending.length > 0) {
    const node = pending.pop()!;
    if (node.kind === "symbol" || node.kind === "apply") names.add(node.name);
    if (node.kind === "operator" || node.kind === "apply") pending.push(...node.args);
  }
  return names;
}

/**
 * Account for links through third-party constraints/background. Direct symbol
 * intersection alone is unsound for full-set conflicts (x, y, not(x and y)).
 */
export function dependencyOverlap(rules: readonly StaticRule[], background: readonly LogicExpression[]): (left: StaticRule, right: StaticRule) => boolean {
  const parents = new Map<string, string>();
  const sizes = new Map<string, number>();
  const root = (name: string): string => {
    let value = name;
    while (parents.get(value) !== undefined && parents.get(value) !== value) value = parents.get(value)!;
    let current = name;
    while (parents.get(current) !== undefined && parents.get(current) !== value) {
      const next = parents.get(current)!; parents.set(current, value); current = next;
    }
    return value;
  };
  const constraints = [...background.map((value) => [value]), ...rules.map((rule) => [rule.guard, rule.response])];
  for (const constraint of constraints) {
    const names = [...expressionReferences(constraint)];
    for (const name of names) if (!parents.has(name)) { parents.set(name, name); sizes.set(name, 1); }
    for (const name of names.slice(1)) {
      let left = root(name); let right = root(names[0]!);
      if (left === right) continue;
      if (sizes.get(left)! > sizes.get(right)!) [left, right] = [right, left];
      parents.set(left, right); sizes.set(right, sizes.get(left)! + sizes.get(right)!);
    }
  }
  const components = new Map(rules.map((rule) => [rule, new Set([...expressionReferences([rule.guard, rule.response])].map(root))]));
  return (left, right) => {
    const a = components.get(left)!; const b = components.get(right)!;
    const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
    for (const name of smaller) if (larger.has(name)) return true;
    return false;
  };
}
