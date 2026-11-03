// Servidor estático mínimo para as fixtures (com Range, como um CDN de vídeo).
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".jpg": "image/jpeg",
  ".png": "image/png",
};

export function serve(dir) {
  const server = createServer((req, res) => {
    const path = join(dir, decodeURIComponent(new URL(req.url, "http://x").pathname));
    let size;
    try {
      size = statSync(path).size;
    } catch {
      res.writeHead(404).end();
      return;
    }
    const headers = {
      "content-type": TYPES[extname(path)] ?? "application/octet-stream",
      "accept-ranges": "bytes",
      "cache-control": "no-store",
    };
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
    const body = readFileSync(path);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1;
      res.writeHead(206, {
        ...headers,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": end - start + 1,
      });
      res.end(body.subarray(start, end + 1));
    } else {
      res.writeHead(200, { ...headers, "content-length": size });
      res.end(body);
    }
  });
  return new Promise((ok) =>
    server.listen(0, "127.0.0.1", () =>
      ok({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }),
    ),
  );
}
