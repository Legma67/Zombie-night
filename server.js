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
//   MAINTENANCE   wenn gesetzt (z. B. "Wir bauen neue Türme ein"): Wartung, nur der Besitzer kommt rein
//
// Updates: Sobald eine neue Version startet, schaltet sie die alte ab. Die alte Version beendet alle Runden,
// speichert alles und meldet sich ab; erst dann lädt die neue Version die Daten und lässt Spieler rein.
// Bis dahin sehen alle „Update wird installiert“, danach lädt das Spiel bei allen von selbst neu.
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = +process.env.PORT || 8080, ADMIN = process.env.ADMIN_SECRET || '', DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const MAX_PLAYERS = +process.env.MAX_PLAYERS || 300, PER_IP = 8, PRESENCE_MAX = 4096, DOC_MAX = 4096, PROFILE_MAX = 256 * 1024;
const BOOT = crypto.randomBytes(6).toString('hex'), START = Date.now(); let upd = 'start', how = ''; // 'start' = new version waits for the old one, 'stop' = old version hands over, null = open
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
    const r = await pg.query('select path, data from zns_docs'); for (const row of r.rows) { if (row.path.startsWith('_sys/')) continue; if (row.path === '_owners') owners = new Set(row.data.list || []); else docs.set(row.path, row.data); }
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

/* ---------- updates: the new version takes over from the old one without losing anything ---------- */
const sysSet = (k, d) => pg.query('insert into zns_docs (path, data, t) values ($1, $2, $3) on conflict (path) do update set data = excluded.data, t = excluded.t', ['_sys/' + k, d, Date.now()]);
const sysGet = async k => { const r = await pg.query('select data from zns_docs where path = $1', ['_sys/' + k]); return r.rows[0] ? r.rows[0].data : null; };
async function reload() { const r = await pg.query('select path, data from zns_docs'); docs.clear(); for (const row of r.rows) { if (row.path.startsWith('_sys/')) continue; if (row.path === '_owners') owners = new Set(row.data.list || []); else docs.set(row.path, row.data); } }
// the old version: end everything, save, tell the new version it may start
async function handOver(why) {
  if (upd === 'stop') return; upd = 'stop'; log('Neue Version ist da (' + why + '): alle Spieler bekommen „Update“, speichere ...');
  for (const c of clients.values()) send(c, { t: 'maint', why: 'update' });
  await new Promise(r => setTimeout(r, 2000)); // the players end their round and send their last save
  for (const c of clients.values()) try { c.ws.close(4003, 'update'); } catch (e) { /* ignore */ }
  for (let i = 0; i < 5 && (dirty.size || flushing); i++) { await flush(); await new Promise(r => setTimeout(r, 300)); }
  if (pg) try { await sysSet('handoff', { boot: BOOT, t: Date.now() }); log('Übergabe an die neue Version fertig'); } catch (e) { log('Übergabe fehlgeschlagen:', e.message); }
}
async function startUp() {
  if (!pg) { upd = null; how = 'datei'; return; }
  try {
    const alive = await sysGet('alive'), h0 = await sysGet('handoff'); await sysSet('deploy', { boot: BOOT, t: START });
    if (!alive || alive.boot === BOOT || Date.now() - alive.t > 20000 || (h0 && h0.boot === alive.boot)) { upd = null; how = 'frei'; log('Keine ältere Version läuft, Spiel ist offen'); }
    else log('Ältere Version läuft noch, warte auf ihre Übergabe ...');
  } catch (e) { upd = null; log('Update-Abstimmung fehlgeschlagen:', e.message); }
  setInterval(async () => { try {
    if (upd === 'start') { const h = await sysGet('handoff'), a = await sysGet('alive'), late = Date.now() - START > 90000; // never wait forever
      const gone = !a || Date.now() - a.t > 15000 || (h && h.boot === a.boot); // the old one handed over, or crashed
      if (gone || late) { await reload(); upd = null; how = late ? 'zeit' : h && a && h.boot === a.boot ? 'übergabe' : 'alte weg'; log(late ? 'Alte Version hat sich nicht gemeldet, starte trotzdem' : 'Daten übernommen, Spiel ist offen,', docs.size, 'Einträge'); } return; }
    if (upd === 'stop') return;
    const d = await sysGet('deploy'); if (d && d.boot !== BOOT && d.t > START) { await handOver('Deploy'); return; }
    await sysSet('alive', { boot: BOOT, t: Date.now() });
  } catch (e) { /* database asleep for a moment */ } }, 3000);
}
// maintenance by hand: MAINTENANCE on the host, or the owner switches it in the game
const maintText = () => process.env.MAINTENANCE ? String(process.env.MAINTENANCE) : (docs.get('_maint') || {}).text || '';
const maintOn = () => !!process.env.MAINTENANCE || !!(docs.get('_maint') || {}).on;

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
let BUILD = ''; try { BUILD = crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, 'public', 'index.html'))).digest('hex').slice(0, 12); } catch (e) { /* no page */ }
const APP_HEAD = '<script>window.ZNS_SERVER = 1; window.ZNS_BUILD = "' + BUILD + '";</script><link rel="manifest" href="/manifest.webmanifest"><meta name="theme-color" content="#1c0e3c"><link rel="icon" href="/icon-192.png"><link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="Zombie Night">';
function pageHtml() { if (!page) { const h = fs.readFileSync(PAGE, 'utf8'); page = h.replace('<head>', '<head>' + APP_HEAD); } return page; }
const FILES = { '/manifest.webmanifest': 'application/manifest+json', '/sw.js': 'text/javascript', '/icon-192.png': 'image/png', '/icon-512.png': 'image/png', '/icon-maskable.png': 'image/png', '/apple-touch-icon.png': 'image/png' };
const server = http.createServer((req, res) => {
  const u = req.url.split('?')[0];
  if (u === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok ' + clients.size + ' online' + (pg ? ' db' : ' datei') + (how ? ' start=' + how : '') + (upd ? ' (Update: ' + upd + ')' : maintOn() ? ' (Wartung)' : '') + ' ' + BUILD); return; }
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
/* ---------- accounts: name + password, so a player keeps his progress on every device ---------- */
const ACC_RE = /^[A-Za-z0-9_äöüÄÖÜß]{3,16}$/, tries = new Map();
const accPath = n => '_acc/' + n.toLowerCase(), tokPath = t => '_tok/' + crypto.createHash('sha256').update('t:' + t).digest('base64url');
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString('base64');
// the player's browser keeps a signed copy of his account; should the server ever lose its data, the account comes back from there
const ACC_KEY = process.env.ACCOUNT_SECRET || ADMIN;
const recSig = r => crypto.createHmac('sha256', 'acc:' + ACC_KEY).update([r.n, r.s, r.h, r.u].join('|')).digest('base64url');
const makeRec = a => { if (!ACC_KEY) return null; const r = { n: a.name, s: a.salt, h: a.hash, u: a.uid }; r.sig = recSig(r); return r; };
function restore(r, tok) {
  if (!ACC_KEY || !r || typeof r !== 'object' || [r.n, r.s, r.h, r.u, r.sig].some(v => typeof v !== 'string' || v.length > 200) || !ACC_RE.test(r.n)) return null;
  const g = Buffer.from(recSig(r)), h = Buffer.from(r.sig); if (g.length !== h.length || !crypto.timingSafeEqual(g, h)) return null;
  const a = docs.get(accPath(r.n)); if (a && a.uid !== r.u) return null; // the name belongs to somebody else now
  if (!a) { docs.set(accPath(r.n), { name: r.n, salt: r.s, hash: r.h, uid: r.u, t: Date.now() }); touch(accPath(r.n)); log('Konto wiederhergestellt:', r.n); }
  docs.set(tokPath(tok), { uid: r.u, user: r.n, t: Date.now() }); touch(tokPath(tok)); return { uid: r.u, user: r.n };
}
function tooMany(ip) { const now = Date.now(), a = (tries.get(ip) || []).filter(t => now - t < 10 * 60 * 1000); tries.set(ip, a); return a.length >= 15; }
function newToken(uid, user) { const t = crypto.randomBytes(24).toString('base64url'); docs.set(tokPath(t), { uid, user, t: Date.now() }); touch(tokPath(t)); return t; }
function account(c, m, reply) {
  const user = typeof m.user === 'string' ? m.user.trim() : '', pw = typeof m.pw === 'string' ? m.pw : '';
  if (m.t === 'logout') { if (typeof m.tok === 'string') { docs.delete(tokPath(m.tok)); touch(tokPath(m.tok)); } return reply({ ok: true }); }
  if (tooMany(c.ip)) return reply({ ok: false, code: 'too_many' }); tries.get(c.ip).push(Date.now());
  if (!ACC_RE.test(user)) return reply({ ok: false, code: 'bad_name' }); if (pw.length < 6 || pw.length > 100) return reply({ ok: false, code: 'bad_pw' });
  const a = docs.get(accPath(user));
  if (m.t === 'register') { if (a) return reply({ ok: false, code: 'taken' });
    const owned = Array.from(docs.entries()).some(([k, v]) => k.startsWith('_acc/') && v.uid === c.uid);
    if (owned) return reply({ ok: false, code: 'has_account' });
    const salt = crypto.randomBytes(16).toString('base64'); const na = { name: user, salt, hash: hashPw(pw, salt), uid: c.uid, t: Date.now() }; docs.set(accPath(user), na); touch(accPath(user)); log('Neues Konto:', user);
    return reply({ ok: true, tok: newToken(c.uid, user), user, rec: makeRec(na) }); }
  if (!a) return reply({ ok: false, code: 'wrong' });
  const h = Buffer.from(hashPw(pw, a.salt)), g = Buffer.from(a.hash); if (h.length !== g.length || !crypto.timingSafeEqual(h, g)) return reply({ ok: false, code: 'wrong' });
  return reply({ ok: true, tok: newToken(a.uid, a.name), user: a.name, rec: makeRec(a) });
}
function hello(c, m) {
  c.uid = crypto.createHash('sha256').update('zns:' + m.key).digest('base64url').slice(0, 20); c.user = null;
  if (typeof m.tok === 'string' && m.tok.length < 80) { const t = docs.get(tokPath(m.tok)); if (t && t.uid) { c.uid = t.uid; c.user = t.user || null; } else { const r = restore(m.acc, m.tok); if (r) { c.uid = r.uid; c.user = r.user; } } }
  if (ADMIN && typeof m.admin === 'string' && m.admin.length >= 4 && crypto.timingSafeEqual(crypto.createHash('sha256').update(m.admin).digest(), crypto.createHash('sha256').update(ADMIN).digest())) { owners.add(c.uid); touch('_owners'); log('Neuer Besitzer:', c.uid); }
  c.owner = owners.has(c.uid);
  if (upd) { send(c, { t: 'maint', why: 'update' }); c.ws.close(4003, 'update'); return; }
  if (maintOn() && !c.owner) { send(c, { t: 'maint', why: 'manual', text: maintText() }); c.ws.close(4003, 'wartung'); return; }
  // one player = one connection: an older tab or a sleeping app of the same player is closed, so nobody sees a double
  for (const o of clients.values()) if (o !== c && o.uid === c.uid) { try { o.ws.close(4001, 'anderswo geöffnet'); } catch (e) { /* ignore */ } }
  const list = []; for (const o of clients.values()) if (o !== c && o.uid) list.push({ peer: o.peer, p: o.presence });
  send(c, { t: 'welcome', peer: c.peer, uid: c.uid, owner: c.owner, user: c.user, build: BUILD, maint: maintOn() ? maintText() || true : false, peers: list });
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
    case 'register': case 'login': case 'logout': return account(c, m, o => reply(o));
    case 'maint': { if (!c.owner) return no('not_permitted'); const on = !!m.on, text = typeof m.text === 'string' ? m.text.slice(0, 200) : ''; docs.set('_maint', { on, text }); touch('_maint'); log('Wartung', on ? 'AN' : 'aus', text);
      if (on) for (const o of clients.values()) if (o.uid && !o.owner) { send(o, { t: 'maint', why: 'manual', text }); setTimeout(() => { try { o.ws.close(4003, 'wartung'); } catch (e) { /* ignore */ } }, 2000); }
      return reply({ ok: true, on }); }
    case 'unsub': { subs.delete(c.peer + ':' + m.sid); c.subs.delete(m.sid); return; }
  }
}
// drop connections that stopped answering
setInterval(() => { for (const c of clients.values()) { if (!c.alive) { c.ws.terminate(); continue; } c.alive = false; try { c.ws.ping(); } catch (e) { /* ignore */ } } }, 30000);
setInterval(flush, 3000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { log('Server stoppt, speichere ...'); if (upd !== 'start') await handOver('Signal'); await flush(); process.exit(0); });

loadStore().then(startUp).then(() => server.listen(PORT, () => log('Zombie Night Survival läuft auf Port', PORT, pg ? '(Postgres)' : '(Datei ' + FILE + ')', ADMIN ? '' : '– ohne ADMIN_SECRET gibt es keinen Besitzer')))
  .catch(e => { console.error('Start fehlgeschlagen:', e.message); process.exit(1); });
