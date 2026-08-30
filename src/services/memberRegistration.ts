import { supabase, supabaseAuth } from "@/lib/supabase";
import { paystack } from "@/lib/paystack";
import { NotificationService } from "@/services/notificationService";
import {
  assertRegistrationOpen,
  type RegistrationWindowRow,
} from "@/services/registrationWindow";
import { uploadSignature, signedDocumentUrl } from "@/services/signatures";

/**
 * The MEM form, as the wire sees it. Field names mirror the paper
 * "MEMBERSHIP REGISTRATION FORM" one-for-one so the two can be diffed by eye.
 */
export interface MembershipApplication {
  email: string;
  password: string;
  full_name: string;
  sex?: string;
  date_of_birth?: string;
  phone: string;
  whatsapp_number?: string;
  marital_status?: string;
  address: string;
  id_card_number?: string;
  next_of_kin?: string;
  place_of_work?: string;
  type_of_business?: string;
  bank_name: string;
  bank_account: string;
  bank_code: string;
  referred_by?: string;
  monthly_subscription?: number;
  avatar_url?: string;
  /** Base64-encoded PNG from the on-screen signature pad, with or without a data: prefix. */
  signature?: string;
  /** Paystack reference for the registration + social fee charge. */
  payment_reference: string;
}

export interface RegistrationResult {
  message: string;
  user_id: string;
  email: string;
  member_status: "pending";
}

/** A problem the applicant can act on. Carries the HTTP status the route should return. */
export class RegistrationError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "RegistrationError";
    this.status = status;
    this.code = code;
  }
}

/** Total payable in whole Naira for a window. Kept in one place — the client renders the same breakdown. */
export function registrationTotal(window: RegistrationWindowRow): number {
  return Number(window.registration_fee) + Number(window.social_fee);
}

/**
 * Confirm the applicant actually paid, independently of anything the client
 * told us.
 *
 * Two units meet here and it is the usual place to get it wrong: Paystack
 * reports `amount` in kobo, while the window's fees are whole Naira
 * (docs/currency-contract.md). Compare in kobo.
 */
async function verifyRegistrationPayment(
  reference: string,
  window: RegistrationWindowRow,
): Promise<{
  amountKobo: number;
  amountNaira: number;
  channel: string | null;
  paidAt: string;
}> {
  // Cheap pre-check for a clean 409. transactions.paystack_ref is UNIQUE, so
  // the insert further down is the real guard against a concurrent replay.
  const { data: existing } = await supabase
    .from("transactions")
    .select("id")
    .eq("paystack_ref", reference)
    .maybeSingle();

  if (existing) {
    throw new RegistrationError(
      409,
      "reference_already_used",
      "This payment reference has already been used for a registration.",
    );
  }

  let charge: Awaited<ReturnType<typeof paystack.verifyTransaction>>;
  try {
    charge = await paystack.verifyTransaction(reference);
  } catch (err) {
    throw new RegistrationError(
      402,
      "verification_failed",
      `We could not confirm that payment with Paystack. Reference: ${reference}`,
    );
  }

  if (charge.status !== "success") {
    throw new RegistrationError(
      402,
      "payment_not_successful",
      `That payment did not complete (${charge.gateway_response ?? charge.status}). Reference: ${reference}`,
    );
  }

  const expectedKobo = Math.round(registrationTotal(window) * 100);
  if (charge.amount !== expectedKobo) {
    throw new RegistrationError(
      422,
      "amount_mismatch",
      `The amount paid (₦${(charge.amount / 100).toLocaleString()}) does not match the registration fee of ₦${registrationTotal(window).toLocaleString()}. Reference: ${reference}`,
    );
  }

  return {
    amountKobo: charge.amount,
    amountNaira: charge.amount / 100,
    channel: charge.channel ?? null,
    paidAt: charge.paid_at ?? new Date().toISOString(),
  };
}

/**
 * Everything the server can check about an application BEFORE money moves.
 *
 * Why this exists: registerMember() takes payment first so that no unpaid
 * account can ever exist. The cost of that ordering is that a rejection after
 * checkout has already charged the applicant ₦21,000 — for something as
 * ordinary as an email they already used. This runs the same rejections
 * against an unpaid draft so the common ones surface before the charge.
 *
 * It does reveal whether an email is registered, which the rest of this API
 * deliberately avoids (see /auth/reset-password). The trade was made
 * knowingly: the endpoint is rate limited to 10/min per IP, and the
 * alternative is charging people for a form they cannot complete. It reports
 * nothing beyond "in use" — no name, status, or member number.
 */
export async function precheckApplication(input: {
  email: string;
  monthly_subscription?: number;
}): Promise<void> {
  const window = await assertRegistrationOpen();

  if (input.monthly_subscription !== undefined) {
    assertSubscriptionInRange(input.monthly_subscription, window);
  }

  const email = input.email.trim().toLowerCase();

  const [member, admin] = await Promise.all([
    supabase.from("profiles").select("id").ilike("email", email).maybeSingle(),
    supabase.from("admin_profiles").select("id").ilike("email", email).maybeSingle(),
  ]);

  if (member.data || admin.data) {
    throw new RegistrationError(
      409,
      "email_in_use",
      "An account already exists for that email address. Sign in instead, or use a different email.",
    );
  }
}

/** Shared by the precheck and the real registration so the two cannot drift apart. */
function assertSubscriptionInRange(subscription: number, window: RegistrationWindowRow): void {
  const min = Number(window.min_monthly_subscription);
  const max = Number(window.max_monthly_subscription);
  if (subscription < min || subscription > max) {
    throw new RegistrationError(
      422,
      "subscription_out_of_range",
      `Monthly subscription must be between ₦${min.toLocaleString()} and ₦${max.toLocaleString()}.`,
    );
  }
}

/**
 * Re-exported so existing callers (and the members route) keep one import for
 * "give me a viewable signature", regardless of which feature stored it.
 */
export const signedSignatureUrl = signedDocumentUrl;

/**
 * Turn a paid application into a pending member account.
 *
 * Order matters. Everything that can reject the applicant runs BEFORE the
 * account exists (window open, payment verified, reference unused), and
 * everything after `signUp` is best-effort: the money has already moved, so a
 * failed notification must never cost someone their membership. Failures past
 * that point are logged loudly for reconciliation instead.
 */
export async function registerMember(
  application: MembershipApplication,
): Promise<RegistrationResult> {
  const window = await assertRegistrationOpen();
  const payment = await verifyRegistrationPayment(application.payment_reference, window);

  if (application.monthly_subscription !== undefined) {
    assertSubscriptionInRange(application.monthly_subscription, window);
  }

  // handle_new_user() reads these off raw_user_meta_data and writes the
  // profiles row. It deliberately does NOT set the registration_* columns —
  // user metadata is client-supplied, and those columns are what say "paid".
  const { data, error } = await supabaseAuth.auth.signUp({
    email: application.email,
    password: application.password,
    options: {
      data: {
        full_name: application.full_name,
        phone: application.phone,
        address: application.address,
        bank_name: application.bank_name,
        bank_account: application.bank_account,
        bank_code: application.bank_code,
        avatar_url: application.avatar_url,
        next_of_kin: application.next_of_kin,
        sex: application.sex,
        date_of_birth: application.date_of_birth,
        whatsapp_number: application.whatsapp_number,
        marital_status: application.marital_status,
        id_card_number: application.id_card_number,
        place_of_work: application.place_of_work,
        type_of_business: application.type_of_business,
        referred_by: application.referred_by,
        monthly_subscription: application.monthly_subscription,
      },
    },
  });

  if (error || !data.user) {
    throw new RegistrationError(
      400,
      "signup_failed",
      error?.message ?? "Could not create the account.",
    );
  }

  const userId = data.user.id;

  const signaturePath = application.signature
    ? await uploadSignature(`signatures/${userId}.png`, application.signature)
    : null;

  // Service-role write: these columns are blocked for end users by
  // protect_profile_columns(). Stamping the window here is also what makes
  // count_registration_application() bump applications_count.
  const { error: stampError } = await supabase
    .from("profiles")
    .update({
      registration_window_id: window.id,
      registration_fee_paid: true,
      registration_ref: application.payment_reference,
      registration_paid_at: payment.paidAt,
      ...(signaturePath ? { signature_url: signaturePath } : {}),
    })
    .eq("id", userId);

  if (stampError) {
    console.error(
      `[Registration] PAID BUT UNSTAMPED — user ${userId}, ref ${application.payment_reference}: ${stampError.message}`,
    );
  }

  // Unique paystack_ref is the idempotency gate for a concurrent replay.
  const { error: txError } = await supabase.from("transactions").insert({
    paystack_ref: application.payment_reference,
    member_id: userId,
    // transactions.amount is kobo — it mirrors Paystack's raw ledger, unlike
    // contributions.amount which was normalised to Naira. See
    // 20260705075811_normalize_contributions_amount_to_naira.sql.
    amount: payment.amountKobo,
    type: "registration",
    status: "success",
    channel: payment.channel,
    description: `Membership registration — ${window.name}`,
    metadata: {
      purpose: "registration",
      window_id: window.id,
      window_name: window.name,
      registration_fee: Number(window.registration_fee),
      social_fee: Number(window.social_fee),
      amount_naira: payment.amountNaira,
    },
  });

  if (txError) {
    console.error(
      `[Registration] Ledger insert failed — user ${userId}, ref ${application.payment_reference}: ${txError.message}`,
    );
  }

  NotificationService.getInstance()
    .notify({
      userIds: [],
      type: "security",
      title: "New member application",
      body: `${application.full_name} registered under ${window.name} and is awaiting approval.`,
      data: {
        event: "member_registered",
        member_id: userId,
        window_id: window.id,
      },
      notifyAdmins: true,
      pushAdmins: true,
    })
    .catch((err) => console.error("Failed to notify admins of registration:", err));

  return {
    message: "Registration successful. Your application is pending admin approval.",
    user_id: userId,
    email: data.user.email!,
    member_status: "pending",
  };
}
