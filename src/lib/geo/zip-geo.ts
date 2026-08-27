// ─── Geolocalização offline por ZIP / cidade (Sul da Flórida) ────────────────
// Base da otimização de rotas (route-optimizer.ts). Tudo aqui é puro e síncrono:
// nenhuma chamada de rede, nenhum banco. A tabela embutida (GeoNames) resolve
// qualquer ZIP 33xxx/34xxx para um centroide; um mapa de apelidos resolve as
// cidades/bairros que o cliente costuma digitar ("Kendall", "West Palm", "Ft
// Lauderdale", "Doral") para o ZIP mais representativo.
//
// Precisão: centroide do ZIP (~2-5 km). Suficiente para separar Miami de Boca
// de West Palm, que é o que decide a rota do vendedor.
import { FL_ZIP_CENTROIDS_RAW } from "./fl-zip-centroids";

export interface GeoPoint {
  lat: number;
  lng: number;
  zip?: string;
  label?: string; // "Miami (33130)" — só para logs/nota interna
  source: "zip" | "city" | "address" | "geocode";
}

interface ZipRow {
  lat: number;
  lng: number;
  place: string;
  county: string;
}

let ZIP_TABLE: Map<string, ZipRow> | null = null;
function zipTable(): Map<string, ZipRow> {
  if (ZIP_TABLE) return ZIP_TABLE;
  const map = new Map<string, ZipRow>();
  for (const entry of FL_ZIP_CENTROIDS_RAW.split(";")) {
    const colon = entry.indexOf(":");
    if (colon < 0) continue;
    const zip = entry.slice(0, colon);
    const [lat, lng, rest] = entry.slice(colon + 1).split(",", 3);
    const [place, county] = (rest ?? "").split("|");
    const la = Number(lat);
    const ln = Number(lng);
    if (!Number.isFinite(la) || !Number.isFinite(ln)) continue;
    map.set(zip, { lat: la, lng: ln, place: place ?? "", county: county ?? "" });
  }
  ZIP_TABLE = map;
  return map;
}

export function knownZipCount(): number {
  return zipTable().size;
}

export function zipCentroid(zip: string | null | undefined): GeoPoint | null {
  const z = (zip ?? "").toString().trim().slice(0, 5);
  if (!/^\d{5}$/.test(z)) return null;
  const row = zipTable().get(z);
  if (!row) return null;
  return { lat: row.lat, lng: row.lng, zip: z, label: `${row.place} (${z})`, source: "zip" };
}

export function zipPlace(zip: string | null | undefined): { place: string; county: string } | null {
  const z = (zip ?? "").toString().trim().slice(0, 5);
  const row = zipTable().get(z);
  return row ? { place: row.place, county: row.county } : null;
}

// ZIP dentro da área atendida (Homestead → Jupiter): todo ZIP da área começa
// por 33 (regra do prompt). Fora disso a rota não tem o que otimizar.
export function isServiceAreaZip(zip: string | null | undefined): boolean {
  return /^33\d{3}$/.test((zip ?? "").toString().trim());
}

// ─── Apelidos de cidade/bairro → ZIP representativo ─────────────────────────
// O GeoNames usa o nome postal (quase tudo em Miami-Dade é "Miami"), então os
// bairros e cidades que o cliente digita precisam de âncora própria. Cada
// apelido aponta para um ZIP que EXISTE na tabela (o eval route-optimizer-verify
// confere todos). SÓ cidades da área atendida: um nome fora da área não ajuda a
// rota e o prompt já recusa pelo ZIP/cidade.
//
// Muitos nomes também são nomes de pessoa ou palavras comuns ("Stuart",
// "Kendall", "Sunrise", "Hollywood", "Jupiter", "Boca"): um apelido só conta
// com CONTEXTO DE LUGAR — precedido de "in/near/em/en/..." ou seguido de
// "FL/Florida/area/ZIP" — ou quando a mensagem inteira é o nome da cidade
// (resposta seca a "qual o zip code?").
const CITY_ALIASES: Array<[string, string]> = [
  // Miami-Dade
  ["homestead", "33030"], ["florida city", "33034"], ["princeton", "33032"], ["leisure city", "33033"],
  ["cutler bay", "33189"], ["palmetto bay", "33157"], ["pinecrest", "33156"], ["kendall", "33176"],
  ["west kendall", "33186"], ["the hammocks", "33196"], ["country walk", "33196"], ["richmond west", "33177"],
  ["south miami", "33143"], ["coral gables", "33134"], ["coconut grove", "33133"], ["key biscayne", "33149"],
  ["brickell", "33131"], ["downtown miami", "33130"], ["little havana", "33135"], ["wynwood", "33127"],
  ["midtown miami", "33137"], ["design district", "33137"], ["edgewater", "33137"], ["allapattah", "33142"],
  ["westchester", "33165"], ["fontainebleau", "33174"], ["sweetwater", "33174"], ["tamiami", "33184"],
  ["doral", "33172"], ["miami springs", "33166"], ["hialeah", "33010"], ["hialeah gardens", "33018"],
  ["miami lakes", "33014"], ["miami gardens", "33056"], ["opa locka", "33054"], ["opa-locka", "33054"],
  ["north miami", "33161"], ["north miami beach", "33162"], ["aventura", "33180"], ["sunny isles", "33160"],
  ["sunny isles beach", "33160"], ["bal harbour", "33154"], ["surfside", "33154"], ["miami beach", "33139"],
  ["south beach", "33139"], ["miami shores", "33138"], ["biscayne park", "33161"], ["el portal", "33138"],
  ["golden glades", "33169"], ["norland", "33169"], ["carol city", "33055"], ["miami", "33130"],
  // Broward
  ["pembroke pines", "33024"], ["miramar", "33025"], ["hollywood", "33020"], ["hallandale", "33009"],
  ["hallandale beach", "33009"], ["dania", "33004"], ["dania beach", "33004"], ["davie", "33314"],
  ["cooper city", "33330"], ["weston", "33326"], ["southwest ranches", "33330"], ["plantation", "33324"],
  ["sunrise", "33322"], ["lauderhill", "33313"], ["lauderdale lakes", "33311"], ["tamarac", "33321"],
  ["fort lauderdale", "33301"], ["ft lauderdale", "33301"], ["ft. lauderdale", "33301"], ["fort lauderdale beach", "33304"],
  ["wilton manors", "33305"], ["oakland park", "33334"], ["lauderdale by the sea", "33308"],
  ["lauderdale-by-the-sea", "33308"], ["pompano", "33060"], ["pompano beach", "33060"], ["lighthouse point", "33064"],
  ["deerfield", "33441"], ["deerfield beach", "33441"], ["coconut creek", "33066"], ["margate", "33063"],
  ["north lauderdale", "33068"], ["coral springs", "33065"], ["parkland", "33076"], ["west park", "33023"],
  // Palm Beach
  ["boca", "33432"], ["boca raton", "33432"], ["west boca", "33428"], ["delray", "33444"], ["delray beach", "33444"],
  ["boynton", "33435"], ["boynton beach", "33435"], ["lantana", "33462"], ["lake worth", "33460"],
  ["lake worth beach", "33460"], ["greenacres", "33463"], ["palm springs", "33461"], ["wellington", "33414"],
  ["royal palm beach", "33411"], ["royal palm", "33411"], ["loxahatchee", "33470"], ["west palm", "33401"],
  ["west palm beach", "33401"], ["palm beach", "33480"], ["riviera beach", "33404"], ["north palm beach", "33408"],
  ["palm beach gardens", "33410"], ["jupiter", "33458"], ["tequesta", "33469"], ["juno beach", "33408"],
  ["jupiter farms", "33478"], ["singer island", "33404"],
];

// Regex compilado uma vez: apelidos mais longos primeiro, fronteira de palavra.
let ALIAS_RE: RegExp | null = null;
let ALIAS_MAP: Map<string, string> | null = null;
function aliasRegex(): { re: RegExp; map: Map<string, string> } {
  if (ALIAS_RE && ALIAS_MAP) return { re: ALIAS_RE, map: ALIAS_MAP };
  const sorted = [...CITY_ALIASES].sort((a, b) => b[0].length - a[0].length);
  const map = new Map<string, string>();
  for (const [name, zip] of sorted) map.set(name, zip);
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  ALIAS_RE = new RegExp(`(?<![a-z])(${sorted.map(([n]) => esc(n)).join("|")})(?![a-z])`, "gi");
  ALIAS_MAP = map;
  return { re: ALIAS_RE, map };
}

function fold(s: string): string {
  return (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// Contexto de lugar ANTES do nome ("in Miami", "near Boca", "en Hialeah",
// "moro em Doral", "the property is in Kendall") ou DEPOIS (", FL", "Florida",
// "area", um ZIP). "from"/"at" ficam de fora de propósito: "I'm from Naples
// originally" e "I can do it at sunrise" não dizem onde fica o imóvel.
const PLACE_BEFORE = /(?:\b(?:in|near|around|into|within|located\s+in|live\s+in|living\s+in|house\s+in|home\s+in|property\s+in|area\s+of|city\s+of|town\s+of|here\s+in|over\s+in|out\s+in|down\s+in|up\s+in)|\b(?:en|em|na|no|dentro\s+de|cerca\s+de|perto\s+de|vivo\s+en|vivimos\s+en|moro\s+em|moramos\s+em|estoy\s+en|estamos\s+en|estou\s+em|estamos\s+em|queda\s+en|fica\s+em|ubicad[oa]\s+en|localizad[oa]\s+em|zona\s+de|[aá]rea\s+de))\s+(?:the\s+|el\s+|la\s+|o\s+|a\s+)?$/i;
const PLACE_AFTER = /^\s*,?\s*(?:fl\b|florida\b|area\b|\d{5}\b|-\s*fl\b)/i;

// "boca" sozinho só vale com contexto em INGLÊS ("in Boca"): em espanhol,
// "de boca en boca" / "en boca de todos" é a boca mesmo.
const SPANISH_CUE_BEFORE = /\b(?:en|de)\s+$/i;

export function cityAliasZip(text: string, opts?: { anyContext?: boolean }): string | null {
  const { re, map } = aliasRegex();
  const t = fold(text);
  // Mensagem inteira = nome da cidade ("Boca Raton", "west palm.") → vale.
  const whole = t.replace(/[\s.!,?]+$/g, "").replace(/^[\s,]+/, "").replace(/\s+/g, " ");
  if (map.has(whole)) return map.get(whole)!;
  re.lastIndex = 0;
  let best: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const key = m[1].replace(/\s+/g, " ");
    const zip = map.get(key);
    if (!zip) continue;
    const before = t.slice(0, m.index);
    const after = t.slice(m.index + m[0].length);
    if (!opts?.anyContext && !PLACE_BEFORE.test(before) && !PLACE_AFTER.test(after)) continue;
    if (key === "boca" && SPANISH_CUE_BEFORE.test(before)) continue;
    // "miami" sozinho é o mais genérico — qualquer outro apelido vence.
    if (best === null || key !== "miami") best = zip;
    if (key !== "miami") break;
  }
  return best;
}

// ─── ZIP em texto livre ──────────────────────────────────────────────────────
// Diferente de extractZip (scheduler.ts), que só olha ENDEREÇOS e por isso
// ignora um "33130" digitado sozinho como resposta ("qual o zip?" → "33130").
// Aqui um token de 5 dígitos vale como ZIP quando: começa por 33 ou 34
// (Flórida, tabela embutida), existe na tabela, não vem colado a "$"/dígitos,
// não é número de apartamento/unidade e não é seguido de um nome de rua
// (número de casa: "33055 SW 12 St", "33055 Southwest 12th Street").
const STREET_WORD_AFTER = /^\s*(?:[nsew]{1,2}\.?\s|(?:north|south|east|west|northwest|northeast|southwest|southeast|norte|sul|leste|oeste)\b|\d+(?:st|nd|rd|th)\b|(?:(?:[a-z'.]+|\d+(?:st|nd|rd|th)?)\s+){0,4}(?:st|street|ave|avenue|blvd|boulevard|dr|drive|rd|road|ln|lane|ct|court|way|ter|terrace|pl|place|hwy|highway|cir|circle|pkwy|parkway|calle|avenida|rua)\b)/i;
const UNIT_BEFORE = /(?:\b(?:apt|apto|apartment|apartamento|unit|unidad|unidade|suite|ste|room|rm|lot|bldg|building)\.?\s*#?\s*|#\s*)$/i;
export function zipsInText(text: string): string[] {
  const t = (text || "").toString();
  const out: string[] = [];
  // Lookahead case-insensitive ("33130 USD", "33150 SQFT"); "ft" só como
  // unidade, nunca "Ft Lauderdale".
  const re = /(?<![\d$,.#-])\b(3[34]\d{3})(?:-\d{4})?\b(?![\d,.]*\s*(?:sq|sf|ft(?!\.?\s*lauderdale)|feet|pies|k\b|dollars|usd))/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const zip = m[1];
    if (UNIT_BEFORE.test(t.slice(0, m.index))) continue; // "apt 33130" = unidade
    if (STREET_WORD_AFTER.test(t.slice(m.index + m[0].length))) continue; // número da casa
    if (!zipTable().has(zip)) continue;
    out.push(zip);
  }
  return out;
}

// O ponto do cliente a partir de um trecho de conversa (texto do CLIENTE, já
// sem o sufixo [SYSTEM:]). Prioridade: ZIP digitado > cidade/bairro citado.
// O ÚLTIMO ZIP do texto vence (a menção mais recente é a do imóvel atual).
export function locationFromText(text: string): GeoPoint | null {
  const zips = zipsInText(text);
  if (zips.length > 0) {
    const p = zipCentroid(zips[zips.length - 1]);
    if (p) return p;
  }
  const alias = cityAliasZip(text);
  if (alias) {
    const p = zipCentroid(alias);
    // Ponto derivado de CIDADE: o rótulo não carrega o ZIP âncora (é só um
    // representante, não o ZIP do cliente).
    if (p) return { ...p, source: "city", label: `${(p.label ?? "").replace(/\s*\(\d{5}\)$/, "")} area` };
  }
  return null;
}

// O ponto de um ENDEREÇO gravado (booking.address / [BOOK].address).
export function locationFromAddress(address: string | null | undefined): GeoPoint | null {
  const a = (address ?? "").toString();
  if (!a.trim()) return null;
  const zips = zipsInText(a);
  if (zips.length > 0) {
    const p = zipCentroid(zips[zips.length - 1]);
    if (p) return { ...p, source: "address" };
  }
  // Endereço gravado sem ZIP: é texto estruturado (não conversa), então a
  // cidade vale sem preposição ("123 Main St, Boynton Beach FL").
  const alias = cityAliasZip(a, { anyContext: true });
  if (alias) {
    const p = zipCentroid(alias);
    if (p) return { ...p, source: "city", label: `${(p.label ?? "").replace(/\s*\(\d{5}\)$/, "")} area` };
  }
  return null;
}

// ─── Geometria ───────────────────────────────────────────────────────────────
const R_KM = 6371;
const toRad = (d: number) => (d * Math.PI) / 180;

export function haversineKm(a: GeoPoint, b: GeoPoint): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

// Rumo (0-360) de a para b — usado para detectar "foi e voltou" na rota.
export function bearingDeg(a: GeoPoint, b: GeoPoint): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lng - a.lng);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

// Menor ângulo entre dois rumos (0-180).
export function turnAngleDeg(b1: number, b2: number): number {
  const d = Math.abs(b1 - b2) % 360;
  return d > 180 ? 360 - d : d;
}

export const geoKey = (p: GeoPoint) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
