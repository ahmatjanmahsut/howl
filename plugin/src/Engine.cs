using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Core.Attributes.Registration;
using CounterStrikeSharp.API.Modules.Timers;
using CounterStrikeSharp.API.Modules.Entities.Constants;
using CounterStrikeSharp.API.Modules.Utils;
using Microsoft.Extensions.Logging;

namespace Howl;

/// <summary>
/// Howl 实时切换引擎(自研,思路来自线上验证过的 AstraBind):
///   · 轮询在线玩家外观指纹(count+max updated_at),网页/菜单改动 3 秒内生效;
///   · 变化 → 读行 → 就地注入 + Kill/Give 重建武器实体(模型与 HUD 强制刷新);
///   · OnEntitySpawned + NextWorldUpdate:任何新武器实体(买枪/重生/拾取)最后由我们上漆;
///   · EventPlayerSpawn/EventPlayerTeam(Post)0.9s/1.9s 两轮从数据库重读重漆
///     —— 保证换边/重生后"数据库是唯一权威、我们永远是最后写入者"。
/// </summary>
public sealed class Engine
{
    private readonly BasePlugin _plugin;
    private readonly ILogger _log;
    private readonly HowlConfig _cfg;
    private readonly Store _store;
    private readonly HowlInjector _inj;

    private readonly Dictionary<ulong, PlayerLook> _cache = new();
    private readonly object _cacheLock = new();
    private Dictionary<ulong, string> _fingerprints = new();
    private volatile bool _pollBusy;
    private volatile bool _baselineDone;
    // 重建冷却必须"按玩家"记账:轮询是一批玩家一起处理,用一个共享时间戳会导致
    // 同批里的第二个及之后玩家被静默跳过 —— 而指纹此时已刷新,他们的改动将永不生效。
    private readonly Dictionary<ulong, double> _lastRebuildAt = new();
    private const double ApplyCooldownSeconds = 2.5;

    public Engine(BasePlugin plugin, ILogger log, HowlConfig cfg, Store store, HowlInjector inj)
    {
        _plugin = plugin; _log = log; _cfg = cfg; _store = store; _inj = inj;
    }

    public void Start()
    {
        _plugin.RegisterListener<Listeners.OnEntitySpawned>(OnEntitySpawned);
        _plugin.RegisterEventHandler<EventPlayerSpawn>((ev, info) => { ScheduleRepaint(ev.Userid); return HookResult.Continue; }, HookMode.Post);
        _plugin.RegisterEventHandler<EventPlayerTeam>((ev, info) => { ScheduleRepaint(ev.Userid); return HookResult.Continue; }, HookMode.Post);
        _plugin.RegisterEventHandler<EventPlayerActivate>((ev, info) => { ScheduleJoin(ev.Userid); return HookResult.Continue; }, HookMode.Post);
        _plugin.RegisterEventHandler<EventPlayerDisconnect>((ev, info) =>
        {
            if (ev.Userid?.IsValid == true && ev.Userid.SteamID != 0)
            {
                var sid = (ulong)ev.Userid.SteamID;
                lock (_cacheLock) _cache.Remove(sid);
                _lastRebuildAt.Remove(sid);
            }
            return HookResult.Continue;
        }, HookMode.Post);
        if (_cfg.InstantApplySeconds > 0 && _inj.Available)
            _plugin.AddTimer(Math.Max(1, _cfg.InstantApplySeconds), PollAndApply, TimerFlags.REPEAT);
    }

    public void Stop()
    {
        try { _plugin.RemoveListener<Listeners.OnEntitySpawned>(OnEntitySpawned); } catch { }
    }

    public PlayerLook? Cached(ulong steam) { PlayerLook? v = null; lock (_cacheLock) _cache.TryGetValue(steam, out v); return v; }

    // ---------- 进服加载 ----------
    private void ScheduleJoin(CCSPlayerController? player)
    {
        if (player is not { IsValid: true } || player.IsBot || player.SteamID == 0) return;
        var steam = (ulong)player.SteamID;
        _ = Task.Run(async () =>
        {
            try
            {
                var rows = await _store.LoadRowsAsync(steam);
                Server.NextFrame(() =>
                {
                    if (player is not { IsValid: true }) return;
                    lock (_cacheLock) _cache[steam] = LookFrom(rows);
                    if (rows.Count > 0) ApplyLive(player, rebuild: false, quiet: true);
                });
            }
            catch (Exception ex) { _log.LogWarning("[Howl] 进服读取失败: " + ex.Message); }
        });
    }

    private static PlayerLook LookFrom(IEnumerable<HowlRow> rows) => HowlPlugin.Current.LookFromRows(rows);

    // ---------- 轮询(网页改动的即时生效) ----------
    private void PollAndApply()
    {
        if (_pollBusy) return;
        var players = new List<(CCSPlayerController p, ulong steam)>();
        foreach (var p in Utilities.GetPlayers())
            if (p is { IsValid: true, IsBot: false } && p.SteamID != 0) players.Add((p, (ulong)p.SteamID));
        if (players.Count == 0) { _fingerprints.Clear(); _baselineDone = false; return; }
        var ids = players.ConvertAll(x => x.steam);
        _pollBusy = true;
        _ = Task.Run(async () =>
        {
            try
            {
                var fresh = await _store.FingerprintAsync(ids);
                var prev = _fingerprints;
                _fingerprints = fresh;
                if (!_baselineDone) { _baselineDone = true; return; }   // 首轮只记基线
                var need = new HashSet<ulong>();
                foreach (var kv in fresh)
                    if (prev.TryGetValue(kv.Key, out var oldv) && oldv != kv.Value) need.Add(kv.Key);
                foreach (var s in prev.Keys) if (!fresh.ContainsKey(s)) need.Add(s);
                if (need.Count == 0) return;
                Server.NextFrame(() =>
                {
                    foreach (var (p, steam) in players)
                        if (need.Contains(steam) && p.IsValid) RefreshAndApply(p, rebuild: true);
                });
            }
            catch (Exception ex) { _log.LogWarning("[Howl] 轮询异常: " + ex.Message); }
            finally { _pollBusy = false; }
        });
    }

    /// <summary>从数据库重读该玩家外观并应用。rebuild=true 重建武器实体;false 只注入。</summary>
    public void RefreshAndApply(CCSPlayerController player, bool rebuild)
    {
        if (player is not { IsValid: true } || player.IsBot || player.SteamID == 0) return;
        var steam = (ulong)player.SteamID;
        _ = Task.Run(async () =>
        {
            List<HowlRow> rows;
            try { rows = await _store.LoadRowsAsync(steam); }
            catch (Exception ex) { _log.LogWarning("[Howl] 重读失败: " + ex.Message); return; }
            Server.NextFrame(() =>
            {
                if (player is not { IsValid: true }) return;
                lock (_cacheLock) _cache[steam] = HowlPlugin.Current.LookFromRows(rows);
                ApplyLive(player, rebuild, quiet: false);
            });
        });
    }

    /// <summary>菜单本地改完:更新缓存(应用由调用方触发)。</summary>
    public void SetCache(ulong steam, PlayerLook look) { lock (_cacheLock) _cache[steam] = look; }

    // ---------- 应用 ----------
    private void ApplyLive(CCSPlayerController player, bool rebuild, bool quiet)
    {
        if (player is not { IsValid: true, IsBot: false } || player.SteamID == 0) return;
        var steam = (ulong)player.SteamID;
        PlayerLook? look; lock (_cacheLock) _cache.TryGetValue(steam, out look);
        if (look is null) return;
        if (rebuild)
        {
            var now = Server.CurrentTime;
            if (_lastRebuildAt.TryGetValue(steam, out var last) && now - last < ApplyCooldownSeconds && !quiet) return;
            _lastRebuildAt[steam] = now;
        }
        try
        {
            var isCt = player.Team == CsTeam.CounterTerrorist;
            var sl = look.For(isCt);
            int hit = 0;
            if (_inj.Available && player.PawnIsAlive && player.PlayerPawn?.Value is { IsValid: true })
            {
                if (player.PlayerPawn.Value.WeaponServices?.MyWeapons is { } guns)
                    foreach (var h in guns)
                    {
                        var w = h.Value;
                        if (w is not { IsValid: true }) continue;
                        var dn = w.DesignerName ?? "";
                        if (!dn.StartsWith("weapon_")) continue;
                        var e = sl.Get(dn);
                        if (e.KnifeDefIndex == 0 && e.Entity == "knife") { e.KnifeDefIndex = sl.KnifeTypeDef; }
                        if (e.HasAnything || (dn.Contains("knife") && sl.KnifeTypeDef > 0))
                            if (_inj.InjectWeapon(player, w, e)) hit++;
                    }
                if (_cfg.Features.Gloves) _inj.InjectGloves(player, sl);
                if (_cfg.Features.MusicKits && look.MusicKit > 0) _inj.ApplyMusic(player, look.MusicKit);
                if (_cfg.Features.Agents) _inj.ApplyAgent(player, isCt ? look.AgentCt : look.AgentT);
            }
            if (!_inj.Available)
            {
                if (!quiet) player.PrintToChat(" [Howl] \x03警告:\x01 注入引擎不可用(缺 gamedata 签名),外观不会生效。");
                return;
            }
            if (rebuild) ReequipWithPaint(player, sl);
            _log.LogInformation($"[Howl] 应用外观 steam={steam} 注入 {hit} 把{(rebuild ? " 重建" : "")}");
            if (!quiet) player.PrintToChat(" [Howl] \x02已生效\x01(改动已同步游戏内)。");
        }
        catch (Exception ex) { _log.LogWarning("[Howl] ApplyLive: " + ex.Message); }
    }

    /// <summary>重建武器实体(击杀→重发→恢复弹药→切回原槽),新实体由 OnEntitySpawned 再上漆。</summary>
    private void ReequipWithPaint(CCSPlayerController player, SideLook sl)
    {
        var pawn = player.PlayerPawn?.Value;
        if (pawn is not { IsValid: true } || !player.PawnIsAlive) return;
        var services = pawn.WeaponServices;
        if (services?.MyWeapons is not { } weapons || weapons.Count == 0) return;
        int activeSlot = 0;
        try { activeSlot = SlotOfGear(services.ActiveWeapon?.Value?.As<CCSWeaponBase>().VData?.GearSlot); } catch { }
        var rebuildList = new List<(string cls, int clip, int reserve, HowlEntry e)>();
        var kills = new List<CBasePlayerWeapon>();
        foreach (var h in weapons)
        {
            var w = h.Value;
            if (w is not { IsValid: true }) continue;
            gear_slot_t? gs = null;
            try { gs = w.As<CCSWeaponBase>().VData?.GearSlot; } catch { }
            if (gs is not (gear_slot_t.GEAR_SLOT_RIFLE or gear_slot_t.GEAR_SLOT_PISTOL or gear_slot_t.GEAR_SLOT_KNIFE)) continue;
            var cls = w.DesignerName ?? "";
            if (cls.Length == 0) continue;
            int clip = -1, reserve = -1;
            if (gs != gear_slot_t.GEAR_SLOT_KNIFE)
            {
                try { var g = w.As<CCSWeaponBaseGun>(); clip = g.Clip1; reserve = g.ReserveAmmo[0]; } catch { }
            }
            var e = sl.Get(cls);
            if (e.Entity == "knife") e.KnifeDefIndex = sl.KnifeTypeDef;
            rebuildList.Add((cls, clip, reserve, e));
            kills.Add(w);
        }
        if (rebuildList.Count == 0) return;
        foreach (var w in kills)
        {
            try { w.AddEntityIOEvent("Kill", w, null, "", 0f); } catch { }
        }
        _plugin.AddTimer(0.3f, () =>
        {
            if (player is not { IsValid: true } || !player.PawnIsAlive) return;
            foreach (var (cls, clip, reserve, e) in rebuildList)
            {
                try
                {
                    var nw = new CBasePlayerWeapon(player.GiveNamedItem(cls));
                    if (nw.IsValid && clip >= 0)
                    {
                        try
                        {
                            var g = nw.As<CCSWeaponBaseGun>();
                            g.Clip1 = clip;
                            if (reserve >= 0) g.ReserveAmmo[0] = reserve;
                        }
                        catch { }
                    }
                    if (nw.IsValid) _inj.InjectWeapon(player, nw, e);
                }
                catch { }
            }
            if (activeSlot >= 1)
                Server.NextFrame(() => { try { if (player.IsValid) player.ExecuteClientCommand("slot" + activeSlot); } catch { } });
            // 0.7s 二次补漆:覆盖其它系统同帧写入的旧值
            _plugin.AddTimer(0.7f, () =>
            {
                if (player is not { IsValid: true } || !player.PawnIsAlive) return;
                try
                {
                    if (player.PlayerPawn?.Value?.WeaponServices?.MyWeapons is not { } guns2) return;
                    var isCt2 = player.Team == CsTeam.CounterTerrorist;
                    PlayerLook? lk; lock (_cacheLock) _cache.TryGetValue((ulong)player.SteamID, out lk);
                    if (lk is null) return;
                    var sl2 = lk.For(isCt2);
                    foreach (var h in guns2)
                    {
                        var w = h.Value;
                        if (w is not { IsValid: true }) continue;
                        var dn = w.DesignerName ?? "";
                        if (!dn.StartsWith("weapon_")) continue;
                        var e = sl2.Get(dn);
                        if (e.Entity == "knife") e.KnifeDefIndex = sl2.KnifeTypeDef;
                        if (e.HasAnything || (dn.Contains("knife") && sl2.KnifeTypeDef > 0)) _inj.InjectWeapon(player, w, e);
                    }
                }
                catch { }
            }, TimerFlags.STOP_ON_MAPCHANGE);
        }, TimerFlags.STOP_ON_MAPCHANGE);
    }

    private static int SlotOfGear(gear_slot_t? g) => g switch
    {
        gear_slot_t.GEAR_SLOT_RIFLE => 1,
        gear_slot_t.GEAR_SLOT_PISTOL => 2,
        gear_slot_t.GEAR_SLOT_KNIFE => 3,
        _ => 0,
    };

    /// <summary>重生/换边:两轮从数据库重读并重漆(只注入不重建),晚于引擎与第三方插件的上漆。</summary>
    private void ScheduleRepaint(CCSPlayerController? player)
    {
        if (player is not { IsValid: true } || player.IsBot || player.SteamID == 0) return;
        var steam = (ulong)player.SteamID;
        foreach (var delay in new[] { 0.9f, 1.9f })
        {
            _plugin.AddTimer(delay, () =>
            {
                if (player is not { IsValid: true }) return;
                _ = Task.Run(async () =>
                {
                    List<HowlRow> rows;
                    try { rows = await _store.LoadRowsAsync(steam); }
                    catch (Exception ex) { _log.LogWarning("[Howl] 重漆读库失败: " + ex.Message); return; }
                    Server.NextFrame(() =>
                    {
                        if (player is not { IsValid: true } || !player.PawnIsAlive) return;
                        lock (_cacheLock) _cache[steam] = HowlPlugin.Current.LookFromRows(rows);
                        ApplyLive(player, rebuild: false, quiet: true);
                    });
                });
            }, TimerFlags.STOP_ON_MAPCHANGE);
        }
    }

    // ---------- 新武器实体的最终上漆 ----------
    private void OnEntitySpawned(CEntityInstance entity)
    {
        try
        {
            var dn = entity?.DesignerName;
            if (dn is null || !dn.Contains("weapon")) return;
            Server.NextWorldUpdate(() =>
            {
                try
                {
                    if (entity is null || !entity.IsValid) return;
                    if (!_inj.Available) return;
                    var weapon = new CBasePlayerWeapon(entity.Handle);
                    if (!weapon.IsValid) return;
                    CCSPlayerController? ctrl = null;
                    if (weapon.OriginalOwnerXuidLow > 0) ctrl = Utilities.GetPlayerFromSteamId(weapon.OriginalOwnerXuidLow);
                    if (ctrl is not { IsValid: true })
                    {
                        var pawn = weapon.OwnerEntity.Value?.As<CCSPlayerPawn>();
                        ctrl = pawn is { IsValid: true } ? pawn.Controller.Value?.As<CCSPlayerController>() : null;
                    }
                    if (ctrl is not { IsValid: true, IsBot: false } || ctrl.SteamID == 0) return;
                    PlayerLook? look; lock (_cacheLock) _cache.TryGetValue((ulong)ctrl.SteamID, out look);
                    if (look is null) return;
                    var sl = look.For(ctrl.Team == CsTeam.CounterTerrorist);
                    var e = sl.Get(weapon.DesignerName ?? "");
                    if (e.Entity == "knife") e.KnifeDefIndex = sl.KnifeTypeDef;
                    if (!e.HasAnything && !(weapon.DesignerName!.Contains("knife") && sl.KnifeTypeDef > 0)) return;
                    if (_inj.InjectWeapon(ctrl, weapon, e))
                        _log.LogDebug($"[Howl] 新实体上漆 {weapon.DesignerName}(steam={ctrl.SteamID})");
                }
                catch { }
            });
        }
        catch { }
    }

    /// <summary>目录热更新后:在线玩家全部重解析+重漆。</summary>
    public void RepaintAllAfterCatalogSwap()
    {
        foreach (var p in Utilities.GetPlayers())
            if (p is { IsValid: true, IsBot: false } && p.SteamID != 0)
                RefreshAndApply(p, rebuild: true);
    }
}
