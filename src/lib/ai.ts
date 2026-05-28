import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";

// ─── Anthropic client (Claude) ─────────────────────────────────────────────
let _anthropic: Anthropic | null = null;
function getAnthropic(): Anthropic {
  if (!_anthropic) {
    _anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY! });
  }
  return _anthropic;
}

// ─── OpenAI client (Whisper + TTS only) ───────────────────────────────────
let _openai: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!_openai) {
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
  }
  return _openai;
}

export type ChatMessage = { role: "user" | "assistant"; content: string };

// ─── Hard-coded intercepts — bypass AI for specific question patterns ─────────
// These override the AI completely because the model cannot be reliably
// instructed to omit pricing from "what's included" type questions.

const HARDCODED_RESPONSES: Array<{ patterns: RegExp[]; response: string }> = [
  {
    patterns: [
      /what\s+is\s+included/i,
      /what('s|\s+is)\s+in(cluded)?\s*(in)?\s*the\s+(materials?\s+)?package/i,
      /what\s+does\s+the\s+package\s+(include|cover|come\s+with)/i,
      /what\s+comes?\s+with\s+(it|the\s+package)/i,
      /is\s+(labor|installation)\s+included/i,
      /does\s+(it|the\s+package)\s+include\s+(labor|installation)/i,
      /what\s+does?\s+(it|that)\s+include/i,
    ],
    response: "Hi! The package already includes the flooring and installation labor. I provide a free quote. Are you planning to do just one area or the entire house?",
  },
];

function checkHardcodedResponse(messages: ChatMessage[]): string | null {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "user") return null;
  const text = last.content;
  for (const rule of HARDCODED_RESPONSES) {
    if (rule.patterns.some((p) => p.test(text))) {
      return rule.response;
    }
  }
  return null;
}

function removeDashes(text: string): string {
  const emDash = String.fromCharCode(0x2014);
  const enDash = String.fromCharCode(0x2013);
  const figDash = String.fromCharCode(0x2012);
  const horizBar = String.fromCharCode(0x2015);
  return text
    .split(emDash).join(",")
    .split(enDash).join(",")
    .split(figDash).join(",")
    .split(horizBar).join(",")
    .replace(/ - /g, ", ")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\./g, ".");
}

// ─── Main AI response via Claude claude-sonnet-4-6 ───────────────────────────────
export async function getAIResponse(
  messages: ChatMessage[],
  memoryContext?: string | null,
  systemMemory?: string | null,
  ownerCorrections?: string | null
): Promise<string> {
  // Check hard-coded intercepts first — bypasses AI entirely for known patterns
  const hardcoded = checkHardcodedResponse(messages);
  if (hardcoded) {
    console.log("[AI] Hard-coded intercept triggered:", hardcoded.slice(0, 60));
    return hardcoded;
  }

  const anthropic = getAnthropic();

  // Build system prompt — layer: base prompt + system learnings + client memory
  let systemContent = SYSTEM_PROMPT;

  if (systemMemory) {
    systemContent += `\n\n---\n\n## AGENT LEARNINGS (from Dreaming analysis)\nUse these patterns to improve responses. Don't mention them explicitly.\n${systemMemory}`;
  }

  if (memoryContext) {
    systemContent += `\n\n---\n\n## RETURNING CLIENT — MEMORY\n${memoryContext}\n\nUse this memory to avoid repeating questions the client already answered. Do NOT ask for info you already have.`;
  }

  if (ownerCorrections) {
    systemContent += `\n\n---\n\n## MANDATORY OWNER CORRECTIONS — THESE OVERRIDE EVERYTHING\nThe owner has already corrected these responses. When the client's question matches or is similar to a PERGUNTA below, you MUST use the exact RESPOSTA CORRETA. No exceptions.\n\n${ownerCorrections}`;
  }

  // FINAL CRITICAL OVERRIDES — these come last and cannot be overridden by anything above
  systemContent += `\n\n---\n\nFINAL RULES THAT OVERRIDE EVERYTHING ABOVE:\n1. ZERO DASHES ANYWHERE. This means no hyphen (-), no en dash (–), no em dash (—). The em dash is the most common violation. Sentences like "400 sqft [em dash] that comes out to" or "thinking [em dash] and I'll" are FAILURES. Replace every dash with a comma or split into two sentences. Scan your entire message before sending. One dash anywhere = automatic failure.\n2. NEVER say "let me have our specialist send you the catalog" or "I'll have someone send you photos." You send photos yourself right now.\n3. When a client asks for colors, options, or photos: ALWAYS use [SEND_IMAGES: color1, color2, color3] AND include both links in the same message:\nWebsite: https://www.ozzifloors.com/\nInstagram: https://www.instagram.com/ozzi.floors/\nNo exceptions. Missing [SEND_IMAGES] or missing the links is an automatic failure.\n4. When a client asks what is included in the package, what the package covers, or what comes with it: your reply MUST be EXACTLY this (word for word): "The package already includes the flooring and installation labor. I provide a free quote. Are you planning to do just one area or the entire house?" — ZERO variation allowed. Do NOT add "$5", "$5/sqft", "$5 per sqft", "no hidden fees", "no surprises", "Luxury Vinyl promo", or any other phrase. Any deviation from this exact reply = automatic failure.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    system: systemContent,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  });

  const block = response.content[0];
  if (block.type === "text") {
    const cleaned = removeDashes(block.text);
    const hadDash = block.text !== cleaned;
    console.log(`[AI v4] dash removed: ${hadDash} | preview: ${cleaned.slice(0, 60)}`);
    return cleaned;
  }
  return "Sorry, I couldn't generate a response.";
}

// ─── Image analysis via Claude claude-haiku-4-5 (vision) ──────────────────────────
export async function analyzeImageFromBase64(base64DataUrl: string): Promise<string> {
  try {
    const anthropic = getAnthropic();

    // Extract base64 content and media type
    const match = base64DataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
    if (!match) return "Image received but could not be processed.";
    const mediaType = match[1] as "image/jpeg" | "image/png" | "image/gif" | "image/webp";
    const base64Data = match[2];

    const response = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: mediaType, data: base64Data },
            },
            {
              type: "text",
              text: `This is a floor plan image sent by a flooring client for a quote.

READ ALL TEXT AND NUMBERS visible in the image carefully.

If it's a FLOOR PLAN:
1. List every room label and its dimensions exactly as written (e.g. "Sala 3.00x3.00m", "Cozinha 1.90x3.00m")
2. Calculate each room area (length × width = m²)
3. Sum all areas: Total sqm × 10.76 = sqft
4. State clearly: "Total: ~Xm² (~Ysqft)"
5. If total is under 500 sqft → state "SMALL PROJECT"
6. If total is over 500 sqft → state "LARGE PROJECT"

If measurements are not visible, describe the rooms you can see.
If it's a photo of existing floors: describe floor type and condition.

Be specific and always calculate when dimensions are visible. Under 120 words.`,
            },
          ],
        },
      ],
    });

    const block = response.content[0];
    return block.type === "text" ? block.text : "Image analyzed but no description generated.";
  } catch (err) {
    console.error("analyzeImageFromBase64 error:", err);
    return "Image received but could not be analyzed.";
  }
}

// ─── Download image and convert to base64 (for Instagram CDN URLs) ─────────
async function imageToBase64(imageUrl: string): Promise<string> {
  const token = process.env.INSTAGRAM_ACCESS_TOKEN ?? "";
  const urlWithToken = imageUrl.includes("?")
    ? `${imageUrl}&access_token=${token}`
    : `${imageUrl}?access_token=${token}`;

  const attempts: [string, RequestInit][] = [
    [urlWithToken, {}],
    [imageUrl, { headers: { Authorization: `Bearer ${token}` } }],
    [imageUrl, {}],
  ];

  for (const [url, options] of attempts) {
    try {
      const res = await fetch(url, { ...options, redirect: "follow" });
      if (!res.ok) continue;
      const contentType = res.headers.get("content-type") ?? "";

      if (contentType.includes("text/html")) {
        const html = await res.text();
        const ogImage =
          html.match(/property="og:image"\s+content="([^"]+)"/)?.[1] ??
          html.match(/content="([^"]+)"\s+property="og:image"/)?.[1];
        if (ogImage) return imageToBase64(ogImage);
        throw new Error("No og:image found");
      }

      if (!contentType.startsWith("image/")) continue;
      const buffer = await res.arrayBuffer();
      if (buffer.byteLength < 2000) continue;
      const base64 = Buffer.from(buffer).toString("base64");
      return `data:${contentType.split(";")[0]};base64,${base64}`;
    } catch {
      continue;
    }
  }
  throw new Error("Could not download image");
}

// ─── Analyze image from URL (fetches then analyzes) ────────────────────────
export async function analyzeImage(imageUrl: string): Promise<string> {
  try {
    const dataUrl = await imageToBase64(imageUrl);
    return analyzeImageFromBase64(dataUrl);
  } catch (err) {
    console.error("Image analysis error:", err);
    return "Image received but could not be analyzed. Please describe what you need.";
  }
}

// ─── Transcribe audio via OpenAI Whisper ────────────────────────────────────
export async function transcribeAudioFromBuffer(
  buffer: ArrayBuffer,
  contentType: string
): Promise<string> {
  if (!process.env.OPENAI_API_KEY) return "[Voice message received — please type your message]";
  try {
    const ext = contentType.includes("ogg")
      ? "ogg"
      : contentType.includes("mpeg") || contentType.includes("mp3")
      ? "mp3"
      : contentType.includes("wav")
      ? "wav"
      : "m4a";
    const audioFile = new File([buffer], `audio.${ext}`, { type: contentType });
    const openai = getOpenAI();
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
    });
    const text = transcription.text?.trim();
    console.log("Transcription:", text?.slice(0, 100));
    return text || "[Voice message — no speech detected]";
  } catch (err) {
    console.error("transcribeAudioFromBuffer error:", err);
    return "[Voice message received — please type your message]";
  }
}

export async function transcribeAudio(audioUrl: string): Promise<string> {
  if (!process.env.OPENAI_API_KEY) return "[Voice message received — please type your message]";
  try {
    const token = process.env.INSTAGRAM_ACCESS_TOKEN ?? "";
    const urlWithToken = audioUrl.includes("?")
      ? `${audioUrl}&access_token=${token}`
      : `${audioUrl}?access_token=${token}`;

    const fetchAttempts: [string, RequestInit][] = [
      [urlWithToken, {}],
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
      } catch {
        continue;
      }
    }

    if (!audioBuffer || audioBuffer.byteLength < 1000) {
      return "[Voice message received — please type your message]";
    }

    return transcribeAudioFromBuffer(audioBuffer, contentType);
  } catch (err) {
    console.error("Transcription error:", err);
    return "[Voice message received — please type your message]";
  }
}

// ─── TTS via OpenAI ──────────────────────────────────────────────────────────
export async function generateSpeech(text: string): Promise<Buffer | null> {
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const openai = getOpenAI();
    const response = await openai.audio.speech.create({
      model: "tts-1",
      voice: "nova",
      input: text,
      response_format: "mp3",
    });
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    console.error("TTS error:", err);
    return null;
  }
}
