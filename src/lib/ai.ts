import OpenAI from "openai";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";

// OpenRouter client — for text + vision responses
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env.OPENROUTER_API_KEY!,
    });
  }
  return _openai;
}

// OpenAI direct client — for Whisper transcription + TTS audio
let _openaiDirect: OpenAI | null = null;
function getOpenAIDirect(): OpenAI {
  if (!_openaiDirect) {
    _openaiDirect = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY!,
    });
  }
  return _openaiDirect;
}

const FALLBACK_MODELS = [
  "google/gemma-3-12b-it:free",
  "google/gemma-3-4b-it:free",
  "google/gemma-2-9b-it:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
];

const VISION_MODELS = [
  "meta-llama/llama-3.2-11b-vision-instruct:free",
  "google/gemini-flash-1.5:free",
  "openai/gpt-4o-mini",
];

function getModels(): string[] {
  const primary = process.env.AI_MODEL;
  const models = primary ? [primary, ...FALLBACK_MODELS] : FALLBACK_MODELS;
  return [...new Set(models)];
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export async function getAIResponse(messages: ChatMessage[]): Promise<string> {
  const openai = getOpenAI();
  const models = getModels();

  const payload: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...messages,
  ];

  for (const model of models) {
    try {
      const completion = await openai.chat.completions.create({ model, messages: payload });
      return completion.choices[0]?.message?.content ?? "Sorry, I couldn't generate a response.";
    } catch (err: unknown) {
      const status = (err as { status?: number })?.status;
      if (status !== 429 && status !== 404) throw err;
      console.warn(`Model ${model} failed with ${status}, trying next...`);
    }
  }

  return "Sorry, I'm temporarily unavailable. Please try again shortly.";
}

// Download image and convert to base64 data URL
async function imageToBase64(imageUrl: string): Promise<string> {
  // Instagram CDN URLs require access_token as query param (not Bearer header)
  const token = process.env.INSTAGRAM_ACCESS_TOKEN ?? "";
  const urlWithToken = imageUrl.includes("?")
    ? `${imageUrl}&access_token=${token}`
    : `${imageUrl}?access_token=${token}`;

  const attempts: [string, RequestInit][] = [
    [urlWithToken, {}],                                                     // query param auth
    [imageUrl, { headers: { Authorization: `Bearer ${token}` } }],        // bearer header
    [imageUrl, {}],                                                         // no auth
  ];

  for (const [url, options] of attempts) {
    try {
      const res = await fetch(url, { ...options, redirect: "follow" });
      if (!res.ok) continue;
      const contentType = res.headers.get("content-type") ?? "";

      // If it's HTML (shared post URL), extract og:image
      if (contentType.includes("text/html")) {
        const html = await res.text();
        const ogImage = html.match(/property="og:image"\s+content="([^"]+)"/)?.[1] ??
          html.match(/content="([^"]+)"\s+property="og:image"/)?.[1];
        if (ogImage) return imageToBase64(ogImage);
        throw new Error("No og:image found in shared page");
      }

      if (!contentType.startsWith("image/")) continue;
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength < 2000) continue; // Skip tiny placeholder images
      const base64 = Buffer.from(buffer).toString("base64");
      return `data:${contentType};base64,${base64}`;
    } catch {
      continue;
    }
  }
  throw new Error("Could not download image");
}

// Analyze an image (floor photo or house plan) using GPT-4o-mini vision
export async function analyzeImage(imageUrl: string): Promise<string> {
  try {
    const openai = getOpenAIDirect();
    const dataUrl = await imageToBase64(imageUrl);

    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            {
              type: "text",
              text: `You are analyzing an image sent by a flooring client for a quote.

If it's a FLOOR PLAN / blueprint:
- List each room and its dimensions if visible (e.g. bedroom 4x3m)
- Calculate total sq meters and convert to sq ft (1 sqm = 10.76 sqft)
- State total: "Total: ~X sqm (~Y sqft)"

If it's a PHOTO of existing floors:
- Describe current floor type (tile, hardwood, carpet, etc.)
- Condition (good, damaged, old)
- Estimate room size if visible

Be concise. Under 80 words. Focus on what's useful for a flooring quote.`,
            },
          ] as unknown as string,
        },
      ],
      max_tokens: 250,
    });

    return response.choices[0]?.message?.content ?? "Image analyzed but no description generated.";
  } catch (err) {
    console.error("Image analysis error:", err);
    return "Image received but could not be analyzed. Please describe what you need.";
  }
}

// Transcribe an audio message using OpenAI Whisper
export async function transcribeAudio(audioUrl: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) {
    return "[Voice message received — please type your message]";
  }

  try {
    // Instagram CDN requires access_token as query param
    const token = process.env.INSTAGRAM_ACCESS_TOKEN ?? "";
    const audioUrlWithToken = audioUrl.includes("?")
      ? `${audioUrl}&access_token=${token}`
      : `${audioUrl}?access_token=${token}`;

    const fetchAttempts: [string, RequestInit][] = [
      [audioUrlWithToken, {}],
      [audioUrl, { headers: { Authorization: `Bearer ${token}` } }],
      [audioUrl, {}],
    ];

    let audioBuffer: ArrayBuffer | null = null;
    let contentType = "audio/mp4";

    for (const [url, opts] of fetchAttempts) {
      try {
        const res = await fetch(url, { ...opts, redirect: "follow" });
        if (!res.ok) continue;
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.startsWith("audio/") && !ct.startsWith("video/") && !ct.includes("octet-stream")) continue;
        audioBuffer = await res.arrayBuffer();
        contentType = ct.split(";")[0] || "audio/mp4";
        if (audioBuffer.byteLength > 1000) break;
      } catch { continue; }
    }

    if (!audioBuffer || audioBuffer.byteLength < 1000) {
      console.warn("Audio download failed or too small:", audioUrl);
      return "[Voice message received — please type your message]";
    }

    // Determine file extension from content type
    const ext = contentType.includes("ogg") ? "ogg"
      : contentType.includes("mpeg") || contentType.includes("mp3") ? "mp3"
      : contentType.includes("wav") ? "wav"
      : "m4a";

    const audioFile = new File([audioBuffer], `audio.${ext}`, { type: contentType });

    const openai = getOpenAIDirect();
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      // No language specified — Whisper auto-detects (handles Portuguese too)
    });

    const text = transcription.text?.trim();
    console.log("Transcription:", text?.slice(0, 100));
    return text || "[Voice message — no speech detected]";
  } catch (err) {
    console.error("Transcription error:", err);
    return "[Voice message received — please type your message]";
  }
}

// Generate TTS audio and return the audio buffer
export async function generateSpeech(text: string): Promise<Buffer | null> {
  try {
    if (!process.env.OPENAI_API_KEY) return null;

    const openai = getOpenAIDirect();
    const response = await openai.audio.speech.create({
      model: "tts-1",
      voice: "nova",
      input: text,
      response_format: "mp3",
    });

    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer;
  } catch (err) {
    console.error("TTS error:", err);
    return null;
  }
}
