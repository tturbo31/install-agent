import { NextRequest, NextResponse } from "next/server";
import { getOrCreateSystemStore } from "@/lib/dreaming";
import Anthropic from "@anthropic-ai/sdk";

let _anthropic: Anthropic | null = null;
function getAnthropic() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  return _anthropic;
}

// POST /api/train — save a training example (client question + owner response)
export async function POST(req: NextRequest) {
  const secret = req.nextUrl.searchParams.get("secret");
  if (secret !== process.env.INSTAGRAM_VERIFY_TOKEN) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { clientMessage, ownerResponse, context } = await req.json();
  if (!clientMessage || !ownerResponse) {
    return NextResponse.json({ error: "clientMessage and ownerResponse required" }, { status: 400 });
  }

  try {
    const anthropic = getAnthropic();
    const storeId = await getOrCreateSystemStore();

    // Read current training examples file (or create new one)
    const page = await anthropic.beta.memoryStores.memories.list(storeId);
    const trainingFile = page.data.find(
      (m) => m.type === "memory" && (m as { path?: string }).path === "/training-examples.md"
    );

    const timestamp = new Date().toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit"
    });

    const newEntry = `\n---\n## Example — ${timestamp}${context ? ` (${context})` : ""}\n**Client:** ${clientMessage}\n**Best response:** ${ownerResponse}\n`;

    if (trainingFile) {
      const existing = await anthropic.beta.memoryStores.memories.retrieve(
        (trainingFile as { id: string }).id,
        { memory_store_id: storeId }
      );
      const currentContent = (existing as { content?: string }).content ?? "";
      await anthropic.beta.memoryStores.memories.update(
        (trainingFile as { id: string }).id,
        { memory_store_id: storeId, content: currentContent + newEntry }
      );
    } else {
      await anthropic.beta.memoryStores.memories.create(storeId, {
        path: "/training-examples.md",
        content: `# OzziFloors — Training Examples\nReal conversations showing how the owner handles clients.\nThe agent should use these as reference for tone, approach, and closing techniques.\n${newEntry}`,
      });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("Train error:", err);
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
