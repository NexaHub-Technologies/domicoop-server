import Elysia, { t } from "elysia";
import { authenticate } from "@/middleware/authenticate";
import { requireAdmin } from "@/middleware/requireAdmin";
import { requireActive } from "@/middleware/requireActive";
import { supabase } from "@/lib/supabase";
import { writeAuditLog } from "@/utils/audit";
import { paginationQS, paginate, uuidParam } from "@/utils/validators";
import type { Database } from "@/types/database";
import { disburseLoan, finalizeDisbursementOtp, notifyLoanApproved } from "@/services/loanDisbursement";
import { MIN_TENURE_MONTHS, MAX_TENURE_MONTHS, isTenureInRange } from "@/services/loanTerms";
import { processLoanRepayment, RepaymentResult } from "@/services/loanRepayment";
import { NotificationService } from "@/services/notificationService";
import { requireOfficer } from "@/middleware/requireOfficer";
import { buildSchedule, installmentCount } from "@/services/loanSchedule";
import { amountInWords } from "@/utils/amountInWords";
import { uploadSignature, signedDocumentUrl } from "@/services/signatures";
import { renderLoanBond } from "@/services/loanBond";

type LoanUpdate = Database["public"]["Tables"]["loans"]["Update"];

export const loanRoutes = new Elysia({ prefix: "/loans" })
  .use(authenticate)
  // Requires active account status for all member-scoped loan routes below
  // (pending/suspended members cannot view or apply for loans)
  .use(requireActive)

  // (tabs)/loans.tsx → GET /loans/me
  .get("/me", async ({ userId }) => {
    const { data, error } = await supabase
      .from("loans")
      .select("*")
      .eq("member_id", userId!)
      .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data;
  })

  // transactions/apply-for-loan.tsx → POST /loans/apply
  .post(
    "/apply",
    async ({ userId, body, set }) => {
      const { count } = await supabase
        .from("contributions")
        .select("*", { count: "exact", head: true })
        .eq("member_id", userId!)
        .eq("payment_status", "success");

      const verifiedCount = count ?? 0;
      const requiredCount = 3;

      if (verifiedCount < requiredCount) {
        set.status = 403;
        return {
          success: false,
          reason: "insufficient_contributions",
          eligibility: {
            verified_count: verifiedCount,
            required_count: requiredCount,
            short_by: requiredCount - verifiedCount,
          },
        };
      }

      const { data: existing } = await supabase
        .from("loans")
        .select("id")
        .eq("member_id", userId!)
        .in("status", ["pending", "under_review", "approved", "disbursed", "repaying"])
        .maybeSingle();

      if (existing) {
        set.status = 409;
        return {
          success: false,
          reason: "active_loan_exists",
          active_loan_id: existing.id,
        };
      }

      const { data, error } = await supabase
        .from("loans")
        .insert({
          member_id: userId!,
          amount_requested: body.amount,
          purpose: body.purpose,
          type: body.type,
          tenure_months: body.tenure_months,
          status: "pending",
          // Part A item 5. Derived, never taken from the client: the words and
          // the figure sit side by side on a signed instrument, so the two must
          // not be able to disagree.
          amount_in_words: amountInWords(body.amount),
          // Snapshots. The bond is a legal record of what was signed, so a
          // profile edited next year must not rewrite a deed.
          applicant_address: body.applicant_address,
          applicant_bank_name: body.applicant_bank_name,
          applicant_bank_account: body.applicant_bank_account,
          applicant_phone: body.applicant_phone,
        })
        .select()
        .single();
      if (error) throw new Error(error.message);

      // Signatures and guarantors are what make this a valid Part A/Part B. If
      // either fails the application is not merely incomplete, it is void — so
      // the loan row is removed rather than left as a half-formed application
      // an officer might approve.
      try {
        const borrowerPath = await uploadSignature(
          `loans/${data.id}/borrower.png`,
          body.borrower_signature,
        );
        if (!borrowerPath) throw new Error("Could not store the borrower signature");

        const guarantorRows = await Promise.all(
          body.guarantors.map(async (g, i) => ({
            loan_id: data.id,
            position: i + 1,
            full_name: g.full_name,
            bank_name: g.bank_name,
            bank_account: g.bank_account,
            phone: g.phone,
            signature_url: await uploadSignature(
              `loans/${data.id}/guarantor-${i + 1}.png`,
              g.signature,
            ),
            signed_at: new Date().toISOString(),
          })),
        );

        const missing = guarantorRows.filter((g) => !g.signature_url).length;
        if (missing > 0) {
          throw new Error(`Could not store ${missing} guarantor signature(s)`);
        }

        const { error: gError } = await supabase.from("loan_guarantors").insert(guarantorRows);
        if (gError) throw new Error(gError.message);

        const { error: sigError } = await supabase
          .from("loans")
          .update({
            borrower_signature_url: borrowerPath,
            bond_signed_at: new Date().toISOString(),
          })
          .eq("id", data.id);
        if (sigError) throw new Error(sigError.message);
      } catch (err) {
        await supabase.from("loans").delete().eq("id", data.id);
        set.status = 422;
        return {
          success: false,
          reason: "incomplete_application",
          error:
            err instanceof Error
              ? err.message
              : "The application could not be recorded. Please try again.",
        };
      }

      return data;
    },
    {
      body: t.Object({
        amount: t.Number({ minimum: 1000 }),
        purpose: t.String({ minLength: 10 }),
        type: t.Union([
          t.Literal("emergency"),
          t.Literal("personal"),
          t.Literal("housing"),
          t.Literal("education"),
          t.Literal("business"),
        ]),
        tenure_months: t.Integer({
          minimum: MIN_TENURE_MONTHS,
          maximum: MAX_TENURE_MONTHS,
        }),
        // Part A items 2–4 and 7. Prefilled from the profile client-side but
        // sent explicitly, because they are snapshots (see the insert above).
        applicant_address: t.String({ minLength: 5 }),
        applicant_bank_name: t.String({ minLength: 2 }),
        applicant_bank_account: t.String({ minLength: 10 }),
        applicant_phone: t.String({ minLength: 7 }),
        // Part A item 9, base64 PNG from the signature pad.
        borrower_signature: t.String({ minLength: 1 }),
        // Part B. Exactly three — the paper form has three slots and the
        // cooperative requires all of them filled.
        guarantors: t.Array(
          t.Object({
            full_name: t.String({ minLength: 2 }),
            bank_name: t.String({ minLength: 2 }),
            bank_account: t.String({ minLength: 10 }),
            phone: t.String({ minLength: 7 }),
            signature: t.String({ minLength: 1 }),
          }),
          { minItems: 3, maxItems: 3 },
        ),
      }),
    },
  )

  // loans/[id].tsx → GET /loans/:id
  .get(
    "/:id",
    async ({ params, userId, role }) => {
      // Scoped for members, open for admins — mirroring GET /contributions/:id.
      // Without the branch an officer could not open the application they are
      // being asked to sign, because it is not their own loan.
      const isAdmin = role === "admin";

      let query = supabase
        .from("loans")
        .select(
          "*, transactions(paystack_ref, amount, created_at, channel), loan_guarantors(id, position, full_name, bank_name, bank_account, phone, signature_url, signed_at), loan_installments(id, installment_no, due_on, amount, paid_amount, status), loan_approvals(id, officer_id, officer_role, action, amount_approved, interest_rate, tenure_months, signed_at)",
        )
        .eq("id", params.id);

      if (!isAdmin) query = query.eq("member_id", userId!);

      const { data, error } = await query.single();
      if (error) throw new Error("Loan not found");

      // Guarantor signatures go to officers only. They are other people's
      // handwriting, and the borrower has no reason to re-read them — but an
      // officer signing Part C is being asked to rely on them.
      const guarantors = await Promise.all(
        (data.loan_guarantors ?? []).map(async (g) => ({
          ...g,
          signature_url:
            isAdmin && g.signature_url ? await signedDocumentUrl(g.signature_url) : null,
        })),
      );

      // Officer names, so the panel can say who signed rather than a UUID.
      const approvals = await Promise.all(
        (data.loan_approvals ?? []).map(async (a) => {
          const { data: officer } = await supabase
            .from("admin_profiles")
            .select("full_name")
            .eq("id", a.officer_id)
            .maybeSingle();
          return { ...a, officer_name: officer?.full_name ?? null };
        }),
      );

      // bond_url is an object path in a private bucket. A bare path is useless
      // to a client and a permanent URL would defeat the point, so hand back a
      // short-lived signed one.
      return {
        ...data,
        loan_guarantors: guarantors.sort((a, b) => a.position - b.position),
        loan_installments: [...(data.loan_installments ?? [])].sort(
          (a, b) => a.installment_no - b.installment_no,
        ),
        loan_approvals: approvals,
        bond_url: data.bond_url ? await signedDocumentUrl(data.bond_url) : null,
      };
    },
    { params: uuidParam },
  )

  // POST /loans/:id/repayment - Verify a Paystack payment server-side and apply
  // it to the loan. The client sends only the transaction reference; amount and
  // status come from Paystack, never from the client.
  .post(
    "/:id/repayment",
    async ({ params, body, userId, set }) => {
      const result = await processLoanRepayment(params.id, userId!, body.reference);

      switch (result.result) {
        case RepaymentResult.LoanNotFound:
          set.status = 404;
          return { success: false, reason: "loan_not_found" };
        case RepaymentResult.ReferenceNotFound:
          set.status = 404;
          return {
            success: false,
            reason: "reference_not_found",
            message: result.message,
          };
        case RepaymentResult.PaymentNotSuccessful:
          set.status = 402;
          return {
            success: false,
            reason: "payment_not_successful",
            status: result.paystack_status,
          };
        case RepaymentResult.UnsupportedCurrency:
          set.status = 422;
          return {
            success: false,
            reason: "unsupported_currency",
            currency: result.currency,
          };
        case RepaymentResult.AlreadyProcessed:
          return {
            success: true,
            already_processed: true,
            loan_id: result.loan_id,
            remaining_balance: result.remaining_balance,
            status: result.loan_status,
          };
        case RepaymentResult.Success:
          return {
            success: true,
            loan_id: result.loan_id,
            amount_paid: result.amount_paid,
            remaining_balance: result.remaining_balance,
            status: result.loan_status,
          };
      }
    },
    {
      params: uuidParam,
      body: t.Object({
        reference: t.String({ minLength: 1 }),
      }),
    },
  )

  .use(requireAdmin)

  .get(
    "/",
    async ({ query }) => {
      const { from, to } = paginate(query.page, query.limit);
      let q = supabase
        .from("loans")
        .select("*, profiles(full_name, member_no)", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(from, to);
      if (query.status) q = q.eq("status", query.status);
      const { data, error, count } = await q;
      if (error) throw new Error(error.message);
      return { data, total: count };
    },
    {
      query: t.Partial(
        t.Object({ page: t.Numeric(), limit: t.Numeric(), status: t.String() }),
      ),
    },
  )

  /**
   * Record a decision on a loan
   *
   * Approving computes the repayment terms and tells the member. The terms are
   * flat-rate, not amortised: the cooperative charges `rate`% of the principal
   * once, so `total = principal × (1 + rate/100)` and every month is
   * `total / tenure`.
   *
   * Only a loan awaiting a decision may be approved or rejected. Without that
   * gate, PATCHing `approved` onto a loan that is already disbursed or
   * repaying would recompute `balance` from the principal and silently erase
   * every repayment made against it — and send a second "Loan Approved" for a
   * loan the member has been paying off for months.
   *
   * @route PATCH /loans/:id/process
   * @group Loans
   * @returns {Object} 200 - The updated loan
   * @returns {Error} 404 - Loan not found
   * @returns {Error} 409 - Loan is past the point where it can be decided
   * @returns {Error} 422 - Approving without the terms the decision needs
   */
  /**
   * Record a non-approval decision on a loan
   *
   * Approval lives on POST /loans/:id/sign, which requires an officer of the
   * cooperative — Part C of the application is signed by the Secretary AND the
   * President, not by "an admin". This route keeps the decisions any admin may
   * take: sending an application back for review, or rejecting it.
   *
   * Only a loan awaiting a decision may be rejected. Without that gate,
   * PATCHing a disbursed or repaying loan would send the member a rejection for
   * a loan they are already paying off.
   *
   * @route PATCH /loans/:id/process
   * @group Loans
   * @returns {Error} 409 - Loan is past the point where it can be decided
   */
  .patch(
    "/:id/process",
    async ({ params, body, userId, set }) => {
      const DECIDABLE_FROM = ["pending", "under_review"];

      const { data, error } = await supabase
        .from("loans")
        .update({
          status: body.status,
          admin_notes: body.admin_notes ?? null,
          updated_at: new Date().toISOString(),
        })
        .eq("id", params.id)
        .in("status", DECIDABLE_FROM)
        .select()
        .maybeSingle();

      if (error) throw new Error(error.message);

      if (!data) {
        const { data: existing } = await supabase
          .from("loans")
          .select()
          .eq("id", params.id)
          .maybeSingle();

        if (!existing) {
          set.status = 404;
          return { error: "Loan not found" };
        }
        // The same decision arriving twice — an admin retrying after a network
        // blip. Return the loan untouched rather than re-notifying.
        if (existing.status === body.status) return existing;

        set.status = 409;
        return {
          error: `A loan with status '${existing.status}' can no longer be ${body.status}.`,
          current_status: existing.status,
        };
      }

      await writeAuditLog({
        actor_id: userId!,
        action: `loan_${body.status}`,
        entity: "loans",
        entity_id: params.id,
      });

      // Best-effort: the decision is committed. Throwing here would hand the
      // admin a 500 for work that succeeded, and their retry would take the
      // idempotent path above and never re-send it — so log loudly instead.
      if (body.status === "rejected") {
        try {
          await NotificationService.getInstance().notify({
            userIds: [data.member_id],
            type: "loan",
            title: "Loan Application Update",
            body: "Your loan application was not approved. Please contact support for details.",
            data: { event: "loan_rejected", loan_id: params.id },
            action: { label: "View Details", url: `/loans/${params.id}` },
          });
        } catch (err) {
          console.error(
            `[Loans] Loan ${params.id} rejected, but the member notification failed:`,
            err,
          );
        }
      }

      return data;
    },
    {
      params: uuidParam,
      body: t.Object({
        // `approved` is deliberately absent — see POST /loans/:id/sign.
        status: t.Union([t.Literal("rejected"), t.Literal("under_review")]),
        admin_notes: t.Optional(t.String()),
      }),
    },
  )

  /**
   * Sign a loan for the cooperative (Part C, and the bond's cancellation clause)
   *
   * Part C of the application and the OFFICE USE ONLY block of the bond are
   * signed by the Secretary AND the President. A loan therefore reaches
   * `approved` only once BOTH offices have signed — one officer cannot approve
   * money on their own, and `UNIQUE (loan_id, officer_role, action)` stops them
   * signing twice to fake a second signature.
   *
   * The first officer proposes the terms; the second sees and countersigns
   * them. The second signature is what computes the schedule, writes the terms,
   * generates the bond and notifies the member.
   *
   * @route POST /loans/:id/sign
   * @group Loans
   * @returns {Object} 200 - { loan, signatures, awaiting }
   * @returns {Error} 403 - Caller holds no cooperative office
   * @returns {Error} 409 - Already signed by this office, or wrong loan state
   * @returns {Error} 422 - Approving without terms, or terms out of range
   */
  .post(
    "/:id/sign",
    async ({ params, body, userId, officerRole, set }) => {
      const role = officerRole as "secretary" | "president";

      const { data: loan, error: loanError } = await supabase
        .from("loans")
        .select("*")
        .eq("id", params.id)
        .maybeSingle();

      if (loanError) throw new Error(loanError.message);
      if (!loan) {
        set.status = 404;
        return { error: "Loan not found" };
      }

      if (body.action === "approve" && !["pending", "under_review"].includes(loan.status)) {
        set.status = 409;
        return {
          error: `A loan with status '${loan.status}' is past approval.`,
          current_status: loan.status,
        };
      }
      if (body.action === "cancel_bond" && loan.status !== "closed") {
        set.status = 409;
        return {
          error:
            "A bond is cancelled only once the loan is fully repaid. This loan is not closed yet.",
          current_status: loan.status,
        };
      }

      // The first officer sets the terms; the second inherits whatever is on
      // record, so a countersignature cannot silently change the amount.
      const { data: existingSignatures } = await supabase
        .from("loan_approvals")
        .select("*")
        .eq("loan_id", params.id)
        .eq("action", body.action);

      const priorApproval = (existingSignatures ?? []).find((a) => a.officer_role !== role);
      const isFirst = !priorApproval;

      let terms: {
        amount_approved: number;
        interest_rate: number;
        tenure_months: number;
      } | null = null;

      if (body.action === "approve") {
        if (isFirst) {
          if (!body.amount_approved || !body.tenure_months) {
            set.status = 422;
            return {
              error:
                "The first officer to sign sets the terms: amount_approved and tenure_months are required.",
            };
          }
          if (!isTenureInRange(body.tenure_months)) {
            set.status = 422;
            return {
              error: `Tenure must be a whole number of months between ${MIN_TENURE_MONTHS} and ${MAX_TENURE_MONTHS}.`,
              min_tenure_months: MIN_TENURE_MONTHS,
              max_tenure_months: MAX_TENURE_MONTHS,
            };
          }
          terms = {
            amount_approved: body.amount_approved,
            interest_rate: body.interest_rate ?? 5,
            tenure_months: body.tenure_months,
          };
        } else {
          terms = {
            amount_approved: Number(priorApproval.amount_approved),
            interest_rate: Number(priorApproval.interest_rate),
            tenure_months: Number(priorApproval.tenure_months),
          };
        }
      }

      const signaturePath = body.signature
        ? await uploadSignature(
            `loans/${params.id}/${body.action}-${role}.png`,
            body.signature,
          )
        : null;

      const { error: signError } = await supabase.from("loan_approvals").insert({
        loan_id: params.id,
        officer_id: userId!,
        officer_role: role,
        action: body.action,
        amount_approved: terms?.amount_approved ?? null,
        interest_rate: terms?.interest_rate ?? null,
        tenure_months: terms?.tenure_months ?? null,
        signature_url: signaturePath,
      });

      if (signError) {
        // 23505 on UNIQUE (loan_id, officer_role, action): this office has
        // already signed. Idempotent rather than an error — a double-tap must
        // not read as a failure.
        if (signError.code === "23505") {
          set.status = 409;
          return {
            error: `The ${role} has already signed this loan.`,
            reason: "already_signed",
          };
        }
        throw new Error(signError.message);
      }

      await writeAuditLog({
        actor_id: userId!,
        action: `loan_sign_${body.action}`,
        entity: "loans",
        entity_id: params.id,
        metadata: { officer_role: role, ...(terms ?? {}) },
      });

      const signedRoles = new Set([
        ...(existingSignatures ?? []).map((a) => a.officer_role),
        role,
      ]);
      const bothSigned = signedRoles.has("secretary") && signedRoles.has("president");

      if (!bothSigned) {
        const awaiting = role === "secretary" ? "president" : "secretary";
        return {
          loan,
          signatures: [...signedRoles],
          awaiting,
          message: `Recorded. Awaiting the ${awaiting}'s signature.`,
        };
      }

      // ---- Both offices have signed. This is the moment of decision. ----
      if (body.action === "approve" && terms) {
        const schedule = buildSchedule({
          principal: terms.amount_approved,
          rate: terms.interest_rate,
          tenureMonths: terms.tenure_months,
        });

        const { data: updated, error: updateError } = await supabase
          .from("loans")
          .update({
            status: "approved",
            amount_approved: terms.amount_approved,
            interest_rate: terms.interest_rate,
            tenure_months: terms.tenure_months,
            monthly_repayment: schedule.monthly_repayment,
            balance: schedule.total_repayable,
            first_installment_on: schedule.first_installment_on,
            due_date: schedule.final_installment_on,
            approved_at: new Date().toISOString(),
            amount_in_words: amountInWords(terms.amount_approved),
            updated_at: new Date().toISOString(),
          })
          .eq("id", params.id)
          .select()
          .single();

        if (updateError) throw new Error(updateError.message);

        // Everything past here is best-effort: the loan is approved and both
        // signatures are on record, so a failed schedule write or bond render
        // must be reconciled, not allowed to undo a decision.
        const { error: scheduleError } = await supabase.from("loan_installments").insert(
          schedule.rows.map((r) => ({
            loan_id: params.id,
            installment_no: r.installment_no,
            due_on: r.due_on,
            amount: r.amount,
          })),
        );
        if (scheduleError) {
          console.error(
            `[Loans] Schedule insert failed for ${params.id}:`,
            scheduleError.message,
          );
        }

        try {
          const bondPath = await renderLoanBond(params.id);
          if (bondPath) {
            await supabase.from("loans").update({ bond_url: bondPath }).eq("id", params.id);
          }
        } catch (err) {
          console.error(`[Loans] Bond render failed for ${params.id}:`, err);
        }

        try {
          await notifyLoanApproved(params.id);
        } catch (err) {
          console.error(`[Loans] Approval notification failed for ${params.id}:`, err);
        }

        return {
          loan: updated,
          signatures: [...signedRoles],
          awaiting: null,
          message: "Approved by both offices.",
        };
      }

      // ---- cancel_bond ----
      const { data: cancelled, error: cancelError } = await supabase
        .from("loans")
        .update({
          bond_cancelled_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("id", params.id)
        .select()
        .single();
      if (cancelError) throw new Error(cancelError.message);

      try {
        await renderLoanBond(params.id);
      } catch (err) {
        console.error(`[Loans] Bond re-render on cancellation failed for ${params.id}:`, err);
      }

      try {
        await NotificationService.getInstance().notify({
          userIds: [cancelled.member_id],
          type: "loan",
          title: "Loan Bond Cancelled",
          body: "Your loan is fully repaid and the bond has been cancelled. Thank you.",
          data: { event: "loan_bond_cancelled", loan_id: params.id },
          action: { label: "View Details", url: `/loans/${params.id}` },
        });
      } catch (err) {
        console.error(`[Loans] Cancellation notification failed for ${params.id}:`, err);
      }

      return {
        loan: cancelled,
        signatures: [...signedRoles],
        awaiting: null,
        message: "Bond cancelled by both offices.",
      };
    },
    {
      // Scoped to this route only — disbursement and repayment stay open to any
      // admin. Returning a value from beforeHandle short-circuits the handler.
      beforeHandle: requireOfficer,
      params: uuidParam,
      body: t.Object({
        action: t.Union([t.Literal("approve"), t.Literal("cancel_bond")]),
        amount_approved: t.Optional(t.Number({ minimum: 1 })),
        interest_rate: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
        tenure_months: t.Optional(t.Integer()),
        signature: t.Optional(t.String()),
      }),
    },
  )

  .post(
    "/:id/disburse",
    async ({ params, userId, set }) => {
      const { data: loan, error: loanError } = await supabase
        .from("loans")
        .select("id, status, amount_approved")
        .eq("id", params.id)
        .single();

      if (loanError || !loan) {
        set.status = 404;
        throw new Error("Loan not found");
      }

      // Approved loans disburse; failed ones may be retried once the cause
      // (e.g. bad bank details) is fixed. Anything else is past disbursement.
      if (!["approved", "disbursement_failed"].includes(loan.status)) {
        set.status = 409;
        throw new Error(
          `Loan must be in 'approved' status to disburse. Current status: ${loan.status}`,
        );
      }

      if (!loan.amount_approved || loan.amount_approved <= 0) {
        set.status = 422;
        throw new Error("Loan has no approved amount to disburse");
      }

      let result;
      try {
        result = await disburseLoan(params.id);
      } catch (err) {
        // Any remaining throw from disburseLoan is a precondition failure
        // (e.g. missing bank details) not caught by the checks above.
        set.status = 422;
        throw err;
      }

      await writeAuditLog({
        actor_id: userId!,
        action: `loan_disbursement_${result.result}`,
        entity: "loans",
        entity_id: params.id,
        metadata: {
          paystack_transfer_ref: result.paystack_transfer_ref,
          recipient_code: result.recipient_code,
        },
      });

      if (result.result === "success") {
        return {
          success: true,
          status: "disbursed",
          paystack_transfer_ref: result.paystack_transfer_ref,
          disbursed_at: result.disbursed_at,
          message: "Loan disbursed successfully",
        };
      } else if (result.result === "pending_otp") {
        return {
          success: true,
          status: "pending_otp",
          paystack_transfer_ref: result.paystack_transfer_ref,
          message: result.message || "Transfer initiated. Awaiting OTP confirmation.",
        };
      } else {
        return {
          success: false,
          status: "disbursement_failed",
          message: result.message || "Disbursement failed",
        };
      }
    },
    { params: uuidParam },
  )

  /**
   * Finalize an OTP-gated disbursement with the code Paystack sent to the
   * business phone. The loan must be `approved` with a stored pending
   * transfer (i.e. a prior disburse returned `pending_otp`).
   *
   * @route POST /loans/:id/disburse/finalize
   * @group Loans
   */
  .post(
    "/:id/disburse/finalize",
    async ({ params, body, userId, set }) => {
      const { data: loan, error: loanError } = await supabase
        .from("loans")
        .select("id, status, paystack_transfer_ref")
        .eq("id", params.id)
        .single();

      if (loanError || !loan) {
        set.status = 404;
        throw new Error("Loan not found");
      }

      if (loan.status !== "approved") {
        set.status = 409;
        throw new Error(
          `Only a loan awaiting disbursement can be finalized. Current status: ${loan.status}`,
        );
      }

      if (!loan.paystack_transfer_ref) {
        set.status = 422;
        throw new Error("No pending transfer for this loan. Disburse first.");
      }

      let result;
      try {
        result = await finalizeDisbursementOtp(params.id, body.otp);
      } catch (err) {
        set.status = 422;
        throw err;
      }

      await writeAuditLog({
        actor_id: userId!,
        action: "loan_disbursement_otp_finalized",
        entity: "loans",
        entity_id: params.id,
        metadata: { result: result.result },
      });

      if (result.result === "success") {
        return {
          success: true,
          status: "disbursed",
          paystack_transfer_ref: result.paystack_transfer_ref,
          disbursed_at: result.disbursed_at,
          message: result.message || "Loan disbursed successfully",
        };
      } else if (result.result === "pending_otp") {
        return {
          success: true,
          status: "pending_otp",
          paystack_transfer_ref: result.paystack_transfer_ref,
          message: result.message || "Transfer still pending.",
        };
      } else {
        return {
          success: false,
          status: "disbursement_failed",
          message: result.message || "Disbursement failed",
        };
      }
    },
    {
      params: uuidParam,
      body: t.Object({ otp: t.String({ minLength: 1 }) }),
    },
  );
