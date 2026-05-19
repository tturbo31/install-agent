import { createClient } from "@supabase/supabase-js";

const SCHEDULER_SUPABASE_URL = "https://wtyezgfzzetfrhoaqemt.supabase.co";
const SCHEDULER_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0eWV6Z2Z6emV0ZnJob2FxZW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMzQwMDQsImV4cCI6MjA5MjkxMDAwNH0.hZ6WwgRqJ2SaRDpxCiIPpWZl-Awkm26cYjsq4XUwBq4";

const SCHEDULER_ID = "b9de3572-b50a-4185-9fd2-9e54f23e2e50";
const ALEXANDRE_ID = "8aa8842e-c903-42b3-aa11-28252024713f";
const DIEGO_ID = "c6fcb045-b914-4bd1-8d2d-bb7f49e90ff4";

const db = createClient(SCHEDULER_SUPABASE_URL, SCHEDULER_ANON_KEY);

export interface BookingRequest {
  clientName: string;
  clientPhone: string;
  clientAddress: string;
  bookingDate: string; // YYYY-MM-DD
  bookingTime: string; // HH:MM
  notes?: string;
}

export interface BookingResult {
  success: boolean;
  bookingId?: string;
  sellerName?: string;
  date?: string;
  time?: string;
  error?: string;
}

async function isSlotTaken(sellerId: string, date: string, time: string): Promise<boolean> {
  const { data } = await db
    .from("bookings")
    .select("id")
    .eq("seller_id", sellerId)
    .eq("booking_date", date)
    .eq("booking_time", time);
  return (data ?? []).length > 0;
}

export async function createBooking(req: BookingRequest): Promise<BookingResult> {
  try {
    // Try Alexandre first, then Diego (priority by seller)
    const sellers = [
      { id: ALEXANDRE_ID, name: "Alex" },
      { id: DIEGO_ID, name: "Diego" },
    ];

    let selectedSeller = null;

    for (const seller of sellers) {
      const taken = await isSlotTaken(seller.id, req.bookingDate, req.bookingTime);
      if (!taken) {
        selectedSeller = seller;
        break;
      }
    }

    if (!selectedSeller) {
      return { success: false, error: "No available slots for the requested date and time." };
    }

    const { data, error } = await db
      .from("bookings")
      .insert({
        name: req.clientName,
        email: `ai-booked-${Date.now()}@instagram.ozzifloors.com`,
        phone: req.clientPhone,
        address: req.clientAddress,
        referral_source: "Instagram",
        source: "Instagram DM",
        scheduled_by: SCHEDULER_ID,
        notes: req.notes ?? null,
        booking_date: req.bookingDate,
        booking_time: req.bookingTime,
        seller_id: selectedSeller.id,
      })
      .select("id")
      .single();

    if (error) {
      console.error("Booking error:", error);
      return { success: false, error: error.message };
    }

    return {
      success: true,
      bookingId: data.id,
      sellerName: selectedSeller.name,
      date: req.bookingDate,
      time: req.bookingTime,
    };
  } catch (err) {
    console.error("Booking exception:", err);
    return { success: false, error: "Failed to create booking." };
  }
}

export async function getAvailableSlots(date: string): Promise<string[]> {
  const allSlots = ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"];

  const { data: bookedAlex } = await db
    .from("bookings")
    .select("booking_time")
    .eq("seller_id", ALEXANDRE_ID)
    .eq("booking_date", date);

  const { data: bookedDiego } = await db
    .from("bookings")
    .select("booking_time")
    .eq("seller_id", DIEGO_ID)
    .eq("booking_date", date);

  const alexBooked = new Set((bookedAlex ?? []).map((b) => b.booking_time));
  const diegoBooked = new Set((bookedDiego ?? []).map((b) => b.booking_time));

  // A slot is available if either Alex or Diego is free
  return allSlots.filter((slot) => !alexBooked.has(slot) || !diegoBooked.has(slot));
}
