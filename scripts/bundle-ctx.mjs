import { readFileSync } from "node:fs";

const text = readFileSync("F:/tmp/main.js", "utf8");
const arg = process.argv[2] ?? "apiV4";
const before = Number(process.argv[3] ?? 2500);
const after = Number(process.argv[4] ?? 200);

let idx = text.indexOf(arg);
let hits = 0;
while (idx !== -1 && hits < 4) {
  const start = Math.max(0, idx - before);
  const end = Math.min(text.length, idx + arg.length + after);
  console.log(`\n##### [${arg}] @${idx} #####`);
  console.log(text.slice(start, end).replace(/\\n/g, " "));
  idx = text.indexOf(arg, idx + 1);
  hits += 1;
}
if (hits === 0) console.log(`未找到 ${arg}`);
