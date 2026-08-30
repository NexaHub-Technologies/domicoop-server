/**
 * Gate for actions a named cooperative officer must perform personally.
 *
 * Distinct from `requireAdmin`: Part C of the loan application and the bond's
 * OFFICE USE ONLY block are signed by the Secretary and the President
 * specifically. Most admins hold neither office and must not be able to sign a
 * loan into existence, however much else they can do.
 *
 * Exported as a `beforeHandle` hook rather than an Elysia plugin on purpose.
 * `.use()` applies to every route defined after it in the instance, which would
 * have swept up disbursement and repayment — operational actions any admin may
 * take. A hook attaches to exactly the route that needs it.
 */
export function requireOfficer({ set, ...ctx }: any): unknown {
  if (ctx.role !== "admin") {
    set.status = 403;
    return { error: "Admin access required" };
  }
  if (ctx.officerRole !== "secretary" && ctx.officerRole !== "president") {
    set.status = 403;
    return {
      error:
        "Only the Secretary or the President may sign for the cooperative. Ask a super admin to assign your office.",
      reason: "no_office_held",
    };
  }
  // Undefined lets the request continue to the handler.
  return undefined;
}
