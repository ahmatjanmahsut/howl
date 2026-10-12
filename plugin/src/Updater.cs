using System.Text.Json;
using System.Text;
using Microsoft.Extensions.Logging;
using CounterStrikeSharp.API;
using CounterStrikeSharp.API.Core;
using CounterStrikeSharp.API.Modules.Admin;
using CounterStrikeSharp.API.Modules.Utils;

namespace Howl;

/// <summary>
/// Howl 数据自动更新器:
///   · 周期性 HEAD 检查 CSGO-API(ByMykel/CSGO-API)各资源文件的 ETag/Last-Modified;
///   · 变化则全量下载(带重试/退避),JSON 校验 + 安全阈值(防止上游截断/半包数据上线);
///   · 原子替换 data/ 目录后热重载目录(新实例),在线玩家即时重漆,数据库记录版本;
///   · Web 端用同一上游同一算法各自同步(两侧版本在 howl_data_meta 表可比对)。
/// 设计吸取线上教训:绝不在解析失败/数量异常时覆盖现有数据,失败保持旧数据不动。
/// </summary>
public sealed class HowlUpdater
{
    private static readonly (string Res, bool Need)[] Resources =
    [
        ("base_weapons", true), ("skins", true), ("agents", true),
        ("music_kits", true), ("keychains", true), ("stickers", true),
    ];
    private static readonly string[] Langs = ["zh-CN", "en"];

    private readonly HowlPlugin _hp;
    private readonly ILogger _log;
    private readonly string _dataDir;
    private readonly string _stateFile;
    private volatile bool _busy;
    private HttpClient _http;

    public HowlUpdater(HowlPlugin hp, ILogger log, string dataDir)
    {
        _hp = hp; _log = log; _dataDir = dataDir;
        _stateFile = Path.Combine(dataDir, "..", "state", "stamp.txt");
        Directory.CreateDirectory(Path.GetDirectoryName(_stateFile)!);
        _http = BuildClient(hp.Config);
    }

    private static HttpClient BuildClient(HowlConfig cfg)
    {
        var handler = new HttpClientHandler();
        if (!string.IsNullOrWhiteSpace(cfg.ProxyUrl))
        {
            try { handler.Proxy = new System.Net.WebProxy(cfg.ProxyUrl, true); handler.UseProxy = true; } catch { }
        }
        var c = new HttpClient(handler) { Timeout = TimeSpan.FromMinutes(6) };
        c.DefaultRequestHeaders.UserAgent.ParseAdd("Howl-CS2-Skins/1.0 (+CounterStrikeSharp)");
        return c;
    }

    private string Url(string lang, string res) => $"{_hp.Config.ApiBase.TrimEnd('/')}/{lang}/{res}.json";

    /// <summary>HEAD 收集 12 个资源的 etag/last-modified 拼成远端戳。</summary>
    private async Task<string> RemoteStampAsync()
    {
        var sb = new StringBuilder();
        foreach (var lang in Langs)
            foreach (var (res, _) in Resources)
            {
                using var req = new HttpRequestMessage(HttpMethod.Head, Url(lang, res));
                using var resp = await _http.SendAsync(req);
                if (!resp.IsSuccessStatusCode) return "";     // 任何缺失视为不可用
                string? lm = null;
                if (resp.Headers.TryGetValues("Last-Modified", out var lmv)) lm = string.Join(",", lmv);
                var tag = resp.Headers.ETag?.Tag ?? lm ?? resp.Content.Headers.ContentLength?.ToString() ?? "?";
                sb.Append($"{lang}/{res}:{tag};");
            }
        return sb.ToString();
    }

    private string LocalStamp() => File.Exists(_stateFile) ? File.ReadAllText(_stateFile).Trim() : "";

    /// <summary>是否已有成功同步的状态文件(首次部署后为空,插件启动会自动补一次检查)。</summary>
    public bool HasState => File.Exists(_stateFile) && new FileInfo(_stateFile).Length > 0;

    public async Task<string> CheckAndApplyAsync(bool force)
    {
        if (_busy) return "已有更新任务在执行";
        _busy = true;
        try
        {
            var remote = await RemoteStampAsync();
            if (remote.Length == 0) return "远端 HEAD 失败(网络/代理?),保持现有数据";
            var local = LocalStamp();
            if (!force && remote == local && local.Length > 0) return null!;   // 无变化

            // 下载到暂存
            var stage = Path.Combine(_dataDir, "..", "stage");
            if (Directory.Exists(stage)) Directory.Delete(stage, true);
            foreach (var lang in Langs) Directory.CreateDirectory(Path.Combine(stage, lang));
            foreach (var (res, need) in Resources)
                foreach (var lang in Langs)
                {
                    if (lang == "en" && res is "agents" or "music_kits" or "keychains" or "stickers") continue; // en 仅用于双语名,可缺
                    var bytes = await GetWithRetryAsync(Url(lang, res));
                    if (bytes is null) { if (need || lang == "zh-CN") return $"下载失败:{lang}/{res}"; continue; }
                    // JSON 合法性校验
                    try { JsonDocument.Parse(bytes); }
                    catch { return $"JSON 校验失败:{lang}/{res},保持旧数据"; }
                    var tmp = Path.Combine(stage, lang, res + ".json");
                    await File.WriteAllBytesAsync(tmp, bytes);
                }

            // 安全阈值校验 —— 必须在覆盖 data/ 之前完成:
            // 早先的实现把整体阈值检查放在文件覆盖之后,一旦上游数据异常,
            // "拒绝上线"只保住了内存里的旧目录,磁盘上的 data/ 已经被坏数据覆盖,重启即中招。
            var zhSkinsPath = Path.Combine(stage, "zh-CN", "skins.json");
            if (!File.Exists(zhSkinsPath)) return "缺少 zh-CN/skins.json,放弃更新";
            using (var doc = JsonDocument.Parse(await File.ReadAllTextAsync(zhSkinsPath)))
            {
                if (doc.RootElement.ValueKind != JsonValueKind.Array || doc.RootElement.GetArrayLength() < 1500)
                    return $"上游 skins.json 条目异常({(doc.RootElement.ValueKind == JsonValueKind.Array ? doc.RootElement.GetArrayLength() : -1)}),低于安全阈值,放弃";
            }

            // 用暂存目录预加载并做整体阈值校验(暂存目录结构与 data/ 一致)
            var fresh = HowlCatalog.Load(stage, _log);
            var guns = fresh.Weapons.Count(w => w.Skins.Count > 0);
            var knifeSkins = fresh.Knives.Sum(k => k.Skins.Count);
            if (guns < 20 || knifeSkins < 400 || fresh.Agents.Count < 40 || fresh.Music.Count < 50 || fresh.Stickers.Count < 3000)
                return $"新目录数量异常(枪 {guns}/刀皮肤 {knifeSkins}/探员 {fresh.Agents.Count}/音乐 {fresh.Music.Count}/贴纸 {fresh.Stickers.Count}),保持线上数据不动";

            // 校验通过,才逐文件覆盖 data/(Windows/Linux 皆可,目标存在则先删)
            foreach (var lang in Langs)
            {
                var dir = Path.Combine(stage, lang);
                if (!Directory.Exists(dir)) continue;
                var dst = Path.Combine(_dataDir, lang);
                Directory.CreateDirectory(dst);
                foreach (var f in Directory.GetFiles(dir))
                {
                    var to = Path.Combine(dst, Path.GetFileName(f));
                    if (File.Exists(to)) File.Delete(to);
                    File.Move(f, to);
                }
            }
            // 后台线程只做纯 IO:存指纹、写 meta;UI/游戏 API 全部交给主线程 OnTick(见 HowlPlugin.SwapCatalog)
            File.WriteAllText(_stateFile, remote);
            var counts = JsonSerializer.Serialize(new
            {
                weapons = guns, knifeSkins, gloveSkins = fresh.Gloves.Sum(g => g.Skins.Count),
                agents = fresh.Agents.Count, music = fresh.Music.Count, stickers = fresh.Stickers.Count, keychains = fresh.Keychains.Count
            });
            try { await _hp.StoreOf.UpdateGameMetaAsync(fresh.Fingerprint, counts); } catch (Exception ex) { _log.LogWarning("[Howl] 写 meta 失败: " + ex.Message); }
            _hp.SwapCatalog(fresh);
            _log.LogInformation($"[Howl] 数据更新完成:版本 {fresh.Fingerprint[..12]}(已挂主线程热重载)");
            return "更新完成";
        }
        catch (Exception ex)
        {
            _log.LogWarning("[Howl] 更新异常: " + ex.Message);
            return "更新异常:" + ex.Message;
        }
        finally
        {
            _busy = false;
            try { var stage = Path.Combine(_dataDir, "..", "stage"); if (Directory.Exists(stage)) Directory.Delete(stage, true); } catch { }
        }
    }

    private async Task<byte[]?> GetWithRetryAsync(string url)
    {
        for (var i = 0; i < 4; i++)
        {
            try
            {
                using var resp = await _http.GetAsync(url);
                if (!resp.IsSuccessStatusCode) throw new Exception("HTTP " + (int)resp.StatusCode);
                return await resp.Content.ReadAsByteArrayAsync();
            }
            catch (Exception ex)
            {
                _log.LogDebug($"[Howl] 下载重试 {i + 1}/4 {url}: {ex.Message}");
                if (i < 3) await Task.Delay(Math.Min(30000, 2000 * (1 << i)));
            }
        }
        return null;
    }
}
