import { supabaseAdmin } from "@/lib/supabase";

// ─── Marketing API (ads) token: DB-first (same pattern as ig-token/fb-token) ──
// ROOT CAUSE (2026-09-23): the ads token (META_ADS_TOKEN) is the SAME user
// token the platform uses; a Facebook password change invalidated it at once
// (OAuth 190/460). It only existed as a Vercel env var, so swapping it needed
// an env edit + redeploy in two projects — and the Vercel login on the
// assistant's machine had expired. Instagram and Messenger tokens already
// live in platform_settings and swap without a deploy; the ads token now does
// the same: row "adstok|<setAtISO>|<token>", env var as fallback.
//
// The platform (ozzi-plataforma) pushes the token here through
// /api/ig-diag?setadstoken=... every time the owner pastes a new one in /config.

const ROW_PREFIX = "adstok|";
const TOKEN_CACHE_MS = 60_000;

let cached: { token: string; setAt: string | null; at: number } | null = null;

export async function readStoredAdsToken(): Promise<{ token: string; setAt: string } | null> {
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

// The token every Marketing API call (ad → creative/campaign name, ad
// templates) should use right now. Empty string = nothing configured.
export async function getAdsToken(): Promise<string> {
  if (cached && Date.now() - cached.at < TOKEN_CACHE_MS) return cached.token;
  try {
    const stored = await readStoredAdsToken();
    if (stored) {
      cached = { token: stored.token, setAt: stored.setAt, at: Date.now() };
      return stored.token;
    }
  } catch (err) {
    console.error("[ADS-TOKEN] read failed, falling back to env:", err);
  }
  const envTok = process.env.META_ADS_TOKEN ?? "";
  cached = { token: envTok, setAt: null, at: Date.now() };
  return envTok;
}

// Store a new ads token (validated by the caller) and drop older rows.
export async function setAdsToken(token: string): Promise<void> {
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
