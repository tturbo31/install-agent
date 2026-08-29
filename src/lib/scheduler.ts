import { createClient } from "@supabase/supabase-js";
import {
  getRouteConfig,
  rankSellersForSlot,
  rankSlotsForDay,
  pickSlotsByRoute,
  travelMatrix,
  buildRoutePriorityNote,
  buildZipFirstNote,
  zipAlreadyAskedInHistory,
  clientLocationFromHistory,
  locationFromAddress,
  toExistingVisits,
  logRouteDecision,
  optionForLog,
  slotMinutes,
  estimateMinutes,
  fillRateOf,
  type DayRanking,
  type ExistingVisit,
  type RouteSeller,
} from "./route-optimizer";
import { type GeoPoint, geoKey, isServiceAreaZip } from "./geo/zip-geo";

const SCHEDULER_URL = "https://wtyezgfzzetfrhoaqemt.supabase.co";
const SCHEDULER_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind0eWV6Z2Z6emV0ZnJob2FxZW10Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMzQwMDQsImV4cCI6MjA5MjkxMDAwNH0.hZ6WwgRqJ2SaRDpxCiIPpWZl-Awkm26cYjsq4XUwBq4";
const SCHEDULER_ID = "b9de3572-b50a-4185-9fd2-9e54f23e2e50";
const BOT_EMAIL = "ia@ozzifloors.com";
const BOT_PASSWORD = "OzziIA2026!";

export interface Seller {
  id: string;
  name: string;
  priority: number;
  enabled_weekdays: number[];
  time_slots: string[];
  // Grade de horarios ESPECIFICA de um dia da semana ("0"=domingo ... "6"=sabado).
  // Quando o dia aparece aqui, ela SUBSTITUI time_slots naquele dia.
  weekday_time_slots?: Record<string, string[]> | null;
  active: boolean;
}

interface BookingRow {
  seller_id: string | null;
  booking_date: string;
  booking_time: string;
}

// ─── Folgas (seller_days_off) ──────────────────────────────────────────────
// A Ozzi Plataforma registra dias de folga por vendedor e um trigger do banco
// BLOQUEIA qualquer insert de booking nesse dia (code 23514, "Vendedor esta de
// folga em ..."). Até 19/08/2026 o cálculo de disponibilidade não lia essa
// tabela: com o Diego de folga na quinta 20/08, o agente ofereceu "jueves 1pm,
// 3pm, 5pm o 7pm" inteiramente em cima da agenda dele — só as 3pm existiam de
// verdade — e o [BOOK] da Mayra Rosabal estourou no trigger e caiu no handoff.
// TODA leitura de disponibilidade e escolha de vendedor exclui quem está de
// folga no dia.
type DaysOffSet = Set<string>; // chaves "sellerId|YYYY-MM-DD"

const dayOffKey = (sellerId: string, dateStr: string) => `${sellerId}|${dateStr}`;

async function getDaysOff(
  db: Awaited<ReturnType<typeof getAuthenticatedClient>>,
  from: string,
  to: string
): Promise<DaysOffSet> {
  // Falha na query = fail-open (sem folgas): oferecer um slot que o trigger
  // ainda bloqueia é recuperável (o webhook oferece alternativas reais);
  // esconder a agenda inteira não é. E SEMPRE checar { error } — o PostgREST
  // devolve data null em silêncio.
  const { data, error } = await db
    .from("seller_days_off")
    .select("seller_id,day")
    .gte("day", from)
    .lte("day", to);
  if (error) {
    console.error("seller_days_off fetch error:", error.message);
    return new Set();
  }
  return new Set(
    ((data ?? []) as Array<{ seller_id: string; day: string }>).map((r) => dayOffKey(r.seller_id, r.day))
  );
}

// Horarios do vendedor NAQUELE dia da semana. A Ozzi Plataforma guarda uma
// grade padrao (time_slots) e, opcionalmente, uma grade por dia da semana
// (weekday_time_slots: {"0":["09:00",...]}). Ate 2026-08-28 o agente lia SO a
// grade padrao: o Diego trabalha 14/16/18/20 na semana mas 09..19 no DOMINGO,
// e a agenda do bot oferecia domingo as 2pm, 4pm, 6pm e 8pm — horarios que nao
// existem. Quem escolhia um deles recebia "Sorry, I couldn't lock in that exact
// time in the system" porque o trigger da plataforma recusa o insert
// (P0001 "Horario 14:00 indisponivel para este vendedor neste dia").
// Caso Chanju-lyn Mwase, Messenger 2026-08-28: domingo 2pm, todos os dados
// dados pela cliente, nenhuma visita gravada.
// Semantica: se o dia estiver presente no override, ELE manda — inclusive uma
// lista vazia, que significa "esse vendedor nao atende nesse dia".
export function slotsForWeekday(s: Seller, weekday: number): string[] {
  const override = s.weekday_time_slots?.[String(weekday)];
  const list = Array.isArray(override) ? override : s.time_slots;
  return (list ?? []).filter((t): t is string => typeof t === "string").map(hhmm);
}

// Regra única de "este vendedor pode atender (dia, horário)?" — usada tanto na
// escolha de vendedor do [BOOK] quanto nas três leituras de disponibilidade.
// Antes cada uma repetia o filtro por conta própria e nenhuma conhecia folga.
export function sellerOpenForSlot(
  s: Seller,
  dateStr: string,
  weekday: number,
  slot: string,
  bookings: BookingRow[],
  daysOff: DaysOffSet
): boolean {
  return (
    s.active &&
    s.enabled_weekdays.includes(weekday) &&
    slotsForWeekday(s, weekday).includes(slot) &&
    !daysOff.has(dayOffKey(s.id, dateStr)) &&
    !bookings.some(
      (b) => b.seller_id === s.id && b.booking_date === dateStr && b.booking_time === slot
    )
  );
}

// Postgres 23514 = violação de check/trigger. É assim que a plataforma bloqueia
// agendamento em dia de folga — indisponibilidade de agenda, não erro de
// sistema. O caller converte para a classe "No availability" para o webhook
// oferecer horários reais em vez do handoff sem saída.
export function isScheduleBlockedError(
  err: { code?: string | null; message?: string | null } | null | undefined
): boolean {
  if (!err) return false;
  // P0001 = RAISE EXCEPTION do trigger da plataforma. E assim que ela recusa um
  // horario que nao existe na grade daquele dia ("Horario 14:00 indisponivel
  // para este vendedor neste dia"). Do nosso lado isso e indisponibilidade: o
  // webhook oferece os horarios REAIS em vez do handoff sem saida (caso Chanju,
  // Messenger 2026-08-28).
  return (
    err.code === "23514" ||
    err.code === "P0001" ||
    /de folga|day off|agendamento bloqueado|indispon[ií]vel para este vendedor|hor[áa]rio .{0,12}indispon/i.test(err.message ?? "")
  );
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
  slot: string,
  daysOff: DaysOffSet
): Seller | null {
  const date = new Date(dateStr + "T12:00:00");
  const weekday = date.getDay();
  const candidates = sellers
    .filter((s) => sellerOpenForSlot(s, dateStr, weekday, slot, bookings, daysOff))
    .sort((a, b) => a.priority - b.priority);
  return candidates[0] ?? null;
}

// ─── Escolha de vendedor COM ROTA (regra do dono, 27/08/2026) ───────────────
// pickSellerForSlot continua sendo a regra atual (o primeiro por priority entre
// os livres). Esta versão pega EXATAMENTE os mesmos candidatos e, quando há mais
// de um, deixa o Route Score (route-optimizer.ts) decidir: menor tempo vindo do
// compromisso anterior + indo para o próximo, com penalidade de zigue-zague.
// Empate dentro da tolerância → priority, como hoje. Qualquer erro (banco,
// mapas, endereço sem ZIP) → pickSellerForSlot puro. Nunca devolve null quando
// a regra atual devolveria alguém: a rota prioriza, jamais bloqueia.
type SchedulerDb = Awaited<ReturnType<typeof getAuthenticatedClient>>;
type VisitRow = { seller_id: string | null; booking_date: string; booking_time: string; address: string | null; email?: string | null };

// Visitas fixas (com endereço) da janela. O booking do PRÓPRIO cliente (ia-<igsid>@)
// fica de fora: numa remarcação o slot antigo dele ainda existe e, a 0 min de
// distância, puxaria a escolha para o mesmo vendedor sem motivo.
async function fetchVisitsWithAddress(db: SchedulerDb, from: string, to: string, excludeIgsid?: string | null): Promise<VisitRow[]> {
  const { data, error } = await db
    .from("bookings")
    .select("seller_id,booking_date,booking_time,address,email")
    .gte("booking_date", from)
    .lte("booking_date", to)
    .is("cancelled_at", null);
  if (error) throw new Error(`bookings(address) fetch: ${error.message}`);
  const own = excludeIgsid ? `ia-${excludeIgsid}@` : null;
  return ((data ?? []) as VisitRow[]).filter((r) => !own || !(r.email ?? "").startsWith(own));
}

async function pickSellerForSlotRouted(
  db: SchedulerDb,
  sellers: Seller[],
  bookings: BookingRow[],
  dateStr: string,
  slot: string,
  daysOff: DaysOffSet,
  ctx: { clientAddress?: string | null; igsid?: string | null; kind: "book" | "reschedule" }
): Promise<Seller | null> {
  const weekday = new Date(dateStr + "T12:00:00").getDay();
  const candidates = sellers
    .filter((s) => sellerOpenForSlot(s, dateStr, weekday, slot, bookings, daysOff))
    .sort((a, b) => a.priority - b.priority);
  if (candidates.length === 0) return null;
  const cfg = getRouteConfig();
  const client = locationFromAddress(ctx.clientAddress);
  if (!cfg.enabled || candidates.length === 1 || !client) {
    logRouteDecision({
      kind: ctx.kind, igsid: ctx.igsid ?? null, date: dateStr, slot, zip: client?.zip ?? null, clientLabel: client?.label ?? null,
      chosenSeller: candidates[0].name, chosenScore: null, chosenTier: null, provider: "none",
      reason: !cfg.enabled ? "route optimization disabled" : candidates.length === 1 ? "single candidate (current rules)" : "client location unknown (no ZIP/city in address) → current priority order",
      options: candidates.map((c) => ({ seller: c.name, priority: c.priority })),
    }, cfg.enabled);
    return candidates[0];
  }
  const started = Date.now();
  try {
    const rows = await fetchVisitsWithAddress(db, dateStr, dateStr, ctx.igsid);
    const visits = toExistingVisits(rows);
    const { ranked, matrix } = await rankSellersForSlot({ client, slot, candidates: candidates.map(asRouteSeller), visits, cfg, allSellers: sellers.map(asRouteSeller) });
    const winner = ranked[0];
    const seller = candidates.find((s) => s.id === winner.seller.id) ?? candidates[0];
    const byPriority = candidates[0];
    logRouteDecision({
      kind: ctx.kind, igsid: ctx.igsid ?? null, date: dateStr, slot, zip: client.zip ?? null, clientLabel: client.label ?? null,
      chosenSeller: seller.name, chosenScore: winner.route.score, chosenTier: winner.route.tier, provider: matrix.provider, fallback: matrix.fallbackReason ?? null,
      reason: winner.preferred
        ? `preferred seller (fill ${seller.name}'s agenda first; ${winner.route.neutral ? "no visits yet that day (neutral)" : `route viable, ${winner.route.score} min`}${winner.route.gapFill ? ", fills a gap" : ""})`
        : seller.id === byPriority.id
          ? (winner.equivalentToBest && ranked.length > 1 && ranked[1].equivalentToBest ? "tie within tolerance → current priority rule" : "best route (also first by priority)")
          : `best route beats priority order (${byPriority.name} would have been ${ranked.find((r) => r.seller.id === byPriority.id)?.route.score ?? "?"} min)`,
      options: ranked.map(optionForLog), ms: Date.now() - started,
    }, true);
    return seller;
  } catch (err) {
    console.error("[route] seller pick failed — falling back to priority order:", err);
    logRouteDecision({ kind: ctx.kind, igsid: ctx.igsid ?? null, date: dateStr, slot, zip: client.zip ?? null, chosenSeller: candidates[0].name, provider: "none", reason: `fallback: ${String((err as Error)?.message ?? err)}`, ms: Date.now() - started }, true);
    return candidates[0];
  }
}

const asRouteSeller = (s: Seller): RouteSeller => ({ id: s.id, name: s.name, priority: s.priority });

// Minimum notice for a SAME-DAY visit, in Eastern minutes. A seller has to see
// the booking, finish what they are doing and drive there; the platform’s
// "40 minutes before" reminder also needs the booking to exist before that
// window opens. 30 minutes was never enough (Rowan Hobbs, 2026-08-23: offered
// at 4:25pm for 5pm, booked 4:28pm, seller cancelled at 5:19pm, client thought
// it was a scam).
export const SAME_DAY_MIN_NOTICE_MIN = 120;
export function isSameDaySlotTooSoon(slotHHMM: string, nowMinutes: number): boolean {
  const m = /^(\d{1,2}):(\d{2})$/.exec((slotHHMM || "").trim());
  if (!m) return false;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10) < nowMinutes + SAME_DAY_MIN_NOTICE_MIN;
}

// Owner alert for a visit just booked for TODAY. The platform’s "40 minutes
// before" reminder cannot be relied on for a short-notice booking, and the
// seller may be mid-visit elsewhere — someone has to see it NOW (Rowan Hobbs,
// 2026-08-23: booked 4:28pm for 5pm, seller cancelled at 5:19pm, nobody told
// the client). Null when the visit is not today or is more than 4h away.
export function sameDayBookingAlert(dateStr: string, timeStr: string, sellerName?: string | null): string | null {
  if (dateStr !== easternTodayStr()) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec((timeStr || "").trim());
  if (!m) return null;
  const { hour, minute } = easternNowHM();
  const diff = parseInt(m[1], 10) * 60 + parseInt(m[2], 10) - (hour * 60 + minute);
  if (diff > 4 * 60) return null;
  const em = diff >= 60 ? `${Math.floor(diff / 60)}h${diff % 60 ? String(diff % 60).padStart(2, "0") : ""}` : `${Math.max(0, diff)} min`;
  return `VISITA HOJE às ${fmt12(timeStr)} (daqui a ~${em}), marcada agora${sellerName ? ` para ${sellerName}` : ""}. Confirme que o vendedor viu a agenda.`;
}

export async function createBooking(req: BookingRequest): Promise<BookingResult> {
  try {
    const db = await getAuthenticatedClient();

    const today = easternTodayStr();

    // Server-side backstop for the same-day notice: even if a too-soon slot
    // slipped into the offer (stale availability text, client-proposed time),
    // never write a visit nobody can reach. The webhooks treat this like any
    // other "No availability" and re-offer real slots.
    if (req.bookingDate === today) {
      const { hour, minute } = easternNowHM();
      if (isSameDaySlotTooSoon(req.bookingTime, hour * 60 + minute)) {
        console.warn(`[createBooking] Same-day slot ${req.bookingTime} is less than ${SAME_DAY_MIN_NOTICE_MIN} min away — blocked`);
        return { success: false, error: `No availability for ${req.bookingDate} at ${req.bookingTime} (too soon).` };
      }
    }

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

    const [{ data: sellersData }, { data: bookedData }, daysOff] = await Promise.all([
      db
        .from("sellers")
        .select("id,name,priority,enabled_weekdays,time_slots,weekday_time_slots,active")
        .eq("active", true)
        .order("priority", { ascending: true }),
      db.rpc("get_booked_slots", { _from: today, _to: futureStr }),
      getDaysOff(db, req.bookingDate, req.bookingDate),
    ]);

    const sellers = (sellersData ?? []) as Seller[];
    const bookings = (bookedData ?? []) as BookingRow[];

    if (sellers.length === 0) {
      return { success: false, error: "No active sellers found." };
    }

    // Rota (27/08/2026): mesmos candidatos da regra atual; entre eles, o de
    // melhor deslocamento; empate → priority. Falha → regra atual.
    const seller = await pickSellerForSlotRouted(db, sellers, bookings, req.bookingDate, req.bookingTime, daysOff, {
      clientAddress: req.clientAddress,
      igsid: req.igsid ?? null,
      kind: "book",
    });

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
      // Trigger da plataforma (folga registrada DEPOIS da nossa leitura, ou
      // regra de agenda que não modelamos): é indisponibilidade, não pane —
      // devolve a classe "No availability" para o webhook oferecer horários
      // reais em vez do handoff sem saída (caso Mayra, 19/08/2026).
      if (isScheduleBlockedError(error)) {
        return { success: false, error: `No availability for ${req.bookingDate} at ${req.bookingTime}.` };
      }
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
// Returns the cancelled visits' details (date/time/address) so the webhook can
// CONFIRM to the client exactly which visit was cancelled and tell the owner
// which house the seller no longer needs to drive to — the model's own text
// never carries that information reliably.
export interface CancelledVisit {
  date: string;
  time: string;
  address: string | null;
}

export async function cancelClientBooking(
  igsid: string
): Promise<{ success: boolean; cancelled?: number; visits?: CancelledVisit[]; error?: string }> {
  try {
    const db = await getAuthenticatedClient();
    // Eastern, not UTC: in the Miami evening UTC has already rolled to tomorrow,
    // and a UTC "today" made this lookup skip a visit scheduled for TODAY — the
    // client asked to cancel tonight and got "no_booking_found".
    const today = easternTodayStr();

    const { data: bookings, error: fetchErr } = await db
      .from("bookings")
      .select("id, booking_date, booking_time, address")
      .like("email", `ia-${igsid}@%`)
      .gte("booking_date", today)
      .order("booking_date", { ascending: true })
      .order("booking_time", { ascending: true });

    if (fetchErr) return { success: false, error: fetchErr.message };
    if (!bookings || bookings.length === 0) return { success: false, error: "no_booking_found" };

    let cancelled = 0;
    const visits: CancelledVisit[] = [];
    for (const b of bookings) {
      const { error } = await db.from("bookings").delete().eq("id", b.id);
      if (!error) {
        cancelled++;
        visits.push({ date: b.booking_date, time: b.booking_time, address: b.address ?? null });
        console.log(`Cancelled booking ${b.id} on ${b.booking_date} at ${b.booking_time}`);
      } else {
        console.error(`Cancel delete failed for booking ${b.id}:`, error.message);
      }
    }

    if (cancelled === 0) return { success: false, error: "delete_failed" };
    return { success: true, cancelled, visits };
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
// "14:00", "14:00:00" and "2pm" all name the same slot; dates compare as YYYY-MM-DD.
function hhmm(time: string | null | undefined): string {
  const t = (time ?? "").toString().trim().toLowerCase();
  const ampm = t.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/);
  if (ampm) {
    let h = parseInt(ampm[1], 10) % 12;
    if (ampm[3] === "pm") h += 12;
    return `${String(h).padStart(2, "0")}:${ampm[2] ?? "00"}`;
  }
  const m = t.match(/^(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : t;
}
export function isSameBookingSlot(dateA: string | null | undefined, timeA: string | null | undefined, dateB: string, timeB: string): boolean {
  const a = (dateA ?? "").toString().trim().slice(0, 10);
  const b = (dateB ?? "").toString().trim().slice(0, 10);
  return !!a && a === b && hhmm(timeA) === hhmm(timeB) && hhmm(timeA) !== "";
}

export async function rescheduleClientBooking(
  igsid: string,
  newDate: string,
  newTime: string,
  fallback?: { name?: string; phone?: string; address?: string; notes?: string; clientBurst?: string }
): Promise<BookingResult & { rescheduled?: boolean; unchanged?: boolean }> {
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

    // SAME SLOT → nothing to move. The model re-emits [BOOK] with the day and
    // time the client already holds (a post-booking "Perfect / text me 40 mins
    // before" turn that landed in RESCHEDULE MODE — Prince Cambow, FB
    // 2026-08-26). Trying to re-create that booking fails against the client's
    // OWN visit ("No availability") and the client was told "I couldn't lock in
    // that exact time" right after "Appointment confirmed". The visit stays as
    // it is; callers restate it instead of apologising.
    if (isSameBookingSlot(old.booking_date, old.booking_time, newDate, newTime)) {
      console.log(`[reschedule] ${igsid}: [BOOK] repeats the existing visit ${old.booking_date} ${old.booking_time} — nothing to move`);
      return { success: true, rescheduled: false, unchanged: true, bookingId: old.id, date: old.booking_date, time: hhmm(old.booking_time) };
    }

    // 2. Pick a seller for the new slot.
    const future = new Date();
    future.setMonth(future.getMonth() + 6);
    const futureStr = future.toISOString().slice(0, 10);
    const [{ data: sellersData }, { data: bookedData }, daysOff] = await Promise.all([
      db.from("sellers").select("id,name,priority,enabled_weekdays,time_slots,weekday_time_slots,active").eq("active", true).order("priority", { ascending: true }),
      db.rpc("get_booked_slots", { _from: today, _to: futureStr }),
      getDaysOff(db, newDate, newDate),
    ]);
    const sellers = (sellersData ?? []) as Seller[];
    const bookings = (bookedData ?? []) as BookingRow[];
    const seller = await pickSellerForSlotRouted(db, sellers, bookings, newDate, newTime, daysOff, {
      clientAddress: old.address ?? fallback?.address ?? null,
      igsid,
      kind: "reschedule",
    });
    if (!seller) return { success: false, error: `No availability for ${newDate} at ${newTime}.` };

    // 3. Create the NEW booking (copy original details, fall back to provided values).
    // O endereço antigo SEMPRE vencia (old.address só é null se um humano criou
    // a visita sem endereço), então uma correção mandada no mesmo turno da
    // remarcação era descartada em silêncio. Só uma troca de UNIDADE detectada
    // deterministicamente na rajada do cliente pode sobrescrever — o endereço
    // que o modelo escreve no [BOOK] continua sem poder nenhum aqui.
    let addressToUse = (old.address ?? fallback?.address ?? "").toString().trim();
    if (fallback?.clientBurst && old.address) {
      const corr = detectAddressCorrection(fallback.clientBurst, old.address);
      if (corr?.kind === "unit") {
        console.warn(`[reschedule] address unit corrected: "${old.address}" -> "${corr.address}"`);
        addressToUse = corr.address;
      }
    }
    const { data: created, error: insErr } = await db
      .from("bookings")
      .insert({
        name: (old.name ?? fallback?.name ?? "Instagram Client").toString().trim().slice(0, 100),
        email: `ia-${igsid}@instagram.ozzifloors.com`,
        phone: (old.phone ?? fallback?.phone ?? "").toString().trim().slice(0, 30) || null,
        address: addressToUse.slice(0, 300),
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
      if (isScheduleBlockedError(insErr)) {
        return { success: false, error: `No availability for ${newDate} at ${newTime}.` };
      }
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
  const fixDay = (weekdayWord: string, monthWord: string, dayNum: number): { day: number; month: number } | null => {
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
    const snappedStr = snapped.toISOString().slice(0, 10);
    if (snappedStr < todayStr) return null; // never point at the past
    // Crossing the month IS allowed, as long as the snapped date stays inside
    // the offer window: "Monday September 1st" said on Aug 27 (Sept 1, 2026 is
    // a Tuesday) means Monday August 31. Leaving it untouched shipped "Monday
    // September 1st at 9am or 11am" to a client, the [BOOK] landed on Tuesday
    // the 1st and she had to ask "is the appointment on Monday or Tuesday?"
    // (Rupinder Nagra, Messenger 2026-08-27). The month word is rewritten in
    // the language of the weekday word.
    if (snappedStr > addDaysStr(todayStr, 21)) return null;
    return { day: snapped.getUTCDate(), month: snapped.getUTCMonth() };
  };
  const monthWordFor = (weekdayWord: string, originalMonthWord: string, monthIdx: number): string => {
    const lang = /^(?:segunda|ter[cç]a|quarta|quinta|sexta)/i.test(weekdayWord)
      ? "pt"
      : /^(?:lunes|martes|mi[eé]rcoles|jueves|viernes)/i.test(weekdayWord)
        ? "es"
        : /^(?:s[áa]bado|domingo)/i.test(weekdayWord)
          ? (/(?:eiro|embro|outubro|mar[cç]o|maio|junho|julho|setembro)/i.test(originalMonthWord) ? "pt" : "es")
          : "en";
    const name = (lang === "pt" ? MONTH_NAMES_PT : lang === "es" ? MONTH_NAMES_ES : MONTH_NAMES)[monthIdx];
    return /^[A-Z]/.test(originalMonthWord) ? name.charAt(0).toUpperCase() + name.slice(1) : name;
  };

  let out = text.replace(OFFER_WD_MONTH_DAY, (whole, wd, sep, mo, gap, day, suffix) => {
    const fixed = fixDay(wd, mo, Number(day));
    if (fixed === null) return whole;
    const moOut = fixed.month === monthIndexOf(mo) ? mo : monthWordFor(wd, mo, fixed.month);
    corrections.push(`${wd} ${mo} ${day} -> ${moOut} ${fixed.day}`);
    return `${wd}${sep}${moOut}${gap}${fixed.day}${suffix ? ordinalSuffix(fixed.day) : ""}`;
  });
  out = out.replace(OFFER_WD_DAY_MONTH, (whole, wd, gap, day, mid, mo) => {
    const fixed = fixDay(wd, mo, Number(day));
    if (fixed === null) return whole;
    const moOut = fixed.month === monthIndexOf(mo) ? mo : monthWordFor(wd, mo, fixed.month);
    corrections.push(`${wd} ${day} de ${mo} -> ${fixed.day} de ${moOut}`);
    return `${wd}${gap}${fixed.day}${mid}${moOut}`;
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
// "3" / "the 6" / "26th at 6" / "a las 6" as the WHOLE reply (or its tail).
const BARE_HOUR_PICK = /^\s*(?:the\s+|el\s+|la\s+|las\s+|a\s+las?\s+)?(\d{1,2})\s*[.!]*\s*$|\b(?:at|a\s+las?|[àa]s)\s+(\d{1,2})\s*[.!]*\s*$/i;
// O \b final do JS é ASCII e NUNCA fecha depois de letra acentuada: "amanhã",
// "sábado", "mañana" e "miércoles" simplesmente não casavam, então um cliente
// PT/ES que confirmava o dia por extenso não era reconhecido como tendo
// escolhido (bloqueava o [BOOK], repetia a pergunta e disparava o ZIP-first).
// (?![a-zà-ÿ]) é o mesmo idioma já usado no resto do arquivo. Verificado 28/08.
const SLOT_DAY_REF = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo|hoy|ma[ñn]ana|segunda|ter[çc]a|quarta|quinta|sexta|hoje|amanh[ãa])(?![a-zà-ÿ])/i;
const SLOT_ORDINAL = /\b(?:the\s+)?(?:first|second|1st|2nd)\b|\b(?:el\s+|la\s+)?(?:primer[oa]?|segund[oa]?)\b|\bese\s+(?:horario|d[ií]a)\b|\besa\s+hora\b|\bthat\s+(?:one|time|day)\b/i;
const SLOT_AFFIRMATIVE = /\b(?:s[ií]|yes|yeah|yep|ok(?:ay)?|perfect(?:o)?|perfeito|claro|dale|vale|de acuerdo|works|sounds good|let'?s do it|hag[aá]moslo|me funciona|funciona|pode ser|combinado|est[aá]\s+bien|est[áa]\s+perfecto)\b/i;
// "September 2nd" / "2 de septiembre" — a month-name date is a day reference
// too (SLOT_DAY_REF only knows weekdays and today/tomorrow words).
const SLOT_MONTH_DATE = new RegExp(`\\b(?:${MONTH_WORDS})\\s+\\d{1,2}\\b|\\b\\d{1,2}\\s+de\\s+(?:${MONTH_WORDS})\\b`, "i");

// Every distinct clock HOUR (mod 12) a message names: "6pm", "6:00 pm", bare
// "9:00" (colon keeps street numbers out), "a las 11" / "às 11", "9 o'clock".
export function hoursNamed(text: string): Set<number> {
  const out = new Set<number>();
  const t = text || "";
  for (const tok of t.matchAll(/\b(\d{1,2})(?::\d{2})?\s*(?:am|pm)\b|\b(\d{1,2}):\d{2}\b/gi)) {
    out.add(parseInt(tok[1] ?? tok[2], 10) % 12);
  }
  for (const tok of t.matchAll(/(?:^|\W)(?:a\s+las?|[àa]s)\s+(\d{1,2})\b|\b(\d{1,2})\s*o'?clock\b/gi)) {
    out.add(parseInt(tok[1] ?? tok[2], 10) % 12);
  }
  if (/\bnoon\b|\bmediod[ií]a\b|\bmeio[-\s]?dia\b/i.test(t)) out.add(0);
  return out;
}

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
    // A bare number that IS one of the offered hours ("3" after "3pm, 5pm o
    // 6pm"; "6" / "26th at 6" after "6pm or 8pm") is a pick — three Messenger
    // clients (Carlos, Brittany, Anna, 2026-08-23/24) answered exactly that and
    // got "I just need to confirm the day and time" up to three times in a row.
    // Only 1–12 qualifies (a bare "25" is a day-of-month, never 1pm).
    const barePick = t.match(BARE_HOUR_PICK);
    if (barePick) {
      const h = parseInt(barePick[1] ?? barePick[2], 10);
      if (h >= 1 && h <= 12 && offeredHours.has(h % 12)) return true;
    }
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

  // 3. CLIENT-PROPOSED slot (LISSETTE, IG 2026-08-24): the client opened with a
  //    complete proposal — "are you available next Wednesday September 2nd at
  //    6:00 pm?" — and the bot ACCEPTED it ("Yes, Wednesday September 2nd at 6pm
  //    works perfectly! Can I get your name..."). Rules 1–2 never see it: the
  //    proposal PRECEDES the bot's first clock-time message, so it sits outside
  //    the pick window, the [BOOK] was blocked, and the canned "confirm the day
  //    and time" ask went out to a client who had already given day, time, name,
  //    address AND phone. A slot the client themselves proposed IS a slot the
  //    client picked — but only when the bot's very next reply echoes the same
  //    hour with an affirmative; a counter-offer ("Friday is full, I have
  //    Saturday...") names other hours and must NOT unlock the booking.
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role !== "user") continue;
    const t = strip(msgs[i].content);
    if (!SLOT_DAY_REF.test(t) && !SLOT_MONTH_DATE.test(t)) continue;
    const proposed = hoursNamed(t);
    if (proposed.size === 0) continue;
    for (let j = i + 1; j < msgs.length; j++) {
      if (msgs[j].role !== "assistant") continue;
      const reply = strip(msgs[j].content);
      const echoed = hoursNamed(reply);
      if (SLOT_AFFIRMATIVE.test(reply) && [...proposed].some((h) => echoed.has(h))) return true;
      break; // only the bot's IMMEDIATE reply can accept the proposal
    }
  }
  return false;
}

// Sent when we have address/phone but the client never picked a specific
// day/time: ask them to choose instead of inventing one.
export function needSlotConfirmationMessage(lang: Lang): string {
  if (lang === "pt") return "Perfeito! Só falta confirmar o dia e o horário, qual fica melhor para você para a visita?";
  return lang === "es"
    ? "Perfecto! Solo me falta confirmar el día y la hora, cuál te queda mejor para la visita?"
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
export async function needTimeChoiceMessage(lang: Lang, dateStr: string, clientAddress?: string | null): Promise<string> {
  try {
    let slots = await getAvailableSlots(dateStr);
    if (dateStr === easternTodayStr()) {
      const nowET = easternNowHM();
      const cutoff = nowET.hour * 60 + nowET.minute + SAME_DAY_MIN_NOTICE_MIN;
      slots = slots.filter((s) => {
        const [h, min] = s.split(":").map(Number);
        return h * 60 + min >= cutoff;
      });
    }
    const times = (await routeOrderedSlots(dateStr, slots, clientAddress, 4)).map(fmt12);
    if (times.length > 0) {
      const sep = lang === "en" ? " or " : lang === "es" ? " o " : " ou ";
      const list = times.length === 1 ? times[0] : `${times.slice(0, -1).join(", ")}${sep}${times[times.length - 1]}`;
      if (lang === "pt") return `Perfeito! Para esse dia tenho disponível ${list}, qual horário fica melhor para você?`;
      return lang === "es"
        ? `Perfecto! Para ese día tengo disponible ${list}, a qué hora te queda mejor?`
        : `Perfect! For that day I have ${list} available, which time works best for you?`;
    }
  } catch (err) {
    console.error("needTimeChoiceMessage error:", err);
  }
  return needSlotConfirmationMessage(lang);
}

// ─── Promise-match guard: the [BOOK] must honor the LAST concrete promise ────
// THE BUG (2026-08-23, MARIA HERNANDEZ, Messenger): the bot offered "hoy
// domingo a las 11am, 1pm, ..., o el martes 25 a las 9am, 1pm, ...", the client
// picked "Hoy ahora" and sent her address, the bot echoed the deal — "Perfecto,
// tengo hoy a las 11am" — and then the model's [BOOK] silently wrote TUESDAY the
// 25th at 1:00pm. Every existing guard passed: "hoy" is a valid day pick
// (clientConfirmedSlot), 1pm appears in the offer list (bookedTimeSeen), and no
// weekday word disagreed (reconcileBookingWeekday). The client sat home all
// Sunday asking "Todavía están viniendo hoy?" while her visit quietly sat two
// days later. This guard is the missing rule: whatever slot the conversation
// last PROMISED (the newest message, either side, naming a single clock hour)
// is the only slot a [BOOK] may write. On a contradiction we block and re-offer
// that day's REAL open times instead of confirming a swap the client never saw.
const PROMISE_TODAY = /\b(?:today|tonight|hoy|hoje)\b/i;
// "mañana" is ONLY "tomorrow" when not "la/de/una mañana" (= the morning).
const PROMISE_TOMORROW = /\b(?:tomorrow|amanh[ãa])\b|(?<!\b(?:la|de|una)\s)\bma[ñn]ana\b/i;
// A number directly followed by am/pm/":" is an HOUR, never a day of month —
// without the lookahead, "Tuesday 2pm" would parse as "day 2".
const NOT_AN_HOUR = "(?!\\s*(?:am|pm|:))";
const PROMISE_DOM_PATTERNS = [
  new RegExp(`\\b(?:${WEEKDAY_WORDS})\\b[,\\s]+(?:the\\s+|el\\s+|d[ií]a\\s+)?([0-3]?\\d)(?:st|nd|rd|th)?\\b${NOT_AN_HOUR}`, "gi"),
  new RegExp(`\\b(?:${MONTH_WORDS})\\s+([0-3]?\\d)\\b${NOT_AN_HOUR}`, "gi"),
  new RegExp(`\\b([0-3]?\\d)${NOT_AN_HOUR}\\s+de\\s+(?:${MONTH_WORDS})\\b`, "gi"),
  new RegExp(`\\bthe\\s+([0-3]?\\d)(?:st|nd|rd|th)\\b${NOT_AN_HOUR}`, "gi"), // English needs the ordinal suffix ("the 2 bedrooms" must not parse)
  new RegExp(`\\b(?:el|d[ií]a)\\s+([0-3]?\\d)\\b${NOT_AN_HOUR}`, "gi"),
];

export function bookedSlotMismatchesPromise(
  history: Array<{ role: string; content: string }>,
  dateStr: string,
  timeHHMM: string
): { mismatch: boolean; promisedDate?: string; reason?: string } {
  const tm = /^(\d{1,2}):(\d{2})/.exec((timeHHMM ?? "").trim());
  if (!tm || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr || "")) return { mismatch: false };
  const bookedH12 = parseInt(tm[1], 10) % 12;
  const strip = (c: string) => (c || "").replace(/[‘’ʼ´]/g, "'").split(/\n\n?\[SYSTEM:/)[0];

  // The anchor is the NEWEST message carrying a slot signal: a clock hour (either
  // side) or a day reference from the CLIENT (their late "mejor el miércoles"
  // must supersede an older echo, not be contradicted by it).
  const msgs = history ?? [];
  let anchor: string | null = null;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const t = strip(msgs[i].content);
    const hasHours = hoursNamed(t).size > 0;
    const hasClientDay =
      msgs[i].role === "user" &&
      (SLOT_DAY_REF.test(t) || SLOT_MONTH_DATE.test(t) || weekdaysNamed(t).length > 0);
    if (hasHours || hasClientDay) { anchor = t; break; }
  }
  if (anchor === null) return { mismatch: false };

  // Hour: enforced only when the anchor names exactly ONE distinct hour — that
  // is a concrete promise/pick, not a multi-slot offer.
  const hours = hoursNamed(anchor);
  const hourMismatch = hours.size === 1 && ![...hours].includes(bookedH12);

  // Date: enforced only on ONE unambiguous signal — today, tomorrow, or a single
  // day-of-month. Weekday words are reconcileBookingWeekday's job, not ours.
  const saysToday = PROMISE_TODAY.test(anchor);
  const saysTomorrow = PROMISE_TOMORROW.test(anchor);
  const doms = new Set<number>();
  for (const re of PROMISE_DOM_PATTERNS) {
    for (const m of anchor.matchAll(re)) {
      const n = parseInt(m[1], 10);
      if (n >= 1 && n <= 31) doms.add(n);
    }
  }
  const todayStr = easternTodayStr();
  let promisedDate: string | undefined;
  let dateMismatch = false;
  const signalCount = (saysToday ? 1 : 0) + (saysTomorrow ? 1 : 0) + (doms.size === 1 ? 1 : 0);
  if (signalCount === 1) {
    if (saysToday) promisedDate = todayStr;
    else if (saysTomorrow) promisedDate = addDaysStr(todayStr, 1);
    else {
      const dom = [...doms][0];
      const anchorWeekdays = weekdaysNamed(anchor);
      for (let d = todayStr, k = 0; k < 40; d = addDaysStr(d, 1), k++) {
        const f = ymd(d);
        if (f.day === dom && (anchorWeekdays.length !== 1 || f.weekday === anchorWeekdays[0])) {
          promisedDate = d;
          break;
        }
      }
    }
    if (promisedDate) dateMismatch = promisedDate !== dateStr;
  }

  if (!hourMismatch && !dateMismatch) return { mismatch: false };
  return {
    mismatch: true,
    promisedDate,
    reason:
      `last promise says ${hours.size === 1 ? `hour ${[...hours][0] || 12} (mod 12)` : "no single hour"}` +
      `${promisedDate ? ` on ${promisedDate}` : ""} but [BOOK] wrote ${dateStr} ${timeHHMM}`,
  };
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

// ─── Nota de rota para a OFERTA de horários (27/08/2026) ─────────────────────
// Só entra quando o webhook passa contexto do cliente (history/endereço). Sem
// opções (evals, chamadas antigas) o texto da agenda é byte-idêntico ao de antes.
//  • Localização conhecida (ZIP digitado, endereço, cidade/bairro) → nota
//    "ROUTE PRIORITY": os MESMOS horários das linhas acima, por dia, na ordem da
//    melhor rota para a pior. O modelo continua oferecendo a mesma quantidade.
//  • Localização desconhecida → nota "ZIP CODE FIRST" (configurável): pedir o
//    ZIP na proposta da visita, uma vez só, sem travar a venda.
// Qualquer erro → sem nota (comportamento atual). Nunca derruba a agenda.
export interface AvailabilityContextOptions {
  history?: Array<{ role: string; content: string }>;
  clientAddress?: string | null;
  igsid?: string | null;
  rescheduling?: boolean; // cliente já agendado remarcando: endereço vem do booking, nunca ZIP-first
}

async function routeNoteForAvailability(
  db: SchedulerDb,
  opts: AvailabilityContextOptions,
  windowDays: string[],
  sellers: Seller[],
  bookings: BookingRow[],
  daysOff: DaysOffSet,
  nowMinutesPlusNotice: number
): Promise<string | null> {
  const cfg = getRouteConfig();
  if (!cfg.enabled) return null;
  let client = locationFromAddress(opts.clientAddress) ?? clientLocationFromHistory(opts.history ?? []);
  // Remarcação: a janela de 15 mensagens pode não conter mais o endereço que o
  // cliente digitou ao agendar — ele está no booking. Nunca pedir ZIP a quem
  // já tem visita marcada (a nota RESCHEDULE MODE diz "não peça o endereço").
  if (!client && opts.rescheduling && opts.igsid) {
    const rec = await getUpcomingBookingRecord(opts.igsid).catch(() => null);
    client = locationFromAddress(rec?.address);
    if (!client) return null;
  }
  // Fora da área atendida (ZIP não começa por 33): o prompt recusa a visita;
  // não há rota a otimizar e nenhuma nota deve empurrar horários.
  if (client?.zip && !isServiceAreaZip(client.zip)) return null;
  if (!client) {
    // Pedir o ZIP antes dos horários só faz sentido ANTES de o cliente escolher:
    // se ele já nomeou/aceitou um dia ou hora, o fluxo normal segue (confirma o
    // slot e pede nome + endereço com ZIP + telefone juntos). Deterministico —
    // o modelo, com a nota no contexto, tendia a pedir o ZIP sozinho.
    if (cfg.askZipBeforeOffer && opts.history && !clientAlreadyNamedSlot(opts.history)) {
      return buildZipFirstNote(zipAlreadyAskedInHistory(opts.history));
    }
    return null;
  }
  const started = Date.now();
  try {
    // Só os dias que ENTRAM na nota (os primeiros noteDays com vaga): menos
    // pontos na matriz (OSRM público aceita ~100), menos latência, e a nota
    // nunca lista dias além disso mesmo.
    const noteDays: Array<{ dateStr: string; displayDate: string; openBySlot: Map<string, RouteSeller[]>; capacity: number; open: number }> = [];
    for (const dateStr of windowDays) {
      if (noteDays.length >= cfg.noteDays) break;
      const { weekday, month, day, year } = ymd(dateStr);
      const isToday = dateStr === windowDays[0];
      const openBySlot = new Map<string, RouteSeller[]>();
      // Daily Fill Rate (regra do dono, 27/08): capacidade = oportunidades
      // vendedor×horário do dia (vendedor ativo, dia habilitado, sem folga;
      // hoje só os horários ainda ofertáveis); ocupadas = capacidade − livres.
      let capacity = 0;
      let open = 0;
      for (const s of sellers) for (const slot of slotsForWeekday(s, weekday)) {
        if (!s.active || !s.enabled_weekdays.includes(weekday) || daysOff.has(`${s.id}|${dateStr}`)) continue;
        if (isToday && slotMinutes(slot) < nowMinutesPlusNotice) continue;
        capacity++;
        if (!sellerOpenForSlot(s, dateStr, weekday, slot, bookings, daysOff)) continue;
        open++;
        openBySlot.set(slot, [...(openBySlot.get(slot) ?? []), asRouteSeller(s)]);
      }
      if (openBySlot.size === 0) continue;
      noteDays.push({ dateStr, displayDate: `${DAY_NAMES[weekday]}, ${MONTH_NAMES[month]} ${day}, ${year} [${dateStr}]`, openBySlot, capacity, open });
    }
    if (noteDays.length === 0) return null;
    const rows = await fetchVisitsWithAddress(db, noteDays[0].dateStr, noteDays[noteDays.length - 1].dateStr, opts.igsid);
    const visitsByDay = new Map<string, ExistingVisit[]>();
    for (const r of rows) {
      const list = visitsByDay.get(r.booking_date) ?? [];
      list.push(...toExistingVisits([r]));
      visitsByDay.set(r.booking_date, list);
    }
    // Uma matriz só: cliente + todos os pontos distintos das visitas desses dias.
    const points: GeoPoint[] = [client];
    const index = new Map<string, number>([[geoKey(client), 0]]);
    for (const d of noteDays) for (const v of visitsByDay.get(d.dateStr) ?? []) {
      if (!v.point) continue;
      const k = geoKey(v.point);
      if (!index.has(k)) { index.set(k, points.length); points.push(v.point); }
    }
    const matrix = await travelMatrix(points, cfg);
    // Ponto fora do índice (não deveria acontecer) → estimativa, nunca 0 min.
    const between = (a: GeoPoint, b: GeoPoint) => {
      const ia = index.get(geoKey(a));
      const ib = index.get(geoKey(b));
      return ia === undefined || ib === undefined ? estimateMinutes(a, b, cfg) : matrix.minutes[ia][ib];
    };

    const days: DayRanking[] = [];
    for (const d of noteDays) {
      const ranked = rankSlotsForDay(client, d.openBySlot, visitsByDay.get(d.dateStr) ?? [], between, cfg, sellers.map(asRouteSeller));
      days.push({ dateStr: d.dateStr, displayDate: d.displayDate, ranked, capacity: d.capacity, open: d.open });
    }
    const note = buildRoutePriorityNote(days, client, cfg, fmt12);
    logRouteDecision({
      kind: "offer", igsid: opts.igsid ?? null, zip: client.zip ?? null, clientLabel: client.label ?? null, date: windowDays[0],
      provider: matrix.provider, fallback: matrix.fallbackReason ?? null, ms: Date.now() - started,
      reason: note ? "route priority note added to the schedule" : "no open slots to rank",
      presented: days.slice(0, cfg.noteDays).map((d) => `${d.dateStr} fill=${Math.round(fillRateOf(d) * 100)}%: ${d.ranked.slice(0, cfg.offerCount + cfg.expandCount).map((r) => `${r.slot}=${r.score}${r.bestSeller ? "/" + r.bestSeller.name : ""}`).join(" ")}`),
    }, false);
    return note;
  } catch (err) {
    console.error("[route] availability note failed — schedule sent without route ordering:", err);
    logRouteDecision({ kind: "offer", igsid: opts.igsid ?? null, zip: client.zip ?? null, date: windowDays[0], provider: "none", reason: `fallback: ${String((err as Error)?.message ?? err)}`, ms: Date.now() - started }, false);
    return null;
  }
}

// O cliente já escolheu (clientConfirmedSlot) ou a mensagem mais recente dele
// nomeia um dia/hora ("can you come Friday?", "a las 3pm") → nada de ZIP-first.
export function clientAlreadyNamedSlot(history: Array<{ role: string; content: string }>): boolean {
  if (clientConfirmedSlot(history)) return true;
  for (const m of history) {
    const t = (m.content || "").replace(/[‘’ʼ´]/g, "'").split(/\n\n?\[SYSTEM:/)[0];
    // O bot já ofereceu horários → a fase "ZIP antes da oferta" já passou.
    if (m.role === "assistant" && CLOCK_TIME_TOKEN.test(t)) { CLOCK_TIME_TOKEN.lastIndex = 0; return true; }
    CLOCK_TIME_TOKEN.lastIndex = 0;
    // O cliente nomeou um dia/hora em QUALQUER bolha ("can you come Saturday?"
    // três mensagens atrás) → fluxo normal, sem ZIP-first.
    if (m.role === "user" && (SLOT_TIME_REF.test(t) || SLOT_DAY_REF.test(t) || SLOT_MONTH_DATE.test(t))) return true;
  }
  return false;
}

export async function getRealAvailabilityContext(opts?: AvailabilityContextOptions): Promise<string> {
  try {
    const db = await getAuthenticatedClient();

    const todayStr = easternTodayStr();
    // Show 21 days so the bot can book NEXT WEEK and beyond, not just this week.
    // It must never tell a client it "can't see" a future date that is bookable.
    const windowDays: string[] = Array.from({ length: 21 }, (_, i) => addDaysStr(todayStr, i));

    const fromStr = windowDays[0];
    const toStr = windowDays[windowDays.length - 1];

    const [{ data: sellersData }, { data: bookedData }, daysOff] = await Promise.all([
      db
        .from("sellers")
        .select("id,name,priority,enabled_weekdays,time_slots,weekday_time_slots,active")
        .eq("active", true)
        .order("priority", { ascending: true }),
      db.rpc("get_booked_slots", { _from: fromStr, _to: toStr }),
      getDaysOff(db, fromStr, toStr),
    ]);

    const sellers = (sellersData ?? []) as Seller[];
    const bookings = (bookedData ?? []) as BookingRow[];

    const lines: string[] = ["REAL-TIME SCHEDULE AVAILABILITY (always use this, never guess):"];

    const nowET = easternNowHM();
    const nowMinutesPlus30 = nowET.hour * 60 + nowET.minute + SAME_DAY_MIN_NOTICE_MIN;

    let hasAnySlot = false;

    for (const dateStr of windowDays) {
      const { weekday, month, day, year } = ymd(dateStr);
      const displayDate = `${DAY_NAMES[weekday]}, ${MONTH_NAMES[month]} ${day}, ${year} [${dateStr}]`;

      const slotSet = new Set<string>();
      sellers.forEach((s) => {
        slotsForWeekday(s, weekday).forEach((slot) => {
          if (sellerOpenForSlot(s, dateStr, weekday, slot, bookings, daysOff)) slotSet.add(slot);
        });
      });

      // For today only: drop slots that start in less than SAME_DAY_MIN_NOTICE_MIN
      // Eastern minutes (was a 30-min buffer: at 4:25pm the bot offered "today at
      // 5pm", booked it at 4:28pm, nobody could get there and the client wrote
      // "Is this a scam" — Rowan Hobbs, 2026-08-23).
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
        "\n- SOONEST DAY FIRST (owner's rule, the team must not be left with empty hours): when you propose the visit, take your two options from the FIRST line above that has open times, today if today still has times listed, otherwise the next day, and take that line's EARLIEST two open times (its first two listed: 9am before 11am before 1pm), so the day fills from the first hour with no holes. If that line has only one open time, offer it plus the first open time of the next line that has any. Move to a later day ONLY when the client says they cannot do that day, asks for another day, or their stated availability has no match on it, and even then use the SOONEST matching line (for 'next week' that is the first listed day of next week, not a later one). Never skip a day that has open times because a later day has more of them." +
        "\n- This list covers the next 21 days, so you CAN book next week and the week after. NEVER tell the client you cannot see, access, or open a future week's calendar — any date listed above is bookable." +
        "\n- When you name a weekday to the client (e.g. 'Friday' / 'viernes'), you MUST use the exact date in [brackets] shown on that SAME line, and ONLY the times listed on that same line." +
        "\n- When you offer day options, you MUST name open times for EVERY day you offer, taken from each day's own line (e.g. 'Wednesday at 9am or 11am — which works?'; only when a day has a single open time do you reach into the next day, e.g. 'Wednesday at 5pm, or Thursday at 9am'). NEVER offer a day without stating its available times: the client can only pick a time you actually showed, and a booking is only valid after the client explicitly chose one of the listed times. Offering 'Wednesday at 3pm or Thursday?' is FORBIDDEN — the client may pick Thursday assuming 3pm while you book a different hour." +
        "\n- A SUMMARY OF availability is not a list of times and is equally FORBIDDEN. Never write 'Sunday with several options', 'Tuesday has plenty of availability', 'Wednesday has full availability from 9am to 7pm', 'both with plenty of times to choose from', or anything similar: a range or a count lets the client answer '10am' or '2pm' — hours that are not on the line and do not exist — and you then have to walk it back. Spell out the actual open times, comma-separated, for every day you name, however many there are." +
        "\n- If the same weekday appears on more than one line (e.g. two Tuesdays), use the SOONEST one, UNLESS the client says 'next week' or names a specific date, then use that line instead." +
        "\n- NEVER pair a weekday with a date from a different line. NEVER compute or guess a date yourself. The weekday name and the [YYYY-MM-DD] must always come from the same line above." +
        "\n- NEVER tell a client a time was 'just taken', is 'no longer available', or ask them to 'pick another time'. If a time is not listed, simply offer a different time that IS listed, naturally." +
        "\n- ONE EXCEPTION, and it is mandatory: if the client is ACCEPTING a day/time YOU offered earlier in this same conversation and that time is no longer on its line above, you must OWN IT in the first clause before anything else — a short apology that it filled up since you offered it — and only then name the real open times. Swapping their accepted slot for a different one with no acknowledgement is the worst thing you can do here: a client who confirmed 'Friday 7pm 👍' and sent his name, address and phone got back 'The soonest I have open is Sunday at 11am or 1pm' and replied 'I thought you said Friday at 7?' (Rolando, 2026-07-29) — the owner had to step in by hand. Say something like 'I'm sorry, that Friday 7pm filled up while we were talking — the closest I have now is Sunday at 11am or 1pm, which works?'. Never pretend the earlier offer did not happen, and never make the client be the one to notice." +
        "\n- Until the visit is actually confirmed, do NOT tell the client a time is 'locked in', 'all set' or 'confirmed'. Say you are holding it while you collect their name, address and phone. Nine clients in five days were told a slot was theirs and then had it taken away." +
        "\n- In the [BOOK:...] tag, copy the date as the exact [YYYY-MM-DD] from the line whose weekday matches what you told the client. If 'Friday' is [2026-06-05] above, the booking date is 2026-06-05, never 2026-06-06."
    );

    // Rota (27/08/2026): nota interna de prioridade dos horários (ou pedido de
    // ZIP) só quando o webhook passa o contexto do cliente. Sem opts → idêntico.
    if (opts) {
      const routeNote = await routeNoteForAvailability(db, opts, windowDays, sellers, bookings, daysOff, nowMinutesPlus30);
      if (routeNote) lines.push("", routeNote);
    }

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

  const [{ data: sellersData }, { data: bookedData }, daysOff] = await Promise.all([
    db.from("sellers").select("id,name,priority,enabled_weekdays,time_slots,weekday_time_slots,active").eq("active", true).order("priority", { ascending: true }),
    db.rpc("get_booked_slots", { _from: fromStr, _to: toStr }),
    getDaysOff(db, fromStr, toStr),
  ]);

  const sellers = (sellersData ?? []) as Seller[];
  const bookings = (bookedData ?? []) as BookingRow[];
  const nowET = easternNowHM();
  const nowMinutesPlus30 = nowET.hour * 60 + nowET.minute + SAME_DAY_MIN_NOTICE_MIN;

  const out: Array<{ dateStr: string; weekday: number; times: string[] }> = [];
  for (const dateStr of windowDays) {
    const { weekday } = ymd(dateStr);
    const slotSet = new Set<string>();
    sellers.forEach((s) => {
      slotsForWeekday(s, weekday).forEach((slot) => {
        if (sellerOpenForSlot(s, dateStr, weekday, slot, bookings, daysOff)) slotSet.add(slot);
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
const DAY_NAMES_PT = ["domingo", "segunda", "terça", "quarta", "quinta", "sexta", "sábado"];

// Recovery offer for when the slot the client confirmed turned out to be full.
// Instead of handing the lead to a human (the old behavior, which lost the
// client), offer other open slot(s) from the real schedule, never saying the
// time was "taken". Returns null when there is genuinely nothing open in the
// window OR when this same recovery was already sent before (anti-loop), so
// the caller falls back to the human handoff.
//
// Caso Anna Evangelista (IG, 2026-08-21): the client's ONLY constraint was the
// day (a 10am walkthrough with the sellers on Tuesday), 10am was full but the
// same Tuesday had 9am/11am open — yet the old message jumped to "soonest
// overall" (Sunday evening), which she had already declined, and repeated it
// verbatim three times. Now: (1) if the REQUESTED day still has open times,
// offer those first; (2) if the exact text we are about to send already sits
// in the assistant history, return null so the lead escalates to Ozzi instead
// of looping.
export async function slotConflictRecoveryMessage(
  lang: Lang,
  requestedDate?: string,
  history?: Array<{ role: string; content: string }>,
  requestedTime?: string,
  clientAddress?: string | null
): Promise<string | null> {
  try {
    let msg: string | null = null;

    // Same-day alternatives first: the client picked that day for a reason.
    if (requestedDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      try {
        // Never re-offer the very time that just failed to book, even if the
        // availability view disagrees with the booking write.
        const failedHM = /^(\d{1,2}):(\d{2})/.exec((requestedTime ?? "").trim());
        const failedMin = failedHM ? parseInt(failedHM[1], 10) * 60 + parseInt(failedHM[2], 10) : null;
        let slots = (await getAvailableSlots(requestedDate)).filter((s) => {
          if (failedMin === null) return true;
          const [h, min] = s.split(":").map(Number);
          return h * 60 + min !== failedMin;
        });
        if (requestedDate === easternTodayStr()) {
          const nowET = easternNowHM();
          const cutoff = nowET.hour * 60 + nowET.minute + SAME_DAY_MIN_NOTICE_MIN;
          slots = slots.filter((s) => {
            const [h, min] = s.split(":").map(Number);
            return h * 60 + min >= cutoff;
          });
        }
        const times = (await routeOrderedSlots(requestedDate, slots, clientAddress, 3)).map(fmt12);
        if (times.length > 0) {
          const sep = lang === "en" ? " or " : lang === "es" ? " o " : " ou ";
          const list = times.length === 1 ? times[0] : `${times.slice(0, -1).join(", ")}${sep}${times[times.length - 1]}`;
          msg =
            lang === "pt"
              ? `Esse horário exato eu não tenho disponível, mas nesse mesmo dia posso às ${list}. Qual fica melhor para você?`
              : lang === "es"
                ? `Ese horario exacto no lo tengo disponible, pero ese mismo día puedo a las ${list}. Cuál te queda mejor?`
                : `That exact time isn't open on my end, but that same day I can do ${list}. Which works better for you?`;
        }
      } catch (err) {
        console.error("slotConflictRecoveryMessage same-day error:", err);
      }
    }

    if (!msg) {
      const open = await getNextOpenSlots(21);
      if (open.length === 0) return null;
      const first = open[0];
      const times = (await routeOrderedSlots(first.dateStr, first.times, clientAddress, 2)).map(fmt12);
      if (lang === "pt") {
        const wd = DAY_NAMES_PT[first.weekday];
        const t = times.length >= 2 ? `${times[0]} ou ${times[1]}` : times[0];
        msg =
          times.length >= 2
            ? `O mais cedo que tenho disponível é ${wd} às ${t}. Qual fica melhor para você?`
            : `O mais cedo que tenho disponível é ${wd} às ${t}. Funciona para você?`;
      } else if (lang === "es") {
        const wd = DAY_NAMES_ES[first.weekday];
        const t = times.length >= 2 ? `${times[0]} o ${times[1]}` : times[0];
        msg =
          times.length >= 2
            ? `Lo más pronto que tengo disponible es el ${wd} a las ${t}. Cuál te queda mejor?`
            : `Lo más pronto que tengo disponible es el ${wd} a las ${t}. Te funciona?`;
      } else {
        const wd = DAY_NAMES[first.weekday];
        const t = times.length >= 2 ? `${times[0]} or ${times[1]}` : times[0];
        msg =
          times.length >= 2
            ? `The soonest I have open is ${wd} at ${t}, which works better for you?`
            : `The soonest I have open is ${wd} at ${t}, does that work for you?`;
      }
    }

    // Anti-loop: the same canned recovery, sent again, is dead air with extra
    // steps (the recap guard even prefixes it "Como te mencioné arriba"). If
    // the client is still stuck after hearing this exact offer once, a human
    // has to decide — null makes the caller hand off to Ozzi.
    const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
    if (history?.some((m) => m.role === "assistant" && norm(m.content).includes(norm(msg!)))) {
      console.warn("[scheduler] slot-conflict recovery already sent once — escalating instead of repeating");
      return null;
    }
    return msg;
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
const MONTH_NAMES_PT = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

// Deterministic answer for a booked client asking about their OWN visit
// ("Are you coming at 3?", "Which day, Tuesday?"). No model involved, so it can
// never hallucinate a date: it restates the scheduler's real booking and opens
// the reschedule door. Two short sentences, no dashes, no emojis (owner rules).
export function visitDetailsMessage(lang: Lang, dateStr: string, timeStr: string): string {
  const { weekday, month, day } = ymd(dateStr);
  const time = /^\d{1,2}:\d{2}$/.test((timeStr || "").trim()) ? fmt12(timeStr.trim()) : (timeStr || "").trim();
  const atTime = time ? (lang === "en" ? ` at ${time}` : lang === "es" ? ` a las ${time}` : ` às ${time}`) : "";
  if (lang === "pt") {
    return `Sua visita está confirmada para ${DAY_NAMES_PT[weekday]} dia ${day} de ${MONTH_NAMES_PT[month]}${atTime}. O Ozzi te avisa uns 40 minutos antes de chegar, e se você precisar mover a visita é só me dizer o novo dia e horário.`;
  }
  if (lang === "es") {
    return `Tu visita está confirmada para el ${DAY_NAMES_ES[weekday]} ${day} de ${MONTH_NAMES_ES[month]}${atTime}. Ozzi te avisa unos 40 minutos antes de llegar, y si necesitas mover la visita solo dime el nuevo día y hora.`;
  }
  return `Your visit is confirmed for ${DAY_NAMES[weekday]}, ${MONTH_NAMES[month]} ${day}${atTime}. Ozzi will message you about 40 minutes before arriving, and if you need to move the visit just tell me the new day and time.`;
}

// Owner rule (2026-08-26, Prince Cambow): a booked client asking to be warned
// before the visit ("Text me or call me please 40 mins before") gets exactly
// this line — the platform's reminder goes out by text 40 minutes before the
// seller arrives. One sentence, no dash, no emoji.
export function reminderAckMessage(lang: Lang): string {
  if (lang === "pt") return "Ok, eu te aviso por mensagem de texto 40 minutos antes de chegar.";
  return lang === "es"
    ? "Ok, te aviso por mensaje de texto 40 minutos antes de llegar."
    : "Ok, I will text you 40 minutes before arriving.";
}

// ─── Language detection + localized booking messages ──────────────────────
// Lightweight heuristic: decide whether the conversation is in Spanish,
// Portuguese or English so canned confirmation/recovery messages match the
// client's language. PT was MISSING here until 2026-08-21 (Anna Evangelista,
// IG): a conversation held entirely in Portuguese scored "es" (shared words +
// the á/é/í/ó accents), so the canned slot-conflict recovery came out in
// SPANISH mid-conversation and the client had to say "Eu não falo espanhol".
// The chars ã õ ç â ê à ô exist in Portuguese but not Spanish, so each is a
// heavyweight PT signal; ñ ¿ ¡ are the Spanish mirror image.
export type Lang = "es" | "en" | "pt";
export function detectLang(text: string): Lang {
  const t = (text || "").toLowerCase();
  if (!t.trim()) return "en";
  let es = (t.match(/[ñ¿¡]/g) || []).length * 2 + (t.match(/[áéíóú]/g) || []).length;
  let en = 0;
  let pt = (t.match(/[ãõçâêàô]/g) || []).length * 2;
  const esWords = ["hola", "gracias", "cuánto", "cuanto", "precio", "piso", "casa", "área", "area", "necesito", "quiero", "buenas", "cita", "dirección", "direccion", "cocina", "cuarto", "metros", "usted", "mañana", "tengo", "viernes", "sábado", "sabado", "domingo", "lunes", "martes", "miércoles", "miercoles", "jueves", "para", "está", "esta", "pisos"];
  const enWords = ["hello", "thanks", "thank", "price", "floor", "house", "need", "want", "quote", "address", "kitchen", "room", "tomorrow", "morning", "would", "please", "available", "looking"];
  // \b is ASCII-only in JS, so accented words use (?:^|\W)…(?=$|\W) instead.
  const ptWords = ["você", "voce", "vcs", "obrigado", "obrigada", "não", "endereço", "endereco", "orçamento", "orcamento", "amanhã", "terça", "segunda-feira", "quarta", "quinta", "sexta", "gostaria", "gostaríamos", "gostariamos", "olá", "hoje", "preço", "madeira", "banheiro", "cozinha", "preciso", "falo", "português", "portugues", "pode", "seria", "tudo bem", "estou", "muito"];
  for (const w of esWords) if (new RegExp(`\\b${w}\\b`).test(t)) es++;
  for (const w of enWords) if (new RegExp(`\\b${w}\\b`).test(t)) en++;
  for (const w of ptWords) if (new RegExp(`(?:^|\\W)${w}(?=$|\\W)`).test(t)) pt++;
  if (pt > es && pt > en) return "pt";
  return es > en ? "es" : "en";
}

// Sent to the client after a booking is successfully created.
// Since 2026-08-25 the confirmation RESTATES the booked day and time: "Appointment
// confirmed." alone left clients guessing (Ruth Erazo: "Quedamos confirmados para
// el martes a la 1:00" → "Perdon a las 11:00"; Mrsmachadoo booked "anytime" and
// never learned the 3pm; Teresa asked "Tuesday at 4:00 pm. Right?"). The date
// and time come from the booking we just wrote, never from the model.
export function bookingSuccessMessage(lang: Lang, dateStr?: string, timeStr?: string): string {
  let when = "";
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    const { weekday, month, day } = ymd(dateStr);
    const t = (timeStr || "").trim();
    const time = /^\d{1,2}:\d{2}$/.test(t) ? fmt12(t) : t;
    if (lang === "pt") when = ` para ${DAY_NAMES_PT[weekday]} dia ${day} de ${MONTH_NAMES_PT[month]}${time ? ` às ${time}` : ""}`;
    else if (lang === "es") when = ` para el ${DAY_NAMES_ES[weekday]} ${day} de ${MONTH_NAMES_ES[month]}${time ? ` a las ${time}` : ""}`;
    else when = ` for ${DAY_NAMES[weekday]}, ${MONTH_NAMES[month]} ${day}${time ? ` at ${time}` : ""}`;
  }
  if (lang === "pt") return `Visita confirmada${when}. Eu te aviso aproximadamente 40 minutos antes de chegar na sua casa. Meu nome é Ozzi.`;
  return lang === "es"
    ? `Cita confirmada${when}. Te aviso aproximadamente 40 minutos antes de llegar a tu casa. Mi nombre es Ozzi.`
    : `Appointment confirmed${when}. I will notify you approximately 40 minutes before arriving at your home. My name is Ozzi.`;
}

// Enviada quando um cliente com a flag booked VENCIDA afirma que tem uma visita
// que o scheduler não mostra (gate code, "we had a confirmed appointment") — o
// dono pode ter combinado por fora do bot (caso Msleo 2026-08-05: remarcação
// manual pelo app do IG nunca chegou ao scheduler). Não afirma NADA sobre data
// ou disponibilidade: reconhece e passa para o Ozzi. Sem traço, sem emoji.
export function appointmentMismatchHandoffMessage(lang: Lang): string {
  if (lang === "pt") return "Obrigado! O Ozzi vai revisar pessoalmente os detalhes da sua visita e te confirma tudo em seguida.";
  return lang === "es"
    ? "Gracias! Ozzi va a revisar personalmente los detalles de tu visita y te confirma todo enseguida."
    : "Thank you! Let me have Ozzi personally double check your visit details and confirm everything with you shortly.";
}

// Sent to the client when the booking could NOT be created (slot genuinely
// unavailable, scheduler error, etc.). Honest, never claims the slot was
// "just taken", and hands the lead to Ozzi so it is never lost.
export function bookingFailureHandoffMessage(lang: Lang): string {
  if (lang === "pt") return "Desculpa, não consegui confirmar esse horário no sistema. Já avisei o Ozzi para confirmar sua visita diretamente, em breve ele te contata.";
  return lang === "es"
    ? "Disculpa, no pude confirmar ese horario en el sistema. Le aviso a Ozzi para que confirme tu cita directamente, en breve te contacta."
    : "Sorry, I couldn't lock in that exact time in the system. I'm having Ozzi confirm your appointment directly, you'll hear back shortly.";
}

// Sent when the model wrote its pre-booking line ("Perfect, see you then!") but
// NO visit was written — the [BOOK] tag was lost, unusable or never emitted
// (Shaeleen Herrera-Garcia, IG 2026-08-26: she waited at home for a 7pm visit
// nobody had in the system). Neutral on purpose: never "locked in", and not the
// failure line either (the owner may have set the visit by hand); Ozzi confirms
// and the owner is alerted with the conversation.
export function bookingUnverifiedHandoffMessage(lang: Lang): string {
  if (lang === "pt") return "Deixa eu pedir para o Ozzi confirmar os detalhes da sua visita diretamente, em breve ele te contata.";
  return lang === "es"
    ? "Déjame pedirle a Ozzi que confirme los detalles de tu visita directamente, en breve te contacta."
    : "Let me have Ozzi confirm your visit details directly, you'll hear back shortly.";
}

// The phone in [BOOK] must be one the CLIENT typed. The model re-types the
// digits and transposes them: in 5 of 8 replays of the Shaeleen turn (IG,
// 2026-08-26, the client typed 305-431-3770) it wrote 3053413770 — a visit the
// seller could never confirm by phone. Deterministic: when the client typed at
// least one real number in this conversation and the tag's digits match none of
// them, use the LAST number the client typed. No client-typed number (WhatsApp
// chat id, number given by voice) → the tag's value stands.
const TYPED_PHONE = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4}(?!\d)/g;
function phoneDigits(s: string | null | undefined): string {
  return (s ?? "").replace(/\D/g, "").replace(/^1(?=\d{10}$)/, "");
}
export function reconcileBookingPhone(
  phone: string | null | undefined,
  history?: Array<{ role: string; content: string }>
): { phone: string | null | undefined; corrected: boolean; reason?: string } {
  if (!history || history.length === 0) return { phone, corrected: false };
  const typed: string[] = [];
  for (const m of history) {
    if (m.role !== "user") continue;
    const text = (m.content || "").split(/\n\n?\[SYSTEM:/)[0];
    for (const cand of text.match(TYPED_PHONE) ?? []) {
      const d = phoneDigits(cand);
      if (d.length === 10) typed.push(d);
    }
  }
  if (typed.length === 0) return { phone, corrected: false };
  const tagDigits = phoneDigits(phone);
  if (tagDigits && typed.includes(tagDigits)) return { phone, corrected: false };
  const last = typed[typed.length - 1];
  return {
    phone: last,
    corrected: true,
    reason: "tag phone " + JSON.stringify(phone ?? null) + " is not a number the client typed; using " + last,
  };
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
export function needNameMessage(lang: Lang): string {
  if (lang === "pt") return "Última coisinha! Em nome de quem eu coloco a visita?";
  return lang === "es"
    ? "Última cosita! A nombre de quién pongo la visita?"
    : "Last thing! What name should I put the visit under?";
}

// We do NOT do repairs of any kind (owner rule 2026-08-25, Priti Budhrani case:
// a "replace the damaged tiles" request was booked as a visit). Sent by the
// webhooks when a [BOOK], visit offer or booking-details ask leaks through while
// the client's standing request is a repair (ai.repairRequestActive).
export function repairDeclineMessage(lang: Lang): string {
  if (lang === "pt") return "No momento só fazemos instalações completas, não fazemos reparos de nenhum tipo. Trabalhamos com projetos acima de 500 pés quadrados. Se um dia precisar de um piso novo, é só me chamar!";
  return lang === "es"
    ? "Por el momento solo hacemos instalaciones completas, no hacemos reparaciones de ningún tipo. Trabajamos con proyectos de más de 500 pies cuadrados. Si algún día necesita un piso nuevo, con gusto le ayudo."
    : "At the moment we only do full installations, we don't do repairs of any kind. We work with projects over 500 square feet. If you ever need a new floor, I'm happy to help!";
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
export function needAddressMessage(lang: Lang): string {
  if (lang === "pt") return "Perfeito! Qual é o endereço completo da propriedade, com o zip code, para a visita?";
  return lang === "es"
    ? "Perfecto! Cuál es la dirección completa de la propiedad, con el código postal, para la visita?"
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
export function needZipMessage(lang: Lang): string {
  if (lang === "pt") return "Quase pronto! Qual é o zip code desse endereço?";
  return lang === "es"
    ? "Casi listo! Cuál es el código postal de esa dirección?"
    : "Almost set! What's the zip code for that address?";
}

// Sent when we have the slot + address but still need a real callback number
// before booking (the client gave a non-number like "Messenger", or no phone).
export function needPhoneMessage(lang: Lang): string {
  if (lang === "pt") return "Quase pronto! Qual é o melhor número de telefone para eu confirmar a visita?";
  return lang === "es"
    ? "Casi listo! Cuál es el mejor número de teléfono para confirmarte la visita?"
    : "Almost set! What's the best phone number to reach you so I can lock in the visit?";
}

// Sent to the client after their visit is successfully moved to a new slot.
// The webhook already includes the new day/time around it via the AI, so this
// stays short and never repeats details that could drift from the real booking.
export function rescheduleSuccessMessage(lang: Lang): string {
  if (lang === "pt") return "Pronto, sua visita foi remarcada. Eu te aviso aproximadamente 40 minutos antes de chegar. Meu nome é Ozzi.";
  return lang === "es"
    ? "Listo, tu visita quedó reagendada. Te aviso aproximadamente 40 minutos antes de llegar. Mi nombre es Ozzi."
    : "All set, your visit has been rescheduled. I will notify you approximately 40 minutes before arriving. My name is Ozzi.";
}

// Sent to the client when the AI itself is unavailable (API down, credits
// exhausted, rate limited, timeout, network error). Without this, an AI outage
// means the client gets TOTAL SILENCE and the lead is lost. This keeps the
// client warm with an honest holding reply while the owner is notified and the
// conversation is handed to a human.
export function aiOutageHandoffMessage(lang: Lang): string {
  if (lang === "pt") return "Obrigado pela sua mensagem! Já avisei nossa equipe e alguém te contata em seguida.";
  return lang === "es"
    ? "Gracias por tu mensaje! Le aviso a nuestro equipo y alguien te contacta en seguida."
    : "Thanks for your message! Let me get our team to reach out, someone will get right back to you.";
}

// ─── Horários de um dia ordenados pela rota (mensagens enlatadas) ────────────
// needTimeChoiceMessage / slotConflictRecoveryMessage sempre ofereceram os N
// primeiros horários do dia em ordem cronológica. Com o endereço do cliente em
// mãos (o [BOOK] já traz), os N escolhidos passam a ser os de melhor rota —
// MESMA quantidade, apresentados em ordem cronológica. Sem localização ou com
// qualquer erro → os N primeiros de sempre.
async function routeOrderedSlots(
  dateStr: string,
  slots: string[],
  clientAddress: string | null | undefined,
  count: number
): Promise<string[]> {
  const base = slots.slice(0, count);
  try {
    const cfg = getRouteConfig();
    if (!cfg.enabled || slots.length <= count) return base;
    const client = locationFromAddress(clientAddress);
    if (!client) return base;
    const db = await getAuthenticatedClient();
    const [{ data: sellersData }, { data: bookedData }, daysOff, rows] = await Promise.all([
      db.from("sellers").select("id,name,priority,enabled_weekdays,time_slots,weekday_time_slots,active").eq("active", true).order("priority", { ascending: true }),
      db.rpc("get_booked_slots", { _from: dateStr, _to: dateStr }),
      getDaysOff(db, dateStr, dateStr),
      fetchVisitsWithAddress(db, dateStr, dateStr),
    ]);
    const sellers = (sellersData ?? []) as Seller[];
    const bookings = (bookedData ?? []) as BookingRow[];
    const weekday = new Date(dateStr + "T12:00:00").getDay();
    const wanted = new Set(slots);
    const openBySlot = new Map<string, RouteSeller[]>();
    for (const s of sellers) for (const slot of slotsForWeekday(s, weekday)) {
      if (!wanted.has(slot) || !sellerOpenForSlot(s, dateStr, weekday, slot, bookings, daysOff)) continue;
      openBySlot.set(slot, [...(openBySlot.get(slot) ?? []), asRouteSeller(s)]);
    }
    // Um horário da lista que a leitura acima não confirmou continua na lista
    // (a lista de entrada é a verdade do chamador): recebe um vendedor SINTÉTICO
    // neutro (sem visitas, nunca o preferido), não a lista de vendedores reais.
    const UNCONFIRMED: RouteSeller = { id: "__unconfirmed__", name: "?", priority: Number.MAX_SAFE_INTEGER };
    for (const slot of slots) if (!openBySlot.has(slot)) openBySlot.set(slot, [UNCONFIRMED]);
    const visits = toExistingVisits(rows);
    const points: GeoPoint[] = [client];
    const index = new Map<string, number>([[geoKey(client), 0]]);
    for (const v of visits) {
      if (!v.point) continue;
      const k = geoKey(v.point);
      if (!index.has(k)) { index.set(k, points.length); points.push(v.point); }
    }
    const matrix = await travelMatrix(points, cfg);
    const between = (a: GeoPoint, b: GeoPoint) => {
      const ia = index.get(geoKey(a));
      const ib = index.get(geoKey(b));
      return ia === undefined || ib === undefined ? estimateMinutes(a, b, cfg) : matrix.minutes[ia][ib];
    };
    const ranked = rankSlotsForDay(client, openBySlot, visits, between, cfg, sellers.map(asRouteSeller));
    const picked = pickSlotsByRoute(ranked, count);
    logRouteDecision({
      kind: "recovery", date: dateStr, zip: client.zip ?? null, clientLabel: client.label ?? null, provider: matrix.provider, fallback: matrix.fallbackReason ?? null,
      reason: picked.join(",") === base.join(",") ? "route order = chronological order" : `route order picked ${picked.join(",")} instead of ${base.join(",")}`,
      presented: picked, options: ranked.map((r) => ({ slot: r.slot, score: r.score, tier: r.tier, seller: r.bestSeller?.name ?? null })),
    }, false);
    return picked.length ? picked : base;
  } catch (err) {
    console.error("[route] routeOrderedSlots failed — using chronological order:", err);
    return base;
  }
}

export async function getAvailableSlots(dateStr: string): Promise<string[]> {
  try {
    const db = await getAuthenticatedClient();
    const [{ data: sellersData }, { data: bookedData }, daysOff] = await Promise.all([
      db
        .from("sellers")
        .select("id,name,priority,enabled_weekdays,time_slots,weekday_time_slots,active")
        .eq("active", true)
        .order("priority", { ascending: true }),
      db.rpc("get_booked_slots", { _from: dateStr, _to: dateStr }),
      getDaysOff(db, dateStr, dateStr),
    ]);

    const sellers = (sellersData ?? []) as Seller[];
    const bookings = (bookedData ?? []) as BookingRow[];
    const date = new Date(dateStr + "T12:00:00");
    const weekday = date.getDay();

    const slotSet = new Set<string>();
    sellers.forEach((s) => {
      slotsForWeekday(s, weekday).forEach((slot) => {
        if (sellerOpenForSlot(s, dateStr, weekday, slot, bookings, daysOff)) slotSet.add(slot);
      });
    });

    return Array.from(slotSet).sort();
  } catch {
    return ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"];
  }
}

// ─── Post-booking ADDRESS CORRECTION ───────────────────────────────────────
// Caso Kristina Mittendorff (IG, 2026-08-13): no agendamento a cliente digitou
// "300 s Australian Av, 1506, 33401" e o booking gravou exatamente isso. Quatro
// dias depois ela mandou "300 s Australian Av 916" — a MESMA rua, outro
// apartamento. Não existia NENHUM caminho que atualizasse o endereço de uma
// visita já confirmada: a correção morreu no fluxo silencioso de booked, o
// registro ficou com o 1506 e o vendedor foi para o apartamento errado.
//
// A detecção é 100% determinística (o modelo nunca decide sobre isso): compara
// o endereço GRAVADO com o que a rajada do cliente traz. Só a troca de UNIDADE
// na mesma rua é escrita sozinha, porque é inequívoca. Rua diferente = possível
// mudança de imóvel, isso vai para o dono decidir.

const STREET_SUFFIXES: Record<string, string> = {
  st: "st", street: "st",
  ave: "ave", av: "ave", avenue: "ave",
  blvd: "blvd", boulevard: "blvd",
  dr: "dr", drive: "dr",
  rd: "rd", road: "rd",
  ln: "ln", lane: "ln",
  ct: "ct", court: "ct",
  way: "way",
  ter: "ter", terr: "ter", terrace: "ter",
  pl: "pl", place: "pl",
  hwy: "hwy", highway: "hwy",
  cir: "cir", circle: "cir",
  pkwy: "pkwy", parkway: "pkwy",
  calle: "calle", avenida: "avenida",
};
const DIRECTIONALS = new Set([
  "n", "s", "e", "w", "ne", "nw", "se", "sw",
  "north", "south", "east", "west", "northeast", "northwest", "southeast", "southwest",
]);
const UNIT_WORD = /^(?:apt|apto|apartment|apartamento|unit|unidad|unidade|suite|ste|room|rm)$/;
// "Apt 916", "unit 916", "#916" — uma correção de unidade sem repetir a rua.
// A lookahead final derruba "apartment 750 sqft": metragem e preço são os dois
// números que mais aparecem colados nessas palavras e não são unidade nenhuma.
const BARE_UNIT_RE =
  /(?:^|[\s,;(])(?:(?:apt|apto|apartment|apartamento|unit|unidad|unidade|suite|ste)\.?\s*#?\s*|#\s*)(\d{1,6}[a-z]?)\b(?!\s*(?:sq|sqft|sf|square|feet|foot|ft|dollars?|usd|k\b))/i;

// Pré-filtro barato, rodado ANTES de tocar o banco da agenda: toda mensagem de
// cliente já agendado passaria a pagar um login + select sem isto.
export function mayCarryAddressCorrection(text?: string | null): boolean {
  const t = (text ?? "").toString();
  if (!t.trim()) return false;
  if (BARE_UNIT_RE.test(t)) return true;
  // O nome da rua aceita token com dígito ("NW 7th St"): sem isso o pré-filtro
  // barrava endereços de OUTRA rua e a mudança de imóvel voltava a morrer antes
  // da detecção. Ser permissivo aqui só custa uma consulta; quem decide de fato
  // é o parseStreetAddress.
  return /\b\d{1,6}[a-z]?\b[\s,.-]+(?:[\w'.-]+[\s,.-]+){0,4}(?:st|street|ave|av|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|ct|court|way|ter|terr|terrace|pl|place|hwy|highway|cir|circle|pkwy|parkway|calle|avenida)\b/i.test(
    t
  );
}

export interface ParsedStreetAddress {
  house: string;
  street: string; // tokens do nome da rua, sem direcional e sem sufixo
  suffix: string; // sufixo normalizado (ave, st, blvd...)
  unit: string | null;
  head: string; // trecho original até o sufixo, inclusive
  tail: string; // trecho original depois da unidade (cidade/estado/zip)
}

// Quebra um endereço em casa + rua + sufixo + unidade, guardando os offsets do
// texto original para conseguir remontar a string sem perder cidade/estado/ZIP.
// Devolve null quando não dá para ter certeza (sem número de casa ou sem sufixo
// de rua reconhecido) — melhor não detectar nada do que detectar errado.
export function parseStreetAddress(input?: string | null): ParsedStreetAddress | null {
  const s = (input ?? "").toString();
  if (!s.trim()) return null;
  const toks: Array<{ norm: string; start: number; end: number }> = [];
  const re = /[^\s,;]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const norm = m[0].toLowerCase().replace(/^#+/, "").replace(/[.]+$/, "");
    if (norm) toks.push({ norm, start: m.index, end: m.index + m[0].length });
  }
  if (toks.length < 3) return null;

  // O ZIP não faz parte da rua nem pode ser confundido com unidade.
  const zip = extractZip(s);
  const zipTok = zip ? toks.findIndex((t, i) => i > 0 && t.norm.replace(/-\d{4}$/, "") === zip) : -1;

  if (!/^\d{1,6}[a-z]?$/.test(toks[0].norm)) return null;
  const house = toks[0].norm;

  const street: string[] = [];
  let suffix = "";
  let suffixIdx = -1;
  let i = 1;
  for (; i < toks.length; i++) {
    if (i === zipTok) break;
    const t = toks[i].norm;
    if (DIRECTIONALS.has(t) && street.length === 0) continue; // "300 S Australian Ave"
    if (STREET_SUFFIXES[t] && street.length > 0) {
      suffix = STREET_SUFFIXES[t];
      suffixIdx = i;
      i++;
      break;
    }
    if (street.length >= 5) return null; // não é um endereço, é texto solto
    street.push(t);
  }
  if (!suffix || street.length === 0) return null;

  // Depois do sufixo pode vir um direcional ("300 Australian Ave NW, 916").
  let headIdx = suffixIdx;
  while (i < toks.length && DIRECTIONALS.has(toks[i].norm) && i !== zipTok) {
    headIdx = i;
    i++;
  }

  let unit: string | null = null;
  let unitIdx = -1;
  for (; i < toks.length; i++) {
    if (i === zipTok) break;
    const t = toks[i].norm;
    if (UNIT_WORD.test(t)) continue; // "apt" antes do número
    if (/^\d{1,6}[a-z]?$/.test(t)) {
      unit = t;
      unitIdx = i;
    }
    break;
  }

  return {
    house,
    street: street.join(" "),
    suffix,
    unit,
    head: s.slice(0, toks[headIdx].end),
    tail: unitIdx >= 0 ? s.slice(toks[unitIdx].end) : s.slice(toks[headIdx].end),
  };
}

function sameStreet(a: ParsedStreetAddress, b: ParsedStreetAddress): boolean {
  return a.house === b.house && a.street === b.street && a.suffix === b.suffix;
}

// Remonta o endereço gravado trocando só a unidade, preservando cidade, estado
// e ZIP que o cliente não repetiu ao mandar a correção.
function withUnit(booked: ParsedStreetAddress, unit: string): string {
  const tail = booked.tail.replace(/^[\s,;]+/, "").trim();
  return `${booked.head.trim()}, ${unit}${tail ? `, ${tail}` : ""}`.replace(/\s+/g, " ").trim();
}

export type AddressCorrection =
  | { kind: "unit"; unit: string; previousUnit: string | null; address: string }
  | { kind: "moved"; address: string };

// Compara a rajada do cliente com o endereço já gravado. null = nada a fazer
// (não veio endereço, ou veio o MESMO endereço repetido).
export function detectAddressCorrection(
  burst: string,
  bookedAddress: string
): AddressCorrection | null {
  const booked = parseStreetAddress(bookedAddress);
  if (!booked) return null;
  const text = (burst ?? "").toString();
  if (!text.trim()) return null;

  for (const line of text.split(/[\n\r]+/)) {
    const cand = parseStreetAddress(line);
    if (!cand) continue;
    if (!sameStreet(cand, booked)) return { kind: "moved", address: line.trim().slice(0, 300) };
    if (cand.unit && cand.unit !== booked.unit) {
      return { kind: "unit", unit: cand.unit, previousUnit: booked.unit, address: withUnit(booked, cand.unit) };
    }
    return null; // mesma rua, mesma unidade: só repetiu o endereço
  }

  // Sem rua na mensagem: "Apt 916" / "#916" ainda é uma correção de unidade.
  const bare = BARE_UNIT_RE.exec(text);
  if (bare && bare[1].toLowerCase() !== (booked.unit ?? "").toLowerCase()) {
    const unit = bare[1].toLowerCase();
    return { kind: "unit", unit, previousUnit: booked.unit, address: withUnit(booked, unit) };
  }
  return null;
}

// As últimas falas do cliente, sem o sufixo [SYSTEM:...] que os webhooks anexam
// (esse sufixo já quebrou regex de histórico antes, no eco do followup).
export function recentClientText(history: Array<{ role: string; content: string }>, n = 6): string {
  return history
    .filter((m) => m.role === "user")
    .slice(-n)
    .map((m) => (m.content || "").split(/\n\n?\[SYSTEM:/)[0])
    .join("\n");
}

export interface UpcomingBookingRecord {
  id: string;
  address: string;
  date: string;
  time: string;
}

// A visita ainda por acontecer deste cliente, com o endereço gravado.
export async function getUpcomingBookingRecord(igsid: string): Promise<UpcomingBookingRecord | null> {
  try {
    const db = await getAuthenticatedClient();
    const today = easternTodayStr();
    const { data, error } = await db
      .from("bookings")
      .select("id, address, booking_date, booking_time")
      .like("email", `ia-${igsid}@%`)
      .gte("booking_date", today)
      .order("booking_date", { ascending: true })
      .order("booking_time", { ascending: true });
    if (error) {
      console.error("getUpcomingBookingRecord error:", error.message);
      return null;
    }
    const { hour, minute } = easternNowHM();
    const nowMinutes = hour * 60 + minute;
    const row = (data ?? []).find((b) =>
      visitStillUpcoming(b.booking_date, b.booking_time, today, nowMinutes)
    );
    if (!row) return null;
    return {
      id: row.id,
      address: (row.address ?? "").toString(),
      date: row.booking_date,
      time: row.booking_time ?? "",
    };
  } catch (err) {
    console.error("getUpcomingBookingRecord exception:", err);
    return null;
  }
}

// Escreve o endereço novo na visita. Checa error E linhas afetadas: um update
// barrado por RLS volta sem error e com zero linhas, e um "sucesso" fantasma
// aqui é o vendedor indo para o endereço velho de novo.
export async function updateBookingAddress(
  bookingId: string,
  newAddress: string
): Promise<{ success: boolean; error?: string }> {
  try {
    const db = await getAuthenticatedClient();
    const { data, error } = await db
      .from("bookings")
      .update({ address: newAddress.trim().slice(0, 300) })
      .eq("id", bookingId)
      .select("id");
    if (error) return { success: false, error: error.message };
    if (!data || data.length === 0) return { success: false, error: "no_rows_updated" };
    return { success: true };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

export type PostBookingAddressResult =
  | { kind: "unit"; unit: string; address: string; previousAddress: string; bookingId: string }
  | { kind: "moved"; address: string; previousAddress: string; bookingId: string }
  | { kind: "failed"; address: string; previousAddress: string; bookingId: string; error: string };

// Ponto único usado pelos 3 webhooks: detecta a correção na rajada e, quando é
// troca de unidade na mesma rua, já grava. Devolve null quando não há nada a
// fazer, e o webhook segue o fluxo normal.
export async function applyPostBookingAddressCorrection(
  igsid: string,
  burst: string
): Promise<PostBookingAddressResult | null> {
  if (!mayCarryAddressCorrection(burst)) return null;
  const booking = await getUpcomingBookingRecord(igsid);
  if (!booking || !booking.address.trim()) return null;
  const corr = detectAddressCorrection(burst, booking.address);
  if (!corr) return null;

  if (corr.kind === "moved") {
    // Rua diferente: pode ser outro imóvel, não sobrescreve sozinho.
    return { kind: "moved", address: corr.address, previousAddress: booking.address, bookingId: booking.id };
  }
  const upd = await updateBookingAddress(booking.id, corr.address);
  if (!upd.success) {
    console.error(`[booking] address correction FAILED for ${igsid}: ${upd.error}`);
    return { kind: "failed", address: corr.address, previousAddress: booking.address, bookingId: booking.id, error: upd.error ?? "unknown" };
  }
  console.warn(`[booking] address corrected for ${igsid}: "${booking.address}" -> "${corr.address}"`);
  return { kind: "unit", unit: corr.unit, address: corr.address, previousAddress: booking.address, bookingId: booking.id };
}

// Anota no booking (campo notes) um pedido feito DEPOIS da visita marcada —
// "Text me or call me please 40 mins before" — para o vendedor ver no cartão.
// Best-effort: nunca lança, nunca bloqueia a resposta ao cliente.
export async function appendUpcomingBookingNote(igsid: string, note: string): Promise<boolean> {
  try {
    const clean = (note || "").replace(/\s+/g, " ").trim().slice(0, 160);
    if (!clean) return false;
    const booking = await getUpcomingBookingRecord(igsid);
    if (!booking) return false;
    const db = await getAuthenticatedClient();
    const { data: row } = await db.from("bookings").select("notes").eq("id", booking.id).maybeSingle();
    const current = ((row?.notes ?? "") as string).toString();
    if (current.includes(clean)) return true;
    const merged = [current.trim(), clean].filter(Boolean).join(" | ").slice(0, 1000);
    const { error } = await db.from("bookings").update({ notes: merged }).eq("id", booking.id);
    if (error) {
      console.error(`[booking] note append FAILED for ${igsid}: ${error.message}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("[booking] note append exception:", err);
    return false;
  }
}

// Confirmação curta ao cliente depois de trocar a unidade na visita marcada.
export function addressCorrectedMessage(lang: Lang, unit: string): string {
  if (lang === "pt") return `Pronto, já atualizei o endereço da sua visita para ${unit}. O Ozzi te avisa uns 40 minutos antes de chegar.`;
  return lang === "es"
    ? `Listo, ya actualicé la dirección de tu visita al ${unit}. Ozzi te avisa unos 40 minutos antes de llegar.`
    : `Got it, I updated your visit address to ${unit}. Ozzi will message you about 40 minutes before arriving.`;
}

// Endereço de OUTRA rua depois da visita marcada, ou falha ao gravar: o cliente
// recebe um aviso honesto em vez do silêncio, e o dono decide.
export function addressChangeHandoffMessage(lang: Lang): string {
  if (lang === "pt") return "Obrigado, anotei o endereço novo. O Ozzi te confirma a mudança antes da visita.";
  return lang === "es"
    ? "Gracias, anoté la dirección nueva. Ozzi te confirma el cambio antes de la visita."
    : "Thanks, I have the new address. Ozzi will confirm the change with you before the visit.";
}

// Linha de alerta no WhatsApp do dono. O que importa é ele bater o olho e saber
// se precisa fazer alguma coisa antes do vendedor sair.
export function postBookingAddressAlert(r: PostBookingAddressResult): string {
  if (r.kind === "unit") {
    return `ENDERECO DA VISITA ATUALIZADO (unidade ${r.unit}).\nAntes: ${r.previousAddress}\nAgora: ${r.address}`;
  }
  if (r.kind === "moved") {
    return `CLIENTE MANDOU OUTRO ENDERECO depois da visita marcada. NAO foi alterado, confirme com ele.\nNa agenda: ${r.previousAddress}\nMandou: ${r.address}`;
  }
  return `FALHA AO ATUALIZAR O ENDERECO DA VISITA (${r.error}). Corrija na plataforma!\nNa agenda: ${r.previousAddress}\nDeveria ser: ${r.address}`;
}

// ─── Cancellation messages (deterministic, never the model's own text) ──────
// The client must hear WHICH visit was cancelled (the real scheduler date/time,
// so they can catch a mix-up) and that we reschedule whenever they are ready.
// The model's free text used to be sent as-is — even when the scheduler delete
// FAILED, the client still got a reassuring goodbye and the seller still drove
// out. Two short sentences, no dashes, no emojis (owner rules).
export function cancellationConfirmedMessage(lang: Lang, dateStr: string, timeStr: string): string {
  const { weekday, month, day } = ymd(dateStr);
  const time = /^\d{1,2}:\d{2}/.test((timeStr || "").trim()) ? fmt12(timeStr.trim().slice(0, 5)) : (timeStr || "").trim();
  const atTime = time ? (lang === "en" ? ` at ${time}` : lang === "es" ? ` a las ${time}` : ` às ${time}`) : "";
  if (lang === "pt") {
    return `Sem problema, sua visita de ${DAY_NAMES_PT[weekday]} dia ${day} de ${MONTH_NAMES_PT[month]}${atTime} foi cancelada. Quando você estiver pronto é só me escrever por aqui e agendamos de novo no dia que ficar melhor para você, estamos à disposição.`;
  }
  if (lang === "es") {
    return `Sin problema, tu visita del ${DAY_NAMES_ES[weekday]} ${day} de ${MONTH_NAMES_ES[month]}${atTime} quedó cancelada. Cuando estés listo solo escríbeme por aquí y agendamos de nuevo el día que mejor te quede, quedamos a la orden.`;
  }
  return `No worries, your visit for ${DAY_NAMES[weekday]}, ${MONTH_NAMES[month]} ${day}${atTime} is cancelled. Whenever you're ready just message me here and we'll set it up again on the day that works best for you, we're always at your disposal.`;
}

// The scheduler delete FAILED (or blew up): never claim the visit is cancelled.
// Honest handoff — the owner gets the siren alert and cancels by hand.
export function cancellationHandoffMessage(lang: Lang): string {
  if (lang === "pt") return "Entendido, já passei seu pedido de cancelamento para o Ozzi e ele te confirma em seguida. Quando você estiver pronto agendamos uma nova visita no dia que ficar melhor para você.";
  return lang === "es"
    ? "Entendido, ya pasé tu solicitud de cancelación a Ozzi y él te la confirma enseguida. Cuando estés listo agendamos una nueva visita el día que mejor te quede."
    : "Got it, I sent your cancellation request to Ozzi and he will confirm it with you right away. Whenever you're ready we can set up a new visit on the day that works best for you.";
}

// Owner WhatsApp alert for every cancellation attempt, so cancellations are
// trackable without reading the whole DM firehose (and the seller never drives
// to a cancelled visit). ASCII like the other alerts.
export function cancellationAlert(
  r: { success: boolean; visits?: CancelledVisit[]; error?: string }
): string {
  if (r.success && r.visits && r.visits.length > 0) {
    const lines = r.visits.map((v) => {
      const { weekday } = ymd(v.date);
      return `${DAY_NAMES[weekday]} ${v.date} as ${v.time}${v.address ? ` - ${v.address}` : ""}`;
    });
    return `VISITA CANCELADA PELO CLIENTE (ja removida da agenda, vendedor NAO precisa ir):\n${lines.join("\n")}`;
  }
  if (r.error === "no_booking_found") {
    return `Cliente pediu CANCELAMENTO mas nao havia visita futura na agenda (nada foi cancelado). Confira se a visita foi criada por fora.`;
  }
  return `CLIENTE PEDIU CANCELAMENTO E NAO CONSEGUI CANCELAR NA AGENDA (${r.error ?? "erro"}). CANCELE MANUALMENTE na plataforma!`;
}
