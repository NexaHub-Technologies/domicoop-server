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

export function allocateContribution(amount: number): ContributionAllocation {
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
