/**
 * Naira amounts spelled out, for Part A item 5 of the loan application
 * ("AMOUNT REQUESTED IN WORDS") and the body of the Loan Bond.
 *
 * Always derived server-side from the figure. The words and the figure appear
 * side by side on a signed instrument, so letting a client supply the words
 * would let the two disagree on a document someone is held to.
 *
 * British/Nigerian convention: "and" before a sub-hundred remainder
 * ("one hundred and five"), short scale (a billion is a thousand million).
 */

const ONES = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
  "nineteen",
];

const TENS = [
  "",
  "",
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
];

const SCALES: [number, string][] = [
  [1_000_000_000, "billion"],
  [1_000_000, "million"],
  [1_000, "thousand"],
];

/** 0–999 in words, without any scale word. */
function underThousand(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) {
    const tens = TENS[Math.floor(n / 10)]!;
    const rest = n % 10;
    return rest ? `${tens}-${ONES[rest]}` : tens;
  }
  const hundreds = `${ONES[Math.floor(n / 100)]} hundred`;
  const rest = n % 100;
  return rest ? `${hundreds} and ${underThousand(rest)}` : hundreds;
}

/** A non-negative integer in words. */
function integerToWords(n: number): string {
  if (n === 0) return "zero";

  const parts: string[] = [];
  let remaining = n;

  for (const [value, name] of SCALES) {
    if (remaining >= value) {
      parts.push(`${underThousand(Math.floor(remaining / value))} ${name}`);
      remaining %= value;
    }
  }

  if (remaining > 0) {
    // "and" joins the final sub-hundred remainder to a larger figure:
    // "five hundred and fifty thousand and twenty", not "... thousand twenty".
    parts.push(
      parts.length && remaining < 100
        ? `and ${underThousand(remaining)}`
        : underThousand(remaining),
    );
  }

  return parts.join(" ");
}

/**
 * Format a Naira amount as it should read on the form, e.g.
 * `550000` → "Five hundred and fifty thousand naira only".
 *
 * Kobo are rendered when present ("... naira, fifty kobo only"); the
 * cooperative deals in whole Naira, so in practice this is the whole-Naira
 * branch.
 */
export function amountInWords(naira: number): string {
  if (!Number.isFinite(naira) || naira < 0) {
    throw new Error(`Cannot spell a non-finite or negative amount: ${naira}`);
  }

  const whole = Math.floor(naira);
  const kobo = Math.round((naira - whole) * 100);

  const nairaWords = `${integerToWords(whole)} naira`;
  const full = kobo > 0 ? `${nairaWords}, ${integerToWords(kobo)} kobo` : nairaWords;

  // Sentence case: the form line is read aloud and signed, not embedded in prose.
  return `${full.charAt(0).toUpperCase()}${full.slice(1)} only`;
}
