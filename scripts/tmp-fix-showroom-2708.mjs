// Showroom: "Do you have a showroom?" → SIM, temos o MOBILE showroom (sem loja
// física, levamos as amostras até a casa). Caso WA +1 954 695-5414, 27/08/2026:
// o modelo respondeu "We don't have a showroom" — regra inexistente no prompt.
import { applyPatches } from "./tmp-patch-lib.mjs";

const PROMPT = "src/lib/system-prompt.ts";
const AI = "src/lib/ai.ts";

applyPatches([
  {
    file: PROMPT,
    find: String.raw`Example: "I'd love for you to see them in person! I bring all the samples to your free visit so you can see everything and pick the right one right there. Is it just one area or the whole house?"

IS IT REALLY VINYL:`,
    replace: String.raw`Example: "I'd love for you to see them in person! I bring all the samples to your free visit so you can see everything and pick the right one right there. Is it just one area or the whole house?"

(2c) SHOWROOM → the answer is YES, we have a MOBILE SHOWROOM. Whenever the client asks if we have a showroom, a store, a shop, a warehouse or a physical location where they can go see the floors ("do you have a showroom", "where is your showroom", "can I come see the floors", "tienen showroom", "tienen tienda", "vocês têm loja/showroom"), NEVER say "we don't have a showroom" or "no showroom". Say: yes, we have a mobile showroom, we don't have a physical store, we bring all the samples right to your home so you can see and compare them on your own floor, free of charge. Then continue the normal flow (one area or the whole house, or propose the visit at 500+ sqft). If they insist on visiting a store, repeat kindly that it is a mobile showroom only and offer the free visit.
Example: "Yes, we have a mobile showroom: we don't have a physical store, I bring all the samples right to your home so you can compare them on your own floor, free of charge. Is it just one area or the whole house?"
Spanish example: "Sí, tenemos un showroom móvil: no tenemos tienda física, te llevo todas las muestras a tu casa para que las compares en tu propio piso, sin costo. ¿Es solo un área o toda la casa?"

IS IT REALLY VINYL:`,
  },
  {
    file: AI,
    find: String.raw`const ZIP_REASK_FRAGMENT = `,
    replace: String.raw`// SHOWROOM (caso WA 27/08/2026): o cliente perguntou "Do you have a showroom"
// e o modelo respondeu "We don't have a showroom". Regra do dono: a resposta é
// SIM, temos o MOBILE showroom (sem loja física, levamos as amostras até a casa).
// isShowroomQuestion detecta a pergunta (EN/ES/PT); fixShowroomDenial troca a
// frase de negação por essa resposta quando a reply nega e não cita "mobile".
const SHOWROOM_WORD = /\b(?:show\s*rooms?|store|shop|warehouse|storefront|physical\s+location|tiendas?|local|almac[eé]n|bodega|lojas?|loja\s+f[ií]sica)\b/i;
export function isShowroomQuestion(text: string): boolean {
  const t = normalizeSmartPunct(text || "").split(/\n\n?\[SYSTEM:/)[0];
  if (!SHOWROOM_WORD.test(t)) return false;
  return /\b(?:do|does|did|have|has|got|is|are|where|any|there)\b[^.!?\n]{0,60}\b(?:show\s*rooms?|store|shop|warehouse|storefront|physical\s+location)\b|\b(?:show\s*rooms?|store|shop|warehouse)\b[^.!?\n]{0,30}\?|\b(?:tienen?|hay|d[oó]nde|cu[aá]l\s+es)\b[^.!?\n]{0,40}\b(?:show\s*rooms?|tiendas?|local|almac[eé]n|bodega)\b|\b(?:t[eê]m|tem|voc[eê]s?|onde|qual)\b[^.!?\n]{0,40}\b(?:show\s*rooms?|lojas?)\b|\b(?:come|go|visit|stop)\s+(?:by|to|in)?\s*(?:your|the|a)\s+(?:show\s*rooms?|store|shop|warehouse)\b/i.test(t);
}
const SHOWROOM_DENIAL = /[^.!?\n]*\b(?:(?:don'?t|do\s+not|doesn'?t|does\s+not|no)\s+(?:currently\s+|actually\s+)?(?:have|got)\s+(?:a|an|any)?\s*(?:physical\s+|traditional\s+)?(?:show\s*rooms?|store|shop|warehouse|storefront)|(?:we|there)(?:'re|'s|\s+are|\s+is)\s+(?:not|no)\s+(?:a\s+)?(?:physical\s+|traditional\s+)?(?:show\s*rooms?|store|shop|warehouse|storefront)|no\s+(?:tenemos|contamos\s+con|hay)\s+(?:un\s+|una\s+)?(?:show\s*rooms?|tiendas?|local|almac[eé]n)|n[aã]o\s+(?:temos|tem)\s+(?:um\s+|uma\s+)?(?:show\s*rooms?|lojas?))\b[^.!?\n]*[.!?]?/i;
const SHOWROOM_ANSWER: Record<string, string> = {
  en: "Yes, we have a mobile showroom: we don't have a physical store, I bring all the samples right to your home so you can compare them on your own floor, free of charge.",
  es: "Sí, tenemos un showroom móvil: no tenemos tienda física, te llevo todas las muestras a tu casa para que las compares en tu propio piso, sin costo.",
  pt: "Sim, temos um showroom móvel: não temos loja física, eu levo todas as amostras até a sua casa para você comparar no seu próprio piso, sem custo.",
};
export function fixShowroomDenial(text: string, lang: "en" | "es" | "pt" = "en"): string {
  return withTagsProtected(text, (prose) => {
    if (/\bmobile\s+show\s*room|show\s*room\s+m[oó]vi[l]?/i.test(prose)) return prose;
    if (!SHOWROOM_DENIAL.test(prose)) return prose;
    const answer = SHOWROOM_ANSWER[lang] ?? SHOWROOM_ANSWER.en;
    let out = prose.replace(SHOWROOM_DENIAL, answer);
    // Sobrou uma explicação redundante da mesma coisa ("but that's actually the
    // better setup: I come directly to your property, bring all the samples…")?
    // Apaga a frase seguinte que só repete amostras/visita, mantendo a pergunta.
    const idx = out.indexOf(answer);
    if (idx >= 0) {
      const after = out.slice(idx + answer.length);
      const redundant = after.match(/^\s*(?:but\s+)?[^.!?\n]*\b(?:samples|muestras|amostras|come\s+(?:directly\s+)?to\s+your|property)\b[^.!?\n]*[.!?]/i);
      if (redundant) out = out.slice(0, idx + answer.length) + " " + after.slice(redundant[0].length).trimStart();
    }
    return out.replace(/[ \t]{2,}/g, " ").trim();
  });
}

const ZIP_REASK_FRAGMENT = `,
  },
  {
    file: AI,
    find: String.raw`    // Strip any [SEND_IMAGES: ...] tags the AI may still generate
    if (/\[SEND_IMAGES[^\]]*\]/i.test(cleaned)) {`,
    replace: String.raw`    // Showroom: nunca "we don't have a showroom" — temos o MOBILE showroom.
    {
      const lastUser = [...(messages ?? [])].reverse().find((m) => m.role === "user");
      if (lastUser && isShowroomQuestion(lastUser.content || "")) {
        const fixed = fixShowroomDenial(cleaned, detectLang(lastUser.content || ""));
        if (fixed !== cleaned) {
          cleaned = fixed;
          console.log("[AI] showroom backstop: replaced 'no showroom' denial with the mobile showroom answer");
        }
      }
    }

    // Strip any [SEND_IMAGES: ...] tags the AI may still generate
    if (/\[SEND_IMAGES[^\]]*\]/i.test(cleaned)) {`,
  },
]);
