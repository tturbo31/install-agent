/**
 * Flexible scenario runner — feeds arbitrary scenarios through the SAME brain
 * (getAIResponse) the 3 channels use, and prints the raw responses as JSON.
 * Used by the adversarial test workflow: an agent writes a scenarios JSON file,
 * runs this, then grades the responses.
 *
 * Usage: npx tsx src/evals/run-scenarios.ts <scenarios.json>
 * Input JSON: [{ "name": "...", "messages": [{"role":"user","content":"..."}], "bookingConfirmed": false }]
 * Output JSON: [{ "name": "...", "response": "...", "error": null }]
 */
import { readFileSync } from "fs";
import { join } from "path";
import { getAIResponse, type ChatMessage } from "../lib/ai";

function loadEnv() {
  try {
    const content = readFileSync(join(process.cwd(), ".env.local"), "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, "");
      if (key && !process.env[key]) process.env[key] = val;
    }
  } catch {}
}
loadEnv();

interface Scenario {
  name: string;
  messages: ChatMessage[];
  bookingConfirmed?: boolean;
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error("Usage: tsx run-scenarios.ts <scenarios.json>");
    process.exit(2);
  }
  const scenarios = JSON.parse(readFileSync(file, "utf-8")) as Scenario[];
  const out: Array<{ name: string; response: string | null; error: string | null }> = [];
  for (const s of scenarios) {
    try {
      const r = await getAIResponse(s.messages, null, null, null, s.bookingConfirmed ?? false);
      out.push({ name: s.name, response: r.text, error: null });
    } catch (e) {
      out.push({ name: s.name, response: null, error: String(e) });
    }
  }
  console.log(JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error("runner crashed:", e);
  process.exit(1);
});
