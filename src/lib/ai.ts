import OpenAI from "openai";
import { SYSTEM_PROMPT } from "@/lib/system-prompt";

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

const FALLBACK_MODELS = [
  "google/gemma-3-12b-it:free",
  "google/gemma-3-4b-it:free",
  "google/gemma-2-9b-it:free",
  "mistralai/mistral-small-3.1-24b-instruct:free",
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
