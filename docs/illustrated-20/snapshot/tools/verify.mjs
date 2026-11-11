/* verify.mjs — машинные проверки демо-лендинга D1 (итерация 2) через Chrome DevTools Protocol.
   Без внешних зависимостей: Node >= 21 (встроенный WebSocket) + headless Chrome.
   Запуск: node tools/verify.mjs  (из корня проекта demo/Landing/d1-tow)

   Сервер: python3 -m http.server 8123 --bind 127.0.0.1.
   Если порт 8123 занят, принимается только сервис, отдающий страницу с маркером
   <meta name="x-demo-project" content="d1-tow">; иначе прогон завершается с ошибкой. */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const PORT = 8123;
const BASE = `http://127.0.0.1:${PORT}/`;
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOTS = join(ROOT, "docs", "illustrated-20", "screenshots");
mkdirSync(SHOTS, { recursive: true });

const results = { checks: [], consoleErrors: [], networkErrors: [] };

function note(name, pass, detail) {
  results.checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- локальный сервер (bind 127.0.0.1, маркер проекта) ---------- */
async function pageIsOurs() {
  try {
    const res = await fetch(BASE);
    if (!res.ok) return false;
    const html = await res.text();
    return html.includes('x-demo-project" content="d1-tow"');
  } catch (e) { return false; }
}

async function ensureServer() {
  const up = await fetch(BASE).then((r) => r.ok).catch(() => false);
  if (up) {
    if (!(await pageIsOurs())) {
      throw new Error(`Порт ${PORT} занят другим сервисом (маркер d1-tow не найден) — прогон завершён.`);
    }
    return null;
  }
  const srv = spawn("python3", ["-m", "http.server", String(PORT), "--bind", "127.0.0.1"], { cwd: ROOT, stdio: "ignore" });
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (await pageIsOurs()) return srv;
  }
  srv.kill("SIGTERM");
  throw new Error("не удалось поднять http.server на 127.0.0.1:" + PORT);
}

/* ---------- Chrome + CDP ---------- */
function startChrome() {
  const dir = join(tmpdir(), `d1-verify-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const args = [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-crash-reporter",
    "--hide-scrollbars", "--remote-debugging-port=0", `--user-data-dir=${join(dir, "profile")}`,
    "about:blank",
  ];
  const proc = spawn(CHROME, args, { stdio: ["ignore", "ignore", "pipe"] });
  return new Promise((resolve, reject) => {
    let buf = "";
    proc.stderr.on("data", (d) => {
      buf += d.toString();
      const m = buf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (m) resolve({ proc, ws: m[1], dir });
    });
    proc.on("exit", (c) => reject(new Error(`Chrome завершился с кодом ${c}; stderr: ${buf.slice(0, 600)}`)));
    setTimeout(() => reject(new Error("Chrome не отдал DevTools endpoint за 15 с")), 15000);
  });
}

async function newTarget(wsUrl) {
  const u = new URL(wsUrl);
  const httpBase = `http://${u.host}`;
  const res = await fetch(`${httpBase}/json/new?about:blank`, { method: "PUT" }).catch(() => null);
  if (res && res.ok) {
    const t = await res.json();
    return t.webSocketDebuggerUrl;
  }
  const list = await (await fetch(`${httpBase}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) throw new Error("нет page-таргета");
  return page.webSocketDebuggerUrl;
}

class CDP {
  constructor(url) {
    this.id = 0;
    this.pending = new Map();
    this.loadHandlers = new Set();
    this.ws = new WebSocket(url);
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener("open", res);
      this.ws.addEventListener("error", () => rej(new Error("CDP websocket error")));
    });
    this.ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { res, rej } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      } else if (msg.method) {
        if (msg.method === "Page.loadEventFired") {
          for (const h of [...this.loadHandlers]) { this.loadHandlers.delete(h); h(); }
        }
        const h = this.handlers[msg.method];
        if (h) h(msg.params);
      }
    });
    this.handlers = {};
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          rej(new Error(`timeout: ${method}`));
        }
      }, 15000);
    });
  }
  on(method, fn) { this.handlers[method] = fn; }
  loadPage(url) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.loadHandlers.delete(h); reject(new Error("loadEventFired timeout")); }, 15000);
      const h = () => { clearTimeout(t); setTimeout(resolve, 400); };
      this.loadHandlers.add(h);
      this.send("Page.navigate", { url }).catch(reject);
    });
  }
  close() { this.ws.close(); }
}

async function evalJs(cdp, expr) {
  const r = await cdp.send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("eval: " + (r.exceptionDetails.text || "exception"));
  return r.result.value;
}

async function screenshot(cdp, file, { fullPage = false } = {}) {
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: "png", captureBeyondViewport: fullPage, fromSurface: true,
  });
  writeFileSync(join(SHOTS, file), Buffer.from(data, "base64"));
  console.log(`SHOT  ${file}`);
}

async function setViewport(cdp, width, height, mobile) {
  await cdp.send("Emulation.setDeviceMetricsOverride", {
    width, height, deviceScaleFactor: 1, mobile: Boolean(mobile),
  });
}

async function key(cdp, keyName, code, vk, modifiers = 0) {
  await cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: keyName, code, windowsVirtualKeyCode: vk, modifiers });
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: vk, modifiers });
}

async function clickAt(cdp, x, y) {
  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
}

/* ---------- геометрия ---------- */
const GEOMETRY = `(() => {
  const doc = document.documentElement;
  const inner = window.innerWidth;
  const visible = (e) => e.getClientRects().length > 0;
  const out = {
    vw: inner,
    scrollWidth: doc.scrollWidth,
    overflow: doc.scrollWidth > inner + 1,
    title: document.title,
    lang: document.documentElement.lang,
    h1: document.getElementById("hero-title")?.textContent.trim() || null,
    strip: !!document.querySelector(".demo-strip"),
    headerOneLine: (() => {
      const b = document.querySelector(".brand").getBoundingClientRect();
      const c = document.getElementById("header-cta").getBoundingClientRect();
      return Math.abs(b.top - c.top) < 6 && c.left > b.right;
    })(),
    mainCtaH: Math.round(document.getElementById("main-cta")?.getBoundingClientRect().height || 0),
    mainCtaInViewport: (() => { const r = document.getElementById("main-cta")?.getBoundingClientRect(); return !!r && r.left >= 0 && r.right <= inner + 1; })(),
    imageVisible: (() => { const e = document.querySelector(".help-scheme"); const r = e?.getBoundingClientRect(); return !!r && r.width > 0 && r.right <= inner + 1 && e.querySelectorAll("li").length === 4; })(),
    stickyList: [...document.querySelectorAll("*")]
      .filter((e) => { const p = getComputedStyle(e).position; return visible(e) && (p === "sticky" || p === "fixed"); })
      .map((e) => e.id || e.tagName.toLowerCase()).slice(0, 6),
    readingMin: Math.min(...[...document.querySelectorAll("main p:not(.kicker):not(.hint):not(.section-num), main li, main dd, main dt, main summary, .contact-recipient, .contact-status")]
      .map((e) => parseFloat(getComputedStyle(e).fontSize) || 99)),
    globalMin: Math.min(...[...document.querySelectorAll("main *")]
      .filter(visible).map((e) => parseFloat(getComputedStyle(e).fontSize) || 99)),
  };
  const probe = document.createElement("button");
  probe.className = "btn btn-primary";
  probe.style.position = "absolute"; probe.style.left = "0"; probe.style.top = "0"; probe.style.visibility = "hidden";
  probe.textContent = "Очень длинная подпись кнопки, которая не должна ломать страницу: 1234567890 1234567890 1234567890";
  document.body.appendChild(probe);
  const pr = probe.getBoundingClientRect();
  out.longLabelOverflow = pr.right > inner + 1;
  probe.remove();
  return out;
})()`;

async function runGeometry(cdp, label) {
  const g = await evalJs(cdp, GEOMETRY);
  note(`${label}: нет горизонтального переполнения`, !g.overflow, `scrollWidth=${g.scrollWidth}, viewport=${g.vw}`);
  note(`${label}: главная кнопка ≥56px в пределах экрана`, g.mainCtaInViewport && g.mainCtaH >= 56, `h=${g.mainCtaH}px`);
  note(`${label}: схема из четырёх шагов в пределах экрана`, g.imageVisible);
  note(`${label}: длинная подпись кнопки не выходит за экран`, !g.longLabelOverflow);
  note(`${label}: основной текст ≥16px, мелкие подписи ≥14px`, g.readingMin >= 16 && g.globalMin >= 14, `readingMin=${g.readingMin}, globalMin=${g.globalMin}`);
  if (["768", "1024", "1440"].includes(label)) {
    note(`${label}: шапка в одну строку`, g.headerOneLine);
  }
  if (label === "390") {
    note("язык, заголовок услуги, маркер демо", g.lang === "ru" && g.h1 === "Перевозка автомобиля эвакуатором" && g.strip);
    note("липких элементов, перекрывающих контент, нет", g.stickyList.length <= 1, `fixed/sticky: ${g.stickyList.join(", ") || "нет"}`);
  }
  return g;
}

/* ---------- состояние конфигурации ---------- */
const STATE = `(() => {
  const main = document.getElementById("main-cta"), head = document.getElementById("header-cta");
  const draft = document.getElementById("contact-draft");
  const slot = (k) => {
    const s = document.querySelector("#slot-" + k + " .btn");
    return s ? { tag: s.tagName, href: s.href || null, disabled: !!s.disabled, label: s.textContent.trim() } : null;
  };
  return {
    mainTag: main.tagName, mainHref: main.href || null, mainLabel: main.textContent.trim(),
    headTag: head.tagName, headHref: head.href || null, headLabel: head.textContent.trim(),
    contactTitle: document.getElementById("contact-title").textContent.trim(),
    draftTag: draft ? draft.tagName : null,
    draftLabel: draft ? draft.textContent.trim() : null,
    draftClass: draft ? String(draft.className) : null,
    heroNote: document.getElementById("hero-note").textContent.trim(),
    intro: document.getElementById("contact-intro").textContent.trim(),
    phone: slot("phone"), messenger: slot("messenger"),
    recipHidden: [...document.querySelectorAll("[data-recipient]")].map((e) => e.hidden),
    contentClean: !/config\\.js|выдумк|заявка отправлена|без основания|подключения телефона или мессенджера текст уйдёт|зафиксирован руль/i.test(document.getElementById("content").textContent),
  };
})()`;

function stateIs(s, exp, label) {
  const fails = [];
  for (const k of Object.keys(exp)) {
    if (JSON.stringify(s[k]) !== JSON.stringify(exp[k])) {
      fails.push(`${k}: got=${JSON.stringify(s[k])} want=${JSON.stringify(exp[k])}`);
    }
  }
  note(label, fails.length === 0, fails.join("; ") || "ok");
  return fails.length === 0;
}

/* ---------- прогон ---------- */
const server = await ensureServer();
const { proc, ws, dir } = await startChrome();
let cdp;
const injectedScripts = [];
try {
  const targetWs = await newTarget(ws);
  cdp = new CDP(targetWs);

  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable");
  await cdp.send("Network.enable");
  cdp.on("Runtime.consoleAPICalled", (p) => {
    if (p.type === "error" || p.type === "warning") {
      results.consoleErrors.push(`${p.type}: ` + p.args.map((a) => a.value ?? a.description ?? "").join(" "));
    }
  });
  cdp.on("Runtime.exceptionThrown", (p) => results.consoleErrors.push(`exception: ${p.exceptionDetails.text}`));
  cdp.on("Log.entryAdded", (p) => { if (p.entry.level === "error") results.consoleErrors.push(`log: ${p.entry.text}`); });
  cdp.on("Network.loadingFailed", (p) => results.networkErrors.push(`loadingFailed: ${p.errorText} ${p.blockedReason ?? ""}`));
  cdp.on("Network.responseReceived", (p) => {
    if (p.response.status >= 400) results.networkErrors.push(`${p.response.status} ${p.response.url}`);
  });

  async function loadWithConfig(cfgSource, extraSource) {
    for (const ident of injectedScripts) {
      await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: ident }).catch(() => {});
    }
    injectedScripts.length = 0;
    /* Тестовый конфиг фиксируется неперезаписываемым свойством window:
       реальный config.js выполняет обычное присваивание и не должен
       затереть тестовое значение до выполнения app.js. */
    let src = (cfgSource || "");
    const m = src.match(/window\.DEMO_CONTACTS = (\{[^{}]*\});/);
    if (m) {
      src = `try { Object.defineProperty(window, "DEMO_CONTACTS", { configurable: false, writable: false, value: ${m[1]} }); } catch (e) {}`;
    }
    src += "\n" + (extraSource || "");
    const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: src });
    injectedScripts.push(identifier);
    await cdp.loadPage(BASE);
    await sleep(250);
  }

  const consoleMark = () => results.consoleErrors.length;

  /* ================= размеры экранов (empty) ================= */
  const sizes = [
    [360, 780, "360"], [390, 844, "390"], [768, 1024, "768"], [1024, 900, "1024"],
    [1440, 900, "1440"], [430, 900, "430"], [899, 900, "899"], [900, 900, "900"], [195, 844, "zoom200-mobile"], [720, 900, "zoom200-desktop"],
  ];
  for (const [w, h, label] of sizes) {
    /* zoom200-* — эмуляция масштаба 200% как reflow вдвое меньшего CSS-вьюпорта;
       это НЕ фактический browser zoom, что честно указано в acceptance. */
    const mobile = w <= 420 && !label.startsWith("zoom200");
    await setViewport(cdp, w, h, mobile);
    await cdp.loadPage(BASE);
    await runGeometry(cdp, label);
    if (["390", "768", "1440"].includes(label)) {
      await screenshot(cdp, `full-${label}.png`, { fullPage: true });
    } else {
      await screenshot(cdp, `hero-${label}.png`);
    }
  }

  /* ================= диалог: открытие, границы Tab, клики по координатам, Esc ================= */
  await setViewport(cdp, 390, 844, true);
  await cdp.loadPage(BASE);
  await cdp.send("Page.bringToFront");
  await evalJs(cdp, `document.getElementById("main-cta").click(); true`);
  await sleep(150);
  const afterOpen = await evalJs(cdp, `(() => ({ open: document.getElementById("memo").open, active: document.activeElement && document.activeElement.id }))()`);
  note("диалог открывается главной кнопкой, фокус на «Скопировать текст»", afterOpen.open === true && afterOpen.active === "memo-copy", JSON.stringify(afterOpen));

  await screenshot(cdp, "dialog-open-390.png");
  note("в момент скриншота диалог был открыт", (await evalJs(cdp, `document.getElementById("memo").open`)) === true);

  /* обе границы фокус-трапа */
  await evalJs(cdp, `document.getElementById("memo-close2").focus(); true`);
  await key(cdp, "Tab", "Tab", 9);
  let act = await evalJs(cdp, `document.activeElement && document.activeElement.id`);
  note("Tab на последнем элементе заворачивает на первый", act === "memo-close", `active=${act}`);
  await evalJs(cdp, `document.getElementById("memo-close").focus(); true`);
  await key(cdp, "Tab", "Tab", 9, 8);
  act = await evalJs(cdp, `document.activeElement && document.activeElement.id`);
  note("Shift+Tab на первом элементе заворачивает на последний", act === "memo-close2", `active=${act}`);

  /* клики по реальным координатам: внутри поля диалога и вне его */
  const rect = await evalJs(cdp, `(() => { const r = document.getElementById("memo").getBoundingClientRect(); return { left: r.left, top: r.top }; })()`);
  await clickAt(cdp, Math.round(rect.left + 6), Math.round(rect.top + 6));
  await sleep(100);
  note("клик внутри поля диалога не закрывает его", (await evalJs(cdp, `document.getElementById("memo").open`)) === true);
  await clickAt(cdp, 4, 4);
  await sleep(100);
  note("клик вне диалога не закрывает его (закрытия по backdrop нет)", (await evalJs(cdp, `document.getElementById("memo").open`)) === true);

  await key(cdp, "Escape", "Escape", 27);
  await sleep(150);
  const afterEsc = await evalJs(cdp, `(() => ({ open: document.getElementById("memo").open, active: document.activeElement && document.activeElement.id }))()`);
  note("Esc закрывает диалог, фокус возвращается на главную кнопку", afterEsc.open === false && afterEsc.active === "main-cta", JSON.stringify(afterEsc));

  await evalJs(cdp, `document.getElementById("open-memo").click(); true`);
  await sleep(120);
  await evalJs(cdp, `document.getElementById("memo-close2").click(); true`);
  await sleep(120);
  const afterBtn = await evalJs(cdp, `(() => ({ open: document.getElementById("memo").open, active: document.activeElement && document.activeElement.id }))()`);
  note("кнопка «Закрыть» закрывает диалог, фокус на кнопке-триггере", afterBtn.open === false && afterBtn.active === "open-memo", JSON.stringify(afterBtn));

  /* ================= копирование: три ветки раздельно ================= */
  /* 1) подтверждённое копирование через Clipboard API (чтение буфера обязательно) */
  try {
    await cdp.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite"], origin: "http://127.0.0.1:8123" });
  } catch (e) { console.log(`NOTE  grantPermissions: ${e.message}`); }
  await loadWithConfig(`window.DEMO_CONTACTS = { recipient: "Диспетчер «Тяга»", phone: null, messenger: null };`);
  await evalJs(cdp, `document.getElementById("open-memo").click(); true`);
  await sleep(120);
  const copy1 = await evalJs(cdp, `(async () => {
    document.getElementById("memo-copy").click();
    await new Promise(r => setTimeout(r, 500));
    let via = null;
    try { via = await navigator.clipboard.readText(); } catch (e) { via = "err:" + e.name; }
    return { via, status: document.getElementById("memo-status").textContent };
  })()`);
  note("ветка 1: текст подтверждённо в буфере (readText)", typeof copy1.via === "string" && copy1.via.startsWith("Здравствуйте"), `via=${String(copy1.via).slice(0, 40)}`);

  /* 2) Clipboard API отклонён, execCommand работает */
  await loadWithConfig(`window.DEMO_CONTACTS = { recipient: "Диспетчер «Тяга»", phone: null, messenger: null };`,
    `try { Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, get: function () { return { writeText: function () { return Promise.reject(new Error("denied")); }, readText: function () { return Promise.reject(new Error("denied")); } }; } }); } catch (e) {}
     document.execCommand = function () { return true; };`);
  await evalJs(cdp, `document.getElementById("open-memo").click(); true`);
  await sleep(120);
  const copy2 = await evalJs(cdp, `(async () => {
    document.getElementById("memo-copy").click();
    await new Promise(r => setTimeout(r, 500));
    let via = null;
    try { via = await navigator.clipboard.readText(); } catch (e) { via = "err:" + e.name; }
    return { via, status: document.getElementById("memo-status").textContent };
  })()`);
  note("ветка 2: API отклонён → execCommand, статус «скопирован»", String(copy2.via).startsWith("err") && copy2.status.includes("скопирован"), `via=${copy2.via}, status="${copy2.status.slice(0, 50)}"`);

  /* 3) Clipboard API отклонён и execCommand не работает → ручная инструкция */
  await loadWithConfig(`window.DEMO_CONTACTS = { recipient: "Диспетчер «Тяга»", phone: null, messenger: null };`,
    `try { Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, get: function () { return { writeText: function () { return Promise.reject(new Error("denied")); }, readText: function () { return Promise.reject(new Error("denied")); } }; } }); } catch (e) {}
     document.execCommand = function () { return false; };`);
  await evalJs(cdp, `document.getElementById("open-memo").click(); true`);
  await sleep(120);
  const copy3 = await evalJs(cdp, `(async () => {
    document.getElementById("memo-copy").click();
    await new Promise(r => setTimeout(r, 500));
    return { status: document.getElementById("memo-status").textContent };
  })()`);
  note("ветка 3: полный отказ → инструкция ручного копирования", copy3.status.includes("выделен") && copy3.status.includes("Ctrl+C"), `status="${copy3.status.slice(0, 80)}"`);
  try { await cdp.send("Browser.resetPermissions"); } catch (e) {}

  /* ================= пять конфигураций ================= */
  const NAV_GUARD = `document.addEventListener("click", function (e) {
    var a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (a) { window.__capturedNav = a.href; e.preventDefault(); }
  }, true);`;

  const scenarios = [
    {
      name: "empty", cfg: `window.DEMO_CONTACTS = { recipient: "Диспетчер «Тяга»", phone: null, messenger: null };`,
      exp: {
        mainTag: "BUTTON", mainLabel: "Попробовать обращение", mainHref: null,
        headTag: "BUTTON", headLabel: "Попробовать обращение", headHref: null,
        contactTitle: "Попробовать обращение",
        draftTag: "BUTTON", draftLabel: "Попробовать обращение", draftClass: "btn btn-primary",
        phone: { tag: "BUTTON", href: null, disabled: true, label: "Телефон не настроен" },
        messenger: { tag: "BUTTON", href: null, disabled: true, label: "Мессенджер не настроен" },
        recipHidden: [true, true],
      },
    },
    {
      name: "phone-only", cfg: `window.DEMO_CONTACTS = { recipient: "Диспетчер «Тяга»", phone: "tel:+70000000000", messenger: null };`,
      exp: {
        mainTag: "A", mainHref: "tel:+70000000000", mainLabel: "Позвонить диспетчеру",
        headTag: "A", headHref: "tel:+70000000000", headLabel: "Позвонить диспетчеру",
        phone: { tag: "A", href: "tel:+70000000000", disabled: false, label: "Позвонить диспетчеру" },
        messenger: { tag: "BUTTON", href: null, disabled: true, label: "Мессенджер не настроен" },
        contactTitle: "Связаться с диспетчером",
        draftTag: "BUTTON", draftLabel: "Открыть черновик обращения", draftClass: "btn btn-secondary",
        recipHidden: [false, false],
      },
    },
    {
      name: "messenger-only", cfg: `window.DEMO_CONTACTS = { recipient: "Диспетчер «Тяга»", phone: null, messenger: "https://example.com/demo-messenger" };`,
      exp: {
        mainTag: "A", mainHref: "https://example.com/demo-messenger", mainLabel: "Написать диспетчеру",
        headTag: "A", headHref: "https://example.com/demo-messenger", headLabel: "Написать диспетчеру",
        phone: { tag: "BUTTON", href: null, disabled: true, label: "Телефон не настроен" },
        messenger: { tag: "A", href: "https://example.com/demo-messenger", disabled: false, label: "Написать в мессенджер" },
        contactTitle: "Связаться с диспетчером",
        draftTag: "BUTTON", draftLabel: "Открыть черновик обращения", draftClass: "btn btn-secondary",
        recipHidden: [false, false],
      },
    },
    {
      name: "both", cfg: `window.DEMO_CONTACTS = { recipient: "Диспетчер «Тяга»", phone: "tel:+70000000000", messenger: "https://example.com/demo-messenger" };`,
      exp: {
        mainTag: "A", mainHref: "tel:+70000000000", mainLabel: "Позвонить диспетчеру",
        headTag: "A", headHref: "tel:+70000000000", headLabel: "Позвонить диспетчеру",
        phone: { tag: "A", href: "tel:+70000000000", disabled: false, label: "Позвонить диспетчеру" },
        messenger: { tag: "A", href: "https://example.com/demo-messenger", disabled: false, label: "Написать в мессенджер" },
        contactTitle: "Связаться с диспетчером",
        draftTag: "BUTTON", draftLabel: "Открыть черновик обращения", draftClass: "btn btn-secondary",
        recipHidden: [false, false],
      },
    },
    {
      name: "invalid", cfg: `window.DEMO_CONTACTS = { recipient: "Диспетчер «Тяга»", phone: "tel:+bad-format", messenger: "not-a-url" };`,
      exp: {
        mainTag: "BUTTON", mainLabel: "Попробовать обращение", mainHref: null,
        headTag: "BUTTON", headLabel: "Попробовать обращение", headHref: null,
        contactTitle: "Попробовать обращение",
        draftTag: "BUTTON", draftLabel: "Попробовать обращение", draftClass: "btn btn-primary",
        phone: { tag: "BUTTON", href: null, disabled: true, label: "Телефон не настроен" },
        messenger: { tag: "BUTTON", href: null, disabled: true, label: "Мессенджер не настроен" },
        recipHidden: [true, true],
      },
    },
  ];

  for (const sc of scenarios) {
    await setViewport(cdp, 390, 844, true);
    const c0 = consoleMark();
    await loadWithConfig(sc.cfg, NAV_GUARD);
    const c1 = consoleMark();
    const s = await evalJs(cdp, STATE);
    stateIs(s, sc.exp, `конфигурация «${sc.name}»: состояние страницы`);
    note(`конфигурация «${sc.name}»: клиентский текст без внутренних слов`, s.contentClean === true);
    if (sc.name === "empty") {
      note("конфигурация «empty»: hero-пояснение про черновик", s.heroNote.includes("черновик") && s.intro.includes("не настроены"));

      /* скрин раздела контакта (демо-режим) */
      await setViewport(cdp, 390, 1200, true);
      await evalJs(cdp, `document.documentElement.style.scrollBehavior = "auto"; document.getElementById("contact").scrollIntoView({behavior:"instant", block:"start"}); true`);
      await sleep(150);
      await screenshot(cdp, "contact-390.png");
      await setViewport(cdp, 390, 844, true);

      /* нижний сценарий: открытие с нижнего триггера, Esc и кнопка возвращают фокус на него */
      await evalJs(cdp, `document.getElementById("contact-draft").click(); true`);
      await sleep(150);
      const bottomOpen = await evalJs(cdp, `(() => ({ open: document.getElementById("memo").open, active: document.activeElement && document.activeElement.id }))()`);
      note("empty: нижний триггер открывает диалог, фокус на «Скопировать текст»", bottomOpen.open === true && bottomOpen.active === "memo-copy", JSON.stringify(bottomOpen));

      await key(cdp, "Escape", "Escape", 27);
      await sleep(150);
      const bottomEsc = await evalJs(cdp, `(() => ({ open: document.getElementById("memo").open, active: document.activeElement && document.activeElement.id }))()`);
      note("empty: Esc возвращает фокус именно на нижний триггер", bottomEsc.open === false && bottomEsc.active === "contact-draft", JSON.stringify(bottomEsc));

      await evalJs(cdp, `document.getElementById("contact-draft").click(); true`);
      await sleep(120);
      await evalJs(cdp, `document.getElementById("memo-close2").click(); true`);
      await sleep(150);
      const bottomClose = await evalJs(cdp, `(() => ({ open: document.getElementById("memo").open, active: document.activeElement && document.activeElement.id }))()`);
      note("empty: кнопка «Закрыть» возвращает фокус на нижний триггер", bottomClose.open === false && bottomClose.active === "contact-draft", JSON.stringify(bottomClose));
    }
    if (sc.name === "phone-only") {
      note("конфигурация «phone-only»: тексты про звонок", s.heroNote.includes("приложение звонков") && s.intro.includes("настроены"));
    }
    if (sc.name === "messenger-only") {
      note("конфигурация «messenger-only»: тексты про мессенджер", s.heroNote.includes("приложение звонков или мессенджер") && s.intro.includes("настроены"));
    }
    if (sc.name === "invalid") {
      note("конфигурация «invalid»: предупреждения в консоли (2)", c1 - c0 === 2, `delta=${c1 - c0}`);
    } else {
      note(`конфигурация «${sc.name}»: без ошибок/предупреждений консоли`, c1 - c0 === 0, `delta=${c1 - c0}`);
    }

    /* перехват навигации: оба CTA — один сценарий, реального перехода нет */
    if (sc.name !== "empty" && sc.name !== "invalid") {
      await evalJs(cdp, `document.getElementById("main-cta").click(); true`);
      await sleep(100);
      const nav1 = await evalJs(cdp, `({ href: window.__capturedNav || null, path: location.pathname })`);
      await evalJs(cdp, `document.getElementById("header-cta").click(); true`);
      await sleep(100);
      const nav2 = await evalJs(cdp, `({ href: window.__capturedNav || null, path: location.pathname })`);
      note(`конфигурация «${sc.name}»: клик по CTA перехвачен, ухода со страницы нет`,
        nav1.href === sc.exp.mainHref && nav2.href === sc.exp.mainHref && nav1.path === "/" && nav2.path === "/",
        `main→${nav1.href}, header→${nav2.href}, path=${nav1.path}`);
    }

    if (sc.name === "phone-only") {
      await evalJs(cdp, `document.getElementById("contact-draft").click(); true`);
      await sleep(150);
      const cfgDraft = await evalJs(cdp, `(() => ({ open: document.getElementById("memo").open, phoneSlot: !!document.querySelector("#slot-phone a.btn") }))()`);
      note("configured: черновик открывается вторичным действием, ссылка телефона на месте", cfgDraft.open === true && cfgDraft.phoneSlot === true, JSON.stringify(cfgDraft));
      await key(cdp, "Escape", "Escape", 27);
      await sleep(120);

      await cdp.loadPage(BASE);
      await sleep(250);
      await screenshot(cdp, "hero-configured-390.png");
    }
  }

  /* ================= без JS ================= */
  await loadWithConfig("", "");
  await cdp.send("Emulation.setScriptExecutionDisabled", { value: true });
  await cdp.loadPage(BASE);
  await sleep(300);
  const noJs = await evalJs(cdp, `(() => ({
    memoOpen: document.getElementById("memo")?.hasAttribute("open") ?? null,
    memoText: document.getElementById("memo-text")?.value.length || 0,
    phoneDisabled: (() => { const b = document.querySelector("#slot-phone button"); return b ? b.disabled : null; })(),
    sections: document.querySelectorAll("section").length,
    overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
    strip: !!document.querySelector(".demo-strip"),
    ctaLabel: document.getElementById("main-cta").textContent.trim(),
    contactTitle: document.getElementById("contact-title").textContent.trim(),
    draftHref: document.getElementById("contact-draft")?.getAttribute("href") || null,
  }))()`);
  note("без JS черновик доступен как блок (атрибут open), текст на месте", noJs.memoOpen === true && noJs.memoText > 50, JSON.stringify(noJs));
  note("без JS секции/маркер на месте, нет переполнения, кнопки отключены", noJs.sections >= 6 && !noJs.overflow && noJs.phoneDisabled === true && noJs.strip && noJs.ctaLabel === "Попробовать обращение");
  note("без JS нижнее действие — якорь к статичному черновику, заголовок раздела совпадает", noJs.draftHref === "#memo" && noJs.contactTitle === "Попробовать обращение", `draftHref=${noJs.draftHref}, title="${noJs.contactTitle}"`);
  await evalJs(cdp, `document.documentElement.style.scrollBehavior = "auto"; document.getElementById("memo").scrollIntoView({behavior:"instant", block:"start"}); true`);
  await sleep(150);
  await screenshot(cdp, "nojs-memo-390.png");
  await cdp.send("Emulation.setScriptExecutionDisabled", { value: false });

  /* ================= локальные медиа ================= */
  await cdp.send("Emulation.setScriptExecutionDisabled", { value: false });
  await cdp.loadPage(BASE);
  const media = await evalJs(cdp, `({ photos: document.querySelectorAll('img, picture, video, link[rel="preload"]').length, scenes: document.querySelectorAll('.help-route svg').length, resources: performance.getEntriesByType('resource').map(r => r.name) })`);
  note("нет фото/видео и их запросов; четыре SVG-сцены", media.photos === 0 && media.scenes === 4 && !media.resources.some(u => /\.(webp|jpe?g|png|mp4)(?:$|\?)/i.test(u)), JSON.stringify(media));
  await cdp.send("Emulation.setEmulatedMedia", {features:[{name:"prefers-reduced-motion", value:"reduce"}]});
  note("reduced motion: прокрутка без анимации", await evalJs(cdp, `getComputedStyle(document.documentElement).scrollBehavior === 'auto'`));
  await cdp.send("Emulation.setEmulatedMedia", {features:[]});
  for (const width of [390, 1440]) {
    await setViewport(cdp, width, 900, width === 390);
    await cdp.loadPage(BASE);
    await screenshot(cdp, `hero-${width}.png`);
    await evalJs(cdp, `document.querySelector('.help-scheme').scrollIntoView({behavior:'instant', block:'start'})`);
    await screenshot(cdp, `scheme-${width}.png`);
    await evalJs(cdp, `document.querySelector('#main-cta').click()`);
    await screenshot(cdp, `memo-${width}.png`);
    await key(cdp, "Escape", "Escape", 27);
  }
  // Проверка полного публичного пути с префиксом, без второго сервера и внешних запросов.
  await cdp.send("Fetch.enable", {patterns:[{urlPattern:`${BASE}preview/d1/*`, requestStage:"Request"}]});
  cdp.on("Fetch.requestPaused", async p => {
    const path = new URL(p.request.url).pathname.replace('/preview/d1/', '');
    const response = await fetch(BASE + path);
    const body = Buffer.from(await response.arrayBuffer()).toString('base64');
    await cdp.send("Fetch.fulfillRequest", {requestId:p.requestId, responseCode:response.status, responseHeaders:[{name:'Content-Type',value:response.headers.get('content-type') || 'text/plain'}], body});
  });
  await cdp.loadPage(BASE + "preview/d1/index.html");
  note("префикс: CSS/JS и схема работают", await evalJs(cdp, `getComputedStyle(document.body).backgroundColor === 'rgb(246, 245, 242)' && !document.querySelector('#memo').open && document.querySelectorAll('.help-route li').length === 4`));
  await cdp.send("Fetch.disable");

  /* ================= консоль и сеть ================= */
  const expectedWarns = results.consoleErrors.filter((e) => e.includes("не прошёл проверку")).length;
  const unexpected = results.consoleErrors.length - expectedWarns;
  note("консоль: только ожидаемые 2 предупреждения сценария invalid", unexpected === 0 && expectedWarns === 2, results.consoleErrors.join(" | ").slice(0, 250) || "чисто");
  note("нет упавших запросов и статусов 4xx/5xx", results.networkErrors.length === 0, results.networkErrors.join(" | ").slice(0, 250) || "чисто");
} finally {
  try {
    if (cdp) cdp.close();
    proc.kill("SIGTERM");
    await sleep(400);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (e) {
    console.log(`NOTE  очистка временной папки Chrome: ${e.message}`);
  }
  if (server) server.kill("SIGTERM");
}

writeFileSync(join(SHOTS, "results.json"), JSON.stringify(results, null, 2) + "\n");
const failed = results.checks.filter((c) => !c.pass);
console.log(`\nИТОГО: ${results.checks.length - failed.length}/${results.checks.length} проверок пройдено`);
if (failed.length) console.log("Не пройдено:\n" + failed.map((f) => " - " + f.name).join("\n"));
process.exit(failed.length ? 1 : 0);
