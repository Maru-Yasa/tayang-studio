//! "Your API": the user brings only an API key (DeepSeek, 9router, CommandCode or any
//! OpenAI-compatible address) and Tayang runs a pinned opencode release as the agent behind it.
//! The user never sees or configures opencode: Tayang downloads it into its app-data folder and
//! starts `opencode acp` with one provider passed in `OPENCODE_CONFIG_CONTENT`.
//!
//! The key lives in the OS keychain (see `commands::api_key_store`), the provider, address and
//! model in Settings (`apiProvider`).

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The opencode release Tayang runs. Bumped by hand after trying it.
pub const ENGINE_VERSION: &str = "1.19.5";
const RELEASE_BASE: &str = "https://github.com/anomalyco/opencode/releases/download";
/// The keychain account that holds the provider's key.
pub const KEY_ACCOUNT: &str = "provider-api-key";
/// The env var the engine reads the key from (the config says `{env:TAYANG_PROVIDER_KEY}`).
pub const KEY_ENV: &str = "TAYANG_PROVIDER_KEY";
/// opencode's id for the one provider Tayang configures; models are `tayang/<model>`.
pub const PROVIDER_ID: &str = "tayang";

/// The provider the user set up. `provider` is the preset the UI picked (`deepseek`, `9router`,
/// `commandcode`, `other`) and only names it; `base_url` is what is called.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ApiProvider {
    pub provider: String,
    pub base_url: String,
    pub model: String,
    /// Every model the key can use (from the check), offered in the chat's model menu.
    #[serde(default)]
    pub models: Vec<String>,
}

/// Display names of the presets, for opencode's model menu.
fn provider_name(provider: &str) -> &str {
    match provider {
        "deepseek" => "DeepSeek",
        "9router" => "9router",
        "commandcode" => "CommandCode",
        _ => "Your API",
    }
}

/// The address with no trailing slash; `None` unless it is an http(s) URL.
pub fn clean_base_url(raw: &str) -> Option<String> {
    let url = raw.trim().trim_end_matches('/');
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"))?;
    (!rest.is_empty() && !rest.starts_with('/') && !url.contains(char::is_whitespace)).then(|| url.to_string())
}

pub fn models_url(base_url: &str) -> String {
    format!("{}/models", base_url.trim_end_matches('/'))
}

/// The model ids in an OpenAI-style `GET /models` answer (`{ "data": [{ "id" }] }`), sorted.
pub fn parse_models(body: &Value) -> Option<Vec<String>> {
    let data = body.get("data")?.as_array()?;
    // Some routers (CommandCode) list models that only speak another format, like Anthropic's
    // `/messages`; the engine calls `/chat/completions`, so those are left out.
    let chat = |m: &&Value| match m.get("supported_endpoints").and_then(Value::as_array) {
        Some(eps) => eps.iter().any(|e| e.as_str() == Some("/chat/completions")),
        None => true,
    };
    let mut ids: Vec<String> = data
        .iter()
        .filter(chat)
        .filter_map(|m| m.get("id").and_then(Value::as_str))
        // Embedding models can't hold a conversation.
        .filter(|id| !id.to_ascii_lowercase().contains("embed"))
        .map(str::to_string)
        .collect();
    ids.sort();
    ids.dedup();
    Some(ids)
}

/// Why checking the key failed, in words the UI can name.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ApiFailure {
    /// The key is wrong or revoked.
    Unauthorized,
    /// The account has no balance left.
    NoBalance,
    /// The plan doesn't include the API (CommandCode's Go plan).
    UpgradeRequired,
    /// Nothing answers at the address (9router not running, typo, offline).
    Unreachable,
    /// Something answered but has no model list there (wrong address).
    NotFound,
    Other,
}

/// What a failed answer means. `body` is the response text, which may carry the provider's own
/// error code.
pub fn classify_failure(status: u16, body: &str) -> ApiFailure {
    let lower = body.to_ascii_lowercase();
    if lower.contains("upgrade_required") || lower.contains("upgrade required") {
        return ApiFailure::UpgradeRequired;
    }
    if status == 402 || lower.contains("insufficient balance") || lower.contains("insufficient_quota") {
        return ApiFailure::NoBalance;
    }
    match status {
        401 | 403 => ApiFailure::Unauthorized,
        404 | 405 => ApiFailure::NotFound,
        _ => ApiFailure::Other,
    }
}

/// The result of checking an address and key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApiCheck {
    pub ok: bool,
    pub models: Vec<String>,
    pub failure: Option<ApiFailure>,
    /// The provider's own message, shown under the plain one.
    pub detail: Option<String>,
}

impl ApiCheck {
    fn failed(failure: ApiFailure, detail: Option<String>) -> Self {
        Self { ok: false, models: Vec::new(), failure: Some(failure), detail }
    }
}

/// The provider's message from an error body (`{"error":{"message"}}` or `{"message"}`), else the
/// start of the text.
fn error_detail(body: &str) -> Option<String> {
    let from_json = serde_json::from_str::<Value>(body).ok().and_then(|v| {
        let e = v.get("error").cloned().unwrap_or(Value::Null);
        e.get("message")
            .or_else(|| v.get("message"))
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| e.as_str().map(str::to_string))
    });
    let text = from_json.unwrap_or_else(|| body.chars().take(200).collect());
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_string())
}

/// Lists the models at `base_url` with `key`, which also checks the key.
pub async fn check(client: &reqwest::Client, base_url: &str, key: &str) -> ApiCheck {
    let mut req = client.get(models_url(base_url));
    if !key.trim().is_empty() {
        req = req.bearer_auth(key.trim());
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return ApiCheck::failed(ApiFailure::Unreachable, Some(e.to_string())),
    };
    let status = resp.status().as_u16();
    let body = resp.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return ApiCheck::failed(classify_failure(status, &body), error_detail(&body));
    }
    match serde_json::from_str::<Value>(&body).ok().as_ref().and_then(parse_models) {
        Some(models) if !models.is_empty() => ApiCheck { ok: true, models, failure: None, detail: None },
        Some(_) => ApiCheck::failed(ApiFailure::Other, Some("The provider returned no models".into())),
        None => ApiCheck::failed(ApiFailure::NotFound, error_detail(&body)),
    }
}

/// One real one-token chat call with `model`: the only proof that the key, the balance and the model
/// all work (some providers list their models without asking for a key).
pub async fn try_model(client: &reqwest::Client, base_url: &str, key: &str, model: &str) -> ApiCheck {
    let url = format!("{}/chat/completions", base_url.trim_end_matches('/'));
    let body = json!({ "model": model, "messages": [{ "role": "user", "content": "Say ok" }], "max_tokens": 1, "stream": false });
    let mut req = client.post(url).header("content-type", "application/json").body(body.to_string());
    if !key.trim().is_empty() {
        req = req.bearer_auth(key.trim());
    }
    let resp = match req.send().await {
        Ok(r) => r,
        Err(e) => return ApiCheck::failed(ApiFailure::Unreachable, Some(e.to_string())),
    };
    let status = resp.status().as_u16();
    let text = resp.text().await.unwrap_or_default();
    if (200..300).contains(&status) {
        ApiCheck { ok: true, models: vec![model.to_string()], failure: None, detail: None }
    } else {
        ApiCheck::failed(classify_failure(status, &text), error_detail(&text))
    }
}

/// Whether anything answers at `base_url` (for "9router is running on this computer").
pub async fn reachable(client: &reqwest::Client, base_url: &str) -> bool {
    client.get(models_url(base_url)).send().await.is_ok()
}

/// opencode's config: the one provider with its models, the picked one as default, and only that
/// provider enabled (so opencode's own free models stay out of the model menu).
pub fn opencode_config(p: &ApiProvider) -> Value {
    let mut models = serde_json::Map::new();
    for m in p.models.iter().chain(std::iter::once(&p.model)) {
        models.insert(m.clone(), json!({ "name": m }));
    }
    json!({
        "$schema": "https://opencode.ai/config.json",
        "model": format!("{PROVIDER_ID}/{}", p.model),
        "enabled_providers": [PROVIDER_ID],
        "autoupdate": false,
        "share": "disabled",
        "provider": {
            PROVIDER_ID: {
                "npm": "@ai-sdk/openai-compatible",
                "name": provider_name(&p.provider),
                "options": { "baseURL": p.base_url, "apiKey": format!("{{env:{KEY_ENV}}}") },
                "models": models,
            }
        }
    })
}

/// The environment the engine runs with: the provider, the key, and opencode kept away from the
/// user's own opencode setup, its free models, its updates and Claude Code's files.
pub fn session_env(p: &ApiProvider, key: &str, config_dir: &Path, data_dir: &Path) -> Vec<(String, String)> {
    vec![
        ("OPENCODE_CONFIG_CONTENT".into(), opencode_config(p).to_string()),
        ("OPENCODE_CONFIG_DIR".into(), config_dir.to_string_lossy().into_owned()),
        ("XDG_DATA_HOME".into(), data_dir.to_string_lossy().into_owned()),
        ("OPENCODE_DISABLE_AUTOUPDATE".into(), "1".into()),
        ("OPENCODE_DISABLE_FREE_MODELS".into(), "1".into()),
        ("OPENCODE_DISABLE_CLAUDE_CODE".into(), "1".into()),
        ("OPENCODE_DISABLE_PROJECT_CONFIG".into(), "1".into()),
        (KEY_ENV.into(), key.to_string()),
    ]
}

// ---- the engine binary ----

/// The release file for this OS and CPU. x64 uses the baseline build, which also runs on CPUs
/// without AVX2.
pub fn engine_asset(os: &str, arch: &str) -> Option<&'static str> {
    Some(match (os, arch) {
        ("macos", "aarch64") => "opencode-darwin-arm64.zip",
        ("macos", "x86_64") => "opencode-darwin-x64-baseline.zip",
        ("windows", "x86_64") => "opencode-windows-x64-baseline.zip",
        ("windows", "aarch64") => "opencode-windows-arm64.zip",
        ("linux", "x86_64") => "opencode-linux-x64-baseline.tar.gz",
        ("linux", "aarch64") => "opencode-linux-arm64.tar.gz",
        _ => return None,
    })
}

pub fn engine_url(asset: &str) -> String {
    format!("{RELEASE_BASE}/v{ENGINE_VERSION}/{asset}")
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "opencode.exe"
    } else {
        "opencode"
    }
}

/// `<app_data>/engine`: each version in its own folder, plus opencode's config folder.
pub fn engine_root(data_dir: &Path) -> PathBuf {
    data_dir.join("engine")
}

/// opencode's own config folder for Tayang's sessions (empty: the config comes in the env).
pub fn engine_config_dir(data_dir: &Path) -> PathBuf {
    engine_root(data_dir).join("config")
}

pub fn engine_data_dir(data_dir: &Path) -> PathBuf {
    engine_root(data_dir).join("data")
}

pub fn engine_binary(data_dir: &Path) -> PathBuf {
    engine_root(data_dir).join(format!("opencode-{ENGINE_VERSION}")).join(exe_name())
}

/// The engine, when it has been downloaded.
pub fn installed_engine(data_dir: &Path) -> Option<PathBuf> {
    Some(engine_binary(data_dir)).filter(|p| p.is_file())
}

/// The opencode binary from a downloaded release archive.
fn extract(archive: &Path, asset: &str, into: &Path) -> Result<PathBuf, String> {
    std::fs::create_dir_all(into).map_err(|e| e.to_string())?;
    let out = into.join(exe_name());
    let file = std::fs::File::open(archive).map_err(|e| e.to_string())?;
    if asset.ends_with(".zip") {
        let mut zip = zip::ZipArchive::new(file).map_err(|e| e.to_string())?;
        let mut entry = zip.by_name(exe_name()).map_err(|e| format!("{} isn't in the download: {e}", exe_name()))?;
        let mut dst = std::fs::File::create(&out).map_err(|e| e.to_string())?;
        std::io::copy(&mut entry, &mut dst).map_err(|e| e.to_string())?;
    } else {
        extract_tar_gz(file, &out)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&out, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[cfg(target_os = "linux")]
fn extract_tar_gz(file: std::fs::File, out: &Path) -> Result<(), String> {
    let mut tar = tar::Archive::new(flate2::read::GzDecoder::new(file));
    for entry in tar.entries().map_err(|e| e.to_string())? {
        let mut entry = entry.map_err(|e| e.to_string())?;
        let is_bin = entry.path().ok().and_then(|p| p.file_name().map(|n| n == exe_name())).unwrap_or(false);
        if is_bin {
            let mut dst = std::fs::File::create(out).map_err(|e| e.to_string())?;
            std::io::copy(&mut entry, &mut dst).map_err(|e| e.to_string())?;
            return Ok(());
        }
    }
    Err("opencode isn't in the download".into())
}

#[cfg(not(target_os = "linux"))]
fn extract_tar_gz(_file: std::fs::File, _out: &Path) -> Result<(), String> {
    Err("tar.gz releases are only used on Linux".into())
}

/// Downloads and unpacks the engine unless it is there, reporting `(done, total)` bytes. Older
/// versions are removed once the new one is in place.
pub async fn install_engine(
    client: &reqwest::Client,
    data_dir: &Path,
    progress: impl Fn(u64, Option<u64>),
) -> Result<PathBuf, String> {
    if let Some(bin) = installed_engine(data_dir) {
        return Ok(bin);
    }
    let asset = engine_asset(std::env::consts::OS, std::env::consts::ARCH)
        .ok_or("Your API isn't available for this computer's system yet")?;
    let root = engine_root(data_dir);
    std::fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let archive = root.join(format!("{asset}.part"));
    let mut resp = client
        .get(engine_url(asset))
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Couldn't download the engine: {e}"))?;
    let total = resp.content_length();
    {
        use std::io::Write;
        let mut f = std::fs::File::create(&archive).map_err(|e| e.to_string())?;
        let mut done = 0u64;
        progress(0, total);
        while let Some(chunk) = resp.chunk().await.map_err(|e| format!("The download stopped: {e}"))? {
            f.write_all(&chunk).map_err(|e| e.to_string())?;
            done += chunk.len() as u64;
            progress(done, total);
        }
        f.flush().map_err(|e| e.to_string())?;
    }
    let final_dir = engine_binary(data_dir).parent().map(Path::to_path_buf).ok_or("bad engine path")?;
    let staging = root.join(format!("opencode-{ENGINE_VERSION}.tmp"));
    let _ = std::fs::remove_dir_all(&staging);
    let (archive2, staging2, asset2) = (archive.clone(), staging.clone(), asset.to_string());
    tokio::task::spawn_blocking(move || extract(&archive2, &asset2, &staging2))
        .await
        .map_err(|e| e.to_string())??;
    let _ = std::fs::remove_file(&archive);
    let _ = std::fs::remove_dir_all(&final_dir);
    std::fs::rename(&staging, &final_dir).map_err(|e| e.to_string())?;
    remove_old_engines(&root);
    Ok(engine_binary(data_dir))
}

/// Folders of other engine versions.
fn remove_old_engines(root: &Path) {
    let keep = format!("opencode-{ENGINE_VERSION}");
    let Ok(entries) = std::fs::read_dir(root) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        if name.starts_with("opencode-") && name != keep && e.path().is_dir() {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn deepseek() -> ApiProvider {
        ApiProvider {
            provider: "deepseek".into(),
            base_url: "https://api.deepseek.com".into(),
            model: "deepseek-chat".into(),
            models: vec!["deepseek-chat".into(), "deepseek-reasoner".into()],
        }
    }

    #[test]
    fn cleans_base_urls() {
        assert_eq!(clean_base_url(" https://api.deepseek.com/ "), Some("https://api.deepseek.com".into()));
        assert_eq!(clean_base_url("http://localhost:20128/v1"), Some("http://localhost:20128/v1".into()));
        assert_eq!(clean_base_url("api.deepseek.com"), None);
        assert_eq!(clean_base_url("https://"), None);
        assert_eq!(clean_base_url("https://a b"), None);
        assert_eq!(clean_base_url("ftp://x"), None);
    }

    #[test]
    fn reads_openai_model_lists() {
        let body = json!({ "object": "list", "data": [{ "id": "deepseek-reasoner" }, { "id": "deepseek-chat" }, { "id": "deepseek-chat" }] });
        assert_eq!(parse_models(&body), Some(vec!["deepseek-chat".into(), "deepseek-reasoner".into()]));
        assert_eq!(parse_models(&json!({ "error": "x" })), None);
        let mixed = json!({ "data": [
            { "id": "claude-sonnet-5", "supported_endpoints": ["/messages"] },
            { "id": "z-ai/glm-5.3-flash", "supported_endpoints": ["/chat/completions"] },
            { "id": "plain" },
            { "id": "gemini/gemini-embedding-001" },
            { "id": "text-embedding-3-small" },
        ] });
        assert_eq!(parse_models(&mixed), Some(vec!["plain".into(), "z-ai/glm-5.3-flash".into()]));
        assert_eq!(models_url("http://localhost:20128/v1/"), "http://localhost:20128/v1/models");
    }

    #[test]
    fn names_failures() {
        assert_eq!(classify_failure(401, "{\"error\":{\"message\":\"invalid key\"}}"), ApiFailure::Unauthorized);
        assert_eq!(classify_failure(402, "Insufficient Balance"), ApiFailure::NoBalance);
        assert_eq!(classify_failure(403, "{\"error\":{\"code\":\"upgrade_required\"}}"), ApiFailure::UpgradeRequired);
        assert_eq!(classify_failure(404, "not found"), ApiFailure::NotFound);
        assert_eq!(classify_failure(500, "boom"), ApiFailure::Other);
        assert_eq!(error_detail("{\"error\":{\"message\":\"Authentication Fails\"}}"), Some("Authentication Fails".into()));
        assert_eq!(error_detail("{\"message\":\"nope\"}"), Some("nope".into()));
        assert_eq!(error_detail("  "), None);
    }

    #[test]
    fn opencode_gets_one_provider_with_the_key_from_env() {
        let c = opencode_config(&deepseek());
        assert_eq!(c["model"], "tayang/deepseek-chat");
        let p = &c["provider"]["tayang"];
        assert_eq!(p["npm"], "@ai-sdk/openai-compatible");
        assert_eq!(p["name"], "DeepSeek");
        assert_eq!(p["options"]["baseURL"], "https://api.deepseek.com");
        assert_eq!(p["options"]["apiKey"], "{env:TAYANG_PROVIDER_KEY}");
        assert!(p["models"]["deepseek-chat"].is_object());
        assert!(p["models"]["deepseek-reasoner"].is_object());
        assert_eq!(c["enabled_providers"], json!(["tayang"]));
        let old = ApiProvider { models: Vec::new(), ..deepseek() };
        assert_eq!(opencode_config(&old)["provider"]["tayang"]["models"].as_object().unwrap().len(), 1, "a saved provider without a list still has its model");
        assert!(!c.to_string().contains("sk-"), "the key never goes in the config");
    }

    #[test]
    fn the_session_env_isolates_opencode() {
        let env = session_env(&deepseek(), "sk-1", Path::new("/data/engine/config"), Path::new("/data/engine/data"));
        let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
        assert_eq!(get("TAYANG_PROVIDER_KEY"), Some("sk-1"));
        assert_eq!(get("OPENCODE_CONFIG_DIR"), Some("/data/engine/config"));
        assert_eq!(get("XDG_DATA_HOME"), Some("/data/engine/data"));
        assert_eq!(get("OPENCODE_DISABLE_FREE_MODELS"), Some("1"));
        assert_eq!(get("OPENCODE_DISABLE_AUTOUPDATE"), Some("1"));
        assert!(get("OPENCODE_CONFIG_CONTENT").unwrap().contains("tayang/deepseek-chat"));
    }

    #[test]
    fn picks_a_release_file_for_each_system() {
        assert_eq!(engine_asset("macos", "aarch64"), Some("opencode-darwin-arm64.zip"));
        assert_eq!(engine_asset("linux", "x86_64"), Some("opencode-linux-x64-baseline.tar.gz"));
        assert_eq!(engine_asset("windows", "x86_64"), Some("opencode-windows-x64-baseline.zip"));
        assert_eq!(engine_asset("freebsd", "x86_64"), None);
        assert!(engine_url("opencode-darwin-arm64.zip").ends_with(&format!("/v{ENGINE_VERSION}/opencode-darwin-arm64.zip")));
    }

    #[test]
    fn unpacks_a_zip_release_and_keeps_one_version() {
        let dir = tempfile::tempdir().unwrap();
        let zip_path = dir.path().join("r.zip");
        {
            use std::io::Write;
            let mut w = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
            w.start_file(exe_name(), zip::write::SimpleFileOptions::default()).unwrap();
            w.write_all(b"#!/bin/sh\n").unwrap();
            w.finish().unwrap();
        }
        let out = extract(&zip_path, "x.zip", &dir.path().join("out")).unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), b"#!/bin/sh\n");

        let root = dir.path().join("engine");
        std::fs::create_dir_all(root.join("opencode-0.1.0")).unwrap();
        std::fs::create_dir_all(root.join(format!("opencode-{ENGINE_VERSION}"))).unwrap();
        std::fs::create_dir_all(root.join("config")).unwrap();
        remove_old_engines(&root);
        assert!(!root.join("opencode-0.1.0").exists());
        assert!(root.join(format!("opencode-{ENGINE_VERSION}")).exists());
        assert!(root.join("config").exists());
    }

    /// Downloads the real release (about 70 MB): `cargo test -- --ignored downloads_the_real_engine`.
    #[tokio::test]
    #[ignore]
    async fn downloads_the_real_engine() {
        let dir = tempfile::tempdir().unwrap();
        let client = reqwest::Client::builder().user_agent("tayang-studio-test").build().unwrap();
        let seen = std::sync::atomic::AtomicU64::new(0);
        let bin = install_engine(&client, dir.path(), |d, _| seen.store(d, std::sync::atomic::Ordering::Relaxed)).await.unwrap();
        assert!(seen.load(std::sync::atomic::Ordering::Relaxed) > 10_000_000);
        let out = std::process::Command::new(&bin).arg("--version").output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), ENGINE_VERSION);
        assert_eq!(installed_engine(dir.path()), Some(bin));
        assert!(std::fs::read_dir(engine_root(dir.path())).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".part")));
    }
}
