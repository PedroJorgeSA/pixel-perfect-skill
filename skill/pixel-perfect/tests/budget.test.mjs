import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateBudget, evaluateTradeoffs } from "../scripts/lib/budget.mjs";

const ledger = {
  entries: [
    {
      id: "glass",
      kind: "backdrop-filter",
      match: "[data-fx=glass]",
      decision: "keep",
      maxInViewport: { mobile: 2, desktop: 6 },
    },
    {
      id: "blend",
      kind: "mix-blend-mode",
      match: "[data-fx=blend]",
      decision: { mobile: "off", desktop: "keep" },
    },
    {
      id: "hero-video",
      kind: "video",
      match: "[data-fx=hero-video]",
      decision: "keep",
      video: {
        poster: true,
        preload: ["none", "metadata"],
        maxBytesBeforeInteraction: { mobile: 1000, desktop: 5000 },
        offscreenMaxBytes: 0,
        reducedMotion: "poster",
      },
      allowances: { mobile: { "bytes.media": 1000 }, desktop: { "bytes.media": 5000 } },
    },
  ],
};
const fx = (kind, inViewport, matches = []) => ({
  kind,
  value: "x",
  inViewport,
  sig: "s",
  matches,
});
const goodVideo = {
  sig: "v",
  matches: ["hero-video"],
  autoplay: true,
  muted: true,
  playsInline: true,
  preload: "metadata",
  poster: "/p.jpg",
  inViewport: true,
  bytes: 800,
  playingWithReducedMotion: false,
};

test("orçamento soma folgas de trade-off aceito", () => {
  const rows = evaluateBudget(
    { lcpMs: 3000, bytes: { media: 900 } },
    { lcpMs: 2500, bytes: { media: 0 } },
    { "bytes.media": 1000 },
  );
  assert.deepEqual(
    rows.map((r) => [r.metric, r.ok]),
    [
      ["lcpMs", false],
      ["bytes.media", true],
    ],
  );
});

test("efeito sem decisão registrada é erro", () => {
  const { findings } = evaluateTradeoffs(
    { effects: [fx("backdrop-filter", true)], videos: [] },
    ledger,
    "mobile",
  );
  assert.ok(findings.some((f) => f.rule === "tradeoff-undeclared"));
});

test("glass aceito, mas acima da densidade do perfil, reprova só no mobile", () => {
  const inv = { effects: [1, 2, 3].map(() => fx("backdrop-filter", true, ["glass"])), videos: [] };
  assert.ok(
    evaluateTradeoffs(inv, ledger, "mobile").findings.some((f) => f.rule === "tradeoff-density"),
  );
  assert.equal(evaluateTradeoffs(inv, ledger, "desktop").findings.length, 0);
});

test("decisão por perfil: blend desligado no mobile", () => {
  const inv = { effects: [fx("mix-blend-mode", false, ["blend"])], videos: [] };
  assert.ok(
    evaluateTradeoffs(inv, ledger, "mobile").findings.some((f) => f.rule === "tradeoff-violated"),
  );
  assert.equal(evaluateTradeoffs(inv, ledger, "desktop").findings.length, 0);
});

test("vídeo bem configurado passa e libera a folga de mídia", () => {
  const { findings, allowances } = evaluateTradeoffs(
    { effects: [], videos: [goodVideo] },
    ledger,
    "mobile",
  );
  assert.deepEqual(findings, []);
  assert.equal(allowances["bytes.media"], 1000);
});

test("vídeo mal configurado: cada regra aponta o problema", () => {
  const bad = {
    ...goodVideo,
    muted: false,
    playsInline: false,
    poster: null,
    preload: "auto",
    bytes: 4000,
    playingWithReducedMotion: true,
  };
  const rules = evaluateTradeoffs({ effects: [], videos: [bad] }, ledger, "mobile")
    .findings.map((f) => f.rule)
    .sort();
  assert.deepEqual(rules, [
    "video-autoplay-sound",
    "video-bytes",
    "video-playsinline",
    "video-poster",
    "video-preload",
    "video-reduced-motion",
  ]);
});

test("vídeo fora da tela não pode baixar nada antes da interação", () => {
  const off = { ...goodVideo, inViewport: false, bytes: 500 };
  assert.ok(
    evaluateTradeoffs({ effects: [], videos: [off] }, ledger, "mobile").findings.some(
      (f) => f.rule === "video-offscreen-bytes",
    ),
  );
});

test("vídeo sem entrada no registro é erro", () => {
  const { findings } = evaluateTradeoffs(
    { effects: [], videos: [{ ...goodVideo, matches: [] }] },
    ledger,
    "mobile",
  );
  assert.ok(findings.some((f) => f.rule === "video-undeclared"));
});

test("seletor genérico no registro é aviso; com strictSelectors vira erro", () => {
  const loose = {
    entries: [
      { id: "g", kind: "backdrop-filter", match: "section [class*=backdrop]", decision: "keep" },
    ],
  };
  const inv = { effects: [], videos: [] };
  assert.equal(evaluateTradeoffs(inv, loose, "mobile").findings[0].level, "warn");
  assert.equal(
    evaluateTradeoffs(inv, { ...loose, strictSelectors: true }, "mobile").findings[0].level,
    "error",
  );
});

test("trade-off com revisão vencida reprova", () => {
  const old = {
    entries: [
      {
        id: "g",
        kind: "backdrop-filter",
        match: "[data-fx=g]",
        decision: "keep",
        reviewBy: "2020-01-01",
      },
    ],
  };
  const f = evaluateTradeoffs({ effects: [], videos: [] }, old, "mobile").findings;
  assert.ok(f.some((x) => x.rule === "tradeoff-expired" && x.level === "error"));
});

test("vídeo sem dimensões avisa risco de CLS", () => {
  const f = evaluateTradeoffs(
    { effects: [], videos: [{ ...goodVideo, hasDims: false }] },
    ledger,
    "mobile",
  ).findings;
  assert.ok(f.some((x) => x.rule === "video-dimensions"));
});
