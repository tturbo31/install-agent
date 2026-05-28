// Product image URLs stored in Supabase Storage bucket "product-images"
// Path format: product-images/collection/color-name/1.jpg

const BASE = "https://xmgwuvkbhflyiuclgszl.supabase.co/storage/v1/object/public/product-images";

// Returns up to 3 public image URLs for a given color/collection name
// Keys are lowercase. Add the Supabase Storage URLs when images are uploaded.
export const PRODUCT_IMAGES: Record<string, string[]> = {
  // ── Blue Armor ──────────────────────────────────────────────────────────
  "forged brown": [
    `${BASE}/blue-armor/forged-brown/1.jpg`,
    `${BASE}/blue-armor/forged-brown/2.jpg`,
  ],
  "drawbridge wood": [
    `${BASE}/blue-armor/drawbridge-wood/1.jpg`,
    `${BASE}/blue-armor/drawbridge-wood/2.jpg`,
  ],
  "grey shield": [
    `${BASE}/blue-armor/grey-shield/1.jpg`,
    `${BASE}/blue-armor/grey-shield/2.jpg`,
  ],
  "petrified oak": [
    `${BASE}/blue-armor/petrified-oak/1.jpg`,
    `${BASE}/blue-armor/petrified-oak/2.jpg`,
  ],
  "fortified wood": [
    `${BASE}/blue-armor/fortified-wood/1.jpg`,
    `${BASE}/blue-armor/fortified-wood/2.jpg`,
  ],
  "winter keep": [
    `${BASE}/blue-armor/winter-keep/1.jpg`,
    `${BASE}/blue-armor/winter-keep/2.jpg`,
  ],
  "white knight": [
    `${BASE}/blue-armor/white-knight/1.jpg`,
    `${BASE}/blue-armor/white-knight/2.jpg`,
  ],

  // ── CPF Spirit XL ───────────────────────────────────────────────────────
  "creme brulee": [
    `${BASE}/cpf-spirit-xl/creme-brulee/1.jpg`,
    `${BASE}/cpf-spirit-xl/creme-brulee/2.jpg`,
  ],
  "blass gray": [
    `${BASE}/cpf-spirit-xl/blass-gray/1.jpg`,
    `${BASE}/cpf-spirit-xl/blass-gray/2.jpg`,
  ],
  "balanced oak": [
    `${BASE}/cpf-spirit-xl/balanced-oak/1.jpg`,
    `${BASE}/cpf-spirit-xl/balanced-oak/2.jpg`,
  ],
  "cerise": [
    `${BASE}/cpf-spirit-xl/cerise/1.jpg`,
    `${BASE}/cpf-spirit-xl/cerise/2.jpg`,
  ],
  "slate": [
    `${BASE}/cpf-spirit-xl/slate/1.jpg`,
    `${BASE}/cpf-spirit-xl/slate/2.jpg`,
  ],
  "plata oak": [
    `${BASE}/cpf-spirit-xl/plata-oak/1.jpg`,
    `${BASE}/cpf-spirit-xl/plata-oak/2.jpg`,
  ],
  "coffee cream": [
    `${BASE}/cpf-spirit-xl/coffee-cream/1.jpg`,
    `${BASE}/cpf-spirit-xl/coffee-cream/2.jpg`,
  ],
  "perla": [
    `${BASE}/cpf-spirit-xl/perla/1.jpg`,
    `${BASE}/cpf-spirit-xl/perla/2.jpg`,
  ],
  "rouge oak": [
    `${BASE}/cpf-spirit-xl/rouge-oak/1.jpg`,
    `${BASE}/cpf-spirit-xl/rouge-oak/2.jpg`,
  ],
  "clear pecan": [
    `${BASE}/cpf-spirit-xl/clear-pecan/1.jpg`,
    `${BASE}/cpf-spirit-xl/clear-pecan/2.jpg`,
  ],
  "cappuccino oak": [
    `${BASE}/cpf-spirit-xl/cappuccino-oak/1.jpg`,
    `${BASE}/cpf-spirit-xl/cappuccino-oak/2.jpg`,
  ],

  // ── Apres ───────────────────────────────────────────────────────────────
  "latte": [
    `${BASE}/apres/latte/1.jpg`,
    `${BASE}/apres/latte/2.jpg`,
  ],
  "galao": [
    `${BASE}/apres/galao/1.jpg`,
    `${BASE}/apres/galao/2.jpg`,
  ],
  "macchiato": [
    `${BASE}/apres/macchiato/1.jpg`,
    `${BASE}/apres/macchiato/2.jpg`,
  ],
  "panna": [
    `${BASE}/apres/panna/1.jpg`,
    `${BASE}/apres/panna/2.jpg`,
  ],
  "mocha": [
    `${BASE}/apres/mocha/1.jpg`,
    `${BASE}/apres/mocha/2.jpg`,
  ],
  "caramel": [
    `${BASE}/apres/caramel/1.jpg`,
    `${BASE}/apres/caramel/2.jpg`,
  ],
  "irish": [
    `${BASE}/apres/irish/1.jpg`,
    `${BASE}/apres/irish/2.jpg`,
  ],
  "espresso": [
    `${BASE}/apres/espresso/1.jpg`,
    `${BASE}/apres/espresso/2.jpg`,
  ],

  // ── Whisper Woods Lite ──────────────────────────────────────────────────
  "coastal mist": [
    `${BASE}/whisper-woods-lite/coastal-mist/1.jpg`,
    `${BASE}/whisper-woods-lite/coastal-mist/2.jpg`,
  ],
  "cenote hickory": [
    `${BASE}/whisper-woods-lite/cenote-hickory/1.jpg`,
    `${BASE}/whisper-woods-lite/cenote-hickory/2.jpg`,
  ],
  "berlin loft": [
    `${BASE}/whisper-woods-lite/berlin-loft/1.jpg`,
    `${BASE}/whisper-woods-lite/berlin-loft/2.jpg`,
  ],
  "oslo ash": [
    `${BASE}/whisper-woods-lite/oslo-ash/1.jpg`,
    `${BASE}/whisper-woods-lite/oslo-ash/2.jpg`,
  ],
  "loire valley": [
    `${BASE}/whisper-woods-lite/loire-valley/1.jpg`,
    `${BASE}/whisper-woods-lite/loire-valley/2.jpg`,
  ],
  "sevilla oak": [
    `${BASE}/whisper-woods-lite/sevilla-oak/1.jpg`,
    `${BASE}/whisper-woods-lite/sevilla-oak/2.jpg`,
  ],
  "nordic shadow": [
    `${BASE}/whisper-woods-lite/nordic-shadow/1.jpg`,
    `${BASE}/whisper-woods-lite/nordic-shadow/2.jpg`,
  ],
  "madagascar oak": [
    `${BASE}/whisper-woods-lite/madagascar-oak/1.jpg`,
    `${BASE}/whisper-woods-lite/madagascar-oak/2.jpg`,
  ],
  "bordeaux wine": [
    `${BASE}/whisper-woods-lite/bordeaux-wine/1.jpg`,
    `${BASE}/whisper-woods-lite/bordeaux-wine/2.jpg`,
  ],

  // ── Iris 8mm ────────────────────────────────────────────────────────────
  "pacific dune": [
    `${BASE}/iris-8mm/pacific-dune/1.jpg`,
    `${BASE}/iris-8mm/pacific-dune/2.jpg`,
  ],
  "harvest": [
    `${BASE}/iris-8mm/harvest/1.jpg`,
    `${BASE}/iris-8mm/harvest/2.jpg`,
  ],
  "palm coast": [
    `${BASE}/iris-8mm/palm-coast/1.jpg`,
    `${BASE}/iris-8mm/palm-coast/2.jpg`,
  ],
  "sand bar": [
    `${BASE}/iris-8mm/sand-bar/1.jpg`,
    `${BASE}/iris-8mm/sand-bar/2.jpg`,
  ],
  "hill country": [
    `${BASE}/iris-8mm/hill-country/1.jpg`,
    `${BASE}/iris-8mm/hill-country/2.jpg`,
  ],
  "caramel coast": [
    `${BASE}/iris-8mm/caramel-coast/1.jpg`,
    `${BASE}/iris-8mm/caramel-coast/2.jpg`,
  ],

  // ── Decotile ────────────────────────────────────────────────────────────
  "eli": [
    `${BASE}/decotile/eli/1.jpg`,
    `${BASE}/decotile/eli/2.jpg`,
  ],
  "lia": [
    `${BASE}/decotile/lia/1.jpg`,
    `${BASE}/decotile/lia/2.jpg`,
  ],
};

// Looks up images for a comma-separated list of color names
// Returns up to 2 images per color, max 6 images total
export function getProductImages(colorsRaw: string): string[] {
  const colors = colorsRaw
    .split(",")
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);

  const urls: string[] = [];
  for (const color of colors) {
    const imgs = PRODUCT_IMAGES[color] ?? [];
    urls.push(...imgs.slice(0, 2));
    if (urls.length >= 6) break;
  }
  return urls;
}
