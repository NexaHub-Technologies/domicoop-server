import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from "pdf-lib";
import { supabase } from "@/lib/supabase";
import { DOCUMENTS_BUCKET, uploadDocument } from "@/services/signatures";
import { amountInWords } from "@/utils/amountInWords";
import { installmentCount } from "@/services/loanSchedule";

/**
 * Renders the LOAN BOND deed (the `LOAN B` document) from stored data.
 *
 * Rendered server-side rather than in a client so there is exactly one bond per
 * loan and everyone — borrower, officers, auditor — sees the same bytes. There
 * is no headless browser here, so this draws with pdf-lib rather than printing
 * HTML; `expo-print` in the mobile app is for member-facing receipts only.
 *
 * The deed is regenerated (same path, upsert) when the bond is cancelled, so
 * the cancellation clause is filled on the one authoritative document rather
 * than living in a second file.
 */

const PAGE = { width: 595.28, height: 841.89 }; // A4 portrait, points
const MARGIN = 56;
const LINE = 14;

const SOCIETY = [
  "DOMINION MULTI-PURPOSE CO-OPERATIVE SOCIETY",
  "NO. 75 JACK NOVO PLAZA WATER RESOURCES",
  "EFFURUN SAPELE ROAD EFFURUN",
  "DELTA STATE.",
];

interface Cursor {
  page: PDFPage;
  y: number;
}

interface Fonts {
  body: PDFFont;
  bold: PDFFont;
}

/** Split text to fit the content width, respecting the font's real metrics. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) > width && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/** A fresh page, used on first draw and whenever the cursor runs off the bottom. */
function newPage(doc: PDFDocument): Cursor {
  const page = doc.addPage([PAGE.width, PAGE.height]);
  return { page, y: PAGE.height - MARGIN };
}

function ensureRoom(doc: PDFDocument, cur: Cursor, needed: number): Cursor {
  if (cur.y - needed >= MARGIN) return cur;
  return newPage(doc);
}

function drawText(
  doc: PDFDocument,
  cur: Cursor,
  text: string,
  opts: { font: PDFFont; size?: number; center?: boolean; gap?: number },
): Cursor {
  const size = opts.size ?? 10;
  const width = PAGE.width - MARGIN * 2;
  const lines = wrap(text, opts.font, size, width);
  let c = ensureRoom(doc, cur, lines.length * LINE);
  for (const line of lines) {
    const x = opts.center
      ? (PAGE.width - opts.font.widthOfTextAtSize(line, size)) / 2
      : MARGIN;
    c.page.drawText(line, { x, y: c.y, size, font: opts.font, color: rgb(0, 0, 0) });
    c.y -= LINE;
  }
  c.y -= opts.gap ?? 0;
  return c;
}

/** A "LABEL: value" line with a dotted rule filling the rest, as on the paper form. */
function drawField(
  doc: PDFDocument,
  cur: Cursor,
  fonts: Fonts,
  label: string,
  value: string | null | undefined,
): Cursor {
  const size = 10;
  const text = `${label}: ${value ?? ""}`;
  let c = ensureRoom(doc, cur, LINE);
  c.page.drawText(text, { x: MARGIN, y: c.y, size, font: fonts.body });
  const used = fonts.body.widthOfTextAtSize(text, size);
  const remaining = PAGE.width - MARGIN * 2 - used;
  if (remaining > 8) {
    const dots = ".".repeat(Math.floor(remaining / fonts.body.widthOfTextAtSize(".", size)));
    c.page.drawText(dots, {
      x: MARGIN + used + 2,
      y: c.y,
      size,
      font: fonts.body,
      color: rgb(0.45, 0.45, 0.45),
    });
  }
  c.y -= LINE;
  return c;
}

/** Fetch a stored signature PNG. Returns null when absent or unreadable. */
async function loadSignature(path: string | null): Promise<Uint8Array | null> {
  if (!path) return null;
  const { data, error } = await supabase.storage.from(DOCUMENTS_BUCKET).download(path);
  if (error || !data) {
    console.error(`[Bond] Could not read signature ${path}:`, error?.message);
    return null;
  }
  return new Uint8Array(await data.arrayBuffer());
}

async function drawSignature(
  doc: PDFDocument,
  cur: Cursor,
  fonts: Fonts,
  label: string,
  png: Uint8Array | null,
  dated: string | null,
): Promise<Cursor> {
  const height = png ? 34 : 0;
  let c = ensureRoom(doc, cur, height + LINE * 2);

  c.page.drawText(label, { x: MARGIN, y: c.y, size: 10, font: fonts.body });
  const labelWidth = fonts.body.widthOfTextAtSize(label, 10);

  if (png) {
    try {
      const image = await doc.embedPng(png);
      const scaled = image.scaleToFit(130, height);
      c.page.drawImage(image, {
        x: MARGIN + labelWidth + 8,
        y: c.y - 6,
        width: scaled.width,
        height: scaled.height,
      });
    } catch (err) {
      // A corrupt PNG must not cost the whole deed; fall through to the rule.
      console.error("[Bond] Signature embed failed:", err);
    }
  } else {
    c.page.drawLine({
      start: { x: MARGIN + labelWidth + 8, y: c.y },
      end: { x: MARGIN + labelWidth + 148, y: c.y },
      thickness: 0.5,
      color: rgb(0.45, 0.45, 0.45),
    });
  }

  const dateText = `DATE: ${dated ? new Date(dated).toLocaleDateString("en-NG") : ""}`;
  c.page.drawText(dateText, {
    x: PAGE.width - MARGIN - fonts.body.widthOfTextAtSize(dateText, 10),
    y: c.y,
    size: 10,
    font: fonts.body,
  });

  c.y -= height + LINE;
  return c;
}

/**
 * Everything the deed says, already resolved. Signatures arrive as raw PNG
 * bytes so the layout has no I/O of its own — which is what makes it testable
 * without a database or a storage bucket.
 */
export interface BondData {
  member_name: string;
  principal: number;
  interest_rate: number;
  purpose: string;
  applicant_address: string | null;
  applicant_bank_name: string | null;
  applicant_bank_account: string | null;
  applicant_phone: string | null;
  installment_count: number;
  first_installment_on: string | null;
  borrower_signature: Uint8Array | null;
  borrower_signed_at: string | null;
  guarantors: {
    position: number;
    full_name: string;
    bank_name: string;
    bank_account: string;
    phone: string;
    signature: Uint8Array | null;
    signed_at: string | null;
  }[];
  officers: {
    role: "secretary" | "president";
    action: "approve" | "cancel_bond";
    name: string;
    signature: Uint8Array | null;
    signed_at: string | null;
  }[];
  cancelled: boolean;
}

/**
 * Draw the deed. Pure: no database, no storage, no clock beyond what it is
 * given, so the same input always produces the same document.
 */
export async function buildBondPdf(data: BondData): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    body: await doc.embedFont(StandardFonts.TimesRoman),
    bold: await doc.embedFont(StandardFonts.TimesRomanBold),
  };

  let cur = newPage(doc);

  for (const [i, line] of SOCIETY.entries()) {
    cur = drawText(doc, cur, line, {
      font: i === 0 ? fonts.bold : fonts.body,
      size: i === 0 ? 13 : 9,
      center: true,
    });
  }
  cur.y -= 8;
  cur = drawText(doc, cur, "LOAN BOND", { font: fonts.bold, size: 12, center: true, gap: 10 });

  cur = drawText(
    doc,
    cur,
    `I, ${data.member_name} (hereinafter called the BORROWER), hereby acknowledge receipt from ` +
      `Dominion Multi-Purpose Co-operative Society, No. 75 Jack Novo Plaza Water Resources, ` +
      `Effurun Sapele Road, Effurun, Delta State (hereinafter referred to as the LENDER), the sum of ` +
      `${amountInWords(data.principal)} (NGN ${data.principal.toLocaleString()}), being a loan bearing ` +
      `the interest rate of ${data.interest_rate}% per annum.`,
    { font: fonts.body, gap: 8 },
  );

  cur = drawField(doc, cur, fonts, "BUSINESS/HOME ADDRESS", data.applicant_address);
  cur = drawField(doc, cur, fonts, "BANK USED BY THE APPLICANT", data.applicant_bank_name);
  cur = drawField(doc, cur, fonts, "ACCOUNT NUMBER", data.applicant_bank_account);
  cur = drawField(doc, cur, fonts, "PURPOSE", data.purpose);
  cur.y -= 8;

  // The paper form hardcodes "ELEVAN Month"; the deed states the term actually
  // granted, which for a 12-month tenure is the same eleven installments.
  const commencing = data.first_installment_on
    ? new Date(data.first_installment_on).toLocaleDateString("en-NG", {
        month: "long",
        year: "numeric",
      })
    : "";

  cur = drawText(
    doc,
    cur,
    `I also hereby agree that I shall use the loan solely for the specific purpose for which it has ` +
      `been granted, and that I shall repay the principal amount within ${data.installment_count} ` +
      `month(s) in equal installments commencing ${commencing}.`,
    { font: fonts.body, gap: 8 },
  );

  cur = await drawSignature(
    doc,
    cur,
    fonts,
    "SIGNATURE OF BORROWER:",
    data.borrower_signature,
    data.borrower_signed_at,
  );
  cur = drawField(doc, cur, fonts, "PHONE NUMBER", data.applicant_phone);
  cur.y -= 12;

  cur = drawText(doc, cur, "GUARANTORS", { font: fonts.bold, size: 11, center: true, gap: 6 });
  for (const g of data.guarantors) {
    cur = drawField(doc, cur, fonts, `${g.position}.  NAME`, g.full_name);
    cur = drawField(doc, cur, fonts, "     NAME OF BANK", g.bank_name);
    cur = drawField(doc, cur, fonts, "     ACCOUNT NUMBER", g.bank_account);
    cur = drawField(doc, cur, fonts, "     PHONE NUMBER", g.phone);
    cur = await drawSignature(doc, cur, fonts, "     SIGN:", g.signature, g.signed_at);
    cur.y -= 6;
  }

  cur.y -= 6;
  cur = drawText(doc, cur, "OFFICE USE ONLY", {
    font: fonts.bold,
    size: 11,
    center: true,
    gap: 6,
  });
  cur = drawText(
    doc,
    cur,
    "Signed and delivered for and on behalf of Dominion Multi-Purpose Co-operative Society, Effurun.",
    { font: fonts.body, gap: 6 },
  );

  const find = (role: string, action: string) =>
    data.officers.find((o) => o.role === role && o.action === action) ?? null;

  for (const role of ["secretary", "president"] as const) {
    const a = find(role, "approve");
    const name = role === "secretary" ? "SECRETARY'S NAME" : "PRESIDENT'S NAME";
    cur = drawField(doc, cur, fonts, name, a?.name ?? "");
    cur = await drawSignature(
      doc,
      cur,
      fonts,
      "     SIGN:",
      a?.signature ?? null,
      a?.signed_at ?? null,
    );
  }

  cur.y -= 10;
  cur = drawText(
    doc,
    cur,
    data.cancelled
      ? "The amount of the loan and interest stated above has been fully paid and the bond is hereby cancelled."
      : "(To be completed on full repayment) The amount of the loan and interest stated above has been fully paid and the bond is hereby cancelled.",
    { font: data.cancelled ? fonts.bold : fonts.body, gap: 6 },
  );

  for (const role of ["president", "secretary"] as const) {
    const a = find(role, "cancel_bond");
    const label = role === "president" ? "PRESIDENT'S SIGNATURE:" : "SECRETARY'S SIGNATURE:";
    cur = await drawSignature(
      doc,
      cur,
      fonts,
      label,
      a?.signature ?? null,
      a?.signed_at ?? null,
    );
  }

  return doc.save();
}

/**
 * Gather a loan's data, draw the deed, and store it. Returns the object path,
 * or null if the loan could not be read — callers treat null as "log and carry
 * on", because the approval itself has already been recorded.
 */
export async function renderLoanBond(loanId: string): Promise<string | null> {
  const { data: loan, error } = await supabase
    .from("loans")
    .select("*, profiles(full_name, member_no)")
    .eq("id", loanId)
    .single();

  if (error || !loan) {
    console.error(`[Bond] Loan ${loanId} not readable:`, error?.message);
    return null;
  }

  const [{ data: guarantors }, { data: approvals }] = await Promise.all([
    supabase
      .from("loan_guarantors")
      .select("*")
      .eq("loan_id", loanId)
      .order("position", { ascending: true }),
    supabase.from("loan_approvals").select("*").eq("loan_id", loanId),
  ]);

  const officers = await Promise.all(
    (approvals ?? []).map(async (a) => ({
      role: a.officer_role as "secretary" | "president",
      action: a.action as "approve" | "cancel_bond",
      name: await officerName(a.officer_id),
      signature: await loadSignature(a.signature_url),
      signed_at: a.signed_at,
    })),
  );

  const bytes = await buildBondPdf({
    member_name: (loan.profiles as { full_name?: string } | null)?.full_name ?? "",
    principal: Number(loan.amount_approved ?? loan.amount_requested),
    interest_rate: Number(loan.interest_rate ?? 0),
    purpose: loan.purpose,
    applicant_address: loan.applicant_address,
    applicant_bank_name: loan.applicant_bank_name,
    applicant_bank_account: loan.applicant_bank_account,
    applicant_phone: loan.applicant_phone,
    installment_count: loan.tenure_months ? installmentCount(loan.tenure_months) : 0,
    first_installment_on: loan.first_installment_on,
    borrower_signature: await loadSignature(
      loan.bond_signature_url ?? loan.borrower_signature_url,
    ),
    borrower_signed_at: loan.bond_signed_at ?? loan.created_at,
    guarantors: await Promise.all(
      (guarantors ?? []).map(async (g) => ({
        position: g.position,
        full_name: g.full_name,
        bank_name: g.bank_name,
        bank_account: g.bank_account,
        phone: g.phone,
        signature: await loadSignature(g.signature_url),
        signed_at: g.signed_at,
      })),
    ),
    officers,
    cancelled: !!loan.bond_cancelled_at,
  });

  // Same path every time: regenerating on cancellation fills the cancellation
  // clause on the one authoritative deed rather than creating a second file.
  return uploadDocument(`loans/${loanId}/bond.pdf`, bytes, "application/pdf");
}

/** Officer names are read at render time so a renamed officer shows correctly. */
async function officerName(officerId: string): Promise<string> {
  const { data } = await supabase
    .from("admin_profiles")
    .select("full_name")
    .eq("id", officerId)
    .maybeSingle();
  return data?.full_name ?? "";
}
