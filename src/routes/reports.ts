import Elysia, { t }    from 'elysia'
import { authenticate } from '../middleware/authenticate'
import { requireAdmin } from '../middleware/requireAdmin'
import { supabase }     from '../lib/supabase'

export const reportRoutes = new Elysia({ prefix: '/reports' })
  .use(authenticate)
  .use(requireAdmin)

  // GET /reports/summary?year=2026 — financial summary
  .get('/summary',
    async ({ query }) => {
      const year = query.year ?? new Date().getFullYear()

      const [
        contributionsResult,
        loansResult,
        membersResult,
        transactionsResult,
        dividendsResult,
      ] = await Promise.all([
        // Total contributions
        supabase.from('contributions')
          .select('amount, payment_status')
          .eq('year', year),

        // Loans summary
        supabase.from('loans')
          .select('amount_requested, amount_approved, balance, status'),

        // Member stats
        supabase.from('profiles')
          .select('status', { count: 'exact' }),

        // Transactions summary
        supabase.from('transactions')
          .select('amount, type, status'),

        // Dividends
        supabase.from('dividends')
          .select('amount, status, year')
          .eq('year', year),
      ])

      const contributions = contributionsResult.data ?? []
      const verifiedContributions = contributions.filter(c => c.payment_status === 'success')
      const totalContributions = verifiedContributions.reduce((s, c) => s + Number(c.amount), 0)

      const loans = loansResult.data ?? []
      const totalLoanRequests = loans.reduce((s, l) => s + Number(l.amount_requested), 0)
      const totalLoanApproved = loans.reduce((s, l) => s + Number(l.amount_approved ?? 0), 0)
      const totalLoanOutstanding = loans.reduce((s, l) => s + Number(l.balance), 0)

      const transactions = transactionsResult.data ?? []
      const totalRevenue = transactions
        .filter(t => t.status === 'success' && ['contribution', 'loan_repayment'].includes(t.type))
        .reduce((s, t) => s + Number(t.amount), 0)

      const dividends = dividendsResult.data ?? []
      const totalDividendsPaid = dividends
        .filter(d => d.status === 'success')
        .reduce((s, d) => s + Number(d.amount), 0)

      return {
        year,
        summary: {
          total_members: membersResult.count ?? 0,
          active_members: (membersResult.data ?? []).filter(m => m.status === 'active').length,
          pending_members: (membersResult.data ?? []).filter(m => m.status === 'pending').length,
        },
        contributions: {
          total: totalContributions,
          count: verifiedContributions.length,
          pending: contributions.filter(c => c.payment_status === 'pending').length,
        },
        loans: {
          total_requested: totalLoanRequests,
          total_approved: totalLoanApproved,
          total_outstanding: totalLoanOutstanding,
          count: loans.length,
          active: loans.filter(l => ['disbursed', 'repaying'].includes(l.status)).length,
        },
        transactions: {
          total_revenue: totalRevenue,
          count: transactions.filter(t => t.status === 'success').length,
        },
        dividends: {
          total_paid: totalDividendsPaid,
          count: dividends.filter(d => d.status === 'success').length,
        },
      }
    },
    { query: t.Partial(t.Object({ year: t.Numeric() })) }
  );

