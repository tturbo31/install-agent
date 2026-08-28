import { applyPatches } from "./tmp-patch-lib.mjs";
applyPatches([
  {
    file: "src/lib/ai.ts",
    find: String.raw`  return /(?:\bwhat|which)\s+(?:time|day)|\bgood\s+time\b|`,
    replace: String.raw`  // "Soonest" phrases (28/08/2026, caught by route-offer-verify T9): "any day
  // works, whatever is soonest", "asap", "the earliest you have", "today if
  // possible", "lo antes posible", "cuanto antes", "qualquer dia" were NOT
  // counted as engaging scheduling, so the anti-pressure strip deleted the very
  // slot sentence the client asked for and shipped "Does that work, or would
  // you prefer something Tuesday?" with no time in it.
  return /\b(?:asap|as\s+soon\s+as\s+(?:possible|you\s+can)|soonest|earliest|anytime|any\s+(?:time|day|days|hour)|whenever|today|tonight|this\s+week|all\s+week|free\s+(?:all|any|every|this)\b|available\s+(?:all|any|every|this)\b|hoy|hoje|amanh[ãa]|lo\s+antes\s+posible|cuanto\s+antes|cualquier\s+(?:d[ií]a|hora|momento)|qualquer\s+(?:dia|hora|momento)|o\s+quanto\s+antes|esta\s+semana|toda\s+la\s+semana|a\s+semana\s+toda)\b|(?:\bwhat|which)\s+(?:time|day)|\bgood\s+time\b|`,
  },
]);
