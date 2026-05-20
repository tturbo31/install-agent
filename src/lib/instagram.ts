import { InstagramProfile } from "@/lib/types";
import { supabaseAdmin } from "@/lib/supabase";

export async function fetchInstagramProfile(igsid: string): Promise<InstagramProfile> {
  const url = new URL(`https://graph.instagram.com/v24.0/${igsid}`);
  url.searchParams.set(
    "fields",
    "name,username,profile_pic,follower_count,is_user_follow_business,is_business_follow_user"
  );
  url.searchParams.set("access_token", process.env.INSTAGRAM_ACCESS_TOKEN!);

  const res = await fetch(url.toString());
  const data = await res.json();

  return {
    name: data.name ?? null,
    username: data.username ?? null,
    profile_pic: data.profile_pic ?? null,
    follower_count: data.follower_count ?? null,
    is_user_follow_business: data.is_user_follow_business ?? null,
    is_business_follow_user: data.is_business_follow_user ?? null,
  };
}

export async function sendInstagramMessage(recipientIgsid: string, text: string) {
  const url = new URL("https://graph.instagram.com/v24.0/me/messages");
  url.searchParams.set("access_token", process.env.INSTAGRAM_ACCESS_TOKEN!);

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      recipient: { id: recipientIgsid },
      message: { text },
    }),
  });

  return res.json();
}

export async function sendInstagramAudio(recipientIgsid: string, audioBuffer: Buffer): Promise<boolean> {
  try {
    // Upload audio to Supabase storage
    const fileName = `tts-${Date.now()}.mp3`;
    const { error: uploadError } = await supabaseAdmin.storage
      .from("audio-responses")
      .upload(fileName, audioBuffer, {
        contentType: "audio/mpeg",
        upsert: false,
      });

    if (uploadError) {
      console.error("Audio upload error:", uploadError.message);
      return false;
    }

    // Get public URL
    const { data: urlData } = supabaseAdmin.storage
      .from("audio-responses")
      .getPublicUrl(fileName);

    const audioUrl = urlData.publicUrl;

    // Send via Instagram API
    const url = new URL("https://graph.instagram.com/v24.0/me/messages");
    url.searchParams.set("access_token", process.env.INSTAGRAM_ACCESS_TOKEN!);

    const res = await fetch(url.toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientIgsid },
        message: {
          attachment: {
            type: "audio",
            payload: {
              url: audioUrl,
              is_reusable: false,
            },
          },
        },
      }),
    });

    const result = await res.json();
    if (result.error) {
      console.error("Instagram audio send error:", result.error);
      return false;
    }

    return true;
  } catch (err) {
    console.error("sendInstagramAudio error:", err);
    return false;
  }
}
