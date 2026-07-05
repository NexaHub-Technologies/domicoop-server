export interface ContributionAllocation {
  shares: number
  social: number
  savings: number
  deposit: number
}

const SHARES_FIXED = 4000
const SOCIAL_FIXED = 1000
const SAVINGS_CAP = 46000
const CEILING = 51000

/**
 * Minimum monthly contribution in Naira. Below this the fixed Shares (₦4,000)
 * and Social (₦1,000) fees would leave less than the ₦1,000 Savings floor
 * (negative for amounts under ₦5,000). See mds/allocation.md.
 */
export const MIN_CONTRIBUTION = 6000

export function allocateContribution(amount: number): ContributionAllocation {
  if (!Number.isFinite(amount) || amount < MIN_CONTRIBUTION) {
    throw new Error(
      `Contribution amount must be at least ₦${MIN_CONTRIBUTION.toLocaleString()}`,
    )
  }

  const shares = SHARES_FIXED
  const social = SOCIAL_FIXED

  if (amount <= CEILING) {
    return {
      shares,
      social,
      savings: amount - SHARES_FIXED - SOCIAL_FIXED,
      deposit: 0,
    }
  }

  return {
    shares,
    social,
    savings: SAVINGS_CAP,
    deposit: amount - CEILING,
  }
}
