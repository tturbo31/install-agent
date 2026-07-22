import { supabaseAdmin } from "@/lib/supabase";

// ─── Instagram access token: DB-first, self-refreshing ──────────────────────
// ROOT CAUSE (2026-07-22): the prod INSTAGRAM_ACCESS_TOKEN expired on
// 2026-07-21 12:35 PDT (OAuth 190) and every IG send since then silently
// failed while the dashboard kept showing "replied". An env var can only be
// fixed with a Vercel env edit + redeploy, so a dying token always means hours
// of silent downtime.
//
// Fix: the live token is stored in platform_settings (row-key pattern, same as
// the funil flags — the table only has the `platform` text column) and every
// Graph API call reads it from there, falling back to the env var. A daily
// refresh (piggybacked on the existing crons — Hobby plan caps us at 2 cron
// jobs) calls Instagram's refresh_access_token, which extends the 60-day
// expiry forever. Rotating the token no longer needs a deploy: POST it to
// /api/ig-diag?settoken=... and it takes effect within TOKEN_CACHE_MS.
//
// Row format: "igtok|<refreshedAtISO>|<token>" — pipes never occur in IG
// tokens or ISO timestamps.

const ROW_PREFIX = "igtok|";
const TOKEN_CACHE_MS = 60_000;
const REFRESH_AFTER_H = 24; // IG allows refresh once the token is ≥24h old

let cached: { token: string; refreshedAt: string | null; at: number } | null = null;

async function readStoredToken(): Promise<{ token: string; refreshedAt: string } | null> {
  const { data } = await supabaseAdmin
    .from("platform_settings")
    .select("platform")
    .like("platform", `${ROW_PREFIX}%`);
  const rows = (data ?? [])
    .map((r) => {
      const [, refreshedAt, token] = String(r.platform).split("|");
      return refreshedAt && token ? { token, refreshedAt } : null;
    })
    .filter((r): r is { token: string; refreshedAt: string } => !!r)
    .sort((a, b) => b.refreshedAt.localeCompare(a.refreshedAt));
  return rows[0] ?? null;
}

// The token every Instagram Graph call should use right now.
export async function getInstagramToken(): Promise<string> {
  if (cached && Date.now() - cached.at < TOKEN_CACHE_MS) return cached.token;
  try {
    const stored = await readStoredToken();
    if (stored) {
      cached = { token: stored.token, refreshedAt: stored.refreshedAt, at: Date.now() };
      return stored.token;
    }
  } catch (err) {
    console.error("[IG-TOKEN] read failed, falling back to env:", err);
  }
  const envTok = process.env.INSTAGRAM_ACCESS_TOKEN ?? "";
  cached = { token: envTok, refreshedAt: null, at: Date.now() };
  return envTok;
}

// Store a new token (validated by the caller) and drop older rows.
export async function setInstagramToken(token: string): Promise<void> {
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

export type IgTokenRefreshResult = {
  attempted: boolean;
  ok: boolean;
  detail: string;
};

// Refresh the stored long-lived token if it is due (>24h since last refresh).
// Called opportunistically from the daily crons; `force` from /api/ig-diag.
// An expired token CANNOT be refreshed (Meta rejects it) — that case surfaces
// in the result so the diag endpoint can tell the owner a new login is needed.
export async function refreshInstagramTokenIfDue(force = false): Promise<IgTokenRefreshResult> {
  try {
    const stored = await readStoredToken();
    const current = stored?.token ?? process.env.INSTAGRAM_ACCESS_TOKEN ?? "";
    if (!current) return { attempted: false, ok: false, detail: "no token configured" };

    if (!force && stored?.refreshedAt) {
      const ageH = (Date.now() - Date.parse(stored.refreshedAt)) / 3_600_000;
      if (ageH < REFRESH_AFTER_H) {
        return { attempted: false, ok: true, detail: `fresh (${ageH.toFixed(1)}h old)` };
      }
    }

    const url = new URL("https://graph.instagram.com/refresh_access_token");
    url.searchParams.set("grant_type", "ig_refresh_token");
    url.searchParams.set("access_token", current);
    const res = await fetch(url.toString());
    const body = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: { message?: string; code?: number };
    };

    if (body.access_token) {
      await setInstagramToken(body.access_token);
      const days = body.expires_in ? Math.round(body.expires_in / 86_400) : null;
      console.log(`[IG-TOKEN] refreshed OK${days ? ` (expires in ~${days}d)` : ""}`);
      return { attempted: true, ok: true, detail: `refreshed${days ? `, expires in ~${days}d` : ""}` };
    }
    const msg = body.error?.message ?? `HTTP ${res.status}`;
    console.error("[IG-TOKEN] refresh FAILED:", msg);
    return { attempted: true, ok: false, detail: msg };
  } catch (err) {
    console.error("[IG-TOKEN] refresh exception:", err);
    return { attempted: true, ok: false, detail: String(err).slice(0, 200) };
  }
}
