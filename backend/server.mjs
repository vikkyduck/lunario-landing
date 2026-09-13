// lunario.online — лендинг с А/Б-тестом + приём заявок + админка.
// Zero-dependency Node >=22.5 (node:sqlite). Слушает 127.0.0.1, за nginx.
//
// А/Б: GET / выдаёт вариант A или B строгим чередованием (счётчик в базе),
// вариант закрепляется cookie lunario_ab на 90 дней. Все события и заявки
// пишутся с меткой варианта → /admin показывает конверсию по вариантам.
//
// 152-ФЗ: база на этом же сервере (РФ), в Telegram персональные данные не уходят.
//
// ENV (.env поднимает systemd, EnvironmentFile):
//   PORT              — порт (по умолч. 5030)
//   SITE_DIR          — каталог статики (по умолч. ../site относительно server.mjs)
//   DB_FILE           — SQLite (по умолч. /opt/lunario/data/lunario.db)
//   TG_BOT_TOKEN      — токен бота (пусто → Telegram пропускается)
//   TG_CHAT_ID        — чат(ы) для уведомлений: один id или несколько через запятую
//   TELEGRAM_API_BASE — базовый URL Telegram API (прямой или CF-прокси)
//   ADMIN_USER / ADMIN_PASS — доступ к /admin (basic auth)
//   PUBLIC_BASE       — публичный URL сайта (для ссылки в уведомлении)
//   METRIKA_ID        — номер счётчика Яндекс Метрики (пусто → счётчик не ставится)

import http from 'node:http';
import { readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 5030);
const HOST = '127.0.0.1';
const SITE_DIR = process.env.SITE_DIR || join(__dirname, '..', 'site');
const DB_FILE = process.env.DB_FILE || '/opt/lunario/data/lunario.db';
const TG_BOT_TOKEN = (process.env.TG_BOT_TOKEN || '').trim();
// один или несколько получателей через запятую: личный чат владелицы + общий чат команды
const TG_CHAT_IDS = (process.env.TG_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean);
const TELEGRAM_API_BASE = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
const ADMIN_USER = (process.env.ADMIN_USER || '').trim();
const ADMIN_PASS = (process.env.ADMIN_PASS || '').trim();
const PUBLIC_BASE = (process.env.PUBLIC_BASE || 'https://lunario.online').replace(/\/+$/, '');
const METRIKA_ID = (process.env.METRIKA_ID || '').trim();

const CONSENT_VERSION = '1.0-2026-08-05';
const MAX_BODY = 16 * 1024;
const LEAD_RATE_MAX = 10;            // заявок в час с одного IP
const EVENT_RATE_MAX = 600;          // событий в час с одного IP
const RATE_WINDOW_MS = 60 * 60e3;
const STATUSES = ['new', 'work', 'done'];
const EVENT_TYPES = new Set(['landing_view', 'cta_click', 'form_start', 'interest_select',
  'lead_sent', 'form_error', 'faq_open', 'scroll_50', 'scroll_90',
  // переход в приложение и установка его на телефон прямо с лендинга
  'app_open', 'pwa_offer', 'pwa_accepted', 'pwa_declined', 'pwa_hint', 'pwa_installed']);

/* ── база ── */
mkdirSync(dirname(DB_FILE), { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    name TEXT DEFAULT '',
    contact TEXT DEFAULT '',
    contact_norm TEXT DEFAULT '',
    interests TEXT DEFAULT '',
    variant TEXT DEFAULT '',
    utm_source TEXT DEFAULT '', utm_medium TEXT DEFAULT '', utm_campaign TEXT DEFAULT '',
    utm_content TEXT DEFAULT '', utm_term TEXT DEFAULT '',
    ip TEXT DEFAULT '', ua TEXT DEFAULT '',
    consent_pd_version TEXT DEFAULT '', consent_pd_ts TEXT DEFAULT '',
    consent_ads INTEGER DEFAULT 0, consent_ads_ts TEXT DEFAULT '',
    status TEXT DEFAULT 'new'
  );
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    type TEXT NOT NULL,
    variant TEXT DEFAULT '',
    detail TEXT DEFAULT ''
  );
  CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events (type, variant);
`);

function metaGet(k, dflt) {
  const r = db.prepare('SELECT v FROM meta WHERE k = ?').get(k);
  return r ? r.v : dflt;
}
function metaSet(k, v) {
  db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, String(v));
}

/* ── варианты А/Б ──
   Заголовки вариантов из вёрстки убраны (с 10.08 на странице один H1),
   но метка варианта по-прежнему пишется в события — механика cookie сохранена. */
const VARIANTS = { A: {}, B: {} };
const metrikaHead = METRIKA_ID
  ? `<script>(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})(window,document,"script","https://mc.yandex.ru/metrika/tag.js","ym");ym(${METRIKA_ID},"init",{clickmap:true,trackLinks:true,accurateTrackBounce:true});</script><noscript><div><img src="https://mc.yandex.ru/watch/${METRIKA_ID}" style="position:absolute;left:-9999px" alt=""></div></noscript>`
  : '';
const pageCache = {};
function buildPages() {
  const tpl = readFileSync(join(SITE_DIR, 'index.html'), 'utf8');
  for (const v of ['A', 'B']) {
    pageCache[v] = tpl
      .replaceAll('{{VARIANT}}', v)
      .replaceAll('{{METRIKA_ID_JSON}}', METRIKA_ID ? METRIKA_ID : 'null')
      .replaceAll('{{METRIKA_HEAD}}', metrikaHead);
  }
}
buildPages();

/* ── утилиты ── */
const leadRate = new Map();
const eventRate = new Map();
function allowRate(map, ip, max) {
  const now = Date.now();
  const rec = map.get(ip) || { n: 0, t: now };
  if (now - rec.t > RATE_WINDOW_MS) { rec.n = 0; rec.t = now; }
  rec.n++;
  map.set(ip, rec);
  if (map.size > 5000) for (const [k, r] of map) if (now - r.t > RATE_WINDOW_MS) map.delete(k);
  return rec.n <= max;
}
function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket.remoteAddress || '';
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('too_large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const clean = (s, max) => String(s ?? '').replace(/[\x00-\x1f]/g, ' ').trim().slice(0, max);

function contactValid(s) {
  if (/^@[a-zA-Z0-9_]{4,32}$/.test(s)) return true;
  if (/^(https?:\/\/)?(t\.me|telegram\.me)\/[a-zA-Z0-9_]{4,32}$/.test(s)) return true;
  if (/^[^\s@]+@[^\s@]+\.[a-zA-Zа-яА-Я]{2,}$/.test(s)) return true;
  return false;
}
function normContact(s) {
  let c = s.trim().toLowerCase();
  const m = c.match(/^(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([a-z0-9_]{4,32})$/);
  if (m) c = '@' + m[1];
  return c;
}

/* ── Telegram (без персональных данных) ── */
// Недоставка одному получателю не мешает остальным: каждый чат обрабатывается отдельно.
async function tgNotify(text) {
  if (!TG_BOT_TOKEN || !TG_CHAT_IDS.length) return;
  await Promise.allSettled(TG_CHAT_IDS.map(async chatId => {
    try {
      const r = await fetch(`${TELEGRAM_API_BASE}/bot${TG_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      if (!r.ok) console.error('[tg]', chatId, r.status, await r.text().catch(() => ''));
    } catch (e) { console.error('[tg]', chatId, e.message); }
  }));
}

/* ── статика ── */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.png': 'image/png', '.ico': 'image/x-icon', '.jpg': 'image/jpeg', '.txt': 'text/plain; charset=utf-8',
};
function serveStatic(res, relPath, cacheSec = 86400) {
  const safe = normalize(relPath).replace(/^(\.\.[/\\])+/, '');
  const file = join(SITE_DIR, safe);
  /* запрос каталога (например GET / без Accept: text/html от бота) раньше ронял процесс: readFileSync на папке */
  if (!file.startsWith(normalize(SITE_DIR)) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не найдено');
    return;
  }
  const ext = file.slice(file.lastIndexOf('.'));
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : `public, max-age=${cacheSec}`,
  });
  res.end(readFileSync(file));
}

/* ── basic auth для /admin ── */
function adminAuthed(req, res) {
  if (!ADMIN_USER || !ADMIN_PASS) {
    res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Админка не настроена: задайте ADMIN_USER и ADMIN_PASS в .env');
    return false;
  }
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Basic ')) {
    const [u, ...p] = Buffer.from(h.slice(6), 'base64').toString('utf8').split(':');
    if (u === ADMIN_USER && p.join(':') === ADMIN_PASS) return true;
  }
  res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Lunario admin", charset="UTF-8"' });
  res.end();
  return false;
}

/* ── обработчики ── */
function handleLanding(req, res, url) {
  // предпросмотр конкретного варианта: /?ab=A или /?ab=B —
  // cookie не ставится, счётчик не двигается, события с фронта не шлются
  const forced = url.searchParams.get('ab');
  if (forced === 'A' || forced === 'B') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(pageCache[forced]);
  }
  const cookies = parseCookies(req);
  let v = cookies.lunario_ab;
  let setCookie = false;
  if (v !== 'A' && v !== 'B') {
    const n = Number(metaGet('ab_counter', '0')) + 1;
    metaSet('ab_counter', n);
    v = n % 2 === 1 ? 'A' : 'B';   // строгое чередование
    setCookie = true;
  }
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-cache',
  };
  if (setCookie) {
    headers['Set-Cookie'] = `lunario_ab=${v}; Path=/; Max-Age=7776000; SameSite=Lax; HttpOnly`;
  }
  res.writeHead(200, headers);
  res.end(pageCache[v]);
}

async function handleEvent(req, res) {
  const ip = clientIp(req);
  if (!allowRate(eventRate, ip, EVENT_RATE_MAX)) return json(res, 429, { ok: false });
  let data;
  try { data = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { ok: false }); }
  const type = clean(data.t, 40);
  const variant = data.v === 'B' ? 'B' : 'A';
  if (!EVENT_TYPES.has(type)) return json(res, 400, { ok: false });
  const detail = clean(data.cta || data.q || data.interest || data.utm_source || '', 100);
  db.prepare('INSERT INTO events (ts, type, variant, detail) VALUES (?, ?, ?, ?)')
    .run(new Date().toISOString(), type, variant, detail);
  json(res, 200, { ok: true });
}

async function handleLead(req, res) {
  const ip = clientIp(req);
  let data;
  try { data = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { ok: false, error: 'bad_json' }); }

  // honeypot: боту отвечаем «успехом», ничего не сохраняя
  if (clean(data.website, 10)) return json(res, 200, { ok: true });

  if (!allowRate(leadRate, ip, LEAD_RATE_MAX)) {
    return json(res, 429, { ok: false, error: 'rate_limited' });
  }

  const contact = clean(data.contact, 200);
  if (!contactValid(contact)) return json(res, 400, { ok: false, error: 'bad_contact' });
  if (data.consent_pd !== true) return json(res, 400, { ok: false, error: 'no_consent' });

  const now = new Date().toISOString();
  const cnorm = normContact(contact);
  const dup = db.prepare('SELECT id FROM leads WHERE contact_norm = ?').get(cnorm);
  if (dup) return json(res, 200, { ok: true, duplicate: true });

  const utm = typeof data.utm === 'object' && data.utm ? data.utm : {};
  const interests = Array.isArray(data.interests)
    ? data.interests.map(i => clean(i, 60)).filter(Boolean).slice(0, 10).join('; ')
    : '';
  const variant = data.variant === 'B' ? 'B' : 'A';

  const info = db.prepare(`INSERT INTO leads
    (ts, name, contact, contact_norm, interests, variant,
     utm_source, utm_medium, utm_campaign, utm_content, utm_term,
     ip, ua, consent_pd_version, consent_pd_ts, consent_ads, consent_ads_ts, status)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'new')`).run(
    now, clean(data.name, 120), contact, cnorm, interests, variant,
    clean(utm.utm_source, 200), clean(utm.utm_medium, 200), clean(utm.utm_campaign, 200),
    clean(utm.utm_content, 200), clean(utm.utm_term, 200),
    ip, clean(req.headers['user-agent'], 300),
    CONSENT_VERSION, now, data.consent_ads === true ? 1 : 0, data.consent_ads === true ? now : '');

  const id = info.lastInsertRowid;
  // уведомление БЕЗ персональных данных (152-ФЗ: трансграничная передача)
  tgNotify(`🌙 Новая заявка №${id} — Лунарио · вариант ${variant}\nОткрыть админку: ${PUBLIC_BASE}/admin`);
  json(res, 200, { ok: true, id: Number(id) });
}

function statsQuery() {
  const per = { A: {}, B: {} };
  for (const v of ['A', 'B']) {
    for (const t of EVENT_TYPES) {
      per[v][t] = db.prepare('SELECT COUNT(*) c FROM events WHERE type = ? AND variant = ?').get(t, v).c;
    }
    per[v].leads = db.prepare('SELECT COUNT(*) c FROM leads WHERE variant = ?').get(v).c;
    per[v].conversion = per[v].landing_view ? +(100 * per[v].leads / per[v].landing_view).toFixed(2) : 0;
  }
  return per;
}

const CSV_COLS = ['id', 'ts', 'name', 'contact', 'interests', 'variant',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
  'consent_pd_version', 'consent_pd_ts', 'consent_ads', 'status'];

async function handleAdminApi(req, res, url) {
  if (url.pathname === '/admin/api/leads' && req.method === 'GET') {
    const rows = db.prepare('SELECT * FROM leads ORDER BY id DESC LIMIT 1000').all();
    return json(res, 200, { ok: true, leads: rows, stats: statsQuery() });
  }
  if (url.pathname === '/admin/api/lead' && req.method === 'POST') {
    let data;
    try { data = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { ok: false }); }
    const id = Number(data.id);
    if (!Number.isInteger(id)) return json(res, 400, { ok: false });
    if (data.action === 'delete') {
      db.prepare('DELETE FROM leads WHERE id = ?').run(id);
      return json(res, 200, { ok: true });
    }
    if (STATUSES.includes(data.status)) {
      db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(data.status, id);
      return json(res, 200, { ok: true });
    }
    return json(res, 400, { ok: false });
  }
  if (url.pathname === '/admin/api/export.csv' && req.method === 'GET') {
    const rows = db.prepare('SELECT * FROM leads ORDER BY id').all();
    const esc = s => `"${String(s ?? '').replaceAll('"', '""')}"`;
    const csv = '﻿' + [CSV_COLS.join(';')]
      .concat(rows.map(r => CSV_COLS.map(c => esc(r[c])).join(';')))
      .join('\r\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="lunario-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
    });
    return res.end(csv);
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Не найдено');
}

/* ── сервер ── */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/' && req.method === 'GET') return handleLanding(req, res, url);
    if (url.pathname === '/api/health') return json(res, 200, { ok: true, service: 'lunario-api' });
    if (url.pathname === '/api/event' && req.method === 'POST') return await handleEvent(req, res);
    if (url.pathname === '/api/lead' && req.method === 'POST') return await handleLead(req, res);

    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      if (!adminAuthed(req, res)) return;
      if (url.pathname === '/admin' || url.pathname === '/admin/') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(readFileSync(join(__dirname, 'admin.html')));
      }
      return await handleAdminApi(req, res, url);
    }

    // Интерактивный прототип приложения (переехал с withoutwater.ru 16.08)
    // старый интерактивный прототип (кремовая ДС v1, до редизайна) с отдачи снят 12.09.2026 — файл остаётся в репозитории
    if (url.pathname === '/prototype' || url.pathname === '/prototype/' || url.pathname === '/prototype.html') { res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('Страница больше не доступна'); }
    if (url.pathname === '/chto-vnutri' || url.pathname === '/chto-vnutri/') return serveStatic(res, 'chto-vnutri.html');
    if (url.pathname === '/politika') return serveStatic(res, 'politika.html');
    if (url.pathname === '/soglasie') return serveStatic(res, 'soglasie.html');
    // service worker лендинга: без кэша, иначе правки доедут до людей с задержкой
    if (url.pathname === '/sw.js') return serveStatic(res, 'sw.js', 0);
    if (url.pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`User-agent: *\nAllow: /\nDisallow: /admin\nSitemap: ${PUBLIC_BASE}/sitemap.xml\n`);
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && !url.pathname.includes('..')) return serveStatic(res, url.pathname);

    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Не найдено');
  } catch (e) {
    console.error('[server]', e);
    if (res.headersSent) { try { res.end(); } catch {} return; }   /* заголовки уже ушли — второй writeHead уронил бы процесс */
    json(res, 500, { ok: false, error: 'internal' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`lunario-api: http://${HOST}:${PORT} · site=${SITE_DIR} · db=${DB_FILE} · metrika=${METRIKA_ID || 'нет'} · tg=${TG_BOT_TOKEN ? 'настроен' : 'нет'}`);
});
