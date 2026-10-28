import { readFileSync } from "node:fs";
const text = readFileSync("F:/tmp/main.js", "utf8");
const idx = text.indexOf("modsDelete");
console.log("idx", idx);
if (idx >= 0) {
  const start = Math.max(0, idx - 900);
  const end = Math.min(text.length, idx + 1600);
  process.stdout.write(text.slice(start, end) + "\n");
}
