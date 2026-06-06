/**
 * One-time script to backfill allocation columns for existing successful contributions.
 *
 * Run: bun run scripts/backfillAllocations.ts
 *
 * This iterates all payment_status = 'success' contributions where allocation
 * fields are NULL and populates shares, social, savings, deposit.
 */

import { supabase } from "@/lib/supabase";
import { allocateContribution } from "@/services/contributionAllocation";

async function backfillAllocations() {
  console.log("Fetching contributions needing backfill...");

  const { data: contributions, error } = await supabase
    .from("contributions")
    .select("id, amount")
    .eq("payment_status", "success")
    .is("shares", null);

  if (error) {
    console.error("Failed to fetch contributions:", error.message);
    process.exit(1);
  }

  if (!contributions?.length) {
    console.log("No contributions need backfill.");
    return;
  }

  console.log(`Found ${contributions.length} contributions to backfill.`);

  let updated = 0;
  let failed = 0;

  for (const c of contributions) {
    const amountNaira = Number(c.amount) / 100;
    const allocation = allocateContribution(amountNaira);

    const { error: updateError } = await supabase
      .from("contributions")
      .update({
        shares: allocation.shares,
        social: allocation.social,
        savings: allocation.savings,
        deposit: allocation.deposit,
        updated_at: new Date().toISOString(),
      })
      .eq("id", c.id);

    if (updateError) {
      console.error(`Failed to update contribution ${c.id}:`, updateError.message);
      failed++;
    } else {
      updated++;
    }
  }

  console.log(`Backfill complete: ${updated} updated, ${failed} failed.`);
}

backfillAllocations().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
