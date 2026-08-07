export interface ContributionAllocation {
  shares: number;
  social: number;
  savings: number;
  deposit: number;
}

const SHARES_FIXED = 4000;
const SOCIAL_FIXED = 1000;
const SAVINGS_CAP = 46000;
const CEILING = 51000;

/**
 * Tier 0 / Tier 1 boundary: below this the member hasn't yet reached the
 * shares benchmark for the contribution, so the whole amount is credited to
 * Shares only (Tier 0). See docs/currency-contract.md.
 */
const TIER1_FLOOR = 6000;

/**
 * Minimum accepted contribution in Naira, per docs/currency-contract.md.
 */
export const MIN_CONTRIBUTION = 5000;

export function allocateContribution(amount: number): ContributionAllocation {
  if (!Number.isFinite(amount) || amount < MIN_CONTRIBUTION) {
    throw new Error(
      `Contribution amount must be at least ₦${MIN_CONTRIBUTION.toLocaleString()}`,
    );
  }

  // Tier 0 — least payment tier (₦5,000 ≤ T < ₦6,000): entire amount to Shares.
  if (amount < TIER1_FLOOR) {
    return { shares: amount, social: 0, savings: 0, deposit: 0 };
  }

  const shares = SHARES_FIXED;
  const social = SOCIAL_FIXED;

  // Tier 1 — standard subscription (₦6,000 ≤ T ≤ ₦51,000).
  if (amount <= CEILING) {
    return {
      shares,
      social,
      savings: amount - SHARES_FIXED - SOCIAL_FIXED,
      deposit: 0,
    };
  }

  // Tier 2 — overflow (T > ₦51,000).
  return {
    shares,
    social,
    savings: SAVINGS_CAP,
    deposit: amount - CEILING,
  };
}
