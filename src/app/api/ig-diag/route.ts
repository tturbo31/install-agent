import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { isDashboardAuthorized, isStrongAdminSecret } from "@/lib/admin-auth";
import { getInstagramToken, setInstagramToken, refreshInstagramTokenIfDue } from "@/lib/ig-token";
import { getFacebookPageToken, setFacebookPageToken, readStoredPageToken } from "@/lib/fb-token";
import { sendInstagramMessage } from "@/lib/instagram";

export const maxDuration = 300;

// GET /api/ig-diag?secret=... — LIVE health check of the PRODUCTION Instagram
// send credentials (the 2026-07-22 outage: prod token expired and every IG
// reply silently vanished for 19 hours while the dashboard showed "answered").
// Reports, without sending anything to any client:
//   • the effective token (env vs DB-stored) validated against graph.instagram.com/me
//   • the Facebook page token + whether the Messenger bridge to IG is viable
//   • when the stored token was last refreshed
//
// Extra actions:
//   ?refresh=1                → force a token refresh now (extends 60-day expiry)
//   ?settoken=<token>         → STRONG secret. Validate a newly minted token and
//                               store it in the DB — takes effect in ≤60s, no
//                               deploy, no Vercel env edit.
//   ?setfbtoken=<token>       → STRONG secret. Same, for the Facebook PAGE token
//                               (Messenger). Added 2026-08-03: a password change
//                               invalidates both tokens at once, and the page
//                               token used to be env-only = deploy required.
//   ?rescue=1[&since=ISO][&dry=1] → STRONG secret. Re-send the bot replies that
//                               were stored but never delivered (phantom
//                               replies) since the token died. Dedupes via a
//                               platform_settings marker so it never
//                               double-sends. dry=1 only lists them.
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const secret = q.get("secret");
  if (!isDashboardAuthorized(secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const out: Record<string, unknown> = {};

  const checkIgToken = async (token: string | undefined | null) => {
    if (!token) return { present: false };
    try {
      const res = await fetch(
        `https://graph.instagram.com/v24.0/me?fields=id,username&access_token=${encodeURIComponent(token)}`
      );
      const body = await res.json().catch(() => ({}));
      return {
        present: true,
        valid: !body.error,
        username: body.username ?? null,
        error: body.error?.message ?? null,
      };
    } catch (e) {
      return { present: true, valid: false, error: String(e).slice(0, 200) };
    }
  };

  const checkFbToken = async (token: string | undefined | null) => {
    if (!token) return { present: false, valid: false, page: null, error: "absent" };
    try {
      const res = await fetch(
        `https://graph.facebook.com/v24.0/me?fields=id,name,instagram_business_account{id,username}&access_token=${encodeURIComponent(token)}`
      );
      const body = await res.json().catch(() => ({}));
      return {
        present: true,
        valid: !body.error,
        page: body.name ?? null,
        instagramLinked: body.instagram_business_account ?? null,
        error: body.error?.message ?? null,
      };
    } catch (e) {
      return { present: true, valid: false, page: null, error: String(e).slice(0, 200) };
    }
  };

  // ── settoken (strong gate: token injection is sensitive) ──
  const newToken = q.get("settoken");
  if (newToken) {
    if (!isStrongAdminSecret(secret)) {
      return NextResponse.json({ error: "settoken requires the strong ADMIN_SECRET" }, { status: 401 });
    }
    const check = await checkIgToken(newToken);
    if (!("valid" in check) || !check.valid) {
      return NextResponse.json({ settoken: "REJECTED — token is not valid", check }, { status: 400 });
    }
    await setInstagramToken(newToken);
    return NextResponse.json({ settoken: "OK — stored, effective within 60s", username: check.username });
  }

  // ── setfbtoken: same escape hatch for the Messenger page token ──
  // 2026-08-03: a Facebook password change killed the IG token AND the page
  // token at once. IG was back in minutes (DB-stored); Messenger needed a
  // Vercel env edit + redeploy. Now both swap from the phone.
  const newFbToken = q.get("setfbtoken");
  if (newFbToken) {
    if (!isStrongAdminSecret(secret)) {
      return NextResponse.json({ error: "setfbtoken requires the strong ADMIN_SECRET" }, { status: 401 });
    }
    const check = await checkFbToken(newFbToken);
    if (!check.valid) {
      return NextResponse.json({ setfbtoken: "REJECTED — token is not valid", check }, { status: 400 });
    }
    await setFacebookPageToken(newFbToken);
    return NextResponse.json({ setfbtoken: "OK — stored, effective within 60s", page: check.page });
  }

  // ── standard diagnosis ──
  const effective = await getInstagramToken();
  const envTok = process.env.INSTAGRAM_ACCESS_TOKEN ?? "";
  const { data: tokRows } = await supabaseAdmin
    .from("platform_settings")
    .select("platform")
    .like("platform", "igtok|%");
  const stored = (tokRows ?? [])
    .map((r) => String(r.platform).split("|"))
    .sort((a, b) => (b[1] ?? "").localeCompare(a[1] ?? ""))[0];

  out.instagram = {
    effectiveSource: stored && effective !== envTok ? "db" : "env",
    envToken: await checkIgToken(envTok),
    dbToken: stored ? { refreshedAt: stored[1], ...(await checkIgToken(stored[2])) } : { present: false },
  };

  const storedFb = await readStoredPageToken();
  const effectiveFb = await getFacebookPageToken();
  const envFb = process.env.FACEBOOK_PAGE_TOKEN ?? "";
  const fbCheck = await checkFbToken(effectiveFb);
  out.facebook = {
    effectiveSource: storedFb && effectiveFb !== envFb ? "db" : "env",
    storedAt: storedFb?.setAt ?? null,
    ...fbCheck,
    bridgeViable: fbCheck.valid && !!(fbCheck as { instagramLinked?: unknown }).instagramLinked,
  };

  if (q.get("refresh") === "1") {
    out.refresh = await refreshInstagramTokenIfDue(true);
  }

  // ── rescue: re-send stored-but-undelivered replies ──
  if (q.get("rescue") === "1") {
    if (!isStrongAdminSecret(secret)) {
      return NextResponse.json({ error: "rescue requires the strong ADMIN_SECRET" }, { status: 401 });
    }
    const dry = q.get("dry") === "1";
    const since = q.get("since") ?? "2026-07-21T19:35:00Z"; // token death time
    const results: Array<Record<string, unknown>> = [];

    const { data: convos } = await supabaseAdmin
      .from("instagram_conversations")
      .select("id, igsid, username, name, mode")
      .gte("updated_at", since)
      .not("igsid", "like", "wa\\_%")
      .not("igsid", "like", "fb\\_%");

    for (const c of convos ?? []) {
      const { data: msgs } = await supabaseAdmin
        .from("instagram_messages")
        .select("id, role, content, created_at")
        .eq("conversation_id", c.id)
        .order("created_at", { ascending: false })
        .limit(1);
      const last = msgs?.[0];
      // Only phantom replies: last message is a bot reply stored after the
      // token died. Paused convos are skipped — the owner already took over.
      if (!last || last.role !== "assistant" || last.created_at < since) continue;
      if (c.mode === "human") {
        results.push({ igsid: c.igsid, name: c.username ?? c.name, skipped: "mode=human (owner took over)" });
        continue;
      }
      const marker = `igrescue|${last.id}`;
      const { data: seen } = await supabaseAdmin
        .from("platform_settings")
        .select("platform")
        .eq("platform", marker)
        .maybeSingle();
      if (seen) {
        results.push({ igsid: c.igsid, name: c.username ?? c.name, skipped: "already rescued" });
        continue;
      }
      // O conteúdo armazenado carrega marcadores internos (ex.: a nudge de
      // follow-up termina em "\n\n[SYSTEM: FOLLOWUP_NUDGE]" para dedup). O
      // cliente recebe SÓ o texto — no primeiro resgate real (2026-07-22) o
      // marcador foi junto e apareceu na DM do cliente.
      const clientText = String(last.content).split(/\n\n?\[SYSTEM:/)[0].trim();
      if (!clientText) {
        results.push({ igsid: c.igsid, name: c.username ?? c.name, skipped: "marker-only content" });
        continue;
      }
      if (dry) {
        results.push({ igsid: c.igsid, name: c.username ?? c.name, wouldResend: clientText.slice(0, 120) });
        continue;
      }
      const sent = await sendInstagramMessage(c.igsid, clientText);
      if (sent.ok) {
        await supabaseAdmin.from("platform_settings").insert({ platform: marker, paused: false });
      }
      results.push({ igsid: c.igsid, name: c.username ?? c.name, sent: sent.ok, via: sent.via, error: sent.error ?? null });
    }
    out.rescue = { since, dry, count: results.length, results };
  }

  return NextResponse.json(out);
}
