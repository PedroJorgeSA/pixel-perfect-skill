#!/usr/bin/env node
// Modo sem MCP — referência do Figma a partir do que o browser mostra.
// Quando o Figma MCP não tem acesso ao arquivo (assento View, outra organização),
// a fonte da verdade vira o protótipo/canvas visto no browser. Este script
// transforma essas capturas em algo verificável:
//
//   stitch   — costura capturas sobrepostas do protótipo (scroll vertical) numa
//              imagem só, recorta a moldura escura e confere a altura esperada
//   sections — diff por seção (retângulos do Figma em docs/design/spec.json)
//              entre a referência costurada e a captura do site
//   texts    — camada 2 sem MCP: cada nó de texto já extraído do Figma × estilo
//              computado no site (família, tamanho, peso, tracking, posição)
//   sample   — amostra cores em pontos da referência e aponta o color style
//              oficial mais próximo (ΔE) — para confirmar cor sem a API
//   resize   — redimensiona uma imagem para a largura da referência
//
// Exemplos:
//   node figref.mjs stitch   --dir .pixel/figma-tiles --out .pixel/ref/landing-800.png --frame-width 1440 --frame-height 8282
//   node figref.mjs resize   --in .pixel/site-1440.png --width 800 --out .pixel/site-800.png
//   node figref.mjs sections --ref .pixel/ref/landing-800.png --actual .pixel/site-800.png --spec docs/design/spec.json --out .pixel/sections
//   node figref.mjs sample   --img .pixel/ref/landing-800.png --points "120,60;400,700" [--scale 0.5556]
//
// Limites (diga no relatório): a referência vem de um PNG/JPEG da tela, em escala
// < 1 (largura do painel), com compressão. Serve para layout, ordem, cores
// chapadas e presença de elementos — não para tipografia fina (use a camada 2
// com valores de docs/design/*.json) nem para antialias.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(join(process.cwd(), "package.json"));
const sharp = require("sharp");
// PIXEL_CONFIG aponta outro config.json (ex.: um dos examples/).
const cfg = JSON.parse(readFileSync(process.env.PIXEL_CONFIG ?? join(HERE, "../config.json"), "utf8"));
const [cmd, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith("--")) continue;
  const k = rest[i].slice(2);
  opt[k] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
}
const die = (m) => {
  console.error(`figref: ${m}`);
  process.exit(2);
};
const ensureDir = (f) => mkdirSync(dirname(resolve(f)), { recursive: true });
const raw = async (img) => {
  const { data, info } = await sharp(img).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height };
};

// ---------------------------------------------------------------- stitch
// Moldura: a cor do canto (0,0) é o fundo do visualizador; o conteúdo é o maior
// retângulo que difere dela. Offsets: para cada par de capturas, o deslocamento
// vertical que minimiza a diferença média na sobreposição.
async function stitch() {
  const files = opt.tiles
    ? String(opt.tiles).split(",")
    : opt.dir
      ? readdirSync(opt.dir)
          .filter((f) => /\.(png|jpe?g)$/i.test(f))
          .sort()
          .map((f) => join(opt.dir, f))
      : die("stitch precisa de --dir ou --tiles");
  if (!opt.out) die("stitch precisa de --out");
  const first = await raw(files[0]);
  const at = (img, x, y) => {
    const i = (y * img.w + x) * 3;
    return [img.data[i], img.data[i + 1], img.data[i + 2]];
  };
  const bg = at(first, 0, 0);
  const isBg = (p) => Math.abs(p[0] - bg[0]) + Math.abs(p[1] - bg[1]) + Math.abs(p[2] - bg[2]) < 12;
  // linha/coluna é conteúdo quando a maioria das amostras foge do fundo (JPEG suja as bordas)
  const rowHas = (img, y) => {
    let n = 0;
    let hit = 0;
    for (let x = 0; x < img.w; x += 4, n++) if (!isBg(at(img, x, y))) hit++;
    return hit > n / 2;
  };
  const colHas = (img, x, y0, y1) => {
    let n = 0;
    let hit = 0;
    for (let y = y0; y < y1; y += 4, n++) if (!isBg(at(img, x, y))) hit++;
    return hit > n / 2;
  };
  let top = 0;
  while (top < first.h && !rowHas(first, top)) top++;
  let bottom = first.h - 1;
  while (bottom > top && !rowHas(first, bottom)) bottom--;
  let left = 0;
  while (left < first.w && !colHas(first, left, top, bottom)) left++;
  let right = first.w - 1;
  while (right > left && !colHas(first, right, top, bottom)) right--;
  // moldura lateral: no JPEG a coluna da borda mistura moldura e conteúdo. Só apara
  // quando ela destoa da vizinha interna bem mais do que o conteúdo varia (PNG não apara).
  const colDiff = (x1, x2) => {
    let d = 0;
    let n = 0;
    for (let y = top; y <= bottom; y += 4, n++) {
      const p = at(first, x1, y);
      const q = at(first, x2, y);
      d += Math.abs(p[0] - q[0]) + Math.abs(p[1] - q[1]) + Math.abs(p[2] - q[2]);
    }
    return d / n;
  };
  if (left > 0 && colDiff(left, left + 1) > 2 * colDiff(left + 1, left + 2) + 8) left += 1;
  if (right < first.w - 1 && colDiff(right, right - 1) > 2 * colDiff(right - 1, right - 2) + 8) right -= 1;
  // 3px de margem: as linhas de transição do JPEG misturam moldura e conteúdo
  top += 3;
  bottom -= 3;
  const box = { left, top, width: right - left + 1, height: bottom - top + 1 };
  const tiles = [];
  for (const f of files) {
    const buf = await sharp(f).extract(box).toBuffer();
    tiles.push({ f, buf, ...(await raw(buf)) });
  }
  const gray = (t, x, y) => {
    const i = (y * t.w + x) * 3;
    return (t.data[i] * 3 + t.data[i + 1] * 6 + t.data[i + 2]) / 10;
  };
  const minOverlap = Number(opt["min-overlap"] ?? 40);
  const offsets = [0];
  const report = [];
  for (let k = 1; k < tiles.length; k++) {
    const a = tiles[k - 1];
    const b = tiles[k];
    const errAt = (dy) => {
      let sum = 0;
      let n = 0;
      for (let y = dy; y < a.h; y += 3)
        for (let x = 0; x < a.w; x += 5) {
          sum += Math.abs(gray(a, x, y) - gray(b, x, y - dy));
          n++;
        }
      return sum / n;
    };
    let best = { dy: 0, err: Infinity };
    for (let dy = 0; dy <= a.h - minOverlap; dy++) {
      const err = errAt(dy);
      if (err < best.err) best = { dy, err };
    }
    // o scroll anda em fração de pixel (ex.: 265,6): parábola nos vizinhos dá o
    // deslocamento subpixel; sem isso a soma dos arredondamentos encurta a imagem
    let frac = 0;
    if (best.dy > 0 && best.dy < a.h - minOverlap) {
      const e0 = errAt(best.dy - 1);
      const e2 = errAt(best.dy + 1);
      const den = e0 - 2 * best.err + e2;
      if (den > 0) frac = Math.max(-0.5, Math.min(0.5, (e0 - e2) / (2 * den)));
    }
    offsets.push(offsets[k - 1] + best.dy + frac);
    report.push({ tile: b.f.split("/").pop(), dy: Number((best.dy + frac).toFixed(2)), err: Number(best.err.toFixed(2)) });
  }
  // as emendas internas usam o recorte com margem; nas pontas do frame devolvemos
  // as 2 linhas cortadas (1ª captura em cima, última embaixo) para a altura bater
  const edge = 2;
  const head = await sharp(files[0]).extract({ ...box, top: box.top - edge, height: edge }).toBuffer();
  const tail = await sharp(files.at(-1)).extract({ ...box, top: box.top + box.height, height: edge }).toBuffer();
  const H = Math.round(offsets.at(-1)) + box.height + edge * 2;
  const composite = [
    { input: head, top: 0, left: 0 },
    ...tiles.map((t, k) => ({ input: t.buf, top: Math.round(offsets[k]) + edge, left: 0 })),
    { input: tail, top: H - edge, left: 0 },
  ];
  let img = sharp({
    create: { width: box.width, height: H, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).composite(composite);
  ensureDir(opt.out);
  await img.png().toFile(opt.out);
  const out = { out: opt.out, box, size: { width: box.width, height: H }, overlaps: report };
  // conferência: proporção do frame do Figma (largura/altura) tem que bater
  if (opt["frame-width"] && opt["frame-height"]) {
    const scale = box.width / Number(opt["frame-width"]);
    const expected = Number(opt["frame-height"]) * scale;
    out.scale = Number(scale.toFixed(5));
    out.expectedHeight = Math.round(expected);
    out.heightDeltaFramePx = Number(((H - expected) / scale).toFixed(1));
  }
  const bad = report.filter((r) => r.err > Number(opt["max-err"] ?? 12));
  if (bad.length) out.warning = `${bad.length} costura(s) com erro alto: confira sobreposição/animação nos blocos ${bad.map((b) => b.tile).join(", ")}`;
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = bad.length || Math.abs(out.heightDeltaFramePx ?? 0) > 8 ? 1 : 0;
}

// ---------------------------------------------------------------- resize
async function resize() {
  if (!opt.in || !opt.out || !opt.width) die("resize precisa de --in, --width e --out");
  ensureDir(opt.out);
  await sharp(opt.in).resize({ width: Number(opt.width), kernel: "lanczos3" }).png().toFile(opt.out);
  const m = await sharp(opt.out).metadata();
  console.log(JSON.stringify({ out: opt.out, width: m.width, height: m.height }));
}

// ---------------------------------------------------------------- sections
// Diff por seção na mesma escala. Saída: tabela + compare.png por seção (Figma | site | diff).
async function sections() {
  if (!opt.ref || !opt.actual || !opt.spec) die("sections precisa de --ref, --actual e --spec");
  const spec = JSON.parse(readFileSync(opt.spec, "utf8"));
  const ref = await raw(opt.ref);
  const act = await raw(opt.actual);
  if (ref.w !== act.w) die(`larguras diferentes: ref ${ref.w} × site ${act.w} (use resize)`);
  const scale = ref.w / spec.size.width;
  const thr = Number(opt.threshold ?? 40); // distância RGB (soma) por pixel
  const shift = Number(opt.shift ?? 1); // px de vizinhança na escala da referência
  const outDir = opt.out ?? ".pixel/sections";
  mkdirSync(outDir, { recursive: true });
  const only = opt.only ? String(opt.only).split(",") : null;
  const rows = [];
  for (const s of spec.sections) {
    if (only && !only.includes(s.name)) continue;
    const y0 = Math.round(s.rect.y * scale);
    let h = Math.round(s.rect.h * scale);
    // arredondamento da escala/costura pode deixar a última seção 1–3px além da imagem
    const room = Math.min(ref.h, act.h) - y0;
    if (h > room && h - room <= 3) h = room;
    const x0 = Math.round(s.rect.x * scale);
    const w = Math.min(Math.round(s.rect.w * scale), ref.w - x0);
    if (y0 + h > ref.h || y0 + h > act.h) {
      rows.push({ section: s.name, node: s.id, status: "fora", note: `site ${act.h}px / ref ${ref.h}px` });
      continue;
    }
    const diff = Buffer.alloc(w * h * 3);
    let bad = 0;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = ((y0 + y) * ref.w + x0 + x) * 3;
        // tolerância de vizinhança: o pixel do Figma casa se algum vizinho (±shift)
        // do site estiver dentro do limiar — tira antialias/escala/JPEG dos contornos
        let d = Infinity;
        for (let dy = -shift; dy <= shift && d > thr; dy++)
          for (let dx = -shift; dx <= shift && d > thr; dx++) {
            const yy = y0 + y + dy;
            const xx = x0 + x + dx;
            if (yy < 0 || xx < 0 || yy >= act.h || xx >= act.w) continue;
            const j = (yy * act.w + xx) * 3;
            d = Math.min(
              d,
              Math.abs(ref.data[i] - act.data[j]) +
                Math.abs(ref.data[i + 1] - act.data[j + 1]) +
                Math.abs(ref.data[i + 2] - act.data[j + 2]),
            );
          }
        const o = (y * w + x) * 3;
        if (d > thr) {
          bad++;
          diff[o] = 230;
          diff[o + 1] = 30;
          diff[o + 2] = 30;
        } else {
          const g = Math.round((act.data[i] + act.data[i + 1] + act.data[i + 2]) / 3 / 1.6 + 96);
          diff[o] = diff[o + 1] = diff[o + 2] = g;
        }
      }
    const pct = (bad / (w * h)) * 100;
    const crop = (img, file) =>
      sharp(img.data, { raw: { width: img.w, height: img.h, channels: 3 } })
        .extract({ left: x0, top: y0, width: w, height: h })
        .png()
        .toBuffer();
    const gap = 8;
    const compare = await sharp({
      create: { width: w * 3 + gap * 2, height: h, channels: 3, background: { r: 35, g: 35, b: 35 } },
    })
      .composite([
        { input: await crop(ref), left: 0, top: 0 },
        { input: await crop(act), left: w + gap, top: 0 },
        { input: await sharp(diff, { raw: { width: w, height: h, channels: 3 } }).png().toBuffer(), left: (w + gap) * 2, top: 0 },
      ])
      .png()
      .toFile(join(outDir, `${s.name}.png`));
    rows.push({ section: s.name, node: s.id, mismatchPct: Number(pct.toFixed(2)), file: join(outDir, `${s.name}.png`) });
  }
  const max = Number(opt.max ?? 3);
  for (const r of rows)
    console.log(
      `${(r.status === "fora" ? "FORA" : r.mismatchPct <= max ? "ok" : "ALTO").padEnd(5)} ${r.section.padEnd(12)} ${String(r.node).padEnd(10)} ${r.mismatchPct ?? "—"}%  ${r.file ?? r.note}`,
    );
  writeFileSync(join(outDir, "report.json"), JSON.stringify({ scale, threshold: thr, shift, rows }, null, 2));
  console.log(`\nescala ${scale.toFixed(4)} · limiar ${thr} · vizinhança ±${shift}px · teto informativo ${max}% (referência de tela: leia os compare.png antes de concluir)`);
}

// ---------------------------------------------------------------- sample
// Cor em pontos da referência (média 5×5) → color style oficial mais próximo.
async function sample() {
  if (!opt.img || !opt.points) die("sample precisa de --img e --points 'x,y;x,y'");
  const styles = Object.entries(cfg.figmaStyles ?? {}).map(([name, hex]) => ({ name, hex }));
  const img = await raw(opt.img);
  const scale = Number(opt.scale ?? 1);
  const hex = (c) => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  for (const p of String(opt.points).split(";")) {
    const [fx, fy] = p.split(",").map(Number);
    const x = Math.round(fx * scale);
    const y = Math.round(fy * scale);
    const acc = [0, 0, 0];
    let n = 0;
    for (let dy = -2; dy <= 2; dy++)
      for (let dx = -2; dx <= 2; dx++) {
        const xx = Math.min(img.w - 1, Math.max(0, x + dx));
        const yy = Math.min(img.h - 1, Math.max(0, y + dy));
        const i = (yy * img.w + xx) * 3;
        acc[0] += img.data[i];
        acc[1] += img.data[i + 1];
        acc[2] += img.data[i + 2];
        n++;
      }
    const c = acc.map((v) => v / n);
    const near = styles
      .map((s) => ({ ...s, d: Math.hypot(...rgb(s.hex).map((v, k) => v - c[k])) }))
      .sort((a, b) => a.d - b.d)[0];
    console.log(
      `${p.padEnd(12)} ${hex(c)}  →  ${near ? `${near.name} ${near.hex} (Δ ${near.d.toFixed(1)}${near.d > 12 ? " — não é style: foto/gradiente ou cor fora da paleta" : ""})` : "sem figmaStyles no config"}`,
    );
  }
}

// ---------------------------------------------------------------- texts
// Camada 2 sem MCP: todo nó de texto já extraído do Figma (docs/design/*.json,
// com fonte/tamanho/peso/tracking/rect) é casado pelo texto com o elemento visível
// do site e comparado no estilo computado. Tipografia diverge → FALHA;
// posição/largura fora da tolerância → aviso; texto não achado → copy (CMS mudou?).
//   node figref.mjs texts --url http://localhost:5173/ --spec docs/design/design-spec-full.json [--width 1440] [--json out.json]
async function texts() {
  if (!opt.url || !opt.spec) die("texts precisa de --url e --spec");
  const { openPage, navigate } = await import("./lib/browser.mjs");
  const spec = JSON.parse(readFileSync(opt.spec, "utf8"));
  const nodes = [];
  (function walk(o) {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== "object") return;
    if (typeof o.text === "string" && o.font && (o.size ?? o.fontSize) && o.rect) nodes.push(o);
    Object.values(o).forEach(walk);
  })(spec);
  const width = Number(opt.width ?? spec.size?.width ?? 1440);
  const page = await openPage({ width, height: 900, mobile: false });
  try {
    await navigate(page, opt.url, { timeout: 45000 });
    await page.evaluate(`(async () => {
      const s = document.createElement('style');
      s.textContent = '*,*::before,*::after{transition:none!important;animation:none!important;content-visibility:visible!important}';
      document.head.appendChild(s);
      for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight * 0.8) { scrollTo(0, y); await new Promise(r => setTimeout(r, 80)); }
      scrollTo(0, 0);
      await document.fonts.ready;
      await new Promise(r => setTimeout(r, 800));
    })()`);
    const wanted = nodes.map((n) => ({ id: n.id, text: n.text, x: n.rect.x, y: n.rect.y }));
    const found = await page.evaluate(`(() => {
      // sem espaços e sem caixa: rich text junta linhas sem espaço e o CSS pode usar uppercase
      const norm = (t) => t.replace(/[\\s\\u2028\\u00a0]+/g, '').toLowerCase();
      const visible = (e) => { const r = e.getBoundingClientRect(); if (r.width < 1 || r.height < 1) return false; for (let n = e; n; n = n.parentElement) { const cs = getComputedStyle(n); if (cs.visibility === 'hidden' || cs.display === 'none' || Number(cs.opacity) === 0) return false; } return true; };
      const all = [...document.body.querySelectorAll('*')].filter(e => !['SCRIPT','STYLE','svg','path'].includes(e.tagName));
      return ${JSON.stringify(wanted)}.map(({ id, text, x, y }) => {
        const t = norm(text);
        // o menor elemento visível cujo texto é exatamente o do nó
        let hits = all.filter(e => norm(e.textContent) === t && visible(e));
        // existe mas está oculto (reveal no scroll, estado não ativo): não é copy ausente
        if (!hits.length && all.some(e => norm(e.textContent) === t)) return { id, hidden: true };
        hits = hits.filter(e => !hits.some(o => o !== e && e.contains(o)));
        // mesmo texto em vários lugares (o mesmo rótulo no hero, nas abas e na vitrine):
        // fica a ocorrência mais perto do retângulo do nó no frame
        const dist = (e) => { const r = e.getBoundingClientRect(); return Math.hypot(r.left + scrollX - x, r.top + scrollY - y); };
        hits.sort((a, b) => dist(a) - dist(b));
        const e = hits[0];
        if (!e) return { id, missing: true };
        // estilo do texto: o primeiro descendente com texto direto (rich text aninha spans)
        let s = e; const tw = document.createTreeWalker(e, NodeFilter.SHOW_TEXT); let tn; while ((tn = tw.nextNode())) { if (tn.textContent.trim()) { s = tn.parentElement; break; } }
        const cs = getComputedStyle(s); const r = e.getBoundingClientRect();
        // x e largura do TEXTO (Range), não da caixa: pílula/botão têm padding e
        // li/p em bloco ocupam a coluna — a caixa de texto do Figma é a do texto
        const range = document.createRange(); range.selectNodeContents(e);
        const rects = [...range.getClientRects()].filter(q => q.width > 0.5);
        const tl = rects.length ? Math.min(...rects.map(q => q.left)) : r.left;
        const tr = rects.length ? Math.max(...rects.map(q => q.right)) : r.right;
        return { id, n: hits.length, family: cs.fontFamily.split(',')[0].replace(/"/g, ''), size: parseFloat(cs.fontSize), weight: Number(cs.fontWeight), ls: cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing), x: tl + scrollX, y: r.top + scrollY, w: tr - tl };
      });
    })()`);
    const rows = [];
    for (const n of nodes) {
      const f = found.find((x) => x.id === n.id);
      const size = n.size ?? n.fontSize;
      const exp = {
        // config.font.figmaFamily: como o nome do Figma vira font-family no CSS.
        // "{family}" e "{style0}" (1ª palavra do estilo: "Standard Medium" → "Standard").
        family: (cfg.font?.figmaFamily ?? "{family}")
          .replace("{family}", n.font.family ?? "")
          .replace("{style0}", (n.font.style ?? "").split(" ")[0]),
        size,
        weight: typeof n.weight === "number" ? n.weight : null,
        ls: n.letterSpacing?.units === "PERCENT" ? (n.letterSpacing.value / 100) * size : (n.letterSpacing?.value ?? 0),
      };
      const label = JSON.stringify(n.text.replace(/\s+/g, " ").trim().slice(0, 34));
      if (f?.hidden) {
        rows.push({ id: n.id, text: label, status: "oculto", issues: ["existe no DOM, mas invisível na captura (reveal/estado): confira com a interação"] });
        continue;
      }
      if (!f || f.missing) {
        rows.push({ id: n.id, text: label, status: "copy", issues: ["texto não encontrado no site (copy do CMS diferente ou estado não exibido)"] });
        continue;
      }
      const issues = [];
      const warn = [];
      // Régua honesta: a spec guarda UM estilo por nó.
      //  - instância escalada no Figma: fontSize é o nominal (caixa < 0,9 × tamanho por linha)
      //  - texto com quebra (\n) ou peso "mixed": vários estilos no mesmo nó
      // Nesses casos só família (e peso, se único) valem; tamanho/tracking viram nota.
      const lines = (n.text.match(/\n/g) || []).length + 1;
      const scaled = n.rect.h / (size * lines) < 0.9;
      const mixed = lines > 1 || n.weight === "mixed";
      if (scaled) warn.push(`instância escalada (caixa ${n.rect.h}px p/ ${size.toFixed(1)}px): tamanho/tracking não comparados`);
      else if (mixed) warn.push("estilos mistos no nó: tamanho/tracking não comparados");
      if (exp.family !== f.family && !(opt["family-map"] && JSON.parse(opt["family-map"])[exp.family] === f.family))
        issues.push(`família ${f.family} ≠ ${exp.family}`);
      if (!scaled && !mixed && Math.abs(f.size - exp.size) > 0.5) issues.push(`tamanho ${f.size.toFixed(2)} ≠ ${exp.size.toFixed(2)}`);
      if (exp.weight != null && f.weight !== exp.weight) issues.push(`peso ${f.weight} ≠ ${exp.weight}`);
      if (!scaled && !mixed && Math.abs(f.ls - exp.ls) > 0.15) issues.push(`tracking ${f.ls.toFixed(2)} ≠ ${exp.ls.toFixed(2)}px`);
      const tol = Number(opt.tol ?? 4);
      // alinhamento do nó: centro/direita do texto, não a borda esquerda da caixa
      const ax = n.align === "CENTER" ? [f.x + f.w / 2, n.rect.x + n.rect.w / 2, "centro x"] : n.align === "RIGHT" ? [f.x + f.w, n.rect.x + n.rect.w, "direita"] : [f.x, n.rect.x, "x"];
      if (Math.abs(ax[0] - ax[1]) > tol) warn.push(`${ax[2]} ${ax[0].toFixed(1)} ≠ ${ax[1].toFixed(1)}`);
      if (Math.abs(f.y - n.rect.y) > tol * 2) warn.push(`y ${f.y.toFixed(1)} ≠ ${n.rect.y}`);
      // caixa de texto do Figma costuma ser fixa: texto menor é normal; maior quer dizer
      // que no Figma ele quebraria (ou a caixa é outra) — só isso vira aviso
      if (f.w > n.rect.w + tol * 2) warn.push(`texto ${f.w.toFixed(1)}px > caixa do Figma ${n.rect.w}px (quebra diferente?)`);
      rows.push({
        id: n.id,
        text: label,
        status: issues.length ? "falha" : warn.length ? "aviso" : "ok",
        issues: [...issues, ...warn],
        site: { family: f.family, size: f.size, weight: f.weight, ls: f.ls, x: f.x, y: f.y, w: f.w },
        figma: { ...exp, rect: n.rect },
      });
    }
    const pad = (s, k) => String(s).padEnd(k);
    for (const r of rows.filter((r) => r.status !== "ok" || opt.verbose))
      console.log(`${pad(r.status === "falha" ? "FALHA" : r.status === "aviso" ? "aviso" : r.status === "copy" ? "copy" : r.status === "oculto" ? "oculto" : "ok", 6)} ${pad(r.id, 10)} ${pad(r.text, 38)} ${r.issues.join(" · ")}`);
    const c = (s) => rows.filter((r) => r.status === s).length;
    console.log(`\n${rows.length} nós de texto · ok ${c("ok")} · falha ${c("falha")} (tipografia) · aviso ${c("aviso")} (posição) · copy ${c("copy")} (não encontrado) · oculto ${c("oculto")}`);
    if (opt.json) {
      ensureDir(opt.json);
      writeFileSync(opt.json, JSON.stringify(rows, null, 2));
    }
    process.exitCode = c("falha") ? 1 : 0;
  } finally {
    page.close();
  }
}

const cmds = { stitch, resize, sections, sample, texts };
if (!cmds[cmd]) die(`comando desconhecido: ${cmd ?? "(vazio)"} — use ${Object.keys(cmds).join(" | ")}`);
await cmds[cmd]();
