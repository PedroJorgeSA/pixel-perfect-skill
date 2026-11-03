#!/usr/bin/env node
// Camada C — custo (performance) e trade-offs de estilo.
//
// Mede a página como o usuário recebe — SEM rolar até o fim, SEM congelar
// animação, com CPU e rede limitadas no mobile — e cruza o que encontrou com
// o registro de trade-offs (perf/tradeoffs.json): todo efeito caro (glass,
// mix-blend, vídeo) precisa de uma decisão registrada, e a decisão vira regra.
//
//   node perf.mjs run   --url http://localhost:5173/ --profile mobile [--json out.json]
//   node perf.mjs check [--base http://localhost:5173] [--only home] [--json .pixel/perf/report.json]
//   node perf.mjs ab    --url http://localhost:5173/ --profile mobile --entry <id> [--runs 3]
//
// Flags: --runs N (mediana de LCP; use 3+ no CI) · --budgets arquivo (default perf/budgets.json) · --ledger arquivo (default perf/tradeoffs.json)
//        --settle ms (espera depois do load, default 3000) · --no-throttle · --strict (avisos reprovam)
// Exit: 0 ok · 1 orçamento/trade-off reprovado · 2 erro do script.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { navigate, openBrowser } from "./lib/browser.mjs";
import { evaluateBudget, evaluateTradeoffs } from "./lib/budget.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const [cmd, ...rest] = process.argv.slice(2);
const opt = {};
for (let i = 0; i < rest.length; i++) {
  if (!rest[i].startsWith("--")) continue;
  const k = rest[i].slice(2);
  opt[k] = rest[i + 1] && !rest[i + 1].startsWith("--") ? rest[++i] : true;
}
const die = (m) => {
  console.error(`perf: ${m}`);
  process.exit(2);
};
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const budgetsFile = resolve(opt.budgets ?? join(HERE, "../perf/budgets.json"));
const ledgerFile = resolve(opt.ledger ?? join(HERE, "../perf/tradeoffs.json"));

// Perfis no estilo do Lighthouse mobile: 150 ms RTT, 1,6 Mbps, CPU 4×.
const NETWORKS = {
  slow4g: {
    latency: 150,
    downloadThroughput: (1.6 * 1024 * 1024) / 8,
    uploadThroughput: (750 * 1024) / 8,
  },
  none: null,
};

// Coletor injetado antes de qualquer script da página.
const COLLECTOR = `(() => {
  const P = (window.__perf = { lcp: null, cls: 0, fcp: null, tbt: 0, shifts: 0, ttfb: null });
  try { P.ttfb = Math.round(performance.getEntriesByType('navigation')[0]?.responseStart ?? 0) || null; } catch {}
  const sig = (el) => {
    if (!el) return null;
    const sec = el.closest('[data-section]')?.getAttribute('data-section') ?? el.closest('header,footer,main,section,nav')?.tagName.toLowerCase();
    return (sec ? sec + ' › ' : '') + el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + [...el.classList].slice(0, 2).map((c) => '.' + c).join('');
  };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) P.lcp = { t: Math.round(e.startTime), size: e.size, url: e.url || null, el: sig(e.element), tag: e.element?.tagName.toLowerCase() ?? null };
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    // CLS com janelas de sessão (gap 1 s, máx. 5 s), como no Chrome
    let win = 0, first = 0, last = 0;
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.hadRecentInput) continue;
        P.shifts++;
        if (win && e.startTime - last < 1000 && e.startTime - first < 5000) win += e.value;
        else { win = e.value; first = e.startTime; }
        last = e.startTime;
        P.cls = Math.max(P.cls, win);
      }
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') P.fcp = Math.round(e.startTime);
    }).observe({ type: 'paint', buffered: true });
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) if (P.fcp != null && e.startTime >= P.fcp) P.tbt += Math.max(0, e.duration - 50);
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) { P.error = String(e); }
})();`;

// Inventário de efeitos caros e vídeos, já com os ids do registro que casam.
const INVENTORY = (entries) => `(() => {
  const entries = ${JSON.stringify(entries.map((e) => ({ id: e.id, kind: e.kind, match: e.match })))};
  const vh = innerHeight, vw = innerWidth;
  const sig = (el) => {
    const sec = el.closest('[data-section]')?.getAttribute('data-section') ?? el.closest('header,footer,main,section,nav,aside')?.tagName.toLowerCase();
    return (sec ? sec + ' › ' : '') + el.tagName.toLowerCase() + [...el.classList].filter((c) => !/[\\[\\]:]/.test(c)).slice(0, 2).map((c) => '.' + c).join('');
  };
  const inVp = (r) => r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  const matchIds = (el, kind) => entries.filter((e) => e.kind === kind).filter((e) => { try { return el.matches(e.match); } catch { return false; } }).map((e) => e.id);
  const effects = [];
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const found = [];
    const bf = cs.backdropFilter || cs.webkitBackdropFilter;
    if (bf && bf !== 'none') found.push(['backdrop-filter', bf]);
    if (cs.mixBlendMode && cs.mixBlendMode !== 'normal') found.push(['mix-blend-mode', cs.mixBlendMode]);
    if (cs.filter && /blur\\(/.test(cs.filter)) found.push(['filter-blur', cs.filter]);
    if (!found.length) continue;
    // conteúdo pulado por content-visibility:auto (fora da tela) não é renderizado:
    // registra o efeito pelo estilo, sem getBoundingClientRect — medir a caixa força o
    // layout da seção e dispara download de fonte/imagem que o usuário não baixaria
    if (el.checkVisibility && !el.checkVisibility()) continue; // ancestral com display:none: não existe na tela
    if (el.checkVisibility && !el.checkVisibility({ contentVisibilityAuto: true })) {
      for (const [kind, value] of found)
        effects.push({ kind, value, inViewport: false, hidden: false, skipped: true, sig: sig(el), matches: matchIds(el, kind) });
      continue;
    }
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    // opacidade efetiva (o elemento ou um ancestral em 0 = invisível, não conta na densidade)
    let hidden = false;
    for (let a = el; a && a !== document.body; a = a.parentElement) if (getComputedStyle(a).opacity === '0') { hidden = true; break; }
    for (const [kind, value] of found)
      effects.push({ kind, value, inViewport: inVp(r) && !hidden, hidden, sig: sig(el), matches: matchIds(el, kind) });
  }
  const videos = [...document.querySelectorAll('video')].map((v) => {
    const r = v.getBoundingClientRect();
    return {
      sig: sig(v), matches: matchIds(v, 'video'),
      autoplay: v.autoplay, muted: v.muted || v.hasAttribute('muted'), playsInline: v.playsInline,
      preload: v.getAttribute('preload') ?? '(padrão do browser)', poster: v.getAttribute('poster') || null,
      src: v.currentSrc || v.querySelector('source')?.src || v.src || null,
      sources: [...v.querySelectorAll('source')].map((s) => ({ src: s.src, type: s.type, media: s.media || null })),
      inViewport: inVp(r), width: Math.round(r.width), intrinsicWidth: v.videoWidth || null,
      paused: v.paused, readyState: v.readyState,
      hasDims: (v.hasAttribute('width') && v.hasAttribute('height')) || getComputedStyle(v).aspectRatio !== 'auto',
      key: v.getAttribute('data-fx') || v.currentSrc || v.querySelector('source')?.src || v.getAttribute('poster') || sig(v),
    };
  });
  return { effects, videos, docHeight: document.documentElement.scrollHeight };
})()`;

function profileOf(budgets, name) {
  const p = budgets.profiles[name];
  if (!p) die(`perfil desconhecido: ${name}`);
  return { name, ...p };
}

async function preparePage(browser, prof, { reducedMotion = false } = {}) {
  const page = await browser.newPage({
    width: prof.width,
    height: prof.height,
    mobile: prof.width < 768,
  });
  await page.send("Network.enable");
  // cache frio, mas ligado: com o cache desligado o Chrome baixa de novo a mesma URL
  // usada duas vezes na página, coisa que um usuário real não paga
  await page.send("Network.clearBrowserCache");
  if (!opt["no-throttle"]) {
    if (prof.cpu > 1) await page.send("Emulation.setCPUThrottlingRate", { rate: prof.cpu });
    const net = NETWORKS[prof.network ?? "none"];
    if (net) await page.send("Network.emulateNetworkConditions", { offline: false, ...net });
  }
  if (reducedMotion)
    await page.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: COLLECTOR });
  // contabilidade de rede por tipo de recurso
  const reqs = new Map();
  page.on("Network.requestWillBeSent", (e) => {
    if (!reqs.has(e.requestId))
      reqs.set(e.requestId, { url: e.request.url, type: e.type ?? "Other", bytes: 0, fin: null });
  });
  page.on("Network.responseReceived", (e) => {
    const r = reqs.get(e.requestId);
    if (r) {
      r.type = e.type ?? r.type;
      r.mime = e.response.mimeType;
      r.status = e.response.status;
    }
  });
  page.on("Network.dataReceived", (e) => {
    const r = reqs.get(e.requestId);
    if (r) r.bytes += e.encodedDataLength || e.dataLength || 0;
  });
  page.on("Network.loadingFinished", (e) => {
    const r = reqs.get(e.requestId);
    if (r) r.fin = e.encodedDataLength;
  });
  return { page, reqs };
}

const TYPE_KEY = {
  Document: "document",
  Stylesheet: "css",
  Image: "image",
  Media: "media",
  Font: "font",
  Script: "script",
  Fetch: "data",
  XHR: "data",
};

function summarizeNetwork(reqs) {
  const bytes = {
    document: 0,
    css: 0,
    image: 0,
    media: 0,
    font: 0,
    script: 0,
    data: 0,
    other: 0,
    total: 0,
  };
  const byUrl = new Map();
  let requests = 0;
  for (const r of reqs.values()) {
    if (/^(ws|wss|data|blob|chrome-extension):/.test(r.url) || r.type === "WebSocket") continue;
    requests++;
    // loadingFinished é o total real; dataReceived pode chegar duplicado (contava vídeo 2×)
    const b = r.fin ?? r.bytes;
    const k = TYPE_KEY[r.type] ?? "other";
    bytes[k] += b;
    bytes.total += b;
    byUrl.set(r.url, (byUrl.get(r.url) ?? 0) + b);
  }
  const heaviest = [...byUrl]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([url, b]) => ({ url: url.replace(/^https?:\/\/[^/]+/, ""), bytes: b }));
  return { bytes, requests, byUrl, heaviest };
}

async function measure(browser, url, prof, ledger) {
  const settle = Number(opt.settle ?? 3000);
  const { page, reqs } = await preparePage(browser, prof);
  const t = Date.now();
  await navigate(page, url, { timeout: 45000 });
  await new Promise((r) => setTimeout(r, settle));
  const vitals = await page.evaluate("window.__perf");
  // bytes ANTES do inventário: a varredura do DOM não pode entrar na conta do usuário
  const net = summarizeNetwork(reqs);
  const inv = await page.evaluate(INVENTORY(ledger.entries));
  await browser.closePage(page);
  // currentSrc é um dos <source>: deduplica para não contar o mesmo arquivo duas vezes
  for (const v of inv.videos)
    v.bytes = [...new Set([v.src, ...v.sources.map((s) => s.src)].filter(Boolean))].reduce(
      (s, u) => s + (net.byUrl.get(u) ?? 0),
      0,
    );

  // segundo passe só se há vídeo: ele respeita prefers-reduced-motion?
  if (inv.videos.length) {
    const rm = await preparePage(browser, prof, { reducedMotion: true });
    await navigate(rm.page, url, { timeout: 45000 });
    await new Promise((r) => setTimeout(r, 1500));
    // casa por data-fx/src/poster — pela posição, um vídeo trocado por <img> desalinhava a lista
    const playing = await rm.page.evaluate(
      `Object.fromEntries([...document.querySelectorAll('video')].map((v) => [v.getAttribute('data-fx') || v.currentSrc || v.querySelector('source')?.src || v.getAttribute('poster') || '', !v.paused]))`,
    );
    for (const v of inv.videos) v.playingWithReducedMotion = !!playing[v.key];
    await browser.closePage(rm.page);
  }
  return {
    url,
    profile: prof.name,
    elapsedMs: Date.now() - t,
    lcpMs: vitals?.lcp?.t ?? null,
    lcp: vitals?.lcp ?? null,
    fcpMs: vitals?.fcp ?? null,
    ttfbMs: vitals?.ttfb ?? null,
    cls: +(vitals?.cls ?? 0).toFixed(4),
    tbtMs: Math.round(vitals?.tbt ?? 0),
    requests: net.requests,
    bytes: net.bytes,
    heaviest: net.heaviest,
    effects: inv.effects,
    videos: inv.videos,
  };
}

function judge(m, budgets, ledger) {
  const { findings, allowances } = evaluateTradeoffs(m, ledger, m.profile);
  if (m.lcp?.tag === "video" && m.lcp.url) {
    const poster = m.videos.find(
      (v) => v.poster && m.lcp.url.endsWith(v.poster.replace(/^https?:\/\/[^/]+/, "")),
    );
    if (!poster)
      findings.push({
        level: "error",
        rule: "video-lcp-frame",
        msg: `o LCP é o 1º frame do vídeo (${m.lcp.url.replace(/^https?:\/\/[^/]+/, "")}), não o poster — o hero espera o vídeo baixar`,
      });
  }
  const budget = budgets.budgets[m.profile] ?? {};
  // métricas que o dev server distorce (JS sem bundle) só valem no build
  const devOnlyIgnore =
    budgets.devServer && opt.env !== "build" ? new Set(budgets.ignoreOnDev ?? []) : new Set();
  const rows = evaluateBudget(m, budget, allowances).filter((r) => !devOnlyIgnore.has(r.metric));
  return { rows, findings };
}

const fmt = (metric, v) =>
  v == null
    ? "—"
    : metric.startsWith("bytes")
      ? `${Math.round(v / 1024).toLocaleString("pt-BR")} KB`
      : metric === "cls"
        ? v.toFixed(3)
        : metric.endsWith("Ms")
          ? `${v} ms`
          : String(v);

function printReport(m, { rows, findings }) {
  console.log(`\n■ ${m.url} · ${m.profile}`);
  console.log(
    `  LCP ${fmt("lcpMs", m.lcpMs)}${m.lcpRuns ? ` [rodadas: ${m.lcpRuns.join(" · ")}]` : ""} (${m.lcp?.tag ?? "?"} ${m.lcp?.el ?? ""}${m.lcp?.url ? " · " + m.lcp.url.replace(/^https?:\/\/[^/]+/, "") : ""})`,
  );
  for (const r of rows)
    console.log(
      `  ${r.ok ? " ok " : "FORA"}  ${r.metric.padEnd(14)} ${fmt(r.metric, r.value).padStart(10)}  limite ${fmt(r.metric, r.limit)}${r.allowance ? `  (inclui +${fmt(r.metric, r.allowance)} de trade-off)` : ""}`,
    );
  const fx = new Map();
  for (const e of m.effects) fx.set(e.kind, (fx.get(e.kind) ?? 0) + 1);
  console.log(
    `  efeitos: ${[...fx].map(([k, n]) => `${k} ${n}`).join(" · ") || "nenhum"} · vídeos: ${m.videos.length}`,
  );
  for (const f of findings)
    console.log(`  ${f.level === "error" ? "ERRO " : "aviso"} ${f.rule}: ${f.msg}`);
}

const failed = (j) =>
  j.rows.some((r) => !r.ok) ||
  j.findings.some((f) => f.level === "error" || (opt.strict && f.level === "warn"));

// Lab é ruidoso: com --runs N mede N vezes e fica com a medição de LCP mediana.
async function measureMedian(browser, url, prof, ledger) {
  const n = Number(opt.runs ?? 1);
  const all = [];
  for (let i = 0; i < n; i++) all.push(await measure(browser, url, prof, ledger));
  all.sort((a, b) => (a.lcpMs ?? Infinity) - (b.lcpMs ?? Infinity));
  const mid = all[Math.floor((n - 1) / 2)];
  if (n > 1) mid.lcpRuns = all.map((m) => m.lcpMs);
  return mid;
}

async function run() {
  if (!opt.url) die("run precisa de --url");
  const budgets = readJson(budgetsFile);
  const ledger = readJson(ledgerFile);
  const prof = profileOf(budgets, opt.profile ?? "mobile");
  const browser = await openBrowser({ gpu: true });
  try {
    const m = await measureMedian(browser, opt.url, prof, ledger);
    const j = judge(m, budgets, ledger);
    printReport(m, j);
    if (opt.json) {
      mkdirSync(dirname(resolve(opt.json)), { recursive: true });
      writeFileSync(opt.json, JSON.stringify({ ...m, ...j }, null, 2));
    }
    process.exitCode = failed(j) ? 1 : 0;
  } finally {
    browser.close();
  }
}

async function check() {
  const budgets = readJson(budgetsFile);
  const ledger = readJson(ledgerFile);
  const only = opt.only ? String(opt.only).split(",") : null;
  const base = opt.base ?? budgets.base ?? "http://localhost:5173";
  const browser = await openBrowser({ gpu: true });
  const all = [];
  try {
    for (const p of budgets.pages.filter((p) => !only || only.includes(p.name)))
      for (const pn of p.profiles) {
        const m = await measureMedian(
          browser,
          new URL(p.path, base).href,
          profileOf(budgets, pn),
          ledger,
        );
        const j = judge(m, budgets, ledger);
        printReport(m, j);
        all.push({ page: p.name, ...m, ...j });
      }
  } finally {
    browser.close();
  }
  const bad = all.filter(failed);
  console.log(
    `\n${all.length} medição(ões) · ${bad.length} reprovada(s)${bad.length ? ": " + bad.map((m) => `${m.page}/${m.profile}`).join(", ") : ""}`,
  );
  const out = opt.json ?? ".pixel/perf/report.json";
  mkdirSync(dirname(resolve(out)), { recursive: true });
  writeFileSync(out, JSON.stringify(all, null, 2));
  process.exitCode = bad.length ? 1 : 0;
}

// Custo de UM efeito no main thread durante o scroll: liga × desliga, n rodadas.
// Mede rAF (quadros) e Performance.getMetrics (estilo/layout/tarefas). O custo de
// GPU do backdrop-filter roda no compositor e NÃO aparece aqui — confirme num
// aparelho real (Chrome DevTools MCP / remote debugging) antes de concluir "é barato".
async function ab() {
  if (!opt.url || !opt.entry) die("ab precisa de --url e --entry");
  const budgets = readJson(budgetsFile);
  const ledger = readJson(ledgerFile);
  const prof = profileOf(budgets, opt.profile ?? "mobile");
  const entry = ledger.entries.find((e) => e.id === opt.entry);
  if (!entry) die(`entrada não encontrada: ${opt.entry}`);
  const off = {
    "backdrop-filter": "backdrop-filter:none!important;-webkit-backdrop-filter:none!important",
    "mix-blend-mode": "mix-blend-mode:normal!important",
    "filter-blur": "filter:none!important",
    video: "display:none!important",
  }[entry.kind];
  const runs = Number(opt.runs ?? 3);
  const browser = await openBrowser({ gpu: true });
  const sample = async (disable) => {
    const { page } = await preparePage(browser, prof);
    await navigate(page, opt.url, { timeout: 45000 });
    await new Promise((r) => setTimeout(r, 2000));
    if (disable)
      await page.evaluate(
        `(() => { const s = document.createElement('style'); s.textContent = ${JSON.stringify(`${entry.match}{${off}}`)}; document.head.appendChild(s); })()`,
      );
    await page.send("Performance.enable");
    const before = Object.fromEntries(
      (await page.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]),
    );
    await page.evaluate(
      `(() => { window.__frames = []; let last = performance.now(); const tick = (t) => { window.__frames.push(t - last); last = t; if (!window.__stop) requestAnimationFrame(tick); }; requestAnimationFrame(tick); })()`,
    );
    await page.send("Input.synthesizeScrollGesture", {
      x: Math.round(prof.width / 2),
      y: Math.round(prof.height * 0.7),
      yDistance: -2400,
      speed: 1200,
      gestureSourceType: prof.width < 768 ? "touch" : "mouse",
      repeatCount: 1,
    });
    await page.evaluate(`window.__stop = true`);
    const frames = (await page.evaluate(`window.__frames`)).slice(1);
    const after = Object.fromEntries(
      (await page.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]),
    );
    await browser.closePage(page);
    const sorted = [...frames].sort((a, b) => a - b);
    const d = (k) => +((after[k] - before[k]) * 1000).toFixed(1);
    return {
      frames: frames.length,
      p95: +(sorted[Math.floor(sorted.length * 0.95)] ?? 0).toFixed(1),
      longFramesPct: +(
        (100 * frames.filter((f) => f > 33.4).length) /
        Math.max(frames.length, 1)
      ).toFixed(1),
      styleMs: d("RecalcStyleDuration"),
      layoutMs: d("LayoutDuration"),
      taskMs: d("TaskDuration"),
    };
  };
  const median = (xs, k) =>
    [...xs.map((x) => x[k])].sort((a, b) => a - b)[Math.floor((xs.length - 1) / 2)];
  try {
    const on = [];
    const offR = [];
    for (let i = 0; i < runs; i++) {
      on.push(await sample(false));
      offR.push(await sample(true));
    }
    const keys = ["p95", "longFramesPct", "styleMs", "layoutMs", "taskMs"];
    const res = Object.fromEntries(
      keys.map((k) => [
        k,
        {
          on: median(on, k),
          off: median(offR, k),
          delta: +(median(on, k) - median(offR, k)).toFixed(1),
        },
      ]),
    );
    console.log(
      `A/B ${entry.id} (${entry.kind}) · ${prof.name} · ${runs} rodada(s) cada · mediana`,
    );
    for (const k of keys)
      console.log(
        `  ${k.padEnd(14)} com ${String(res[k].on).padStart(7)}   sem ${String(res[k].off).padStart(7)}   Δ ${res[k].delta}`,
      );
    const budget = entry.costBudget?.[prof.name] ?? entry.costBudget;
    let bad = false;
    for (const [k, lim] of Object.entries(budget ?? {})) {
      const ok = res[k]?.delta <= lim;
      bad ||= !ok;
      console.log(
        `  ${ok ? " ok " : "FORA"} Δ ${k} ${res[k]?.delta} ≤ ${lim} (custo aceito no registro)`,
      );
    }
    if (opt.json) {
      mkdirSync(dirname(resolve(opt.json)), { recursive: true });
      writeFileSync(
        opt.json,
        JSON.stringify({ entry: entry.id, profile: prof.name, on, off: offR, res }, null, 2),
      );
    }
    // O lab não vê o custo de GPU do compositor (a revisão mediu Δ negativo para o glass):
    // o A/B é diagnóstico. Só vira portão com --gate, e nunca no CI.
    if (bad && !opt.gate)
      console.log("  (informativo: use --gate para reprovar; confirme num aparelho real)");
    process.exitCode = bad && opt.gate ? 1 : 0;
  } finally {
    browser.close();
  }
}

const commands = { run, check, ab };
if (!commands[cmd]) die("uso: perf.mjs <run|check|ab> [flags] — veja o cabeçalho do arquivo");
commands[cmd]().catch((e) => {
  console.error(e);
  process.exit(2);
});
