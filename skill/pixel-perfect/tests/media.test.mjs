import { test } from "node:test";
import assert from "node:assert/strict";
import { checkMediaFile, mp4Faststart, sniff } from "../scripts/lib/media.mjs";

const box = (type, payload = 0) => {
  const b = Buffer.alloc(8 + payload);
  b.writeUInt32BE(8 + payload, 0);
  b.write(type, 4, "latin1");
  return b;
};
const ftyp = (brand = "isom") => {
  const b = box("ftyp", 8);
  b.write(brand, 8, "latin1");
  return b;
};
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const LIMITS = {
  imageMaxBytes: 300000,
  imageMaxSide: 2560,
  pngOpaqueMaxBytes: 100000,
  videoMaxBytes: 4000000,
};

test("sniff identifica pelo conteúdo, não pela extensão", () => {
  assert.equal(sniff(PNG), "png");
  assert.equal(sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0])), "jpeg");
  assert.equal(sniff(Buffer.concat([ftyp("isom"), box("moov")])), "mp4");
  assert.equal(sniff(Buffer.concat([ftyp("qt  "), box("moov")])), "mov");
  assert.equal(sniff(Buffer.concat([ftyp("avif"), box("meta")])), "avif");
  assert.equal(sniff(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0])), "webm");
});

test("PNG com extensão .jpg é erro (caso real: public/figma/hero.jpg)", () => {
  const f = checkMediaFile(
    {
      file: "hero.jpg",
      bytes: 226745,
      buf: PNG,
      meta: { width: 480, height: 270, hasAlpha: true, isOpaque: true },
    },
    LIMITS,
  );
  assert.ok(f.some((x) => x.rule === "ext-mismatch" && x.level === "error"));
  assert.ok(f.some((x) => x.rule === "png-opaque"));
});

test("MP4 faststart: moov antes de mdat passa, depois reprova", () => {
  const good = Buffer.concat([ftyp(), box("moov", 16), box("mdat", 64)]);
  const bad = Buffer.concat([ftyp(), box("mdat", 64), box("moov", 16)]);
  assert.equal(mp4Faststart(good).ok, true);
  assert.equal(mp4Faststart(bad).ok, false);
  const f = checkMediaFile({ file: "hero.mp4", bytes: bad.length, buf: bad }, LIMITS);
  assert.ok(f.some((x) => x.rule === "video-faststart"));
});

test("vídeo .mov e acima do limite reprovam", () => {
  const mov = Buffer.concat([ftyp("qt  "), box("moov", 16), box("mdat", 64)]);
  const f = checkMediaFile({ file: "hero.mov", bytes: 5_000_000, buf: mov }, LIMITS);
  assert.ok(f.some((x) => x.rule === "video-mov"));
  assert.ok(f.some((x) => x.rule === "video-bytes"));
});
