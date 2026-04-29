import Elysia from "elysia";
import { paystack, type PaystackBank } from "@/lib/paystack";

interface BankCache {
  data: PaystackBank[];
  timestamp: number;
}

let bankCache: BankCache | null = null;
const CACHE_TTL = 1000 * 60 * 60;

async function getCachedBanks(): Promise<PaystackBank[]> {
  const now = Date.now();
  if (bankCache && now - bankCache.timestamp < CACHE_TTL && bankCache.data.length > 0) {
    return bankCache.data;
  }

  const result = await paystack.listBanks({ perPage: 100 });
  console.log("Raw result type:", Array.isArray(result));

  // Handle both array and { data: [] } responses
  const banks = Array.isArray(result) ? result : result?.data;
  if (!banks) return [];

  const activeBanks = banks.filter((bank) => bank.active && !bank.is_deleted);
  bankCache = { data: activeBanks, timestamp: now };
  return activeBanks;
}

export const bankRoutes = new Elysia({ prefix: "/banks" }).get("/", async () => {
  const banks = await getCachedBanks();

  return {
    data: banks.map((bank) => ({
      id: bank.id,
      name: bank.name,
      code: bank.code,
      slug: bank.slug,
      type: bank.type,
      country: bank.country,
      currency: bank.currency,
      active: bank.active,
      pay_with_bank_transfer: bank.pay_with_bank_transfer,
    })),
  };
});
