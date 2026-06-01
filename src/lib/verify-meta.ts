import { createHmac, timingSafeEqual } from "crypto";

export function verifyMetaSignature(rawBody: string, signature: string | null): boolean {
  const secret = process.env.FACEBOOK_APP_SECRET;
  if (!secret) {
    console.warn("[Security] FACEBOOK_APP_SECRET not set — skipping webhook signature check");
    return true;
  }
  if (!signature?.startsWith("sha256=")) {
    console.warn("[Security] Missing or malformed X-Hub-Signature-256 header");
    return false;
  }
  const expected = "sha256=" + createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
