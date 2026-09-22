// ─── TEXTO NÃO É TELEFONE (22/09/2026) ──────────────────────────────────────
//
// Caso real (Jesus, Instagram, 11/09): o bot pediu "nome, endereço e telefone"
// e o cliente respondeu "Jesus, 3285 Nw 211th St, Miami Gardens, 33056". A
// mensagem inteira foi para a plataforma no campo `telefone` — pareceTelefone
// só contava dígitos (3285 + 211 + 33056 = 12, "telefone válido") — e o
// ENDEREÇO virou a identidade do lead lá. O número de verdade chegou dois
// minutos depois e foi descartado (campo já "preenchido"); dez dias depois o
// mesmo cliente respondeu pelo WhatsApp, nasceu um segundo lead com o número
// certo, e a visita dele apareceu duas vezes no painel do dono.
//
// Regra (a mesma da plataforma, lib/rastreio-origem.ts): campo com três ou
// mais LETRAS é texto, não número — "or", "ext", "x" continuam passando.
// Função pura, sem dependências: testada em scripts/test-telefone-texto.mts.

/** Telefone de verdade: 10 a 15 dígitos, sem texto em volta. */
export function pareceTelefone(valor: string | null | undefined): boolean {
  const semRamal = (valor ?? "").replace(/\b(?:ext|ramal|x)\.?\s*\d+\s*$/i, "").trim();
  if ((semRamal.match(/[a-z]/gi) ?? []).length >= 3) return false;
  const d = semRamal.replace(/\D/g, "");
  return d.length >= 10 && d.length <= 15 && !/^0+$/.test(d.slice(-10));
}
