/* Howl Web 全链路冒烟:注册/登录/绑定/分边外观读写/贴纸数值/管理接口 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const BASE = "http://127.0.0.1:8090";
let cookie = "";
async function req(p, o) {
  o = o || {};
  const r = await fetch(BASE + p, {
    method: o.method || "GET",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
    redirect: "manual",
  });
  const sc = r.headers.get("set-cookie");
  if (sc) cookie = sc.split(";")[0];
  const j = await r.json().catch(() => ({}));
  return { status: r.status, j };
}
let fails = 0;
const ok = (cond, name, extra) => { console.log((cond ? "✓ " : "✗ ") + name + (extra ? "  " + extra : "")); if (!cond) fails++; };

(async () => {
  const user = "smoke" + Math.floor(Math.random() * 1e6);
  let r = await req("/api/register", { method: "POST", body: { username: user, password: "Smoke12345!" } });
  ok(r.j.ok, "注册 " + user);
  r = await req("/api/me");
  ok(r.j.ok && r.j.username === user, "登录态 /api/me", JSON.stringify(r.j.steamids));
  // 模拟游戏内绑定码
  const mysql = require(path.join(ROOT, "web", "node_modules", "mysql2", "promise"));
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "config.json"), "utf8"));
  const conn = await mysql.createConnection({ host: cfg.database.host, port: cfg.database.port, user: cfg.database.user, password: cfg.database.password, database: cfg.database.database });
  const STEAM = "76561199000000123";
  await conn.query("DELETE FROM howl_bind_codes WHERE code='SMOK01'");
  await conn.query("INSERT INTO howl_bind_codes (code,steamid64,persona,expires_at) VALUES ('SMOK01',?,?,DATE_ADD(NOW(),INTERVAL 10 MINUTE))", [STEAM, "冒烟玩家"]);
  r = await req("/api/bind", { method: "POST", body: { code: "SMOK01" } });
  ok(r.j.ok, "绑定码换绑");
  // 保存外观:双队 AK 火蛇 + CT M4A1-S 皮肤 + T 贴纸带数值 + 挂件 + 探员 + 音乐
  r = await req("/api/loadout/" + STEAM, { method: "POST", body: {
    set: [
      { s: "any", t: "weapon", a: "weapon_ak47", v: "weapon_ak47:180" },
      { s: "ct", t: "weapon", a: "weapon_m4a1_silencer", v: "weapon_m4a1_silencer:3495" },
      { s: "t", t: "wear", a: "weapon_ak47", v: "0.25" },
      { s: "t", t: "sticker", a: "weapon_ak47:0", v: "sticker-60|0.2|1.3|0.25|1.1|-0.4" },
      { s: "any", t: "keychain", a: "weapon_awp", v: "keychain-8" },
      { s: "any", t: "knife_type", a: "knife", v: "weapon_knife_butterfly" },
      { s: "ct", t: "knife", a: "knife", v: "weapon_knife_butterfly:615" },
      { s: "any", t: "glove", a: "glove", v: "sporty_gloves:10048" },
      { s: "any", t: "agent", a: "ct", v: "agent-4619" },
      { s: "any", t: "music_kit", a: "music", v: "102" },
    ], del: [] } });
  ok(r.j.ok, "保存外观(CT/T/双队三层)", r.j.hint || r.j.error);
  r = await req("/api/loadout/" + STEAM);
  const rows = r.j.rows || [];
  ok(rows.length >= 10, "读回行数", "rows=" + rows.length);
  const has = (s, t2, a) => rows.some(x => x.s === s && x.t === t2 && x.a === a);
  ok(has("any", "weapon", "weapon_ak47") && has("ct", "weapon", "weapon_m4a1_silencer") && has("t", "wear", "weapon_ak47") && has("t", "sticker", "weapon_ak47:0"), "三层都在");
  // 复制 CT→T 后清 T
  r = await req("/api/loadout/" + STEAM + "/copy", { method: "POST", body: { from: "ct", to: "t" } });
  ok(r.j.ok, "复制 CT→T");
  r = await req("/api/loadout/" + STEAM + "/t", { method: "DELETE" });
  ok(r.j.ok, "清空 T 边");
  // 目录与搜索
  r = await req("/api/catalog");
  const ak = (r.j.guns || []).find(g => g.entity === "weapon_ak47");
  ok(!!ak && ak.skins.some(s => s.paint === 180), "catalog 含火蛇", ak ? ak.skins.length + " 皮肤" : "");
  r = await req("/api/stickers?q=" + encodeURIComponent("iBUYPOWER") + "&size=20");
  ok(r.j.ok && r.j.total > 0 && r.j.items.length > 0, "贴纸搜索", "total=" + r.j.total);
  r = await req("/api/skinsearch?q=" + encodeURIComponent("火蛇"));
  ok(r.j.ok && r.j.items.some(x => x.paint === 180), "混搭搜索 火蛇", "hit=" + (r.j.items || []).length);
  r = await req("/api/servers");
  ok(r.j.ok && Array.isArray(r.j.servers), "服务器状态接口", JSON.stringify((r.j.servers || []).map(s => s.online)));
  r = await req("/api/admin/users");
  ok(!r.j.ok || r.j.error === "forbidden", "普通用户被管理接口拒", JSON.stringify(r.j));
  // 管理登录
  await req("/api/logout", { method: "POST" });
  r = await req("/api/login", { method: "POST", body: { username: "admin", password: cfg.web.adminPassword } });
  ok(r.j.ok && r.j.role !== "x", "admin 登录");
  r = await req("/api/admin/users");
  ok(r.j.ok && r.j.stats && r.j.users.length >= 2, "admin 用户列表", "total=" + r.j.stats.total);
  r = await req("/api/admin/sync", { method: "POST" });
  ok(r.j.ok, "admin 手动同步触发");
  // 清数据
  await conn.query("DELETE FROM howl_steam WHERE steamid64=?", [STEAM]);
  await conn.query("DELETE FROM howl_bind_codes WHERE code='SMOK01'");
  await conn.query("DELETE FROM howl_users WHERE username=?", [user]);
  await conn.end();
  console.log(fails === 0 ? "\n全部通过" : "\n" + fails + " 项失败");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("异常", e); process.exit(1); });
