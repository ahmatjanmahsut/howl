using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Commands;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace Howl;

/// <summary>
/// Howl —— CS2 换肤插件(数据源:CSGO-API;换肤实现:AstraSkins 方式 + 自研实时切换引擎)。
/// 游戏内全中文菜单、CT/T 分边、跨武器混搭;Web 面板与插件共读同一 MySQL 表,改动秒级生效;
/// CSGO-API 目录更新时插件自动拉取、校验、热重载。
/// </summary>
[MinimumApiVersion(376)]
public sealed class HowlPlugin : BasePlugin, IPluginConfig<HowlConfig>
{
    public static HowlPlugin Current { get; private set; } = null!;

    public override string ModuleName => "Howl 换肤";
    public override string ModuleVersion => "1.0.1";
    public override string ModuleAuthor => "CS2Suite";
    public override string ModuleDescription => "CSGO-API 数据源换肤:全中文菜单、CT/T 分边、混搭皮肤、网页秒级生效、目录自动更新。";

    public HowlConfig Config { get; set; } = new();
    public void OnConfigParsed(HowlConfig config) { Config = config; }   // 教训:必须回写,否则永远用默认值

    private Store _store = null!;
    private Engine _engine = null!;
    private HowlInjector _injector = null!;
    private HowlMenu _menu = null!;
    private HowlUpdater _updater = null!;
    private volatile HowlCatalog? _catalog;
    private string DataDir => Path.Combine(ModuleDirectory, "data");

    public Store StoreOf => _store;
    public Engine EngineOf => _engine;
    public HowlMenu MenuOf => _menu;
    public HowlCatalog? Catalog => _catalog;

    public override void Load(bool hotReload)
    {
        Current = this;
        _store = new Store(Config, Logger);
        _catalog = TryLoadCatalog();
        _injector = new HowlInjector(this, Logger, _catalog ?? new HowlCatalog());
        _engine = new Engine(this, Logger, Config, _store, _injector);
        _menu = new HowlMenu(this);
        _updater = new HowlUpdater(this, Logger, DataDir);

        _ = Task.Run(async () =>
        {
            try
            {
                await _store.EnsureSchemaAsync();
                Logger.LogInformation("[Howl] 数据库表结构就绪");
            }
            catch (Exception ex) { Logger.LogError("[Howl] 数据库不可用: " + ex.Message + " —— 请检查 configs/plugins/Howl/Howl.json"); }
            if (_catalog is null && Config.AutoUpdate)
            {
                Logger.LogInformation("[Howl] 本地无目录数据,执行首次自动下载…");
                var r = await _updater.CheckAndApplyAsync(true);
                Logger.LogInformation("[Howl] 首次下载:" + (r ?? "完成"));
            }
        });

        _engine.Start();

        // 周期自动更新
        if (Config.AutoUpdate)
        {
            // 启动 90 秒后若从未成功同步过(状态文件缺失),自动补一次检查:写 meta 版本、对齐 Web 显示
            // 注意:这两个定时器不能带 STOP_ON_MAPCHANGE —— 换图后定时器会被销毁且不会重建,
            // 服务器只要换过一次图,"每 N 小时检查更新"就永久失效了。
            AddTimer(90f, () =>
            {
                if (!_updater.HasState)
                    _ = Task.Run(async () =>
                    {
                        var r = await _updater.CheckAndApplyAsync(false);
                        Logger.LogInformation("[Howl] 启动补检:" + (r ?? "无变化"));
                    });
            });
            var mins = Math.Max(10, Config.UpdateCheckMinutes);
            AddTimer(mins * 60f, () =>
            {
                _ = Task.Run(async () =>
                {
                    var r = await _updater.CheckAndApplyAsync(false);
                    if (r is not null && r != "已有更新任务在执行") Logger.LogInformation("[Howl] 自动更新:" + r);
                });
            }, TimerFlags.REPEAT);
        }

        // 命令
        AddCommand("howl", "打开 Howl 换肤菜单", OnHowl);
        AddCommand("howlhelp", "Howl 使用说明", (p, _) => { if (Ready(p)) _menu.OpenHelp(p!); });
        AddCommand("howlfind", "跨武器混搭搜索皮肤:!howlfind <关键词>", (p, info) =>
        {
            if (!Ready(p)) return;
            var kw = CollectArgs(info, 1);
            if (kw.Length == 0) Tell(p!, "用法:!howlfind 关键词(如 !howlfind 火蛇)");
            else _menu.OpenFind(p!, kw);
        });
        AddCommand("howlstkfind", "搜索贴纸并贴到当前槽:!howlstkfind <关键词>", (p, info) =>
        {
            if (!Ready(p)) return;
            var kw = CollectArgs(info, 1);
            if (kw.Length == 0) Tell(p!, "用法:!howlstkfind 关键词");
            else _menu.OpenStickerFind(p!, kw);
        });
        AddCommand("howlname", "名称牌:!howlname <文字|off>", (p, info) =>
        {
            if (!Ready(p)) return;
            var ent = _menu.CurrentEnt(p!);
            if (ent is null) { Tell(p!, "先在 !howl 菜单选好武器(进入它的功能页)。"); return; }
            var txt = CollectArgs(info, 1);
            if (txt.Length == 0) { Tell(p!, "用法:!howlname 文字(off 清除)"); return; }
            if (txt.Equals("off", StringComparison.OrdinalIgnoreCase)) Del(p!, "nametag", ent);
            else Set(p!, "nametag", ent, txt[..Math.Min(txt.Length, 20)], rebuild: true);
        });
        AddCommand("howlwear", "磨损:!howlwear <0~1>", (p, info) =>
        {
            if (!Ready(p)) return;
            var ent = _menu.CurrentEnt(p!);
            if (ent is null) { Tell(p!, "先在 !howl 菜单选好武器。"); return; }
            var a = info.ArgCount > 1 ? info.GetArg(1) : "";
            if (!float.TryParse(a, System.Globalization.CultureInfo.InvariantCulture, out var w) || w < 0 || w > 1)
            { Tell(p!, "用法:!howlwear 0.0~1.0"); return; }
            Set(p!, "wear", ent, w.ToString("0.0000", System.Globalization.CultureInfo.InvariantCulture), rebuild: false);
        });
        AddCommand("howlseed", "模板 Seed:!howlseed <0~8192>", (p, info) =>
        {
            if (!Ready(p)) return;
            var ent = _menu.CurrentEnt(p!);
            if (ent is null) { Tell(p!, "先在 !howl 菜单选好武器。"); return; }
            var a = info.ArgCount > 1 ? info.GetArg(1) : "";
            if (!int.TryParse(a, out var s) || s < 0 || s > 8192) { Tell(p!, "用法:!howlseed 0~8192"); return; }
            Set(p!, "seed", ent, s.ToString(), rebuild: false);
        });
        AddCommand("howlstattrak", "暗金:!howlstattrak <on|off>", (p, info) =>
        {
            if (!Ready(p)) return;
            var ent = _menu.CurrentEnt(p!);
            if (ent is null) { Tell(p!, "先在 !howl 菜单选好武器。"); return; }
            var a = (info.ArgCount > 1 ? info.GetArg(1) : "").ToLowerInvariant();
            if (a is not ("on" or "off")) { Tell(p!, "用法:!howlstattrak on|off"); return; }
            Set(p!, "stattrak", ent, a == "on" ? "1" : "off", rebuild: true);
        });
        AddCommand("howlreset", "清除外观(打开重置菜单)", (p, _) => { if (Ready(p)) { _menu.Forget(p!.Slot); OpenMainSafe(p!); } });
        AddCommand("howlbind", "生成网页绑定码", OnBind);
        AddCommand("howlwho", "查看我的 SteamID 与绑定状态", OnWho);
        AddCommand("howl_update", "立即检查/更新换肤数据(管理员)", async (p, info) =>
        {
            if (p is { IsValid: true, IsBot: false } && !IsAdminFor(p)) { Tell(p, "仅限管理员。"); return; }
            TellSender(p, info, "Howl:开始检查 CSGO-API 更新…");
            _ = Task.Run(async () =>
            {
                var r = await _updater.CheckAndApplyAsync(true);
                var msg = r ?? "无变化(目录已是最新)";
                if (p is { IsValid: true }) Server.NextFrame(() => TellSender(p, info, "Howl 更新:" + msg));
                else Logger.LogInformation("[Howl] 手动更新:" + msg);
            });
        });
        AddCommand("howl_status", "Howl 状态(管理员)", (p, info) =>
        {
            if (p is { IsValid: true, IsBot: false } && !IsAdminFor(p)) return;
            var c = _catalog;
            var s = c is null
                ? "目录未加载(等待自动更新或执行 howl_update)"
                : $"版本 {c.Fingerprint[..12]} · 皮肤 {c.AllSkins.Count} · 刀 {c.Knives.Count}/{c.Knives.Sum(k => k.Skins.Count)} · 手套 {c.Gloves.Count}/{c.Gloves.Sum(g => g.Skins.Count)} · 探员 {c.Agents.Count} · 音乐 {c.Music.Count} · 贴纸 {c.Stickers.Count} · 挂件 {c.Keychains.Count} · 注入器 {(EngineOf != null ? "已启动" : "-")} · 签名 {_injector.Available}";
            if (p is { IsValid: true }) p.PrintToChat("[Howl] " + s);
            else info.ReplyToCommand("[Howl] " + s);
        });

        RegisterEventHandler<EventPlayerDisconnect>((ev, _) => { if (ev.Userid is { IsValid: true }) _menu.Forget(ev.Userid.Slot); return HookResult.Continue; }, HookMode.Post);
        RegisterListener<Listeners.OnTick>(() =>
        {
            OnTickSwap();
            if (_swapRepaintAt > 0 && Server.CurrentTime >= _swapRepaintAt) { _swapRepaintAt = -999f; _engine.RepaintAllAfterCatalogSwap(); }
        });

        if (hotReload)
            foreach (var p in Utilities.GetPlayers())
                if (p is { IsValid: true, IsBot: false }) _engine.RefreshAndApply(p, rebuild: false);
    }

    private HowlCatalog? TryLoadCatalog()
    {
        try
        {
            var p = Path.Combine(DataDir, "zh-CN", "skins.json");
            if (!File.Exists(p)) return null;
            return HowlCatalog.Load(DataDir, Logger);
        }
        catch (Exception ex)
        {
            Logger.LogWarning("[Howl] 目录加载失败(将保持旧数据或等待更新): " + ex.Message);
            return null;
        }
    }

    /// <summary>
    /// 热替换目录(自动更新完成后)。Updater 在后台线程,只能"挂请求";
    /// 真正的替换/重漆/广播在 OnTick(主线程)消费 —— 严禁跨线程调用 CSS API(项目铁律)。
    /// </summary>
    private volatile HowlCatalog? _swapReq;
    private float _swapRepaintAt = -999f;
    public void SwapCatalog(HowlCatalog cat) => _swapReq = cat;

    private void OnTickSwap()
    {
        try
        {
            var req = _swapReq;
            if (req is null) return;
            _catalog = req;
            _injector.UseCatalog(req);
            _swapReq = null;
            _swapRepaintAt = (float)Server.CurrentTime + 0.5f;
            foreach (var p in Utilities.GetPlayers())
                if (p is { IsValid: true, IsBot: false } && IsAdminFor(p))
                    p.PrintToChat($" [Howl] {ChatColors.Green}换肤数据已自动更新{ChatColors.Default}:皮肤 {req.AllSkins.Count}、贴纸 {req.Stickers.Count}(版本 {req.Fingerprint[..8]})");
        }
        catch { }
    }

    public PlayerLook LookFromRows(IEnumerable<HowlRow>? rows) => PlayerLook.Parse(rows ?? Array.Empty<HowlRow>(), _catalog ?? new HowlCatalog(), Logger);

    // ---------- 落库 + 即时生效(菜单/命令统一入口) ----------
    private string SideFor(CCSPlayerController p, string type)
    {
        // 分层规则:刀型/刀兜底皮肤/手套/探员/音乐盒 = 全局(any);CT/T 只分皮肤/贴纸/磨损/挂件等
        if (type is "agent" or "music_kit" or "knife_type" or "glove") return "any";
        if (type == "knife" && _menu.CurrentEnt(p) == "knife") return "any";   // 菜单兜底行=全局
        return Config.TeamSpecificLoadouts ? _menu.CurrentSide(p) : "any";
    }

    public void Set(CCSPlayerController p, string type, string target, string value, bool rebuild, bool global = false)
    {
        if (!Ready(p)) return;
        var steam = (ulong)p.SteamID;
        var side = global ? "any" : SideFor(p, type);
        _ = Task.Run(async () =>
        {
            try { await _store.SetRowAsync(steam, side, type, target, value); }
            catch (Exception ex) { Logger.LogWarning("[Howl] 写入失败: " + ex.Message); Server.NextFrame(() => { if (p.IsValid) Tell(p, "保存失败(数据库)。"); }); return; }
            Server.NextFrame(() =>
            {
                if (!p.IsValid) return;
                _engine.RefreshAndApply(p, rebuild);
            });
        });
    }

    public void Del(CCSPlayerController p, string type, string target, bool global = false)
    {
        if (!Ready(p)) return;
        var steam = (ulong)p.SteamID;
        var side = global ? "any" : SideFor(p, type);
        _ = Task.Run(async () =>
        {
            try { await _store.DeleteRowAsync(steam, side, type, target); }
            catch (Exception ex) { Logger.LogWarning("[Howl] 删除失败: " + ex.Message); return; }
            Server.NextFrame(() => { if (p.IsValid) _engine.RefreshAndApply(p, rebuild: true); });
        });
    }

    public void ClearWeapon(CCSPlayerController p, string ent)
    {
        if (!Ready(p)) return;
        var steam = (ulong)p.SteamID;
        var side = Config.TeamSpecificLoadouts ? _menu.CurrentSide(p) : "any";
        _ = Task.Run(async () =>
        {
            try { await _store.ClearWeaponAsync(steam, side, ent); }
            catch (Exception ex) { Logger.LogWarning("[Howl] 清除失败: " + ex.Message); return; }
            Server.NextFrame(() => { if (p.IsValid) { Tell(p, "已清除。"); _engine.RefreshAndApply(p, rebuild: true); } });
        });
    }

    public void ClearCategory(CCSPlayerController p, string category)
    {
        if (!Ready(p)) return;
        var steam = (ulong)p.SteamID;
        string? side = category is "weapon" or "weapons_all" or "knife" or "glove" && Config.TeamSpecificLoadouts
            ? _menu.CurrentSide(p) : null;
        _ = Task.Run(async () =>
        {
            try { await _store.ClearCategoryAsync(steam, side, category); }
            catch (Exception ex) { Logger.LogWarning("[Howl] 清除失败: " + ex.Message); return; }
            Server.NextFrame(() => { if (p.IsValid) { Tell(p, "已清除,回到默认外观。"); _engine.RefreshAndApply(p, rebuild: true); } });
        });
    }

    // ---------- 绑定(!howlbind) ----------
    private void OnBind(CCSPlayerController? p, CommandInfo info)
    {
        if (!Ready(p)) { info.ReplyToCommand("仅限玩家使用。"); return; }
        var steam = (ulong)p!.SteamID;
        var name = p.PlayerName ?? "";
        _ = Task.Run(async () =>
        {
            try
            {
                var code = await _store.CreateBindCodeAsync(steam, name, Config.BindCodeTtlMinutes);
                Server.NextFrame(() =>
                {
                    if (!p.IsValid) return;
                    if (code is null) Tell(p, "你的 SteamID 已绑定网页账号(换绑请先在网页解绑)。");
                    else Tell(p, $"绑定码:\x04{code}\x01  有效期 {Config.BindCodeTtlMinutes} 分钟,到网页 {Config.WebUrl} 输入即可。");
                });
            }
            catch (Exception ex) { Logger.LogWarning("[Howl] bind 异常: " + ex.Message); Server.NextFrame(() => { if (p.IsValid) Tell(p, "数据库暂时不可用。"); }); }
        });
    }

    private void OnWho(CCSPlayerController? p, CommandInfo info)
    {
        if (!Ready(p)) { info.ReplyToCommand("仅限玩家使用。"); return; }
        var steam = (ulong)p!.SteamID;
        _ = Task.Run(async () =>
        {
            bool bound = false;
            try { bound = await _store.IsSteamBoundAsync(steam); } catch { }
            Server.NextFrame(() =>
            {
                if (!p.IsValid) return;
                Tell(p, $"SteamID:\x04{steam}\x01 网页绑定:" + (bound ? "\x02已绑定\x01" : "\x03未绑定\x01(!howlbind 获取绑定码)"));
            });
        });
    }

    private void OpenMainSafe(CCSPlayerController p)
    {
        _menu.OpenMain(p);
    }

    /// <summary>请求异步补读该玩家档案(菜单打开时缓存可能还没就绪)。</summary>
    public void RequestLoad(CCSPlayerController p)
    {
        if (p is not { IsValid: true, IsBot: false } || p.SteamID == 0) return;
        _engine.RefreshAndApply(p, rebuild: false);
    }

    /// <summary>管理员判定:CSS admins.json 权限(@css/root)即可。</summary>
    public static bool IsAdminFor(CCSPlayerController p)
    {
        try { return AdminManager.PlayerHasPermissions(p, "@css/root"); }
        catch { return false; }
    }

    private void OnHowl(CCSPlayerController? p, CommandInfo info)
    {
        if (!Ready(p)) { info.ReplyToCommand("仅限玩家使用。"); return; }
        _menu.OpenMain(p!);
    }

    private bool Ready(CCSPlayerController? p)
    {
        if (p is not { IsValid: true, IsBot: false } || p.SteamID == 0) return false;
        return true;
    }

    private static string CollectArgs(CommandInfo info, int from)
    {
        var parts = new List<string>();
        for (var i = from; i < info.ArgCount; i++) parts.Add(info.GetArg(i));
        return string.Join(" ", parts).Trim();
    }

    void Tell(CCSPlayerController p, string msg) { try { p.PrintToChat(" [Howl] \x01" + msg); } catch { } }
    private static void TellSender(CCSPlayerController? p, CommandInfo info, string msg)
    {
        if (p is { IsValid: true }) { try { p.PrintToChat("[Howl] " + msg); return; } catch { } }
        try { info.ReplyToCommand("[Howl] " + msg); } catch { }
    }

    public override void Unload(bool hotReload)
    {
        try { _engine?.Stop(); } catch { }
    }
}
