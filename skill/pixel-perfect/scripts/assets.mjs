#!/usr/bin/env node
// Camada A — auditoria estática de assets e de uso de mídia no código.
// Determinística, sem browser: roda no CI antes do build.
//
//   node assets.mjs                 # public/ inteiro + código
//   node assets.mjs --changed       # só assets alterados (git) — ainda reporta órfãos
//   node assets.mjs --base origin/main
//   flags: --json  --strict (avisos reprovam)
//
// Arquivo: tipo real pelos bytes (hero.jpg que é PNG), peso, dimensão, PNG
// opaco, GIF animado, vídeo .mov, MP4 sem faststart, órfãos em public/.
// Código: <video>/<Video> sem poster, autoplay sem muted/playsInline,
// preload="auto", <img>/<picture> de vídeo convertido em GIF.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { checkMediaFile, kb, sniff } from "./lib/media.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = execSync("git rev-parse --show-toplevel").toString().trim();
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const require = createRequire(join(ROOT, "package.json"));
const budgets = JSON.parse(
  readFileSync(val("--budgets") ?? join(HERE, "../perf/budgets.json"), "utf8"),
);
const limits = budgets.assets;

const walk = (p, out = []) => {
  if (!existsSync(p)) return out;
  if (statSync(p).isFile()) {
    out.push(p);
    return out;
  }
  for (const e of readdirSync(p)) walk(join(p, e), out);
  return out;
};
const MEDIA = /\.(png|jpe?g|webp|avif|gif|svg|mp4|m4v|mov|webm)$/i;

// texto onde um asset pode ser referenciado (fonte + conteúdo do CMS)
const codeFiles = walk(join(ROOT, "src")).filter(
  (f) => /\.(tsx?|css)$/.test(f) && !/\.gen\./.test(f),
);
const blockFiles = walk(join(ROOT, ".deco/blocks")).filter((f) => f.endsWith(".json"));
const corpus = [...codeFiles, ...blockFiles].map((f) => readFileSync(f, "utf8")).join("\n");

let changed = null;
if (flag("--changed") || val("--base")) {
  const range = val("--base") ? `$(git merge-base ${val("--base")} HEAD)` : "HEAD";
  changed = new Set(
    execSync(
      `git diff --name-only ${range} -- public src .deco/blocks; git ls-files --others --exclude-standard -- public src .deco/blocks`,
      { cwd: ROOT, shell: "/bin/bash" },
    )
      .toString()
      .split("\n")
      .filter(Boolean)
      .map((f) => join(ROOT, f)),
  );
}

let sharp = null;
try {
  sharp = require("sharp");
} catch {}

const findings = [];
const add = (file, level, rule, msg) =>
  findings.push({ file: relative(ROOT, file), level, rule, msg });

const publicFiles = walk(join(ROOT, "public")).filter((f) => MEDIA.test(f));
let orphanBytes = 0;
const orphans = [];
for (const file of publicFiles) {
  const url = "/" + relative(join(ROOT, "public"), file).split("\\").join("/");
  const bytes = statSync(file).size;
  const referenced = corpus.includes(url) || corpus.includes(encodeURI(url));
  if (!referenced) {
    // caminho montado em runtime (`/figma/products/${id}.jpg`)? então a pasta aparece no código
    const dir = dirname(url) + "/";
    const dynamic =
      corpus.includes(dir + "${") || corpus.includes(dir + '" +') || corpus.includes(dir + "' +");
    if (!dynamic) {
      orphanBytes += bytes;
      orphans.push({ file, bytes });
      continue;
    }
  }
  if (changed && !changed.has(file)) continue;
  const buf = readFileSync(file);
  let meta = null;
  const real = sniff(buf);
  if (sharp && ["png", "jpeg", "webp", "avif", "gif"].includes(real)) {
    try {
      const m = await sharp(buf).metadata();
      meta = { width: m.width, height: m.height, hasAlpha: m.hasAlpha };
      if (real === "png" && m.hasAlpha) {
        const st = await sharp(buf).stats();
        meta.isOpaque = st.isOpaque;
      }
    } catch {}
  }
  for (const f of checkMediaFile({ file, bytes, buf, meta }, limits))
    add(file, f.level, f.rule, f.msg);
}
if (orphanBytes > limits.orphanMaxBytes)
  findings.push({
    file: "public/",
    level: "warn",
    rule: "orphans",
    msg: `${orphans.length} arquivo(s) sem referência em src/ ou .deco/blocks somando ${kb(orphanBytes)} (maiores: ${orphans
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 4)
      .map((o) => `${relative(join(ROOT, "public"), o.file)} ${kb(o.bytes)}`)
      .join(", ")})`,
  });

// ---------- uso de mídia no código ----------
const VIDEO_TAG = /<(video|Video)\b([^>]*)>/gs;
for (const file of codeFiles) {
  if (changed && !changed.has(file)) continue;
  const text = readFileSync(file, "utf8");
  for (const m of text.matchAll(VIDEO_TAG)) {
    const attrs = m[2];
    const line = text.slice(0, m.index).split("\n").length;
    const has = (a) => new RegExp(`\\b${a}\\b`).test(attrs);
    const where = `${relative(ROOT, file)}:${line}`;
    if (m[1] === "video") {
      if (!has("poster")) add(file, "error", "video-poster", `${where} <video> sem poster`);
      // player com controls montado depois de um clique (modal) pode tocar com som;
      // vídeo decorativo (sem controls) com autoPlay e som é bloqueado pelo browser
      if (has("autoPlay") && !has("muted"))
        add(
          file,
          has("controls") ? "warn" : "error",
          "video-autoplay-sound",
          has("controls")
            ? `${where} autoPlay com som e controls: confirme que só monta depois do clique (gesto do usuário)`
            : `${where} autoPlay sem muted`,
        );
      if (has("autoPlay") && !has("playsInline"))
        add(file, "error", "video-playsinline", `${where} autoPlay sem playsInline`);
      if (/preload=["{]?["']?auto/.test(attrs))
        add(file, "error", "video-preload", `${where} preload="auto"`);
    } else if (!has("poster")) add(file, "warn", "video-poster", `${where} <Video> sem poster`);
  }
  if (/\.gif["'`]/.test(text) && /<(img|Image|Picture)\b/.test(text))
    add(
      file,
      "warn",
      "gif-anim",
      `${relative(ROOT, file)} usa GIF em <img> — animação pesa 5–10× mais que <video>`,
    );
}

const count = (l) => findings.filter((f) => f.level === l).length;
if (flag("--json")) console.log(JSON.stringify({ files: publicFiles.length, findings }, null, 2));
else {
  for (const f of findings)
    console.log(
      `${f.level === "error" ? "ERRO " : "aviso"}  ${f.rule.padEnd(20)} ${f.file}  ${f.msg}`,
    );
  console.log(
    `\n${publicFiles.length} asset(s) · ${count("error")} erro(s) · ${count("warn")} aviso(s)${sharp ? "" : " · sharp ausente: sem checagem de dimensão"}`,
  );
}
process.exitCode = count("error") > 0 || (flag("--strict") && count("warn") > 0) ? 1 : 0;
