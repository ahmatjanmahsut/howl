"use strict";
/* ============================================================
 * Howl 换肤 Web 端 —— 与 Howl 插件配套(zscsgo.com/skins 同款布局)
 *   · 数据源:CSGO-API 原始文件(data/zh-CN、data/en),catalog.js 归一化
 *   · 外观读写:howl_selection 表(行协议与插件一致,含 CT/T/any 三层)
 *   · 自动更新:内置定时检查 CSGO-API → 数据热重载 → 图片增量下载
 *   · 账号:howl_users(bcrypt + HMAC cookie),三级权限 user<admin<superadmin
 * ============================================================ */
const express = require("express");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const dgram = require("dgram");
const { build: buildCatalog } = require("./catalog.js");
const HOT = require("./hotloadout.js");

const CFG = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
const PORT = (CFG.web && CFG.web.port) || 8090;
const SECRET = (CFG.web && CFG.web.sessionSecret) || "change-me";
const DATA_DIR = CFG.dataDir ? path.resolve(CFG.dataDir) : path.join(__dirname, "data");
const IMG_DIR = path.join(__dirname, "public", "img");
const SKINS_DB = CFG.howlDatabase || (CFG.database && CFG.database.database) || "howl";
const POOL = mysql.createPool({
  host: CFG.database.host, port: CFG.database.port || 3306,
  user: CFG.database.user, password: CFG.database.password, database: CFG.database.database,
  waitForConnections: true, connectionLimit: 10, charset: "utf8mb4",
});

/* ---------- 表结构(与插件同库,幂等) ---------- */
async function initTables() {
  await POOL.query("CREATE TABLE IF NOT EXISTS " + SKINS_DB + ".howl_selection (steam_id BIGINT UNSIGNED NOT NULL, side ENUM('ct','t','any') NOT NULL DEFAULT 'any', sel_type VARCHAR(24) NOT NULL, target VARCHAR(64) NOT NULL, value VARCHAR(128) NOT NULL, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (steam_id, side, sel_type, target), KEY idx_steam (steam_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  await POOL.query("CREATE TABLE IF NOT EXISTS " + SKINS_DB + ".howl_data_meta (id TINYINT UNSIGNED NOT NULL PRIMARY KEY, fingerprint CHAR(64) NULL, game_updated_at TIMESTAMP NULL, game_version VARCHAR(32) NULL, web_updated_at TIMESTAMP NULL, web_version VARCHAR(32) NULL, counts_json JSON NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  await POOL.query("INSERT IGNORE INTO " + SKINS_DB + ".howl_data_meta (id) VALUES (1)");
  await POOL.query("CREATE TABLE IF NOT EXISTS howl_users (id INT UNSIGNED NOT NULL AUTO_INCREMENT, username VARCHAR(32) NOT NULL, email VARCHAR(190) NULL, password_hash VARCHAR(255) NOT NULL, role ENUM('user','admin','superadmin') NOT NULL DEFAULT 'user', status ENUM('active','banned') NOT NULL DEFAULT 'active', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, last_login_at TIMESTAMP NULL, PRIMARY KEY (id), UNIQUE KEY uq_username (username), UNIQUE KEY uq_email (email)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  await POOL.query("CREATE TABLE IF NOT EXISTS howl_steam (steamid64 VARCHAR(20) NOT NULL, user_id INT UNSIGNED NOT NULL, persona VARCHAR(64) NULL, is_primary TINYINT(1) NOT NULL DEFAULT 1, bound_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (steamid64), KEY idx_user (user_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  await POOL.query("CREATE TABLE IF NOT EXISTS howl_bind_codes (code CHAR(6) NOT NULL, steamid64 VARCHAR(20) NOT NULL, persona VARCHAR(64) NULL, issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, expires_at DATETIME NOT NULL, used_by INT UNSIGNED NULL, used_at TIMESTAMP NULL, PRIMARY KEY (code), KEY idx_sid (steamid64)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  await POOL.query("CREATE TABLE IF NOT EXISTS howl_plan (id INT UNSIGNED NOT NULL AUTO_INCREMENT, steam_id BIGINT UNSIGNED NOT NULL, user_id INT UNSIGNED NOT NULL, name VARCHAR(32) NOT NULL, rows_json JSON NOT NULL, in_use TINYINT(1) NOT NULL DEFAULT 0, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP, PRIMARY KEY (id), KEY idx_steam (steam_id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci");
  const [n] = await POOL.query("SELECT COUNT(*) c FROM howl_users WHERE role IN ('admin','superadmin')");
  if (!n[0].c && CFG.web.adminPassword) {
    const h = await bcrypt.hash(String(CFG.web.adminPassword), 10);
    await POOL.query("INSERT INTO howl_users (username,email,password_hash,role) VALUES (?,?,?,'superadmin')", ["admin", null, h]);
    console.log("[howl-web] 初始最高管理员已创建: admin");
  }
}

/* ---------- 目录缓存(数据热更新即重建) ---------- */
let CAT = null, STK_INDEX = null;
const gzCache = new Map();
function loadCatalog() {
  try { CAT = buildCatalog(DATA_DIR); }
  catch (e) { CAT = null; console.log("[howl-web] 目录数据未就绪(首次部署属正常,等待自动下载):", e.message); return false; }
  gzCache.clear();
  STK_INDEX = null;
  console.log("[howl-web] catalog:", CAT.guns.length, "枪 /", CAT.allSkins.length, "皮肤 /", CAT.stickers.length, "贴纸 / 版本", CAT.fingerprint.slice(0, 12));
  return true;
}

/* ---------- session ---------- */
const clean = (v, max = 64) => String(v == null ? "" : v).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, max);
function sign(payload) {
  const b = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return b + "." + crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
}
function read(tok) {
  if (!tok) return null;
  const [b, s] = String(tok).split(".");
  if (!b || !s) return null;
  const want = crypto.createHmac("sha256", SECRET).update(b).digest("base64url");
  if (want !== s) return null;
  try { const p = JSON.parse(Buffer.from(b, "base64url").toString("utf8")); return p.exp > Date.now() ? p : null; } catch { return null; }
}
function cookieParse(req) {
  const h = req.headers.cookie || "";
  const m = h.match(/(?:^|;\s*)howl_auth=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}
const ah = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(e => { console.error(e); if (!res.headersSent) res.json({ ok: false, error: "server_error" }); });
const RATE = new Map();
function rate(limit, ms) {
  return (req, res, next) => {
    const k = req.ip + "|" + req.path;
    const now = Date.now();
    const rec = RATE.get(k) || { c: 0, t: now };
    if (now - rec.t > ms) { rec.c = 0; rec.t = now; }
    if (++rec.c > limit) return res.status(429).json({ ok: false, error: "too_many" });
    RATE.set(k, rec);
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of RATE) if (now - v.t > 600000) RATE.delete(k); }, 300000).unref();
const ROLE_RANK = { user: 0, admin: 1, superadmin: 2 };
const isAdmin = r => (ROLE_RANK[r] || 0) >= 1;
const isSuper = r => (ROLE_RANK[r] || 0) >= 2;
async function accountState(uid) {
  const [rs] = await POOL.query("SELECT role,status FROM howl_users WHERE id=?", [uid]);
  return rs[0] || null;
}
function auth(req, res, next) {
  const p = read(cookieParse(req));
  if (!p) return res.status(401).json({ ok: false, error: "unauthorized" });
  (async () => {
    const st = await accountState(p.uid).catch(() => null);
    if (!st || st.status !== "active") return res.status(401).json({ ok: false, error: "unauthorized" });
    req.user = { uid: p.uid, username: p.username, role: st.role };
    next();
  })().catch(() => res.status(500).json({ ok: false }));
}
const adminOnly = (req, res, next) => req.user && isAdmin(req.user.role) ? next() : res.status(403).json({ ok: false, error: "forbidden" });

/* ---------- 压缩直出 ---------- */
function sendJsonCached(res, key, obj, maxAgeSec) {
  let hit = gzCache.get(key);
  if (!hit) {
    const buf = Buffer.from(JSON.stringify(obj));
    hit = { raw: buf, gzip: zlib.gzipSync(buf, { level: 6 }) };
    gzCache.set(key, hit);
  }
  const ae = String(res.req.headers["accept-encoding"] || "");
  res.set("Cache-Control", "public, max-age=" + maxAgeSec);
  if (ae.includes("gzip")) { res.set("Content-Encoding", "gzip"); res.type("application/json"); return res.send(hit.gzip); }
  res.type("application/json"); res.send(hit.raw);
}

/* ---------- 路由 ---------- */
const app = express();
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => { if (!req.path.startsWith("/img/")) res.set("Cache-Control", "no-store"); next(); });

app.get("/api/meta", ah(async (req, res) => {
  let meta = {};
  try {
    const [rs] = await POOL.query("SELECT fingerprint, game_version, game_updated_at, web_version, web_updated_at FROM " + SKINS_DB + ".howl_data_meta WHERE id=1");
    meta = rs[0] || {};
  } catch { /* 数据库不可用不影响页面 */ }
  let imgCount = 0;
  try { imgCount = fs.readdirSync(IMG_DIR).length; } catch { imgCount = 0; }
  res.json({
    ok: true, name: "Howl 外观工坊", version: CAT ? CAT.fingerprint : null,
    gameVersion: meta.game_version || null, gameUpdatedAt: meta.game_updated_at || null,
    localAssets: imgCount > 500,
    counts: CAT ? { skins: CAT.allSkins.length, stickers: CAT.stickers.length, agents: CAT.agents.length, music: CAT.music.length, keychains: CAT.keychains.length } : {},
    lastSync: SYNC_STATE,
  });
}));

app.get("/api/catalog", ah(async (req, res) => {
  if (!CAT) return res.json({ ok: false, error: "catalog_not_ready" });
  res.json({
    ok: true, version: CAT.fingerprint,
    guns: CAT.guns.map(g => ({ entity: g.entity, def: g.def, zh: g.zh, en: g.en, cat: g.cat, sniper: !!g.sniper, ct: g.ct, t: g.t, skins: g.skins })),
    knives: CAT.knives.map(k => ({ entity: k.entity, def: k.def, zh: k.zh, en: k.en, url: k.url || "", baseImg: k.baseImg || (k.entity + ".png"), skins: k.skins })),
    gloves: CAT.gloves.map(g => ({ model: g.model, def: g.def, zh: g.zh, en: g.en, skins: g.skins })),
    agents: CAT.agents, music: CAT.music.map(m => ({ kit: m.kit, zh: m.zh, en: m.en, img: m.img })),
    wearTiers: CAT.wearTiers, rarZh: CAT.rarZh, rarColor: CAT.rarColor,
  });
}));

app.get("/api/keychains", ah(async (req, res) => sendJsonCached(res, "keychains", { ok: true, items: CAT ? CAT.keychains : [] }, 3600)));

/* 贴纸:服务端搜索 + 年份/类型分面 + 分页 */
function stickerIndex() {
  if (!CAT) return [];
  if (!STK_INDEX) STK_INDEX = CAT.stickers.map(s => ({ s }));
  return STK_INDEX;
}
app.get("/api/stickers", ah(async (req, res) => {
  if (!CAT) return res.json({ ok: true, total: 0, page: 0, size: 60, items: [], facets: { years: [], yearNone: 0, types: [] } });
  const q = String(req.query.q || "").trim().toLowerCase();
  const yearRaw = String(req.query.year || "").trim();
  const yearNone = yearRaw === "none";
  const year = yearNone ? 0 : (parseInt(yearRaw, 10) || 0);
  const type = String(req.query.type || "").trim();
  const page = Math.max(0, parseInt(req.query.page || "0", 10) || 0);
  const size = Math.min(120, Math.max(20, parseInt(req.query.size || "60", 10) || 60));
  const idx = stickerIndex();
  const years = new Map(), types = new Map();
  for (const it of idx) {
    years.set(it.s.year, (years.get(it.s.year) || 0) + 1);
    types.set(it.s.type, (types.get(it.s.type) || 0) + 1);
  }
  let hit = idx;
  if (yearNone) hit = hit.filter(x => x.s.year === 0);
  else if (year) hit = hit.filter(x => x.s.year === year);
  if (type) hit = hit.filter(x => x.s.type === type);
  if (q) hit = hit.filter(x => ((x.s.zh || "") + " " + (x.s.en || "") + " " + (x.s.group || "") + " " + x.s.def).toLowerCase().includes(q));
  const TYPE_ZH = { normal: "普通", gold: "金色", holo: "全息", foil: "闪亮", glitter: "闪耀", lenticular: "3D 立体" };
  res.json({
    ok: true, total: hit.length, page, size,
    items: hit.slice(page * size, page * size + size).map(x => x.s),
    facets: {
      years: [...years.entries()].filter(([y]) => y > 0).sort((a, b) => b[0] - a[0]).map(([y, n]) => ({ y, n })),
      yearNone: years.get(0) || 0,
      types: Object.entries(TYPE_ZH).map(([k, zh]) => ({ k, zh, n: types.get(k) || 0 })).filter(t => t.n > 0),
    },
  });
}));

/* 皮肤搜索(混搭后端) */
app.get("/api/skinsearch", ah(async (req, res) => {
  if (!CAT) return res.json({ ok: false });
  const q = String(req.query.q || "").trim().toLowerCase();
  const rar = String(req.query.rar || "").trim();
  const page = Math.max(0, parseInt(req.query.page || "0", 10) || 0);
  const size = Math.min(120, Math.max(20, parseInt(req.query.size || "60", 10) || 60));
  let list = CAT.allSkins;
  if (rar) list = list.filter(s => s.rar === rar);
  if (q) list = list.filter(s => ((s.zh || "") + " " + (s.en || "") + " " + s.id).toLowerCase().includes(q));
  res.json({ ok: true, total: list.length, items: list.slice(page * size, page * size + size) });
}));

/* ---------- 账号 ---------- */
app.post("/api/register", rate(10, 60000), ah(async (req, res) => {
  const username = clean(req.body.username, 32);
  const password = String(req.body.password || "");
  const email = clean(req.body.email, 190) || null;
  if (!/^[\w\u4e00-\u9fa5.-]{3,32}$/.test(username)) return res.json({ ok: false, error: "bad_username" });
  if (password.length < 8) return res.json({ ok: false, error: "bad_password" });
  const hash = await bcrypt.hash(password, 10);
  try {
    const [r] = await POOL.query("INSERT INTO howl_users (username,email,password_hash) VALUES (?,?,?)", [username, email, hash]);
    const tok = sign({ uid: r.insertId, username, exp: Date.now() + 14 * 864e5 });
    res.set("Set-Cookie", "howl_auth=" + encodeURIComponent(tok) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600");
    res.json({ ok: true });
  } catch (e) {
    if (e.code === "ER_DUP_ENTRY") return res.json({ ok: false, error: "username_taken" });
    throw e;
  }
}));
app.post("/api/login", rate(10, 60000), ah(async (req, res) => {
  const username = clean(req.body.username, 32);
  const password = String(req.body.password || "");
  const [rs] = await POOL.query("SELECT id,password_hash,role,status FROM howl_users WHERE username=?", [username]);
  const u = rs[0];
  if (!u || u.status === "banned" || !(await bcrypt.compare(password, u.password_hash)))
    return res.json({ ok: false, error: "bad_credentials" });
  POOL.query("UPDATE howl_users SET last_login_at=NOW() WHERE id=?", [u.id]).catch(() => {});
  const tok = sign({ uid: u.id, username, role: u.role, exp: Date.now() + 14 * 864e5 });
  res.set("Set-Cookie", "howl_auth=" + encodeURIComponent(tok) + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600");
  res.json({ ok: true });
}));
app.post("/api/logout", (_, res) => { res.set("Set-Cookie", "howl_auth=; Path=/; Max-Age=0"); res.json({ ok: true }); });
app.post("/api/password", auth, rate(10, 60000), ah(async (req, res) => {
  const oldPw = String(req.body.oldPassword || ""), newPw = String(req.body.newPassword || "");
  if (newPw.length < 8) return res.json({ ok: false, error: "bad_password" });
  const [rs] = await POOL.query("SELECT password_hash FROM howl_users WHERE id=?", [req.user.uid]);
  if (!rs[0] || !(await bcrypt.compare(oldPw, rs[0].password_hash))) return res.json({ ok: false, error: "bad_credentials" });
  await POOL.query("UPDATE howl_users SET password_hash=? WHERE id=?", [await bcrypt.hash(newPw, 10), req.user.uid]);
  res.json({ ok: true });
}));
async function mySteam(uid) {
  const [rs] = await POOL.query("SELECT steamid64,persona,is_primary,bound_at FROM howl_steam WHERE user_id=? ORDER BY is_primary DESC,bound_at", [uid]);
  return rs;
}
app.get("/api/me", auth, ah(async (req, res) => res.json({ ok: true, username: req.user.username, role: req.user.role, steamids: await mySteam(req.user.uid) })));
app.post("/api/bind", auth, rate(20, 60000), ah(async (req, res) => {
  const code = clean(req.body.code, 8).toUpperCase();
  if (!/^[A-Z0-9]{6}$/.test(code)) return res.json({ ok: false, error: "bad_code" });
  const conn = await POOL.getConnection();
  try {
    await conn.beginTransaction();
    const [rs] = await conn.query("SELECT * FROM howl_bind_codes WHERE code=? FOR UPDATE", [code]);
    const c = rs[0];
    if (!c || c.used_by || new Date(c.expires_at) < new Date()) { await conn.rollback(); return res.json({ ok: false, error: "code_invalid" }); }
    const [own] = await conn.query("SELECT user_id FROM howl_steam WHERE steamid64=?", [c.steamid64]);
    if (own.length) { await conn.rollback(); return res.json({ ok: false, error: "steam_taken" }); }
    await conn.query("UPDATE howl_bind_codes SET used_by=?,used_at=NOW() WHERE code=?", [req.user.uid, code]);
    await conn.query("INSERT INTO howl_steam (steamid64,user_id,persona) VALUES (?,?,?)", [c.steamid64, req.user.uid, c.persona]);
    await conn.commit();
    res.json({ ok: true });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));
app.get("/api/steam", auth, ah(async (req, res) => res.json({ ok: true, steamids: await mySteam(req.user.uid) })));
async function ownsSteam(uid, sid) {
  const [rs] = await POOL.query("SELECT 1 x FROM howl_steam WHERE user_id=? AND steamid64=?", [uid, sid]);
  return rs.length > 0;
}
app.delete("/api/steam/:sid", auth, ah(async (req, res) => {
  const sid = clean(req.params.sid, 20);
  if (!await ownsSteam(req.user.uid, sid)) return res.status(403).json({ ok: false, error: "forbidden" });
  await POOL.query("DELETE FROM howl_steam WHERE steamid64=? AND user_id=?", [sid, req.user.uid]);
  res.json({ ok: true });
}));

/* ---------- 外观读写(howl_selection 行协议) ---------- */
const TYPES = new Set(["weapon", "knife_type", "knife", "glove", "agent", "music_kit", "sticker", "keychain", "seed", "wear", "nametag", "stattrak", "sticker_wear"]);
const SIDES = new Set(["ct", "t", "any"]);
async function guardSteam(req, res) {
  const sid = clean(req.params.steam, 20);
  if (!/^\d{17,20}$/.test(sid)) { res.json({ ok: false, error: "bad_steam" }); return null; }
  if (!isAdmin(req.user.role) && !await ownsSteam(req.user.uid, sid)) { res.status(403).json({ ok: false, error: "forbidden" }); return null; }
  return sid;
}
app.get("/api/loadout/:steam", auth, ah(async (req, res) => {
  const sid = await guardSteam(req, res); if (!sid) return;
  const [rs] = await POOL.query("SELECT side,sel_type,target,value,updated_at FROM " + SKINS_DB + ".howl_selection WHERE steam_id=?", [sid]);
  res.json({ ok: true, rows: rs.map(r => ({ s: r.side, t: r.sel_type, a: r.target, v: r.value, at: r.updated_at })) });
}));
/* body: {set:[{s,t,a,v}], del:[{s,t,a}]} —— 与插件行协议一致 */
app.post("/api/loadout/:steam", auth, rate(60, 60000), ah(async (req, res) => {
  const sid = await guardSteam(req, res); if (!sid) return;
  const sets = Array.isArray(req.body.set) ? req.body.set.slice(0, 200) : [];
  const dels = Array.isArray(req.body.del) ? req.body.del.slice(0, 200) : [];
  const conn = await POOL.getConnection();
  try {
    await conn.beginTransaction();
    for (const o of sets) {
      if (!TYPES.has(o.t) || !SIDES.has(o.s)) throw new Error("bad_type");
      await conn.query("INSERT INTO " + SKINS_DB + ".howl_selection (steam_id,side,sel_type,target,value) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE value=VALUES(value)",
        [sid, o.s, o.t, clean(o.a, 64), clean(o.v, 128)]);
    }
    for (const o of dels) {
      if (!TYPES.has(o.t) || !SIDES.has(o.s)) throw new Error("bad_type");
      await conn.query("DELETE FROM " + SKINS_DB + ".howl_selection WHERE steam_id=? AND side=? AND sel_type=? AND target=?",
        [sid, o.s, o.t, clean(o.a, 64)]);
    }
    await conn.commit();
    // 使用中背包自动同步为最新 selection(编辑即改背包,不会"改了丢失")
    await POOL.query("UPDATE " + SKINS_DB + ".howl_plan p SET p.rows_json=IFNULL((SELECT JSON_ARRAYAGG(JSON_OBJECT('s',x.side,'t',x.sel_type,'a',x.target,'v',x.value)) FROM " + SKINS_DB + ".howl_selection x WHERE x.steam_id=?),JSON_ARRAY()) WHERE p.steam_id=? AND p.in_use=1", [sid, sid]).catch(e => console.log("[howl-web] 背包同步失败:", e.message));
    res.json({ ok: true, hint: "已保存(同步到使用中背包),游戏内数秒内自动生效" });
  } catch (e) { await conn.rollback(); return res.json({ ok: false, error: String(e.message || e).slice(0, 60) }); } finally { conn.release(); }
}));
/* 复制一侧到另一侧 */
app.post("/api/loadout/:steam/copy", auth, rate(20, 60000), ah(async (req, res) => {
  const sid = await guardSteam(req, res); if (!sid) return;
  const from = String(req.body.from || ""), to = String(req.body.to || "");
  if (!["ct", "t"].includes(from) || !["ct", "t"].includes(to) || from === to) return res.json({ ok: false, error: "bad_args" });
  const conn = await POOL.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query("DELETE FROM " + SKINS_DB + ".howl_selection WHERE steam_id=? AND side=?", [sid, to]);
    await conn.query("INSERT INTO " + SKINS_DB + ".howl_selection (steam_id,side,sel_type,target,value) SELECT steam_id,?,sel_type,target,value FROM " + SKINS_DB + ".howl_selection WHERE steam_id=? AND side=?", [to, sid, from]);
    await conn.commit();
    res.json({ ok: true });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));
/* 清一边/清全部 */
app.delete("/api/loadout/:steam/:scope", auth, ah(async (req, res) => {
  const sid = await guardSteam(req, res); if (!sid) return;
  const scope = clean(req.params.scope, 10);
  if (scope === "all") await POOL.query("DELETE FROM " + SKINS_DB + ".howl_selection WHERE steam_id=?", [sid]);
  else if (scope === "ct" || scope === "t") await POOL.query("DELETE FROM " + SKINS_DB + ".howl_selection WHERE steam_id=? AND side=?", [sid, scope]);
  else return res.json({ ok: false, error: "bad_scope" });
  res.json({ ok: true });
}));


/* ---------- 背包(多套配置方案,参考站"我的背包"):方案存 rows 快照,设使用中=原子覆盖 howl_selection ---------- */
const MAX_PLANS = 3;   // 参考站会员上限
app.get("/api/plans/:steam", auth, ah(async (req, res) => {
  const sid = await guardSteam(req, res); if (!sid) return;
  // 使用中的背包与当前生效外观拉齐(selection 为准:游戏内菜单改动也会体现在背包里)
  await POOL.query("UPDATE " + SKINS_DB + ".howl_plan p SET p.rows_json=IFNULL((SELECT JSON_ARRAYAGG(JSON_OBJECT('s',x.side,'t',x.sel_type,'a',x.target,'v',x.value)) FROM " + SKINS_DB + ".howl_selection x WHERE x.steam_id=?),JSON_ARRAY()) WHERE p.steam_id=? AND p.in_use=1", [sid, sid]).catch(e => console.log("[howl-web] 背包拉齐失败:", e.message));
  let [rs] = await POOL.query("SELECT id,name,rows_json,in_use,updated_at FROM howl_plan WHERE steam_id=? ORDER BY id", [sid]);
  if (!rs.length) {
    /* 全新用户(没有任何背包也没有外观)→ 默认发放「热门全家桶」并设为使用中(注册即用) */
    const [selN] = await POOL.query("SELECT COUNT(*) n FROM howl_selection WHERE steam_id=?", [sid]);
    if (!selN[0].n) {
      try {
        const rows = HOT.build(CAT);
        for (const o of rows) await POOL.query("INSERT IGNORE INTO howl_selection (steam_id,side,sel_type,target,value) VALUES (?,?,?,?,?)", [sid, o.s, o.t, o.a, o.v]);
        await POOL.query("INSERT INTO " + SKINS_DB + ".howl_plan (steam_id,user_id,name,rows_json,in_use) VALUES (?,?,?,?,1)", [sid, req.user.uid, HOT.NAME, JSON.stringify(rows)]);
        rs = (await POOL.query("SELECT id,name,rows_json,in_use,updated_at FROM " + SKINS_DB + ".howl_plan WHERE steam_id=? ORDER BY id", [sid]))[0];
        console.log("[howl-web] 新用户默认全家桶: steam=" + sid + " 行数=" + rows.length);
        res.json({ ok: true, plans: rs.map(r => ({ id: r.id, name: r.name, inUse: !!r.in_use, at: r.updated_at, rows: typeof r.rows_json === "string" ? JSON.parse(r.rows_json) : (r.rows_json || []) })) });
        return;
      } catch (e) { console.log("[howl-web] 默认全家桶发放失败(回退空背包):", e.message); }
    }
    // INSERT ... SELECT(VALUES 里不能放子查询);空 selection 时聚合仍返回一行(空数组)
    await POOL.query("INSERT INTO " + SKINS_DB + ".howl_plan (steam_id,user_id,name,rows_json,in_use) SELECT ?,?,'默认背包',COALESCE(JSON_ARRAYAGG(JSON_OBJECT('s',side,'t',sel_type,'a',target,'v',value)),JSON_ARRAY()),1 FROM " + SKINS_DB + ".howl_selection WHERE steam_id=?", [sid, req.user.uid, sid]).catch(async () => {
      await POOL.query("INSERT INTO " + SKINS_DB + ".howl_plan (steam_id,user_id,name,rows_json,in_use) VALUES (?,?,'默认背包',JSON_ARRAY(),1)", [sid, req.user.uid]).catch(() => {});
    });
    rs = (await POOL.query("SELECT id,name,rows_json,in_use,updated_at FROM " + SKINS_DB + ".howl_plan WHERE steam_id=? ORDER BY id", [sid]))[0];
  }
  res.json({ ok: true, plans: rs.map(r => ({ id: r.id, name: r.name, inUse: !!r.in_use, at: r.updated_at, rows: typeof r.rows_json === "string" ? JSON.parse(r.rows_json) : r.rows_json })) });
}));
/* body: {name, from:"current"|"empty"} */
app.post("/api/plans/:steam/create", auth, rate(20, 60000), ah(async (req, res) => {
  const sid = await guardSteam(req, res); if (!sid) return;
  const name = clean(req.body.name, 20) || "新背包";
  const [cnt] = await POOL.query("SELECT COUNT(*) c FROM howl_plan WHERE steam_id=?", [sid]);
  if (cnt[0].c >= MAX_PLANS) return res.json({ ok: false, error: "plan_limit", msg: "最多可以使用" + MAX_PLANS + "个背包" });
  let rowsJson = "[]";
  if (req.body.from !== "empty") {
    const [rs] = await POOL.query("SELECT side,sel_type,target,value FROM " + SKINS_DB + ".howl_selection WHERE steam_id=?", [sid]);
    rowsJson = JSON.stringify(rs.map(r => ({ s: r.side, t: r.sel_type, a: r.target, v: r.value })));
  }
  const [r] = await POOL.query("INSERT INTO howl_plan (steam_id,user_id,name,rows_json) VALUES (?,?,?,?)", [sid, req.user.uid, name, rowsJson]);
  res.json({ ok: true, id: r.insertId });
}));
app.post("/api/plans/:steam/rename", auth, ah(async (req, res) => {
  const sid = await guardSteam(req, res); if (!sid) return;
  const id = +req.body.id || 0;
  await POOL.query("UPDATE howl_plan SET name=? WHERE id=? AND steam_id=?", [clean(req.body.name, 20) || "背包", id, sid]);
  res.json({ ok: true });
}));
app.post("/api/plans/:steam/delete", auth, ah(async (req, res) => {
  const sid = await guardSteam(req, res); if (!sid) return;
  await POOL.query("DELETE FROM howl_plan WHERE id=? AND steam_id=?", [+req.body.id || 0, sid]);
  res.json({ ok: true });
}));
/* 清空背包内容(参考站"清空背包") */
app.post("/api/plans/:steam/clear", auth, ah(async (req, res) => {
  const sid = await guardSteam(req, res); if (!sid) return;
  await POOL.query("UPDATE howl_plan SET rows_json='[]' WHERE id=? AND steam_id=?", [+req.body.id || 0, sid]);
  res.json({ ok: true });
}));
/* 设为使用中:事务内清 howl_selection 再写入方案 rows */
app.post("/api/plans/:steam/apply", auth, rate(20, 60000), ah(async (req, res) => {
  const sid = await guardSteam(req, res); if (!sid) return;
  const id = +req.body.id || 0;
  const conn = await POOL.getConnection();
  try {
    await conn.beginTransaction();
    const [[p]] = await conn.query("SELECT rows_json FROM howl_plan WHERE id=? AND steam_id=? FOR UPDATE", [id, sid]);
    if (!p) { await conn.rollback(); return res.json({ ok: false, error: "not_found" }); }
    const rows = typeof p.rows_json === "string" ? JSON.parse(p.rows_json) : p.rows_json;
    await conn.query("DELETE FROM " + SKINS_DB + ".howl_selection WHERE steam_id=?", [sid]);
    for (const o of (rows || []).slice(0, 400)) {
      if (!TYPES.has(o.t) || !SIDES.has(o.s)) continue;
      await conn.query("INSERT INTO " + SKINS_DB + ".howl_selection (steam_id,side,sel_type,target,value) VALUES (?,?,?,?,?)", [sid, o.s, o.t, clean(o.a, 64), clean(o.v, 128)]);
    }
    await conn.query("UPDATE howl_plan SET in_use=(id=?) WHERE steam_id=?", [id, sid]);
    await conn.commit();
    res.json({ ok: true, count: (rows || []).length });
  } catch (e) { await conn.rollback(); throw e; } finally { conn.release(); }
}));
/* 整包保存:编辑非使用中背包时,前端把工作副本全量写回该背包 rows_json(不触碰游戏) */
app.post("/api/plans/:steam/save", auth, rate(30, 60000), ah(async (req, res) => {
  const sid = await guardSteam(req, res); if (!sid) return;
  const id = +req.body.id || 0;
  let rows = Array.isArray(req.body.rows) ? req.body.rows.slice(0, 400) : null;
  if (!rows) return res.json({ ok: false, error: "bad_rows" });
  rows = rows.filter(o => TYPES.has(o.t) && SIDES.has(o.s) && o.a && o.v != null).map(o => ({ s: o.s, t: o.t, a: clean(o.a, 64), v: clean(o.v, 128) }));
  const [r] = await POOL.query("UPDATE howl_plan SET rows_json=? WHERE id=? AND steam_id=?", [JSON.stringify(rows), id, sid]);
  if (!r.affectedRows) return res.json({ ok: false, error: "not_found" });
  res.json({ ok: true, count: rows.length });
}));
/* 把当前使用中的外观同步回某背包(参考站无此按钮,但插件菜单改过外观后需要"存回背包"的通道) */
app.post("/api/plans/:steam/sync", auth, rate(20, 60000), ah(async (req, res) => {
  const sid = await guardSteam(req, res); if (!sid) return;
  const [rs] = await POOL.query("SELECT side,sel_type,target,value FROM " + SKINS_DB + ".howl_selection WHERE steam_id=?", [sid]);
  const rows = JSON.stringify(rs.map(r => ({ s: r.side, t: r.sel_type, a: r.target, v: r.value })));
  await POOL.query("UPDATE howl_plan SET rows_json=? WHERE id=? AND steam_id=?", [rows, +req.body.id || 0, sid]);
  res.json({ ok: true });
}));

/* ---------- 用户管理(三级权限) ---------- */
const roleOf = r => (ROLE_RANK[r] != null ? r : "user");
async function assertManageable(req, res, targetId) {
  if (!targetId) { res.json({ ok: false, error: "bad_id" }); return null; }
  if (targetId === req.user.uid) { res.json({ ok: false, error: "self" }); return null; }
  const [[t]] = await POOL.query("SELECT id,username,role FROM howl_users WHERE id=?", [targetId]);
  if (!t) { res.json({ ok: false, error: "not_found" }); return null; }
  if (ROLE_RANK[roleOf(t.role)] >= ROLE_RANK[roleOf(req.user.role)]) { res.json({ ok: false, error: "higher_or_equal" }); return null; }
  return t;
}
app.get("/api/admin/users", auth, adminOnly, ah(async (req, res) => {
  const q = clean(req.query.q, 32).toLowerCase();
  const [users] = await POOL.query("SELECT id,username,email,role,status,created_at,last_login_at FROM howl_users ORDER BY id DESC LIMIT 500");
  const [st] = await POOL.query("SELECT user_id,steamid64,persona FROM howl_steam");
  const map = {}, pmap = {};
  for (const x of st) { (map[x.user_id] = map[x.user_id] || []).push(x.steamid64); if (x.persona) (pmap[x.user_id] = pmap[x.user_id] || []).push(x.persona); }
  let list = users.map(u => ({
    ...u, role: roleOf(u.role), steamids: (map[u.id] || []).join(","), personas: (pmap[u.id] || []).join(","),
    manageable: u.id !== req.user.uid && ROLE_RANK[roleOf(u.role)] < ROLE_RANK[roleOf(req.user.role)],
  }));
  if (q) list = list.filter(u => (u.username + " " + (u.email || "") + " " + u.steamids + " " + (u.personas || "")).toLowerCase().includes(q));
  const stats = {
    total: users.length,
    admins: users.filter(u => roleOf(u.role) === "admin").length,
    superadmins: users.filter(u => roleOf(u.role) === "superadmin").length,
    banned: users.filter(u => u.status === "banned").length,
    bound: Object.keys(map).length,
    online: users.filter(u => u.last_login_at && (Date.now() - new Date(u.last_login_at).getTime()) < 30 * 60 * 1000).length,
  };
  res.json({ ok: true, users: list, stats, me: { uid: req.user.uid, role: roleOf(req.user.role) } });
}));
app.post("/api/admin/role", auth, adminOnly, ah(async (req, res) => {
  const id = +req.body.id || 0;
  const role = roleOf(req.body.role);
  const t = await assertManageable(req, res, id);
  if (!t) return;
  if (role === "superadmin" && !isSuper(req.user.role)) return res.json({ ok: false, error: "need_superadmin" });
  await POOL.query("UPDATE howl_users SET role=? WHERE id=?", [role, id]);
  res.json({ ok: true, role });
}));
app.post("/api/admin/status", auth, adminOnly, ah(async (req, res) => {
  const id = +req.body.id || 0;
  const status = req.body.status === "banned" ? "banned" : "active";
  const t = await assertManageable(req, res, id);
  if (!t) return;
  await POOL.query("UPDATE howl_users SET status=? WHERE id=?", [status, id]);
  res.json({ ok: true, status });
}));
app.post("/api/admin/password", auth, adminOnly, ah(async (req, res) => {
  const id = +req.body.id || 0, np = String(req.body.newPassword || "");
  if (np.length < 8) return res.json({ ok: false, error: "bad_password" });
  const t = await assertManageable(req, res, id);
  if (!t) return;
  await POOL.query("UPDATE howl_users SET password_hash=? WHERE id=?", [await bcrypt.hash(np, 10), id]);
  res.json({ ok: true });
}));
app.post("/api/admin/delete", auth, adminOnly, ah(async (req, res) => {
  if (!isSuper(req.user.role)) return res.json({ ok: false, error: "need_superadmin" });
  const id = +req.body.id || 0;
  const t = await assertManageable(req, res, id);
  if (!t) return;
  const [st] = await POOL.query("SELECT steamid64 FROM howl_steam WHERE user_id=?", [id]);
  await POOL.query("DELETE FROM howl_steam WHERE user_id=?", [id]);
  await POOL.query("DELETE FROM howl_users WHERE id=?", [id]);
  res.json({ ok: true, removedSteam: st.map(x => x.steamid64) });
}));
app.post("/api/admin/sync", auth, adminOnly, ah(async (req, res) => {
  checkForUpdates(true);
  res.json({ ok: true, msg: "已触发数据检查(稍后刷新页面查看新版本)" });
}));

/* ---------- 服务器状态(A2S,含 challenge 握手,每次发包重置超时) ---------- */
function a2sQuery(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    let done = false, timer = null;
    const finish = (r) => { if (done) return; done = true; if (timer) clearTimeout(timer); try { sock.close(); } catch (e) {} resolve(r); };
    const arm = (ms) => { if (timer) clearTimeout(timer); timer = setTimeout(() => finish({ ok: false, error: "timeout" }), ms); };
    arm(timeoutMs || 2500);
    const sendInfo = (challenge) => {
      const head = Buffer.from([0xff, 0xff, 0xff, 0xff, 0x54]);
      const body = Buffer.from("Source Engine Query\0", "ascii");
      const ch = challenge == null ? Buffer.from([0xff, 0xff, 0xff, 0xff]) : challenge;
      sock.send(Buffer.concat([head, body, ch]), port, host);
    };
    sock.on("message", (msg) => {
      if (msg.length < 6) return;
      const type = msg[4];
      if (type === 0x41) { arm(timeoutMs || 2500); sendInfo(msg.subarray(5, 9)); return; }
      if (type === 0x49) {
        let o = 6;
        const cstr = () => { const e = msg.indexOf(0, o); const s = msg.toString("utf8", o, e); o = e + 1; return s; };
        const name = cstr(), map = cstr();
        cstr(); cstr();
        o += 2;
        const players = msg.readUInt8(o); o += 1;
        const maxPlayers = msg.readUInt8(o); o += 1;
        const bots = msg.readUInt8(o);
        finish({ ok: true, name, map, players, maxPlayers, bots });
        return;
      }
    });
    sock.on("error", (e) => finish({ ok: false, error: e.message }));
    sendInfo(null);
  });
}
const PANEL_FILE = path.join(__dirname, "data", "servers.json");
let PANEL_SERVERS = null;
function loadPanelServers() {
  try {
    if (!fs.existsSync(PANEL_FILE)) return null;
    const j = JSON.parse(fs.readFileSync(PANEL_FILE, "utf8"));
    const list = (j.servers || []).filter(x => x && x.host && x.port);
    if (!list.length) return null;
    return list.map(x => ({ id: String(x.id), label: x.label || (x.host + ":" + x.port), host: x.host, port: Number(x.port) }));
  } catch { return null; }
}
const PUBLIC_HOST = (CFG.web && CFG.web.publicHost) || "";
const joinHost = sv => PUBLIC_HOST || sv.host;
const SERVERS_FALLBACK = Array.isArray(CFG.servers) && CFG.servers.length ? CFG.servers : [{ id: "howl", label: "Howl 换肤服", host: "127.0.0.1", port: 27015 }];
const MAP_ZH = {
  de_dust2: "炙热沙城 II", de_mirage: "荒漠迷城", de_inferno: "炼狱小镇", de_nuke: "核子危机",
  de_overpass: "死亡游乐园", de_ancient: "远古遗迹", de_anubis: "阿努比斯", de_vertigo: "殒命大厦",
  de_train: "列车停放站", de_cache: "仓库", de_cbble: "古堡", de_tuscan: "托斯卡纳",
  cs_office: "办公室", cs_italy: "意大利", cs_militia: "民兵", cs_agency: "办事处",
  de_aztec: "阿兹特克", de_dust: "沙城", de_shortdust: "迷你沙城", de_baggage: "行李仓库",
  de_lake: "湖畔", de_safehouse: "安全屋", de_bank: "银行", de_stmarc: "圣马可",
  workshop_aim_map: "练枪图", aim_map: "练枪图", de_grail: "圣杯",
};
let SRV_CACHE = { at: 0, data: null, fileAt: 0 };
/* ===== 24 小时在线人数采样(参考站「实时在线人数」模块)=====
 * 每 60s A2S 轮询所有服务器,写入小时桶(存最近快照),持久化 data/stats.json。 */
const STATS_FILE = path.join(__dirname, "data", "stats.json");
let STATS = { hours: {} };
try { if (fs.existsSync(STATS_FILE)) STATS = JSON.parse(fs.readFileSync(STATS_FILE, "utf8")); } catch {}
function saveStats() { try { fs.writeFileSync(STATS_FILE, JSON.stringify(STATS)); } catch {} }
async function sampleOnce() {
  try {
    if (!PANEL_SERVERS) { const fresh = loadPanelServers(); if (fresh) PANEL_SERVERS = fresh; }
    const list = PANEL_SERVERS || SERVERS_FALLBACK || [];
    const bucket = {};
    let total = 0;
    for (const sv of list) {
      const r = await a2sQuery(sv.host, sv.port, 3500);
      const n = r && r.ok ? (Number(r.players) || 0) : 0;
      bucket[(sv.addr || (sv.host + ":" + sv.port))] = n;
      total += n;
    }
    const key = new Date().toISOString().slice(0, 13).replace(/[-:]/g, "").replace("T", "");
    STATS.hours[key] = { total, per: bucket };
    const keys = Object.keys(STATS.hours).sort();
    while (keys.length > 24) delete STATS.hours[keys.shift()];
    saveStats();
  } catch (e) {}
}
setInterval(sampleOnce, 60000);
setTimeout(sampleOnce, 9000);
app.get("/api/stats", ah(async (req, res) => {
  const hours = Object.keys(STATS.hours).sort();
  res.json({ ok: true, hours: hours.map(k => ({ k, total: (STATS.hours[k] || {}).total || 0, per: (STATS.hours[k] || {}).per || {} })) });
}));

app.get("/api/servers", ah(async (req, res) => {
  const now = Date.now();
  if (SRV_CACHE.data && now - SRV_CACHE.at < 5000) return sendJsonCached(res, "servers", SRV_CACHE.data, 5);
  if (!PANEL_SERVERS || now - SRV_CACHE.fileAt > 60000) {
    const fresh = loadPanelServers();
    if (fresh) PANEL_SERVERS = fresh;
    SRV_CACHE.fileAt = now;
  }
  const list = await Promise.all((PANEL_SERVERS || SERVERS_FALLBACK).map(async (sv) => {
    const r = await a2sQuery(sv.host, sv.port, 3500);
    return {
      id: sv.id, label: sv.label, host: sv.host, port: sv.port,
      online: !!r.ok, name: r.ok ? r.name : null, map: r.ok ? r.map : null,
      mapZh: r.ok ? (MAP_ZH[r.map] || r.map) : null,
      players: r.ok ? r.players : 0, maxPlayers: r.ok ? r.maxPlayers : 0,
      join: "steam://connect/" + joinHost(sv) + ":" + sv.port,
      addr: joinHost(sv) + ":" + sv.port,
      connectCmd: "connect " + joinHost(sv) + ":" + sv.port,
      error: r.ok ? null : (r.error || "unreachable"),
    };
  }));
  const payload = { ok: true, servers: list };
  SRV_CACHE = { at: now, data: payload, fileAt: SRV_CACHE.fileAt };
  sendJsonCached(res, "servers", payload, 5);
}));

/* ---------- 静态资源 ---------- */
app.use("/img", express.static(IMG_DIR, { maxAge: "365d", immutable: true, etag: false, fallthrough: true }));
app.use(express.static(path.join(__dirname, "public")));
app.get("*", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

/* ---------- 自动同步:检查 CSGO-API → 数据热重载 → 图片增量 ---------- */
const API_BASE = (CFG.apiBase || "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api").replace(/\/$/, "");
const RES_FILES = ["base_weapons", "skins", "agents", "music_kits", "keychains", "stickers"];
const LANGS = ["zh-CN", "en"];
const SYNC_STATE = { at: null, msg: null, images: null };
function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, { timeout: timeoutMs || 120000, headers: { "User-Agent": "Howl-CS2-Skins/1.0" } }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return resolve(httpGet(r.headers.location, timeoutMs)); }
      if (r.statusCode === 404) { r.resume(); return resolve(null); }
      if (r.statusCode !== 200) { r.resume(); return reject(new Error("HTTP " + r.statusCode)); }
      const chunks = [];
      r.on("data", d => chunks.push(d));
      r.on("end", () => resolve(Buffer.concat(chunks)));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
  });
}
function httpHeadEtag(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.request(url, { method: "HEAD", timeout: 20000, headers: { "User-Agent": "Howl-CS2-Skins/1.0" } }, (r) => {
      r.resume();
      resolve((r.headers.etag || "") + "|" + (r.headers["last-modified"] || "") + "|" + (r.headers["content-length"] || ""));
    });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.end();
  });
}
async function remoteStamp() {
  const parts = [];
  for (const lang of LANGS) for (const res of RES_FILES) {
    try { parts.push(await httpHeadEtag(API_BASE + "/" + lang + "/" + res + ".json")); }
    catch { return null; }
  }
  return parts.join(";");
}
const stampFile = path.join(DATA_DIR, "..", "state", "remote-stamp.txt");
let syncing = false;
async function checkForUpdates(force) {
  if (syncing) return;
  syncing = true;
  try {
    const stamp = await remoteStamp();
    if (!stamp) { SYNC_STATE.msg = "远端检查失败(网络),保持现有数据"; return; }
    const local = fs.existsSync(stampFile) ? fs.readFileSync(stampFile, "utf8") : "";
    if (!force && stamp === local) return;
    console.log("[howl-web] 检测到 CSGO-API 变化,开始下载…");
    for (const lang of LANGS) fs.mkdirSync(path.join(DATA_DIR, lang), { recursive: true });
    for (const lang of LANGS) for (const res of RES_FILES) {
      const buf = await httpGet(API_BASE + "/" + lang + "/" + res + ".json", 300000);
      if (!buf) { if (lang === "zh-CN") throw new Error("上游缺文件:" + lang + "/" + res); continue; }
      JSON.parse(buf.toString("utf8"));
      const tmp = path.join(DATA_DIR, lang, res + ".json.tmp");
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, path.join(DATA_DIR, lang, res + ".json"));
    }
    fs.mkdirSync(path.dirname(stampFile), { recursive: true });
    fs.writeFileSync(stampFile, stamp);
    loadCatalog();
    syncImages().catch(e => console.log("[howl-web] 图片同步异常:", e.message));
    try {
      await POOL.query("UPDATE " + SKINS_DB + ".howl_data_meta SET fingerprint=?, web_updated_at=NOW(), web_version=? WHERE id=1", [CAT.fingerprint, CAT.fingerprint.slice(0, 12)]);
    } catch (e) { console.log("[howl-web] 写 meta 失败:", e.message); }
    SYNC_STATE.at = new Date().toISOString();
    SYNC_STATE.msg = "同步完成";
    console.log("[howl-web] 数据同步完成,版本", CAT.fingerprint.slice(0, 12));
  } catch (e) {
    SYNC_STATE.msg = "同步失败:" + String(e.message || e).slice(0, 120);
    console.log("[howl-web]", SYNC_STATE.msg);
  } finally { syncing = false; }
}
/* 图片增量:皮肤/探员/挂件/音乐盒/贴纸/武器基础图,缺哪张下哪张 */
async function syncImages() {
  if (!CAT) return;
  fs.mkdirSync(IMG_DIR, { recursive: true });
  const want = [];
  for (const g of CAT.guns) want.push({ f: g.entity + ".png", u: g.url || "" });
  if (CAT.baseImgs) for (const b of CAT.baseImgs) want.push({ f: b.file, u: b.url || "" });
  for (const g of CAT.guns) for (const s of g.skins) if (s.url) want.push({ f: s.img, u: s.url });
  for (const k of CAT.knives) for (const s of k.skins) if (s.url) want.push({ f: s.img, u: s.url });
  for (const g of CAT.gloves) for (const s of g.skins) if (s.url) want.push({ f: s.img, u: s.url });
  for (const a of CAT.agents) want.push({ f: a.img, u: a.url });
  for (const m of CAT.music) want.push({ f: m.img, u: m.url });
  for (const k of CAT.keychains) want.push({ f: k.img, u: k.url });
  for (const s of CAT.stickers) want.push({ f: s.img, u: s.url });
  const have = new Set(fs.readdirSync(IMG_DIR));
  const missing = want.filter(w => w.u && /^https/.test(w.u) && !have.has(w.f));
  console.log("[howl-web] 图片清单 " + want.length + ",待补 " + missing.length);
  let done = 0, fail = 0;
  const queue = missing.slice();
  await Promise.all(Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const it = queue.shift();
      try {
        const buf = await httpGet(it.u, 60000);
        if (buf && buf.length > 100) { fs.writeFileSync(path.join(IMG_DIR, it.f), buf); done++; }
        else fail++;
      } catch { fail++; }
      if ((done + fail) % 400 === 0) console.log("[howl-web] 图片下载进度 " + (done + fail) + "/" + missing.length);
    }
  }));
  SYNC_STATE.images = { total: want.length, downloaded: done, failed: fail };
  console.log("[howl-web] 图片同步完成:新下 " + done + ",失败 " + fail);
}

/* ---------- 启动 ---------- */
const ready = loadCatalog();
if (ready) syncImages().catch(e => console.log("[howl-web] 启动图片增量异常:", e.message));   // 素材库缺的(如刀图)自动补齐
initTables().then(() => {
  app.listen(PORT, () => console.log("[howl-web] listening on :" + PORT));
  checkForUpdates(!ready);
  const au = CFG.autoUpdate || {};
  const mins = Math.max(10, au.checkMinutes || 360);
  if (au.enabled !== false) setInterval(() => checkForUpdates(false), mins * 60000);
}).catch(e => { console.error("[howl-web] init failed:", e.message); process.exit(1); });
