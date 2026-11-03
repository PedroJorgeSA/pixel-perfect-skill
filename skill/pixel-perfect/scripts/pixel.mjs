#!/usr/bin/env node
// Camadas 2 e 3 — verificação pixel perfect contra o Figma.
// Zero dependências novas: Chrome headless via CDP (WebSocket nativo do Node)
// + sharp (já em node_modules).
//
//   shot   — captura a página (ou um elemento) no viewport do Figma
//   diff   — compara PNG do Figma x captura, gera heatmap + lado a lado + regiões
//   styles — confere estilos computados contra uma spec tirada do get_design_context
//
// Exemplos:
//   node pixel.mjs shot   --url http://localhost:5173/ --width 390 --out .pixel/home-mobile.png
//   node pixel.mjs shot   --url http://localhost:5173/ --width 1440 --selector "footer" --out .pixel/footer.png
//   node pixel.mjs diff   --ref .pixel/ref/home-mobile.png --actual .pixel/home-mobile.png --out .pixel/diff/home-mobile
//   node pixel.mjs styles --spec .pixel/specs/product-card.json
//   node pixel.mjs regress [--only home] [--base http://localhost:5175]
//   node pixel.mjs side   --figma ref.png --before main.png --after branch.png --out .pixel/lado-a-lado.png
//
// Viewports e fonte esperada vêm de ../config.json (ou $PIXEL_CONFIG): viewports, mobileMaxWidth, font.
// Flags de shot/styles: --height (viewport, default = altura do perfil no config.json),
//   --wait ms (default 1500), --hide "sel1,sel2" (visibility:hidden, p/ conteúdo dinâmico),
//   --no-scroll (não rola a página p/ disparar lazy-load)
// Flags de diff: --threshold 0.1 (sensibilidade por pixel, 0–1), --max 2 (% máx. p/ passar),
//   --ignore "y0-y1,y0-y1" (faixas verticais a ignorar, em px)
//   --mask "x,y,w,h;x,y,w,h" (retângulos a ignorar — fotos/copy vindos do CMS, que diferem do mock)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { navigate, openBrowser, openPage } from "./lib/browser.mjs";

// PIXEL_CONFIG aponta outro config.json (ex.: um dos examples/).
const CONFIG = JSON.parse(
  readFileSync(
    process.env.PIXEL_CONFIG ?? join(dirname(fileURLToPath(import.meta.url)), "../config.json"),
    "utf8",
  ),
);
const VP = CONFIG.viewports;
const MOBILE_MAX = CONFIG.mobileMaxWidth ?? 767;
const FONT = CONFIG.font ?? { family: "sans-serif", fallbacks: [], probe: "Aa" };

const require = createRequire(join(process.cwd(), "package.json"));
const [cmd, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith("--")) continue;
  const k = rest[i].slice(2);
  opt[k] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
}
const die = (msg) => {
  console.error(`pixel: ${msg}`);
  process.exit(2);
};
const ensureDir = (file) => mkdirSync(dirname(resolve(file)), { recursive: true });

// content-visibility:auto (seções fora da tela) não é pintado pelo captureBeyondViewport:
// sem forçar visible, a captura de página inteira sai em branco abaixo da dobra.
const FREEZE_CSS = `*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important;content-visibility:visible!important}`;

const t0 = Date.now();
const debug = (step) => process.env.PIXEL_DEBUG && console.error(`[${Date.now() - t0}ms] ${step}`);

async function loadPage(page, { url, wait, hide, scroll }) {
  // o dev server do Vite mantém um WebSocket de HMR aberto, então "load" pode
  // demorar; "networkAlmostIdle" (≤2 conexões) chega antes e é suficiente.
  await navigate(page, url);
  debug("navegou");
  const hideCss = hide ? `${hide}{visibility:hidden!important}` : "";
  await page.evaluate(`(() => {
    const s = document.createElement('style');
    s.textContent = ${JSON.stringify(FREEZE_CSS + hideCss)};
    document.head.appendChild(s);
  })()`);
  if (scroll) {
    // rola até o fim p/ disparar lazy-load / deferred sections, depois volta ao topo
    await page.evaluate(`(async () => {
      const step = innerHeight * 0.8;
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        scrollTo(0, y);
        await new Promise(r => setTimeout(r, 120));
      }
      scrollTo(0, 0);
    })()`);
  }
  debug("scroll ok");
  await page.evaluate(
    `Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 3000); })))`,
  );
  debug("imagens ok");
  await page.evaluate(`document.fonts.ready.then(() => true)`);
  await new Promise((r) => setTimeout(r, wait));
  if (scroll) {
    // 2ª passada: conteúdo trocado depois da hidratação (ex.: Modo Figma)
    // ainda tem imagens lazy que a 1ª passada não alcançou.
    await page.evaluate(`(async () => {
      const step = innerHeight * 0.8;
      for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
        scrollTo(0, y);
        await new Promise(r => setTimeout(r, 80));
      }
      scrollTo(0, 0);
      await Promise.all([...document.images].filter(i => !i.complete).map(i => new Promise(r => { i.onload = i.onerror = r; setTimeout(r, 3000); })));
      await new Promise(r => setTimeout(r, 300));
    })()`);
    debug("2ª passada ok");
  }
}

// A captura de página inteira estica o viewport até a altura do documento:
// elementos fixed fora da tela (drawers, bottom sheets) entram no quadro e
// alturas em vh/svh esticam. Congela o layout do viewport real antes.
const FREEZE_VIEWPORT = `(() => {
  const vh = innerHeight, vw = innerWidth, frozen = { hidden: 0, pinned: 0, heights: 0 };
  const els = [...document.querySelectorAll('body *')];
  const rects = els.map((el) => [el, el.getBoundingClientRect(), getComputedStyle(el)]);
  for (const [el, r, cs] of rects) {
    if (cs.position === 'fixed') {
      const off = r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw || r.width === 0 || r.height === 0;
      if (off || cs.visibility === 'hidden' || Number(cs.opacity) === 0) {
        el.style.setProperty('visibility', 'hidden', 'important');
        frozen.hidden++;
      } else {
        for (const [k, v] of [['position', 'absolute'], ['top', r.top + scrollY + 'px'], ['left', r.left + 'px'], ['bottom', 'auto'], ['right', 'auto'], ['width', r.width + 'px'], ['height', r.height + 'px']])
          el.style.setProperty(k, v, 'important');
        frozen.pinned++;
      }
    } else if (r.height > 0 && Math.abs(r.height - vh) < 2 && cs.position !== 'absolute') {
      el.style.setProperty('height', r.height + 'px', 'important');
      el.style.setProperty('min-height', '0', 'important');
      frozen.heights++;
    }
  }
  return frozen;
})()`;

function viewportFrom(o) {
  const width = Number(o.width ?? VP.desktop.width);
  const mobile = width <= MOBILE_MAX;
  const height = Number(o.height ?? (mobile ? VP.mobile.height : VP.desktop.height));
  return { width, height, mobile };
}

// ---------------------------------------------------------------- shot
async function shot() {
  if (!opt.url || !opt.out) die("shot precisa de --url e --out");
  const vp = viewportFrom(opt);
  const page = await openPage(vp);
  try {
    await loadPage(page, {
      url: opt.url,
      wait: Number(opt.wait ?? 1500),
      hide: opt.hide,
      scroll: !opt["no-scroll"],
    });
    let clip;
    if (opt.selector) {
      clip = await page.evaluate(`(() => {
        const el = document.querySelector(${JSON.stringify(opt.selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.left + scrollX, y: r.top + scrollY, width: r.width, height: r.height };
      })()`);
      if (!clip) die(`seletor não encontrado: ${opt.selector}`);
    } else {
      if (!opt["no-freeze"])
        debug(`freeze ${JSON.stringify(await page.evaluate(FREEZE_VIEWPORT))}`);
      const h = await page.evaluate(
        `Math.max(document.documentElement.scrollHeight, document.body.scrollHeight)`,
      );
      clip = { x: 0, y: 0, width: vp.width, height: h };
    }
    const r = (v) => Math.round(v);
    const { data } = await page.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      clip: { x: r(clip.x), y: r(clip.y), width: r(clip.width), height: r(clip.height), scale: 1 },
    });
    ensureDir(opt.out);
    writeFileSync(opt.out, Buffer.from(data, "base64"));
    const fonts = await page.evaluate(`(async () => {
      const el = document.querySelector(${JSON.stringify(opt.selector ?? "body")}) ?? document.body;
      const fam = getComputedStyle(el).fontFamily;
      const want = ${JSON.stringify(FONT.family)};
      const candidates = [want, ...${JSON.stringify(FONT.fallbacks ?? [])}];
      // webfont: espera as faces carregarem; fonts.check() é true p/ fonte de sistema ausente,
      // então mede contra monospace
      await document.fonts.ready;
      const ctx = document.createElement('canvas').getContext('2d');
      const probe = ${JSON.stringify(FONT.probe ?? "Aa")};
      const w = (f) => { ctx.font = f; return ctx.measureText(probe).width; };
      const has = (f) => w('16px "' + f + '", monospace') !== w('16px monospace');
      const expected = has(want);
      return { family: fam, expected, rendered: candidates.find(has) ?? 'fallback genérico' };
    })()`);
    console.log(
      JSON.stringify(
        {
          out: opt.out,
          viewport: vp,
          size: { width: r(clip.width), height: r(clip.height) },
          fonts,
        },
        null,
        2,
      ),
    );
    if (!fonts.expected)
      console.error(
        `aviso: "${FONT.family}" não carregou nesta página — texto renderiza com ${fonts.rendered}; diffs em áreas de texto são esperados (use \`styles\` p/ validar tipografia).`,
      );
  } finally {
    page.close();
  }
}

// ---------------------------------------------------------------- diff
async function diff() {
  if (!opt.ref || !opt.actual || !opt.out) die("diff precisa de --ref, --actual e --out");
  const sharp = require("sharp");
  const threshold = Number(opt.threshold ?? 0.1);
  const maxPct = Number(opt.max ?? 2);
  const ignore = String(opt.ignore ?? "")
    .split(",")
    .filter(Boolean)
    .map((s) => s.split("-").map(Number));

  const load = async (p) => {
    const img = sharp(p).flatten({ background: "#ffffff" }).ensureAlpha();
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  };
  let ref = await load(opt.ref);
  const act = await load(opt.actual);
  const notes = [];
  if (ref.width !== act.width) {
    notes.push(
      `largura diferente: Figma ${ref.width}px x site ${act.width}px — Figma redimensionado p/ comparar (peça get_screenshot com maxDimension >= maior lado do nó)`,
    );
    const { data, info } = await sharp(opt.ref)
      .flatten({ background: "#ffffff" })
      .resize({ width: act.width })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    ref = { data, width: info.width, height: info.height };
  }
  const W = act.width;
  const H = Math.min(ref.height, act.height);
  if (ref.height !== act.height)
    notes.push(
      `altura diferente: Figma ${ref.height}px x site ${act.height}px (Δ ${act.height - ref.height}px) — comparado só até ${H}px`,
    );

  // delta de cor perceptual (YIQ, mesma métrica do pixelmatch)
  const maxDelta = 35215 * threshold * threshold;
  const out = Buffer.alloc(W * H * 4);
  const rowBad = new Uint32Array(H);
  let bad = 0;
  let considered = 0;
  const masks = String(opt.mask ?? "")
    .split(";")
    .filter(Boolean)
    .map((s) => s.split(",").map(Number));
  const ignored = (y) => ignore.some(([a, b]) => y >= a && y <= b);
  const masked = (x, y) =>
    masks.some(([mx, my, mw, mh]) => x >= mx && x < mx + mw && y >= my && y < my + mh);
  for (let y = 0; y < H; y++) {
    const skipRow = ignored(y);
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const [r1, g1, b1] = [ref.data[i], ref.data[i + 1], ref.data[i + 2]];
      const [r2, g2, b2] = [act.data[i], act.data[i + 1], act.data[i + 2]];
      const dy = (r1 - r2) * 0.29889531 + (g1 - g2) * 0.58662247 + (b1 - b2) * 0.11448223;
      const di = (r1 - r2) * 0.59597799 - (g1 - g2) * 0.2741761 - (b1 - b2) * 0.32180189;
      const dq = (r1 - r2) * 0.21147017 - (g1 - g2) * 0.52261711 + (b1 - b2) * 0.31114694;
      const delta = 0.5053 * dy * dy + 0.299 * di * di + 0.1957 * dq * dq;
      const gray = 255 - 0.1 * (255 - (r2 * 0.299 + g2 * 0.587 + b2 * 0.114));
      if (skipRow || (masks.length && masked(x, y))) {
        out.set([gray, gray, 255, 255], i);
        continue;
      }
      considered++;
      if (delta > maxDelta) {
        bad++;
        rowBad[y]++;
        out.set([255, 0, 0, 255], i);
      } else {
        out.set([gray, gray, gray, 255], i);
      }
    }
  }

  // agrupa linhas com diferença em regiões contíguas
  const regions = [];
  let cur = null;
  for (let y = 0; y < H; y++) {
    const ratio = rowBad[y] / W;
    if (ratio > 0.01) {
      if (cur && y - cur.y1 <= 8) cur.y1 = y;
      else regions.push((cur = { y0: y, y1: y, px: 0 }));
      cur.px += rowBad[y];
    } else if (cur && y - cur.y1 > 8) cur = null;
  }
  for (const r of regions) r.pct = +((100 * r.px) / (W * (r.y1 - r.y0 + 1))).toFixed(1);
  regions.sort((a, b) => b.px - a.px);

  mkdirSync(opt.out, { recursive: true });
  const diffPng = join(opt.out, "diff.png");
  await sharp(out, { raw: { width: W, height: H, channels: 4 } })
    .png()
    .toFile(diffPng);
  const crop = (img) =>
    sharp(img.data, { raw: { width: img.width, height: img.height, channels: 4 } })
      .extract({ left: 0, top: 0, width: W, height: H })
      .png()
      .toBuffer();
  const gap = 16;
  const comparePng = join(opt.out, "compare.png");
  await sharp({ create: { width: W * 3 + gap * 2, height: H, channels: 4, background: "#ff00ff" } })
    .composite([
      { input: await crop(ref), left: 0, top: 0 },
      { input: await crop(act), left: W + gap, top: 0 },
      { input: diffPng, left: (W + gap) * 2, top: 0 },
    ])
    .png()
    .toFile(comparePng);

  const pct = +((100 * bad) / Math.max(considered, 1)).toFixed(2);
  const pass =
    pct <= maxPct && ref.height === act.height && notes.every((n) => !n.startsWith("largura"));
  const report = {
    pass,
    mismatchPct: pct,
    maxPct,
    threshold,
    size: { figma: [ref.width, ref.height], site: [act.width, act.height] },
    notes,
    topRegions: regions
      .slice(0, 12)
      .map(({ y0, y1, pct }) => ({ y: `${y0}-${y1}`, height: y1 - y0 + 1, pct })),
    files: { diff: diffPng, compare: comparePng },
  };
  writeFileSync(join(opt.out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = pass ? 0 : 1;
}

// ---------------------------------------------------------------- styles
// spec: { url, width, height?, hide?, before?, requires?, checks: [{ name, selector, text?, nth?, node?, expect: { "font-size": "14px", ... } }] }
//   text: filtra os elementos do selector cujo texto começa com esse valor
//   node: id do nó no Figma de onde saiu o valor (documentação/rastreio)
const MEASURE = (checks) => `(() => {
  const checks = ${JSON.stringify(checks)};
  const probe = document.createElement('div');
  document.body.appendChild(probe);
  const color = (v) => { probe.style.color = ''; probe.style.color = v; return getComputedStyle(probe).color; };
  const out = checks.map((c) => {
    const els = [...document.querySelectorAll(c.selector)].filter((e) => !c.text || e.textContent.trim().startsWith(c.text));
    const el = els[c.nth ?? 0];
    if (!el) return { ...c, missing: true };
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const got = {};
    for (const k of Object.keys(c.expect)) {
      if (k === 'width') got[k] = r.width + 'px';
      else if (k === 'height') got[k] = r.height + 'px';
      // posição no documento (= x/y do nó dentro do frame da página no Figma).
      // 'top'/'left' continuam sendo as propriedades CSS (left de elementos absolutos).
      else if (k === 'doc-top') got[k] = r.top + scrollY + 'px';
      else if (k === 'doc-left') got[k] = r.left + scrollX + 'px';
      else got[k] = cs.getPropertyValue(k);
    }
    const expectNorm = {};
    for (const [k, v] of Object.entries(c.expect))
      expectNorm[k] = /color|background-color|border-color/.test(k) ? color(v) : String(v);
    return { ...c, got, expectNorm, count: els.length };
  });
  probe.remove();
  return out;
})()`;

function compare(results) {
  const TOL = Number(opt.tolerance ?? 0.5);
  const num = (v) =>
    typeof v === "string" && /^-?[\d.]+px$/.test(v.trim()) ? parseFloat(v) : null;
  // tipografia não tem folga: -0.28px x -0.12px é outro token
  const TYPE_PROPS = /^(font-size|line-height|letter-spacing|font-weight)$/;
  const same = (exp, got, prop) => {
    const tol = TYPE_PROPS.test(prop) ? 0.02 : TOL;
    exp = String(exp).trim();
    got = String(got).trim();
    if (exp === got) return true;
    const a = exp.split(/\s+/);
    const b = got.split(/\s+/);
    if (a.length !== b.length) return false;
    return a.every((x, i) => {
      const nx = num(x);
      const ny = num(b[i]);
      if (nx != null && ny != null) return Math.abs(nx - ny) <= tol;
      return x.replace(/\s/g, "") === b[i].replace(/\s/g, "");
    });
  };
  let fails = 0;
  let missing = 0;
  const rows = [];
  for (const c of results) {
    if (c.missing) {
      fails++;
      missing++;
      rows.push({
        check: c.name,
        prop: "—",
        expected: c.selector,
        got: "ELEMENTO NÃO ENCONTRADO",
        ok: false,
      });
      continue;
    }
    for (const [k, exp] of Object.entries(c.expectNorm)) {
      const ok = same(exp, c.got[k], k);
      if (!ok) fails++;
      rows.push({ check: c.name, prop: k, expected: exp, got: c.got[k], ok });
    }
  }
  return { rows, fails, missing, TOL };
}

const printRows = (rows) => {
  for (const r of rows)
    console.log(
      `${r.ok ? "  ok " : "FALHA"}  ${r.check} · ${r.prop}: esperado ${r.expected} · obtido ${r.got}`,
    );
};

// spec.before: JS executado na página logo antes de medir (ex.: voltar o
// carrossel do hero ao slide 0 — ele troca sozinho a cada 5 s e a medição
// pegaria outro bullet ativo). Espera 300 ms depois.
const runBefore = async (page, spec) => {
  if (!spec.before) return;
  await page.evaluate(`(async () => { ${spec.before} })()`);
  await new Promise((r) => setTimeout(r, Number(spec.beforeWait ?? 300)));
};

async function styles() {
  if (!opt.spec) die("styles precisa de --spec arquivo.json");
  const spec = JSON.parse(readFileSync(opt.spec, "utf8"));
  const vp = viewportFrom({ ...spec, ...opt });
  const page = await openPage(vp);
  let results;
  try {
    await loadPage(page, {
      url: opt.url ?? spec.url,
      wait: Number(opt.wait ?? 1000),
      hide: spec.hide,
      scroll: true,
    });
    await runBefore(page, spec);
    results = await page.evaluate(MEASURE(spec.checks));
  } finally {
    page.close();
  }
  const { rows, fails, TOL } = compare(results);
  printRows(rows);
  console.log(
    `\n${rows.length - fails}/${rows.length} propriedades batem com o Figma (tolerância: ${TOL}px em medidas, 0.02px em tipografia)`,
  );
  if (opt.out) {
    ensureDir(opt.out);
    writeFileSync(opt.out, JSON.stringify(rows, null, 2));
  }
  process.exitCode = fails ? 1 : 0;
}

// ---------------------------------------------------------------- regress
// Roda várias specs com um Chrome só e UMA carga por (url, largura, altura, hide).
//   node pixel.mjs regress [--dir specs/] [--base http://localhost:5173] [--only home,header] [--json out.json]
// --base troca a origem das specs (ex.: outra porta ou um preview).
// Uma spec com todos os elementos ausentes é classificada como INFRA (dados não
// carregaram — ex.: API de catálogo/commerce fora), não como regressão de design.
async function regress() {
  const { existsSync, readdirSync } = await import("node:fs");
  const dir = resolve(opt.dir ?? join(dirname(new URL(import.meta.url).pathname), "../specs"));
  const only = opt.only ? String(opt.only).split(",") : null;
  const specs = (existsSync(dir) ? readdirSync(dir) : [])
    .filter((f) => f.endsWith(".json"))
    .filter((f) => !only || only.some((o) => f.includes(o)))
    .map((f) => ({ file: f, ...JSON.parse(readFileSync(join(dir, f), "utf8")) }));
  if (!specs.length) {
    console.log(`nenhuma spec em ${relative(process.cwd(), dir) || dir}${only ? ` (--only ${only})` : ""} — nada verificado`);
    return;
  }
  const rebase = (u) =>
    opt.base ? new URL(new URL(u).pathname + new URL(u).search, opt.base).href : u;
  const groups = new Map();
  for (const s of specs) {
    const vp = viewportFrom(s);
    const key = JSON.stringify([rebase(s.url), vp.width, vp.height, s.hide ?? ""]);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  const t = Date.now();
  const browser = await openBrowser();
  const summary = [];
  try {
    for (const [key, list] of groups) {
      const [url, width, height, hide] = JSON.parse(key);
      const page = await browser.newPage({ width, height, mobile: width <= MOBILE_MAX });
      const tg = Date.now();
      await loadPage(page, { url, wait: Number(opt.wait ?? 1000), hide, scroll: true });
      for (const s of list) {
        await runBefore(page, s);
        const { rows, fails, missing } = compare(await page.evaluate(MEASURE(s.checks)));
        // INFRA só para spec que declara depender de dados externos ("requires": "<api>", ex. "vtex").
        // Seção de CMS (hero, banners) com tudo ausente é FALHA: foi reescrita ou quebrou.
        const status =
          fails === 0 ? "ok" : s.requires && missing === s.checks.length ? "infra" : "falha";
        summary.push({
          spec: s.file,
          url,
          width,
          status,
          ok: rows.length - fails,
          total: rows.length,
          rows,
        });
      }
      console.error(
        `· ${url} @${width} — ${list.length} spec(s) em ${((Date.now() - tg) / 1000).toFixed(1)}s`,
      );
      await browser.closePage(page);
    }
  } finally {
    browser.close();
  }
  const pad = (s, n) => String(s).padEnd(n);
  for (const r of summary) {
    console.log(
      `${pad(r.status === "ok" ? "ok" : r.status === "infra" ? "INFRA" : "FALHA", 6)} ${pad(r.spec, 38)} ${r.ok}/${r.total}`,
    );
    if (r.status === "falha" && opt.verbose) printRows(r.rows.filter((x) => !x.ok));
  }
  const n = (st) => summary.filter((r) => r.status === st).length;
  console.log(
    `\n${specs.length} specs · ${groups.size} carga(s) de página · ${((Date.now() - t) / 1000).toFixed(1)}s · ok ${n("ok")} · falha ${n("falha")} · infra ${n("infra")}`,
  );
  if (opt.json) {
    ensureDir(opt.json);
    writeFileSync(opt.json, JSON.stringify(summary, null, 2));
  }
  // INFRA não reprova o design, mas também não aprova: exit 3 p/ o CI tratar à parte
  process.exitCode = n("falha") ? 1 : n("infra") ? 3 : 0;
}

// ---------------------------------------------------------------- side
// Lado a lado para revisão humana (camada 4): Figma | antes | depois, mesma escala.
//   node pixel.mjs side --figma ref.png --before main.png --after branch.png --out lado.png
//        [--crop x,y,w,h] [--scale 2] [--labels "Figma,Antes (main),Depois"]
async function side() {
  if (!opt.figma || !opt.out) die("side precisa de --figma e --out (e --before e/ou --after)");
  const sharp = require("sharp");
  // rótulos na ordem das imagens passadas (Figma, antes, depois — as que existirem)
  const files = [opt.figma, opt.before, opt.after].filter(Boolean);
  const defaults = [
    "Figma",
    ...(opt.before ? ["Antes (main)"] : []),
    ...(opt.after ? ["Depois"] : []),
  ];
  const labels = opt.labels ? String(opt.labels).split(",") : defaults;
  const cols = files.map((f, i) => [labels[i] ?? defaults[i], f]);
  const scale = Number(opt.scale ?? 1);
  const crop = opt.crop ? String(opt.crop).split(",").map(Number) : null;
  const GAP = 24;
  const LABEL = Math.round(28 * Math.max(1, scale * 0.8));
  const tiles = [];
  for (const [label, file] of cols) {
    let img = sharp(file).flatten({ background: "#ffffff" });
    if (crop) img = img.extract({ left: crop[0], top: crop[1], width: crop[2], height: crop[3] });
    const buf = await img.png().toBuffer();
    const m = await sharp(buf).metadata();
    const w = Math.round(m.width * scale);
    const h = Math.round(m.height * scale);
    tiles.push({
      label,
      w,
      h,
      buf: await sharp(buf).resize(w, h, { kernel: "nearest" }).png().toBuffer(),
    });
  }
  const W = tiles.reduce((s, t) => s + t.w, 0) + GAP * (tiles.length - 1);
  const H = Math.max(...tiles.map((t) => t.h)) + LABEL;
  const esc = (t) => t.replace(/[<&>]/g, (c) => ({ "<": "&lt;", "&": "&amp;", ">": "&gt;" })[c]);
  const comps = [];
  let x = 0;
  for (const t of tiles) {
    const svg = `<svg width="${t.w}" height="${LABEL}" xmlns="http://www.w3.org/2000/svg"><rect width="100%" height="100%" fill="#232323"/><text x="10" y="${Math.round(LABEL * 0.68)}" font-family="Arial, sans-serif" font-size="${Math.round(LABEL * 0.5)}" font-weight="700" fill="#f4f4f4">${esc(t.label)}</text></svg>`;
    comps.push({ input: Buffer.from(svg), left: x, top: 0 }, { input: t.buf, left: x, top: LABEL });
    x += t.w + GAP;
  }
  ensureDir(opt.out);
  await sharp({ create: { width: W, height: H, channels: 3, background: "#fa4516" } })
    .composite(comps)
    .png()
    .toFile(opt.out);
  console.log(JSON.stringify({ out: opt.out, size: [W, H], columns: tiles.map((t) => t.label) }));
}

const commands = { shot, diff, styles, regress, side };
if (!commands[cmd])
  die("uso: pixel.mjs <shot|diff|styles|regress|side> [flags] — veja o cabeçalho do arquivo");
commands[cmd]().catch((e) => {
  console.error(e);
  process.exit(2);
});
