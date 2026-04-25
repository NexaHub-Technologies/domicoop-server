import Elysia, { t } from "elysia";
import { authenticate } from "../middleware/authenticate";
import { requireAdmin } from "../middleware/requireAdmin";
import { supabase } from "../lib/supabase";
import { paystack } from "../lib/paystack";
import { writeAuditLog } from "../utils/audit";

export const dividendRoutes = new Elysia({ prefix: "/dividends" })
  .use(authenticate)
  .use(requireAdmin)

  // GET /dividends — list all dividends
  .get(
    "/",
    async ({ query }) => {
      const year = query.year ?? new Date().getFullYear();
      const { data, error } = await supabase
        .from("dividends")
        .select("*, profiles(full_name, member_no)")
        .eq("year", year)
        .order("created_at", { ascending: false });
      if (error) throw new Error(error.message);
      return data;
    },
    { query: t.Partial(t.Object({ year: t.Numeric() })) },
  )

  // POST /dividends/preview — preview dividend distribution
  .post(
    "/preview",
    async ({ body }) => {
      const { data: activeMembers } = await supabase
        .from("profiles")
        .select("id, full_name, member_no")
        .eq("status", "active");

      if (!activeMembers?.length) throw new Error("No active members found");

      // Calculate total verified contributions for the year
      const { data: contributions } = await supabase
        .from("contributions")
        .select("member_id, amount")
        .eq("year", body.year)
        .eq("payment_status", "success");

      // Aggregate contributions per member
      const memberTotals: Record<string, number> = {};
      let grandTotal = 0;
      contributions?.forEach((c) => {
        const amt = Number(c.amount);
        memberTotals[c.member_id] = (memberTotals[c.member_id] ?? 0) + amt;
        grandTotal += amt;
      });

      // Calculate dividends
      const preview = activeMembers
        .map((m) => {
          const memberContrib = memberTotals[m.id] ?? 0;
          const shareRatio = grandTotal > 0 ? memberContrib / grandTotal : 0;
          const dividendAmount = parseFloat((body.total_amount * shareRatio).toFixed(2));
          return {
            member_id: m.id,
            full_name: m.full_name,
            member_no: m.member_no,
            contribution_amount: memberContrib,
            dividend_amount: dividendAmount,
          };
        })
        .filter((d) => d.dividend_amount > 0);

      return {
        year: body.year,
        total_amount: body.total_amount,
        total_members: preview.length,
        grand_total_contributions: grandTotal,
        preview,
      };
    },
    {
      body: t.Object({
        year: t.Number(),
        total_amount: t.Number({ minimum: 1 }),
      }),
    },
  )

  // POST /dividends/distribute — execute dividend distribution
  .post(
    "/distribute",
    async ({ body, userId }) => {
      const results = [];

      for (const dividend of body.dividends) {
        // Get member bank details
        const { data: member } = await supabase
          .from("profiles")
          .select("bank_name, bank_account, bank_code")
          .eq("id", dividend.member_id)
          .single();

        if (!member?.bank_account || !member?.bank_code) {
          results.push({
            member_id: dividend.member_id,
            status: "failed",
            error: "Missing bank details",
          });
          continue;
        }

        try {
          // Create transfer recipient
          const recipient = await paystack.createTransferRecipient({
            name: member.bank_name ?? "Member",
            account_number: member.bank_account,
            bank_code: member.bank_code,
          });

          // Initiate transfer
          const transfer = await paystack.initiateTransfer({
            amount: dividend.amount,
            recipient: recipient.recipient_code,
            reason: `Dividend for ${body.year}`,
          });

          // Record dividend
          await supabase.from("dividends").insert({
            member_id: dividend.member_id,
            amount: dividend.amount,
            year: body.year,
            paystack_transfer_ref: transfer.transfer_code,
            status: "processing",
          });

          results.push({
            member_id: dividend.member_id,
            status: "processing",
            transfer_code: transfer.transfer_code,
          });
        } catch (err) {
          results.push({
            member_id: dividend.member_id,
            status: "failed",
            error: (err as Error).message,
          });
        }
      }

      await writeAuditLog({
        actor_id: userId,
        action: "dividend_distribute",
        entity: "dividends",
        metadata: { year: body.year, count: body.dividends.length },
      });

      return { results };
    },
    {
      body: t.Object({
        year: t.Number(),
        dividends: t.Array(
          t.Object({
            member_id: t.String(),
            amount: t.Number({ minimum: 1 }),
          }),
        ),
      }),
    },
  );
