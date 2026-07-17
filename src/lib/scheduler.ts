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
  instagramHandle?: string;
  igsid?: string;
}

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

    // Guard: if this client already has an upcoming booking, block the duplicate
    if (req.igsid) {
      const { data: existing } = await db
        .from("bookings")
        .select("id")
        .like("email", `ia-${req.igsid}@%`)
        .gte("booking_date", today)
        .limit(1);
      if (existing && existing.length > 0) {
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
          ? `Instagram DM — ${req.instagramHandle}`
          : "Instagram DM",
        source: req.creative ?? "Instagram DM",
        creative_url: req.creative ?? null,
        creative_urls: [],
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
  if (corrected < easternTodayStr()) corrected = addDaysStr(corrected, 7);

  return {
    date: corrected,
    corrected: corrected !== bookingDate,
    from: bookingDate,
    intendedWeekday: intended,
    reason: `client picked ${DAY_NAMES[intended]} but [BOOK] date ${bookingDate} is ${DAY_NAMES[bookedWeekday]}; snapped to ${corrected}`,
  };
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
const SLOT_TIME_REF = /\b\d{1,2}(?::\d{2})?\s*(?:am|pm)\b|\ba\s+las?\s+\d{1,2}\b|\b[àa]s\s+\d{1,2}\b|\b\d{1,2}\s*(?:h|hs|hrs|horas?|o'?clock)\b|\bnoon\b|\bmediod[ií]a\b|\bmeio[-\s]?dia\b/i;
const SLOT_DAY_REF = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo|hoy|ma[ñn]ana|segunda|ter[çc]a|quarta|quinta|sexta|hoje|amanh[ãa])\b/i;
const SLOT_ORDINAL = /\b(?:the\s+)?(?:first|second|1st|2nd)\b|\b(?:el\s+|la\s+)?(?:primer[oa]?|segund[oa]?)\b|\bese\s+(?:horario|d[ií]a)\b|\besa\s+hora\b|\bthat\s+(?:one|time|day)\b/i;
const SLOT_AFFIRMATIVE = /\b(?:s[ií]|yes|yeah|yep|ok(?:ay)?|perfect(?:o)?|perfeito|claro|dale|vale|de acuerdo|works|sounds good|let'?s do it|hag[aá]moslo|me funciona|funciona|pode ser|combinado|est[aá]\s+bien|est[áa]\s+perfecto)\b/i;

export function clientConfirmedSlot(history: Array<{ role: string; content: string }>): boolean {
  const msgs = history ?? [];
  const strip = (c: string) => (c || "").split(/\n\n?\[SYSTEM:/)[0];

  // The bot's most recent message that offered clock time(s).
  let offerIdx = -1;
  let offeredCount = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "assistant") continue;
    const times = [...strip(msgs[i].content).matchAll(CLOCK_TIME_TOKEN)];
    if (times.length >= 1) {
      offerIdx = i;
      offeredCount = new Set(times.map((t) => `${t[1]}${t[2].toLowerCase()}`)).size;
      break;
    }
  }

  const from = offerIdx >= 0 ? offerIdx + 1 : 0;
  let sawAffirmative = false;
  for (let i = from; i < msgs.length; i++) {
    if (msgs[i].role !== "user") continue;
    const t = strip(msgs[i].content);
    if (SLOT_TIME_REF.test(t) || SLOT_DAY_REF.test(t) || SLOT_ORDINAL.test(t)) return true;
    if (SLOT_AFFIRMATIVE.test(t)) sawAffirmative = true;
  }
  // A bare "yes/ok" only confirms a slot when exactly ONE was offered.
  if (offeredCount === 1 && sawAffirmative) return true;
  return false;
}

// Sent when we have address/phone but the client never picked a specific
// day/time: ask them to choose instead of inventing one.
export function needSlotConfirmationMessage(lang: "es" | "en"): string {
  return lang === "es"
    ? "¡Perfecto! Solo me falta confirmar el día y la hora, ¿cuál te queda mejor para la visita?"
    : "Perfect! I just need to confirm the day and time, which works best for you for the visit?";
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
        "\n- If the same weekday appears on more than one line (e.g. two Tuesdays), use the SOONEST one, UNLESS the client says 'next week' or names a specific date, then use that line instead." +
        "\n- NEVER pair a weekday with a date from a different line. NEVER compute or guess a date yourself. The weekday name and the [YYYY-MM-DD] must always come from the same line above." +
        "\n- NEVER tell a client a time was 'just taken', is 'no longer available', or ask them to 'pick another time'. If a time is not listed, simply offer a different time that IS listed, naturally." +
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

// True only when the string holds a real phone number (enough digits to dial).
// Guards against the model dropping a non-number into the phone field, e.g. the
// client says "Call me in Messenger" / "contact me here" and the AI booked with
// phone="Messenger". US numbers have 10 digits; require at least 7 to allow for
// odd formatting while rejecting words and obviously-too-short junk.
export function isRealPhoneNumber(phone?: string | null): boolean {
  if (!phone) return false;
  return (phone.match(/\d/g) || []).length >= 7;
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
