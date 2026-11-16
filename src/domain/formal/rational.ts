/** Exact bounded rational arithmetic used only for constants and authored scales. */
import { err, ok, type Result } from "../result.js";
import type { Rational } from "./expression-types.js";

/** Bound protects bigint parsing/arithmetic independently of total expression size. */
export const NUMERAL_DIGITS_MAX = 4_096;

/** Normalize a rational without floating-point arithmetic; zero divisors reject. */
export function rational(numerator: string, denominator = "1"): Result<Rational, string> {
  if (!/^-?\d+$/u.test(numerator) || !/^-?\d+$/u.test(denominator)
    || numerator.length > NUMERAL_DIGITS_MAX || denominator.length > NUMERAL_DIGITS_MAX) return err("Invalid or oversized exact numeral");
  let n = BigInt(numerator);
  let d = BigInt(denominator);
  if (d === 0n) return err("Zero rational denominator");
  if (d < 0n) { n = -n; d = -d; }
  let a = n < 0n ? -n : n;
  let b = d;
  // Euclid strictly decreases the nonnegative remainder; digit bound limits work.
  for (let iterations = 0; b !== 0n && iterations < NUMERAL_DIGITS_MAX * 8; iterations += 1) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  if (b !== 0n) return err("Rational normalization bound exceeded");
  const gcd = a === 0n ? 1n : a;
  return ok(Object.freeze({ numerator: String(n / gcd), denominator: String(d / gcd) }));
}

/** Decode an SMT-style integer/decimal atom, retaining its explicit numeric sort. */
export function numericAtom(text: string): Result<{ value: Rational; sort: "Int" | "Real" }, string> {
  if (/^-?\d+$/u.test(text)) {
    const value = rational(text);
    return value.ok ? ok({ value: value.value, sort: "Int" }) : value;
  }
  const decimal = /^(-?)(\d+)\.(\d+)$/u.exec(text);
  if (decimal === null || text.length > NUMERAL_DIGITS_MAX) return err("Not a supported exact numeric literal");
  const value = rational(`${decimal[1]}${decimal[2]}${decimal[3]}`, "1" + "0".repeat(decimal[3]!.length));
  return value.ok ? ok({ value: value.value, sort: "Real" }) : value;
}

/** Exact authored scale ratio for explicit unit conversion, with bounded result. */
export function scaleRatio(from: Rational, to: Rational): Result<Rational, string> {
  const source = rational(from.numerator, from.denominator);
  const target = rational(to.numerator, to.denominator);
  if (!source.ok || !target.ok) return err("Invalid unit scale");
  if (BigInt(source.value.numerator) <= 0n || BigInt(target.value.numerator) <= 0n) return err("Unit scales must be positive");
  return rational(String(BigInt(source.value.numerator) * BigInt(target.value.denominator)), String(BigInt(source.value.denominator) * BigInt(target.value.numerator)));
}
