// 在 app.asar 里按字符串定位片段（asar 内容未压缩，可直接按字节搜）。
// 用法：node asar-scan.mjs <搜索串> [前后各取多少字节]
import { readFileSync } from "node:fs";

const ASAR = "D:\\Users\\Darwin\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar";
const needle = process.argv[2] ?? "OFFICIAL_ON_DEMAND_CATALOG";
const pad = Number(process.argv[3] ?? 700);

const buf = readFileSync(ASAR);
const hay = buf.toString("latin1");
const needleLatin = Buffer.from(needle, "utf8").toString("latin1");

let at = 0;
let hits = 0;
while (true) {
  const i = hay.indexOf(needleLatin, at);
  if (i === -1) break;
  hits += 1;
  const from = Math.max(0, i - pad);
  const to = Math.min(hay.length, i + needleLatin.length + pad);
  const slice = Buffer.from(hay.slice(from, to), "latin1").toString("utf8");
  console.log(`--- hit #${hits} @ byte ${i} ---`);
  console.log(slice.replace(/\0/g, "\u2591"));
  console.log();
  at = i + needleLatin.length;
  if (hits >= 6) break;
}
if (hits === 0) console.log(`no match for ${needle}`);
