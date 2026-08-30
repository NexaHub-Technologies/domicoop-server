import { supabase } from "@/lib/supabase";
import type { Database } from "@/types/database";

export type RegistrationWindowRow =
  Database["public"]["Tables"]["registration_windows"]["Row"];

/**
 * Why a registration window can be shut. Ordered from "not yet" to "never
 * again" — the client renders a different message for each, so the reason is
 * part of the contract, not just a log line.
 */
export type ClosedReason =
  | "no_window" // nothing scheduled at all
  | "not_yet_open" // exists, but before opens_at or still a draft
  | "period_ended" // past closes_at
  | "at_capacity" // full
  | "closed_by_admin"; // manually ended

export interface RegistrationWindowState {
  window: RegistrationWindowRow | null;
  is_open: boolean;
  reason: ClosedReason | null;
  /** null when the window has no capacity cap. */
  slots_remaining: number | null;
}

/**
 * The live window and whether it is actually accepting applications.
 *
 * Openness is derived rather than stored: two of its three inputs (the clock,
 * the application count) move without anybody writing a row, so a cached
 * boolean would be wrong most of the time it mattered. `state` is only the
 * admin's manual override.
 *
 * A unique partial index guarantees at most one non-closed row, so this reads
 * a single window rather than picking among candidates.
 */
export async function getActiveWindow(): Promise<RegistrationWindowState> {
  const { data, error } = await supabase
    .from("registration_windows")
    .select("*")
    .neq("state", "closed")
    .order("opens_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data)
    return { window: null, is_open: false, reason: "no_window", slots_remaining: null };

  const now = Date.now();
  const opensAt = new Date(data.opens_at).getTime();
  const closesAt = new Date(data.closes_at).getTime();
  const slotsRemaining =
    data.capacity === null ? null : Math.max(data.capacity - data.applications_count, 0);

  let reason: ClosedReason | null = null;
  if (data.state === "draft" || now < opensAt) reason = "not_yet_open";
  else if (now > closesAt) reason = "period_ended";
  else if (slotsRemaining !== null && slotsRemaining <= 0) reason = "at_capacity";

  return { window: data, is_open: reason === null, reason, slots_remaining: slotsRemaining };
}

/**
 * The most recent closed window, used only to tell an applicant when the last
 * intake ran. Never used to price a registration.
 */
export async function getLastClosedWindow(): Promise<RegistrationWindowRow | null> {
  const { data, error } = await supabase
    .from("registration_windows")
    .select("*")
    .eq("state", "closed")
    .order("closes_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data;
}

const CLOSED_MESSAGES: Record<ClosedReason, string> = {
  no_window: "Membership registration is not currently open.",
  not_yet_open: "Membership registration has not opened yet.",
  period_ended: "The membership registration period has closed.",
  at_capacity: "This registration period is full.",
  closed_by_admin: "Membership registration is closed.",
};

/** Thrown when an application arrives outside an open window. Carries the reason so routes can shape the response. */
export class RegistrationClosedError extends Error {
  readonly reason: ClosedReason;
  readonly state: RegistrationWindowState;

  constructor(state: RegistrationWindowState) {
    const reason = state.reason ?? "closed_by_admin";
    super(CLOSED_MESSAGES[reason]);
    this.name = "RegistrationClosedError";
    this.reason = reason;
    this.state = state;
  }
}

/**
 * Gate for every path that can create a member. Returns the open window so the
 * caller can price the registration off the same row it was validated against
 * — re-reading it later would let an admin edit the fee mid-application.
 */
export async function assertRegistrationOpen(): Promise<RegistrationWindowRow> {
  const state = await getActiveWindow();
  if (!state.is_open || !state.window) throw new RegistrationClosedError(state);
  return state.window;
}
