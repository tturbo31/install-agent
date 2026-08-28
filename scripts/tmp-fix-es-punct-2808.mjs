// Regra do dono (28/08/2026): em espanhol NUNCA usar ¿ / ¡ (só ? e ! no final, como no português).
// 1) helper stripInvertedPunctuation (outbound-text.ts) aplicado no envio dos 3 canais e no getAIResponse
// 2) enlatados em espanhol sem ¿¡ (strings literais; regexes de detecção ficam intactas)
// 3) regra no prompt (FINAL REMINDERS 1b)
import { readFileSync, writeFileSync } from "fs";
import { applyPatches } from "./tmp-patch-lib.mjs";

applyPatches([
  {
    file: "src/lib/outbound-text.ts",
    find: `export function stripInternalMarkers(text: string): string {
  return (text || "")
    .replace(/\\n{0,2}\\[SYSTEM: ?(?:FOLLOWUP_NUDGE|QUOTE_FOLLOWUP[^\\]]*|SEND_FAILED)\\]/g, "")
    .trim();
}`,
    replace: `export function stripInternalMarkers(text: string): string {
  return stripInvertedPunctuation(
    (text || "")
      .replace(/\\n{0,2}\\[SYSTEM: ?(?:FOLLOWUP_NUDGE|QUOTE_FOLLOWUP[^\\]]*|SEND_FAILED)\\]/g, "")
      .trim()
  );
}

// Regra do dono (28/08/2026): em espanhol a pontuação é como no português — só
// o "?" / "!" de fechamento, nunca os invertidos "¿" / "¡". Vale para o modelo
// e para todo enlatado; aplicado no envio dos 3 canais (backstop) e no
// getAIResponse (o que fica no banco também sai limpo).
export function stripInvertedPunctuation(text: string): string {
  return (text || "").replace(/[¿¡]/g, "");
}`,
  },
  {
    file: "src/lib/ai.ts",
    find: `import { clientConfirmedSlot, detectLang, repairDeclineMessage } from "@/lib/scheduler";`,
    replace: `import { clientConfirmedSlot, detectLang, repairDeclineMessage } from "@/lib/scheduler";
import { stripInvertedPunctuation } from "@/lib/outbound-text";`,
  },
  {
    file: "src/lib/ai.ts",
    find: `    // With prompt caching on, usage.input_tokens counts ONLY the uncached
    // remainder — the true prompt size is the sum of the three fields.`,
    replace: `    // Regra do dono (28/08/2026): nada de ¿ / ¡ em espanhol — só ? e ! no final.
    cleaned = stripInvertedPunctuation(cleaned);

    // With prompt caching on, usage.input_tokens counts ONLY the uncached
    // remainder — the true prompt size is the sum of the three fields.`,
  },
  {
    file: "src/lib/ai.ts",
    find: `Replace with commas or periods.\\n2. Zero emojis`,
    replace: `Replace with commas or periods.\\n1b. SPANISH PUNCTUATION: never use the inverted marks ¿ or ¡. In Spanish, punctuate exactly like Portuguese: only the closing ? or ! at the end of the sentence ("Cuál te interesa?", "Perfecto!"), never "¿Cuál te interesa?" or "¡Perfecto!".\\n2. Zero emojis`,
  },
]);

// Enlatados: apagar ¿¡ apenas em linhas que são strings literais (nunca em regex/comentário).
const CANNED = ["src/lib/scheduler.ts", "src/lib/system-prompt.ts", "src/lib/followup.ts", "src/lib/quote-followup.ts", "src/lib/route-optimizer.ts"];
for (const file of CANNED) {
  const raw = readFileSync(file, "utf-8");
  const crlf = /\r\n/.test(raw);
  let changed = 0;
  const out = raw.replace(/\r\n/g, "\n").split("\n").map((line) => {
    if (!/[¿¡]/.test(line)) return line;
    const isRegexOrComment = /^\s*\/\//.test(line) || /\.(?:match|test|replace)\(|new RegExp|^\s*(?:const|let)\s+[A-Z_]+\s*=\s*\//.test(line) || /\/[^/"`]*[¿¡][^/"`]*\/[gimsuy]*/.test(line);
    if (isRegexOrComment) return line;
    changed++;
    return line.replace(/[¿¡]/g, "");
  }).join("\n");
  writeFileSync(file, crlf ? out.replace(/\n/g, "\r\n") : out);
  console.log(`${file}: ${changed} linha(s) de enlatado limpas (${crlf ? "CRLF" : "LF"})`);
}
