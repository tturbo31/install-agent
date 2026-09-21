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
    // 2000 cut the 2026-09-21 file in the middle of a sentence (the last
    // "improvement" ended at "the best next step is to call"), and that half
    // sentence was injected into every conversation for a day.
    max_tokens: 3000,
    system: `You are analyzing sales conversations for OzziFloors, a premium flooring company in Miami, FL.
The agent classifies leads by size: UNDER 400 sqft = never priced or booked in the chat, the client is pointed to Ozzi's direct line (561) 674-8334; 400 to 499 sqft = quoted by DM; 500 sqft or more = LARGE, schedule the free in-person visit. Bathroom remodels and any bathroom work (shower, tub, vanity) are ALSO never priced or booked in the chat: Ozzi direct at the same number.
Pricing: Luxury Vinyl $5/sqft (floor+labor). Tile labor only: $4.50/sqft. Visit = free quote, agent brings samples, measures, negotiates.

Conversations marked [CONVERTED ✓] ended with a scheduled appointment — these are your most valuable signal.
Your job: find patterns that CAUSED conversions and generate specific, actionable improvements for the agent.
IMPORTANT: Owner manual corrections are the highest priority signal. They show exactly where the agent failed and what the correct response is. Always incorporate them into the improvements.

HARD CONSTRAINTS — your learnings must NEVER contradict these owner rules, even when a converted conversation broke one and got away with it:
1. For projects of 500 sqft or more, the agent must NEVER give any dollar total, "starting price", ballpark, or estimate by DM — the ONLY allowed move is the free in-person visit. NEVER recommend giving an opening number for large projects, no matter how many conversions did it.
2. NEVER recommend revealing internal pricing mechanics (pricing tiers, per-sqft breakdowns, or the reason small jobs go to Ozzi).
5. For projects UNDER 400 sqft (owner rule 2026-09-11) the agent must NEVER give any price, rate, range or estimate and NEVER propose a visit or collect booking details: the only compliant move is pointing the client to Ozzi directly at (561) 674-8334, and holding that line if the client insists. NEVER recommend quoting or scheduling a job under 400 sqft, no matter how many conversions did it.
6. Bathroom remodels / renovations and any bathroom work (owner rule 2026-09-11) are NEVER quoted and NEVER scheduled in the chat: the only compliant move is pointing the client to Ozzi directly at (561) 674-8334. NEVER recommend proposing a visit or collecting booking details for a bathroom project, even if a converted conversation did.
3. When a client mentions a competitor's lower price or asks to lower/match/beat a price, the ONLY compliant pattern is: notify the owner ([NOTIFY_OWNER]) and tell the client the team will check the space in person and see about a better number. NEVER advise committing to beat or match a number ("I can beat that quote" is forbidden — the agent once promised to beat a $3.99/sqft rate the business cannot do).
4. If a conversation converted WHILE violating a rule above, do NOT extract that behavior as a pattern. Credit the compliant elements that helped instead (the two-slot offer, the free-visit reframe, language mirroring).
7. ZIP CODE IS NEVER ASKED BEFORE THE VISIT TIMES (owner rule 2026-09-16, the route optimization was removed): the agent offers the two visit times straight from the schedule and collects the zip code ONLY inside the full property address, together with the name and phone, AFTER the client picks a time. Conversations before 2026-09-16 show the agent asking "What's the zip code of the property?" before offering times — that flow no longer exists. NEVER recommend asking the zip code (or the city) first, NEVER extract "ask the zip, then offer two slots" as a pattern, and NEVER write a suggested reply that ends with a zip-code question; the location question ("where are you located?") is answered with the service area (Homestead to Jupiter) and moves on to the flooring type or the visit, never to a zip-code qualifier.
8. THE CLIENT'S NAME IS NEVER ASKED (owner rule 2026-09-16): a visit books with the full property address (with the zip code) and the phone number only; the name is NOT a requirement and the agent never asks for it, not together with the address and phone and not on its own ("what name should I put the visit under?" no longer exists). Conversations before 2026-09-16 show the agent asking "Can I get your name, the property address, and the best phone number?" — that ask is now "Can I get the property address with the zip code and the best phone number?". NEVER recommend collecting the name, NEVER write "name + address + phone" as the details to collect, and NEVER write a suggested reply that asks for the client's name.
9. "NO SPEAK ENGLISH" MEANS THE CLIENT DOES NOT SPEAK ENGLISH (2026-09-17): a client who writes "No, speak English", "No speak English", "no English" or any broken-English form of "I don't speak English" after an English message from the agent is asking for SPANISH (Portuguese only if they wrote Portuguese). The compliant reply switches to Spanish at once and continues the conversation in Spanish. NEVER extract "Already in English!" or any reply that keeps writing in English, corrects the client's English or treats that message as a request for English (a real conversation did exactly that on 2026-09-17 and lost the lead); NEVER write a suggested reply that answers such a message in English.
10. A REQUEST FOR OUR WHATSAPP OR PHONE NUMBER IS ANSWERED WITH THE NUMBER, IN THE CLIENT'S LANGUAGE (2026-09-17): "Me envia seu WhatsApp", "pásame tu WhatsApp", "send me your WhatsApp", "what's your number?" get (561) 674-8334 (our phone and our WhatsApp) in that same reply, in the language the client wrote, and then the next question. NEVER recommend answering such a request with the flooring-type question alone or with a canned English opener (a real Portuguese-speaking lead got the English "which one are you interested in?" on 2026-09-17 and the owner had to send the number by hand).
11. REPLIES ARE SHORT TEXTS (owner rule 2026-09-21: "respostas mais curtas, sem textão"): every reply is one or two short sentences, under 160 characters, 220 at the very most. NEVER recommend "stacking" selling points (free visit + samples + best price on the spot) in one message, NEVER present a long reply as a winning pattern, and NEVER recommend repeating a selling point that was already said in the conversation. Every converted conversation before 2026-09-21 contains the long visit pitch because the old script forced it into EVERY conversation, converted or not: that is not a cause of conversion, do not extract it. Every reply you suggest in this file (ideal answers, best responses, examples) must itself be one or two short sentences under 160 characters, with no dashes, and must give no price while the flooring type is still unknown.
12. NEVER RECOMMEND SILENCE FOR A CLIENT ACTION (owner rule 2026-07-27, re-learned the hard way on 2026-09-21): a tap on our ad ("[Client replied to our ad]"), a re-tapped FAQ button or any other client message ALWAYS gets a reply. The learnings file of 2026-09-21 said that answering ad taps "escalates to spam" and that "further messages produce no value", and with that sentence in context the agent answered [REACT_ONLY] to 12 out of 12 ad re-taps from clients who had already talked to us. When a conversation stalls on repeated taps, the finding is about the REPEATED WORDING, never about answering: recommend a differently worded short reply or a different move (for example offering the free visit with the two soonest real times), NEVER recommend stopping, staying silent, ignoring taps, or capping the replies. The only silences that exist are the ones the owner defined: a pure closing ("ok thanks"), a job seeker, a hostile rejection.
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

Be specific and concise: the whole file must stay under 7,000 characters, every item two or three sentences, every suggested reply one or two short sentences. Base everything strictly on the conversations above. Prioritize [CONVERTED ✓] conversations.`,
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
