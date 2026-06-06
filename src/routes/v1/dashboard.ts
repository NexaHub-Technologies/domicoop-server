import Elysia from "elysia";
import { authenticate } from "@/middleware/authenticate";
import { supabase } from "@/lib/supabase";

export const dashboardRoutes = new Elysia({ prefix: "/dashboard" })
  .use(authenticate)

  // (tabs)/index.tsx → GET /dashboard/summary
  // Returns all card data needed to render the home dashboard in a single request
  .get("/summary", async ({ userId }) => {
    const currentYear = new Date().getFullYear();
    const currentMonth = `${currentYear}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;

    const [profile, contributions, activeLoan, recentTxns, announcements] =
      await Promise.all([
        supabase
          .from("profiles")
          .select("full_name, member_no, status, avatar_url")
          .eq("id", userId!)
          .single(),

        supabase
          .from("contributions")
          .select("amount, shares, social, savings, deposit, month")
          .eq("member_id", userId!)
          .eq("year", currentYear)
          .eq("payment_status", "success"),

        supabase
          .from("loans")
          .select("id, amount_approved, balance, monthly_repayment, status, due_date")
          .eq("member_id", userId!)
          .in("status", ["disbursed", "repaying"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle(),

        supabase
          .from("transactions")
          .select("id, amount, type, status, created_at, description")
          .eq("member_id", userId!)
          .eq("status", "success")
          .order("created_at", { ascending: false })
          .limit(5),

        supabase
          .from("announcements")
          .select("id, title, body, created_at")
          .eq("published", true)
          .order("created_at", { ascending: false })
          .limit(3),
      ]);

    const totalContributions =
      contributions.data?.reduce((s, c) => s + Number(c.amount), 0) ?? 0;
    const totalSavings =
      contributions.data?.reduce((s, c) => s + Number(c.savings ?? 0), 0) ?? 0;
    const totalShares =
      contributions.data?.reduce((s, c) => s + Number(c.shares ?? 0), 0) ?? 0;
    const totalSocial =
      contributions.data?.reduce((s, c) => s + Number(c.social ?? 0), 0) ?? 0;
    const totalDeposit =
      contributions.data?.reduce((s, c) => s + Number(c.deposit ?? 0), 0) ?? 0;
    const paidThisMonth =
      contributions.data?.some((c) => c.month === currentMonth) ?? false;

    return {
      member: profile.data,
      total_contributions: totalContributions,
      total_savings: totalSavings,
      total_shares: totalShares,
      total_social: totalSocial,
      total_deposit: totalDeposit,
      paid_this_month: paidThisMonth,
      current_month: currentMonth,
      active_loan: activeLoan.data,
      recent_transactions: recentTxns.data,
      announcements: announcements.data,
    };
  });
