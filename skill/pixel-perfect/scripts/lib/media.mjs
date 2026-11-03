// Identificação de mídia por bytes (não pela extensão) e checagens de vídeo
// que não precisam de ffprobe. Funções puras — testadas em tests/media.test.mjs.

const EXT_TYPES = {
  png: "png",
  jpg: "jpeg",
  jpeg: "jpeg",
  webp: "webp",
  avif: "avif",
  gif: "gif",
  svg: "svg",
  mp4: "mp4",
  m4v: "mp4",
  mov: "mov",
  webm: "webm",
};

/** Tipo real do arquivo a partir dos primeiros bytes. */
export function sniff(buf) {
  const b = (i) => buf[i];
  const ascii = (from, to) => String.fromCharCode(...buf.subarray(from, to));
  if (buf.length >= 8 && b(0) === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (buf.length >= 3 && b(0) === 0xff && b(1) === 0xd8 && b(2) === 0xff) return "jpeg";
  if (buf.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (buf.length >= 6 && ascii(0, 3) === "GIF") return "gif";
  if (buf.length >= 4 && b(0) === 0x1a && b(1) === 0x45 && b(2) === 0xdf && b(3) === 0xa3)
    return "webm";
  if (buf.length >= 12 && ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (/^avi[fs]$/.test(brand)) return "avif";
    if (brand === "qt  ") return "mov";
    return "mp4";
  }
  const head = buf.subarray(0, 512).toString("utf8").trimStart();
  if (head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"))) return "svg";
  return "unknown";
}

export const extType = (file) => EXT_TYPES[file.split(".").pop().toLowerCase()] ?? null;

/** Caixas de topo de um MP4/MOV: [{ type, size, offset }]. */
export function mp4Boxes(buf) {
  const boxes = [];
  let off = 0;
  while (off + 8 <= buf.length) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString("latin1", off + 4, off + 8);
    if (size === 1 && off + 16 <= buf.length) size = Number(buf.readBigUInt64BE(off + 8));
    else if (size === 0) size = buf.length - off;
    if (size < 8 || !/^[\x20-\x7e]{4}$/.test(type)) break;
    boxes.push({ type, size, offset: off });
    off += size;
  }
  return boxes;
}

/**
 * "faststart": o índice (moov) vem antes dos dados (mdat). Sem isso o browser
 * precisa baixar o arquivo até o fim (ou fazer um range request extra) para
 * começar a tocar — o primeiro frame do hero atrasa.
 */
export function mp4Faststart(buf) {
  const boxes = mp4Boxes(buf);
  const moov = boxes.findIndex((x) => x.type === "moov");
  const mdat = boxes.findIndex((x) => x.type === "mdat");
  const brand = buf.length >= 12 ? buf.toString("latin1", 8, 12) : null;
  if (moov === -1) return { ok: null, reason: "sem caixa moov no trecho lido", brand, boxes };
  if (mdat === -1)
    return { ok: true, reason: "sem mdat (fragmentado ou só cabeçalho)", brand, boxes };
  return {
    ok: moov < mdat,
    reason:
      moov < mdat ? "moov antes de mdat" : "moov depois de mdat — rode com -movflags +faststart",
    brand,
    boxes,
  };
}

/** Regras de arquivo de mídia — devolve achados { level, rule, msg }. */
export function checkMediaFile({ file, bytes, buf, meta }, limits) {
  const out = [];
  const real = sniff(buf);
  const ext = extType(file);
  if (ext && real !== "unknown" && ext !== real && !(ext === "mp4" && real === "mov"))
    out.push({
      level: "error",
      rule: "ext-mismatch",
      msg: `extensão .${file.split(".").pop()} mas o arquivo é ${real}`,
    });
  const isVideo = ["mp4", "mov", "webm"].includes(real);
  if (isVideo) {
    if (real === "mov")
      out.push({
        level: "error",
        rule: "video-mov",
        msg: "QuickTime (.mov) — exporte MP4 (H.264/HEVC) ou WebM (VP9/AV1)",
      });
    if (bytes > limits.videoMaxBytes)
      out.push({
        level: "error",
        rule: "video-bytes",
        msg: `${kb(bytes)} > ${kb(limits.videoMaxBytes)} por vídeo`,
      });
    if (real === "mp4" || real === "mov") {
      const fs = mp4Faststart(buf);
      if (fs.ok === false) out.push({ level: "error", rule: "video-faststart", msg: fs.reason });
    }
    return out;
  }
  if (["png", "jpeg", "webp", "avif", "gif"].includes(real)) {
    if (bytes > limits.imageMaxBytes)
      out.push({
        level: "error",
        rule: "image-bytes",
        msg: `${kb(bytes)} > ${kb(limits.imageMaxBytes)}`,
      });
    if (meta && Math.max(meta.width, meta.height) > limits.imageMaxSide)
      out.push({
        level: "warn",
        rule: "image-side",
        msg: `${meta.width}×${meta.height} — lado maior que ${limits.imageMaxSide}px`,
      });
    if (real === "png" && meta && !meta.hasAlpha && bytes > limits.pngOpaqueMaxBytes)
      out.push({
        level: "warn",
        rule: "png-opaque",
        msg: `PNG sem transparência com ${kb(bytes)} — WebP/AVIF/JPG`,
      });
    if (real === "png" && meta?.hasAlpha && meta.isOpaque && bytes > limits.pngOpaqueMaxBytes)
      out.push({
        level: "warn",
        rule: "png-opaque",
        msg: `PNG com canal alfa todo opaco (${kb(bytes)}) — WebP/AVIF/JPG`,
      });
    if (real === "gif" && bytes > 200_000)
      out.push({
        level: "warn",
        rule: "gif-anim",
        msg: "GIF grande — use <video> MP4/WebM (5–10× menor)",
      });
  }
  return out;
}

export const kb = (n) => `${Math.round(n / 1024).toLocaleString("pt-BR")} KB`;
