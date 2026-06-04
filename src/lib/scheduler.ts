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

    const today = new Date().toISOString().slice(0, 10);

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

export async function getRealAvailabilityContext(): Promise<string> {
  try {
    const db = await getAuthenticatedClient();

    const today = new Date();
    const next10Days: string[] = [];
    for (let i = 0; i < 10; i++) {
      const d = new Date(today);
      d.setDate(today.getDate() + i);
      next10Days.push(d.toISOString().slice(0, 10));
    }

    const fromStr = next10Days[0];
    const toStr = next10Days[next10Days.length - 1];

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

    const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const lines: string[] = ["REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):"];

    let hasAnySlot = false;

    for (const dateStr of next10Days) {
      const date = new Date(dateStr + "T12:00:00");
      const weekday = date.getDay();
      const dayName = dayNames[weekday];
      const [y, , d] = dateStr.split("-");
      const displayDate = `${dayName}, ${monthNames[date.getMonth()]} ${parseInt(d)}, ${y} [${dateStr}]`;

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

      // For today: filter out slots that are already past (add 30-min buffer)
      const nowPlus30 = new Date(Date.now() + 30 * 60 * 1000);
      const isToday = dateStr === new Date().toISOString().slice(0, 10);
      const futureSlots = Array.from(slotSet).filter((slot) => {
        if (!isToday) return true;
        const [h, m] = slot.split(":").map(Number);
        const slotTime = new Date();
        slotTime.setHours(h, m, 0, 0);
        return slotTime >= nowPlus30;
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
      lines.push("No availability in the next 10 days.");
    }

    lines.push(
      "\nIMPORTANT — read carefully before offering any time:" +
        "\n- ONLY offer times listed above. Never mention a time shown as 'fully booked'." +
        "\n- When you name a weekday to the client (e.g. 'Friday' / 'viernes'), you MUST use the exact date in [brackets] shown on that SAME line, and ONLY the times listed on that same line." +
        "\n- NEVER pair a weekday with a date from a different line. NEVER compute or guess a date yourself. The weekday name and the [YYYY-MM-DD] must always come from the same line above." +
        "\n- In the [BOOK:...] tag, copy the date as the exact [YYYY-MM-DD] from the line whose weekday matches what you told the client. If 'Friday' is [2026-06-05] above, the booking date is 2026-06-05, never 2026-06-06."
    );

    return lines.join("\n");
  } catch (err) {
    console.error("Failed to fetch availability:", err);
    return "AVAILABILITY: Could not fetch real-time schedule. Ask the client for their preferred day and check manually.";
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
