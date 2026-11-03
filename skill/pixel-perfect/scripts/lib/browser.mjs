// Chrome headless via CDP (WebSocket nativo do Node) — compartilhado por
// pixel.mjs (camadas 2–3) e perf.mjs (camada de custo). Sem dependências.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Mobile Safari/537.36";

export function findChrome() {
  const home = process.env.HOME ?? "";
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    join(home, ".cache/ms-playwright/chromium-1234/chrome-linux/chrome"),
  ].filter(Boolean);
  const hit = candidates.find((c) => existsSync(c));
  if (!hit) throw new Error("Chrome não encontrado — defina CHROME_PATH");
  return hit;
}

/** Abre um Chrome headless com uma aba. `gpu: true` não passa --disable-gpu (medições de custo). */
export async function openBrowser({ gpu = false } = {}) {
  const profile = mkdtempSync(join(tmpdir(), "pixel-chrome-"));
  const proc = spawn(
    findChrome(),
    [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${profile}`,
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--font-render-hinting=none",
      ...(gpu ? [] : ["--disable-gpu"]),
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  // Se o Node morrer antes do close() (timeout do teste, Ctrl+C, process.exit num
  // erro), o Chrome headless ficava órfão gastando CPU e distorcendo as medições seguintes.
  const reap = () => {
    try {
      proc.kill("SIGKILL");
    } catch {}
  };
  process.once("exit", reap);
  for (const sig of ["SIGINT", "SIGTERM"])
    process.once(sig, () => {
      reap();
      process.exit(sig === "SIGINT" ? 130 : 143);
    });
  const port = await new Promise((ok, fail) => {
    let buf = "";
    const t = setTimeout(() => fail(new Error("Chrome não abriu a porta de debug")), 15000).unref();
    proc.stderr.on("data", (d) => {
      buf += d;
      const m = buf.match(/DevTools listening on ws:\/\/[^:]+:(\d+)\//);
      if (m) {
        clearTimeout(t);
        ok(m[1]);
      }
    });
  });

  const pages = [];
  const newPage = async ({ width, height, mobile }) => {
    const target = await (
      await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" })
    ).json();
    const page = await connect(target.webSocketDebuggerUrl);
    await page.send("Page.enable");
    // PIXEL_DEBUG=1: erros e console.error da página no stderr (hidratação etc.).
    if (process.env.PIXEL_DEBUG) {
      page.on("Runtime.exceptionThrown", (p) =>
        console.error(
          `[page] exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`,
        ),
      );
      page.on("Runtime.consoleAPICalled", (p) => {
        if (p.type === "error" || p.type === "warning")
          console.error(
            `[page] ${p.type}: ${p.args
              .map((a) => a.value ?? a.description)
              .join(" ")
              .slice(0, 400)}`,
          );
      });
    }
    await page.send("Runtime.enable");
    await page.send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile,
    });
    if (mobile) {
      await page.send("Emulation.setUserAgentOverride", {
        userAgent: MOBILE_UA,
        platform: "Android",
      });
      await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    }
    page.targetId = target.id;
    pages.push(page);
    return page;
  };
  const closePage = async (page) => {
    try {
      await fetch(`http://127.0.0.1:${port}/json/close/${page.targetId}`);
    } catch {}
    page.ws.close();
  };
  const close = () => {
    for (const p of pages)
      try {
        p.ws.close();
      } catch {}
    proc.kill("SIGKILL");
    // o Chrome ainda escreve no perfil logo após o kill (ENOTEMPTY): tenta de novo
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {}
  };
  return { newPage, closePage, close };
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((ok, fail) => {
    ws.onopen = ok;
    ws.onerror = fail;
  });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = ({ data }) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      const { ok, fail } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? fail(new Error(`${msg.error.message}`)) : ok(msg.result);
    } else if (msg.method && listeners.has(msg.method)) {
      for (const fn of listeners.get(msg.method)) fn(msg.params);
    }
  };
  const send = (method, params = {}) =>
    new Promise((ok, fail) => {
      pending.set(++id, { ok, fail });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const on = (method, fn) => listeners.set(method, [...(listeners.get(method) ?? []), fn]);
  const off = (method) => listeners.delete(method);
  const once = (method) => new Promise((ok) => on(method, ok));
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description ?? "erro no evaluate");
    return r.result.value;
  };
  return { ws, send, on, off, once, evaluate };
}

/** Compatível com o pixel.mjs antigo: um Chrome com uma aba; close() derruba tudo. */
export async function openPage(vp, opts) {
  const browser = await openBrowser(opts);
  const page = await browser.newPage(vp);
  return { ...page, close: browser.close };
}

/** Navega e espera a rede quase ociosa (o WebSocket de HMR do Vite impede o "load" limpo). */
export async function navigate(page, url, { timeout = 20000 } = {}) {
  await page.send("Page.setLifecycleEventsEnabled", { enabled: true });
  let started = false;
  page.off("Page.lifecycleEvent");
  const idle = new Promise((ok) =>
    page.on("Page.lifecycleEvent", (e) => {
      if (e.name === "init") started = true;
      else if (started && e.name === "networkAlmostIdle") ok();
    }),
  );
  const loaded = page.once("Page.loadEventFired");
  await page.send("Page.navigate", { url });
  await Promise.race([idle, loaded, new Promise((r) => setTimeout(r, timeout).unref())]);
}
