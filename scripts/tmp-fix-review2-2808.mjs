import { applyPatches } from "./tmp-patch-lib.mjs";

applyPatches([
  // conserta a chave duplicada do patch anterior
  {
    file: "src/app/api/conversations/[id]/send/route.ts",
    find: `      conversation_id: id,
      // O dono pode digitar "¿" no painel; o envio limpa (regra 28/08), então o
      // banco tem que guardar o texto limpo — senão o eco do Messenger/IG não
      // bate com esta linha e a própria resposta dele vira "[Treino]".
      conversation_id: id,
      role: "assistant",`,
    replace: `      // O dono pode digitar "¿" no painel; o envio limpa (regra 28/08), então o
      // banco tem que guardar o texto limpo — senão o eco do Messenger/IG não
      // bate com esta linha e a própria resposta dele vira "[Treino]".
      conversation_id: id,
      role: "assistant",`,
  },
  // imports que faltaram
  {
    file: "src/app/api/conversations/[id]/send/route.ts",
    find: `import { sendWhatsAppMessage } from "@/lib/whatsapp";`,
    replace: `import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { stripInvertedPunctuation } from "@/lib/outbound-text";`,
  },
  {
    file: "src/app/api/enviar/route.ts",
    find: `import { sendWhatsAppMessage } from "@/lib/whatsapp";`,
    replace: `import { sendWhatsAppMessage } from "@/lib/whatsapp";
import { stripInvertedPunctuation } from "@/lib/outbound-text";`,
  },
  {
    file: "src/app/api/confirmar-instalacao/route.ts",
    find: `import { sendWhatsAppMessage, notifyOwners } from "@/lib/whatsapp";`,
    replace: `import { sendWhatsAppMessage, notifyOwners } from "@/lib/whatsapp";
import { stripInvertedPunctuation } from "@/lib/outbound-text";`,
  },
]);
