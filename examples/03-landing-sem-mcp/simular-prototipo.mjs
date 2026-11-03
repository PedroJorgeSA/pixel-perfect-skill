#!/usr/bin/env node
// Simula as capturas que você faria do protótipo do Figma no browser (modo sem MCP):
// painel de 800 px de largura (frame de 1440 em escala 0,556), moldura escura do
// visualizador, rolagem de ~2 ticks por captura, JPEG. Num projeto real esses
// arquivos vêm de screenshots do protótipo (scaling=scale-down-width&hide-ui=1).
//   node simular-prototipo.mjs <frame-1440.png> <pasta de saída>
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(join(process.cwd(), "package.json"));
const sharp = require("sharp");
const [src, out] = process.argv.slice(2);
mkdirSync(out, { recursive: true });

const W = 800;
const page = await sharp(src).resize({ width: W }).png().toBuffer();
const { height: H } = await sharp(page).metadata();
const view = 500;
const step = 237.5; // scroll fracionário, como o do visualizador
const frame = { top: 56, left: 24 };
let k = 0;
for (let y = 0; ; y += step) {
  const top = Math.min(Math.round(y), H - view);
  const crop = await sharp(page).extract({ left: 0, top, width: W, height: view }).toBuffer();
  await sharp({ create: { width: W + 48, height: view + 112, channels: 3, background: { r: 30, g: 30, b: 30 } } })
    .composite([{ input: crop, ...frame }])
    .jpeg({ quality: 88 })
    .toFile(join(out, `${String(++k).padStart(2, "0")}.jpg`));
  if (top >= H - view) break;
}
console.log(`${k} capturas em ${out} (página ${W} × ${H})`);
