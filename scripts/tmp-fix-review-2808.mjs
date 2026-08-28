// Correções da revisão adversarial de 28/08/2026 (7 lentes + verificação manual).
import { applyPatches } from "./tmp-patch-lib.mjs";

applyPatches([
  // ─────────────────────────────────────────────────────────────────────────
  // F1. GRAVADO ≠ ENVIADO depois do strip de ¿¡ → o eco do IG/FB não bate com a
  // linha do banco → "[Treino] ..." + mode=human → o lead fica MUDO (é o
  // incidente de 03/08 do followup, reintroduzido pelo strip). O envio já limpa
  // (stripInternalMarkers → stripInvertedPunctuation); agora o INSERT limpa igual.
  {
    file: "src/lib/followup.ts",
    find: `      await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: text + FOLLOWUP_DB_SUFFIX });`,
    replace: `      // O texto GRAVADO tem que ser idêntico ao ENVIADO: sendXMessage passa por
      // stripInvertedPunctuation (regra do dono 28/08, espanhol sem ¿¡) e o eco
      // do Messenger/IG volta já limpo — sem limpar aqui, norm() não bate, o
      // followup vira "[Treino]" e a conversa é pausada (mode=human).
      await supabaseAdmin.from("instagram_messages").insert({ conversation_id: conv.id, role: "assistant", content: stripInvertedPunctuation(text) + FOLLOWUP_DB_SUFFIX });`,
  },
  {
    file: "src/lib/followup.ts",
    find: `import { sendWhatsAppMessage } from "@/lib/whatsapp";`,
    replace: `import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { stripInvertedPunctuation } from "@/lib/outbound-text";`,
  },
  {
    file: "src/app/api/enviar/route.ts",
    find: `    const { error } = await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: conv.id,
      role: "assistant",
      content: text,
    });`,
    replace: `    // Gravar EXATAMENTE o que foi enviado (sendXMessage limpa ¿¡ — regra do dono
    // 28/08); texto diferente do eco = "[Treino]" + conversa pausada.
    const { error } = await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: conv.id,
      role: "assistant",
      content: stripInvertedPunctuation(text),
    });`,
  },
  {
    file: "src/app/api/confirmar-instalacao/route.ts",
    find: `    const { error } = await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: conv.id,
      role: "assistant",
      content: text,
    });`,
    replace: `    // Gravar EXATAMENTE o que foi enviado (sendWhatsAppMessage limpa ¿¡).
    const { error } = await supabaseAdmin.from("instagram_messages").insert({
      conversation_id: conv.id,
      role: "assistant",
      content: stripInvertedPunctuation(text),
    });`,
  },
  {
    file: "src/app/api/conversations/[id]/send/route.ts",
    find: `      conversation_id: id,
      role: "assistant",
      content: body.text,`,
    replace: `      conversation_id: id,
      // O dono pode digitar "¿" no painel; o envio limpa (regra 28/08), então o
      // banco tem que guardar o texto limpo — senão o eco do Messenger/IG não
      // bate com esta linha e a própria resposta dele vira "[Treino]".
      conversation_id: id,
      role: "assistant",
      content: stripInvertedPunctuation(body.text),`,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // F2. clientEngagedScheduling: 32 de 33 respostas reais de cliente ("I'm
  // flexible", "either one", "you choose", "amanhã", "quanto antes") NÃO
  // contavam como engajamento → o guard anti-pressão apagava a frase com o
  // horário ("I have today at 3pm or 5pm, which one works better?" virava
  // "which one works better?"). Mesma classe do bug T9. O \b do JS é ASCII: em
  // "amanhã" ele nunca fecha — por isso as formas acentuadas saem do grupo \b
  // e usam o idioma do resto do arquivo: (?:^|[\s...])(?:...)(?![a-zà-ÿ]).
  {
    file: "src/lib/ai.ts",
    find: `  return /\\b(?:asap|as\\s+soon\\s+as\\s+(?:possible|you\\s+can)|soonest|earliest|anytime|any\\s+(?:time|day|days|hour)|whenever|today|tonight|this\\s+week|all\\s+week|free\\s+(?:all|any|every|this)\\b|available\\s+(?:all|any|every|this)\\b|hoy|hoje|amanh[ãa]|lo\\s+antes\\s+posible|cuanto\\s+antes|cualquier\\s+(?:d[ií]a|hora|momento)|qualquer\\s+(?:dia|hora|momento)|o\\s+quanto\\s+antes|esta\\s+semana|toda\\s+la\\s+semana|a\\s+semana\\s+toda)\\b|`,
    replace: `  if (SOONEST_OR_DEFER_TO_US.test(clientText)) return true;
  return /\\b(?:asap|as\\s+soon\\s+as\\s+(?:possible|you\\s+can)|soonest|earliest|anytime|any\\s+(?:time|day|days|hour)|whenever|today|tonight|this\\s+week|all\\s+week|free\\s+(?:all|any|every|this)\\b|available\\s+(?:all|any|every|this)\\b|hoy|hoje|amanh[ãa]|lo\\s+antes\\s+posible|cuanto\\s+antes|cualquier\\s+(?:d[ií]a|hora|momento)|qualquer\\s+(?:dia|hora|momento)|o\\s+quanto\\s+antes|esta\\s+semana|toda\\s+la\\s+semana|a\\s+semana\\s+toda)\\b|`,
  },
  {
    file: "src/lib/ai.ts",
    find: `export function clientEngagedScheduling(userText: string): boolean {
  const clientText = userText.split(/\\n\\n?\\[SYSTEM:/)[0];`,
    replace: `// "Você escolhe" / "o mais cedo possível" — a resposta mais comum a "qual dia
// funciona melhor?" É engajamento de agenda tanto quanto dizer uma hora, e sem
// isto o guard anti-pressão apaga o horário da resposta (verificado 28/08: 32 de
// 33 frases reais falhavam). Sem \\b: o word boundary do JS é ASCII e nunca fecha
// depois de "amanhã"/"possível" — mesmo idioma usado no resto do arquivo.
const SOONEST_OR_DEFER_TO_US = new RegExp(
  "(?:^|[\\\\s.,!?;:¡¿\"'()\\\\-])(?:" +
    [
      // inglês: deixa a escolha conosco / o quanto antes
      "flexible", "i'?m\\\\s+flexible", "im\\\\s+flexible",
      "whatever\\\\s+(?:works|day|time|is\\\\s+(?:best|soonest|earliest|easier)|you\\\\s+have)",
      "whichever(?:\\\\s+(?:works|is\\\\s+(?:best|easier)|you\\\\s+(?:have|prefer)))?",
      "either(?:\\\\s+(?:one|day|time|works|is\\\\s+fine))?",
      "up\\\\s+to\\\\s+you", "you\\\\s+(?:choose|pick|decide|tell\\\\s+me)",
      "does(?:n'?t|\\\\s+not)\\\\s+matter", "no\\\\s+preference",
      "as\\\\s+early\\\\s+as\\\\s+(?:possible|you\\\\s+can)", "as\\\\s+soon\\\\s+as\\\\s+possible",
      "right\\\\s+away", "the\\\\s+sooner\\\\s+the\\\\s+better",
      "(?:i'?m|i\\\\s+am|im)\\\\s+(?:free|available|open|around)",
      // espanhol
      "el\\\\s+m[áa]s\\\\s+pronto(?:\\\\s+posible)?", "lo\\\\s+m[áa]s\\\\s+pronto(?:\\\\s+posible)?",
      "cualquier\\\\s+horario", "cualquier\\\\s+d[ií]a", "cuando\\\\s+(?:puedas|pueda|quieras)",
      "estoy\\\\s+(?:libre|disponible)", "lo\\\\s+que\\\\s+sea\\\\s+mejor", "el\\\\s+que\\\\s+sea",
      "cuando\\\\s+gustes", "t[uú]\\\\s+decides", "como\\\\s+prefieras",
      // português
      "amanh[ãa]", "o\\\\s+mais\\\\s+cedo(?:\\\\s+poss[íi]vel)?", "quanto\\\\s+antes",
      "qualquer\\\\s+(?:hor[áa]rio|dia|hora)", "quando\\\\s+(?:puder|voc[êe]\\\\s+puder|quiser)",
      "estou\\\\s+(?:livre|dispon[íi]vel)", "voc[êe]\\\\s+escolhe", "o\\\\s+que\\\\s+for\\\\s+melhor",
      "tanto\\\\s+faz", "pode\\\\s+ser\\\\s+qualquer",
    ].join("|") +
    ")(?![a-zà-ÿ])",
  "i"
);

export function clientEngagedScheduling(userText: string): boolean {
  const clientText = userText.split(/\\n\\n?\\[SYSTEM:/)[0];`,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // F3. Corte de HOJE nas mensagens enlatadas era 30 min, mas createBooking
  // BLOQUEIA qualquer visita de hoje a menos de SAME_DAY_MIN_NOTICE_MIN (120).
  // Resultado: às 17h o bot oferecia "hoje às 18h", o cliente aceitava e o
  // agendamento era recusado ("couldn't lock in") — justamente no dia que a
  // regra do dono manda encher primeiro.
  {
    file: "src/lib/scheduler.ts",
    find: `      const cutoff = nowET.hour * 60 + nowET.minute + 30;`,
    replace: `      const cutoff = nowET.hour * 60 + nowET.minute + SAME_DAY_MIN_NOTICE_MIN;`,
    count: 2,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // F4. O scrubber de vazamento não conhecia o vocabulário NOVO da nota
  // (28/08): "no empty hours", "fill from the first hour", "owner's rule".
  {
    file: "src/lib/ai.ts",
    find: `    /\\bpriority\\s+day\\b|\\bd[ií]a\\s+prioritari[oa]\\b|\\bdia\\s+priorit[áa]ri[oa]\\b|\\bfill\\s+rate\\b|\\bpreferred\\s+seller\\b|\\bvendedor\\s+prefer(?:ido|ente)\\b|\\b\\d{1,3}\\s?%\\s+(?:booked|full|reserved|ocupad[oa]|reservad[oa]|llen[oa]|chei[oa])\\b/.source,`,
    replace: `    /\\bpriority\\s+day\\b|\\bd[ií]a\\s+prioritari[oa]\\b|\\bdia\\s+priorit[áa]ri[oa]\\b|\\bfill\\s+rate\\b|\\bpreferred\\s+seller\\b|\\bvendedor\\s+prefer(?:ido|ente)\\b|\\b\\d{1,3}\\s?%\\s+(?:booked|full|reserved|ocupad[oa]|reservad[oa]|llen[oa]|chei[oa])\\b/.source,
    // SOONEST-DAY / EARLIEST-FIRST note vocabulary (2026-08-28): the note now
    // says "no empty hours", "fills from the first hour", "owner's rule",
    // "soonest day first". None of it is client-facing. "The earliest I have
    // is Monday at 9am" IS client-facing and must survive — hence the narrow
    // phrasing (no bare "earliest").
    /\\bno\\s+empty\\s+hours\\b|\\bempty\\s+hours\\b|\\bno\\s+holes\\b|\\bsoonest\\s+day\\s+first\\b|\\bowner'?s\\s+rule\\b|\\bregra\\s+do\\s+dono\\b|\\bregla\\s+del\\s+due[ñn]o\\b|\\bfills?\\s+from\\s+the\\s+first\\s+hour\\b|\\bfill\\s+from\\s+the\\s+first\\s+hour\\b|\\bdate\\s+first\\b/.source,`,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // F5. recapForDuplicateReply decidia o idioma do PREFIXO pelo "¿" da própria
  // resposta — que agora nunca existe. Um recap em espanhol saía com prefixo em
  // inglês ("As I mentioned above: Que dia te queda mejor?"). detectLang pesa
  // acentos e palavras, não a pontuação.
  {
    file: "src/lib/ai.ts",
    find: `  const lang: "en" | "es" | "pt" = /[¿¡]|\\b(hola|precio|instalaci[oó]n|cu[aá]l|gracias)\\b/i.test(reply)
    ? "es"
    : /\\b(voc[eê]|or[cç]amento|obrigad|instala[cç][aã]o)\\b/i.test(reply)
      ? "pt"
      : "en";`,
    replace: `  // O idioma vem de detectLang (acentos + vocabulário), NUNCA de "¿": desde a
  // regra do dono de 28/08 nenhuma resposta nossa em espanhol tem sinal
  // invertido, e o heurístico antigo prefixava espanhol com texto em inglês.
  const lang: "en" | "es" | "pt" = detectLang(reply);`,
  },

  // ─────────────────────────────────────────────────────────────────────────
  // F6. Contradições no prompt: STEP 2B mandava oferecer "2 DIAS" (sem horário)
  // e o exemplo da agenda mostrava TRÊS horários em DOIS dias, logo abaixo da
  // regra SOONEST DAY FIRST.
  {
    file: "src/lib/system-prompt.ts",
    find: `At the visit: measure everything, bring samples, give the final number on the spot. It is free. Always offer 2 specific available days from the real-time schedule in context.`,
    replace: `At the visit: measure everything, bring samples, give the final number on the spot. It is free. Always offer exactly 2 specific available TIMES taken from the real-time schedule in context, both from the SOONEST day that still has open times (its earliest two), never two days without times.`,
  },
  {
    file: "src/lib/system-prompt.ts",
    find: `Example: "Roughly $X approximate for that size, but the final price depends on the exact measurements. I can come by free to measure and bring samples. I have [day] and [day] open. What works?"`,
    replace: `Example: "Roughly $X approximate for that size, but the final price depends on the exact measurements. I can come by free to measure and bring samples. I have [soonest day] at [its earliest time] or [its next time]. What works?"`,
  },
  {
    file: "src/lib/scheduler.ts",
    find: String.raw`"\n- When you offer day options, you MUST name open times for EVERY day you offer, taken from each day's own line (e.g. 'Wednesday at 3pm, or Thursday at 9am or 11am — which works?').`,
    replace: String.raw`"\n- When you offer day options, you MUST name open times for EVERY day you offer, taken from each day's own line (e.g. 'Wednesday at 9am or 11am — which works?'; only when a day has a single open time do you reach into the next day, e.g. 'Wednesday at 5pm, or Thursday at 9am').`,
  },
]);
