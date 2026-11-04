// Canal de uma conversa a partir do igsid (fb_… = Messenger, wa_… = WhatsApp,
// numérico = Instagram) e os rótulos/cores usados no painel. Funções puras,
// compartilhadas pela lista, pelo cabeçalho do chat e pela busca.

export type Channel = "instagram" | "facebook" | "whatsapp";

export const CHANNELS: Channel[] = ["instagram", "facebook", "whatsapp"];

/** Abas da lista do painel: um canal, ou só as conversas com a IA pausada. */
export type ListTab = Channel | "paused";

export const CHANNEL_LABEL: Record<Channel, string> = {
  instagram: "Instagram",
  facebook: "Messenger",
  whatsapp: "WhatsApp",
};

// Classes literais (Tailwind só gera o que aparece escrito no código).
// Cor do canal = categoria: só tinta pálida e ícone pequeno, nunca ênfase.
export const CHANNEL_TINT: Record<Channel, { text: string; bg: string; ring: string }> = {
  instagram: { text: "text-ig", bg: "bg-ig/15", ring: "ring-ig/30" },
  facebook: { text: "text-fb", bg: "bg-fb/15", ring: "ring-fb/30" },
  whatsapp: { text: "text-wa", bg: "bg-wa/15", ring: "ring-wa/30" },
};

export function getChannel(igsid: string | null | undefined): Channel {
  if (igsid?.startsWith("fb_")) return "facebook";
  if (igsid?.startsWith("wa_")) return "whatsapp";
  return "instagram";
}

/** Dígitos do número de WhatsApp guardado no igsid ("wa_15613037754" → "15613037754"). */
export function waPhoneDigits(igsid: string | null | undefined): string | null {
  if (!igsid?.startsWith("wa_")) return null;
  const d = igsid.slice(3).replace(/\D/g, "");
  return d.length >= 8 ? d : null;
}

/** Telefone legível: EUA "+1 (561) 303-7754", Brasil "+55 11 99999-9999", resto "+<dígitos>". */
export function formatPhone(digits: string | null | undefined): string {
  const d = (digits ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 11 && d.startsWith("1")) return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) {
    const local = d.slice(4);
    const split = local.length === 9 ? 5 : 4;
    return `+55 ${d.slice(2, 4)} ${local.slice(0, split)}-${local.slice(split)}`;
  }
  return `+${d}`;
}

/** Nome mostrado na lista e no cabeçalho: nome → @ → número do WhatsApp → "Cliente Messenger" → id. */
export function displayName(
  conv: { igsid: string; name: string | null; username: string | null },
  channel: Channel = getChannel(conv.igsid)
): string {
  if (conv.name) return conv.name;
  if (conv.username) return conv.username;
  if (channel === "whatsapp") return formatPhone(waPhoneDigits(conv.igsid)) || "Cliente WhatsApp";
  if (channel === "facebook") return "Cliente Messenger";
  return conv.igsid;
}

export function getInitials(name: string | null | undefined, username: string | null | undefined): string {
  const str = (name || username || "?").trim();
  return str
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .toUpperCase()
    .slice(0, 2);
}
