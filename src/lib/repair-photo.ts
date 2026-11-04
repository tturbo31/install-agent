import { supabaseAdmin } from "@/lib/supabase";
import { repairAwaitingMedia } from "@/lib/ai";
import { notifyTeamRepairPhoto } from "@/lib/whatsapp";

// REPAIR (owner rule 2026-11-04, Sandy Bell IG): the client who asked for a
// repair was asked for a video or a picture of the project, and this photo
// just landed. The three webhooks call this right after storing the row and
// BEFORE the debounce, so the team (Ozzi, Vinicius, Ruani) gets the picture
// itself the moment it arrives; the burst's last handler then sends the client
// the handoff line ("Ozzi is going to check it and will get back to you") and
// the text alert with the conversation. "Awaited" = our ask went out and no
// handoff did (the photo bubble itself changes neither). A photo sent together
// with the very first repair message is not forwarded (nothing was asked yet);
// the alert text carries its analysis.
export async function forwardRepairPhotoIfAwaited(params: {
  conversationId: string;
  platform: string;
  clientName: string | null;
  clientId: string;
  imageUrl: string;
  analysis?: string | null;
}): Promise<boolean> {
  const { conversationId, platform, clientName, clientId, imageUrl, analysis } = params;
  try {
    const { data } = await supabaseAdmin
      .from("instagram_messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(20);
    const recent = (data ?? []).reverse();
    if (!repairAwaitingMedia(recent)) return false;
    console.log(`[REPAIR] photo of the repair landed on ${platform} (${clientId}) — forwarding it to the team`);
    await notifyTeamRepairPhoto({ platform, clientName, clientId, imageUrl, analysis: analysis ?? null });
    return true;
  } catch (err) {
    console.error("[REPAIR] photo forward failed:", err);
    return false;
  }
}
