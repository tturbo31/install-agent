import { supabaseAdmin } from "@/lib/supabase";

// ─── Facebook page token: DB-first (same pattern as ig-token.ts) ────────────
// ROOT CAUSE (2026-08-03): a Facebook password change invalidated EVERY token
// derived from that login at once — the Instagram token AND the page token
// (OAuth 190 subcode 460, "session has been invalidated"). Instagram recovered
// in minutes because its token lives in the DB and /api/ig-diag?settoken= swaps
// it without a deploy; Messenger stayed dead because its token only existed as
// a Vercel env var, which needs an env edit + redeploy the owner cannot do from
// his phone at 11pm.
//
// So the page token now lives in the same place, with the same escape hatch:
// row "fbtok|<setAtISO>|<token>" in platform_settings, env var as fallback.
// There is no refresh endpoint for page tokens (a long-lived page token derived
// from a long-lived user token does not expire on its own — it only dies when
// the password/session is invalidated), so this module is storage only.

const ROW_PREFIX = "fbtok|";
const TOKEN_CACHE_MS = 60_000;

let cached: { token: string; setAt: string | null; at: number } | null = null;

export async function readStoredPageToken(): Promise<{ token: string; setAt: string } | null> {
  const { data } = await supabaseAdmin
    .from("platform_settings")
    .select("platform")
    .like("platform", `${ROW_PREFIX}%`);
  const rows = (data ?? [])
    .map((r) => {
      const [, setAt, token] = String(r.platform).split("|");
      return setAt && token ? { token, setAt } : null;
    })
    .filter((r): r is { token: string; setAt: string } => !!r)
    .sort((a, b) => b.setAt.localeCompare(a.setAt));
  return rows[0] ?? null;
}

// The token every Messenger/Graph page call should use right now.
export async function getFacebookPageToken(): Promise<string> {
  if (cached && Date.now() - cached.at < TOKEN_CACHE_MS) return cached.token;
  try {
    const stored = await readStoredPageToken();
    if (stored) {
      cached = { token: stored.token, setAt: stored.setAt, at: Date.now() };
      return stored.token;
    }
  } catch (err) {
    console.error("[FB-TOKEN] read failed, falling back to env:", err);
  }
  const envTok = process.env.FACEBOOK_PAGE_TOKEN ?? "";
  cached = { token: envTok, setAt: null, at: Date.now() };
  return envTok;
}

// Store a new page token (validated by the caller) and drop older rows.
export async function setFacebookPageToken(token: string): Promise<void> {
  const clean = token.trim();
  if (!clean || clean.includes("|")) throw new Error("invalid token format");
  await supabaseAdmin
    .from("platform_settings")
    .insert({ platform: `${ROW_PREFIX}${new Date().toISOString()}|${clean}`, paused: false });
  const { data } = await supabaseAdmin
    .from("platform_settings")
    .select("platform")
    .like("platform", `${ROW_PREFIX}%`);
  const rows = (data ?? []).map((r) => String(r.platform)).sort().reverse();
  for (const old of rows.slice(1)) {
    await supabaseAdmin.from("platform_settings").delete().eq("platform", old);
  }
  cached = null;
}
