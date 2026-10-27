// 27/10/2026 — AD PRICE CONTEXT: fetchAdCreative lê a saudação (page_welcome_message) e ganha cache por anúncio (facebook.ts)
// + funil.ts exporta o ad_id persistido da conversa (só banco) para os webhooks relerem o criativo em qualquer turno
import { applyPatches } from "./tmp-patch-lib.mjs";

const FB = "src/lib/facebook.ts";
const FU = "src/lib/funil.ts";

applyPatches([
  // C1. helper da saudação + cache (antes do comentário da função)
  {
    file: FB,
    find: String.raw`// Best-effort: "see the ad" by pulling its creative (all text fields + the main
// image) from the Meta Graph API using the ad_id that Meta sends on the referral.`,
    replace: String.raw`// The ad's greeting (page_welcome_message): the "Hi {{user_first_name}}! ...
// starting at $2,350" bubble the client reads before writing anything. It is a
// JSON string inside the story spec; its texts (the welcome message and the
// quick-replies variant) join the creative's signals so the price the client
// actually saw is visible to the webhooks (owner rule 2026-10-27, caso Jason:
// read what the ad promised before saying what is included).
function adGreetingText(raw: unknown): string | undefined {
  if (!raw) return undefined;
  try {
    const pwm = (typeof raw === "string" ? JSON.parse(raw) : raw) as Record<string, any>;
    const texts = [pwm?.text_format?.message?.text, pwm?.image_format?.message?.text]
      .filter((t): t is string => typeof t === "string" && t.trim().length > 0);
    return texts.length ? texts.join(" | ") : undefined;
  } catch {
    return undefined;
  }
}

// Per-ad cache: the webhooks re-read the creative on EVERY turn of an ad lead
// (flooring type + price tier), so one Graph call per ad per instance is enough.
const AD_CREATIVE_TTL_MS = 6 * 3600_000;
const adCreativeCache = new Map<string, { at: number; value: { text: string | null; imageUrl: string | null } }>();

// Best-effort: "see the ad" by pulling its creative (all text fields + the main
// image) from the Meta Graph API using the ad_id that Meta sends on the referral.`,
  },
  // C2. cache hit
  {
    file: FB,
    find: String.raw`    if (!adId || !/^\d{3,}$/.test(adId)) return empty;`,
    replace: String.raw`    if (!adId || !/^\d{3,}$/.test(adId)) return empty;
    const hit = adCreativeCache.get(adId);
    if (hit && Date.now() - hit.at < AD_CREATIVE_TTL_MS) return hit.value;`,
  },
  // C3. saudação entra nos textos
  {
    file: FB,
    find: String.raw`    const afs = (c.asset_feed_spec ?? {}) as Record<string, any>;
    const texts: Array<string | undefined> = [
      data.name, c.name, c.title, c.body, c.link_url,`,
    replace: String.raw`    const afs = (c.asset_feed_spec ?? {}) as Record<string, any>;
    const greeting = adGreetingText(link.page_welcome_message ?? afs.additional_data?.page_welcome_message);
    const texts: Array<string | undefined> = [
      data.name, c.name, c.title, c.body, c.link_url, greeting,`,
  },
  // C4. grava o cache
  {
    file: FB,
    find: String.raw`    return { text, imageUrl: imageUrl || null };
  } catch {
    return empty;
  }
}`,
    replace: String.raw`    const value = { text, imageUrl: imageUrl || null };
    if (text || value.imageUrl) adCreativeCache.set(adId, { at: Date.now(), value });
    return value;
  } catch {
    return empty;
  }
}`,
  },
  // D1. funil.ts: ad_id persistido, só banco
  {
    file: FU,
    find: String.raw`  try {
    return { contrato: JSON.parse(decodeURIComponent(key.slice(adxKeyPrefix(convId).length))) as ContratoAnuncio, key };
  } catch {
    return null;
  }
}`,
    replace: String.raw`  try {
    return { contrato: JSON.parse(decodeURIComponent(key.slice(adxKeyPrefix(convId).length))) as ContratoAnuncio, key };
  } catch {
    return null;
  }
}

// ad_id do anúncio de origem já persistido (funil_adx_, senão a chave legada
// funil_ad_), SÓ banco e nunca lança: os webhooks o usam em QUALQUER turno para
// reler o criativo (tipo de piso e faixa de preço do anúncio), porque a tabela
// de conversas não guarda o anúncio e o referral da Meta só vem na 1ª mensagem
// (regra do dono 27/10/2026: ler o que o anúncio prometeu antes de dizer o que
// está incluso).
export async function adIdPersistidoDaConversa(convId: string): Promise<string | null> {
  try {
    const persistido = await lerContratoPersistido(convId);
    if (persistido?.contrato.ad_id) return persistido.contrato.ad_id;
    const { data } = await supabaseAdmin
      .from("platform_settings")
      .select("platform")
      .like("platform", adKeyPrefix(convId) + "%")
      .limit(1);
    const key = data?.[0]?.platform as string | undefined;
    if (!key) return null;
    const rawId = key.slice("funil_ad_".length).split("::")[1];
    const adId = rawId ? decodeURIComponent(rawId) : "";
    return /^\d{3,}$/.test(adId) ? adId : null;
  } catch {
    return null;
  }
}`,
  },
]);
