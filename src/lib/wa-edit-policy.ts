// Pure policy for EDITED WhatsApp bubbles (no I/O; eval-covered by
// src/evals/wa-edit-verify.ts). The branch itself lives in the WA webhook.
//
// 2026-09-18, Alejandro Trigoso (WA 17864439815): asked for the address with
// the zip code, the client sent "17474 sw 272 st" and 8 seconds later EDITED
// that bubble to "17474 sw 272 st\nHomestead, fl 33031". Z-API delivers an edit
// as a ReceivedCallback with isEdit:true, the ORIGINAL bubble's messageId (plus
// a new editMessageId) and phone = the chat LID ("111952684707921@lid"), not
// the number. The webhook deduped on messageId, so the edit was dropped as a
// repeat: the bot never saw the zip, asked "What's the zip code for that
// address?", and the client, whose phone shows the edited bubble WITH the zip,
// never answered. Sunday 3pm visit lost.
//
// An edit is now stored as a NEW client bubble (instagram_msg_id =
// editMessageId) in the original bubble's conversation and goes through the
// normal flow; the pre-send stale-context guard discards a reply still being
// built on the old text. Once we already answered the original, only an edit
// that brings new information is answered again: a reworded question we
// already answered must not get a second answer (Francis Celis 19/09, "What is
// usually the APR?" → "What is percentage usually the APR?" 7s after our reply).
// Instagram and Messenger never send edit events (0 in 3,284 raw captures).

export type WaEditAction =
  | "ignore" // same text: nothing to do
  | "update-original" // cosmetic edit after our reply: fix the stored bubble, no reply
  | "answer"; // new client bubble through the normal flow

export function isWaEditCallback(body: Record<string, unknown>): boolean {
  return body.isEdit === true;
}

// Id stored for the edit bubble (dedupes Z-API retries of the same edit; each
// new edit of the same bubble carries its own editMessageId).
export function waEditStoreId(body: Record<string, unknown>): string {
  const editId = body.editMessageId;
  if (typeof editId === "string" && editId.trim()) return editId.trim();
  return `${String(body.messageId ?? "")}_edit_${Number(body.momment) || Date.now()}`;
}

// A real WhatsApp number (the edit callback brings the "…@lid" chat id instead).
export function isRealWaPhone(phone: unknown): phone is string {
  return typeof phone === "string" && /^\d{8,15}$/.test(phone);
}

// "wa_17864439815" → "17864439815"; anything else → null.
export function phoneFromWaIgsid(igsid: unknown): string | null {
  const m = typeof igsid === "string" ? /^wa_(\d{8,15})$/.exec(igsid) : null;
  return m ? m[1] : null;
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

const tokens = (s: string) => norm(s).match(/[a-z0-9]+/g) ?? [];

// Words that change what we must do even when the client only swapped one of
// them: day/time, floor type, address parts, a negation or a cancel.
const INFO_WORDS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "mon", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "sat", "sun",
  "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo",
  "segunda", "terca", "quarta", "quinta", "sexta",
  "today", "tomorrow", "tonight", "morning", "afternoon", "evening", "noon",
  "hoy", "manana", "tarde", "noche", "hoje", "amanha", "manha", "noite",
  "am", "pm",
  "january", "february", "march", "april", "may", "june", "july", "august",
  "september", "october", "november", "december",
  "tile", "tiles", "vinyl", "laminate", "hardwood", "wood", "carpet", "stairs", "baseboard", "baseboards",
  "st", "street", "ave", "avenue", "rd", "road", "blvd", "dr", "drive", "ct", "court", "ln", "lane",
  "way", "ter", "terrace", "pl", "place", "cir", "circle", "apt", "unit", "suite", "fl", "florida",
  "cancel", "cancelar",
]);

// "I can do Sunday" → "I can't do Sunday" adds no word token worth a list, so a
// negation is counted on its own.
const NEGATION = /n['’]t\b|\b(?:not|no|never|nao|nunca)\b/g;
const negations = (s: string) => (norm(s).match(NEGATION) ?? []).length;

function lev(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 2) return 3;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

// Did the edit bring information the original bubble did not have?
export function editAddsInfo(original: string, edited: string): boolean {
  if (negations(edited) > negations(original)) return true;
  const before = new Set(tokens(original));
  const added = tokens(edited).filter((t) => !before.has(t));
  if (!added.length) return false;
  // Any new number: zip, house number, phone, sqft, a changed hour.
  if (added.some((t) => /\d/.test(t))) return true;
  if (/\S+@\S+\.\S+/.test(edited) && !/\S+@\S+\.\S+/.test(original)) return true;
  if (added.some((t) => INFO_WORDS.has(t))) return true;
  // Plain words: a typo fix ("yoi" → "you") is not new information; three or
  // more genuinely new words are.
  const fresh = added.filter((t) => ![...before].some((b) => !/\d/.test(b) && lev(t, b) <= (Math.max(t.length, b.length) <= 5 ? 1 : 2)));
  return fresh.length >= 3;
}

export function waEditAction(original: string, edited: string, answeredSinceOriginal: boolean): WaEditAction {
  const squash = (s: string) => norm(s).replace(/\s+/g, " ").trim();
  if (!edited.trim() || squash(edited) === squash(original)) return "ignore";
  // Not answered yet: the edit replaces what the bot would have answered.
  if (!answeredSinceOriginal) return "answer";
  return editAddsInfo(original, edited) ? "answer" : "update-original";
}
