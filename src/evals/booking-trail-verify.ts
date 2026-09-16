/**
 * Rastro de agendamentos (booktrail|…) — 16/09/2026.
 *
 * Com a rota removida, o log route|book|… (fonte da auditoria de 14/09 para
 * bookings APAGADOS pelo cancelamento) deixou de existir. Este rastro grava,
 * em platform_settings do app, uma linha por evento: visita criada pelo bot
 * (book / reschedule, só depois de vencer a corrida de slot) e linha apagada
 * por este código (cancel / reschedule-old), com o id da visita para casar
 * criação e remoção.
 *
 * Puro + estático:
 *  1. bookingTrailKey: formato, hora normalizada (14:00:00 / 2pm → 14:00),
 *     "|" nunca vaza para dentro dos campos, tamanho < 250.
 *  2. bookingTrailExpired: só o que passou de BOOKING_TRAIL_KEEP_DAYS.
 *  3. igsidFromBookingEmail: ia-<igsid>@… → igsid.
 *  4. scheduler.ts: "book" DEPOIS da corrida de slot em createBooking;
 *     "reschedule" depois da corrida + "reschedule-old" por antiga apagada;
 *     "cancel" por linha apagada em cancelClientBooking (select traz seller_id)
 *     e em cancelBooking(id) (lê antes de apagar); GC só em booktrail|%.
 * Ao vivo (só se SUPABASE do app estiver no .env.local): insere uma linha
 *  booktrail|test|… e apaga em seguida, conferindo { error, count }.
 * Run: npx tsx src/evals/booking-trail-verify.ts
 */
import { readFileSync } from "fs";
import { join } from "path";
import { bookingTrailKey, bookingTrailExpired, igsidFromBookingEmail, BOOKING_TRAIL_KEEP_DAYS } from "../lib/scheduler";

function loadEnv() {
  try {
    const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    for (const line of content.split("\n")) {
      const t = line.trim(); if (!t || t.startsWith("#")) continue;
      const i = t.indexOf("="); if (i === -1) continue;
      const k = t.slice(0, i).trim(); const v = t.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      if (k && !process.env[k]) process.env[k] = v;
    }
  } catch {}
}
loadEnv();

let pass = 0, fail = 0; const fails: string[] = [];
function ck(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ❌ ${name}  «${(detail || "").replace(/\s+/g, " ").slice(0, 300)}»`); }
}

async function run() {
  console.log("\n━━ 1. bookingTrailKey ━━");
  const now = new Date("2026-09-16T18:00:00.000Z");
  const k1 = bookingTrailKey("book", { igsid: "1234567890", date: "2026-09-17", time: "14:00:00", seller: "Alexandre", bookingId: "abc-123" }, now);
  ck("formato booktrail|kind|igsid|data hora|vendedor|id|ts", k1 === "booktrail|book|1234567890|2026-09-17 14:00|Alexandre|abc-123|2026-09-16T18:00:00.000Z", k1);
  const k2 = bookingTrailKey("cancel", { igsid: "x", date: "2026-09-17", time: "2pm", seller: "Diego", bookingId: "id" }, now);
  ck("hora '2pm' vira 14:00", /\|2026-09-17 14:00\|/.test(k2), k2);
  const k3 = bookingTrailKey("reschedule-old", { igsid: null, date: "2026-09-17", time: "09:00", seller: "A|B", bookingId: null }, now);
  ck("campos vazios viram '?' e '|' dentro do campo vira '/'", /^booktrail\|reschedule-old\|\?\|2026-09-17 09:00\|A\/B\|\?\|/.test(k3) && k3.split("|").length === 7, k3);
  const long = bookingTrailKey("book", { igsid: "i".repeat(200), date: "2026-09-17", time: "09:00", seller: "s".repeat(200), bookingId: "b".repeat(200) }, now);
  ck("chave cabe em platform_settings (< 250) e termina no timestamp", long.length < 250 && long.endsWith("|2026-09-16T18:00:00.000Z"), String(long.length));

  console.log("\n━━ 2. bookingTrailExpired ━━");
  const nowMs = Date.parse("2026-09-16T18:00:00.000Z");
  ck(`keep days >= 45 (${BOOKING_TRAIL_KEEP_DAYS})`, BOOKING_TRAIL_KEEP_DAYS >= 45);
  ck("linha de ontem NÃO expira", !bookingTrailExpired("booktrail|book|i|2026-09-15 09:00|A|b|2026-09-15T18:00:00.000Z", nowMs));
  ck(`linha com ${BOOKING_TRAIL_KEEP_DAYS + 1} dias expira`, bookingTrailExpired(`booktrail|book|i|2026-07-01 09:00|A|b|${new Date(nowMs - (BOOKING_TRAIL_KEEP_DAYS + 1) * 86400000).toISOString()}`, nowMs));
  ck("linha sem timestamp válido nunca expira (não apaga o que não entende)", !bookingTrailExpired("booktrail|book|i|2026-07-01 09:00|A|b|lixo", nowMs));

  console.log("\n━━ 3. igsidFromBookingEmail ━━");
  ck("ia-<igsid>@instagram.ozzifloors.com → igsid", igsidFromBookingEmail("ia-1234567890@instagram.ozzifloors.com") === "1234567890");
  ck("e-mail humano → null", igsidFromBookingEmail("maria@gmail.com") === null && igsidFromBookingEmail(null) === null);

  console.log("\n━━ 4. scheduler.ts: onde o rastro entra ━━");
  const s = readFileSync(join(process.cwd(), "src/lib/scheduler.ts"), "utf-8");
  ck("createBooking: 'book' só DEPOIS de insertLostSlotRace", /insertLostSlotRace\(db, data\.id, seller\.id, req\.bookingDate, req\.bookingTime\)\)\s*\{[\s\S]{0,200}\}\s*logBookingTrail\("book", \{ igsid: req\.igsid \?\? null, date: req\.bookingDate, time: req\.bookingTime, seller: seller\.name, bookingId: data\.id \}\);/.test(s));
  ck("reschedule: 'reschedule' só DEPOIS da corrida", /insertLostSlotRace\(db, created\.id, seller\.id, newDate, newTime\)\)\s*\{[\s\S]{0,200}\}\s*logBookingTrail\("reschedule", \{ igsid, date: newDate, time: newTime, seller: seller\.name, bookingId: created\.id \}\);/.test(s));
  ck("reschedule: 'reschedule-old' por antiga apagada (dentro do !delErr)", /if \(!delErr\) \{\s*removed\+\+;\s*logBookingTrail\("reschedule-old", \{ igsid, date: b\.booking_date, time: b\.booking_time, seller: [^}]+, bookingId: b\.id \}\);/.test(s));
  ck("reschedule: select das antigas traz seller_id", /referral_source, booking_date, booking_time, seller_id"\)/.test(s));
  ck("cancelClientBooking: select traz seller_id e 'cancel' por linha apagada", /select\("id, booking_date, booking_time, address, seller_id"\)/.test(s) && /Cancelled booking \$\{b\.id\}[^\n]*\n\s*logBookingTrail\("cancel", \{ igsid, date: b\.booking_date, time: b\.booking_time, seller: [^}]+, bookingId: b\.id \}\);/.test(s));
  ck("cancelBooking(id): lê a linha antes e grava 'cancel' depois do delete", /select\("id, email, booking_date, booking_time, seller_id"\)\.eq\("id", bookingId\)\.maybeSingle\(\);\s*const \{ error \} = await db\.from\("bookings"\)\.delete\(\)\.eq\("id", bookingId\);[\s\S]{0,300}if \(row\) logBookingTrail\("cancel", \{ igsid: igsidFromBookingEmail\(row\.email\)/.test(s));
  ck("GC só toca em booktrail|% e usa bookingTrailExpired", /like\("platform", "booktrail\|%"\)/.test(s) && /if \(bookingTrailExpired\(r\.platform\)\) await supabaseAdmin\.from\("platform_settings"\)\.delete\(\)\.eq\("platform", r\.platform\)/.test(s));
  ck("persistência é best-effort (void + warn, nunca throw)", /void supabaseAdmin\s*\.from\("platform_settings"\)\s*\.insert\(\{ platform: key, paused: false \}\)/.test(s) && /\[booktrail\] persist failed/.test(s));
  ck("nenhum resto do log da rota (logRouteDecision / GC de route|%)", !/logRouteDecision/.test(s) && !/like\("platform", "route\|/.test(s));

  console.log("\n━━ 5. ao vivo: escreve e apaga uma linha de teste ━━");
  if (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL) {
    const { supabaseAdmin } = await import("../lib/supabase");
    const key = bookingTrailKey("book", { igsid: "eval-test", date: "2000-01-01", time: "09:00", seller: "Eval", bookingId: "eval" });
    const testKey = key.replace("booktrail|book|", "booktrail|test|");
    const { error: insErr } = await supabaseAdmin.from("platform_settings").insert({ platform: testKey, paused: false });
    ck("insert da linha de teste sem erro", !insErr, insErr?.message);
    const { data: found } = await supabaseAdmin.from("platform_settings").select("platform").eq("platform", testKey);
    ck("linha de teste legível de volta", (found ?? []).length === 1);
    const { error: delErr, count } = await supabaseAdmin.from("platform_settings").delete({ count: "exact" }).eq("platform", testKey);
    ck("linha de teste apagada (error null, count 1)", !delErr && count === 1, `${delErr?.message ?? ""} count=${count}`);
  } else {
    console.log("  (sem SUPABASE_URL no ambiente — etapa ao vivo pulada)");
  }

  console.log(`\n${fail === 0 ? "✅" : "❌"} booking-trail-verify: ${pass} passed, ${fail} failed`);
  if (fail) { console.log("FAILS:\n - " + fails.join("\n - ")); process.exit(1); }
}
run().catch((e) => { console.error(e); process.exit(1); });
