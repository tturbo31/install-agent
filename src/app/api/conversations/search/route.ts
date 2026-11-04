import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getAuthenticatedClient } from "@/lib/scheduler";
import {
  parseSearchQuery,
  digitsPattern,
  orGroupAllWords,
  igsidFromBookingEmail,
  looksLikeAddress,
  classifyDigitsMatch,
  snippetAround,
  mergeMatches,
  scoreOf,
  cleanClientText,
  type ParsedQuery,
  type SearchMatch,
} from "@/lib/conversation-search";

// GET /api/conversations/search?q=…
//
// Acha a conversa pelo que o cliente mandou (04/11/2026). Fontes, em paralelo:
//   1. perfil (name/username) e número do WhatsApp (igsid "wa_…");
//   2. histórico de mensagens do CLIENTE (role=user) — telefone, endereço, trecho;
//   3. visitas marcadas pelo bot na agenda (bookings, SÓ LEITURA: phone/address/name,
//      e-mail "ia-<igsid>@…" liga a visita à conversa).
// (funil_estado.telefone não entra: a tabela não existe no banco do app — PGRST205.)
// Uma fonte fora do ar não derruba a busca: responde `partial: true`.
//
// Modo telefone: dígitos em ordem com qualquer coisa no meio ("954 123 4567"
// acha "(954) 123-4567"); modo texto: todas as palavras, em qualquer ordem,
// então "105 bandol" acha "105bandol street" (número colado à rua, 26/10).

type ConvRow = {
  id: string;
  igsid: string;
  name: string | null;
  username: string | null;
  profile_pic: string | null;
  follower_count: number | null;
  is_user_follow_business: boolean | null;
  is_business_follow_user: boolean | null;
  mode: "agent" | "human";
  updated_at: string;
  created_at: string;
  instagram_messages?: Array<{ content: string; created_at: string; role: string }>;
};

const MAX_RESULTS = 60;

export async function GET(req: NextRequest) {
  const q = parseSearchQuery(req.nextUrl.searchParams.get("q") ?? "");
  if (q.mode === "none") return NextResponse.json({ results: [], partial: false });

  const byConv = new Map<string, SearchMatch[]>();
  const byIgsid = new Map<string, SearchMatch[]>();
  const add = (map: Map<string, SearchMatch[]>, key: string, m: SearchMatch) => {
    const list = map.get(key) ?? [];
    list.push(m);
    map.set(key, list);
  };

  const sources = [
    ["perfil", searchProfiles(q, (id, m) => add(byConv, id, m))],
    ["mensagens", searchMessages(q, (id, m) => add(byConv, id, m))],
    ["agenda", searchBookings(q, (igsid, m) => add(byIgsid, igsid, m))],
  ] as const;
  const settled = await Promise.allSettled(sources.map(([, p]) => p));
  let partial = false;
  settled.forEach((s, i) => {
    if (s.status === "rejected") {
      partial = true;
      console.error(`[search] fonte "${sources[i][0]}" falhou:`, s.reason);
    }
  });

  // Visitas → conversa pelo igsid.
  if (byIgsid.size > 0) {
    const { data } = await supabaseAdmin
      .from("instagram_conversations")
      .select("id, igsid")
      .in("igsid", [...byIgsid.keys()]);
    for (const row of (data ?? []) as Array<{ id: string; igsid: string }>) {
      for (const m of byIgsid.get(row.igsid) ?? []) add(byConv, row.id, m);
    }
  }

  if (byConv.size === 0) return NextResponse.json({ results: [], partial });

  // Ordena pelo peso dos matches e carrega só as conversas que entram na resposta.
  const ranked = [...byConv.entries()]
    .map(([id, matches]) => ({ id, matches: mergeMatches(matches) }))
    .sort((a, b) => scoreOf(b.matches) - scoreOf(a.matches))
    .slice(0, MAX_RESULTS);

  const { data: convs, error } = await supabaseAdmin
    .from("instagram_conversations")
    .select("*, instagram_messages ( content, created_at, role )")
    .in("id", ranked.map((r) => r.id));
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const convById = new Map<string, ConvRow>();
  for (const c of (convs ?? []) as ConvRow[]) convById.set(c.id, c);

  const results = ranked
    .map(({ id, matches }) => {
      const conv = convById.get(id);
      if (!conv) return null;
      const sorted = [...(conv.instagram_messages ?? [])].sort(
        (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
      const last = sorted[0];
      return {
        conversation: {
          ...conv,
          instagram_messages: undefined,
          last_message: last?.content ?? null,
          last_message_at: last?.created_at ?? null,
        },
        matches,
      };
    })
    .filter(Boolean);

  return NextResponse.json({ results, partial });
}

// ─── fontes ─────────────────────────────────────────────────────────────────

async function searchProfiles(q: ParsedQuery, add: (id: string, m: SearchMatch) => void) {
  let query = supabaseAdmin.from("instagram_conversations").select("id, igsid, name, username").limit(80);
  if (q.mode === "phone") {
    query = query.like("igsid", "wa_%").ilike("igsid", `%${q.digits}%`);
  } else {
    query = query.or(orGroupAllWords(["name", "username"], q.words));
  }
  const { data, error } = await query;
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ id: string; igsid: string; name: string | null; username: string | null }>) {
    if (q.mode === "phone") add(row.id, { kind: "telefone", text: row.igsid.slice(3) });
    else add(row.id, { kind: "nome", text: (row.name ?? row.username ?? "").trim() });
  }
}

async function searchMessages(q: ParsedQuery, add: (id: string, m: SearchMatch) => void) {
  let query = supabaseAdmin
    .from("instagram_messages")
    .select("conversation_id, content, created_at")
    .eq("role", "user")
    .order("created_at", { ascending: false })
    .limit(300);
  if (q.mode === "phone") {
    query = query.filter("content", "imatch", digitsPattern(q.digits));
  } else {
    for (const w of q.words) query = query.ilike("content", `%${w}%`);
  }
  const { data, error } = await query;
  if (error) throw error;
  for (const row of (data ?? []) as Array<{ conversation_id: string; content: string; created_at: string }>) {
    const clean = cleanClientText(row.content);
    // A injeção [SYSTEM:] pode conter o que se busca sem o cliente ter dito.
    if (!clean) continue;
    const stillMatches =
      q.mode === "phone"
        ? clean.replace(/\D/g, "").includes(q.digits)
        : q.words.every((w) => clean.toLowerCase().includes(w));
    if (!stillMatches) continue;
    const kind: SearchMatch["kind"] = q.mode === "phone"
      ? classifyDigitsMatch(clean, q.digits)
      : looksLikeAddress(clean) ? "endereco" : "mensagem";
    add(row.conversation_id, { kind, text: snippetAround(clean, q), at: row.created_at });
  }
}

async function searchBookings(q: ParsedQuery, add: (igsid: string, m: SearchMatch) => void) {
  const db = await getAuthenticatedClient();
  const base = () =>
    db
      .from("bookings")
      .select("id, name, phone, address, email, booking_date, booking_time")
      .like("email", "ia-%")
      .order("booking_date", { ascending: false })
      .limit(60);
  type BookingRow = { id: string; name: string | null; phone: string | null; address: string | null; email: string | null; booking_date: string; booking_time: string };
  const rows: BookingRow[] = [];
  if (q.mode === "phone") {
    const [byPhone, byAddress] = await Promise.all([
      base().filter("phone", "imatch", digitsPattern(q.digits)),
      base().ilike("address", `%${q.digits}%`),
    ]);
    if (byPhone.error) throw byPhone.error;
    if (byAddress.error) throw byAddress.error;
    rows.push(...((byPhone.data ?? []) as BookingRow[]), ...((byAddress.data ?? []) as BookingRow[]));
  } else {
    const { data, error } = await base().or(orGroupAllWords(["address", "name", "phone"], q.words));
    if (error) throw error;
    rows.push(...((data ?? []) as BookingRow[]));
  }
  const seen = new Set<string>();
  for (const b of rows) {
    if (seen.has(b.id)) continue;
    seen.add(b.id);
    const igsid = igsidFromBookingEmail(b.email);
    if (!igsid) continue;
    // "12/10 13:00" (ano só quando não é o atual)
    const [y, mo, d] = String(b.booking_date ?? "").split("-");
    const day = y === String(new Date().getFullYear()) ? `${d}/${mo}` : `${d}/${mo}/${(y ?? "").slice(2)}`;
    const when = `${day} ${String(b.booking_time ?? "").slice(0, 5)}`.trim();
    const what = [b.name, b.phone, b.address].filter(Boolean).join(" · ");
    add(igsid, { kind: "visita", text: `${when} — ${what}`.slice(0, 200), at: b.booking_date });
  }
}
