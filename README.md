# Howl · CS2 换肤系统

> 插件 + 网页面板一体化交付。**数据源 = CSGO-API(ByMykel/CSGO-API)原始格式**;游戏内按
> **AstraSkins 的实现方式(行式外观档案 + 经济属性注入)**换肤,并内置我们自研的
> **AstraBind 实时切换引擎**(轮询指纹 + 实体重建 + 最后写入者策略,秒级生效、换边不丢);
> Web 端采用成熟的换肤面板信息架构(平铺武器卡网格、双队/TR/CT 自动拆分合并、
> 居中大弹层 + 右滑翼、自动保存),**CT 与 T 方所有武器分开选择,皮肤可跨武器混搭**;
> **CSGO-API 更新时插件自动更新,Web 端数据与图片同步更新**;游戏内菜单**全中文**。

## 目录结构

```
howl/
├── plugin/                 C# 插件源码(CounterStrikeSharp,net10.0)
│   ├── Howl.csproj
│   ├── gamedata/howl.json  经济属性写入签名(部署到 CSS gamedata 目录)
│   ├── config/Howl.example.json  配置示例(部署为 configs/plugins/Howl/Howl.json)
│   └── src/
│       ├── Plugin.cs       入口:命令/装配/落库
│       ├── Config.cs       配置类
│       ├── Catalog.cs      CSGO-API 数据加载器(中英双语/刀归一/音乐去重/安全过滤)
│       ├── Store.cs        MySQL 读写(howl_selection 行协议 + 绑定码)
│       ├── Look.cs         行 → 玩家外观(CT/T/双队三层覆盖模型)
│       ├── Injector.cs     注入引擎(皮肤/贴纸/挂件/暗金/改名/手套/探员/音乐盒)
│       ├── Engine.cs       实时切换(轮询指纹/实体重建/出生与换边重漆/新实体最后上漆)
│       ├── Menu.cs         游戏内全中文菜单(WASD 面板)
│       └── Updater.cs      数据自动更新(HEAD 检查 → 下载校验 → 热重载 → 安全阈值)
├── web/                    Node.js 面板(Express;数据/图片自动同步内置)
│   ├── server.js           后端(目录/外观/账号/管理/A2S 服务器状态/自动同步)
│   ├── catalog.js          CSGO-API → Web 目录归一化(与插件同口径)
│   ├── public/index.html   前端(紧凑卡片网格布局与配色)
│   ├── public/app.js       前端逻辑(弹层/翼/拆合/自动保存)
│   ├── config.example.json / Dockerfile / package.json
├── db/schema.sql           表结构(插件与 Web 各自幂等建表)
├── deploy/                 可直接投放的插件成品(dll + gamedata + 配置示例)
├── tools/                  验证脚本(web-smoke.cjs 后端冒烟 / domtest 前端 jsdom 冒烟 / catalog-test)
└── docs/DEPLOY.md          部署与运维(含与 AstraSkins 共存注意事项)
```

## 核心设计

### 1. 数据:CSGO-API 原始格式直接用
- 插件与 Web 各自读同一批文件:`data/zh-CN/*.json` + `data/en/*.json`
  (base_weapons / skins / agents / music_kits / keychains / stickers)。
- 归一化规则与线上 auto-update 验证过的口径一致:
  刀 `sfui_wpnhud_*`→`weapon_*` 按 def_index 归一;过滤宙斯/道具/裸刀/`t_gloves`/`ct_gloves`;
  音乐盒按 def_index 去重;中英名双语取自两份目录;贴纸年份/类型分面。
- 实测结果(2026-10-10 上游):**枪 34 把 / 武器皮肤 1449、刀 20 型 / 556 款、手套 8 型 / 94 款、
  探员 63、音乐盒 102(去重后)、贴纸 11134、挂件 78** —— 与 AstraSkins 现网数字一致。

### 2. 游戏内换肤:AstraSkins 方式 + AstraBind 实时引擎
- 行式档案(表 `howl_selection`):`(steam_id, side, sel_type, target, value)`,
  side ∈ ct / t / any(**any=双队共享层,ct/t 行覆盖 any**)——这是"CT/T 分开选择"的底层模型。
- 注入写法与 AstraSkins 同源:`set item texture prefab/seed/wear` 双属性表写入、
  bodygroup(legacy/StatTrak)、贴纸槽、挂件槽、EconGloves、MusicKitID、探员 SetModel。
- 实时生效(沿用 AstraBind v6 的策略,Howl 是唯一写入者,无第三方竞争):
  3 秒轮询 count+MAX(updated_at) 指纹 → 变化即读行 → **Kill+Give 重建武器实体** →
  `OnEntitySpawned + NextWorldUpdate` 最后上漆 → 0.7s 二次补漆;
  `EventPlayerSpawn/EventPlayerTeam`(Post)0.9/1.9s 两轮从数据库重读 `RepaintOnly` —— 换边/重生不丢外观。
- 磨损默认 0(与面板规则一致)。

### 3. 游戏内菜单(全中文,WASD 面板)
```
!howl               主菜单:切换编辑边 CT/T → 类别 → 武器 → 皮肤/磨损/贴纸/挂件/名称暗金
!howlfind 关键词     跨武器混搭:搜任意皮肤应用到当前编辑物品
!howlstkfind 关键词  搜索贴纸贴到当前槽(菜单:贴纸 5 槽 + 分组分页)
!howlname 文字|off   名称牌;!howlwear 0~1;!howlseed 0~1000;!howlstattrak on|off
!howlbind / !howlwho 网页绑定码 / 绑定状态
howl_update(控制台)  立即检查 CSGO-API 更新;howl_status 查看目录版本与数量
```

### 4. Web 端(30 项结构断言,jsdom 回归 0 错误)
- **平铺武器卡网格**(手套在前,2→7 列响应式):每件武器按 CT/T 两边配置指纹自动呈现
  **1 张"⛓双队"卡**(相同)或 **CT/T 两张卡**(不同);悬停可**拆分队伍/合并队伍**(合并带覆盖确认)。
- **居中大弹层**:左 360 竖排子标签(刀型/皮肤/印花/挂件)+ 内联属性块(磨损·模板·名称·暗金,
  官方五档色 + 滑杆 + 精确输入),右滑出翼钻取选择网格。
- **混搭其他武器皮肤**:皮肤翼顶部按钮 → 选来源武器 → 选皮肤(全目录搜索 + 稀有度 chips)。
- **印花**:5 槽 + 磨损/缩放/角度/坐标数值(序列化 `sticker-def|wear|scale|rot|x|y`,
  插件注入引擎按值写属性,未调过的保持引擎默认)+ 复制所有槽位 + 年份/类型分面搜索。
- **探员(TR/CT 分开)与音乐盒**在"当前配置"右侧三宫格摘要,点开即选。
- **自动保存**:乐观更新 + 0.8s 防抖写库(无保存按钮,改完即存),页脚显示"已保存 · 游戏内约 3 秒生效"。
- **我的背包**:多套配置卡(编号水印 01/02/03、九宫格预览、"使用中"角标、悬停滑出"设为使用中"、⋮ 菜单:重命名/同步/清空/删除,上限 3 套;设使用中=事务覆盖 howl_selection,游戏内约 3 秒跟随)。
- **贴纸可视化画布**:已贴印花渲染为可拖拽元素,位置与数值行 X/Y 双向换算(可直接拖动;缩放/角度/磨损数值行齐备)。
- **探员/音乐盒弹层**:左列表右大预览双列结构(hover 预览、点选即用)。
- 顶栏中央 **amber 公告条**(数据版本/两侧同步状态,点击展开详情)、子标签 lucide 风格图标、翼宽度过渡动画与独立关闭钮、卡片磨损短码(FN/MW/FT/WW/BS 官方五色)、模板 Seed 上限 8192、75px 玻璃顶栏。
- 服务器状态卡(A2S)/三级用户权限(沿用 astra-web 的权限防坑规则)/绑定码流全部保留。

### 5. 数据与图片自动更新
- **插件**:内置 Updater,周期(默认 6h)HEAD 检查 CSGO-API ETag/Last-Modified →
  全量下载 12 文件 → JSON 校验 + 安全阈值(枪≥20、刀皮肤≥400、音乐≥50、贴纸≥3000…)→
  原子替换 → 目录热重载 → 在线玩家全部重漆 → 版本写 `howl_data_meta`。任何一步失败保持旧数据。
- **Web**:同一机制;下载后**重建目录缓存**并做**图片增量**——对照
  `entity-paint.png / sticker-def.png / keychain-def.png / agent-def.png / music-def.png`
  清单,缺哪张从 CSGO-API 的 image URL 下载到 `public/img`(并发 8),前端强缓存一年。
- 两侧指纹算法一致(7 文件字节拼接 SHA-256),`/api/meta` 同时显示游戏端/Web 端版本;
  前端每 60s 轮询版本,变了自动热重载目录并提示。

## 验证结论(本机全通过)
- `dotnet build Howl.csproj -c Release` → **0 错误 0 警告**。
- `tools/catalog-test`(C# 数据层):目录数量 + CT/T/any 三层合并 9 条断言全过。
- `tools/web-smoke.cjs`(Web 后端全链路,真库):注册/登录/绑定/三层外观/拆合/搜索/管理/A2S 共 16 项全过。
- `tools/web-smoke-plans.cjs`(背包链路):创建/设使用中/同步/切换/上限/删除 14 项全过。
- `tools/domtest/howl-dom.cjs`(前端 jsdom 结构断言,30 项):公告条/背包卡/双队与拆分卡/磨损短码/弹层标签序+属性块位置/
  图标/翼动画与两级返回/混搭钻取/贴纸画布与拖拽数值/5 槽位/双列探员预览/管理页 —— **捕获错误 0**。

> ⚠️ **与 AstraSkins 不要同时启用**:两套系统写同一批武器实体属性,同时开会出现互相覆盖。
> 迁移方案与共存注意事项见 `docs/DEPLOY.md`。

## 仓库内容说明

本仓库只放**源码与示例配置**;以下内容**故意不入库**,克隆后自行生成或使用你自己的:

| 不入库内容 | 原因 | 如何获得 |
|---|---|---|
| `web/config.json`、`Howl.json` | 含数据库口令、会话密钥、管理员口令 | 复制对应的 `*.example.json` 后填写 |
| `node_modules/`、`bin/`、`obj/` | 依赖与构建产物 | `pnpm i --frozen-lockfile` / `dotnet build -c Release` |
| `web/data/`、`plugin/data/`、`web/public/img/` | CSGO-API 目录与全部图标(约 850MB,版权归 Valve) | 首次启动自动下载 |
| `deploy/**/*.dll` | 第三方二进制(CounterStrikeSharp.API / CS2MenuManager / MySqlConnector) | 由 NuGet 还原并构建 |
| `reference/` | 第三方参考源码 | 自行获取 |

### 从源码构建

```bash
# 插件(net10.0,需 .NET 10 SDK)
cd plugin && dotnet build -c Release
# 产物 bin/Release/net10.0/Howl.dll,连同 gamedata/ 与 configs/ 投放至 CSS

# 网页端(Node 20+)
cd web && pnpm i && cp config.example.json config.json && node server.js
```

### 安全

- 仓库内**不含**任何真实凭据;数据库口令、会话密钥、管理员口令一律走 `config.json`(已 gitignore)。
- `.gitignore` 已覆盖 `config.json`、`*.pw`、`.env`、`deploy/_*` 等易误提交项;提交前脚本建议自查一遍。

## License

MIT,见 [LICENSE](LICENSE)(Copyright 2026 ahmatjanmahsut)。

**素材与第三方说明**
- 皮肤 / 贴纸 / 挂件 / 探员 / 音乐盒数据来自 [CSGO-API](https://github.com/ByMykel/CSGO-API)(MIT 代码,数据版权归 Valve 所有)。
  本项目**不在仓库内分发**这些数据与图片,插件与 Web 端均在运行时从上游自动下载。
- 依赖 NuGet 包 `CounterStrikeSharp.API`(MIT)、`CS2MenuManager`(MIT)、`MySqlConnector`(MIT)。
- 换肤属性写入方式参考了 AstraSkins(MIT)的设计思路;面板前端为自行实现。

