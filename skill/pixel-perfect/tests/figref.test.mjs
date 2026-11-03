// Modo sem MCP: a referência costurada e o diff por seção precisam ser confiáveis,
// senão a camada 3 vira opinião. Testa com imagens sintéticas (sem browser).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIGREF = join(HERE, "../scripts/figref.mjs");
const require = createRequire(join(process.cwd(), "package.json"));
const sharp = require("sharp");
const tmp = mkdtempSync(join(tmpdir(), "figref-"));

const run = (...args) =>
  new Promise((ok) =>
    execFile(process.execPath, [FIGREF, ...args], { timeout: 60000 }, (err, stdout, stderr) =>
      ok({ code: err?.code ?? 0, stdout, stderr }),
    ),
  );

// "página" 400 × 1500 com faixas e blocos únicos (sem período vertical)
async function page() {
  const W = 400;
  const H = 1500;
  const data = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      data[i] = (y * 7 + x) % 256;
      data[i + 1] = (y * 3) % 256;
      data[i + 2] = (x * 5 + ((y / 37) | 0) * 40) % 256;
    }
  return { W, H, buf: await sharp(data, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer() };
}

// simula o visualizador do protótipo: moldura escura, janela de 300px, scroll de 137,5px.
// PNG: o padrão sintético muda de cor a cada pixel e o JPEG (croma 4:2:0) o destruiria;
// a costura de JPEG real é validada pela altura do frame (stitch --frame-height).
async function tiles(dir, { W, H, buf }) {
  mkdirSync(dir, { recursive: true });
  const view = 300;
  const step = 137.5;
  const frame = { top: 40, left: 20 };
  let k = 0;
  for (let y = 0; y + view <= H; y += step) {
    const top = Math.round(y);
    const crop = await sharp(buf).extract({ left: 0, top, width: W, height: view }).toBuffer();
    await sharp({
      create: { width: W + 40, height: view + 80, channels: 3, background: { r: 55, g: 55, b: 55 } },
    })
      .composite([{ input: crop, ...frame }])
      .png()
      .toFile(join(dir, `${String(++k).padStart(2, "0")}.png`));
    if (top + view >= H) break;
  }
  const last = await sharp(buf).extract({ left: 0, top: H - view, width: W, height: view }).toBuffer();
  await sharp({ create: { width: W + 40, height: view + 80, channels: 3, background: { r: 55, g: 55, b: 55 } } })
    .composite([{ input: last, ...frame }])
    .png()
    .toFile(join(dir, `${String(++k).padStart(2, "0")}.png`));
  return k;
}

test("stitch recorta a moldura, acha o scroll fracionário e reconstrói a altura", async () => {
  const p = await page();
  const dir = join(tmp, "tiles");
  const n = await tiles(dir, p);
  assert.ok(n >= 8);
  const out = join(tmp, "ref.png");
  const r = await run("stitch", "--dir", dir, "--out", out, "--frame-width", "400", "--frame-height", "1500");
  const rep = JSON.parse(r.stdout);
  assert.equal(rep.box.width, 400, "largura do conteúdo sem a moldura");
  assert.ok(Math.abs(rep.heightDeltaFramePx) <= 3, `altura fora: Δ ${rep.heightDeltaFramePx}px`);
  // conteúdo: diff contra a página original abaixo de 2% com tolerância de vizinhança
  const spec = join(tmp, "spec.json");
  writeFileSync(spec, JSON.stringify({ size: { width: 400 }, sections: [{ name: "tudo", id: "0:1", rect: { x: 0, y: 0, w: 400, h: 1490 } }] }));
  const orig = join(tmp, "orig.png");
  writeFileSync(orig, p.buf);
  const d = await run("sections", "--ref", out, "--actual", orig, "--spec", spec, "--out", join(tmp, "s"));
  const report = JSON.parse(readFileSync(join(tmp, "s", "report.json"), "utf8"));
  assert.ok(report.rows[0].mismatchPct < 2, `costura diverge ${report.rows[0].mismatchPct}%\n${d.stdout}`);
});

test("sections: imagem idêntica dá 0% e um bloco deslocado aparece", async () => {
  const p = await page();
  const a = join(tmp, "a.png");
  writeFileSync(a, p.buf);
  // desloca 6px um retângulo de 100×100 na seção 2
  const moved = await sharp(p.buf)
    .composite([{ input: await sharp(p.buf).extract({ left: 50, top: 800, width: 100, height: 100 }).toBuffer(), left: 56, top: 806 }])
    .png()
    .toBuffer();
  const b = join(tmp, "b.png");
  writeFileSync(b, moved);
  const spec = join(tmp, "spec2.json");
  writeFileSync(
    spec,
    JSON.stringify({
      size: { width: 400 },
      sections: [
        { name: "s1", id: "1:1", rect: { x: 0, y: 0, w: 400, h: 700 } },
        { name: "s2", id: "1:2", rect: { x: 0, y: 700, w: 400, h: 700 } },
      ],
    }),
  );
  await run("sections", "--ref", a, "--actual", a, "--spec", spec, "--out", join(tmp, "same"));
  const same = JSON.parse(readFileSync(join(tmp, "same", "report.json"), "utf8"));
  assert.deepEqual(same.rows.map((r) => r.mismatchPct), [0, 0]);
  await run("sections", "--ref", a, "--actual", b, "--spec", spec, "--out", join(tmp, "moved"));
  const moved2 = JSON.parse(readFileSync(join(tmp, "moved", "report.json"), "utf8"));
  assert.equal(moved2.rows[0].mismatchPct, 0, "seção sem mudança continua limpa");
  assert.ok(moved2.rows[1].mismatchPct > 0.5, "deslocamento de 6px (> vizinhança de 1px) tem que aparecer");
});
