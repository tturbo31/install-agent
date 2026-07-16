import { createHash, timingSafeEqual } from "crypto";

// ─── Admin secret gate ──────────────────────────────────────────────────────
// AUDIT (2026-07-15): ADMIN_SECRET was NEVER actually set — not in .env.local,
// not in Vercel. Every admin route read `process.env.ADMIN_SECRET ?? "Pepeka"`,
// so the secret that really protected production was the hardcoded literal
// "Pepeka". Worse, that same literal is compiled into the PUBLIC dashboard
// bundle (`NEXT_PUBLIC_ADMIN_SECRET ?? "Pepeka"` in ChatPanel, Dashboard,
// TrainingSimulator and upload-fotos), so anyone who opens the dashboard URL can
// read it straight out of the JavaScript.
//
// A public secret on read-only diagnostics and owner-only dashboard buttons is
// bad but survivable. It is NOT survivable on /api/enviar, which sends arbitrary
// WhatsApp text to arbitrary numbers through our own Z-API instance: a leaked
// secret there is a spam cannon pointed at our own WhatsApp number (ban risk).
// Hence two distinct gates:
//
//  • isDashboardAuthorized — for the PRE-EXISTING routes. Accepts the legacy
//    literal, INSTAGRAM_VERIFY_TOKEN, and a real ADMIN_SECRET. This is a strict
//    SUPERSET of what each of those routes accepted before ADMIN_SECRET existed,
//    which is exactly what makes finally setting ADMIN_SECRET safe: no dashboard
//    button and no cron URL can start returning 401.
//
//  • isStrongAdminSecret — for /api/enviar ONLY. Requires ADMIN_SECRET to be set
//    AND to be a genuine secret (never the public legacy literal, >= 32 chars),
//    compared in constant time.
//
// TODO (owner decision): the real fix for the dashboard is proper login instead
// of a shared secret baked into the client bundle. Until then, LEGACY_ADMIN_SECRET
// stays accepted here so nothing the owner uses today breaks.

export const LEGACY_ADMIN_SECRET = "Pepeka";
export const MIN_STRONG_SECRET_LENGTH = 32;

// Hash both sides before comparing: constant time, never throws on a length
// mismatch, and the comparison itself leaks no length information.
function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

// Gate for the pre-existing admin/dashboard/cron routes. Deliberately permissive:
// it must accept everything those routes accepted before ADMIN_SECRET existed.
export function isDashboardAuthorized(secret: string | null | undefined): boolean {
  if (!secret) return false;
  const accepted = [
    process.env.ADMIN_SECRET,
    process.env.INSTAGRAM_VERIFY_TOKEN,
    LEGACY_ADMIN_SECRET,
  ];
  return accepted.some((expected) => !!expected && constantTimeEquals(secret, expected));
}

// Gate for /api/enviar (sends WhatsApp messages). STRICT: only a real, strong
// ADMIN_SECRET opens it. If ADMIN_SECRET is unset, short, or still the public
// legacy literal, this returns false for EVERY input — the endpoint fails closed
// rather than exposing a send API behind a secret that is public in the bundle.
export function isStrongAdminSecret(secret: string | null | undefined): boolean {
  const expected = process.env.ADMIN_SECRET;
  if (!expected || expected.length < MIN_STRONG_SECRET_LENGTH) return false;
  if (expected === LEGACY_ADMIN_SECRET) return false;
  if (!secret) return false;
  return constantTimeEquals(secret, expected);
}
