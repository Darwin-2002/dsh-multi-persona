// 校验打出来的 npm 包：清单能解析、文件齐、元数据适合分发、patch 指向自己。
// 用法：node verify-pack.mjs <解包后的 package 目录>
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) {
  console.error("usage: node verify-pack.mjs <package dir>");
  process.exit(2);
}

let failed = 0;
const check = (ok, label, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const read = (rel) => readFileSync(join(root, rel));
const hasBom = (buf) => buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;

for (const rel of [
  "package.json", "index.js", "client.js", "cordis.patch.yml",
  "icon.svg", "README.md", "locale/zh.json", "locale/en.json",
  "examples/sample/persona.json", "examples/sample/prompt.md",
]) {
  check(existsSync(join(root, rel)), `含文件 ${rel}`);
}

check(!hasBom(read("package.json")), "package.json 无 BOM");
check(!hasBom(read("cordis.patch.yml")), "cordis.patch.yml 无 BOM");

const pkg = JSON.parse(read("package.json").toString("utf8"));
check(pkg.name === "dsh-multi-persona", "包名", pkg.name);
check(
  Array.isArray(pkg.formerNames) && pkg.formerNames.includes("dsh-persona-router"),
  "formerNames 记着旧名（代码里仍是 persona-router 前缀）",
  JSON.stringify(pkg.formerNames),
);
check(/^\d+\.\d+\.\d+/.test(pkg.version ?? ""), "版本号", String(pkg.version));
check(pkg.private === undefined, "已去掉 private（否则 npm 拒发）");
check(pkg.license === "MIT", "license", String(pkg.license));
check(pkg.type === "module", "type=module");
check(typeof pkg.main === "string" && existsSync(join(root, pkg.main)), "main 指向真实文件", String(pkg.main));
check(Boolean(pkg.exports?.["./client"]), "exports 暴露 ./client");
check(Array.isArray(pkg.files) && pkg.files.includes("cordis.patch.yml"), "files 含 cordis.patch.yml");
const peers = pkg.peerDependencies ?? {};
check(peers["@deepseek-ai/cordis"] !== undefined, "peerDependencies: cordis", peers["@deepseek-ai/cordis"]);
check(peers.react !== undefined, "peerDependencies: react", peers.react);
check(pkg.dsh?.bundle?.patch === "./cordis.patch.yml", "dsh.bundle.patch", String(pkg.dsh?.bundle?.patch));
check(pkg.dsh?.client?.platform === "web", "dsh.client.platform=web");
check(pkg.dsh?.client?.immediately === true, "dsh.client.immediately");
check(existsSync(join(root, "examples", "sample")), "自带 examples/sample 模板");

const patch = read("cordis.patch.yml").toString("utf8");
check(patch.includes(`name: ${pkg.name}`), "patch 里声明了本包", pkg.name);

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
