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
        email: `ia-${Date.now()}@instagram.ozzifloors.com`,
        phone: req.clientPhone.trim().slice(0, 30) || null,
        address: req.clientAddress.trim().slice(0, 300),
        referral_source: "Instagram",
        source: "Instagram DM",
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
