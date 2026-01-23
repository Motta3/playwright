// server.js
require('dotenv').config();

const express = require('express');
let morgan, helmet; // fallback leve se não instaladas
try { morgan = require('morgan'); } catch { morgan = () => (req, res, next) => next(); }
try { helmet = require('helmet'); } catch { helmet = () => (req, res, next) => next(); }
const cors = require('cors');
const { chromium } = require('playwright');
const os = require('os');
const http = require('http');
const https = require('https');

const fs = require('fs');
const path = require('path');

(function diag() {
  const envPath = process.env.PLAYWRIGHT_BROWSERS_PATH || '(unset)';
  try {
    const haveMs = fs.existsSync('/ms-playwright');
    // nota: fs.existsSync não entende glob; manter como verificação simples
    const haveChrome = fs.existsSync('/ms-playwright/chromium-*-*') || fs.existsSync('/ms-playwright/chromium');
    console.log('[DIAG] PLAYWRIGHT_BROWSERS_PATH =', envPath);
    console.log('[DIAG] /ms-playwright exists? ', haveMs);
    console.log('[DIAG] has chromium inside /ms-playwright? ', haveChrome);
    const pwPkg = require('playwright/package.json');
    console.log('[DIAG] playwright version =', pwPkg.version);
  } catch (e) {
    console.log('[DIAG] error:', e.message);
  }
})();


// -------- Supabase (para /api/exec dinâmico) ----------
const { createClient } = (() => {
  try { return require('@supabase/supabase-js'); }
  catch { return { createClient: null }; }
})();

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_SERVICE_ROLE || '';
const supabase = (createClient && SUPABASE_URL && SUPABASE_KEY)
  ? createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } })
  : null;

// -------- Config ----------
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
const API_TOKEN = process.env.API_TOKEN || null;

// -------- App ----------
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json({ limit: '4mb' }));
app.use(morgan('tiny'));

// -------- Auth ----------
function requireAuth(req, res, next) {
  if (!API_TOKEN) return res.status(401).json({ error: 'Auth disabled on server, but endpoint requires it.' });
  const header = req.header('x-api-token');
  if (!header || header !== API_TOKEN) {
    return res.status(401).json({ error: 'Invalid or missing x-api-token' });
  }
  next();
}

// -------- Helpers (NOVO) ----------
function toNumberOr(value, fallback = 0) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function toBooleanLike(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const v = value.toLowerCase().trim();
    if (['1', 'true', 'yes', 'on'].includes(v)) return true;
    if (['0', 'false', 'no', 'off'].includes(v)) return false;
  }
  return fallback;
}

// -------- HTTP helpers for DSL (NOVO) ----------
function shellQuote(str) {
  const s = String(str);
  // bash single-quote style: ' -> '\''
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Converte um objeto { url, method, headers, postData } em cURL (bash)
function requestDataToCurl(reqData) {
  if (!reqData || !reqData.url) throw new Error('requestDataToCurl: missing reqData');
  const url = reqData.url;
  const method = String(reqData.method || 'GET').toUpperCase();
  const headers = reqData.headers || {};
  const postData = reqData.postData || '';

  // Remover headers que frequentemente atrapalham a reprodução
  const drop = new Set(['content-length', 'host', 'connection']);

  const headerFlags = Object.entries(headers)
    .filter(([k, v]) => v != null && v !== '' && !drop.has(String(k).toLowerCase()))
    .map(([k, v]) => `-H ${shellQuote(`${k}: ${v}`)}`)
    .join(' ');

  const dataFlag =
    method === 'GET' || postData === ''
      ? ''
      : `--data-raw ${shellQuote(postData)}`;

  const compressedFlag = headers['accept-encoding'] ? '--compressed' : '';

  return `curl ${shellQuote(url)} -X ${method} ${headerFlags} ${dataFlag} ${compressedFlag}`
    .replace(/\s+/g, ' ')
    .trim();
}

function postJson(urlString, payload, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
    const lib = u.protocol === 'http:' ? http : https;

    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: data,
          })
        );
      }
    );

    req.on('error', reject);
    req.setTimeout(Math.max(1000, toNumberOr(timeoutMs, 30000)), () => {
      req.destroy(new Error('POST timeout'));
    });

    req.write(body);
    req.end();
  });
}


// -------- Playwright: browser singleton ----------
let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-setuid-sandbox',
        '--no-zygote',
        '--disable-features=site-per-process',
      ],
    });
  }
  return browserPromise;
}

async function newContextAndPage(options = {}) {
  const browser = await getBrowser();

  const {
    userAgent = [
      'Mozilla/5.0 (X11; Linux x86_64)',
      'AppleWebKit/537.36 (KHTML, like Gecko)',
      'Chrome/122.0.0.0 Safari/537.36',
    ].join(' '),
    locale = 'pt-BR',
    timezoneId = 'America/Fortaleza',
    viewport = { width: 1280, height: 800 },
    deviceScaleFactor = 1,
  } = options;

  const context = await browser.newContext({
    userAgent,
    locale,
    timezoneId,
    viewport,
    deviceScaleFactor,
    javaScriptEnabled: true,
    ignoreHTTPSErrors: true,
  });

  // Anti-detecção
  await context.addInitScript(() => {
    try {
      const proto = Object.getPrototypeOf(navigator);
      Object.defineProperty(proto, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['pt-BR', 'pt', 'en'] });
      Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
      if (navigator.permissions && navigator.permissions.query) {
        const originalQuery = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (parameters) => {
          if (parameters && parameters.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission });
          }
          return originalQuery(parameters);
        };
      }
    } catch {}
  });

  const page = await context.newPage();
  return { context, page };
}

// -------- Helpers ----------
async function applyCookies(context, cookies, urlAsFallback) {
  if (!Array.isArray(cookies) || cookies.length === 0) return;
  const normalized = cookies.map((c) => {
    const out = { ...c };
    if (!out.url && !out.domain && urlAsFallback) out.url = urlAsFallback;
    return out;
  });
  await context.addCookies(normalized);
}

// Alvo = page ou frame
async function resolveTarget(page, step) {
  const { frameUrlIncludes, frameUrlEquals, frameName } = step || {};
  if (!frameUrlIncludes && !frameUrlEquals && !frameName) return page;
  const frames = page.frames();
  if (frameUrlEquals) {
    const f = frames.find((fr) => fr.url() === frameUrlEquals);
    if (f) return f;
  }
  if (frameUrlIncludes) {
    const f = frames.find((fr) => fr.url().includes(frameUrlIncludes));
    if (f) return f;
  }
  if (frameName) {
    const f = frames.find((fr) => fr.name() === frameName);
    if (f) return f;
  }
  return page;
}

// Rolagem simples para lazy-load
async function autoScroll(page, steps = 0, delayMs = 400) {
  steps = Math.max(0, steps | 0);
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('End');
    await page.waitForTimeout(delayMs);
  }
}

// deepMerge raso (para defaults < dsl < payload)
function deepMerge(a = {}, b = {}) {
  return JSON.parse(JSON.stringify(Object.assign({}, a, b)));
}

// Interpola {{param}} em strings do DSL
function interpolate(obj, params = {}) {
  if (obj == null) return obj;
  if (typeof obj === 'string') {
    return obj.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
      const val = key.split('.').reduce((acc, k) => (acc && acc[k] !== undefined ? acc[k] : undefined), params);
      return val !== undefined && val !== null ? String(val) : '';
    });
  }
  if (Array.isArray(obj)) return obj.map(v => interpolate(v, params));
  if (typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) out[k] = interpolate(obj[k], params);
    return out;
  }
  return obj;
}

// -------- Docs & Health ----------
app.get('/', (_req, res) => {
  res.type('text/plain').send(`
╔════════════════════════════════════════════════════════════════╗
║                    🚀 PLAYWRIGHT API v1.2                     ║
╠════════════════════════════════════════════════════════════════╣
║  GET  /                        - Documentação                  ║
║  GET  /health                  - Status da API                 ║
║  POST /api/screenshot          - Capturar screenshot           ║
║  POST /api/pdf                 - Gerar PDF                     ║
║  POST /api/scrape              - Web scraping                  ║
║  POST /api/actions             - Executar ações (com frames)   ║
║  POST /api/element-exists      - Verificar elemento            ║
║  POST /api/html                - Obter HTML                    ║
║  POST /api/cookies             - Gerenciar cookies             ║
║  POST /api/exec                - Executar script (Supabase)    ║
║                                                                ║
║  Headers de auth: x-api-token                                 ║
╚════════════════════════════════════════════════════════════════╝
`);
});

app.get('/health', async (_req, res) => {
  let pwVersion = 'unknown';
  try { pwVersion = require('playwright/package.json').version || 'unknown'; } catch {}
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    playwright: pwVersion,
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    cpu: os.cpus()?.length ?? null,
    auth: API_TOKEN ? 'enabled' : 'disabled',
  });
});

// -------- /api/screenshot ----------
app.post('/api/screenshot', requireAuth, async (req, res) => {
  const {
    url,
    width = 1366,
    height = 768,
    fullPage = true,
    waitUntil = 'networkidle',
    waitForSelector,
    cookies,
    deviceScaleFactor = 1,
    timeout = 30000,
    clip, // { x, y, width, height }
    delayMs,            // pode vir string
    waitAfter,          // alias aceito, pode vir string
    scrollSteps,        // pode vir string
    scrollDelayMs,      // pode vir string
    asBase64,           // pode vir string
  } = req.body || {};

  if (!url) return res.status(400).json({ error: 'Missing "url"' });

  // Coerções numéricas/booleanas (NOVO)
  const widthN = toNumberOr(width, 1366);
  const heightN = toNumberOr(height, 768);
  const dsfN = toNumberOr(deviceScaleFactor, 1);
  const timeoutN = Math.max(0, toNumberOr(timeout, 30000));
  const delayFinal = toNumberOr(waitAfter ?? delayMs, 0);
  const scrollStepsN = Math.max(0, toNumberOr(scrollSteps, 0));
  const scrollDelayN = Math.max(0, toNumberOr(scrollDelayMs, 400));
  const fullPageB = toBooleanLike(fullPage, true);
  const asBase64B = toBooleanLike(asBase64 ?? req.query.asBase64, false);

  let context, page;
  try {
    ({ context, page } = await newContextAndPage({
      viewport: { width: widthN, height: heightN },
      deviceScaleFactor: dsfN,
    }));

    if (cookies) await applyCookies(context, cookies, url);
    await page.goto(url, { waitUntil, timeout: timeoutN });
    if (waitForSelector) await page.waitForSelector(waitForSelector, { timeout: timeoutN });
    if (delayFinal > 0) await page.waitForTimeout(delayFinal);
    if (scrollStepsN > 0) await autoScroll(page, scrollStepsN, scrollDelayN);

    const buffer = await page.screenshot({ fullPage: fullPageB, clip: clip || undefined, type: 'png' });

    if (asBase64B) {
      const base64 = buffer.toString('base64');
      return res.json({ ok: true, type: 'image/png', length: buffer.length, base64 });
    }

    res.set('Content-Type', 'image/png');
    res.set('Content-Disposition', 'inline; filename="screenshot.png"');
    return res.status(200).send(buffer);
  } catch (err) {
    console.error('Erro no screenshot:', err);
    return res.status(500).json({ error: 'Failed to capture screenshot', details: String(err?.message || err) });
  } finally {
    try { if (page) await page.close(); if (context) await context.close(); } catch {}
  }
});

// -------- /api/pdf ----------
app.post('/api/pdf', requireAuth, async (req, res) => {
  const {
    url,
    waitUntil = 'networkidle',
    cookies,
    printOptions = {
      format: 'A4',
      printBackground: true,
      margin: { top: '10mm', right: '10mm', bottom: '10mm', left: '10mm' },
    },
    timeout = 30000,
    asBase64,
  } = req.body || {};

  if (!url) return res.status(400).json({ error: 'Missing "url"' });

  const timeoutN = Math.max(0, toNumberOr(timeout, 30000));
  const asBase64B = toBooleanLike(asBase64 ?? req.query.asBase64, false);

  let context, page;
  try {
    ({ context, page } = await newContextAndPage({}));
    if (cookies) await applyCookies(context, cookies, url);
    await page.goto(url, { waitUntil, timeout: timeoutN });

    const pdfBuffer = await page.pdf(printOptions);

    if (asBase64B) {
      const base64 = pdfBuffer.toString('base64');
      return res.json({ ok: true, type: 'application/pdf', length: pdfBuffer.length, base64 });
    }

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="page.pdf"');
    return res.status(200).send(pdfBuffer);
  } catch (err) {
    console.error('Erro no pdf:', err);
    return res.status(500).json({ error: 'Failed to generate PDF', details: String(err?.message || err) });
  } finally {
    try { if (page) await page.close(); if (context) await context.close(); } catch {}
  }
});

// -------- /api/scrape ----------
app.post('/api/scrape', requireAuth, async (req, res) => {
  const {
    url,
    waitUntil = 'networkidle',
    cookies,
    waitForSelector,
    evaluate, // string "( ) => { ... return ... }"
    timeout = 30000,
    asBase64,
  } = req.body || {};

  if (!url) return res.status(400).json({ error: 'Missing "url"' });

  const timeoutN = Math.max(0, toNumberOr(timeout, 30000));
  const asBase64B = toBooleanLike(asBase64 ?? req.query.asBase64, false);

  let context, page;
  try {
    ({ context, page } = await newContextAndPage({}));
    if (cookies) await applyCookies(context, cookies, url);
    await page.goto(url, { waitUntil, timeout: timeoutN });
    if (waitForSelector) await page.waitForSelector(waitForSelector, { timeout: Math.max(1000, timeoutN - 1000) });

    const title = await page.title();
    const content = await page.content();
    let result = null;
    if (evaluate && typeof evaluate === 'string') {
      result = await page.evaluate(`(${evaluate})()`);
    }

    if (asBase64B) {
      const base64 = Buffer.from(content || '', 'utf8').toString('base64');
      return res.json({
        ok: true,
        type: 'text/html',
        title,
        length: (content || '').length,
        base64,
        result,
      });
    }

    return res.json({
      ok: true,
      url,
      title,
      length: content?.length ?? 0,
      result,
      htmlSample: content?.slice(0, 1000) ?? '',
    });
  } catch (err) {
    console.error('Erro no scrape:', err);
    return res.status(500).json({ error: 'Failed to scrape page', details: String(err?.message || err) });
  } finally {
    try { if (page) await page.close(); if (context) await context.close(); } catch {}
  }
});

// -------- /api/html ----------
app.post('/api/html', requireAuth, async (req, res) => {
  const { url, waitUntil = 'networkidle', cookies, timeout = 30000, asBase64 } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing "url"' });

  const timeoutN = Math.max(0, toNumberOr(timeout, 30000));
  const asBase64B = toBooleanLike(asBase64 ?? req.query.asBase64, false);

  let context, page;
  try {
    ({ context, page } = await newContextAndPage({}));
    if (cookies) await applyCookies(context, cookies, url);
    await page.goto(url, { waitUntil, timeout: timeoutN });
    const html = await page.content();

    if (asBase64B) {
      const base64 = Buffer.from(html || '', 'utf8').toString('base64');
      return res.json({ ok: true, type: 'text/html', length: (html || '').length, base64 });
    }

    res.type('text/html').send(html);
  } catch (err) {
    console.error('Erro no html:', err);
    return res.status(500).json({ error: 'Failed to retrieve HTML', details: String(err?.message || err) });
  } finally {
    try { if (page) await page.close(); if (context) await context.close(); } catch {}
  }
});

// -------- /api/element-exists ----------
app.post('/api/element-exists', requireAuth, async (req, res) => {
  const { url, selector, waitUntil = 'domcontentloaded', cookies, timeout = 15000 } = req.body || {};
  if (!url || !selector) return res.status(400).json({ error: 'Missing "url" or "selector"' });

  const timeoutN = Math.max(0, toNumberOr(timeout, 15000));

  let context, page;
  try {
    ({ context, page } = await newContextAndPage({}));
    if (cookies) await applyCookies(context, cookies, url);
    await page.goto(url, { waitUntil, timeout: timeoutN });
    const el = await page.$(selector);
    return res.json({ exists: Boolean(el) });
  } catch (err) {
    console.error('Erro no element-exists:', err);
    return res.status(500).json({ error: 'Failed to check element', details: String(err?.message || err) });
  } finally {
    try { if (page) await page.close(); if (context) await context.close(); } catch {}
  }
});

// -------- /api/actions (com frames) ----------
app.post('/api/actions', requireAuth, async (req, res) => {
  const { url, waitUntil = 'domcontentloaded', cookies, timeout = 30000, actions = [] } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing "url"' });
  if (!Array.isArray(actions)) return res.status(400).json({ error: '"actions" must be an array' });

  const timeoutN = Math.max(0, toNumberOr(timeout, 30000));

  let context, page;
  try {
    ({ context, page } = await newContextAndPage({}));
    if (cookies) await applyCookies(context, cookies, url);
    await page.goto(url, { waitUntil, timeout: timeoutN });

    const results = [];
    const vars = Object.create(null);
    for (const step of actions) {
      const { type } = step || {};
      if (!type) throw new Error('Action missing "type"');

      const stepTimeout = (() => {
        const st = toNumberOr(step.stepTimeout, NaN);
        if (Number.isFinite(st) && st >= 1) return st;
        // fallback: usa timeout global com limites
        return Math.min(45000, Math.max(1000, timeoutN));
      })();

      const target = await resolveTarget(page, step);

      switch (type) {
        case 'waitForSelector': {
          const { selector, state = 'visible' } = step;
          await target.waitForSelector(selector, { state, timeout: stepTimeout });
          results.push({ type, ok: true });
          break;
        }
        case 'click': {
          const { selector } = step;
          await target.click(selector, { timeout: stepTimeout });
          results.push({ type, ok: true });
          break;
        }
        case 'type': {
          const { selector, text, delay } = step;
          const delayN = Math.max(0, toNumberOr(delay, 0));
          await target.type(selector, text ?? '', { delay: delayN, timeout: stepTimeout });
          results.push({ type, ok: true });
          break;
        }
        case 'fill': {
          const { selector, value } = step;
          await target.fill(selector, value ?? '', { timeout: stepTimeout });
          results.push({ type, ok: true });
          break;
        }
        case 'press': {
          const { key } = step;
          await target.keyboard.press(key);
          results.push({ type, ok: true });
          break;
        }
        case 'wait': {
          const msN = Math.max(0, toNumberOr(step.ms, 1000));
          await target.waitForTimeout(msN);
          results.push({ type, ok: true });
          break;
        }

        case 'waitForRequest': {
          // Ex: { type:'waitForRequest', urlIncludesAny:['get_stream_logs','get_jetstream_logs'], method:'POST', saveAs:'logsReq' }
          const includesAny = Array.isArray(step.urlIncludesAny)
            ? step.urlIncludesAny
            : (Array.isArray(step.cookieRequestUrlIncludesAny) ? step.cookieRequestUrlIncludesAny : null);

          const includesAnyFinal = (includesAny && includesAny.length ? includesAny : []).filter(Boolean);
          if (!includesAnyFinal.length) {
            throw new Error('waitForRequest: missing "urlIncludesAny" (array) or "cookieRequestUrlIncludesAny" (array)');
          }

          const wantMethod = step.method ? String(step.method).toUpperCase() : null;

          const timeoutMs = (() => {
            const t = toNumberOr(step.timeout_ms, NaN);
            if (Number.isFinite(t) && t >= 1) return t;
            return stepTimeout;
          })();

          const req = await page.waitForRequest(
            (r) => {
              const u = r.url();
              const okUrl = includesAnyFinal.some((part) => u.includes(part));
              if (!okUrl) return false;
              if (wantMethod && String(r.method()).toUpperCase() !== wantMethod) return false;
              return true;
            },
            { timeout: timeoutMs }
          );

          const saveAs = step.saveAs || 'lastRequest';
          const reqData = {
            url: req.url(),
            method: req.method(),
            headers: req.headers(),
            postData: req.postData() || '',
          };
          vars[saveAs] = reqData;

          results.push({ type, ok: true, saveAs, matchedUrl: reqData.url });
          break;
        }
        case 'requestToCurl': {
          // Ex: { type:'requestToCurl', fromVar:'lastRequest', saveAs:'curlBash' }
          const fromVar = step.fromVar || step.requestVar || 'lastRequest';
          const reqData = vars[fromVar];
          if (!reqData) throw new Error(`requestToCurl: vars["${fromVar}"] not found`);

          const curl = requestDataToCurl(reqData);
          const saveAs = step.saveAs || 'lastCurl';
          vars[saveAs] = curl;

          results.push({ type, ok: true, saveAs });
          break;
        }
        case 'postWebhook': {
          // Ex: { type:'postWebhook', url:'https://...', requestVar:'lastRequest', curlVar:'lastCurl', saveAs:'webhookResp' }
          const url = step.url || step.webhookUrl;
          if (!url) throw new Error('postWebhook: missing "url" (or "webhookUrl")');

          const requestVar = step.requestVar || 'lastRequest';
          const curlVar = step.curlVar || 'lastCurl';
          const respVar = step.saveAs || 'lastWebhookResponse';

          const reqData = vars[requestVar] || null;
          const curl = vars[curlVar] || '';

          // payload customizável; se não vier, cria um padrão compatível com teu webhook
          const payload =
            step.payload && typeof step.payload === 'object'
              ? step.payload
              : {
                  captured_at: new Date().toISOString(),
                  source: 'playwright_dsl',
                  bubble_request_url: reqData?.url || null,
                  bubble_request_method: reqData?.method || null,
                  cookieHeader: (reqData?.headers?.cookie || '').trim(),
                  curl_bash: String(curl || ''),
                };

          const timeoutMs = (() => {
            const t = toNumberOr(step.timeout_ms, NaN);
            if (Number.isFinite(t) && t >= 1) return t;
            return stepTimeout;
          })();

          const resp = await postJson(String(url), payload, timeoutMs);
          vars[respVar] = resp;

          results.push({ type, ok: true, saveAs: respVar, status: resp.status });
          break;
        }

        default:
          throw new Error(`Unsupported action type: ${type}`);
      }
    }

    return res.json({ ok: true, results, vars });
  } catch (err) {
    console.error('Erro no actions:', err);
    return res.status(500).json({ error: 'Failed to run actions', details: String(err?.message || err) });
  } finally {
    try { if (page) await page.close(); if (context) await context.close(); } catch {}
  }
});

// -------- /api/cookies ----------
app.post('/api/cookies', requireAuth, async (req, res) => {
  const { url, cookies } = req.body || {};
  if (!url) return res.status(400).json({ error: 'Missing "url"' });

  let context, page;
  try {
    ({ context, page } = await newContextAndPage({}));
    if (cookies) await applyCookies(context, cookies, url);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const out = await context.cookies(url);
    return res.json({ ok: true, cookies: out });
  } catch (err) {
    console.error('Erro no cookies:', err);
    return res.status(500).json({ error: 'Failed to manage cookies', details: String(err?.message || err) });
  } finally {
    try { if (page) await page.close(); if (context) await context.close(); } catch {}
  }
});

// -------- /api/exec (Supabase + fallback) ----------
app.post('/api/exec', requireAuth, async (req, res) => {
  try {
    const { key, params = {}, type, payload } = req.body || {};

    // Fallback direto: permite executar sem banco
    if (!supabase && type && payload) {
      switch (type) {
        case 'actions':
          req.body = payload;
          req.url = '/api/actions';
          return app._router.handle(req, res);
        case 'screenshot':
          req.body = payload;
          req.url = '/api/screenshot';
          return app._router.handle(req, res);
        case 'scrape':
          req.body = payload;
          req.url = '/api/scrape';
          return app._router.handle(req, res);
        case 'pdf':
          req.body = payload;
          req.url = '/api/pdf';
          return app._router.handle(req, res);
        default:
          return res.status(400).json({ error: `Unsupported type: ${type}` });
      }
    }

    if (!supabase) return res.status(500).json({ error: 'Supabase client not configured' });
    if (!key) return res.status(400).json({ error: 'Missing "key"' });

    // Busca script no Supabase
    const { data, error } = await supabase
      .from('playwright_scripts')
      .select('type, dsl, defaults, enabled')
      .eq('key', key)
      .maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).json({ error: 'Script not found' });
    if (!data.enabled) return res.status(403).json({ error: 'Script disabled' });

    const { type: scriptType, dsl, defaults } = data;

    // Monta payload final: defaults < dsl < (dsl interpolado por params) < params.payload (override)
    const basePayload = deepMerge(defaults || {}, dsl || {});
    const interpolated = interpolate(basePayload, params);
    const finalPayload = deepMerge(interpolated, params.payload || {});

    // Encaminha para o endpoint apropriado
    switch (scriptType) {
      case 'actions':
        req.body = finalPayload;
        req.url = '/api/actions';
        return app._router.handle(req, res);
      case 'screenshot':
        req.body = finalPayload; // respeita asBase64 somente se vier no payload
        req.url = '/api/screenshot';
        return app._router.handle(req, res);
      case 'scrape':
        req.body = finalPayload; // respeita asBase64 somente se vier no payload
        req.url = '/api/scrape';
        return app._router.handle(req, res);
      case 'pdf':
        req.body = finalPayload; // respeita asBase64 somente se vier no payload
        req.url = '/api/pdf';
        return app._router.handle(req, res);
      default:
        return res.status(400).json({ error: `Unsupported script type: ${scriptType}` });
    }
  } catch (err) {
    console.error('Erro no /api/exec:', err);
    return res.status(500).json({ error: 'Failed to execute script', details: String(err?.message || err) });
  }
});

// -------- Start ----------
app.listen(PORT, () => {
  const masked = API_TOKEN ? API_TOKEN.slice(0, 4) + '****' : '(disabled)';
  console.log('');
  console.log('╔════════════════════════════════════════════════════════════════╗');
  console.log('║                    🚀 PLAYWRIGHT API v1.2                     ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log('║                                                                ║');
  console.log(`║  Status: ✅ Online                                             ║`);
  console.log(`║  Porta:  ${PORT.toString().padEnd(52, ' ')}║`);
  console.log(`║  Auth:   ${API_TOKEN ? '🔐 Habilitada'.padEnd(52, ' ') : '⚠️  Desabilitada'.padEnd(52, ' ')}║`);
  console.log('║                                                                ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log('║                      📚 ENDPOINTS                             ║');
  console.log('╠════════════════════════════════════════════════════════════════╣');
  console.log('║  GET  /                      - Documentação                   ║');
  console.log('║  GET  /health               - Status da API                   ║');
  console.log('║  POST /api/screenshot       - Capturar screenshot             ║');
  console.log('║  POST /api/pdf              - Gerar PDF                       ║');
  console.log('║  POST /api/scrape           - Web scraping                    ║');
  console.log('║  POST /api/actions          - Executar ações (com frames)     ║');
  console.log('║  POST /api/element-exists   - Verificar elemento              ║');
  console.log('║  POST /api/html             - Obter HTML                      ║');
  console.log('║  POST /api/cookies          - Gerenciar cookies               ║');
  console.log('║  POST /api/exec             - Executar script (Supabase)      ║');
  console.log('╚════════════════════════════════════════════════════════════════╝');
  console.log('');
});

// -------- Encerramento limpo ----------
async function shutdown() {
  try {
    if (browserPromise) {
      const b = await browserPromise;
      await b.close();
    }
  } catch {}
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
