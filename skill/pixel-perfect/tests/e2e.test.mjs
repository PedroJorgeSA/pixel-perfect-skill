// Ponta a ponta: perf.mjs contra páginas de exemplo com vídeo bom/ruim e glass.
// Precisa de um Chrome (CHROME_PATH); sem ele, o teste é pulado.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome } from "../scripts/lib/browser.mjs";
import { serve } from "./serve.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, "fixtures");
const PERF = join(HERE, "../scripts/perf.mjs");
let chrome = true;
try {
  findChrome();
} catch {
  chrome = false;
}
let srv;
const tmp = mkdtempSync(join(tmpdir(), "perf-e2e-"));
before(async () => (srv = await serve(FIX)));
after(() => srv?.close());

const perf = (...args) =>
  new Promise((ok) =>
    execFile(
      process.execPath,
      [
        PERF,
        ...args,
        "--budgets",
        join(FIX, "budgets.json"),
        "--ledger",
        join(FIX, "tradeoffs.json"),
      ],
      { timeout: 120000 },
      (err, stdout, stderr) => ok({ code: err?.code ?? 0, stdout, stderr }),
    ),
  );
const runPage = async (name) => {
  const out = join(tmp, `${name}.json`);
  const r = await perf(
    "run",
    "--url",
    `${srv.url}/video-${name}.html`,
    "--profile",
    "mobile",
    "--json",
    out,
  );
  let report;
  try {
    report = JSON.parse(readFileSync(out, "utf8"));
  } catch {
    assert.fail(`perf.mjs run não gerou ${name}.json (exit ${r.code})\n${r.stderr.slice(-2000)}`);
  }
  return { ...r, report };
};

test(
  "vídeo bem configurado passa no orçamento com a folga do trade-off",
  { skip: !chrome },
  async () => {
    const { code, report, stdout } = await runPage("good");
    assert.equal(code, 0, stdout);
    const below = report.videos.find((v) => v.matches.includes("below-video"));
    assert.equal(below.bytes, 0, "vídeo abaixo da dobra não baixa nada antes do scroll");
    const hero = report.videos.find((v) => v.matches.includes("hero-video"));
    assert.equal(hero.playingWithReducedMotion, false, "reduced motion fica no poster");
    assert.equal(report.lcp.tag, "video");
    assert.match(report.lcp.url, /poster\.jpg$/, "o LCP é o poster, não o 1º frame");
    const size = 687098; // tests/fixtures/media/clip.webm
    assert.ok(
      Math.abs(hero.bytes - size) / size < 0.01,
      `bytes do hero = tamanho do arquivo ±1% (veio ${hero.bytes})`,
    );
  },
);

test(
  "vídeo mal configurado e glass demais reprovam com o motivo certo",
  { skip: !chrome },
  async (t) => {
    const { code, report } = await runPage("bad");
    assert.equal(code, 1);
    const rules = new Set(report.findings.map((f) => f.rule));
    // video-lcp-frame só existe se o Chrome registrar o 1º frame do vídeo como LCP:
    // o do macOS registra; o do runner Linux (vídeo sem som bloqueado, sem frame pintado) não.
    if (report.lcp?.tag === "video") assert.ok(rules.has("video-lcp-frame"), "LCP é o vídeo sem poster");
    else t.diagnostic(`LCP não foi o vídeo neste Chrome (${report.lcp?.tag ?? "sem LCP"}): video-lcp-frame não verificado`);
    for (const r of [
      "video-poster",
      "video-autoplay-sound",
      "video-playsinline",
      "video-preload",
      "video-offscreen-bytes",
      "tradeoff-density",
      "tradeoff-undeclared",
    ])
      assert.ok(rules.has(r), `esperava ${r}; veio ${[...rules].join(", ")}`);
    assert.ok(report.bytes.media > 600000, "o vídeo fora da tela foi baixado inteiro");
  },
);

test("ab mede o custo de um efeito ligado × desligado", { skip: !chrome }, async () => {
  const out = join(tmp, "ab.json");
  const { code, stdout } = await perf(
    "ab",
    "--url",
    `${srv.url}/video-good.html`,
    "--profile",
    "mobile",
    "--entry",
    "glass",
    "--runs",
    "1",
    "--json",
    out,
  );
  assert.ok([0, 1].includes(code), stdout);
  const r = JSON.parse(readFileSync(out, "utf8"));
  assert.ok(r.res.taskMs.on >= 0 && r.res.p95.on > 0, "coletou quadros e tempo de tarefa");
});
