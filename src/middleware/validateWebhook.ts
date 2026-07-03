import crypto from "crypto";

/**
 * Verify a Paystack webhook signature (HMAC-SHA512 of the raw request body).
 *
 * Paystack signs webhooks with the account's secret key; set
 * PAYSTACK_WEBHOOK_SECRET to the same value as PAYSTACK_SECRET_KEY.
 *
 * NOTE: this used to be an Elysia .derive() plugin, but local-scoped derives
 * don't propagate to consuming routes, so validation silently never ran.
 * Routes now call this directly with the raw body (via a custom parse).
 */
export function verifyPaystackSignature(rawBody: string, signature: string): boolean {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
  if (!secret) {
    console.error("[Webhook] PAYSTACK_WEBHOOK_SECRET is not set; rejecting webhook");
    return false;
  }
  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest("hex");
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(signature, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
