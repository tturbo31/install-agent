import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";

// Lista do painel (04/11/2026). ANTES: uma única consulta com TODAS as
// conversas e TODAS as mensagens embutidas; o Supabase corta em 1.000 linhas,
// então de 15.374 conversas o painel só via as 1.000 mais recentes (tudo antes
// de 29/10 sumia — caso "China lavoile", @chinalavoile, invisível na lista) e
// baixava ~7.000 mensagens a cada mensagem nova. AGORA: uma página por vez,
// por canal (ou só as pausadas), com a ÚLTIMA mensagem de cada conversa, e as
// contagens reais de cada aba.
//
// GET /api/conversations?channel=instagram|facebook|whatsapp|paused&limit=200&before=<updated_at ISO>
// → { conversations, hasMore, counts: { instagram, facebook, whatsapp, paused } }

const DEFAULT_LIMIT = 200;
// limit + 1 must stay under the server cap of 1,000 rows, or hasMore lies.
const MAX_LIMIT = 500;
type Tab = "instagram" | "facebook" | "whatsapp" | "paused";
const TABS: Tab[] = ["instagram", "facebook", "whatsapp", "paused"];

// The supabase builder types are too deep for a generic helper (TS2589), so the
// tab filter goes through this minimal structural view of the builder.
interface Filterable {
  like(column: string, pattern: string): Filterable;
  eq(column: string, value: string): Filterable;
  not(column: string, operator: string, value: string): Filterable;
}
function scope<T>(q: T, tab: Tab): T {
  const f = q as unknown as Filterable;
  if (tab === "whatsapp") return f.like("igsid", "wa_%") as unknown as T;
  if (tab === "facebook") return f.like("igsid", "fb_%") as unknown as T;
  if (tab === "paused") return f.eq("mode", "human") as unknown as T;
  return f.not("igsid", "like", "wa_%").not("igsid", "like", "fb_%") as unknown as T;
}

async function countOf(tab: Tab): Promise<number | null> {
  const base = supabaseAdmin.from("instagram_conversations").select("id", { count: "exact", head: true });
  const { count, error } = await scope(base, tab);
  return error ? null : count ?? 0;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const tabParam = sp.get("channel") ?? "instagram";
  const tab: Tab = (TABS as string[]).includes(tabParam) ? (tabParam as Tab) : "instagram";
  const limit = Math.min(Math.max(Number(sp.get("limit")) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const before = sp.get("before");

  let q = scope(
    supabaseAdmin
      .from("instagram_conversations")
      .select("*, instagram_messages ( content, created_at, role )"),
    tab
  )
    .order("updated_at", { ascending: false })
    // só a última mensagem de cada conversa (era o histórico inteiro)
    .order("created_at", { referencedTable: "instagram_messages", ascending: false })
    .limit(1, { referencedTable: "instagram_messages" })
    // uma a mais para saber se há outra página
    .limit(limit + 1);
  if (before) q = q.lt("updated_at", before);

  const [{ data, error }, ...counts] = await Promise.all([q, ...TABS.map(countOf)]);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const rows = (data ?? []) as Array<Record<string, unknown> & { instagram_messages?: Array<{ content: string; created_at: string }> }>;
  const hasMore = rows.length > limit;
  const conversations = rows.slice(0, limit).map((conv) => {
    const last = conv.instagram_messages?.[0];
    return {
      ...conv,
      instagram_messages: undefined,
      last_message: last?.content ?? null,
      last_message_at: last?.created_at ?? null,
    };
  });

  return NextResponse.json({
    conversations,
    hasMore,
    counts: Object.fromEntries(TABS.map((t, i) => [t, counts[i]])),
  });
}
