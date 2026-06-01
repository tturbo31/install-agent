import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { SYSTEM_PROMPT, WHAT_IS_INCLUDED_RESPONSE } from "@/lib/system-prompt";

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
    response: WHAT_IS_INCLUDED_RESPONSE,
  },
  {
    // Portuguese: client asking to see photos / samples / catalog
    patterns: [
      /[nm]e\s+(envi[ae]|mand[ae]|mostr[ae])\s+.{0,25}(foto|imagem|amostra|cat[aá]logo|op[cç][aã]o)/i,
      /conseg[ue]{1,2}\s+.{0,10}(enviar?|mandar?|mostrar?)\s+.{0,20}(foto|imagem|amostra)/i,
      /enviar?\s+.{0,10}(fotos?|imagens?|amostra)/i,
      /tem\s+(alguma\s+)?(foto|imagem|amostra|cat[aá]logo)/i,
      /(foto|imagem|amostra)s?\s+(dos?\s+|de\s+)?(piso|ch[aã]o|vinyl|lvp|op[cç][aã]o)/i,
      /quer\s+ver\s+.{0,25}(foto|imagem|amostra|op[cç][aã]o)/i,
      /ver\s+.{0,15}(foto|imagem|amostra|op[cç][aã]o)s?/i,
      /qual\s+(é\s+o\s+)?visual\s+(dos?\s+)?(piso|ch[aã]o|vinyl)/i,
      /(foto|imagem|amostra|cat[aá]logo)\s+dos?\s+(pisos?|chão|ch[aã]o|op[cç])/i,
    ],
    response: "Você pode ver todas as nossas opções no site ozzifloors.com e no Instagram @ozzi.floors. Me conta mais sobre o seu espaço e o estilo que você prefere, assim te indico as melhores opções para o seu projeto!",
  },
  {
    // English: client asking to see photos / samples / catalog / material options
    patterns: [
      // Only intercept when client asks AGENT to send photos — NOT "send me a quote" or "I'll send you a photo"
      /send\s+me\s+(?!.{0,30}(?:quote|estimate|price|cost|approx|message|info))(photos?|images?|pics?|samples?|catalogs?)/i,
      /(?:can|could|would|please)\s+(?:you\s+)?send\s+(?!.{0,30}(?:quote|estimate|price|cost)).{0,60}(photos?|images?|pics?|samples?|catalogs?)/i,
      /would\s+like\s+(?:you\s+to\s+)?send\s+me\s+(?!.{0,20}(?:quote|estimate|price|cost|approx))(photos?|images?|samples?)/i,
      /like\s+to\s+(?:see|view|receive|get)\s+.{0,40}(photos?|images?|samples?)/i,
      /can\s+you\s+(?:send|show|share)\s+.{0,40}(photos?|images?|pics?|samples?|catalogs?)/i,
      /do\s+you\s+have\s+(?:any\s+)?(photos?|images?|pics?|samples?|catalogs?)/i,
      /show\s+me\s+(?:your\s+)?(floor|option|color|sample|catalog)/i,
      /photos?\s+of\s+(?:the\s+)?(floor|tile|vinyl|option|samples?)\s+(?:you\s+have\s+)?available/i,
      /samples?\s+(?:you\s+have\s+)?available/i,
      /what\s+do\s+(?:the\s+)?floors?\s+look\s+like/i,
      /colors?\s+(?:do\s+you\s+have|options?|available)/i,
      // Material / flooring options questions
      /material\s+options?/i,
      /(?:floor|flooring)\s+options?/i,
      /what\s+(?:are\s+(?:the|your)|options?\s+do\s+you\s+have).{0,30}(?:material|floor|option|color|style|product)/i,
      /what\s+(?:kind|type)s?\s+of\s+(?:floor|flooring|material|vinyl|product)/i,
      /what\s+options?\s+(?:do\s+you\s+have|are\s+(?:available|there))/i,
      /(?:available|offer(?:ed)?)\s+(?:floor|flooring|material|color|style)\s+options?/i,
    ],
    response: "You can browse all our floor options and see completed projects at ozzifloors.com and on our Instagram @ozzi.floors. What style are you going for so I can point you in the right direction?",
  },
  {
    // Client who already had an in-person visit wants to negotiate the quoted price
    patterns: [
      // Portuguese patterns
      /negoci[ao]/i,
      /quero\s+(discutir|falar|conversar)\s+(sobre\s+)?(os?\s+)?(valor|pre[cç]o|or[cç]amento)/i,
      /or[cç]amento\s+(que|da\s+visit|j[aá]\s+foi|feito|que\s+voc)/i,
      /valor(es)?\s+(do|da|que|j[aá])/i,
      /j[aá]\s+(fiz|fizemos|fizeram|foi\s+feito)\s+(o\s+)?or[cç]amento/i,
      /j[aá]\s+tiv(e|emos)\s+(a\s+)?visit/i,
      /depois\s+da\s+visit/i,
      /sobre\s+o\s+or[cç]amento/i,
      /o\s+pre[cç]o\s+(que|do)/i,
      // English patterns
      /negotiate\s+(the\s+)?(price|quote|cost|value|estimate)/i,
      /(discuss|talk\s+about|go\s+over)\s+(the\s+)?(price|quote|estimate|value|cost)/i,
      /the\s+(quote|estimate|price)\s+(from|you\s+gave|we\s+discussed|after)/i,
      /after\s+the\s+(visit|in.?person)/i,
      /from\s+the\s+(visit|in.?person|quote)/i,
      /you\s+(visited|came\s+to)\s+my/i,
      /already\s+(got|have|received)\s+a\s+(quote|estimate|price)/i,
      /want\s+to\s+negotiate/i,
    ],
    response: "I'll make sure our team reaches out to you directly to go over all the details from your visit. You'll hear from us very shortly![NOTIFY_OWNER]",
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

// Final safety net: strip [SEND_IMAGES] tags even if the AI generates them
// Called both inside getAIResponse AND at webhook level as a double guard
export function stripForbiddenTags(text: string): string {
  if (!/\[SEND_IMAGES/i.test(text)) return text;
  let cleaned = text.replace(/\[SEND_IMAGES[^\]]*\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
  if (!cleaned.includes("ozzifloors.com")) {
    cleaned += "\n\nYou can browse all our options at ozzifloors.com and on our Instagram @ozzi.floors.";
  }
  console.log("[AI] [SEND_IMAGES] tag stripped at safety layer");
  return cleaned;
}

function removeEmojis(text: string): string {
  // Strip emoji unicode ranges as a safety net
  const cleaned = text.replace(
    /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE00}-\u{FEFF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F1FF}\u{1F200}-\u{1F2FF}\u{1F900}-\u{1F9FF}\u{231A}-\u{231B}\u{23E9}-\u{23F3}\u{25AA}-\u{25FE}\u{2614}-\u{2615}\u{1F004}\u{1F0CF}]/gu,
    ""
  ).replace(/\s{2,}/g, " ").trim();
  if (cleaned !== text) console.log("[AI] emoji stripped from response");
  return cleaned;
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

export type AIResponse = { text: string; inputTokens: number; outputTokens: number };

// Detects if client's message mentions >= 500 sqft (or equivalent sqm).
// Returns the sqft value, or null if not a large lead.
export function detectLargeLeadSqft(text: string): number | null {
  const sqftMatch = text.match(/\b(?:around|about|approximately|roughly)?\s*(\d[\d,]*)\s*(?:sqft|sq\.?\s*ft\.?|square\s+feet?)/i);
  if (sqftMatch) {
    const n = parseInt(sqftMatch[1].replace(/,/g, ""), 10);
    if (n >= 500) return n;
  }
  const sqmMatch = text.match(/\b(?:around|about|approximately|roughly)?\s*(\d[\d,]*)\s*(?:sqm|sq\.?\s*m\.?|square\s+met(?:er|re)s?|m[²2])/i);
  if (sqmMatch) {
    const sqm = parseInt(sqmMatch[1].replace(/,/g, ""), 10);
    const sqft = Math.round(sqm * 10.76);
    if (sqft >= 500) return sqft;
  }
  return null;
}

// ─── Main AI response via Claude claude-sonnet-4-6 ───────────────────────────────
export async function getAIResponse(
  messages: ChatMessage[],
  memoryContext?: string | null,
  systemMemory?: string | null,
  ownerCorrections?: string | null,
  bookingConfirmed?: boolean
): Promise<AIResponse> {
  // After booking is confirmed, send NOTHING to the client — webhook already notified the owner
  if (bookingConfirmed) {
    console.log("[AI] Booking confirmed — sending nothing to client");
    return { text: "", inputTokens: 0, outputTokens: 0 };
  }

  // Check hard-coded intercepts first — bypasses AI entirely for known patterns
  const hardcoded = checkHardcodedResponse(messages);
  if (hardcoded) {
    console.log("[AI] Hard-coded intercept triggered:", hardcoded.slice(0, 60));
    return { text: hardcoded, inputTokens: 0, outputTokens: 0 };
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

  // FINAL REMINDERS — come last to reinforce the most critical rules
  systemContent += `\n\n---\n\nFINAL REMINDERS:\n1. Zero dashes — no -, –, or — anywhere. Replace with commas or periods.\n2. Zero emojis — no emoji, no decorative symbol, nothing. Plain text only.\n3. LENGTH RULE: Use 1 sentence when the message is complete with just the answer. Use 2 sentences ONLY when you genuinely need both an answer AND a forward question. Never 3 sentences. NEVER use a standalone opener like "Perfect!", "Great!", "Sounds good!", "Hello!", or "Hi!" as its own sentence — always merge it with a comma: "Perfect, at $5/sqft that's $1,000." not "Perfect! At $5/sqft that's $1,000."\n4. SQFT RULE: If the client mentions a specific number of 500 sqft or more, NEVER give a price. Always propose the free in-person visit. This overrides everything else.\n5. SCOPE ALREADY ANSWERED RULE: If the client has already mentioned in this conversation which areas, rooms, or project scope (kitchen, bedroom, whole house, one room, etc.), NEVER ask "one area or whole house?" again. That question is asked ONCE at the very start. When the client asks about scheduling, availability, pricing, or anything else AFTER already stating scope, answer their question directly without re-attaching the classification question.\n6. BOOKING DONE RULE: If [BOOKING ALREADY CONFIRMED] appears in the system context, the conversation is over. Do NOT answer any question. For ANY client message, respond with ONE sentence redirecting to Ozzi and add [NOTIFY_OWNER] — example: "I'll connect you with Ozzi for anything else you need![NOTIFY_OWNER]" NEVER generate [BOOK:...]. NEVER answer questions directly. NEVER mention appointment details.\n7. SLOT CONFIRMATION RULE: Ask for address and phone ONLY after the client explicitly names a specific day and time (e.g., "Monday at 3pm works"). Vague replies like "Okay", "Sounds good", "Alright", "I'll let you know" mean they are still deciding — respond with ONE sentence only and wait. NEVER use "No problem!" as a standalone sentence — merge it: "No problem, just let me know which day works!" Never push for address/phone when the slot is not confirmed.\n8. PRE-BOOKING TEXT RULE: The text before [BOOK:...] must be 5 words or fewer. NEVER repeat the date, time, or address in that text. The system sends the confirmation automatically. Write ONLY something like "Perfect, see you then!" or "All set!" before the tag.\n9. ONLY when the client asks "what is included", "what does the package include", "is labor included", or "does it include installation" → reply EXACTLY: "${WHAT_IS_INCLUDED_RESPONSE}" For any other package question (explaining, pricing, details), answer naturally.\n10. Colors: plain text only, no tags or brackets of any kind.\n10b. OPTIONS/MATERIALS RULE: When the client asks about floor options, material options, colors available, or what products you carry — NEVER list specific color names or product names in your response. ALWAYS redirect to the website and Instagram: "You can browse all our floor options and see completed projects at ozzifloors.com and on our Instagram @ozzi.floors." Then ask one follow-up question about their style preference. This rule overrides any impulse to describe colors.\n11. If the client asks for a phone number or contact: use ONLY (561) 674-8334. The owner's name is Ozzi. NEVER invent a number.\n12. LARGE LEAD RULE: For projects 500 sqft or more: NEVER give a total price or dollar estimate by DM. Always push for the free in-person visit. Asking "how much?" or "what's the price per sqft?" does NOT mean the client refuses a visit — it means they want information. Give the visit offer, not a price.\n13. TILE RULE: When the client mentions "tile", "tiles", "porcelain", or "ceramic" — this is a TILE installation job, NOT luxury vinyl. NEVER quote $5/sqft for a tile job. Tile labor only is $4.50/sqft. Tile demo/removal is $1.50/sqft extra. For tile projects 500 sqft or more, NEVER give a total DM price — always propose the free visit.\n14. NO INVENTED SLOTS RULE: If you do NOT see [REAL-TIME SCHEDULE] with actual time slots in this conversation context, you have ZERO schedule information. NEVER say "I have Thursday at 2pm" or any specific day/time. The ONLY correct answer when asked about availability is: "Let me check what I have open. What day works best for you?" — then stop. Do not invent or guess any slot.`;

  // Inject booking-confirmed block directly into system prompt (highest priority — model reads it last)
  if (bookingConfirmed) {
    systemContent += `\n\n---\n\nCRITICAL — BOOKING ALREADY CONFIRMED:\nThe conversation is over. Do NOT answer any question or continue the conversation.\n- For ANY message — thank-you, question, or anything else — respond with ONE sentence redirecting to Ozzi, then add [NOTIFY_OWNER]\n- Required format: "I'll connect you with Ozzi for anything else you need![NOTIFY_OWNER]"\n- NEVER generate [BOOK:...] under any circumstance\n- NEVER answer questions about time, address, arrival, or any topic\n- NEVER say any slot is taken or unavailable\n- NEVER use any person's name other than Ozzi`;
  }

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 300,
    system: systemContent,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  });

  const block = response.content[0];
  if (block.type === "text") {
    let cleaned = removeEmojis(removeDashes(block.text));
    const hadDash = block.text !== cleaned;

    // Strip any [SEND_IMAGES: ...] tags the AI may still generate
    if (/\[SEND_IMAGES[^\]]*\]/i.test(cleaned)) {
      cleaned = cleaned.replace(/\[SEND_IMAGES[^\]]*\]/gi, "").replace(/\n{3,}/g, "\n\n").trim();
      // Ensure the links are present if not already
      if (!cleaned.includes("ozzifloors.com")) {
        cleaned += "\n\nYou can browse all our options at ozzifloors.com and on our Instagram @ozzi.floors.";
      }
      console.log("[AI v4] [SEND_IMAGES] tag stripped from response");
    }

    console.log(`[AI v4] dash removed: ${hadDash} | preview: ${cleaned.slice(0, 60)}`);
    return { text: cleaned, inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens };
  }
  return { text: "Sorry, I couldn't generate a response.", inputTokens: 0, outputTokens: 0 };
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
