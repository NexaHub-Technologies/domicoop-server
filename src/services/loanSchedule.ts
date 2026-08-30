import { MIN_TENURE_MONTHS, MAX_TENURE_MONTHS } from "@/services/loanTerms";

/**
 * Months between disbursement and the first installment.
 *
 * The cooperative lends on one month of grace: the bond says the principal is
 * repaid "within ELEVEN Month in equal installments", and Part A of the
 * application has exactly eleven month/amount rows — on a twelve-month term.
 * Twelve months of tenure is therefore one month of grace plus eleven payments,
 * not twelve payments.
 */
export const GRACE_MONTHS = 1;

/** How many payments a term actually produces. */
export function installmentCount(tenureMonths: number): number {
  return tenureMonths - GRACE_MONTHS;
}

export interface ScheduleRow {
  installment_no: number;
  due_on: string; // YYYY-MM-DD
  amount: number; // whole Naira, 2dp
}

export interface LoanSchedule {
  /** principal × (1 + rate/100). Interest is FLAT, not amortised. */
  total_repayable: number;
  /** The even installment — every row but the last carries exactly this. */
  monthly_repayment: number;
  first_installment_on: string;
  /** Final due date, for `loans.due_date`. */
  final_installment_on: string;
  rows: ScheduleRow[];
}

/** Add whole months to a date, clamping to the end of a short month. */
function addMonths(date: Date, months: number): Date {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const targetDay = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  // A loan disbursed on the 31st must not skip February into March.
  const lastDayOfTarget = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0),
  ).getUTCDate();
  d.setUTCDate(Math.min(targetDay, lastDayOfTarget));
  return d;
}

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Build the repayment schedule a borrower signs on Part A item 8.
 *
 * Interest is flat: the member repays `principal × (1 + rate/100)`, split
 * evenly across the installments. It is NOT amortised — do not "fix" this into
 * a reducing-balance formula without the cooperative's say-so.
 *
 * The last row absorbs the rounding remainder. Without that, eleven rows of a
 * rounded-down installment sum to less than the total, and the loan's balance
 * can never reach zero — so it never reaches `closed`, and the bond is never
 * cancelled.
 */
export function buildSchedule(input: {
  principal: number;
  rate: number;
  tenureMonths: number;
  /** Disbursement date; the clock for the grace period. Defaults to today. */
  startDate?: Date;
}): LoanSchedule {
  const { principal, rate, tenureMonths, startDate = new Date() } = input;

  if (!Number.isFinite(principal) || principal <= 0) {
    throw new Error("Loan principal must be a positive amount");
  }
  if (!Number.isFinite(rate) || rate < 0) {
    throw new Error("Interest rate must be zero or greater");
  }
  if (
    !Number.isInteger(tenureMonths) ||
    tenureMonths < MIN_TENURE_MONTHS ||
    tenureMonths > MAX_TENURE_MONTHS
  ) {
    throw new Error(
      `Tenure must be a whole number of months between ${MIN_TENURE_MONTHS} and ${MAX_TENURE_MONTHS}`,
    );
  }

  const count = installmentCount(tenureMonths);
  if (count < 1) {
    // A one-month term is all grace and no payments. Rejected here rather than
    // producing an empty schedule that would look like a settled loan.
    throw new Error(
      `A ${tenureMonths}-month term leaves no installments after ${GRACE_MONTHS} month(s) of grace`,
    );
  }

  const total = round2(principal * (1 + rate / 100));
  const even = round2(Math.floor((total / count) * 100) / 100);

  const rows: ScheduleRow[] = [];
  let allocated = 0;
  for (let i = 1; i <= count; i++) {
    const isLast = i === count;
    const amount = isLast ? round2(total - allocated) : even;
    allocated = round2(allocated + amount);
    rows.push({
      installment_no: i,
      due_on: isoDate(addMonths(startDate, GRACE_MONTHS + i - 1)),
      amount,
    });
  }

  return {
    total_repayable: total,
    monthly_repayment: even,
    first_installment_on: rows[0]!.due_on,
    final_installment_on: rows[rows.length - 1]!.due_on,
    rows,
  };
}
