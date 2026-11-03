import { isFirstContactRejection, isHostileRejection, mentionsRejection, getAIResponse } from "../lib/ai";

const burst = "What is the installation process?\nNo thank you";
const cases: Array<[string, string]> = [
  ["burst joined", burst],
  ["burst + ad tag", "[Client replied to our ad]\nWhat is the installation process?\nNo thank you"],
  ["bubble 1", "What is the installation process?"],
  ["bubble 2", "No thank you"],
  ["Stop", "Stop"],
];
for (const [label, t] of cases) {
  console.log(
    label.padEnd(16),
    "| firstContactRejection=", String(isFirstContactRejection(t)).padEnd(5),
    "| mentionsRejection=", String(mentionsRejection(t)).padEnd(5),
    "| hostile=", String(isHostileRejection(t))
  );
}

// E2E through the real router (zero-token path expected)
(async () => {
  const r = await getAIResponse([
    { role: "user", content: "What is the installation process?" },
    { role: "user", content: "No thank you" },
  ] as any);
  console.log("\nROUTER OUTPUT:", JSON.stringify(r.text), "tokens", r.inputTokens, r.outputTokens);
})();
