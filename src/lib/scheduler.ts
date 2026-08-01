import { createClient } from "@supabase/supabase-js";

const SCHEDULER_URL = "https://wtyezgfzzetfrhoaqemt.supabase.co";
const SCHEDULER_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0eWV6Z2Z6emV0ZnJob2FxZW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMzQwMDQsImV4cCI6MjA5MjkxMDAwNH0.hZ6WwgRqJ2SaRDpxCiIPpWZl-Awkm26cYjsq4XUwBq4";
const SCHEDULER_ID = "b9de3572-b50a-4185-9fd2-9e54f23e2e50";
const BOT_EMAIL = "ia@ozzifloors.com";
const BOT_PASSWORD = "OzziIA2026!";

interface Seller {
  id: string;
  name: string;
  priority: number;
  enabled_weekdays: number[];
  time_slots: string[];
  active: boolean;
}

interface BookingRow {
  seller_id: string | null;
  booking_date: string;
  booking_time: string;
}

export interface BookingRequest {
  clientName: string;
  clientPhone: string;
  clientAddress: string;
  bookingDate: string;
  bookingTime: string;
  notes?: string;
  creative?: string;
  creativeImage?: string; // imagem do anúncio (ads_context_data.photo_url)
  channel?: CanalDoBooking; // por onde a pessoa falou — NÃO é o anúncio
  instagramHandle?: string;
  igsid?: string;
}

// O calendário mostra este texto em "como nos conheceu?". Até 01/08/2026 TODO
// booking do agente nascia como "Instagram DM", inclusive Messenger e
// WhatsApp: a plataforma lia esse campo e escrevia "o cliente disse: Instagram"
// no cartão de quem tinha vindo do Facebook. Cada canal diz o seu.
export type CanalDoBooking = "instagram" | "facebook" | "whatsapp";

const ROTULO_CANAL: Record<CanalDoBooking, string> = {
  instagram: "Instagram DM",
  facebook: "Facebook Messenger",
  whatsapp: "WhatsApp",
};

export interface BookingResult {
  success: boolean;
  bookingId?: string;
  sellerName?: string;
  date?: string;
  time?: string;
  error?: string;
}

async function getAuthenticatedClient() {
  const db = createClient(SCHEDULER_URL, SCHEDULER_ANON_KEY, {
    auth: { persistSession: false },
  });
  const { error } = await db.auth.signInWithPassword({
    email: BOT_EMAIL,
    password: BOT_PASSWORD,
  });
  if (error) throw new Error(`Bot auth failed: ${error.message}`);
  return db;
}

function pickSellerForSlot(
  sellers: Seller[],
  bookings: BookingRow[],
  dateStr: string,
  slot: string
): Seller | null {
  const date = new Date(dateStr + "T12:00:00");
  const weekday = date.getDay();
  const candidates = sellers
    .filter(
      (s) =>
        s.active &&
        s.enabled_weekdays.includes(weekday) &&
        s.time_slots.includes(slot) &&
        !bookings.some(
          (b) =>
            b.seller_id === s.id &&
            b.booking_date === dateStr &&
            b.booking_time === slot
        )
    )
    .sort((a, b) => a.priority - b.priority);
  return candidates[0] ?? null;
}

export async function createBooking(req: BookingRequest): Promise<BookingResult> {
  try {
    const db = await getAuthenticatedClient();

    const today = easternTodayStr();

    // Guard: if this client already has an upcoming booking, block the duplicate.
    // Time-aware like the snapshot: a visit that already happened earlier TODAY
    // must not block a returning client from booking a NEW visit tonight.
    if (req.igsid) {
      const { data: existing } = await db
        .from("bookings")
        .select("id, booking_date, booking_time")
        .like("email", `ia-${req.igsid}@%`)
        .gte("booking_date", today);
      const { hour, minute } = easternNowHM();
      const nowMinutes = hour * 60 + minute;
      if ((existing ?? []).some((b) => visitStillUpcoming(b.booking_date, b.booking_time, today, nowMinutes))) {
        console.warn(`[createBooking] Duplicate blocked — ${req.igsid} already has an upcoming booking`);
        return { success: false, error: "already_booked" };
      }
    }

    const future = new Date();
    future.setMonth(future.getMonth() + 6);
    const futureStr = future.toISOString().slice(0, 10);

    const [{ data: sellersData }, { data: bookedData }] = await Promise.all([
      db
        .from("sellers")
        .select("id,name,priority,enabled_weekdays,time_slots,active")
        .eq("active", true)
        .order("priority", { ascending: true }),
      db.rpc("get_booked_slots", { _from: today, _to: futureStr }),
    ]);

    const sellers = (sellersData ?? []) as Seller[];
    const bookings = (bookedData ?? []) as BookingRow[];

    if (sellers.length === 0) {
      return { success: false, error: "No active sellers found." };
    }

    const seller = pickSellerForSlot(sellers, bookings, req.bookingDate, req.bookingTime);

    if (!seller) {
      return {
        success: false,
        error: `No availability for ${req.bookingDate} at ${req.bookingTime}.`,
      };
    }

    const { data, error } = await db
      .from("bookings")
      .insert({
        name: req.clientName.trim().slice(0, 100),
        email: `ia-${req.igsid || Date.now()}@instagram.ozzifloors.com`,
        phone: req.clientPhone.trim().slice(0, 30) || null,
        address: req.clientAddress.trim().slice(0, 300),
        referral_source: req.instagramHandle
          ? `${ROTULO_CANAL[req.channel ?? "instagram"]} — ${req.instagramHandle}`
          : ROTULO_CANAL[req.channel ?? "instagram"],
        source: req.creative ?? ROTULO_CANAL[req.channel ?? "instagram"],
        creative_url: req.creative ?? null,
        // a PEÇA do anúncio, quando a Meta mandou (ads_context_data.photo_url):
        // é ela que aparece na agenda da plataforma
        creative_urls: req.creativeImage ? [req.creativeImage] : [],
        scheduled_by: SCHEDULER_ID,
        notes: req.notes?.trim().slice(0, 1000) || null,
        booking_date: req.bookingDate,
        booking_time: req.bookingTime,
        seller_id: seller.id,
      })
      .select("id")
      .single();

    if (error) {
      console.error("Booking insert error:", error);
      return { success: false, error: error.message };
    }

    return {
      success: true,
      bookingId: data.id,
      sellerName: seller.name,
      date: req.bookingDate,
      time: req.bookingTime,
    };
  } catch (err) {
    console.error("Booking exception:", err);
    return { success: false, error: String(err) };
  }
}

export async function cancelBooking(bookingId: string): Promise<{ success: boolean; error?: string }> {
  try {
    const db = await getAuthenticatedClient();
    const { error } = await db.from("bookings").delete().eq("id", bookingId);
    if (error) {
      console.error("Cancel booking error:", error);
      return { success: false, error: error.message };
    }
    return { success: true };
  } catch (err) {
    console.error("Cancel booking exception:", err);
    return { success: false, error: String(err) };
  }
}

// Cancel the most recent future booking for a client by their igsid
// No SQL migration needed — finds booking via email pattern ia-{igsid}@...
export async function cancelClientBooking(igsid: string): Promise<{ success: boolean; cancelled?: number; error?: string }> {
  try {
    const db = await getAuthenticatedClient();
    const today = new Date().toISOString().slice(0, 10);

    const { data: bookings, error: fetchErr } = await db
      .from("bookings")
      .select("id, booking_date, booking_time")
      .like("email", `ia-${igsid}@%`)
      .gte("booking_date", today)
      .order("booking_date", { ascending: true })
      .order("booking_time", { ascending: true });

    if (fetchErr) return { success: false, error: fetchErr.message };
    if (!bookings || bookings.length === 0) return { success: false, error: "no_booking_found" };

    let cancelled = 0;
    for (const b of bookings) {
      const { error } = await db.from("bookings").delete().eq("id", b.id);
      if (!error) {
        cancelled++;
        console.log(`Cancelled booking ${b.id} on ${b.booking_date} at ${b.booking_time}`);
      }
    }

    return { success: cancelled > 0, cancelled };
  } catch (err) {
    console.error("cancelClientBooking exception:", err);
    return { success: false, error: String(err) };
  }
}

// Move a client's existing upcoming visit to a new date/time. SAFE ORDER: it
// creates the NEW booking first (copying the original client details so nothing
// is lost even if the address/phone are no longer in recent chat history), and
// ONLY deletes the old booking after the new one succeeds. If the new slot is
// unavailable, the old booking is left untouched so the client is never left
// without an appointment.
export async function rescheduleClientBooking(
  igsid: string,
  newDate: string,
  newTime: string,
  fallback?: { name?: string; phone?: string; address?: string; notes?: string }
): Promise<BookingResult & { rescheduled?: boolean }> {
  try {
    const db = await getAuthenticatedClient();
    const today = easternTodayStr();

    // 1. Find the existing upcoming booking(s) to move.
    const { data: olds, error: fetchErr } = await db
      .from("bookings")
      .select("id, name, phone, address, notes, source, creative_url, referral_source, booking_date, booking_time")
      .like("email", `ia-${igsid}@%`)
      .gte("booking_date", today)
      .order("booking_date", { ascending: true })
      .order("booking_time", { ascending: true });

    if (fetchErr) return { success: false, error: fetchErr.message };
    if (!olds || olds.length === 0) return { success: false, error: "no_booking_found" };
    const old = olds[0];

    // 2. Pick a seller for the new slot.
    const future = new Date();
    future.setMonth(future.getMonth() + 6);
    const futureStr = future.toISOString().slice(0, 10);
    const [{ data: sellersData }, { data: bookedData }] = await Promise.all([
      db.from("sellers").select("id,name,priority,enabled_weekdays,time_slots,active").eq("active", true).order("priority", { ascending: true }),
      db.rpc("get_booked_slots", { _from: today, _to: futureStr }),
    ]);
    const sellers = (sellersData ?? []) as Seller[];
    const bookings = (bookedData ?? []) as BookingRow[];
    const seller = pickSellerForSlot(sellers, bookings, newDate, newTime);
    if (!seller) return { success: false, error: `No availability for ${newDate} at ${newTime}.` };

    // 3. Create the NEW booking (copy original details, fall back to provided values).
    const { data: created, error: insErr } = await db
      .from("bookings")
      .insert({
        name: (old.name ?? fallback?.name ?? "Instagram Client").toString().trim().slice(0, 100),
        email: `ia-${igsid}@instagram.ozzifloors.com`,
        phone: (old.phone ?? fallback?.phone ?? "").toString().trim().slice(0, 30) || null,
        address: (old.address ?? fallback?.address ?? "").toString().trim().slice(0, 300),
        referral_source: old.referral_source ?? "Instagram DM",
        source: old.source ?? "Instagram DM",
        creative_url: old.creative_url ?? null,
        creative_urls: [],
        scheduled_by: SCHEDULER_ID,
        notes: ((fallback?.notes ?? old.notes ?? "").toString() + " | Rescheduled").trim().slice(0, 1000) || null,
        booking_date: newDate,
        booking_time: newTime,
        seller_id: seller.id,
      })
      .select("id")
      .single();

    if (insErr || !created) {
      console.error("Reschedule insert error:", insErr);
      return { success: false, error: insErr?.message ?? "insert_failed" };
    }

    // 4. New booking is in place — now remove the old one(s).
    let removed = 0;
    for (const b of olds) {
      if (b.id === created.id) continue;
      const { error: delErr } = await db.from("bookings").delete().eq("id", b.id);
      if (!delErr) removed++;
    }
    console.log(`[reschedule] ${igsid}: new ${newDate} ${newTime} (seller ${seller.name}), removed ${removed} old booking(s)`);

    return { success: true, rescheduled: true, bookingId: created.id, sellerName: seller.name, date: newDate, time: newTime };
  } catch (err) {
    console.error("rescheduleClientBooking exception:", err);
    return { success: false, error: String(err) };
  }
}

// ─── Eastern-time helpers ──────────────────────────────────────────────────
// The business runs on Miami / Eastern time, but the server runs in UTC. In the
// evening Eastern, UTC has already rolled to the next day, which made the bot
// think "today" was tomorrow (e.g. Thursday 9pm ET = Friday 1am UTC). All date
// and weekday math MUST be done in America/New_York.
const ET_TZ = "America/New_York";
const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Today's calendar date in Eastern, as YYYY-MM-DD.
export function easternTodayStr(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ET_TZ }).format(new Date());
}

// Current wall-clock hour/minute in Eastern.
function easternNowHM(): { hour: number; minute: number } {
  const p = new Intl.DateTimeFormat("en-US", { timeZone: ET_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date());
  const hour = parseInt(p.find((x) => x.type === "hour")?.value ?? "0", 10) % 24;
  const minute = parseInt(p.find((x) => x.type === "minute")?.value ?? "0", 10);
  return { hour, minute };
}

// Calendar fields for a YYYY-MM-DD string (anchored at UTC noon = deterministic).
function ymd(dateStr: string): { weekday: number; month: number; day: number; year: number } {
  const d = new Date(dateStr + "T12:00:00Z");
  return { weekday: d.getUTCDay(), month: d.getUTCMonth(), day: d.getUTCDate(), year: d.getUTCFullYear() };
}

// Add N days to a YYYY-MM-DD string, returning a YYYY-MM-DD string.
function addDaysStr(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ─── Weekday↔date reconciliation for the [BOOK] date ────────────────────────
// THE BUG (2026-07-16, Facebook client 6247 SW 139 Ave): the bot offered
// "Thursday at 7pm or Friday at 7pm this week", the client typed "Thursday is
// fine", and the visit was booked for FRIDAY 2026-07-17 instead of Thursday
// 2026-07-16 — a day late. The model is given the real schedule (each line
// "Weekday ... [YYYY-MM-DD]") and rule 16 says copy the date from the line whose
// weekday it promised, but it still sometimes writes the neighbouring day's date.
// NOTHING server-side checked it: processBookingCommand booked whatever date the
// model wrote. This guard is that missing check.
//
// It fires ONLY on a clear, unambiguous mismatch: when the CLIENT'S OWN last
// weekday word (their explicit pick, e.g. "Thursday is fine") disagrees with the
// weekday of the [BOOK] date. The model gets the WEEK right and the DAY wrong by
// one or two, so we snap to the NEAREST date carrying the client's weekday. When
// the client's message is ambiguous (names two weekdays, or none), we fall back
// to the bot's last single-weekday offer; if that is ambiguous too, we do NOT
// touch the date. Never books the past.
const WEEKDAY_PATTERNS: Array<[number, RegExp]> = [
  [0, /\b(sundays?|domingos?)\b/i],
  [1, /\b(mondays?|lunes|segundas?(?:[\s-]?feira)?)\b/i],
  [2, /\b(tuesdays?|tues|martes|ter[cç]as?(?:[\s-]?feira)?)\b/i],
  [3, /\b(wednesdays?|wed|mi[eé]rcoles|quartas?(?:[\s-]?feira)?)\b/i],
  [4, /\b(thursdays?|thurs?|jueves|quintas?(?:[\s-]?feira)?)\b/i],
  [5, /\b(fridays?|viernes|sextas?(?:[\s-]?feira)?)\b/i],
  [6, /\b(saturdays?|s[áa]bados?)\b/i],
];

// Distinct weekday numbers (0=Sun..6=Sat) named in a message, ignoring any
// injected [SYSTEM: ...] note (the schedule inside it lists every weekday).
export function weekdaysNamed(text: string): number[] {
  const clean = (text || "").split(/\n\n?\[SYSTEM:/)[0];
  const out: number[] = [];
  for (const [num, re] of WEEKDAY_PATTERNS) if (re.test(clean)) out.push(num);
  return out;
}

// A relative or explicit-date time reference ("today", "tomorrow", "the 17th",
// "July 17", "asap", "this weekend"). When the CLIENT counters a weekday offer
// with one of these and names NO weekday, the earlier weekday offer is STALE:
// the bot re-resolves to a concrete date ("today at 7pm") that carries no
// weekday word, and the model's booked date is trusted. Without this, a real
// case — bot offered "Friday", client said "can we do it today? we're booked
// tomorrow", bot booked today (Thursday) correctly — would be WRONGLY snapped to
// Friday by the stale offer (caught by the 2026-07-16 victim scan).
const RELATIVE_TERMS = /\b(today|tonight|tomorrow|day after tomorrow|this\s+(?:morning|afternoon|evening|week|weekend)|next\s+(?:week|weekend|month)|asap|as soon as possible|earliest|soonest|right now|hoy|ma[ñn]ana|esta\s+(?:tarde|noche|semana)|pr[oó]xima\s+semana|hoje|amanh[ãa])\b/i;
const DATE_NUMBER = /\b\d{1,2}(?:st|nd|rd|th)\b|\b(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\s+\d{1,2}\b/i;
function hasRelativeOrDateTerm(text: string): boolean {
  const clean = (text || "").split(/\n\n?\[SYSTEM:/)[0];
  return RELATIVE_TERMS.test(clean) || DATE_NUMBER.test(clean);
}

export type BookingReconciliation = {
  date: string;
  corrected: boolean;
  from?: string;
  intendedWeekday?: number;
  reason?: string;
};

export function reconcileBookingWeekday(
  bookingDate: string,
  history: Array<{ role: string; content: string }>
): BookingReconciliation {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(bookingDate || "")) return { date: bookingDate, corrected: false };
  const bookedWeekday = ymd(bookingDate).weekday;
  const msgs = history ?? [];

  // Scope the intent to the CURRENT scheduling round, anchored on the bot's last
  // slot offer (its last message naming any weekday). This is what stops a stale
  // weekday word from earlier in a long chat — or from before a reschedule — from
  // dragging a correct new date back to an old day: "you were on Thursday, want
  // Friday instead?" / "yes push it" must resolve to FRIDAY (the offer), not the
  // Thursday the client typed ten messages ago.
  let offerIdx = -1;
  let offerDays: number[] = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "assistant") continue;
    const days = weekdaysNamed(msgs[i].content);
    if (days.length >= 1) { offerIdx = i; offerDays = days; break; }
  }

  // Look at the CLIENT's messages in the current round (at/after the offer):
  // a single explicit weekday word (their pick) and whether they countered with
  // a relative/date term ("today", "the 17th") that makes the stale offer moot.
  const from = offerIdx >= 0 ? offerIdx : 0;
  let clientWeekday: number | null = null;
  let clientRelative = false;
  for (let i = from; i < msgs.length; i++) {
    if (msgs[i].role !== "user") continue;
    const days = weekdaysNamed(msgs[i].content);
    if (days.length === 1) clientWeekday = days[0]; // last single-weekday pick wins
    if (hasRelativeOrDateTerm(msgs[i].content)) clientRelative = true;
  }

  // Intent priority within the round:
  //  1. a weekday the CLIENT explicitly named (their pick) — always wins,
  //  2. else, if the client did NOT counter with a relative/date term, the
  //     offer's own weekday when it named exactly one,
  //  3. else (no offer at all) the client's last single-weekday word anywhere.
  // If the client countered with "today"/"tomorrow"/a date and named no weekday,
  // we have NO reliable weekday anchor → do not touch the model's date.
  let intended: number | null = null;
  if (clientWeekday !== null) {
    intended = clientWeekday;
  } else if (offerIdx >= 0 && offerDays.length === 1 && !clientRelative) {
    intended = offerDays[0];
  } else if (offerIdx < 0) {
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role !== "user") continue;
      const days = weekdaysNamed(msgs[i].content);
      if (days.length === 1 && !hasRelativeOrDateTerm(msgs[i].content)) { intended = days[0]; break; }
      if (days.length > 1 || hasRelativeOrDateTerm(msgs[i].content)) break;
    }
  }

  if (intended === null || intended === bookedWeekday) {
    return { date: bookingDate, corrected: false, intendedWeekday: intended ?? undefined };
  }

  // Snap to the NEAREST date carrying the intended weekday. Forward distance is
  // 1..6 (0 excluded since weekdays differ); the nearest of {forward, forward-7}.
  const forward = (((intended - bookedWeekday) % 7) + 7) % 7;
  const delta = Math.abs(forward) <= Math.abs(forward - 7) ? forward : forward - 7;
  let corrected = addDaysStr(bookingDate, delta);
  // Never book the past: if the nearest match already passed, take next week's.
  // A single +7 was not enough — a [BOOK] date more than a week stale still
  // landed in the past and quietly broke the "never books the past" guarantee
  // this guard advertises (booking-date-verify caught it once the frozen July
  // dates in its fixtures aged out). Roll until it is genuinely upcoming; the
  // date strictly increases each pass, so this always terminates.
  const todayStr = easternTodayStr();
  while (corrected < todayStr) corrected = addDaysStr(corrected, 7);

  return {
    date: corrected,
    corrected: corrected !== bookingDate,
    from: bookingDate,
    intendedWeekday: intended,
    reason: `client picked ${DAY_NAMES[intended]} but [BOOK] date ${bookingDate} is ${DAY_NAMES[bookedWeekday]}; snapped to ${corrected}`,
  };
}

// ─── Weekday↔date reconciliation for the OFFER TEXT the client actually reads ─
// THE BUG (5-day review, 2026-08-01): reconcileBookingWeekday only guards the
// [BOOK] payload, so a wrong date inside the SENTENCE we send was never checked.
// Four offers in the window named a weekday paired with someone else's date —
// "Thursday July 31" (July 31 was a Friday, John Schmidt 07-29), "Sunday
// August 3" twice (August 3 was a Monday, fcf81ab4 07-29 and Christina Terron
// 07-30). The client reads the DATE, writes it in their calendar, and shows up
// on the wrong day — or, as happened here, the bot contradicts itself one
// message later ("Sunday August 3" then "Sunday August 2").
//
// The weekday word is authoritative, exactly as reconcileBookingWeekday already
// treats it: the model picks the day it means and then miscounts the number.
// We snap the DAY NUMBER to the nearest date carrying the named weekday, and
// only when the two genuinely disagree. Anything we cannot parse with full
// confidence (no month, month spelled oddly, a date more than a week off) is
// left untouched — a silent no-op is always safer than a rewritten sentence.
const MONTH_PATTERNS: Array<[number, RegExp]> = [
  [0, /jan(?:uary|eiro)?|enero/i], [1, /feb(?:ruary|rero)?|fevereiro/i],
  [2, /mar(?:ch|zo|ço)?/i], [3, /apr(?:il)?|abril/i],
  [4, /may|mayo|maio/i], [5, /jun(?:e|io|ho)?/i],
  [6, /jul(?:y|io|ho)?/i], [7, /aug(?:ust)?|agosto/i],
  [8, /sep(?:t(?:ember)?)?|septiembre|setembro/i], [9, /oct(?:ober)?|octubre|outubro/i],
  [10, /nov(?:ember|iembre|embro)?/i], [11, /dec(?:ember)?|diciembre|dezembro/i],
];
const WEEKDAY_WORDS = "sundays?|domingos?|mondays?|lunes|segundas?|tuesdays?|tues|martes|ter[cç]as?|wednesdays?|wed|mi[eé]rcoles|quartas?|thursdays?|thurs?|jueves|quintas?|fridays?|viernes|sextas?|saturdays?|s[áa]bados?";
const MONTH_WORDS = "jan(?:uary|eiro)?|enero|feb(?:ruary|rero)?|fevereiro|mar(?:ch|zo|ço)?|apr(?:il)?|abril|may|mayo|maio|jun(?:e|io|ho)?|jul(?:y|io|ho)?|aug(?:ust)?|agosto|sep(?:t(?:ember)?)?|septiembre|setembro|oct(?:ober)?|octubre|outubro|nov(?:ember|iembre|embro)?|dec(?:ember)?|diciembre|dezembro";
// "Thursday July 31" / "Sunday, August 3rd" / "Friday the 31st of July"
const OFFER_WD_MONTH_DAY = new RegExp(`\\b(${WEEKDAY_WORDS})\\b([,\\s]+(?:the\\s+)?)(${MONTH_WORDS})(\\s+)(\\d{1,2})(st|nd|rd|th)?\\b`, "gi");
// "lunes 3 de agosto" / "domingo 2 de agosto"
const OFFER_WD_DAY_MONTH = new RegExp(`\\b(${WEEKDAY_WORDS})\\b(\\s+)(\\d{1,2})(\\s+de\\s+)(${MONTH_WORDS})\\b`, "gi");

function monthIndexOf(word: string): number | null {
  for (const [i, re] of MONTH_PATTERNS) if (re.test(word)) return i;
  return null;
}
function weekdayOf(word: string): number | null {
  for (const [num, re] of WEEKDAY_PATTERNS) if (re.test(word)) return num;
  return null;
}

export function reconcileOfferedDates(
  text: string,
  todayStr: string = easternTodayStr()
): { text: string; corrections: string[] } {
  const corrections: string[] = [];
  if (!text) return { text, corrections };
  const year = ymd(todayStr).year;

  // Returns the corrected day-of-month, or null when we should not touch it.
  const fixDay = (weekdayWord: string, monthWord: string, dayNum: number): number | null => {
    const wantWeekday = weekdayOf(weekdayWord);
    const month = monthIndexOf(monthWord);
    if (wantWeekday === null || month === null) return null;
    if (dayNum < 1 || dayNum > 31) return null;
    // The offer window is the next 21 days, so a month far from today means the
    // year rolls over (December offers reaching into January).
    const todayMonth = ymd(todayStr).month;
    const useYear = month < todayMonth - 6 ? year + 1 : month > todayMonth + 6 ? year - 1 : year;
    const stated = new Date(Date.UTC(useYear, month, dayNum, 12));
    if (stated.getUTCMonth() !== month) return null; // e.g. "February 31"
    // ONLY inside the 21-day window we actually offer. Outside it the date is
    // not ours to fix — it is the client's own proposal being echoed back, and
    // rewriting it changes what they said: "Lunes 3 de octubre no lo tengo en mi
    // calendario todavía" (Thaly Blanco 07-27) was the bot correctly telling a
    // client their October date is out of range, and an unbounded snap turned it
    // into "Lunes 5 de octubre" — a date nobody had mentioned.
    const statedStr = stated.toISOString().slice(0, 10);
    if (statedStr < todayStr || statedStr > addDaysStr(todayStr, 21)) return null;
    const have = stated.getUTCDay();
    if (have === wantWeekday) return null; // already consistent — no-op
    // Snap to the nearest date carrying the named weekday (±3 days max: the
    // model miscounts by a day or two, it does not pick a different week).
    const forward = (((wantWeekday - have) % 7) + 7) % 7;
    const delta = forward <= 3 ? forward : forward - 7;
    const snapped = new Date(stated.getTime() + delta * 86400000);
    if (snapped.getUTCMonth() !== month) return null; // would cross the month — leave it
    if (snapped.toISOString().slice(0, 10) < todayStr) return null; // never point at the past
    return snapped.getUTCDate();
  };

  let out = text.replace(OFFER_WD_MONTH_DAY, (whole, wd, sep, mo, gap, day, suffix) => {
    const fixed = fixDay(wd, mo, Number(day));
    if (fixed === null) return whole;
    corrections.push(`${wd} ${mo} ${day} -> ${fixed}`);
    return `${wd}${sep}${mo}${gap}${fixed}${suffix ? ordinalSuffix(fixed) : ""}`;
  });
  out = out.replace(OFFER_WD_DAY_MONTH, (whole, wd, gap, day, mid, mo) => {
    const fixed = fixDay(wd, mo, Number(day));
    if (fixed === null) return whole;
    corrections.push(`${wd} ${day} de ${mo} -> ${fixed}`);
    return `${wd}${gap}${fixed}${mid}${mo}`;
  });
  return { text: out, corrections };
}

function ordinalSuffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return ["th", "st", "nd", "rd"][n % 10] ?? "th";
}

// ─── Slot-confirmation guard: never book a slot the client never picked ─────
// THE BUG (2026-07-16, RODOLFO/guzman.1988): the bot offered "hoy jueves a las
// 11am o mañana viernes a las 9am", the client answered "Podemos aser un appt
// pero igual no estoy preparado" (never picked a slot), then volunteered his
// address and phone — and the bot sent "Cita confirmada" for Friday 9am, a slot
// the client NEVER chose. The SLOT CONFIRMATION RULE lived only in the prompt;
// nothing server-side enforced it, so an address+phone was enough for the model
// to invent a day/time. This guard is that missing enforcement.
//
// A [BOOK] is allowed ONLY when the client, after the bot's slot offer, gave a
// real slot signal: a clock time ("9am", "a las 11"), a day ("jueves", "today",
// "tomorrow"), an ordinal ("the first"), OR a plain yes when EXACTLY ONE slot was
// on the table. Address and phone are NOT slot selections. When no such signal
// exists, the booking is blocked and the client is asked to pick a day/time.
const CLOCK_TIME_TOKEN = /\b(\d{1,2})(?::\d{2})?\s*(am|pm)\b/gi;
// A bare "9:00" (colon + minutes, NO am/pm) IS a slot pick: "Let’s do
// 9:00–thank you" after a "9am or 1pm" offer carried no recognized time token,
// so the [BOOK] was blocked and the bot re-asked a day/time the client had
// already chosen (Brian Guilford, 2026-07-25). The colon requirement keeps
// street numbers ("11 NW 9th St") from ever counting as a time.
const SLOT_TIME_REF = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\b\d{1,2}:\d{2}\b|\ba\s+las?\s+\d{1,2}\b|\b[àa]s\s+\d{1,2}\b|\b\d{1,2}\s*(?:h|hs|hrs|horas?|o'?clock)\b|\bnoon\b|\bmediod[ií]a\b|\bmeio[-\s]?dia\b/i;
// "Let's do 9" — a bare colon-less hour counts as a pick ONLY when it matches
// an hour the bot actually offered, so "let's do 2 rooms" can never confirm.
const LETS_DO_HOUR = /\blet'?s\s+do\s+(?:it\s+at\s+)?(\d{1,2})(?::\d{2})?\b/i;
const SLOT_DAY_REF = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo|hoy|ma[ñn]ana|segunda|ter[çc]a|quarta|quinta|sexta|hoje|amanh[ãa])\b/i;
const SLOT_ORDINAL = /\b(?:the\s+)?(?:first|second|1st|2nd)\b|\b(?:el\s+|la\s+)?(?:primer[oa]?|segund[oa]?)\b|\bese\s+(?:horario|d[ií]a)\b|\besa\s+hora\b|\bthat\s+(?:one|time|day)\b/i;
const SLOT_AFFIRMATIVE = /\b(?:s[ií]|yes|yeah|yep|ok(?:ay)?|perfect(?:o)?|perfeito|claro|dale|vale|de acuerdo|works|sounds good|let'?s do it|hag[aá]moslo|me funciona|funciona|pode ser|combinado|est[aá]\s+bien|est[áa]\s+perfecto)\b/i;

export function clientConfirmedSlot(history: Array<{ role: string; content: string }>): boolean {
  const msgs = history ?? [];
  // Smart-quote normalization mirrors normalizeSmartPunct in ai.ts: phone
  // keyboards send U+2019 ("Let’s"), which silently breaks every `'?` regex
  // below (the Guilford case). Kept local so this file stays SDK-free.
  const strip = (c: string) => (c || "").replace(/[‘’ʼ´]/g, "'").split(/\n\n?\[SYSTEM:/)[0];

  // Every bot message that carries clock time(s). The FIRST one opens the
  // pick window. IMPORTANT: we must NOT anchor on the LAST such message — after
  // the client picks, the bot echoes the choice back ("Perfect, Sunday at 7pm
  // it is! What's the address?") and that echo also carries a clock time; using
  // it as the anchor would place the window AFTER the client's pick and block a
  // perfectly confirmed booking (caught live by the E2E replay, 2026-07-17).
  const offerIdxs: number[] = [];
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "assistant") continue;
    if ([...strip(msgs[i].content).matchAll(CLOCK_TIME_TOKEN)].length >= 1) offerIdxs.push(i);
  }
  const firstOffer = offerIdxs.length ? offerIdxs[0] : -1;

  // 1. The client themselves named a TIME (or a day / an ordinal pick) at any
  //    point from the first offer on → that is a real slot signal.
  const offeredHours = new Set<number>();
  for (const i of offerIdxs) {
    for (const t of strip(msgs[i].content).matchAll(CLOCK_TIME_TOKEN)) {
      offeredHours.add(parseInt(t[1], 10) % 12);
    }
  }
  const from = firstOffer >= 0 ? firstOffer + 1 : 0;
  for (let i = from; i < msgs.length; i++) {
    if (msgs[i].role !== "user") continue;
    const t = strip(msgs[i].content);
    if (SLOT_TIME_REF.test(t) || SLOT_DAY_REF.test(t) || SLOT_ORDINAL.test(t)) return true;
    const bareHour = t.match(LETS_DO_HOUR);
    if (bareHour && offeredHours.has(parseInt(bareHour[1], 10) % 12)) return true;
  }

  // 2. Exactly ONE slot on the table + a plain affirmative right after that
  //    offer → the "yes" unambiguously means that slot. Checked per offer
  //    window so a later echo cannot swallow the affirmative.
  for (let k = 0; k < offerIdxs.length; k++) {
    const idx = offerIdxs[k];
    const end = k + 1 < offerIdxs.length ? offerIdxs[k + 1] : msgs.length;
    const times = [...strip(msgs[idx].content).matchAll(CLOCK_TIME_TOKEN)];
    const distinct = new Set(times.map((t) => `${t[1]}${t[2].toLowerCase()}`)).size;
    if (distinct !== 1) continue;
    for (let i = idx + 1; i < end; i++) {
      if (msgs[i].role === "user" && SLOT_AFFIRMATIVE.test(strip(msgs[i].content))) return true;
    }
  }
  return false;
}

// Sent when we have address/phone but the client never picked a specific
// day/time: ask them to choose instead of inventing one.
export function needSlotConfirmationMessage(lang: "es" | "en"): string {
  return lang === "es"
    ? "¡Perfecto! Solo me falta confirmar el día y la hora, ¿cuál te queda mejor para la visita?"
    : "Perfect! I just need to confirm the day and time, which works best for you for the visit?";
}

// ─── Time-invention guard: never book an HOUR nobody ever mentioned ─────────
// THE BUG (2026-07-30, AXEL GONZALEZ, Messenger): the bot offered "el miércoles
// 29 a las 3pm o el jueves 30?" — Thursday carried NO times. The client answered
// "Jueves 30 me parece bien" (a valid day pick, so clientConfirmedSlot passed),
// and the model booked Thursday at 9am — an hour that never appeared anywhere in
// the conversation. The seller drove an hour to a 9am visit; the client had
// assumed 3pm. A [BOOK] time is only trustworthy when that clock hour was
// actually on the table: offered by the bot or typed by the client. Otherwise
// the model invented it.
export function bookedTimeSeenInConversation(
  history: Array<{ role: string; content: string }>,
  timeHHMM: string
): boolean {
  const m = /^(\d{1,2}):(\d{2})/.exec((timeHHMM ?? "").trim());
  if (!m) return true; // unparseable time → let the scheduler's own validation decide
  const h12 = parseInt(m[1], 10) % 12;
  const strip = (c: string) => (c || "").replace(/[‘’ʼ´]/g, "'").split(/\n\n?\[SYSTEM:/)[0];
  for (const msg of history ?? []) {
    const t = strip(msg.content);
    // "9am", "3 pm", "9:00am" — and bare "9:00" (colon keeps street numbers out)
    for (const tok of t.matchAll(/\b(\d{1,2})(?::\d{2})?\s*(?:am|pm)\b|\b(\d{1,2}):\d{2}\b/gi)) {
      if (parseInt(tok[1] ?? tok[2], 10) % 12 === h12) return true;
    }
    // "a las 9" / "às 9" (ES/PT) and "9 o'clock". (?:^|\W) instead of \b: JS
    // word boundaries are ASCII-only, so \b never matches before "às".
    for (const tok of t.matchAll(/(?:^|\W)(?:a\s+las?|[àa]s)\s+(\d{1,2})\b|\b(\d{1,2})\s*o'?clock\b/gi)) {
      if (parseInt(tok[1] ?? tok[2], 10) % 12 === h12) return true;
    }
    if (h12 === 0 && /\bnoon\b|\bmediod[ií]a\b|\bmeio[-\s]?dia\b/i.test(t)) return true;
  }
  return false;
}

// Sent when the client picked a day but the [BOOK] hour was never shown to them:
// re-offer with that day's REAL open times so the pick that follows is explicit.
export async function needTimeChoiceMessage(lang: "es" | "en", dateStr: string): Promise<string> {
  try {
    let slots = await getAvailableSlots(dateStr);
    if (dateStr === easternTodayStr()) {
      const nowET = easternNowHM();
      const cutoff = nowET.hour * 60 + nowET.minute + 30;
      slots = slots.filter((s) => {
        const [h, min] = s.split(":").map(Number);
        return h * 60 + min >= cutoff;
      });
    }
    const times = slots.slice(0, 4).map(fmt12);
    if (times.length > 0) {
      const sep = lang === "es" ? " o " : " or ";
      const list = times.length === 1 ? times[0] : `${times.slice(0, -1).join(", ")}${sep}${times[times.length - 1]}`;
      return lang === "es"
        ? `¡Perfecto! Para ese día tengo disponible ${list}, ¿a qué hora te queda mejor?`
        : `Perfect! For that day I have ${list} available, which time works best for you?`;
    }
  } catch (err) {
    console.error("needTimeChoiceMessage error:", err);
  }
  return needSlotConfirmationMessage(lang);
}

// Date context injected into the AI prompt — always Eastern, never UTC.
export function getEasternDateContext(): string {
  const todayStr = easternTodayStr();
  const tmrStr = addDaysStr(todayStr, 1);
  const t = ymd(todayStr);
  const tm = ymd(tmrStr);
  const { hour, minute } = easternNowHM();
  return `TODAY: ${DAY_NAMES[t.weekday]}, ${MONTH_NAMES[t.month]} ${t.day}, ${t.year} [${todayStr}]. TOMORROW: ${DAY_NAMES[tm.weekday]}, ${MONTH_NAMES[tm.month]} ${tm.day} [${tmrStr}]. Current time: ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} Eastern.`;
}

// True if this client (by igsid) already has ANY booking in the scheduler — past
// or future. Used to detect clients we already booked or already served (visit
// done) so the bot hands them to the team instead of re-engaging, even when the
// booking was made outside the bot (in person, manually) and the app flag is unset.
export async function hasExistingBooking(igsid: string): Promise<boolean> {
  try {
    const db = await getAuthenticatedClient();
    const { data } = await db
      .from("bookings")
      .select("id")
      .like("email", `ia-${igsid}@%`)
      .limit(1);
    return !!(data && data.length > 0);
  } catch (err) {
    console.error("hasExistingBooking error:", err);
    return false;
  }
}

export async function getRealAvailabilityContext(): Promise<string> {
  try {
    const db = await getAuthenticatedClient();

    const todayStr = easternTodayStr();
    // Show 21 days so the bot can book NEXT WEEK and beyond, not just this week.
    // It must never tell a client it "can't see" a future date that is bookable.
    const windowDays: string[] = Array.from({ length: 21 }, (_, i) => addDaysStr(todayStr, i));

    const fromStr = windowDays[0];
    const toStr = windowDays[windowDays.length - 1];

    const [{ data: sellersData }, { data: bookedData }] = await Promise.all([
      db
        .from("sellers")
        .select("id,name,priority,enabled_weekdays,time_slots,active")
        .eq("active", true)
        .order("priority", { ascending: true }),
      db.rpc("get_booked_slots", { _from: fromStr, _to: toStr }),
    ]);

    const sellers = (sellersData ?? []) as Seller[];
    const bookings = (bookedData ?? []) as BookingRow[];

    const lines: string[] = ["REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):"];

    const nowET = easternNowHM();
    const nowMinutesPlus30 = nowET.hour * 60 + nowET.minute + 30;

    let hasAnySlot = false;

    for (const dateStr of windowDays) {
      const { weekday, month, day, year } = ymd(dateStr);
      const displayDate = `${DAY_NAMES[weekday]}, ${MONTH_NAMES[month]} ${day}, ${year} [${dateStr}]`;

      const slotSet = new Set<string>();
      sellers.forEach((s) => {
        if (!s.active || !s.enabled_weekdays.includes(weekday)) return;
        s.time_slots.forEach((slot) => {
          const taken = bookings.some(
            (b) =>
              b.seller_id === s.id &&
              b.booking_date === dateStr &&
              b.booking_time === slot
          );
          if (!taken) slotSet.add(slot);
        });
      });

      // For today only: drop slots already past in Eastern time (30-min buffer)
      const isToday = dateStr === windowDays[0];
      const futureSlots = Array.from(slotSet).filter((slot) => {
        if (!isToday) return true;
        const [h, m] = slot.split(":").map(Number);
        return h * 60 + m >= nowMinutesPlus30;
      });

      const slots = futureSlots.sort();
      if (slots.length > 0) {
        hasAnySlot = true;
        const formatted = slots.map((s) => {
          const [h, min] = s.split(":").map(Number);
          const period = h >= 12 ? "pm" : "am";
          const h12 = h % 12 || 12;
          return `${h12}${min === 0 ? "" : `:${min}`}${period}`;
        });
        lines.push(`• ${displayDate}: ${formatted.join(", ")}`);
      } else {
        lines.push(`• ${displayDate}: fully booked`);
      }
    }

    if (!hasAnySlot) {
      lines.push("No availability in the next 21 days.");
    }

    lines.push(
      "\nIMPORTANT — read carefully before offering any time:" +
        "\n- ONLY offer times listed above. Never mention a time shown as 'fully booked'." +
        "\n- This list covers the next 21 days, so you CAN book next week and the week after. NEVER tell the client you cannot see, access, or open a future week's calendar — any date listed above is bookable." +
        "\n- When you name a weekday to the client (e.g. 'Friday' / 'viernes'), you MUST use the exact date in [brackets] shown on that SAME line, and ONLY the times listed on that same line." +
        "\n- When you offer day options, you MUST name open times for EVERY day you offer, taken from each day's own line (e.g. 'Wednesday at 3pm, or Thursday at 9am or 11am — which works?'). NEVER offer a day without stating its available times: the client can only pick a time you actually showed, and a booking is only valid after the client explicitly chose one of the listed times. Offering 'Wednesday at 3pm or Thursday?' is FORBIDDEN — the client may pick Thursday assuming 3pm while you book a different hour." +
        "\n- A SUMMARY OF availability is not a list of times and is equally FORBIDDEN. Never write 'Sunday with several options', 'Tuesday has plenty of availability', 'Wednesday has full availability from 9am to 7pm', 'both with plenty of times to choose from', or anything similar: a range or a count lets the client answer '10am' or '2pm' — hours that are not on the line and do not exist — and you then have to walk it back. Spell out the actual open times, comma-separated, for every day you name, however many there are." +
        "\n- If the same weekday appears on more than one line (e.g. two Tuesdays), use the SOONEST one, UNLESS the client says 'next week' or names a specific date, then use that line instead." +
        "\n- NEVER pair a weekday with a date from a different line. NEVER compute or guess a date yourself. The weekday name and the [YYYY-MM-DD] must always come from the same line above." +
        "\n- NEVER tell a client a time was 'just taken', is 'no longer available', or ask them to 'pick another time'. If a time is not listed, simply offer a different time that IS listed, naturally." +
        "\n- ONE EXCEPTION, and it is mandatory: if the client is ACCEPTING a day/time YOU offered earlier in this same conversation and that time is no longer on its line above, you must OWN IT in the first clause before anything else — a short apology that it filled up since you offered it — and only then name the real open times. Swapping their accepted slot for a different one with no acknowledgement is the worst thing you can do here: a client who confirmed 'Friday 7pm 👍' and sent his name, address and phone got back 'The soonest I have open is Sunday at 11am or 1pm' and replied 'I thought you said Friday at 7?' (Rolando, 2026-07-29) — the owner had to step in by hand. Say something like 'I'm sorry, that Friday 7pm filled up while we were talking — the closest I have now is Sunday at 11am or 1pm, which works?'. Never pretend the earlier offer did not happen, and never make the client be the one to notice." +
        "\n- Until the visit is actually confirmed, do NOT tell the client a time is 'locked in', 'all set' or 'confirmed'. Say you are holding it while you collect their name, address and phone. Nine clients in five days were told a slot was theirs and then had it taken away." +
        "\n- In the [BOOK:...] tag, copy the date as the exact [YYYY-MM-DD] from the line whose weekday matches what you told the client. If 'Friday' is [2026-06-05] above, the booking date is 2026-06-05, never 2026-06-06."
    );

    return lines.join("\n");
  } catch (err) {
    console.error("Failed to fetch availability:", err);
    return "AVAILABILITY: Could not fetch real-time schedule. Ask the client for their preferred day and check manually.";
  }
}

// Format a "HH:MM" 24h slot as a friendly 12h label (e.g. "13:30" -> "1:30pm").
function fmt12(slot: string): string {
  const [h, min] = slot.split(":").map(Number);
  const period = h >= 12 ? "pm" : "am";
  const h12 = h % 12 || 12;
  return `${h12}${min === 0 ? "" : `:${min}`}${period}`;
}

// The next days (within `maxDays`) that still have at least one open slot,
// soonest first. Same availability logic as getRealAvailabilityContext, but
// returns structured data so we can build a recovery offer. Today's already-past
// slots are dropped (30-min buffer), and fully-booked days are omitted.
export async function getNextOpenSlots(
  maxDays = 21
): Promise<Array<{ dateStr: string; weekday: number; times: string[] }>> {
  const db = await getAuthenticatedClient();
  const todayStr = easternTodayStr();
  const windowDays: string[] = Array.from({ length: maxDays }, (_, i) => addDaysStr(todayStr, i));
  const fromStr = windowDays[0];
  const toStr = windowDays[windowDays.length - 1];

  const [{ data: sellersData }, { data: bookedData }] = await Promise.all([
    db.from("sellers").select("id,name,priority,enabled_weekdays,time_slots,active").eq("active", true).order("priority", { ascending: true }),
    db.rpc("get_booked_slots", { _from: fromStr, _to: toStr }),
  ]);

  const sellers = (sellersData ?? []) as Seller[];
  const bookings = (bookedData ?? []) as BookingRow[];
  const nowET = easternNowHM();
  const nowMinutesPlus30 = nowET.hour * 60 + nowET.minute + 30;

  const out: Array<{ dateStr: string; weekday: number; times: string[] }> = [];
  for (const dateStr of windowDays) {
    const { weekday } = ymd(dateStr);
    const slotSet = new Set<string>();
    sellers.forEach((s) => {
      if (!s.active || !s.enabled_weekdays.includes(weekday)) return;
      s.time_slots.forEach((slot) => {
        const taken = bookings.some((b) => b.seller_id === s.id && b.booking_date === dateStr && b.booking_time === slot);
        if (!taken) slotSet.add(slot);
      });
    });
    const isToday = dateStr === windowDays[0];
    const times = Array.from(slotSet)
      .filter((slot) => {
        if (!isToday) return true;
        const [h, m] = slot.split(":").map(Number);
        return h * 60 + m >= nowMinutesPlus30;
      })
      .sort();
    if (times.length > 0) out.push({ dateStr, weekday, times });
  }
  return out;
}

const DAY_NAMES_ES = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// Recovery offer for when the slot the client confirmed turned out to be full.
// Instead of handing the lead to a human (the old behavior, which lost the
// client), offer the soonest OTHER open slot(s) from the real schedule, never
// saying the time was "taken". Returns null only when there is genuinely nothing
// open in the window, so the caller can fall back to the human handoff.
export async function slotConflictRecoveryMessage(lang: "es" | "en"): Promise<string | null> {
  try {
    const open = await getNextOpenSlots(21);
    if (open.length === 0) return null;
    const first = open[0];
    const times = first.times.slice(0, 2).map(fmt12);
    if (lang === "es") {
      const wd = DAY_NAMES_ES[first.weekday];
      const t = times.length >= 2 ? `${times[0]} o ${times[1]}` : times[0];
      return times.length >= 2
        ? `Lo más pronto que tengo disponible es el ${wd} a las ${t}. ¿Cuál te queda mejor?`
        : `Lo más pronto que tengo disponible es el ${wd} a las ${t}. ¿Te funciona?`;
    }
    const wd = DAY_NAMES[first.weekday];
    const t = times.length >= 2 ? `${times[0]} or ${times[1]}` : times[0];
    return times.length >= 2
      ? `The soonest I have open is ${wd} at ${t}, which works better for you?`
      : `The soonest I have open is ${wd} at ${t}, does that work for you?`;
  } catch (err) {
    console.error("slotConflictRecoveryMessage error:", err);
    return null;
  }
}

// ─── Client booking snapshot (upcoming vs past) ───────────────────────────
// The booking_confirmed flag on the conversation is a one-way latch, but a
// visit is a moment in time: once the booked date is behind us, the client is
// a normal person with a flooring need again. Before this, a client whose
// visit happened (or was missed) WEEKS ago still hit the silent post-booking
// path forever — new quote requests, callback requests, FAQ taps, and ad
// re-taps all died unanswered (4 real clients found in the 2026-07-21 review,
// one silent for 26 days). The webhooks use this snapshot to (a) keep the
// silence only while a visit is actually upcoming, and (b) answer "are you
// coming at 3?" style questions with the real booked date/time.
export type ClientBookingSnapshot = {
  upcoming: { date: string; time: string } | null; // earliest visit still ahead (incl. grace window)
  lastPast: { date: string; time: string } | null; // most recent visit already behind us
};

// A visit TODAY only counts as "upcoming" until this long after its start time.
// Date-only comparison kept a 1pm client silenced until MIDNIGHT: she came back
// at 6:30pm the same day asking about the materials package (post-visit
// shopping question, re-tapped the ad 3x) and hit the silent post-booking path
// (Lisa, Deerfield Beach, 2026-07-27). The grace window keeps the bot out of
// the way while Ozzi may still be en route or on site running late.
export const VISIT_UPCOMING_GRACE_MIN = 120;
export function visitStillUpcoming(dateStr: string, timeStr: string | null | undefined, todayStr: string, nowMinutes: number): boolean {
  if (dateStr > todayStr) return true;
  if (dateStr < todayStr) return false;
  const m = /^(\d{1,2}):(\d{2})/.exec((timeStr ?? "").trim());
  if (!m) return true; // no parseable start time: stay quiet for the rest of the day (fail safe, never fail chatty)
  return nowMinutes < parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + VISIT_UPCOMING_GRACE_MIN;
}

export async function getClientBookingSnapshot(igsid: string): Promise<ClientBookingSnapshot | null> {
  try {
    const db = await getAuthenticatedClient();
    const { data, error } = await db
      .from("bookings")
      .select("booking_date, booking_time")
      .like("email", `ia-${igsid}@%`)
      .order("booking_date", { ascending: false })
      .limit(25);
    if (error) {
      console.error("getClientBookingSnapshot error:", error.message);
      return null; // caller keeps the legacy behavior on lookup failure
    }
    const today = easternTodayStr();
    const { hour, minute } = easternNowHM();
    const nowMinutes = hour * 60 + minute;
    let upcoming: ClientBookingSnapshot["upcoming"] = null;
    let lastPast: ClientBookingSnapshot["lastPast"] = null;
    for (const b of data ?? []) {
      if (!b.booking_date) continue;
      if (visitStillUpcoming(b.booking_date, b.booking_time, today, nowMinutes)) {
        // rows come newest-first, so the LAST still-upcoming row is the earliest upcoming
        upcoming = { date: b.booking_date, time: b.booking_time ?? "" };
      } else if (!lastPast) {
        lastPast = { date: b.booking_date, time: b.booking_time ?? "" };
      }
    }
    return { upcoming, lastPast };
  } catch (err) {
    console.error("getClientBookingSnapshot exception:", err);
    return null;
  }
}

const MONTH_NAMES_ES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// Deterministic answer for a booked client asking about their OWN visit
// ("Are you coming at 3?", "Which day, Tuesday?"). No model involved, so it can
// never hallucinate a date: it restates the scheduler's real booking and opens
// the reschedule door. Two short sentences, no dashes, no emojis (owner rules).
export function visitDetailsMessage(lang: "es" | "en", dateStr: string, timeStr: string): string {
  const { weekday, month, day } = ymd(dateStr);
  const time = /^\d{1,2}:\d{2}$/.test((timeStr || "").trim()) ? fmt12(timeStr.trim()) : (timeStr || "").trim();
  const atTime = time ? (lang === "es" ? ` a las ${time}` : ` at ${time}`) : "";
  if (lang === "es") {
    return `Tu visita está confirmada para el ${DAY_NAMES_ES[weekday]} ${day} de ${MONTH_NAMES_ES[month]}${atTime}. Ozzi te avisa unos 40 minutos antes de llegar, y si necesitas mover la visita solo dime el nuevo día y hora.`;
  }
  return `Your visit is confirmed for ${DAY_NAMES[weekday]}, ${MONTH_NAMES[month]} ${day}${atTime}. Ozzi will message you about 40 minutes before arriving, and if you need to move the visit just tell me the new day and time.`;
}

// ─── Language detection + localized booking messages ──────────────────────
// Lightweight heuristic: decide whether the conversation is in Spanish or
// English so confirmation/recovery messages match the client's language.
export function detectLang(text: string): "es" | "en" {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return "en";
  let es = (t.match(/[áéíóúñ¿¡]/g) || []).length;
  let en = 0;
  const esWords = ["hola", "gracias", "cuánto", "cuanto", "precio", "piso", "casa", "área", "area", "necesito", "quiero", "buenas", "cita", "dirección", "direccion", "cocina", "cuarto", "metros", "usted", "mañana", "tengo", "viernes", "sábado", "sabado", "domingo", "lunes", "martes", "miércoles", "miercoles", "jueves", "para", "está", "esta", "pisos"];
  const enWords = ["hello", "thanks", "thank", "price", "floor", "house", "need", "want", "quote", "address", "kitchen", "room", "tomorrow", "morning", "would", "please", "available", "looking"];
  for (const w of esWords) if (new RegExp(`\\b${w}\\b`).test(t)) es++;
  for (const w of enWords) if (new RegExp(`\\b${w}\\b`).test(t)) en++;
  return es > en ? "es" : "en";
}

// Sent to the client after a booking is successfully created.
export function bookingSuccessMessage(lang: "es" | "en"): string {
  return lang === "es"
    ? "Cita confirmada. Te aviso aproximadamente 40 minutos antes de llegar a tu casa. Mi nombre es Ozzi."
    : "Appointment confirmed. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi.";
}

// Sent to the client when the booking could NOT be created (slot genuinely
// unavailable, scheduler error, etc.). Honest, never claims the slot was
// "just taken", and hands the lead to Ozzi so it is never lost.
export function bookingFailureHandoffMessage(lang: "es" | "en"): string {
  return lang === "es"
    ? "Disculpa, no pude confirmar ese horario en el sistema. Le aviso a Ozzi para que confirme tu cita directamente, en breve te contacta."
    : "Sorry, I couldn't lock in that exact time in the system. I'm having Ozzi confirm your appointment directly, you'll hear back shortly.";
}

// Placeholder names the AI drops into [BOOK] when it does not know the real one.
// These must never be saved as the booking name when we have the actual profile
// name on file.
const GENERIC_NAMES = new Set([
  "client", "instagram client", "facebook client", "whatsapp client", "customer",
  "cliente", "there", "friend", "guest", "user", "unknown", "sem nome", "no name",
]);

// Strip emoji/pictographs/symbols (keeps letters of any alphabet, e.g. Cyrillic)
// and collapse whitespace, so a profile name like "Линда ♎️" becomes "Линда".
function cleanName(s: string): string {
  return s
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2300}-\u{23FF}\u{2460}-\u{24FF}\u{25A0}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE00}-\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Resolve the best real client name for a booking from a priority list of
// candidates (e.g. the name the client typed → the saved profile name → the
// handle). Skips generic placeholders ("Client", "Instagram Client", etc.) and
// emoji-only strings, so a booking is never saved as just "Client" when we have
// the profile name. Falls back to `fallback` only if nothing real is available.
export function resolveClientName(candidates: Array<string | null | undefined>, fallback: string): string {
  for (const c of candidates) {
    const t = cleanName((c ?? "").toString());
    if (t && !GENERIC_NAMES.has(t.toLowerCase())) return t.slice(0, 100);
  }
  return fallback;
}

// Owner rule (2026-07-27): a visit is confirmed ONLY when the CLIENT gave all
// three of name, address, and phone in the conversation. A profile display name
// (IG/FB name, WhatsApp pushname) is NOT the client giving their name — the bot
// must ASK. This is the server-side enforcement: the [BOOK] name must be real
// (not a generic placeholder) AND at least one of its words must be something
// the client actually typed. Token-level comparison (accent/case-insensitive)
// so "José" matches a typed "jose" but "Ana" never matches inside "banana".
const deaccent = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const nameTokens = (s: string) => deaccent(s).split(/[^a-z0-9]+/).filter(Boolean);
export function clientProvidedName(name: string | null | undefined, history: Array<{ role: string; content: string }>): boolean {
  const cleaned = cleanName((name ?? "").toString());
  if (!cleaned || GENERIC_NAMES.has(cleaned.toLowerCase())) return false;
  const typed = new Set(
    (history ?? [])
      .filter((m) => m.role === "user")
      .flatMap((m) => nameTokens((m.content || "").split(/\n\n?\[SYSTEM:/)[0]))
  );
  return nameTokens(cleaned).some((w) => w.length >= 2 && !GENERIC_NAMES.has(w) && typed.has(w));
}

// Sent when the slot (and possibly address/phone) is in hand but the client
// never gave their name: ask for it instead of booking under a profile name.
export function needNameMessage(lang: "es" | "en"): string {
  return lang === "es"
    ? "¡Última cosita! ¿A nombre de quién pongo la visita?"
    : "Last thing! What name should I put the visit under?";
}

// True only when the string holds a real phone number (enough digits to dial).
// Guards against the model dropping a non-number into the phone field, e.g. the
// client says "Call me in Messenger" / "contact me here" and the AI booked with
// phone="Messenger". US numbers have 10 digits; require at least 7 to allow for
// odd formatting while rejecting words and obviously-too-short junk.
export function isRealPhoneNumber(phone?: string | null): boolean {
  if (!phone) return false;
  return (phone.match(/\d/g) || []).length >= 7;
}

// True only when the string plausibly is a REAL street address. Guards against
// the model dropping a placeholder into the address field to satisfy the "has
// address" check: a 2000-sqft visit was booked with address literally "pending"
// (fb_27019671124380652, 2026-07-17 review) — Ozzi had a Sunday visit with
// nowhere to go. US street addresses virtually always carry a street number, so
// require a digit, a minimum length, and no placeholder words.
const ADDRESS_PLACEHOLDER = /\b(?:pending|tbd|t\.b\.d|n\/?a|unknown|later|address|na later|to be|will send|not sure|pendiente|por confirmar|despu[eé]s|depois|luego|messenger|whatsapp|instagram|facebook)\b/i;
export function isRealAddress(address?: string | null): boolean {
  const t = (address ?? "").trim();
  if (t.length < 8) return false;
  if (!/\d/.test(t)) return false;
  if (ADDRESS_PLACEHOLDER.test(t) && t.length < 25) return false;
  return true;
}

// Sent when the slot is confirmed but we still need a usable street address.
// Asks for the ZIP in the same breath (owner rule 2026-08-01) so the client
// sends the complete address once instead of being asked twice.
export function needAddressMessage(lang: "es" | "en"): string {
  return lang === "es"
    ? "¡Perfecto! ¿Cuál es la dirección completa de la propiedad, con el código postal, para la visita?"
    : "Perfect! What's the full property address, including the zip code, for the visit?";
}

// Owner rule (2026-08-01): the visit is confirmed only with the client's NAME,
// the FULL address INCLUDING THE ZIP CODE, and the phone. A street address with
// no ZIP is ambiguous in South Florida (the same street name repeats across
// Miami-Dade, Broward and Palm Beach), so the crew ends up routing by guess.
//
// Pull the ZIP out of the address string. Two things must never be mistaken for
// a ZIP: the leading house number ("11417 SW 251st St ..."), and a 5-digit house
// number sitting mid-string ("Apt 2, 12345 NW 7th St, Miami FL 33125" → 33125).
const STREET_AFTER_NUMBER = /^[\s,]*(?:[nsew]{1,2}\.?[\s,]|\d+(?:st|nd|rd|th)\b|(?:[a-z'.]+[\s,]+){0,3}(?:st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|ct|court|way|ter|terrace|pl|place|hwy|highway|cir|circle|pkwy|parkway|calle|avenida)\b)/i;
export function extractZip(address?: string | null): string | null {
  const t = (address ?? "").toString();
  const re = /\b(\d{5})(?:-\d{4})?\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    if (m.index === 0) continue; // leading house number, never a ZIP
    if (!/[a-z]/i.test(t.slice(0, m.index))) continue; // only digits/punct before it
    if (STREET_AFTER_NUMBER.test(t.slice(m.index + m[0].length))) continue; // "12345 NW 7th St"
    return m[1];
  }
  return null;
}

// The address must also carry the STREET NUMBER (owner rule 2026-08-01: "tem
// que ser o endereço completo"). "Miami FL 33125" passes isRealAddress (it has
// digits) but is not an address anyone can drive to — the ZIP was the only
// number in it. Remove the ZIP first, then require a house number followed by
// the street name/directional.
export function addressHasStreetNumber(address?: string | null): boolean {
  let t = (address ?? "").toString();
  const zip = extractZip(t);
  if (zip) t = t.replace(new RegExp(`\\b${zip}(?:-\\d{4})?\\b`), " ");
  return /\b\d{1,6}[a-z]?\b[\s,.-]*[a-z]/i.test(t);
}

// True only when the [BOOK] address carries a ZIP the CLIENT actually typed in
// this conversation. Both halves matter: no ZIP at all → ask for it; a ZIP that
// never appears in any client message → the model inferred it from the city
// (the same invention failure that once produced a made-up 9am visit), so ask
// instead of shipping a routed-by-guess address.
export function bookingAddressHasZip(
  address: string | null | undefined,
  history?: Array<{ role: string; content: string }>
): boolean {
  const zip = extractZip(address);
  if (!zip) return false;
  if (!history || history.length === 0) return true;
  const seen = new RegExp(`\\b${zip}\\b`);
  return history.some(
    (m) => m.role === "user" && seen.test((m.content || "").split(/\n\n?\[SYSTEM:/)[0])
  );
}

// Sent when the slot, street address, name and phone are in hand but the ZIP is
// missing (or was invented by the model). Short and specific: the client only
// has to send five digits back.
export function needZipMessage(lang: "es" | "en"): string {
  return lang === "es"
    ? "¡Casi listo! ¿Cuál es el código postal de esa dirección?"
    : "Almost set! What's the zip code for that address?";
}

// Sent when we have the slot + address but still need a real callback number
// before booking (the client gave a non-number like "Messenger", or no phone).
export function needPhoneMessage(lang: "es" | "en"): string {
  return lang === "es"
    ? "¡Casi listo! ¿Cuál es el mejor número de teléfono para confirmarte la visita?"
    : "Almost set! What's the best phone number to reach you so I can lock in the visit?";
}

// Sent to the client after their visit is successfully moved to a new slot.
// The webhook already includes the new day/time around it via the AI, so this
// stays short and never repeats details that could drift from the real booking.
export function rescheduleSuccessMessage(lang: "es" | "en"): string {
  return lang === "es"
    ? "Listo, tu visita quedó reagendada. Te aviso aproximadamente 40 minutos antes de llegar. Mi nombre es Ozzi."
    : "All set, your visit has been rescheduled. I will notify you approximately 40 minutes before arriving. My name is Ozzi.";
}

// Sent to the client when the AI itself is unavailable (API down, credits
// exhausted, rate limited, timeout, network error). Without this, an AI outage
// means the client gets TOTAL SILENCE and the lead is lost. This keeps the
// client warm with an honest holding reply while the owner is notified and the
// conversation is handed to a human.
export function aiOutageHandoffMessage(lang: "es" | "en"): string {
  return lang === "es"
    ? "Gracias por tu mensaje! Le aviso a nuestro equipo y alguien te contacta en seguida."
    : "Thanks for your message! Let me get our team to reach out, someone will get right back to you.";
}

export async function getAvailableSlots(dateStr: string): Promise<string[]> {
  try {
    const db = await getAuthenticatedClient();
    const [{ data: sellersData }, { data: bookedData }] = await Promise.all([
      db
        .from("sellers")
        .select("id,name,priority,enabled_weekdays,time_slots,active")
        .eq("active", true)
        .order("priority", { ascending: true }),
      db.rpc("get_booked_slots", { _from: dateStr, _to: dateStr }),
    ]);

    const sellers = (sellersData ?? []) as Seller[];
    const bookings = (bookedData ?? []) as BookingRow[];
    const date = new Date(dateStr + "T12:00:00");
    const weekday = date.getDay();

    const slotSet = new Set<string>();
    sellers.forEach((s) => {
      if (!s.active || !s.enabled_weekdays.includes(weekday)) return;
      s.time_slots.forEach((slot) => {
        const taken = bookings.some(
          (b) =>
            b.seller_id === s.id &&
            b.booking_date === dateStr &&
            b.booking_time === slot
        );
        if (!taken) slotSet.add(slot);
      });
    });

    return Array.from(slotSet).sort();
  } catch {
    return ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"];
  }
}
