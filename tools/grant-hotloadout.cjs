"use strict";
/* 手动给所有已绑定用户发放「热门全家桶」(--apply 顺带应用为使用中)。规则见 web/hotloadout.js。幂等。 */
const fs = require("fs"); const path = require("path");
const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "web", "config.json"), "utf8"));
const cat = require(path.join(__dirname, "..", "web", "catalog.js")).build(path.join(__dirname, "..", "reference", "csgo-api"));
const HOT = require(path.join(__dirname, "..", "web", "hotloadout.js"));
const rows = HOT.build(cat);
(async () => {
  const mysql = require(path.join(__dirname, "..", "web", "node_modules", "mysql2", "promise.js"));
  const c = await mysql.createConnection({ host: cfg.database.host, user: cfg.database.user, password: cfg.database.password, database: "howl" });
  const [users] = await c.query("SELECT DISTINCT s.steamid64, s.user_id, s.persona, u.username FROM howl_steam s JOIN howl_users u ON u.id = s.user_id");
  if (!users.length) { console.log("没有已绑定用户"); await c.end(); return; }
  const apply = process.argv.includes("--apply");
  for (const u of users) {
    const sid = u.steamid64;
    await c.query("DELETE FROM howl_plan WHERE steam_id=? AND name=?", [sid, HOT.NAME]);
    await c.query("INSERT INTO howl_plan (steam_id,user_id,name,rows_json,in_use) VALUES (?,?,?,?)", [sid, u.user_id, HOT.NAME, JSON.stringify(rows), 0]);
    let msg = "发放 " + sid + " (" + (u.persona || u.username) + ") 行数=" + rows.length;
    if (apply) {
      await c.query("UPDATE howl_plan SET in_use=0 WHERE steam_id=?", [sid]);
      await c.query("UPDATE howl_plan SET in_use=1 WHERE steam_id=? AND name=?", [sid, HOT.NAME]);
      await c.query("DELETE FROM howl_selection WHERE steam_id=?", [sid]);
      for (const o of rows) await c.query("INSERT INTO howl_selection (steam_id,side,sel_type,target,value) VALUES (?,?,?,?,?)", [sid, o.s, o.t, o.a, o.v]);
      msg += " · 已应用使用中";
    }
    console.log(msg);
  }
  await c.end();
})().catch(e => { console.error("失败:", e.message); process.exit(1); });
