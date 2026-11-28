import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const { BOT_TOKEN: BOT, PORT = 3000, ORIGIN } = process.env;
if (!BOT) throw new Error('BOT_TOKEN missing in .env');
const ADMINS = (process.env.ADMIN_IDS || '').split(',').map(Number).filter(Boolean);
const CHANNELS = (process.env.CHANNELS || '').split(',').map(s => s.trim()).filter(Boolean);
const M = 1000; // 1 DOGS = 1000 unit। পূর্ণসংখ্যায় রাখলে দশমিকের হিসাব ভুল হয় না

/* ---------- ডাটাবেস ---------- */
const db = new Database(process.env.DB_PATH || 'dogs.db');
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, username TEXT, name TEXT,
  balance INTEGER NOT NULL DEFAULT 0 CHECK(balance>=0),
  mine_end INTEGER NOT NULL DEFAULT 0, last_daily INTEGER NOT NULL DEFAULT 0,
  referrer INTEGER, ref_earned INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0, banned INTEGER NOT NULL DEFAULT 0, created INTEGER);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS tasks(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, reward INTEGER, chat TEXT, url TEXT);
CREATE TABLE IF NOT EXISTS user_tasks(user_id INTEGER, task_id INTEGER, PRIMARY KEY(user_id,task_id));
CREATE TABLE IF NOT EXISTS nfts(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, emoji TEXT, price INTEGER, boost INTEGER);
CREATE TABLE IF NOT EXISTS user_nfts(user_id INTEGER, nft_id INTEGER, PRIMARY KEY(user_id,nft_id));
CREATE TABLE IF NOT EXISTS withdrawals(id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, amount INTEGER, wallet TEXT, status TEXT DEFAULT 'pending', created INTEGER);
CREATE TABLE IF NOT EXISTS deposits(hash TEXT PRIMARY KEY, user_id INTEGER, ton REAL, dogs INTEGER, created INTEGER);
`);

const DEFAULTS = {
  mining:   { rate: 1, session: 4, daily: 50 },
  deposit:  { address: '', rate: 100, min: 1 },
  referral: { bonus: 50, every: 10, reward: 200 },
  withdraw: { min: 100 },
  general:  { bot: '', support: '', maint: false },
};
for (const [k, v] of Object.entries(DEFAULTS))
  db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run(k, JSON.stringify(v));
if (!db.prepare('SELECT 1 FROM nfts').get())
  for (const n of [['DOGS King','🐶',100,200],['Cool Dog','😎',60,120],['Cap Dog','🧢',40,80]])
    db.prepare('INSERT INTO nfts(name,emoji,price,boost) VALUES (?,?,?,?)').run(n[0], n[1], n[2] * M, n[3]);
if (!db.prepare('SELECT 1 FROM tasks').get())
  for (const t of [['Join our YouTube',null],['Join our Telegram','@DogsOfficial'],['Follow on X',null],['Like our Post',null]])
    db.prepare('INSERT INTO tasks(title,reward,chat) VALUES (?,?,?)').run(t[0], 50 * M, t[1]);

/* ---------- হেল্পার ---------- */
const S = () => Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(r => [r.key, JSON.parse(r.value)]));
const get = id => db.prepare('SELECT * FROM users WHERE id=?').get(id);
const speedOf = id => 100 + db.prepare('SELECT COALESCE(SUM(n.boost),0) s FROM user_nfts u JOIN nfts n ON n.id=u.nft_id WHERE u.user_id=?').get(id).s;
const credit = (id, amt) => db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(amt, id);
const debit = (id, amt) => db.prepare('UPDATE users SET balance=balance-? WHERE id=? AND balance>=?').run(amt, id, amt).changes === 1;
const wrap = fn => (q, s, n) => Promise.resolve(fn(q, s, n)).catch(n);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

async function isMember(chat, uid) {
  const r = await fetch(`https://api.telegram.org/bot${BOT}/getChatMember?chat_id=${encodeURIComponent(chat)}&user_id=${uid}`).then(r => r.json());
  return !!r.ok && ['member', 'administrator', 'creator'].includes(r.result.status);
}

/* ---------- Telegram initData যাচাই (সবচেয়ে গুরুত্বপূর্ণ নিরাপত্তা ধাপ) ---------- */
function parseInitData(raw) {
  const p = new URLSearchParams(raw);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const str = [...p.entries()].map(([k, v]) => `${k}=${v}`).sort().join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT).digest();
  const calc = Buffer.from(crypto.createHmac('sha256', secret).update(str).digest('hex'));
  const got = Buffer.from(hash);
  if (calc.length !== got.length || !crypto.timingSafeEqual(calc, got)) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return { user: JSON.parse(p.get('user')), start: p.get('start_param') }; } catch { return null; }
}

const createUser = db.transaction((id, username, name, start) => {
  const m = /^ref_(\d+)$/.exec(start || '');
  const ref = m && +m[1] !== id && get(+m[1]) ? +m[1] : null;
  db.prepare('INSERT INTO users(id,username,name,referrer,created) VALUES (?,?,?,?,?)').run(id, username || null, name || '', ref, Date.now());
  if (ref) {
    const r = S().referral;
    let bonus = Math.round(r.bonus * M);
    const n = db.prepare('SELECT COUNT(*) c FROM users WHERE referrer=?').get(ref).c;
    if (r.every > 0 && n % r.every === 0) bonus += Math.round(r.reward * M); // মাইলস্টোন বোনাস
    db.prepare('UPDATE users SET balance=balance+?, ref_earned=ref_earned+? WHERE id=?').run(bonus, bonus, ref);
  }
});

function auth(req, res, next) {
  const d = parseInitData((req.headers.authorization || '').replace(/^tma /, ''));
  if (!d) return bad(res, 'Invalid initData', 401);
  const { id, username, first_name } = d.user;
  if (!get(id)) createUser(id, username, first_name, d.start);
  const u = get(id);
  if (u.banned) return bad(res, 'Account banned', 403);
  if (S().general.maint && !ADMINS.includes(id)) return bad(res, 'Maintenance', 503);
  req.u = u;
  next();
}
const ready = (req, res, next) => (CHANNELS.length && !req.u.verified ? bad(res, 'Join channels first', 403) : next());
const admin = (req, res, next) => (ADMINS.includes(req.u.id) ? next() : bad(res, 'Forbidden', 403));

function profile(id) {
  const u = get(id), st = S();
  return {
    id: u.id, username: u.username, balance: u.balance / M, verified: !!u.verified, isAdmin: ADMINS.includes(id),
    mining: { endsAt: u.mine_end, speed: speedOf(id), rate: st.mining.rate, session: st.mining.session },
    nextDailyAt: u.last_daily + 86400e3,
    invited: db.prepare('SELECT COUNT(*) c FROM users WHERE referrer=?').get(id).c, refEarned: u.ref_earned / M,
  };
}

/* ---------- অ্যাপ ---------- */
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '20kb' }));
app.use(cors({ origin: ORIGIN || false }));
app.use('/api', rateLimit({ windowMs: 60_000, limit: 120 }));
app.use(express.static('public')); // public/index.html = মিনি অ্যাপ, public/admin.html = অ্যাডমিন

app.get('/api/config', (q, s) => s.json({ botApp: process.env.BOT_APP || '', channels: CHANNELS.map(c => c.replace(/^@/, '')), usd: Number(process.env.USD_PRICE) || 0.001031 }));
app.get('/api/me', auth, (q, s) => s.json(profile(q.u.id)));

app.post('/api/verify', auth, wrap(async (q, s) => {
  for (const c of CHANNELS) if (!(await isMember(c, q.u.id))) return bad(s, `Join ${c} first`);
  db.prepare('UPDATE users SET verified=1 WHERE id=?').run(q.u.id);
  s.json(profile(q.u.id));
}));

/* মাইনিং: সময় সবসময় সার্ভারের ঘড়িতে গোনা হয়, ক্লায়েন্টের নয় */
app.post('/api/mining/start', auth, ready, (q, s) => {
  if (q.u.mine_end > 0) return bad(s, 'Session already running or unclaimed');
  db.prepare('UPDATE users SET mine_end=? WHERE id=?').run(Date.now() + S().mining.session * 3600e3, q.u.id);
  s.json(profile(q.u.id));
});
app.post('/api/mining/claim', auth, ready, (q, s) => {
  const u = q.u;
  if (!u.mine_end || Date.now() < u.mine_end) return bad(s, 'Session not finished');
  const m = S().mining, reward = Math.round(m.rate * m.session * speedOf(u.id) / 100 * M);
  db.transaction(() => { credit(u.id, reward); db.prepare('UPDATE users SET mine_end=0 WHERE id=?').run(u.id); })();
  s.json({ reward: reward / M, ...profile(u.id) });
});
app.post('/api/daily', auth, ready, (q, s) => {
  if (Date.now() < q.u.last_daily + 86400e3) return bad(s, 'Already claimed today');
  db.transaction(() => { credit(q.u.id, Math.round(S().mining.daily * M)); db.prepare('UPDATE users SET last_daily=? WHERE id=?').run(Date.now(), q.u.id); })();
  s.json(profile(q.u.id));
});

/* টাস্ক */
app.get('/api/tasks', auth, (q, s) => s.json(db.prepare(
  'SELECT t.id,t.title,t.reward/?1.0 AS reward,t.url,t.chat, EXISTS(SELECT 1 FROM user_tasks x WHERE x.task_id=t.id AND x.user_id=?) AS done FROM tasks t').all(M, q.u.id)));
app.post('/api/tasks/:id/complete', auth, ready, wrap(async (q, s) => {
  const t = db.prepare('SELECT * FROM tasks WHERE id=?').get(+q.params.id);
  if (!t) return bad(s, 'No such task', 404);
  if (t.chat && !(await isMember(t.chat, q.u.id))) return bad(s, 'Task not completed yet');
  const ok = db.transaction(() => {
    if (!db.prepare('INSERT OR IGNORE INTO user_tasks VALUES (?,?)').run(q.u.id, t.id).changes) return false; // ডাবল ক্লেইম ঠেকায়
    credit(q.u.id, t.reward); return true;
  })();
  ok ? s.json(profile(q.u.id)) : bad(s, 'Already done', 409);
}));

/* NFT */
app.get('/api/nfts', auth, (q, s) => s.json(db.prepare(
  'SELECT n.id,n.name,n.emoji,n.price/?1.0 AS price,n.boost, EXISTS(SELECT 1 FROM user_nfts u WHERE u.nft_id=n.id AND u.user_id=?) AS owned FROM nfts n').all(M, q.u.id)));
app.post('/api/nft/buy', auth, ready, (q, s) => {
  const n = db.prepare('SELECT * FROM nfts WHERE id=?').get(+q.body.id);
  if (!n) return bad(s, 'No such NFT', 404);
  const ok = db.transaction(() => {
    if (!db.prepare('INSERT OR IGNORE INTO user_nfts VALUES (?,?)').run(q.u.id, n.id).changes) return 'owned';
    if (!debit(q.u.id, n.price)) { db.prepare('DELETE FROM user_nfts WHERE user_id=? AND nft_id=?').run(q.u.id, n.id); return 'funds'; }
    return 'ok';
  })();
  if (ok === 'owned') return bad(s, 'You already own this', 409);
  if (ok === 'funds') return bad(s, 'Not enough DOGS');
  s.json(profile(q.u.id));
});

/* ওয়ালেট */
app.get('/api/deposit-info', auth, (q, s) => {
  const d = S().deposit;
  s.json({ address: d.address, memo: `dogs_${q.u.id}`, rate: d.rate, min: d.min }); // ইউজারকে memo/comment সহ TON পাঠাতে হবে
});
app.post('/api/withdraw', auth, ready, (q, s) => {
  const amount = Math.round(Number(q.body.amount) * M), wallet = String(q.body.wallet || '').trim();
  if (!Number.isFinite(amount) || amount < S().withdraw.min * M) return bad(s, `Minimum is ${S().withdraw.min} DOGS`);
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(wallet)) return bad(s, 'Invalid TON address');
  const ok = db.transaction(() => {
    if (!debit(q.u.id, amount)) return false; // টাকা আগেই হোল্ডে যায়
    db.prepare('INSERT INTO withdrawals(user_id,amount,wallet,created) VALUES (?,?,?,?)').run(q.u.id, amount, wallet, Date.now());
    return true;
  })();
  ok ? s.json(profile(q.u.id)) : bad(s, 'Not enough DOGS');
});

/* ---------- অ্যাডমিন API ---------- */
const A = express.Router();
A.use(auth, admin);
A.get('/settings', (q, s) => s.json({ ...S(), tasks: db.prepare('SELECT id,title,reward/?1.0 AS reward,chat FROM tasks').all(M), nfts: db.prepare('SELECT id,name,emoji,price/?1.0 AS price,boost FROM nfts').all(M) }));
A.put('/settings/:key', (q, s) => {
  const def = DEFAULTS[q.params.key];
  if (!def) return bad(s, 'Unknown section', 404);
  const next = { ...S()[q.params.key] };
  for (const [k, v] of Object.entries(q.body || {})) {
    if (!(k in def) || typeof v !== typeof def[k]) return bad(s, `Bad field: ${k}`);
    if (typeof v === 'number' && !(v >= 0 && Number.isFinite(v))) return bad(s, `Bad number: ${k}`);
    next[k] = typeof v === 'string' ? v.trim().slice(0, 200) : v;
  }
  db.prepare('UPDATE settings SET value=? WHERE key=?').run(JSON.stringify(next), q.params.key);
  s.json(next);
});
A.post('/tasks', (q, s) => {
  const { title, reward, chat } = q.body || {};
  const url = /^https:\/\/\S{1,300}$/.test((q.body && q.body.url) || '') ? q.body.url : null;
  if (!title || !(reward >= 0)) return bad(s, 'title and reward required');
  const r = db.prepare('INSERT INTO tasks(title,reward,chat,url) VALUES (?,?,?,?)').run(String(title).slice(0, 80), Math.round(reward * M), chat || null, url);
  s.json({ id: r.lastInsertRowid });
});
A.delete('/tasks/:id', (q, s) => { db.prepare('DELETE FROM tasks WHERE id=?').run(+q.params.id); s.json({ ok: true }); });
A.put('/nfts/:id', (q, s) => {
  const { price, boost } = q.body || {};
  if (!(price >= 0) || !(boost >= 0)) return bad(s, 'price and boost required');
  db.prepare('UPDATE nfts SET price=?, boost=? WHERE id=?').run(Math.round(price * M), Math.round(boost), +q.params.id);
  s.json({ ok: true });
});
A.get('/users', (q, s) => {
  const like = `%${String(q.query.q || '').replace(/[%_]/g, '')}%`;
  s.json(db.prepare('SELECT id,username,name,balance/?1.0 AS balance,banned FROM users WHERE username LIKE ? OR CAST(id AS TEXT) LIKE ? ORDER BY created DESC LIMIT 100').all(M, like, like));
});
A.post('/users/:id/ban', (q, s) => { db.prepare('UPDATE users SET banned=? WHERE id=?').run(q.body.banned ? 1 : 0, +q.params.id); s.json({ ok: true }); });
A.get('/withdrawals', (q, s) => s.json(db.prepare("SELECT w.id,w.user_id,u.username,w.amount/?1.0 AS amount,w.wallet,w.status FROM withdrawals w JOIN users u ON u.id=w.user_id WHERE w.status=? ORDER BY w.id").all(M, q.query.status || 'pending')));
A.post('/withdrawals/:id', (q, s) => {
  const act = q.body.action;
  if (!['approve', 'reject'].includes(act)) return bad(s, 'action must be approve or reject');
  const ok = db.transaction(() => {
    const w = db.prepare("SELECT * FROM withdrawals WHERE id=? AND status='pending'").get(+q.params.id);
    if (!w) return false;
    db.prepare('UPDATE withdrawals SET status=? WHERE id=?').run(act === 'approve' ? 'approved' : 'rejected', w.id);
    if (act === 'reject') credit(w.user_id, w.amount); // বাতিল হলে টাকা ফেরত
    return true;
  })();
  ok ? s.json({ ok: true }) : bad(s, 'Not pending', 409);
});
app.use('/api/admin', A);

app.use((e, q, s, n) => { console.error(e); s.status(500).json({ error: 'Server error' }); });

/* ---------- TON ডিপোজিট পোলার (প্রথমে testnet-এ পরীক্ষা করুন) ---------- */
async function pollDeposits() {
  const d = S().deposit;
  if (!d.address) return;
  const r = await fetch(`https://toncenter.com/api/v2/getTransactions?address=${d.address}&limit=30`,
    { headers: process.env.TONCENTER_KEY ? { 'X-API-Key': process.env.TONCENTER_KEY } : {} }).then(r => r.json());
  for (const tx of r.result || []) {
    const m = tx.in_msg;
    if (!m || !m.value || !/^dogs_\d+$/.test(m.message || '')) continue;
    const uid = +m.message.slice(5), ton = Number(m.value) / 1e9;
    if (ton < d.min || !get(uid)) continue;
    const dogs = Math.round(ton * d.rate * M);
    db.transaction(() => {
      if (db.prepare('INSERT OR IGNORE INTO deposits VALUES (UQBZ47wWKxzNgEAsLlzVmPjnpemiW7DY08JKt7z7vhiKGOWM)').run(tx.transaction_id.hash, uid, ton, dogs, Date.now()).changes) credit(uid, dogs);
    })();
  }
}
setInterval(() => pollDeposits().catch(e => console.error('deposit poll:', e.message)), 30_000);

app.listen(PORT, () => console.log(`DOGS backend on :${PORT}`));
if (process.env.RUN_BOT !== '0') import('./bot.js').catch(e => console.error('bot:', e.message)); // বট একই সার্ভারে চলে
