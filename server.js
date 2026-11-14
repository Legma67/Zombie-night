// Zombie Night Survival – eigener Server
// Liefert das Spiel aus und kümmert sich um: Mehrspieler (wer gerade online ist und was er tut),
// Bestenliste, Cloud-Speicher und Clans.
//
// Einstellungen (Umgebungsvariablen):
//   PORT          Port für Web und WebSocket (Standard 8080; Hoster setzen ihn meist selbst)
//   ADMIN_SECRET  geheimes Wort: wer das Spiel einmal mit ?admin=<wort> öffnet, wird Besitzer (unendlich Münzen)
//   DATABASE_URL  Postgres-Datenbank (z. B. von Neon, Supabase oder Render). Ohne sie speichert der Server in eine Datei.
//   DATA_DIR      Ordner für die Datei-Speicherung (Standard ./data)
//   MAX_PLAYERS   wie viele gleichzeitig verbunden sein dürfen (Standard 300)
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080, ADMIN = process.env.ADMIN_SECRET || '', DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_PLAYERS = +process.env.MAX_PLAYERS || 300, PER_IP = 8, PRESENCE_MAX = 4096, DOC_MAX = 4096, PROFILE_MAX = 256 * 1024;
const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);

/* ---------- storage: every document lives in memory and is written to Postgres or a file ---------- */
const docs = new Map(); let owners = new Set(); const dirty = new Set(); let pg = null, fileDirty = false;
const FILE = path.join(DATA_DIR, 'spiel-daten.json');
async function loadStore() {
  // the database address, also when it was pasted with extras like  psql '...'  or  DATABASE_URL="..."
  let url = String(process.env.DATABASE_URL || '').trim().replace(/^DATABASE_URL\s*=\s*/i, '').replace(/^psql\s+/i, '').replace(/^['"]|['"]$/g, '').trim();
  if (url && !/^postgres(ql)?:\/\/[^@]+@[^/]+\//.test(url)) { log('ACHTUNG: DATABASE_URL sieht nicht wie eine Datenbank-Adresse aus (muss mit postgresql:// anfangen). Der Server speichert jetzt nur in eine Datei.'); url = ''; }
  if (url) try {
    const { Pool } = require('pg'); const local = /localhost|127\.0\.0\.1/.test(url);
    pg = new Pool({ connectionString: url, ssl: local ? false : { rejectUnauthorized: false }, max: 4 });
    pg.on('error', e => log('Datenbank-Verbindung kurz weg (wird neu aufgebaut):', e.message)); // e.g. a free database that sleeps when idle
    await pg.query('create table if not exists zns_docs (path text primary key, data jsonb not null, t bigint not null)');
    const r = await pg.query('select path, data from zns_docs'); for (const row of r.rows) { if (row.path === '_owners') owners = new Set(row.data.list || []); else docs.set(row.path, row.data); }
    log('Postgres verbunden,', docs.size, 'Einträge geladen'); return;
  } catch (e) { log('ACHTUNG: Datenbank nicht erreichbar (' + e.message + '). Prüfe DATABASE_URL. Der Server läuft trotzdem und speichert so lange nur in eine Datei.'); try { await pg.end(); } catch (er) { /* ignore */ } pg = null; docs.clear(); }
  {
    try { const j = JSON.parse(fs.readFileSync(FILE, 'utf8')); for (const k in j.docs || {}) docs.set(k, j.docs[k]); owners = new Set(j.owners || []); log('Datei geladen,', docs.size, 'Einträge'); }
    catch (e) { if (e.code !== 'ENOENT') log('Datei konnte nicht gelesen werden:', e.message); else log('Neue, leere Datenbank (Datei)'); }
  }
}
function touch(p) { if (pg) dirty.add(p); else fileDirty = true; }
let flushing = false;
async function flush() {
  if (flushing) return; flushing = true;
  try {
    if (pg) { const keys = Array.from(dirty); dirty.clear();
      for (const k of keys) { try { if (k === '_owners') await pg.query('insert into zns_docs (path, data, t) values ($1, $2, $3) on conflict (path) do update set data = excluded.data, t = excluded.t', [k, { list: Array.from(owners) }, Date.now()]);
          else if (docs.has(k)) await pg.query('insert into zns_docs (path, data, t) values ($1, $2, $3) on conflict (path) do update set data = excluded.data, t = excluded.t', [k, docs.get(k), Date.now()]);
          else await pg.query('delete from zns_docs where path = $1', [k]); } catch (e) { dirty.add(k); log('Speichern fehlgeschlagen:', e.message); break; } } }
    else if (fileDirty) { fileDirty = false; fs.mkdirSync(DATA_DIR, { recursive: true }); const o = { owners: Array.from(owners), docs: Object.fromEntries(docs) }; fs.writeFileSync(FILE + '.tmp', JSON.stringify(o)); fs.renameSync(FILE + '.tmp', FILE); }
  } catch (e) { log('Speichern fehlgeschlagen:', e.message); fileDirty = true; }
  flushing = false;
}

/* ---------- who may read and write what ---------- */
// scores/<id>, clans/<id>, cmembers/<id>: everybody reads, only the player <id> writes his own
// data/users/<id>/profile: only the player himself
const PUB = /^(scores|clans|cmembers)\/([A-Za-z0-9_-]{4,40})$/, PRIV = /^data\/users\/([A-Za-z0-9_-]{4,40})\/profile$/;
function canRead(p, uid) { const a = PUB.exec(p); if (a) return true; const b = PRIV.exec(p); return !!b && b[1] === uid; }
function canWrite(p, uid) { const a = PUB.exec(p); if (a) return a[2] === uid; const b = PRIV.exec(p); return !!b && b[1] === uid; }
const sizeOf = d => Buffer.byteLength(JSON.stringify(d));
const plain = d => d && typeof d === 'object' && !Array.isArray(d);

/* ---------- the game page ---------- */
const PAGE = path.join(__dirname, 'public', 'index.html');
let page = null;
// the page knows it runs on this server, and gets what a phone needs to install it as an app
const APP_HEAD = '<script>window.ZNS_SERVER = 1;</script><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#1c0e3c"><link rel="icon" href="/icon-192.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Zombie Night">';
function pageHtml() { if (!page) { const h = fs.readFileSync(PAGE, 'utf8'); page = h.replace('<head>', '<head>' + APP_HEAD); } return page; }
const FILES = { '/manifest.webmanifest': 'application/manifest+json', '/sw.js': 'text/javascript', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/icon-maskable.png': 'image/png', '/apple-touch-icon.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok ' + clients.size + ' online'); return; }
  if (u === '/' || u === '/index.html') { try { const b = pageHtml(); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' }); res.end(b); } catch (e) { res.writeHead(500); res.end('Spiel-Datei fehlt (public/index.html)'); } return; }
  if (FILES[u]) { fs.readFile(path.join(__dirname, 'public', u.slice(1)), (e, b) => { if (e) { res.writeHead(404); res.end(); return; } res.writeHead(200, { 'content-type': FILES[u], 'cache-control': u === '/sw.js' ? 'no-cache' : 'public, max-age=86400' }); res.end(b); }); return; }
  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('nicht gefunden');
});

/* ---------- live connections ---------- */
const clients = new Map(), perIp = new Map(), subs = new Map(); let peerN = 0;
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: PROFILE_MAX + 4096 });
const send = (c, m) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(m)); };
function toAll(m, except) { const s = JSON.stringify(m); for (const c of clients.values()) if (c !== except && c.uid && c.ws.readyState === 1) c.ws.send(s); }
function snapshot(sub) {
  const pre = sub.coll + '/', out = []; for (const [k, v] of docs) if (k.startsWith(pre) && k.indexOf('/', pre.length) < 0) out.push({ id: k.slice(pre.length), d: v });
  if (sub.order) { const [f, dir] = sub.order, s = dir === 'desc' ? -1 : 1; out.sort((a, b) => ((+a.d[f] || 0) - (+b.d[f] || 0)) * s); }
  return out.slice(0, sub.lim);
}
// changes reach the people who watch that collection, at most a few times per second
const pending = new Set(); let pendT = null;
function changed(p) { const coll = p.split('/')[0]; pending.add(coll); if (!pendT) pendT = setTimeout(() => { pendT = null; const cs = Array.from(pending); pending.clear(); for (const sub of subs.values()) if (cs.includes(sub.coll)) send(sub.c, { t: 'snap', sid: sub.sid, docs: snapshot(sub) }); }, 250); }

wss.on('connection', (ws, req) => {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (clients.size >= MAX_PLAYERS || (perIp.get(ip) || 0) >= PER_IP) { ws.close(1013, 'voll'); return; }
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  const c = { ws, ip, peer: 'p' + (++peerN).toString(36) + crypto.randomBytes(3).toString('hex'), uid: null, owner: false, presence: {}, tokens: 80, last: Date.now(), alive: true, subs: new Set() };
  clients.set(c.peer, c);
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', raw => {
    // a few messages per second are plenty; whoever floods is cut off
    const now = Date.now(); c.tokens = Math.min(80, c.tokens + (now - c.last) * 0.04); c.last = now; if (c.tokens < 1) { if (c.tokens < -200) ws.close(1008, 'zu viele Nachrichten'); c.tokens -= 1; return; } c.tokens -= 1;
    let m; try { m = JSON.parse(raw); } catch (e) { return; } if (!m || typeof m.t !== 'string') return;
    if (!c.uid) { if (m.t !== 'hi' || typeof m.key !== 'string' || m.key.length < 16 || m.key.length > 80) return; hello(c, m); return; }
    try { handle(c, m); } catch (e) { log('Fehler:', e.message); }
  });
  ws.on('close', () => { clients.delete(c.peer); const n = (perIp.get(ip) || 1) - 1; if (n <= 0) perIp.delete(ip); else perIp.set(ip, n); for (const sid of c.subs) subs.delete(c.peer + ':' + sid); if (c.uid) toAll({ t: 'left', peer: c.peer }); });
  ws.on('error', () => { });
});
function hello(c, m) {
  c.uid = crypto.createHash('sha256').update('zns:' + m.key).digest('base64url').slice(0, 20);
  if (ADMIN && typeof m.admin === 'string' && m.admin.length >= 4 && crypto.timingSafeEqual(crypto.createHash('sha256').update(m.admin).digest(), crypto.createHash('sha256').update(ADMIN).digest())) { owners.add(c.uid); touch('_owners'); log('Neuer Besitzer:', c.uid); }
  c.owner = owners.has(c.uid);
  const list = []; for (const o of clients.values()) if (o !== c && o.uid) list.push({ peer: o.peer, p: o.presence });
  send(c, { t: 'welcome', peer: c.peer, uid: c.uid, owner: c.owner, peers: list });
}
function handle(c, m) {
  const reply = (o) => send(c, Object.assign({ t: 'res', rid: m.rid }, o)), no = code => reply({ ok: false, code });
  switch (m.t) {
    case 'p': { if (!plain(m.d) || sizeOf(m.d) > PRESENCE_MAX) return; c.presence = m.d; toAll({ t: 'pp', peer: c.peer, p: m.d }, c); return; }
    case 'get': { if (typeof m.path !== 'string' || !canRead(m.path, c.uid)) return no('not_permitted'); const d = docs.get(m.path); return reply({ ok: true, exists: d !== undefined, data: d === undefined ? null : d }); }
    case 'set': case 'update': {
      if (typeof m.path !== 'string' || !canWrite(m.path, c.uid)) return no('not_permitted'); if (!plain(m.data)) return no('invalid_argument');
      const d = m.t === 'update' ? Object.assign({}, docs.get(m.path) || {}, m.data) : m.data; if (sizeOf(d) > (PRIV.test(m.path) ? PROFILE_MAX : DOC_MAX)) return no('invalid_argument');
      docs.set(m.path, d); touch(m.path); changed(m.path); return reply({ ok: true }); }
    case 'delete': { if (typeof m.path !== 'string' || !canWrite(m.path, c.uid)) return no('not_permitted'); docs.delete(m.path); touch(m.path); changed(m.path); return reply({ ok: true }); }
    case 'sub': { if (!['scores', 'clans', 'cmembers'].includes(m.coll) || typeof m.sid !== 'number' || c.subs.size > 20) return; const order = Array.isArray(m.order) && typeof m.order[0] === 'string' && m.order[0].length < 30 ? [m.order[0], m.order[1] === 'desc' ? 'desc' : 'asc'] : null;
      const sub = { c, sid: m.sid, coll: m.coll, order, lim: Math.max(1, Math.min(2000, m.lim | 0 || 100)) }; subs.set(c.peer + ':' + m.sid, sub); c.subs.add(m.sid); send(c, { t: 'snap', sid: m.sid, docs: snapshot(sub) }); return; }
    case 'unsub': { subs.delete(c.peer + ':' + m.sid); c.subs.delete(m.sid); return; }
  }
}
// drop connections that stopped answering
setInterval(() => { for (const c of clients.values()) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch (e) { /* ignore */ } } }, 30000);
setInterval(flush, 3000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { log('Server stoppt, speichere ...'); await flush(); process.exit(0); });

loadStore().then(() => server.listen(PORT, () => log('Zombie Night Survival läuft auf Port', PORT, pg ? '(Postgres)' : '(Datei ' + FILE + ')', ADMIN ? '' : '– ohne ADMIN_SECRET gibt es keinen Besitzer')))
  .catch(e => { console.error('Start fehlgeschlagen:', e.message); process.exit(1); });
