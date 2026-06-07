import { supabaseAdmin } from "@/lib/supabase";

// Owner corrections are stored as `[Treino] ...` rows in instagram_messages.
// Two kinds share that prefix:
//   1. Free-text owner echoes — the owner replied manually in a DM. These mark
//      the conversation as "owner handled" (NOTIFY_OWNER), per-conversation.
//   2. Structured Q→A corrections — saved deliberately from the dashboard
//      "Corrigir e enviar" button or the simulator. These are GLOBAL training
//      rules the AI must apply instantly across every conversation.
//
// The marker below is what distinguishes a structured correction from a plain
// owner echo.

const TREINO_PREFIX = "[Treino]";
const STRUCTURED_MARKER = "RESPOSTA CORRETA:";

// A structured correction is a deliberate Q→A rule, not a manual owner reply.
export function isStructuredCorrection(content: string): boolean {
  return content.startsWith(TREINO_PREFIX) && content.includes(STRUCTURED_MARKER);
}

// Format a correction the exact way getAIResponse and the LIKE filters expect.
export function buildCorrectionContent(originalQuestion: string, correction: string): string {
  const q = originalQuestion.trim();
  return q
    ? `${TREINO_PREFIX} PERGUNTA: "${q}" → RESPOSTA CORRETA: "${correction.trim()}"`
    : `${TREINO_PREFIX} ${correction.trim()}`;
}

// Load every structured owner correction from the last 30 days, across ALL
// conversations, so a fix made once is applied instantly everywhere. Returned
// as a newline-joined block ready to inject as `ownerCorrections`.
export async function loadGlobalCorrections(): Promise<string | null> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const { data } = await supabaseAdmin
    .from("instagram_messages")
    .select("content")
    .like("content", "[Treino]%RESPOSTA CORRETA:%")
    .gte("created_at", thirtyDaysAgo)
    .order("created_at", { ascending: true })
    .limit(50);

  if (!data || data.length === 0) return null;

  const lines = data
    .map((m) => (m.content as string).replace(/^\[Treino\]\s*/, "").trim())
    .filter(Boolean);

  return lines.length > 0 ? lines.join("\n") : null;
}
