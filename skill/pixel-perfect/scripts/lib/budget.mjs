// Avaliação determinística de orçamento (camada de custo) e do registro de
// trade-offs de estilo. Funções puras — testadas em tests/budget.test.mjs.

/** Lê um caminho "bytes.image" de um objeto. */
const get = (o, path) => path.split(".").reduce((v, k) => (v == null ? v : v[k]), o);

/**
 * metrics: saída do perf.mjs · budget: { lcpMs, cls, tbtMs, requests, bytes: { image, media, ... } }
 * allowances: folgas concedidas por trade-offs aceitos (ex.: { "bytes.media": 400000 }).
 */
export function evaluateBudget(metrics, budget, allowances = {}) {
  const rows = [];
  const walk = (obj, prefix = "") => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === "object") walk(v, path);
      else {
        const limit = v + (allowances[path] ?? 0);
        const value = get(metrics, path);
        rows.push({
          metric: path,
          value: value ?? null,
          limit,
          allowance: allowances[path] ?? 0,
          ok: value != null && value <= limit,
        });
      }
    }
  };
  walk(budget);
  return rows;
}

/**
 * Cruza o inventário de efeitos e vídeos da página com o registro de trade-offs.
 * inventory.effects: [{ kind, value, inViewport, sig, matches: [ids] }]
 * inventory.videos:  [{ sig, matches, autoplay, muted, playsInline, preload, poster, inViewport, bytes, playingWithReducedMotion }]
 * ledger.entries:    [{ id, kind, decision: "keep"|"mobile-off"|"remove", maxInViewport?, video?: {...}, allowances? }]
 * profile: "mobile" | "desktop"
 */
export function evaluateTradeoffs(inventory, ledger, profile) {
  const findings = [];
  // valores por perfil: { mobile: x, desktop: y } ou um valor só
  const pick = (v) =>
    v && typeof v === "object" && !Array.isArray(v) && profile in v ? v[profile] : v;
  const byId = new Map(ledger.entries.map((e) => [e.id, e]));
  const allowances = {};
  const used = new Set();

  // 0) o registro só aceita seletor por data-fx: classe/tag casa efeito novo sozinho
  for (const e of ledger.entries) {
    const parts = String(e.match)
      .split(",")
      .map((x) => x.trim());
    const loose = parts.filter((x) => !/^\[data-fx=["']?[\w-]+["']?\]$/.test(x));
    if (loose.length)
      findings.push({
        level: ledger.strictSelectors ? "error" : "warn",
        rule: "tradeoff-loose-selector",
        msg: `${e.id}: seletor genérico (${loose.join(", ")}) — efeitos novos casam sem decisão; use [data-fx=${e.id}]`,
      });
  }

  // 1) todo efeito caro precisa de uma decisão registrada
  const undeclared = new Map();
  for (const fx of inventory.effects) {
    if (!fx.matches.length) {
      const k = `${fx.kind}|${fx.sig}`;
      undeclared.set(k, { ...fx, count: (undeclared.get(k)?.count ?? 0) + 1 });
    }
    for (const id of fx.matches) used.add(id);
  }
  for (const fx of undeclared.values())
    findings.push({
      level: "error",
      rule: "tradeoff-undeclared",
      msg: `${fx.kind} "${fx.value}" sem decisão no registro (${fx.count}× · ${fx.sig})`,
    });

  // 2) decisões registradas são cumpridas
  for (const e of ledger.entries) {
    const hits = inventory.effects.filter((fx) => fx.matches.includes(e.id));
    const inVp = hits.filter((fx) => fx.inViewport).length;
    const decision = pick(e.decision);
    if ((decision === "remove" || decision === "off") && hits.length)
      findings.push({
        level: "error",
        rule: "tradeoff-violated",
        msg: `${e.id}: decisão "${decision}" em ${profile}, mas o efeito está na página (${hits.length}×)`,
      });
    const max = pick(e.maxInViewport);
    if (decision === "keep" && max != null && inVp > max)
      findings.push({
        level: "error",
        rule: "tradeoff-density",
        msg: `${e.id}: ${inVp} no primeiro viewport > ${max} aceitos`,
      });
    if (decision === "keep" && hits.length) {
      for (const [k, v] of Object.entries(pick(e.allowances) ?? {}))
        if (typeof v === "number") allowances[k] = (allowances[k] ?? 0) + v;
    }
    if (e.reviewBy && new Date(e.reviewBy) < new Date())
      findings.push({
        level: "error",
        rule: "tradeoff-expired",
        msg: `${e.id}: revisão vencida em ${e.reviewBy}`,
      });
  }

  // 3) vídeos: regras de carregamento
  for (const v of inventory.videos ?? []) {
    const e = v.matches.map((id) => byId.get(id)).find((x) => x?.kind === "video");
    if (!e) {
      findings.push({
        level: "error",
        rule: "video-undeclared",
        msg: `<video> sem entrada no registro (${v.sig})`,
      });
      continue;
    }
    used.add(e.id);
    const r = Object.fromEntries(Object.entries(e.video ?? {}).map(([k, v]) => [k, pick(v)]));
    const decision = pick(e.decision);
    if (decision === "remove" || decision === "off")
      findings.push({
        level: "error",
        rule: "tradeoff-violated",
        msg: `${e.id}: vídeo com decisão "${decision}" em ${profile}`,
      });
    else if (decision === "keep" && !used.has(`allow:${e.id}`) && used.add(`allow:${e.id}`))
      for (const [k, val] of Object.entries(pick(e.allowances) ?? {}))
        if (typeof val === "number") allowances[k] = (allowances[k] ?? 0) + val;
    const tag = `${e.id} (${profile})`;
    if (v.autoplay && !v.muted)
      findings.push({
        level: "error",
        rule: "video-autoplay-sound",
        msg: `${tag}: autoplay sem muted — o browser bloqueia e o hero fica no poster`,
      });
    if (v.autoplay && !v.playsInline)
      findings.push({
        level: "error",
        rule: "video-playsinline",
        msg: `${tag}: autoplay sem playsinline — iOS abre em tela cheia`,
      });
    if (r.poster !== false && !v.poster)
      findings.push({
        level: "error",
        rule: "video-poster",
        msg: `${tag}: sem poster — tela vazia até o primeiro frame e LCP pior`,
      });
    if (r.preload && !r.preload.includes(v.preload))
      findings.push({
        level: "error",
        rule: "video-preload",
        msg: `${tag}: preload="${v.preload}", esperado ${r.preload.join(" | ")}`,
      });
    if (!v.inViewport && v.bytes > (r.offscreenMaxBytes ?? 0))
      findings.push({
        level: "error",
        rule: "video-offscreen-bytes",
        msg: `${tag}: fora da tela mas já baixou ${Math.round(v.bytes / 1024)} KB`,
      });
    if (r.maxBytesBeforeInteraction != null && v.bytes > r.maxBytesBeforeInteraction)
      findings.push({
        level: "error",
        rule: "video-bytes",
        msg: `${tag}: ${Math.round(v.bytes / 1024)} KB antes de qualquer interação > ${Math.round(r.maxBytesBeforeInteraction / 1024)} KB`,
      });
    if (r.reducedMotion === "poster" && v.playingWithReducedMotion)
      findings.push({
        level: "error",
        rule: "video-reduced-motion",
        msg: `${tag}: continua tocando com prefers-reduced-motion`,
      });
    if (v.hasDims === false)
      findings.push({
        level: "warn",
        rule: "video-dimensions",
        msg: `${tag}: sem width/height nem aspect-ratio — se o container não tiver altura fixa, empurra o layout (CLS)`,
      });
    if (r.width && v.intrinsicWidth && v.intrinsicWidth > r.width * 2)
      findings.push({
        level: "warn",
        rule: "video-oversized",
        msg: `${tag}: ${v.intrinsicWidth}px de largura para ~${r.width}px exibidos`,
      });
  }

  for (const e of ledger.entries)
    if (!used.has(e.id) && e.expectOn?.includes(profile))
      findings.push({
        level: "warn",
        rule: "tradeoff-unused",
        msg: `${e.id}: registrado mas não encontrado em ${profile} (seletor desatualizado?)`,
      });

  return { findings, allowances };
}
