#!/usr/bin/env node
// Camada 1 — auditoria estática de tokens.
// Lê os tokens do projeto (config.json → tokens) e aponta cores, tamanhos de
// fonte e raios que deveriam ser token ou que estão fora do Figma. Funciona
// com CSS puro (declarações em src/styles, style={{}} e fill="#…" no TSX) e
// com utilitários arbitrários do Tailwind (text-[#hex], rounded-[13px]…).
//
// De onde vêm os tokens:
//   - toda custom property `--nome: #hex` nos arquivos de tokens.sources
//     (Tailwind v4: `--color-*`, `--text-*`, `--radius-*` no @theme);
//   - tokens.palette: cores do Figma que ainda não viraram variável (hex → nó);
//   - tokens.fontSizes / tokens.radii: escalas em px (null = sem escala, só a camada 2 confere).
//
// Uso:
//   node .claude/skills/pixel-perfect/scripts/audit.mjs            # src/ inteiro
//   node .claude/skills/pixel-perfect/scripts/audit.mjs --changed  # só arquivos alterados e não commitados
//   node .claude/skills/pixel-perfect/scripts/audit.mjs --base origin/main  # alterados no PR (CI)
//   node .claude/skills/pixel-perfect/scripts/audit.mjs src/sections/Hero.tsx
//   flags: --json  --strict (exit 1 também com avisos)  --config <arquivo>  --all-lines
import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = execSync("git rev-parse --show-toplevel").toString().trim();
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : null);
const paths = args.filter(
  (a, i) => !a.startsWith("--") && !["--base", "--config"].includes(args[i - 1]),
);
const config = JSON.parse(readFileSync(val("--config") ?? process.env.PIXEL_CONFIG ?? join(HERE, "../config.json"), "utf8"));
const tk = config.tokens ?? {};
const ignored = (tk.ignore ?? []).map((p) => join(ROOT, p));

// ---------- tokens ----------
const norm = (hex) => {
  let h = hex.toLowerCase().replace("#", "");
  if (h.length === 3 || h.length === 4) h = [...h].map((c) => c + c).join("");
  if (h.length === 6) h += "ff";
  return h;
};
const exts = /\.(tsx?|jsx?|css)$/;
const skip = /(\.gen\.|routeTree|node_modules|\/dist\/)/;
function walk(p, out = []) {
  if (!existsSync(p)) return out;
  if (statSync(p).isFile()) {
    if (exts.test(p) && !skip.test(p)) out.push(p);
    return out;
  }
  for (const e of readdirSync(p)) walk(join(p, e), out);
  return out;
}
const css = (tk.sources ?? ["src/styles/app.css"])
  .flatMap((p) => walk(join(ROOT, p)))
  .filter((f) => f.endsWith(".css"))
  .map((f) => readFileSync(f, "utf8"))
  .join("\n");
const colorTokens = new Map(); // hex8 -> [custom property sem "--"]
for (const [, name, value] of css.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{3,8})\s*;/g)) {
  if (name.startsWith("color-gray-")) continue; // paleta legada do Tailwind, não é do Figma
  const k = norm(value);
  if (!colorTokens.get(k)?.includes(name)) colorTokens.set(k, [...(colorTokens.get(k) ?? []), name]);
}
const palette = new Map(Object.entries(tk.palette ?? {}).map(([h, n]) => [norm(h), n]));
const textTokens = new Map(); // px -> [token names]
for (const [, name, px] of css.matchAll(/--text-([a-z0-9-]+):\s*(\d+(?:\.\d+)?)px\s*;/g)) {
  textTokens.set(px, [...(textTokens.get(px) ?? []), name]);
}
for (const px of tk.fontSizes ?? []) if (!textTokens.has(String(px))) textTokens.set(String(px), []);
const radiusTokens = new Map();
for (const [, name, px] of css.matchAll(/--radius-([a-z0-9-]+):\s*(\d+(?:\.\d+)?)px\s*;/g)) {
  radiusTokens.set(px, name);
}
for (const px of tk.radii ?? []) if (!radiusTokens.has(String(px))) radiusTokens.set(String(px), null);
// classe Tailwind quando o token é --color-x; senão a variável
const colorHint = (util, name) =>
  name.startsWith("color-") ? `${util}-${name.slice(6)}` : `${util}-[var(--${name})]`;

// ---------- arquivos ----------
// --base <ref>: arquivos alterados desde o merge-base com <ref> (uso no CI/PR).
// --changed sozinho só vê o que ainda não foi commitado.
const baseIdx = args.indexOf("--base");
const baseRef = baseIdx >= 0 ? args[baseIdx + 1] : null;
let files;
// linhas alteradas por arquivo (ratchet): com --base, só reprova o que o PR mudou;
// a dívida antiga dos arquivos tocados não trava o PR. --all-lines desliga.
let changedLines = null;
if (flag("--changed") || baseRef) {
  const range = baseRef
    ? execSync(`git merge-base ${baseRef} HEAD`, { cwd: ROOT }).toString().trim()
    : "HEAD";
  const list = execSync(
    `git diff --name-only ${range} -- src; git ls-files --others --exclude-standard -- src`,
    { cwd: ROOT },
  )
    .toString()
    .split("\n")
    .filter(Boolean);
  files = [...new Set(list)]
    .map((f) => join(ROOT, f))
    .filter((f) => existsSync(f) && exts.test(f) && !skip.test(f));
  if (baseRef && !flag("--all-lines")) {
    changedLines = new Map();
    const diff = execSync(`git diff -U0 ${range} -- src`, {
      cwd: ROOT,
      maxBuffer: 64 << 20,
    }).toString();
    let cur = null;
    for (const l of diff.split("\n")) {
      if (l.startsWith("+++ ")) {
        cur = l.startsWith("+++ b/") ? join(ROOT, l.slice(6)) : null;
        if (cur) changedLines.set(cur, new Set());
      } else if (cur && l.startsWith("@@")) {
        const m = /\+(\d+)(?:,(\d+))?/.exec(l);
        const start = Number(m[1]);
        const n = m[2] == null ? 1 : Number(m[2]);
        for (let k = 0; k < n; k++) changedLines.get(cur).add(start + k);
      }
    }
  }
} else {
  files = (paths.length ? paths : ["src"]).flatMap((p) => walk(join(ROOT, p)));
}

files = files.filter((f) => !ignored.some((p) => f.startsWith(p)));

// ---------- regras ----------
const findings = [];
let skippedOld = 0;
const add = (file, line, level, rule, found, hint) => {
  // arquivo novo (não está no diff) conta inteiro; arquivo alterado, só as linhas do diff
  const set = changedLines?.get(file);
  if (set && !set.has(line)) {
    skippedOld++;
    return;
  }
  findings.push({ file: relative(ROOT, file), line, level, rule, found, hint });
};
// cor literal: token existe → aviso com o substituto; paleta do Figma → ok; fora → erro
const checkColor = (file, ln, found, hex, tokenHint) => {
  const names = colorTokens.get(norm(hex));
  if (names) add(file, ln, "warn", "color-token", found, tokenHint(names[0]));
  else if (!palette.has(norm(hex)))
    add(
      file,
      ln,
      "error",
      "color-off-palette",
      found,
      "cor fora da paleta do Figma — conferir o nó (use_figma) e registrar em config.json tokens.palette",
    );
};
const checkSize = (file, ln, found, px, variant = "") => {
  if (!textTokens.size) return; // projeto sem escala tipográfica: só a camada 2 confere
  const names = textTokens.get(px);
  if (names?.length)
    add(file, ln, "warn", "type-token", found, `${variant}text-${names.join(" | text-")} (inclui leading + tracking)`);
  else if (!names) add(file, ln, "error", "type-off-scale", found, `${px}px não existe na escala tipográfica do Figma`);
};
const checkRadius = (file, ln, found, px, prefix = "") => {
  if (!radiusTokens.size) return;
  if (!radiusTokens.has(px))
    add(file, ln, "error", "radius-off-scale", found, `raio ${px}px não existe no Figma (escala: ${[...radiusTokens.keys()].join("/")}px)`);
  else if (radiusTokens.get(px)) add(file, ln, "warn", "radius-token", found, `${prefix}${radiusTokens.get(px)}`);
};

// Tailwind (utilitário arbitrário)
const COLOR_UTIL =
  /\b((?:[a-z]+:)*)(text|bg|border(?:-[trblxy])?|fill|stroke|from|via|to|ring|outline|decoration|divide|placeholder|caret|accent)-\[(?:color:)?(#[0-9a-fA-F]{3,8})\](\/\d+)?/g;
const SIZE_UTIL = /\b((?:[a-z]+:)*)text-\[(\d+(?:\.\d+)?)px\]/g;
const RADIUS_UTIL = /\b((?:[a-z]+:)*)rounded(-[trbl]{1,2}|-[se][se]?)?-\[(\d+(?:\.\d+)?)px\]/g;
const TRACKING_UTIL = /\b((?:[a-z]+:)*)(tracking|leading)-\[[^\]]+\]/g;
// CSS puro e style={{}} / atributos SVG no TSX
const HEX = /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b/g;
const TSX_COLOR =
  /\b(color|background(?:Color)?|border(?:Top|Right|Bottom|Left)?Color|outlineColor|fill|stroke|stopColor|stop-color)\s*[:=]\s*\{?\s*["'`](#[0-9a-fA-F]{3,8})["'`]/g;
const CSS_SIZE = /(?<![-\w])font-size\s*:\s*(\d+(?:\.\d+)?)px/g;
const CSS_RADIUS = /(?<![-\w])border(?:-[a-z]+)?-radius\s*:\s*(\d+(?:\.\d+)?)px/g;

for (const file of files) {
  const isCss = file.endsWith(".css");
  let inComment = false;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((raw, i) => {
    const ln = i + 1;
    if (/audit-ignore/.test(raw)) return;
    let text = raw;
    if (isCss) {
      // tira comentários /* … */ (inclusive de várias linhas)
      let out = "";
      for (let k = 0; k < text.length; ) {
        if (inComment) {
          const end = text.indexOf("*/", k);
          if (end < 0) break;
          inComment = false;
          k = end + 2;
        } else {
          const start = text.indexOf("/*", k);
          if (start < 0) {
            out += text.slice(k);
            break;
          }
          out += text.slice(k, start);
          inComment = true;
          k = start + 2;
        }
      }
      text = out;
      // a parte depois do último "{" é declaração; linha de seletor (termina em ",") não é
      const decl = text.includes("{") ? text.slice(text.lastIndexOf("{") + 1) : text;
      if (!/^\s*--/.test(decl) && !/,\s*$/.test(decl)) {
        for (const m of decl.matchAll(HEX))
          checkColor(file, ln, decl.trim(), m[0], (n) => `var(--${n})`);
        for (const m of decl.matchAll(CSS_SIZE)) checkSize(file, ln, m[0], m[1]);
        for (const m of decl.matchAll(CSS_RADIUS)) checkRadius(file, ln, m[0], m[1], "var(--radius-");
      }
      return;
    }
    for (const m of text.matchAll(TSX_COLOR))
      checkColor(file, ln, m[0], m[2], (n) => `var(--${n})`);
    for (const m of text.matchAll(COLOR_UTIL)) {
      const [, variant, util, hex, alpha] = m;
      checkColor(file, ln, m[0], hex, (n) => `${variant}${colorHint(util, n)}${alpha ?? ""}`);
    }
    for (const m of text.matchAll(SIZE_UTIL)) checkSize(file, ln, m[0], m[2], m[1]);
    for (const m of text.matchAll(RADIUS_UTIL))
      checkRadius(file, ln, m[0], m[3], `${m[1]}rounded${m[2] ?? ""}-`);
    for (const m of text.matchAll(TRACKING_UTIL)) {
      add(file, ln, "info", "type-manual", m[0], "prefira o token text-* (já traz leading/tracking do Figma)");
    }
  });
}

// ---------- saída ----------
const count = (lvl) => findings.filter((f) => f.level === lvl).length;
if (flag("--json")) {
  console.log(JSON.stringify({ files: files.length, findings }, null, 2));
} else {
  // Map.groupBy só existe no Node 21+; sem o fallback a lista sumia e só o resumo aparecia
  const byFile = new Map();
  for (const f of findings.filter((f) => f.level !== "info"))
    byFile.set(f.file, [...(byFile.get(f.file) ?? []), f]);
  for (const [file, list] of byFile) {
    console.log(`\n${file}`);
    for (const f of list) {
      console.log(
        `  ${String(f.line).padStart(4)}  ${f.level === "error" ? "ERRO" : "aviso"}  ${f.found}  →  ${f.hint}`,
      );
    }
  }
  console.log(
    `\n${files.length} arquivo(s) · ${count("error")} erro(s) · ${count("warn")} aviso(s) · ${count("info")} info (tracking/leading manual)${changedLines ? ` · ${skippedOld} achado(s) em linhas não alteradas (dívida antiga, não reprova)` : ""}` +
      ` · tokens: ${colorTokens.size} cor(es) em variável, ${palette.size} na paleta, escala tipográfica ${textTokens.size || "—"}, raios ${radiusTokens.size || "—"}`,
  );
}
process.exitCode = count("error") > 0 || (flag("--strict") && count("warn") > 0) ? 1 : 0;
