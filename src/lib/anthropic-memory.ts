import Anthropic from "@anthropic-ai/sdk";

let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
  return _anthropic;
}

export interface ClientMemory {
  lead_type?: "small" | "large";
  client_name?: string;
  project_summary?: string;
  quote_given?: string;
  visit_scheduled?: boolean;
  status?: "new" | "classified" | "quoted" | "scheduled" | "closed";
}

// Create a new memory store for a client (called once on first DM)
export async function createClientMemoryStore(igsid: string, clientName?: string): Promise<string> {
  const anthropic = getAnthropic();
  const store = await anthropic.beta.memoryStores.create({
    name: `ozzif-${igsid}`,
    description: `OzziFloors client context for Instagram user ${clientName || igsid}`,
  });
  await anthropic.beta.memoryStores.memories.create(store.id, {
    path: "/client.md",
    content: buildMemoryContent({ status: "new" }),
  });
  return store.id;
}

// Read memory content to inject into conversation context
export async function readClientMemory(storeId: string): Promise<string | null> {
  try {
    const anthropic = getAnthropic();
    const page = await anthropic.beta.memoryStores.memories.list(storeId, {
      path_prefix: "/",
    });

    const memoryItems = page.data.filter((m) => m.type === "memory");
    if (memoryItems.length === 0) return null;

    const contents = await Promise.all(
      memoryItems.map(async (m) => {
        const mem = await anthropic.beta.memoryStores.memories.retrieve(
          (m as { id: string }).id,
          { memory_store_id: storeId }
        );
        return (mem as { content?: string }).content ?? null;
      })
    );

    return contents.filter(Boolean).join("\n\n") || null;
  } catch (err) {
    console.error("Memory read error:", err);
    return null;
  }
}

// Update client memory after a conversation turn
export async function updateClientMemory(
  storeId: string,
  update: ClientMemory
): Promise<void> {
  try {
    const anthropic = getAnthropic();
    const page = await anthropic.beta.memoryStores.memories.list(storeId);
    const clientFile = page.data.find(
      (m) => m.type === "memory" && (m as { path?: string }).path === "/client.md"
    );

    const newContent = buildMemoryContent(update);

    if (clientFile) {
      await anthropic.beta.memoryStores.memories.update(
        (clientFile as { id: string }).id,
        { memory_store_id: storeId, content: newContent }
      );
    } else {
      await anthropic.beta.memoryStores.memories.create(storeId, {
        path: "/client.md",
        content: newContent,
      });
    }
  } catch (err) {
    console.error("Memory update error:", err);
  }
}

function buildMemoryContent(data: ClientMemory): string {
  const lines: string[] = ["# OzziFloors — Client Memory"];
  if (data.client_name) lines.push(`Name: ${data.client_name}`);
  if (data.lead_type) {
    lines.push(
      data.lead_type === "small"
        ? "Lead type: SMALL — under 500 sqft, close quote by DM"
        : "Lead type: LARGE — over 500 sqft, must schedule free in-person visit"
    );
  }
  if (data.project_summary) lines.push(`Project: ${data.project_summary}`);
  if (data.quote_given) lines.push(`Quote given: ${data.quote_given}`);
  if (data.visit_scheduled) lines.push("Visit: already scheduled");
  if (data.status) lines.push(`Status: ${data.status}`);
  lines.push(`Updated: ${new Date().toISOString()}`);
  return lines.join("\n");
}

// Parse AI response + conversation to detect memory updates (no extra AI call)
export function extractMemoryUpdate(
  aiResponse: string,
  allMessages: { role: string; content: string }[],
  existingMemory: ClientMemory
): ClientMemory | null {
  const combined = allMessages.map((m) => m.content).join(" ").toLowerCase();
  const response = aiResponse.toLowerCase();
  const update: ClientMemory = { ...existingMemory };
  let changed = false;

  // Detect lead classification
  if (!update.lead_type) {
    const isLarge =
      /whole house|entire house|all rooms|all the rooms|full apartment|multiple rooms|2\s*bedroom|3\s*bedroom|4\s*bedroom|casa toda|apartamento todo/.test(combined);
    const isSmall =
      /single room|one room|just one|bedroom only|bathroom only|kitchen only|one area/.test(combined) ||
      /small lead|under 500|less than 500/.test(response);

    if (isLarge) { update.lead_type = "large"; changed = true; }
    else if (isSmall) { update.lead_type = "small"; changed = true; }
  }

  // Detect quote given (e.g. "$5 × 300 sqft = $1,500" or "your total would be $1500")
  const quoteMatch = aiResponse.match(/\$[\d,]+(?:\.\d{2})?(?:\s*total)?/i);
  if (quoteMatch && !update.quote_given) {
    update.quote_given = quoteMatch[0];
    update.status = "quoted";
    changed = true;
  }

  // Detect booking confirmation — check both the raw [BOOK: tag and the
  // post-processed confirmation text (tag is stripped before this function runs)
  if (
    (/\[BOOK:/i.test(aiResponse) || /appointment confirmed/i.test(aiResponse) || /cita confirmada/i.test(aiResponse)) &&
    !update.visit_scheduled
  ) {
    update.visit_scheduled = true;
    update.status = "scheduled";
    changed = true;
  }

  // Detect status progression
  if (!update.status || update.status === "new") {
    if (update.lead_type) { update.status = "classified"; changed = true; }
  }

  return changed ? update : null;
}
