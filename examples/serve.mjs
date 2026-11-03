#!/usr/bin/env node
// Servidor estático dos exemplos: node examples/serve.mjs <pasta> [porta]
import { createServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 4400);
const TYPES = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml" };

createServer((req, res) => {
  let path = join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
  try {
    if (statSync(path).isDirectory()) path = join(path, "index.html");
    res.writeHead(200, { "content-type": TYPES[extname(path)] ?? "application/octet-stream", "cache-control": "no-store" });
    res.end(readFileSync(path));
  } catch {
    res.writeHead(404).end();
  }
}).listen(port, "127.0.0.1", () => console.log(`servindo ${root} em http://127.0.0.1:${port}`));
