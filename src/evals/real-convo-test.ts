/**
 * Real conversation simulation — tests a full end-to-end flow
 * including post-booking silence.
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

const c = {
  green:  (s: string) => `\x1b[32m${s}\x1b[0m`,
  red:    (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan:   (s: string) => `\x1b[36m${s}\x1b[0m`,
  bold:   (s: string) => `\x1b[1m${s}\x1b[0m`,
  dim:    (s: string) => `\x1b[2m${s}\x1b[0m`,
};

interface Turn {
  client: string;
  bookingConfirmed?: boolean;
  checks: Array<{ label: string; fn: (r: string) => boolean }>;
}

interface Conversation {
  name: string;
  turns: Turn[];
}

// Simulates the [SYSTEM: ...] context the webhook injects into the last user message
const FAKE_SCHEDULE = `[SYSTEM: Today is Monday, June 2 2026.\n\n[REAL-TIME SCHEDULE: Available slots this week:\n- Tuesday June 3: 10:00am, 2:00pm\n- Wednesday June 4: 9:00am, 4:00pm\n- Thursday June 5: 11:00am, 3:00pm]]`;

function withSchedule(msg: string): string {
  return `${msg}\n\n${FAKE_SCHEDULE}`;
}

const CONVERSATIONS: Conversation[] = [
  {
    name: "Fluxo completo: small lead → orçamento → farewell",
    turns: [
      {
        client: "Hi! I'm interested in flooring for one bedroom",
        checks: [
          { label: "Pergunta o tipo de piso (tile/vinyl/hardwood)", fn: r => /tile/i.test(r) && /vinyl/i.test(r) && /hardwood/i.test(r) },
          { label: "Não cota preço ainda", fn: r => !/\$\s?\d/.test(r) },
          { label: "Zero emojis",          fn: r => !/[\u{1F300}-\u{1FAFF}]/u.test(r) },
          { label: "Zero dashes",          fn: r => !/[—–]/.test(r) },
        ],
      },
      {
        client: "Vinyl, it's about 200 sqft",
        checks: [
          { label: "Dá um preço pelo DM (small lead vinil)", fn: r => /\$\s?\d|1[,.]?500/.test(r) },
          { label: "Zero emojis",               fn: r => !/[\u{1F300}-\u{1FAFF}]/u.test(r) },
        ],
      },
      {
        client: "Thanks, I'll think about it",
        checks: [
          { label: "Resposta curta (farewell)",    fn: r => r.length < 150 },
          { label: "Não faz upselling",            fn: r => !/\$5|package|quote|send/i.test(r) },
          { label: "Zero emojis",                  fn: r => !/[\u{1F300}-\u{1FAFF}]/u.test(r) },
        ],
      },
    ],
  },

  {
    name: "Fluxo completo: large lead → visita → booking → silêncio pós-booking",
    turns: [
      {
        client: "Hello, I want to redo the flooring for my whole house",
        checks: [
          { label: "Pergunta o tipo OU propõe visita (large lead)", fn: r => (/tile/i.test(r) && /vinyl/i.test(r) && /hardwood/i.test(r)) || /visit|in.?person|come|measure|stop\s+by|how\s+(big|many|large)|size|square\s*f|sqft/i.test(r) },
          { label: "Zero emojis",                  fn: r => !/[\u{1F300}-\u{1FAFF}]/u.test(r) },
          { label: "Zero dashes",                  fn: r => !/[—–]/.test(r) },
        ],
      },
      {
        client: withSchedule("The whole house, around 1800 square feet"),
        checks: [
          { label: "Propõe visita (large lead)",  fn: r => /visit|in.?person|come|measure|stop\s+by/i.test(r) },
          { label: "Não dá preço total por DM",   fn: r => !(/\$\s*[\d,]{4,}/.test(r) && !/approximate|rough|estimate/i.test(r)) },
          { label: "Zero emojis",                 fn: r => !/[\u{1F300}-\u{1FAFF}]/u.test(r) },
        ],
      },
      {
        client: withSchedule("Tuesday at 10am works for me"),
        checks: [
          { label: "Pede endereço e telefone",  fn: r => /address|phone|number/i.test(r) },
          { label: "Zero emojis",               fn: r => !/[\u{1F300}-\u{1FAFF}]/u.test(r) },
          { label: "Zero dashes",               fn: r => !/[—–]/.test(r) },
        ],
      },
      {
        client: "My address is 1234 SW 8th St, Miami. Phone is (305) 555-1234",
        checks: [
          { label: "Gera tag [BOOK:...]",   fn: r => /\[BOOK:/i.test(r) },
          { label: "Texto antes da tag ≤ 6 palavras", fn: r => {
            const before = r.replace(/\[BOOK:[\s\S]*?\]/gi, "").trim();
            return before.split(/\s+/).length <= 6;
          }},
          { label: "Zero emojis",           fn: r => !/[\u{1F300}-\u{1FAFF}]/u.test(r) },
        ],
      },
      {
        client: "Ok thank you so much!",
        bookingConfirmed: true,
        checks: [
          { label: "SILÊNCIO TOTAL — nada enviado ao cliente", fn: r => r.trim() === "" },
        ],
      },
      {
        client: "What time will you arrive on Tuesday?",
        bookingConfirmed: true,
        checks: [
          { label: "SILÊNCIO TOTAL — nada enviado ao cliente", fn: r => r.trim() === "" },
        ],
      },
    ],
  },

  {
    name: "Tile job → não cita $5/sqft, propõe visita se >= 500 sqft",
    turns: [
      {
        client: "I want to install tile in my kitchen and 2 bathrooms, about 600 sqft total",
        checks: [
          { label: "NÃO cita $5/sqft",          fn: r => !/\$5(?:\/sq|\s+per)/i.test(r) },
          { label: "Propõe visita (tile + large)", fn: r => /visit|in.?person|come|measure/i.test(r) },
          { label: "Zero emojis",               fn: r => !/[\u{1F300}-\u{1FAFF}]/u.test(r) },
          { label: "Zero dashes",               fn: r => !/[—–]/.test(r) },
        ],
      },
    ],
  },

  {
    name: "Cliente pede fotos → redireciona para WhatsApp, sem [SEND_IMAGES]",
    turns: [
      {
        client: "Can you show me some photos of your floors?",
        checks: [
          { label: "Redireciona para WhatsApp", fn: r => /whatsapp|561\D*674\D*8334/i.test(r) },
          { label: "Sem [SEND_IMAGES]",                       fn: r => !/\[SEND_IMAGES/i.test(r) },
          { label: "Zero emojis",                             fn: r => !/[\u{1F300}-\u{1FAFF}]/u.test(r) },
        ],
      },
    ],
  },

  {
    name: "Pedido de telefone → número correto apenas",
    turns: [
      {
        client: "What's your phone number? I'd like to call",
        checks: [
          { label: "Número correto (561) 674-8334", fn: r => r.includes("(561) 674-8334") },
          { label: "Sem número inventado",          fn: r => {
            const nums = r.match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) ?? [];
            return nums.every(p => p.replace(/\D/g, "") === "5616748334");
          }},
          { label: "Zero emojis", fn: r => !/[\u{1F300}-\u{1FAFF}]/u.test(r) },
        ],
      },
    ],
  },
];

async function main() {
  const startMs = Date.now();
  console.log(c.bold("\nOzziFloors — Teste de Conversa Real (multi-turno)\n"));

  let totalPassed = 0;
  let totalFailed = 0;
  const failures: string[] = [];

  for (const convo of CONVERSATIONS) {
    console.log(c.bold(`\n═══ ${convo.name} ═══`));

    const history: ChatMessage[] = [];

    for (let i = 0; i < convo.turns.length; i++) {
      const turn = convo.turns[i];
      history.push({ role: "user", content: turn.client });

      console.log(c.cyan(`\n  [Cliente] "${turn.client}"`));

      let response: string;
      try {
        const result = await getAIResponse(
          history,
          null, null, null,
          turn.bookingConfirmed ?? false
        );
        response = result.text;
      } catch (e) {
        console.log(c.red(`  ERRO chamando IA: ${e}`));
        totalFailed++;
        failures.push(`${convo.name} | Turno ${i + 1}: API error`);
        break;
      }

      const preview = response === "" ? c.dim("  [sem resposta — silêncio]") : `  [IA] "${response.replace(/\n+/g, " ").slice(0, 110)}${response.length > 110 ? "…" : ""}"`;
      console.log(preview);

      if (response !== "") {
        history.push({ role: "assistant", content: response });
      }

      let turnPassed = true;
      for (const check of turn.checks) {
        const ok = check.fn(response);
        console.log(`    ${ok ? c.green("✓") : c.red("✗")} ${check.label}`);
        if (!ok) {
          turnPassed = false;
          failures.push(`${convo.name} | Turno ${i + 1} | ${check.label}`);
        }
      }

      if (turnPassed) {
        totalPassed++;
        console.log(c.green("    → turno OK"));
      } else {
        totalFailed++;
        console.log(c.red("    → turno FALHOU"));
      }
    }
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  console.log("\n" + "─".repeat(60));
  console.log(c.bold(`Resultado: ${c.green(`${totalPassed} turnos OK`)}  ${c.red(`${totalFailed} falhou`)}  (${elapsed}s)`));

  if (failures.length > 0) {
    console.log(c.red("\nFalhas:"));
    for (const f of failures) console.log(c.red(`  • ${f}`));
  }

  console.log();
  process.exit(totalFailed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("Teste crashou:", e);
  process.exit(1);
});
