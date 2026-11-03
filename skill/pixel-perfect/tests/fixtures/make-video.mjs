// Gera media/clip.webm (vídeo real, ~3 s, 1280×720) gravando um canvas no
// próprio Chrome — sem ffmpeg. Roda uma vez; o arquivo fica versionado.
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { openBrowser } from "../../scripts/lib/browser.mjs";

const out = join(dirname(fileURLToPath(import.meta.url)), "media/clip.webm");
const browser = await openBrowser();
try {
  const page = await browser.newPage({ width: 800, height: 600, mobile: false });
  const b64 = await page.evaluate(`(async () => {
    const c = Object.assign(document.createElement('canvas'), { width: 1280, height: 720 });
    const g = c.getContext('2d');
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 2_500_000 });
    const chunks = [];
    rec.ondataavailable = (e) => chunks.push(e.data);
    rec.start(250);
    const t0 = performance.now();
    await new Promise((done) => {
      const draw = (t) => {
        const k = (t - t0) / 1000;
        g.fillStyle = 'hsl(' + (k * 60) % 360 + ' 60% 45%)'; g.fillRect(0, 0, 1280, 720);
        for (let i = 0; i < 40; i++) { g.fillStyle = 'hsl(' + (i * 9 + k * 90) % 360 + ' 70% 60%)'; g.beginPath(); g.arc((i * 97 + k * 300) % 1280, (i * 53 + k * 120) % 720, 30 + (i % 7) * 8, 0, 7); g.fill(); }
        k < 3 ? requestAnimationFrame(draw) : done();
      };
      requestAnimationFrame(draw);
    });
    rec.stop();
    await new Promise((r) => (rec.onstop = r));
    const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
    let s = ''; for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return btoa(s);
  })()`);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, Buffer.from(b64, "base64"));
  console.log(out, Buffer.from(b64, "base64").length, "bytes");
} finally {
  browser.close();
}
