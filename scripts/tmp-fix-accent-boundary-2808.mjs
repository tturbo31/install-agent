import { applyPatches } from "./tmp-patch-lib.mjs";

applyPatches([
  {
    file: "src/lib/scheduler.ts",
    find: String.raw`const SLOT_DAY_REF = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo|hoy|ma[ñn]ana|segunda|ter[çc]a|quarta|quinta|sexta|hoje|amanh[ãa])\b/i;`,
    replace:
      String.raw`// O \b final do JS é ASCII e NUNCA fecha depois de letra acentuada: "amanhã",` +
      "\n" +
      String.raw`// "sábado", "mañana" e "miércoles" simplesmente não casavam, então um cliente` +
      "\n" +
      String.raw`// PT/ES que confirmava o dia por extenso não era reconhecido como tendo` +
      "\n" +
      String.raw`// escolhido (bloqueava o [BOOK], repetia a pergunta e disparava o ZIP-first).` +
      "\n" +
      String.raw`// (?![a-zà-ÿ]) é o mesmo idioma já usado no resto do arquivo. Verificado 28/08.` +
      "\n" +
      String.raw`const SLOT_DAY_REF = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|today|tonight|tomorrow|lunes|martes|mi[eé]rcoles|jueves|viernes|s[áa]bado|domingo|hoy|ma[ñn]ana|segunda|ter[çc]a|quarta|quinta|sexta|hoje|amanh[ãa])(?![a-zà-ÿ])/i;`,
  },
]);
