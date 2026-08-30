/**
 * Loan term bounds — the server's single source of truth.
 *
 * These used to be written out at each call site, which let them drift: the
 * apply schema said 1–36, `/process` bounded nothing at all, and the app
 * offered 1–12. An admin could approve a tenure no member could have asked
 * for, and a member's application could be accepted at a length the
 * cooperative no longer lends over.
 *
 * The cooperative's rule: one month of grace after disbursement, repaid within
 * one year. Mirrored client-side in domicoop-mobile `constants/loans.ts`
 * (`loanConfig`) and domicoop-admin `lib/types/loans.ts` — change all three
 * together, and see docs/loan-terms.md.
 */
export const MIN_TENURE_MONTHS = 1;
export const MAX_TENURE_MONTHS = 12;

// The default interest rate is deliberately NOT here. The server falls back to
// 5% while the app's loanConfig advertises 10%, and reconciling those two is a
// pricing decision, not a bounds one.

export function isTenureInRange(months: number): boolean {
  return (
    Number.isInteger(months) && months >= MIN_TENURE_MONTHS && months <= MAX_TENURE_MONTHS
  );
}
