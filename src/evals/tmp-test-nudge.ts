import { adRetapNudge, isJobSeeker } from "../lib/ai";
const hist = [
  { role: "user" as const, content: "[Client replied to our ad]" },
  { role: "assistant" as const, content: "Hi, we work with luxury vinyl, tile, and hardwood flooring, and we have a promotion on each. Which one are you interested in?" },
  { role: "user" as const, content: "[Client replied to our ad]\n\n[SYSTEM: nota]" },
];
console.log("isJobSeeker(placeholder):", isJobSeeker("[Client replied to our ad]"));
console.log("adRetapNudge:", JSON.stringify(adRetapNudge(hist)));
