import { supabase } from "@/lib/supabase";

/**
 * Documents captured from members: signatures, and the generated loan bonds.
 *
 * Private, deliberately. A signature is handwriting tied to a name, address and
 * ID number, and a loan bond names a sum of money and three guarantors — a
 * public bucket would make every one of them enumerable. Everything here is
 * read through short-lived signed URLs.
 */
export const DOCUMENTS_BUCKET = "member-documents";

/** Strip a `data:image/png;base64,` prefix if the client sent one. */
function decodeBase64Png(base64: string): Buffer | null {
  const payload = base64.includes(",") ? base64.slice(base64.indexOf(",") + 1) : base64;
  if (!payload.trim()) return null;
  return Buffer.from(payload, "base64");
}

/**
 * Store a base64 PNG signature and return its object path.
 *
 * Returns the PATH, not a URL: the bucket is private, so a URL would either be
 * useless or — if made permanent — defeat the point. Readers call
 * `signedDocumentUrl`.
 *
 * Never throws. A failed upload returns null so the caller can decide: for a
 * loan application that means rejecting, for a paid registration it means
 * keeping the account and logging for reconciliation. Both are already past
 * the point where losing the work would be worse than losing the image.
 */
export async function uploadSignature(path: string, base64: string): Promise<string | null> {
  const bytes = decodeBase64Png(base64);
  if (!bytes) return null;

  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(path, bytes, { contentType: "image/png", upsert: true });

  if (error) {
    console.error(`[Documents] Signature upload failed for ${path}:`, error.message);
    return null;
  }
  return path;
}

/** Store a generated document (e.g. a loan bond PDF) and return its object path. */
export async function uploadDocument(
  path: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<string | null> {
  const { error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .upload(path, bytes, { contentType, upsert: true });

  if (error) {
    console.error(`[Documents] Upload failed for ${path}:`, error.message);
    return null;
  }
  return path;
}

/**
 * A time-limited link to a stored document, for the clients.
 *
 * Minted per request and never cached — five minutes is enough to render a
 * page or download a file, and short enough that a leaked URL expires before
 * it is useful.
 */
export async function signedDocumentUrl(
  path: string,
  expiresInSeconds = 300,
): Promise<string | null> {
  const { data, error } = await supabase.storage
    .from(DOCUMENTS_BUCKET)
    .createSignedUrl(path, expiresInSeconds);

  if (error) {
    console.error(`[Documents] Could not sign ${path}:`, error.message);
    return null;
  }
  return data.signedUrl;
}
