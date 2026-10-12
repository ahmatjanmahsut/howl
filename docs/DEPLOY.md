# Howl 部署与运维(中文)

## 容器挂载清单(howl-web,改文件须重启容器,新增文件必须补 -v)
/opt/howl-web/{server.js,catalog.js,hotloadout.js,config.json} → /app 同名 :ro;public/app.js、public/index.html :ro;data、state、public/img 可写。

## 0. 前提
- CounterStrikeSharp **1.0.376+**(net10 运行时;历史教训:目标框架必须与 CSS 宿主一致)。
- core.json 的 FollowCS2ServerGuidelines = false(换肤必需,现网已满足)。
- MySQL 8.0+(用 db/schema.sql 或让插件/Web 各自幂等建表)。
- 游戏服与路由器容器需能访问 raw.githubusercontent.com(不通就配代理,如 http://127.0.0.1:7890)。

## 1. 【重要】与 AstraSkins 的关系
Howl 是**独立完整**的换肤系统(自带数据目录、档案表、注入引擎、实时切换)。
AstraSkins/AstraBind 与 Howl **不要同时启用**:两套都会写同一批武器实体的经济属性,
同时开启时"最后写入者"不确定,外观会互相覆盖。
迁移方式:卸载 AstraSkins 与 AstraBind(插件目录移除 + configs 移除),再装 Howl。
现网 MySQL 的 astra_skins / astra_web 库**不动**,历史配置保留;如需要可人工把
astra_player_skin_selections 的行翻译进 howl_selection(协议几乎同构,加 side='any' 即可)。

## 2. 插件部署(游戏服,如 <游戏服IP>)
1) 复制文件:
    addons/counterstrikesharp/plugins/Howl/            ← deploy/.../plugins/Howl/(Howl.dll、Howl.deps.json、CS2MenuManager.dll、MySqlConnector.dll;data/ 目录会自动生成)
    addons/counterstrikesharp/plugins/CS2MenuManager_MenuManager/   ← 菜单服务子插件(deploy 已附带;若服务器已装 MatchZy 0.9.x 的 MenuManagerCore 则**不要**重复放,二者只需其一)
    addons/counterstrikesharp/gamedata/howl.json       ← 注入签名(缺它菜单可用但外观不生效,日志会警告)
    addons/counterstrikesharp/configs/plugins/Howl/Howl.json  ← 由 Howl.example.json 复制修改
2) 改 Howl.json:Database(指向 howl 库)、WebUrl(面板地址)、必要时 ProxyUrl。
3) 重启实例(菜单服务子插件与主插件都建议冷启动;css_plugins reload 不可靠是旧证)。
4) 首次启动插件自动下载全量 CSGO-API 数据(约 25MB);或离线时把
   web/data 的 zh-CN/en 两套 json 拷到 plugins/Howl/data/ 下。
5) 验证:控制台 howl_status(应显示 枪 34/皮肤 2099+/版本);!howl 打开中文菜单选把枪保存,
   手持武器应立即重建换漆;howl_update 可手动触发检查更新。
6) 玩家进服提示可自绑:!howl 使用说明即全部命令。
配置项速览(Howl.json):
    InstantApplySeconds=3   网页改动轮询生效间隔
    MenuPageSize=30         菜单分页
    TeamSpecificLoadouts    true=游戏内菜单按 CT/T 分边保存(推荐);false=统一 any
    Features                Stickers/Keychains/Nametags/StatTrak/Gloves/Agents/MusicKits 开关
    AutoUpdate/UpdateCheckMinutes  自动更新(默认 360 分钟检查一次;安全阈值不满足会自动放弃并保留旧数据)

## 3. Web 部署(建议路由器,与 astra-web 并存用 8090 端口)
1) 源码上传到 /opt/howl-web(web/ 目录整体,不含 node_modules)。
2) 准备 config.json:复制 config.example.json,填数据库(与插件同一个 howl 库)、
   sessionSecret(随机 64 hex)、adminPassword(初始最高管理员)、web.publicHost(外网域名)、
   servers(或沿用面板 data/servers.json 同步机制)。
3) 镜像与容器:
    docker build -t howl-web:1.0 /opt/howl-web
    docker run -d --name howl-web --restart always --network host \
      -v /opt/howl-web/server.js:/app/server.js:ro \
      -v /opt/howl-web/catalog.js:/app/catalog.js:ro \
      -v /opt/howl-web/config.json:/app/config.json:ro \
      -v /opt/howl-web/public/app.js:/app/public/app.js:ro \
      -v /opt/howl-web/public/index.html:/app/public/index.html:ro \
      -v /opt/howl-web/data:/app/data \
      -v /opt/howl-web/public/img:/app/public/img \
      howl-web:1.0
   (沿用"全挂载"教训:改任何文件 docker restart 即可,无需重建镜像)
4) 图片冷启动(强烈建议,省一整轮下载):现网 astra-web 素材目录命名规则与 Howl 完全一致
   (entity-paint.png / sticker-def.png / keychain-def.png / agent-def.png),可直接复用:
    cp -a /mnt/nvme0n1-4/astra-img/. /opt/howl-web/public/img/
   之后 Howl 的自动同步只会增量补新图(首次启动若 autoUpdate.enabled=true 会自动检查并补齐)。
   不拷贝也行:前端有 CDN 兜底(数据里带 Steam image URL),只是首屏慢。
5) 验证:浏览器开 http://<host>:8090 注册/登录;admin 初始密码=config.json 的 adminPassword。
   页脚应显示"数据 v<版本>";绑 SteamID 后在面板配置 CT/T,游戏内 3 秒内生效。

## 4. 数据自动更新链路(三方对齐)
- 上游:ByMykel/CSGO-API 的 zh-CN 与 en 六类 json。
- 插件侧:每 UpdateCheckMinutes 检查 HEAD 指纹 → 下载校验 → 安全阈值 → 原子替换 data/ →
  目录热重载 → 在线玩家重漆 → 版本写 howl_data_meta(game_version)。
- Web 侧:同样机制(独立进程内定时器),完成后补图片增量并写 web_version;
  前端 60s 轮询 /api/meta,版本变化自动重载目录并提示。
- 一致性核对:howl_data_meta 一行里 game_version 与 web_version 应一致
  (两侧指纹算法相同:7 个核心文件字节拼接 SHA-256);不一致 = 某一侧网络失败,看各自日志。
- 手动触发:控制台 howl_update / 网页管理「POST /api/admin/sync(用户管理页无入口时可直接调 API)」。

## 5. 冒烟/回归脚本(改动后必跑)
- 插件数据层:dotnet run --project tools/catalog-test(期望「全部断言通过」)
- Web 后端全链路:node tools/web-smoke.cjs(16 项 ✓;需要本地能连 MySQL)
- 前端 jsdom:node tools/domtest/howl-dom.cjs(期望「捕获到的错误 (0)」)
- 编译:dotnet build plugin/Howl.csproj -c Release(0 错误 0 警告)

## 6. 常见故障速查
- 菜单能开但外观不变:多半缺 gamedata/howl.json(日志有"签名"警告)→ 放置后重启。
- 网页保存不生效:确认插件连的是同一 MySQL 同一库;看插件日志"应用外观/轮询异常"。
- 换边后外观回退:Howl 在 EventPlayerSpawn/Team(Post) 0.9/1.9s 两轮重读库重漆;
  若仍有第三方插件在更晚时机写属性,把该插件卸载或调高 Howl 的补漆延迟(Engine.ScheduleRepaint)。
- 自动更新一直"保持现有数据":上游网络不通 → 配 ProxyUrl;或阈值被拒(日志有明细)。
- 首次下载贴纸图片很久:11k+ 张属正常,进度看 [howl-web] 图片下载进度 日志。
