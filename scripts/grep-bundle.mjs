// 在官网 JS bundle 里定位接口表（只做只读文本分析）
import { readFileSync } from "node:fs";

const files = ["F:/tmp/main.js", "F:/tmp/975.js"];
const needles = process.argv.slice(2);
const ctx = 700;

for (const f of files) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    continue;
  }
  for (const needle of needles) {
    let idx = text.indexOf(needle);
    let count = 0;
    while (idx !== -1 && count < 3) {
      const start = Math.max(0, idx - ctx);
      const end = Math.min(text.length, idx + needle.length + ctx);
      console.log(`\n===== ${f} @${idx} [${needle}] =====`);
      console.log(text.slice(start, end).replace(/\s+/g, " "));
      idx = text.indexOf(needle, idx + 1);
      count += 1;
    }
  }
}
