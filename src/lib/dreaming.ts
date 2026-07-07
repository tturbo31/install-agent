import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const SYSTEM_STORE_NAME = "ozzifloors-system";

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  return _anthropic;
}

// ─── System Memory Store (shared learnings, not per-client) ─────────────────

export async function getOrCreateSystemStore(): Promise<string> {
  // Use cached env var to avoid slow list() API call on every message
  if (process.env.ANTHROPIC_SYSTEM_STORE_ID) {
    return process.env.ANTHROPIC_SYSTEM_STORE_ID;
  }

  const anthropic = getAnthropic();
  const stores = await anthropic.beta.memoryStores.list();
  const existing = stores.data.find((s) => s.name === SYSTEM_STORE_NAME);
  if (existing) return existing.id;

  const store = await anthropic.beta.memoryStores.create({
    name: SYSTEM_STORE_NAME,
    description: "OzziFloors agent learnings, patterns, and best practices. Updated nightly by Dreaming.",
  });

  await anthropic.beta.memoryStores.memories.create(store.id, {
    path: "/learnings.md",
    content: [
      "# OzziFloors Agent — System Learnings",
      "",
      "Initial state. Will be updated nightly by Dreaming analysis.",
      "",
      "## Common client patterns",
      "(No data yet)",
      "",
      "## What closes bookings",
      "(No data yet)",
      "",
      "## Common objections",
      "(No data yet)",
      "",
      "## Where conversations stall",
      "(No data yet)",
    ].join("\n"),
  });

  return store.id;
}

export async function readSystemMemory(storeId: string): Promise<string | null> {
  try {
    const anthropic = getAnthropic();
    const page = await anthropic.beta.memoryStores.memories.list(storeId, { path_prefix: "/" });
    const items = page.data.filter((m) => m.type === "memory");
    if (items.length === 0) return null;

    const contents = await Promise.all(
      items.map(async (m) => {
        const mem = await anthropic.beta.memoryStores.memories.retrieve(
          (m as { id: string }).id,
          { memory_store_id: storeId }
        );
        return (mem as { content?: string }).content ?? null;
      })
    );
    return contents.filter(Boolean).join("\n\n---\n\n") || null;
  } catch (err) {
    console.error("readSystemMemory error:", err);
    return null;
  }
}

async function updateSystemMemory(storeId: string, newContent: string): Promise<void> {
  const anthropic = getAnthropic();
  const page = await anthropic.beta.memoryStores.memories.list(storeId);
  const learningsFile = page.data.find(
    (m) => m.type === "memory" && (m as { path?: string }).path === "/learnings.md"
  );
  if (learningsFile) {
    await anthropic.beta.memoryStores.memories.update((learningsFile as { id: string }).id, {
      memory_store_id: storeId,
      content: newContent,
    });
  } else {
    await anthropic.beta.memoryStores.memories.create(storeId, {
      path: "/learnings.md",
      content: newContent,
    });
  }
}

// ─── Fetch recent conversations from Supabase ────────────────────────────────

async function fetchRecentConversations(): Promise<string> {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Pull the most recent conversations AND, separately, every conversation that
  // actually booked in the window. On busy days the recent-40 list is all fresh
  // non-converted chats, which pushed the booked ones (our best signal — "what
  // worked on the good day") out of the analysis entirely. Always include them.
  const [{ data: recentConvs }, { data: bookedConvs }] = await Promise.all([
    db
      .from("instagram_conversations")
      .select("id, username, booking_confirmed")
      .gte("updated_at", sevenDaysAgo)
      .order("updated_at", { ascending: false })
      .limit(40),
    db
      .from("instagram_conversations")
      .select("id, username, booking_confirmed")
      .eq("booking_confirmed", true)
      .gte("updated_at", sevenDaysAgo)
      .order("updated_at", { ascending: false })
      .limit(40),
  ]);

  const byId = new Map<string, { id: string; username: string | null; booking_confirmed: boolean }>();
  for (const c of [...(bookedConvs ?? []), ...(recentConvs ?? [])]) byId.set(c.id, c);
  const convs = [...byId.values()];

  if (convs.length === 0) return "No conversations found in the last 7 days.";

  // Fetch every conversation's messages in parallel — sequential awaits across
  // dozens of conversations was the main risk of the nightly cron timing out.
  const built = await Promise.all(
    convs.map(async (conv) => {
      const { data: msgs } = await db
        .from("instagram_messages")
        .select("role, content, created_at")
        .eq("conversation_id", conv.id)
        .order("created_at", { ascending: true })
        .limit(12);

      if (!msgs || msgs.length < 3) return null;

      const converted =
        conv.booking_confirmed ||
        msgs.some(
          (m) =>
            m.role === "assistant" &&
            (m.content?.includes("Appointment confirmed") ||
              m.content?.includes("Cita confirmada") ||
              /\[BOOK:/i.test(m.content ?? ""))
        );

      const lines = msgs.map((m) => {
        const role = m.role === "user" ? "Client" : "Agent";
        const content = (m.content ?? "").replace(/\[BOOK:\{[\s\S]*?\}\]/g, "[BOOKING CREATED]").slice(0, 300);
        return `${role}: ${content}`;
      });

      const label = converted
        ? `--- Conversation [CONVERTED ✓] (${conv.username || conv.id}) ---`
        : `--- Conversation (${conv.username || conv.id}) ---`;

      return `${label}\n${lines.join("\n")}`;
    })
  );

  const transcripts = built.filter((t): t is string => t !== null);

  return transcripts.length > 0
    ? transcripts.join("\n\n")
    : "No meaningful conversations found.";
}

// ─── Fetch owner corrections ([Treino] messages) from the last 30 days ───────

async function fetchOwnerCorrections(): Promise<string> {
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!
  );

  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data: msgs } = await db
    .from("instagram_messages")
    .select("content, created_at, conversation_id")
    .like("content", "[Treino]%")
    .gte("created_at", thirtyDaysAgo)
    .order("created_at", { ascending: true })
    .limit(50);

  if (!msgs || msgs.length === 0) return "";

  const lines = msgs.map((m) =>
    m.content.replace(/^\[Treino\]\s*/, "").trim()
  );

  return lines.join("\n");
}

// ─── Main Dreaming function ──────────────────────────────────────────────────

export interface DreamResult {
  summary: string;
  learnings: string;
  conversationsAnalyzed: number;
  timestamp: string;
}

export async function runDreaming(): Promise<DreamResult> {
  const anthropic = getAnthropic();

  // 1. Get system store
  const storeId = await getOrCreateSystemStore();
  const currentLearnings = await readSystemMemory(storeId);

  // 2. Fetch conversations and owner corrections
  const transcripts = await fetchRecentConversations();
  const ownerCorrections = await fetchOwnerCorrections();
  const convCount = (transcripts.match(/--- Conversation/g) || []).length;

  if (convCount === 0) {
    return {
      summary: "No conversations to analyze.",
      learnings: currentLearnings ?? "",
      conversationsAnalyzed: 0,
      timestamp: new Date().toISOString(),
    };
  }

  const correctionsSection = ownerCorrections
    ? `\n\n---\n\nOWNER MANUAL CORRECTIONS (highest priority — these are cases where the owner fixed the agent's response. The new learnings MUST reflect these corrections):\n${ownerCorrections}`
    : "";

  // 3. Claude analyzes patterns
  const convertedCount = (transcripts.match(/\[CONVERTED ✓\]/g) || []).length;

  const analysisResponse = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: `You are analyzing sales conversations for OzziFloors, a premium flooring company in Miami, FL.
The agent classifies leads as SMALL (<500 sqft, close by DM) or LARGE (>500 sqft, schedule free in-person visit).
Pricing: Luxury Vinyl $5/sqft (floor+labor). Tile labor only: $4.50/sqft. Visit = free quote, agent brings samples, measures, negotiates.

Conversations marked [CONVERTED ✓] ended with a scheduled appointment — these are your most valuable signal.
Your job: find patterns that CAUSED conversions and generate specific, actionable improvements for the agent.
IMPORTANT: Owner manual corrections are the highest priority signal. They show exactly where the agent failed and what the correct response is. Always incorporate them into the improvements.

HARD CONSTRAINTS — your learnings must NEVER contradict these owner rules, even when a converted conversation broke one and got away with it:
1. For projects of 500 sqft or more, the agent must NEVER give any dollar total, "starting price", ballpark, or estimate by DM — the ONLY allowed move is the free in-person visit. NEVER recommend giving an opening number for large projects, no matter how many conversions did it.
2. NEVER recommend revealing internal pricing mechanics (the small-job add-on, pricing tiers, or per-sqft breakdowns on small jobs).
3. If a conversation converted WHILE violating a rule above, do NOT extract that behavior as a pattern. Credit the compliant elements that helped instead (the two-slot offer, the free-visit reframe, language mirroring).
A past learning that violated constraint 1 spread a pricing-rule violation to every conversation — treat such learnings as forbidden output.`,
    messages: [
      {
        role: "user",
        content: `Here are the recent conversations from the last 7 days (${convertedCount} converted out of ${convCount} total):\n\n${transcripts}${correctionsSection}\n\n---\n\nAnalyze these conversations and produce an updated learnings file in this EXACT markdown format:

# OzziFloors Agent — System Learnings
Updated: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}
Conversations analyzed: ${convCount} (${convertedCount} converted)

## What closed bookings (from CONVERTED conversations only)
(List 3-5 specific phrases or moments in [CONVERTED ✓] conversations that directly led to the booking)

## Common client questions
(List the 3-5 most frequently asked questions with ideal short answers)

## Common objections and how to handle them
(List top 3 objections and the best response for each — prioritize objections from converted conversations)

## Where conversations stall
(List 2-3 patterns where leads go cold, based on non-converted conversations)

## Agent improvements for next week
(List 2-4 SPECIFIC improvements — e.g. "When client says X, respond with Y instead of Z". Focus on gaps between converted and non-converted conversations.)

Be specific and concise. Base everything strictly on the conversations above. Prioritize [CONVERTED ✓] conversations.`,
      },
    ],
  });

  const block = analysisResponse.content[0];
  let newLearnings = block.type === "text" ? block.text : "";

  // The model is unreliable at writing the current date (it tends to emit a
  // past year). Stamp the real server date programmatically so freshness is
  // always verifiable.
  if (newLearnings) {
    const stamp = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    if (/^Updated:.*$/m.test(newLearnings)) {
      newLearnings = newLearnings.replace(/^Updated:.*$/m, `Updated: ${stamp}`);
    } else {
      newLearnings = newLearnings.replace(/^(#[^\n]*\n)/, `$1Updated: ${stamp}\n`);
    }
  }

  // 4. Save to system memory store
  if (newLearnings) {
    await updateSystemMemory(storeId, newLearnings);
  }

  // 5. Generate a short summary for the dashboard
  const summaryResponse = await anthropic.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 300,
    messages: [
      {
        role: "user",
        content: `Based on this analysis, write a 3-sentence executive summary for the OzziFloors owner. What were the main findings?\n\n${newLearnings}`,
      },
    ],
  });

  const summaryBlock = summaryResponse.content[0];
  const summary = summaryBlock.type === "text" ? summaryBlock.text : "Analysis complete.";

  return {
    summary,
    learnings: newLearnings,
    conversationsAnalyzed: convCount,
    timestamp: new Date().toISOString(),
  };
}
