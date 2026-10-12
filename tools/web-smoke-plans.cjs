"use strict";
/* Howl 背包(多套配置)接口冒烟 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const BASE = "http://127.0.0.1:8090";
let cookie = "";
async function req(p, o) {
  o = o || {};
  const r = await fetch(BASE + p, { method: o.method || "GET", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined, redirect: "manual" });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return { status: r.status, j: await r.json().catch(() => ({})) };
}
let fails = 0;
const ok = (c, n, x) => { console.log((c ? "✓ " : "✗ ") + n + (x ? "  " + x : "")); if (!c) fails++; };
(async () => {
  const STEAM = "76561199000000777";
  const cfg0 = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "config.json"), "utf8"));
  let r = await req("/api/login", { method: "POST", body: { username: "admin", password: cfg0.web.adminPassword } });
  ok(r.j.ok, "admin 登录");
  const mysql = require(path.join(ROOT, "web", "node_modules", "mysql2", "promise"));
  const cfg = cfg0;
  const conn = await mysql.createConnection({ host: cfg.database.host, user: cfg.database.user, password: cfg.database.password, database: "howl" });
  await conn.query("DELETE FROM howl_steam WHERE steamid64=?", [STEAM]);
  await conn.query("DELETE FROM howl_plan WHERE steam_id=?", [STEAM]);
  await conn.query("DELETE FROM howl_selection WHERE steam_id=?", [STEAM]);
  await conn.query("INSERT INTO howl_steam (steamid64,user_id,persona) VALUES (?,1,'背包测试')", [STEAM]);
  await conn.end();
  // 造当前外观(双队 AK 火蛇 + CT M4)
  r = await req("/api/loadout/" + STEAM, { method: "POST", body: { set: [
    { s: "any", t: "weapon", a: "weapon_ak47", v: "weapon_ak47:180" },
    { s: "ct", t: "weapon", a: "weapon_m4a1_silencer", v: "weapon_m4a1_silencer:3495" },
    { s: "any", t: "glove", a: "glove", v: "sporty_gloves:10048" },
  ], del: [] } });
  ok(r.j.ok, "基础外观就位");
  r = await req("/api/plans/" + STEAM + "/create", { method: "POST", body: { name: "搭配A", from: "current" } });
  ok(r.j.ok && r.j.id > 0, "创建背包A(快照当前)");
  const pa = r.j.id;
  // 清空当前 → 应用背包 → 应恢复 3 行
  await req("/api/loadout/" + STEAM + "/all", { method: "DELETE" });
  r = await req("/api/loadout/" + STEAM);
  ok((r.j.rows || []).length === 0, "已清空当前");
  r = await req("/api/plans/" + STEAM + "/apply", { method: "POST", body: { id: pa } });
  ok(r.j.ok && r.j.count === 3, "设使用中(恢复3行)", "count=" + r.j.count);
  r = await req("/api/loadout/" + STEAM);
  ok((r.j.rows || []).some(x => x.a === "weapon_ak47" && x.v === "weapon_ak47:180"), "库内容=背包快照");
  // 改当前 → sync 回背包
  await req("/api/loadout/" + STEAM, { method: "POST", body: { set: [{ s: "t", t: "weapon", a: "weapon_awp", v: "weapon_awp:234" }], del: [] } });
  r = await req("/api/plans/" + STEAM + "/sync", { method: "POST", body: { id: pa } });
  ok(r.j.ok, "同步当前→背包");
  r = await req("/api/plans/" + STEAM);
  const A = (r.j.plans || []).find(x => x.id === pa);
  ok(A && A.rows.some(x => x.a === "weapon_awp" && x.s === "t"), "同步生效(rows=" + (A ? A.rows.length : 0) + ")", A && A.inUse ? "inUse✓" : "");
  // 第2个背包 + 上限
  r = await req("/api/plans/" + STEAM + "/create", { method: "POST", body: { name: "搭配B", from: "empty" } });
  ok(r.j.ok, "创建空背包B");
  await req("/api/plans/" + STEAM + "/create", { method: "POST", body: { name: "C", from: "empty" } });
  r = await req("/api/plans/" + STEAM + "/create", { method: "POST", body: { name: "D", from: "empty" } });
  ok(!r.j.ok && r.j.error === "plan_limit", "上限 3 生效");
  // 切到 B 再切回 A
  const pb = (await (async () => { const rr = await req("/api/plans/" + STEAM); return rr.j.plans.find(x => x.name === "搭配B").id; })());
  r = await req("/api/plans/" + STEAM + "/apply", { method: "POST", body: { id: pb } });
  ok(r.j.ok && r.j.count === 0, "切到空背包B");
  r = await req("/api/loadout/" + STEAM);
  ok((r.j.rows || []).length === 0, "B 应用中→库空");
  r = await req("/api/plans/" + STEAM + "/apply", { method: "POST", body: { id: pa } });
  ok(r.j.ok, "切回 A");
  // 清理
  const del = await (async () => { const rr = await req("/api/plans/" + STEAM); for (const x of rr.j.plans) await req("/api/plans/" + STEAM + "/delete", { method: "POST", body: { id: x.id } }); return true; })();
  ok(del, "删除全部背包");
  const conn2 = await mysql.createConnection({ host: cfg.database.host, user: cfg.database.user, password: cfg.database.password, database: "howl" });
  await conn2.query("DELETE FROM howl_steam WHERE steamid64=?", [STEAM]);
  await conn2.query("DELETE FROM howl_selection WHERE steam_id=?", [STEAM]);
  await conn2.end();
  console.log(fails ? "\n" + fails + " 失败" : "\n背包链路全部通过");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
