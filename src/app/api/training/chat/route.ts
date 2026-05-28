import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase";
import { getAIResponse, analyzeImageFromBase64 } from "@/lib/ai";
import { getOrCreateSystemStore, readSystemMemory } from "@/lib/dreaming";

const SANDBOX_IGSID = "training_sandbox";

// Ensure the sandbox conversation exists and return its id
async function getOrCreateSandboxConversation(): Promise<string> {
  const { data: existing } = await supabaseAdmin
    .from("instagram_conversations")
    .select("id")
    .eq("igsid", SANDBOX_IGSID)
    .single();

  if (existing) return existing.id;

  const { data: created, error } = await supabaseAdmin
    .from("instagram_conversations")
    .insert({
      igsid: SANDBOX_IGSID,
      name: "Training Sandbox",
      username: "training_sandbox",
      mode: "human",
    })
    .select("id")
    .single();

  if (error || !created) {
    throw new Error(`Failed to create sandbox conversation: ${error?.message}`);
  }

  return created.id;
}

// POST — send a training message and get an AI response
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    const rawMessages: Array<{ role: "user" | "assistant"; content: string }> =
      body.messages ?? [];
    const imageBase64: string | undefined = body.imageBase64;

    if (rawMessages.length === 0) {
      return NextResponse.json({ error: "messages is required" }, { status: 400 });
    }

    // Get or create sandbox conversation
    const sandboxId = await getOrCreateSandboxConversation();

    // The last message is the one just sent by the owner playing client
    const lastMessage = rawMessages[rawMessages.length - 1];
    let enrichedUserContent = lastMessage.content;

    // If an image was attached, analyze it and enrich the message content
    if (imageBase64) {
      const imageAnalysis = await analyzeImageFromBase64(imageBase64);
      enrichedUserContent = lastMessage.content
        ? `${lastMessage.content}\n\n[Image analysis: ${imageAnalysis}]`
        : `[Image: ${imageAnalysis}]`;
    }

    // Build the message array for the AI, substituting the enriched content
    const messagesForAI = rawMessages.map((m, i) =>
      i === rawMessages.length - 1
        ? { role: m.role, content: enrichedUserContent }
        : { role: m.role, content: m.content }
    );

    // Persist the user message to the sandbox conversation
    const { data: userMsg, error: userMsgError } = await supabaseAdmin
      .from("instagram_messages")
      .insert({
        conversation_id: sandboxId,
        role: "user",
        content: enrichedUserContent,
      })
      .select("id")
      .single();

    if (userMsgError || !userMsg) {
      throw new Error(`Failed to save user message: ${userMsgError?.message}`);
    }

    // Load system memory (agent learnings) for the AI
    let systemMemory: string | null = null;
    try {
      const storeId = await getOrCreateSystemStore();
      systemMemory = await readSystemMemory(storeId);
    } catch {
      // Non-fatal: proceed without system memory
    }

    // Call the AI
    const rawAiResponse = await getAIResponse(messagesForAI, null, systemMemory);

    // Strip any dash characters before sending to client (belt-and-suspenders)
    const emDash = String.fromCharCode(0x2014);
    const enDash = String.fromCharCode(0x2013);
    const aiResponse = rawAiResponse
      .split(emDash).join(",")
      .split(enDash).join(",")
      .replace(/ - /g, ", ")
      .replace(/,\s*,/g, ",")
      .replace(/,\s*\./g, ".");

    // Persist the AI response
    const { data: aiMsg, error: aiMsgError } = await supabaseAdmin
      .from("instagram_messages")
      .insert({
        conversation_id: sandboxId,
        role: "assistant",
        content: aiResponse,
      })
      .select("id")
      .single();

    if (aiMsgError || !aiMsg) {
      throw new Error(`Failed to save AI message: ${aiMsgError?.message}`);
    }

    // Touch the conversation timestamp
    await supabaseAdmin
      .from("instagram_conversations")
      .update({ updated_at: new Date().toISOString() })
      .eq("id", sandboxId);

    return NextResponse.json({
      response: aiResponse,
      sandboxId,
      aiMsgId: aiMsg.id,
      enrichedUserMsg: enrichedUserContent,
    });
  } catch (err) {
    console.error("[training/chat POST]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}

// PATCH — save a correction for an AI message
export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { sandboxId, aiMsgId, correction } = body as {
      sandboxId?: string;
      aiMsgId?: string;
      correction?: string;
    };

    if (!sandboxId || !aiMsgId || !correction) {
      return NextResponse.json(
        { error: "sandboxId, aiMsgId and correction are required" },
        { status: 400 }
      );
    }

    // Persist the correction as a new assistant message tagged with [Training]
    const { error } = await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: sandboxId,
      role: "assistant",
      content: `[Treino] ${correction}`,
    });

    if (error) {
      throw new Error(`Failed to save correction: ${error.message}`);
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[training/chat PATCH]", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Internal server error" },
      { status: 500 }
    );
  }
}
