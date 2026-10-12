using System.Text.Json.Serialization;
using CounterStrikeSharp.API.Core;

namespace Howl;

/// <summary>数据库连接配置。</summary>
public sealed class DatabaseConfig
{
    [JsonPropertyName("Host")] public string Host { get; set; } = "127.0.0.1";
    [JsonPropertyName("Port")] public int Port { get; set; } = 3306;
    [JsonPropertyName("User")] public string User { get; set; } = "howl";
    [JsonPropertyName("Password")] public string Password { get; set; } = "";
    [JsonPropertyName("Database")] public string Database { get; set; } = "howl";
}

/// <summary>功能开关(与 AstraSkins 的 Config 思路一致:关掉某类,菜单与注入都跳过)。</summary>
public sealed class FeatureConfig
{
    [JsonPropertyName("Stickers")] public bool Stickers { get; set; } = true;
    [JsonPropertyName("Keychains")] public bool Keychains { get; set; } = true;
    [JsonPropertyName("Nametags")] public bool Nametags { get; set; } = true;
    [JsonPropertyName("StatTrak")] public bool StatTrak { get; set; } = true;
    [JsonPropertyName("Gloves")] public bool Gloves { get; set; } = true;
    [JsonPropertyName("Agents")] public bool Agents { get; set; } = true;
    [JsonPropertyName("MusicKits")] public bool MusicKits { get; set; } = true;
}

/// <summary>Howl 插件配置(configs/plugins/Howl/Howl.json)。</summary>
public sealed class HowlConfig : BasePluginConfig
{
    [JsonPropertyName("Database")] public DatabaseConfig Database { get; set; } = new();
    [JsonPropertyName("WebUrl")] public string WebUrl { get; set; } = "http://127.0.0.1:8090";
    [JsonPropertyName("BindCodeTtlMinutes")] public int BindCodeTtlMinutes { get; set; } = 15;
    [JsonPropertyName("InstantApplySeconds")] public int InstantApplySeconds { get; set; } = 3;
    [JsonPropertyName("MaxStickersPerWeapon")] public int MaxStickersPerWeapon { get; set; } = 5;
    [JsonPropertyName("MenuPageSize")] public int MenuPageSize { get; set; } = 30;
    [JsonPropertyName("TeamSpecificLoadouts")] public bool TeamSpecificLoadouts { get; set; } = true;
    [JsonPropertyName("Features")] public FeatureConfig Features { get; set; } = new();
    [JsonPropertyName("AutoUpdate")] public bool AutoUpdate { get; set; } = true;
    [JsonPropertyName("UpdateCheckMinutes")] public int UpdateCheckMinutes { get; set; } = 360;
    [JsonPropertyName("ApiBase")] public string ApiBase { get; set; } = "https://raw.githubusercontent.com/ByMykel/CSGO-API/main/public/api";
    [JsonPropertyName("ProxyUrl")] public string ProxyUrl { get; set; } = "";
}
