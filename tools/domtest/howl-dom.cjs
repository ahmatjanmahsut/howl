"use strict";
/* Howl 前端 jsdom 冒烟 v4 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..", "..");
// jsdom 优先取本地,取不到则回退到 cs2suite/tools/domtest/node_modules
function loadJsdom() {
  try { return require("jsdom"); }
  catch { return require(path.join(ROOT, "..", "cs2suite", "tools", "domtest", "node_modules", "jsdom")); }
}
const { JSDOM, VirtualConsole } = loadJsdom();
const BASE = "http://127.0.0.1:8090";
const html = fs.readFileSync(path.join(ROOT, "web", "public", "index.html"), "utf8").replace(/<script src="app\.js\?v=\d+"><\/script>/, "");
const appjs = fs.readFileSync(path.join(ROOT, "web", "public", "app.js"), "utf8");
const errors = [];
const vc = new VirtualConsole();
vc.on("jsdomError", e => errors.push("jsdomError: " + (e && e.message)));
vc.on("error", (...a) => errors.push("console.error: " + a.map(String).join(" ")));
vc.on("warn", () => {});
const dom = new JSDOM(html, { runScripts: "outside-only", virtualConsole: vc, pretendToBeVisual: true, url: BASE + "/#/skins" });
const { window } = dom;
window.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
window.confirm = () => true; window.prompt = (m, d) => d || "x";
const STEAM = "76561198000000000";
const cache = {};
const D2 = "$";
const S1 = D2 + "(";
const S2 = D2 + D2 + "(";
(async () => {
  for (const p of ["/api/catalog", "/api/keychains", "/api/meta"]) cache[p] = await (await fetch(BASE + p)).text();
  cache["/api/stickers?q=&size=60&page=0"] = await (await fetch(BASE + "/api/stickers?q=&size=60&page=0")).text();
  const catj = JSON.parse(cache["/api/catalog"]);
  const m4 = catj.guns.find(g => g.entity === "weapon_m4a1_silencer");
  const m4skin = m4.skins.find(s => s.rar === "rare") || m4.skins[5];
  const rows = [
    { s: "any", t: "weapon", a: "weapon_ak47", v: "weapon_ak47:180" },
    { s: "ct", t: "weapon", a: "weapon_m4a1_silencer", v: m4skin.id },
    { s: "ct", t: "wear", a: "weapon_m4a1_silencer", v: "0.12" },
    { s: "t", t: "sticker", a: "weapon_ak47:0", v: "sticker-60|0.2|1.2|0.25|1.5|-1.2" },
    { s: "any", t: "keychain", a: "weapon_awp", v: "keychain-8" },
    { s: "any", t: "knife_type", a: "knife", v: "weapon_knife_butterfly" },
    { s: "any", t: "knife", a: "weapon_knife_butterfly", v: "weapon_knife_butterfly:415" },
    { s: "any", t: "glove", a: "glove", v: "sporty_gloves:10048" },
    { s: "any", t: "agent", a: "ct", v: "agent-4619" },
    { s: "any", t: "music_kit", a: "music", v: "102" },
  ];
  window.fetch = async (u, opt) => {
    const url = String(u); const o = opt || {};
    if (url.startsWith("/api/me")) return { status: 200, json: async () => ({ ok: true, username: "tester", role: "superadmin", steamids: [{ steamid64: STEAM, persona: "测试" }] }) };
    if (/^\/api\/plans\/[^/]+\/(create|rename|delete|clear|apply|sync)/.test(url)) return { status: 200, json: async () => ({ ok: true, id: 9, count: 3 }) };
    if (/^\/api\/plans\/[^/]+\/save/.test(url)) { window.__lastPlansSave = url; try { window.__plansSaveBody = JSON.parse(o.body); } catch {} return { status: 200, json: async () => ({ ok: true, count: 10 }) }; }
    if (url.startsWith("/api/plans/")) return { status: 200, json: async () => ({ ok: true, plans: [
      { id: 1, name: "搭配一", inUse: 1, at: "", rows },
      { id: 2, name: "搭配二", inUse: 0, at: "", rows: rows.slice(0, 8) },
    ] }) };
    if (url.startsWith("/api/loadout/")) {
      if (o.method === "POST") { window.__loadoutPosted = true; return { status: 200, json: async () => ({ ok: true }) }; }
      if (o.method === "DELETE") return { status: 200, json: async () => ({ ok: true }) };
      return { status: 200, json: async () => ({ ok: true, rows: JSON.parse(JSON.stringify(rows)) }) };
    }
    if (url.startsWith("/api/stats")) return { status: 200, json: async () => ({ ok: true, hours: [
      { k: "2026101017", total: 5, per: { "t:27035": 3, "b:2": 2 } },
      { k: "2026101018", total: 8, per: { "t:27035": 5, "b:2": 3 } },
    ] }) };
    if (url.startsWith("/api/servers")) return { status: 200, json: async () => ({ ok: true, servers: [{ id: "t", label: "测试", online: true, map: "de_mirage", mapZh: "荒漠迷城", players: 2, maxPlayers: 10, join: "steam://connect/t", addr: "t:27035", connectCmd: "connect t:27035" }] }) };
    if (url.startsWith("/api/admin/users")) return { status: 200, json: async () => ({ ok: true, users: [{ id: 2, username: "u", role: "user", status: "active", manageable: true, steamids: "", personas: "" }], stats: { total: 2, admins: 0, superadmins: 1, banned: 0, bound: 0, online: 0 }, me: { uid: 1, role: "superadmin" } }) };
    const key = url.split("?")[0];
    const hit = cache[url] || cache[key];
    if (hit) { const j = JSON.parse(hit); return { status: 200, json: async () => j }; }
    return { status: 404, json: async () => ({ ok: false, error: "mock_missing:" + url }) };
  };
  window.addEventListener("error", e => errors.push("WERR:" + e.message));
  window.addEventListener("unhandledrejection", e => errors.push("REJ:" + ((e.reason && e.reason.message) || String(e.reason))));
  window.eval(appjs);
  const wait = ms => new Promise(r => setTimeout(r, ms));
  await wait(1400);
  const q1 = s => window.document.querySelector(s);
  const q2 = s => [...window.document.querySelectorAll(s)];
  const rep = [];
  const assert = (c, n) => { rep.push((c ? "✓ " : "✗ ") + n); if (!c) errors.push("断言失败:" + n); };
  const closeModal = () => { const x = q1("#mx"); if (x) x.click(); };
  assert(q1("#noticeTxt") && /皮肤数据 v/.test(q1("#noticeTxt").textContent), "顶栏公告条");
  assert(q2("#bagRow .bagcard").length === 2, "背包卡×2");
  assert(q2("#bagRow .inusechip").length === 1, "使用中角标");
  const cards = q2("#grid [data-card]");
  assert(cards.length >= 55, "主网格 " + cards.length + " 卡");
  const bfCard = cards.find(c => (c.textContent || "").includes("蝴蝶刀"));
  const bfIm = bfCard && bfCard.querySelector("img");
  assert(!!bfIm && /weapon_knife_butterfly-415\.png/.test(bfIm.getAttribute("src") || ""), "蝴蝶刀卡=型号皮肤图+CDN兜底");
  bfCard.click(); await wait(250);
  assert(q2("#wbody .pick").length >= 18, "点刀卡先弹选模型");
  closeModal(); await wait(120);
  const akBoth = q2("#grid [data-card]").find(c => (c.textContent || "").includes("火蛇"));
  akBoth.click(); await wait(250);
  const kids = [...((q1("#modal .mtabs") || { children: [] })).children].map(e => (e.className || "").includes("mprops") ? "P" : ((e.dataset || {}).tab || "?"));
  assert(kids.join(",") === "skins,P,stickers,keychain", "标签序 [" + kids.join(",") + "]");
  q1("[data-tab=\"stickers\"]").click(); await wait(300);
  assert(!!q1("#stkCv"), "贴纸画布");
  assert(Math.abs(+q1("#sxN").value - 1.5) < 0.01, "画布与数值同步 X=1.5");
  closeModal(); await wait(120);
  // ===== 背包编辑流 =====
  const bag2 = q2("#bagRow .bagcard")[1];
  bag2.click(); await wait(300);
  assert(/正在编辑背包「搭配二」/.test((q1("#planBanner") || {}).textContent || ""), "点背包=打开编辑(横幅)");
  const ak2 = q2("#grid [data-card]").find(c => (c.textContent || "").includes("火蛇"));
  ak2.click(); await wait(200);
  q1("[data-tab=\"keychain\"]").click(); await wait(250);
  const firstKc = q2("#wbody .pick")[0];
  firstKc.click(); await wait(1400);
  assert(!!window.__lastPlansSave && !window.__loadoutPosted, "未使用背包保存走 plans/save,不碰 loadout");
  assert(!!(window.__plansSaveBody && window.__plansSaveBody.rows) && window.__plansSaveBody.rows.length >= 8, "plans/save 全量 rows 送达(" + ((window.__plansSaveBody || {}).rows || []).length + " 行)");
  const back = q1("#backLive");
  assert(!!back, "返回使用中背包按钮");
  back.click(); await wait(600);
  assert(!/正在编辑背包「搭配二」/.test((q1("#planBanner") || {}).textContent || ""), "返回后横幅切回使用中提示");
  // ===== 背包二级页 =====
  {
    const bag2b = q2("#bagRow .bagcard")[1];
    bag2b.click(); await wait(300);
    assert(/🎒 搭配二/.test((q1("#edChrome") || {}).textContent || ""), "二级页工具条(背包名+状态)");
    assert(!!q1("#bagBack") && !!q1("#bagAddItem") && !!q1("#bagDel"), "返回/添加物品/删除此背包 按钮在位");
    const akc = q2("#grid [data-card]").find(c => (c.textContent || "").includes("火蛇"));
    akc.click(); await wait(250);
    assert(!!q1("#rmItem"), "二级页弹层含「从背包移除该物品」");
    q1("#rmItem").click(); await wait(1400);
    assert(!!window.__lastPlansSave, "移除物品后自动存回背包(plans/save)");
    closeModal();
    q1("#bagBack").click(); await wait(700);
    assert(!/🎒/.test((q1("#edChrome") || {}).textContent || ""), "返回后恢复普通编辑器");
  }
  // ===== 服务器卡 =====
    window.location.hash = "#/servers"; window.dispatchEvent(new window.Event("hashchange")); await wait(500);
    assert(!!q1("#srvbar") && q2(".srvcard").length >= 1, "独立页面 #/servers 渲染服务器卡");
    assert(/服务器/.test((q1('#nav a[data-v="servers"]') || {}).textContent || ""), "导航含「服务器」入口");
  {
    // (首次弹窗已移除,默认网格模式)
    // (首次弹窗已移除,默认网格模式)
    assert(q2(".srvcard").length >= 1, "服务器卡片渲染 " + q2(".srvcard").length + " 张");
    const im = q1(".srvcard .scbg img");
    assert(!!im && String(im.getAttribute("src") || "").indexOf("/img/maps/bg-cs2-") === 0, "卡片全幅地图背景(bg-cs2 webp)");
    assert(!!q1(".srvcard .cor") && !!q1(".sbadge.on"), "四角装饰 + Online 徽标");
    assert(!!q1("#srvQ") && !!q1("#srvRefresh") && !!q1("#srvGrid") && !!q1("#srvList"), "搜索/刷新/网格/列表 工具栏");
    assert(/已发现 \d+ 个在线服务器/.test((q1(".srvtitle .tip") || {}).textContent || ""), "「已发现 N 个」文案");
    const cp = q1(".srvcard .scpy"); cp.click(); await wait(80);
    assert(cp.classList.contains("done"), "复制按钮点击后变 check 态");
    q1("#srvList").click(); await wait(200);
    assert(q2(".srvrow").length >= 1 && !q1(".srvcard"), "切换列表模式(srvrow)");
    q1("#srvGrid").click(); await wait(200);
    assert(q2(".srvcard").length >= 1, "切回网格模式");
    await wait(300);
    assert(q2(".livebars .lbar").length >= 2, "24h 在线堆叠柱(" + q2(".livebars .lbar").length + " 根)");
    assert(/实时在线人数/.test((q1("#liveBox") || {}).textContent || ""), "Live Telemetry 模块");
    window.location.hash = "#/skins"; window.dispatchEvent(new window.Event("hashchange")); await wait(400);
    assert(!q1("#srvbar"), "外观页不再嵌服务器区");
  }
  // 探员/管理
  q2("#summary [data-sum]")[1].click(); await wait(250);
  assert(!!q1("#pvcol"), "探员双列预览");
  q1("#mx2").click();
  window.location.hash = "#/admin"; window.dispatchEvent(new window.Event("hashchange")); await wait(400);
  assert(q2("#adBody tr").length >= 2, "管理表格");
  console.log(rep.join("\n"));
  console.log("\n捕获到的错误 (" + errors.length + ")");
  errors.slice(0, 8).forEach(e => console.log("  - " + String(e).slice(0, 150)));
  process.exit(errors.length ? 1 : 0);
})().catch(e => { console.error("脚本异常", e && e.message, String(e.stack || "").split("\n").slice(0, 5).join(" | ")); process.exit(1); });
setTimeout(() => process.exit(3), 40000);
