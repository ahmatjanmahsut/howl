"use strict";
/* 背包实时同步冒烟:编辑 selection → 使用中背包自动反映;无背包自动建"默认背包" */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const BASE = "http://127.0.0.1:8090";
let cookie = "";
async function req(p, o) {
  o = o || {};
  const r = await fetch(BASE + p, { method: o.method || "GET", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined, redirect: "manual" });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  return await r.json().catch(() => ({}));
}
let fails = 0;
const ok = (c, n, x) => { console.log((c ? "✓ " : "✗ ") + n + (x ? "  " + x : "")); if (!c) fails++; };
(async () => {
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "web", "config.json"), "utf8"));
  let j = await req("/api/login", { method: "POST", body: { username: "admin", password: cfg.web.adminPassword } });
  ok(j.ok, "admin 登录");
  const mysql = require(path.join(ROOT, "web", "node_modules", "mysql2", "promise"));
  const conn = await mysql.createConnection({ host: cfg.database.host, user: cfg.database.user, password: cfg.database.password, database: "howl" });
  const S = "76561199000000999";
  await conn.query("DELETE FROM howl_steam WHERE steamid64=?", [S]);
  await conn.query("DELETE FROM howl_plan WHERE steam_id=?", [S]);
  await conn.query("DELETE FROM howl_selection WHERE steam_id=?", [S]);
  await conn.query("INSERT INTO howl_steam (steamid64,user_id,persona) VALUES (?,1,'背包同步测试')", [S]);
  await conn.end();
  j = await req("/api/plans/" + S);
  ok(j.ok && j.plans.length === 1 && !!j.plans[0].inUse && j.plans[0].name === "默认背包", "无背包→自动建默认并使用中", JSON.stringify(j.plans && j.plans.map(p => p.name + ":" + p.inUse)));
  j = await req("/api/loadout/" + S, { method: "POST", body: { set: [{ s: "any", t: "weapon", a: "weapon_ak47", v: "weapon_ak47:180" }, { s: "any", t: "knife_type", a: "knife", v: "weapon_knife_karambit" }], del: [] } });
  ok(j.ok, "编辑保存(2 行)");
  j = await req("/api/plans/" + S);
  const p0 = j.plans[0];
  ok(p0.rows.length === 2 && p0.rows.some(x => x.a === "weapon_ak47") && p0.rows.some(x => x.v === "weapon_knife_karambit"), "使用中背包自动=最新外观", "rows=" + p0.rows.length);
  j = await req("/api/loadout/" + S, { method: "POST", body: { set: [{ s: "any", t: "weapon", a: "weapon_ak47", v: "weapon_ak47:650" }], del: [] } });
  j = await req("/api/plans/" + S);
  ok(j.plans[0].rows.some(x => x.a === "weapon_ak47" && x.v === "weapon_ak47:650"), "改皮肤→背包跟随");
  // 建第二背包 → 切换 → 编辑跟随新背包
  j = await req("/api/plans/" + S + "/create", { method: "POST", body: { name: "背包二", from: "empty" } });
  ok(j.ok, "建空背包二");
  const list = (await req("/api/plans/" + S)).plans;
  const b2 = list.find(x => x.name === "背包二");
  j = await req("/api/plans/" + S + "/apply", { method: "POST", body: { id: b2.id } });
  ok(j.ok, "切到背包二(外观清空)");
  await req("/api/loadout/" + S, { method: "POST", body: { set: [{ s: "ct", t: "weapon", a: "weapon_m4a1", v: "weapon_m4a1:309" }], del: [] } });
  const l2 = (await req("/api/plans/" + S)).plans;
  const bb2 = l2.find(x => x.id === b2.id), bb1 = l2.find(x => x.name === "默认背包");
  ok(!!bb2.inUse && bb2.rows.length === 1 && bb2.rows[0].a === "weapon_m4a1", "编辑流入新使用中背包");
  ok(bb1.rows.some(x => x.a === "weapon_ak47" && x.v === "weapon_ak47:650"), "旧背包保持原内容不被污染");
  // 游戏内菜单模拟:直接写 selection → GET plans 拉齐
  const conn2 = await mysql.createConnection({ host: cfg.database.host, user: cfg.database.user, password: cfg.database.password, database: "howl" });
  await conn2.query("INSERT INTO howl_selection (steam_id,side,sel_type,target,value) VALUES (?,'any','weapon','weapon_awp','weapon_awp:234') ON DUPLICATE KEY UPDATE value=VALUES(value)", [S]);
  await conn2.end();
  const l3 = (await req("/api/plans/" + S)).plans;
  const bb3 = l3.find(x => x.id === b2.id);
  ok(bb3.rows.some(x => x.a === "weapon_awp"), "游戏内改动→进页拉齐到使用中背包");
  // 清理
  const c3 = await mysql.createConnection({ host: cfg.database.host, user: cfg.database.user, password: cfg.database.password, database: "howl" });
  await c3.query("DELETE FROM howl_steam WHERE steamid64=?", [S]);
  await c3.query("DELETE FROM howl_plan WHERE steam_id=?", [S]);
  await c3.query("DELETE FROM howl_selection WHERE steam_id=?", [S]);
  await c3.end();
  console.log(fails ? "\n" + fails + " 失败" : "\n背包同步全部通过");
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error("异常", e); process.exit(1); });
