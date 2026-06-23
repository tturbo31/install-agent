import { supabaseAdmin } from "@/lib/supabase";

// Track token usage and conversion for a conversation, per platform. Shared by
// all three channel webhooks (Instagram, Messenger, WhatsApp) so the dashboard
// counts every channel the same way — previously only Instagram was tracked, so
// Messenger and WhatsApp tokens/conversions were missing from the metrics.
//
// Fire-and-forget on purpose: a metrics failure must NEVER break the reply flow,
// so the RPC error is swallowed and only logged. Always call it with `void`.
export async function trackConversationMetrics(
  conversationId: string,
  platform: string,
  inputTokens: number,
  outputTokens: number,
  converted: boolean
): Promise<void> {
  try {
    await supabaseAdmin.rpc("increment_conversation_metrics", {
      p_conversation_id: conversationId,
      p_platform: platform,
      p_input_tokens: inputTokens,
      p_output_tokens: outputTokens,
      p_converted: converted,
    });
  } catch (err) {
    console.error("Metrics tracking error:", err);
  }
}
