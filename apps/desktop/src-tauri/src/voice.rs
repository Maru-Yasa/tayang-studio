//! The user's own voice for voice-overs, instead of Tayang credits: an ElevenLabs or Fish Audio
//! API key, or VoiceStudio running on this computer (free, local). The agents still call Tayang's `/voice`
//! (see `ai_proxy`); Tayang sends the text to the source picked in Settings › Video, so every
//! agent works the same way and the key never reaches an agent.

use std::path::Path;
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};

use crate::types::VoiceSource;

pub const ELEVEN_BASE: &str = "https://api.elevenlabs.io";
/// Speaks Indonesian and 28 other languages.
const ELEVEN_MODEL: &str = "eleven_multilingual_v2";
/// "George", a voice every ElevenLabs account has, for when Settings names none.
const ELEVEN_DEFAULT_VOICE: &str = "JBFqnCBsd6RMkjVDRZzb";
pub const FISH_BASE: &str = "https://api.fish.audio";
/// VoiceStudio's local API, up while the app is open.
pub const VOICESTUDIO_BASE: &str = "http://127.0.0.1:3900";
impl VoiceSource {
    /// The name agents and messages use.
    pub fn name(self) -> &'static str {
        match self {
            Self::Tayang => "Tayang",
            Self::Elevenlabs => "ElevenLabs",
            Self::Fishaudio => "Fish Audio",
            Self::Voicestudio => "VoiceStudio",
        }
    }

    /// The keychain account that holds this source's API key; none for a source without one.
    pub fn key_account(self) -> Option<&'static str> {
        match self {
            Self::Elevenlabs => Some("elevenlabs-api-key"),
            Self::Fishaudio => Some("fish-audio-api-key"),
            Self::Tayang | Self::Voicestudio => None,
        }
    }

    /// Where the source's API is.
    pub fn base(self) -> &'static str {
        match self {
            Self::Elevenlabs => ELEVEN_BASE,
            Self::Fishaudio => FISH_BASE,
            Self::Voicestudio => VOICESTUDIO_BASE,
            Self::Tayang => "",
        }
    }
}
/// Fish Audio's production model, and the free one an account with no API credit can use.
const FISH_MODEL: &str = "s2.1-pro";
const FISH_FREE_MODEL: &str = "s2.1-pro-free";
/// VoiceStudio refuses longer text in one call.
const VOICESTUDIO_MAX_CHARS: usize = 4096;
const MAX_BYTES: usize = 60 * 1024 * 1024;

/// Why the user's own voice didn't speak.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum VoiceError {
    /// A source with a key is picked but no key is saved.
    NoKey,
    BadKey,
    /// The account's credit or quota is used up.
    NoBalance,
    /// The voice id in Settings doesn't exist.
    BadVoice,
    /// Nothing answers at VoiceStudio's address: the app isn't open.
    NotRunning,
    TooLong,
    Busy,
    Failed,
}

/// What an agent does when the user's own voice can't speak.
const FALLBACK: &str = "use a free voice (the system's text-to-speech) and tell the user once";

impl VoiceError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::NoKey => "no-key",
            Self::BadKey => "bad-key",
            Self::NoBalance => "no-balance",
            Self::BadVoice => "bad-voice",
            Self::NotRunning => "not-running",
            Self::TooLong => "too-long",
            Self::Busy => "busy",
            Self::Failed => "failed",
        }
    }

    /// The HTTP status and JSON body an agent gets from `/voice`. The message says what to do
    /// next; `name` is the source that was asked.
    pub fn refusal(&self, name: &str) -> (u16, Value) {
        let (status, message) = match self {
            Self::NoKey => (401, format!("The user picked {name} for voice but saved no API key: {FALLBACK} to add the key in Settings › Video")),
            Self::BadKey => (401, format!("The user's {name} API key was refused: {FALLBACK} to check the key in Settings › Video")),
            Self::NoBalance => (402, format!("The user's {name} account has no credit left: {FALLBACK}")),
            Self::BadVoice => (400, format!("The {name} voice id in Settings › Video doesn't exist: {FALLBACK} to fix the voice id")),
            Self::NotRunning => (503, format!("{name} isn't open on this computer: {FALLBACK} to open {name} for its voice")),
            Self::TooLong => (400, "That text is too long for one call: split the narration into parts under 4000 characters, one /voice call each".to_string()),
            Self::Busy => (429, "The voice provider is busy: wait a few seconds and try once more".to_string()),
            Self::Failed => (502, "The voice provider failed: try once more, else use a free voice (the system's text-to-speech)".to_string()),
        };
        (status, json!({ "error": self.code(), "message": message }))
    }
}

/// The audio is kept as `.wav` when that is what came back (VoiceStudio without an mp3 encoder).
fn is_wav(bytes: &[u8]) -> bool {
    bytes.starts_with(b"RIFF")
}

async fn audio(res: reqwest::Response) -> Result<Vec<u8>, VoiceError> {
    let bytes = res.bytes().await.map_err(|_| VoiceError::Failed)?;
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err(VoiceError::Failed);
    }
    Ok(bytes.to_vec())
}

async fn fish_call(client: &reqwest::Client, base: &str, key: &str, model: &str, body: &Value) -> Result<reqwest::Response, VoiceError> {
    client
        .post(format!("{base}/v1/tts"))
        .bearer_auth(key)
        .header("model", model)
        .timeout(Duration::from_secs(180))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|_| VoiceError::Failed)
}

/// Speech from Fish Audio as mp3. `voice_id` is a voice from fish.audio (its `reference_id`); none
/// is Fish Audio's default voice. An account with no API credit gets the free model.
pub async fn fish_speak(client: &reqwest::Client, base: &str, key: &str, text: &str, voice_id: Option<&str>, language: Option<&str>) -> Result<Vec<u8>, VoiceError> {
    if key.is_empty() {
        return Err(VoiceError::NoKey);
    }
    let mut body = json!({ "text": text, "format": "mp3" });
    if let Some(v) = voice_id.filter(|v| !v.is_empty()) {
        body["reference_id"] = json!(v);
    }
    if let Some(l) = language.filter(|l| !l.is_empty()) {
        body["language"] = json!(l);
    }
    let mut res = fish_call(client, base, key, FISH_MODEL, &body).await?;
    if res.status().as_u16() == 402 {
        res = fish_call(client, base, key, FISH_FREE_MODEL, &body).await?;
    }
    match res.status().as_u16() {
        200..=299 => audio(res).await,
        401 | 403 => Err(VoiceError::BadKey),
        402 => Err(VoiceError::NoBalance),
        400 | 404 if voice_id.is_some_and(|v| !v.is_empty()) => Err(VoiceError::BadVoice),
        429 => Err(VoiceError::Busy),
        _ => Err(VoiceError::Failed),
    }
}

/// ElevenLabs says why in `detail.status`.
async fn eleven_error(res: reqwest::Response) -> VoiceError {
    let status = res.status().as_u16();
    let body = res.bytes().await.ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).unwrap_or(Value::Null);
    match body.pointer("/detail/status").and_then(Value::as_str).unwrap_or("") {
        "quota_exceeded" => VoiceError::NoBalance,
        "voice_not_found" => VoiceError::BadVoice,
        "invalid_api_key" | "needs_authorization" | "missing_permissions" => VoiceError::BadKey,
        "too_many_concurrent_requests" | "system_busy" => VoiceError::Busy,
        _ => match status {
            401 | 403 => VoiceError::BadKey,
            402 => VoiceError::NoBalance,
            404 => VoiceError::BadVoice,
            429 => VoiceError::Busy,
            _ => VoiceError::Failed,
        },
    }
}

/// Speech from ElevenLabs as mp3. `voice_id` is a voice from the user's ElevenLabs account; none
/// is the default voice every account has.
pub async fn eleven_speak(client: &reqwest::Client, base: &str, key: &str, text: &str, voice_id: Option<&str>) -> Result<Vec<u8>, VoiceError> {
    if key.is_empty() {
        return Err(VoiceError::NoKey);
    }
    let voice = voice_id.filter(|v| !v.is_empty()).unwrap_or(ELEVEN_DEFAULT_VOICE);
    // A voice id is letters and digits; anything else would change the address.
    if !voice.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(VoiceError::BadVoice);
    }
    let res = client
        .post(format!("{base}/v1/text-to-speech/{voice}?output_format=mp3_44100_128"))
        .header("xi-api-key", key)
        .header("content-type", "application/json")
        .timeout(Duration::from_secs(180))
        .body(json!({ "text": text, "model_id": ELEVEN_MODEL }).to_string())
        .send()
        .await
        .map_err(|_| VoiceError::Failed)?;
    if res.status().is_success() {
        audio(res).await
    } else {
        Err(eleven_error(res).await)
    }
}

/// Speech from VoiceStudio on this computer: its OpenAI-style `/v1/audio/speech`.
pub async fn voicestudio_speak(client: &reqwest::Client, base: &str, text: &str, language: Option<&str>) -> Result<Vec<u8>, VoiceError> {
    if text.chars().count() > VOICESTUDIO_MAX_CHARS {
        return Err(VoiceError::TooLong);
    }
    let mut body = json!({ "model": "tts-1", "voice": "default", "input": text, "response_format": "mp3" });
    if let Some(l) = language.filter(|l| !l.is_empty()) {
        body["language"] = json!(l);
    }
    let res = client
        .post(format!("{base}/v1/audio/speech"))
        // A local model can take minutes on a computer without a GPU.
        .timeout(Duration::from_secs(600))
        .header("content-type", "application/json")
        .body(body.to_string())
        .send()
        .await
        .map_err(|e| if e.is_connect() { VoiceError::NotRunning } else { VoiceError::Failed })?;
    match res.status().as_u16() {
        200..=299 => audio(res).await,
        413 => Err(VoiceError::TooLong),
        429 | 503 => Err(VoiceError::Busy),
        _ => Err(VoiceError::Failed),
    }
}

/// What `speak` needs from Settings and the keychain for the picked source.
pub struct VoiceSetup {
    pub source: VoiceSource,
    /// The source's API key; VoiceStudio has none.
    pub key: Option<String>,
    pub voice_id: Option<String>,
    pub base: String,
}

/// Runs a `/voice` job with the user's own voice and saves it at `out` inside `folder`. Answers
/// like Tayang's own voice does, with no credits charged.
pub async fn speak(client: &reqwest::Client, setup: &VoiceSetup, text: &str, language: Option<&str>, out: &Path, folder: &Path) -> Result<Value, (u16, Value)> {
    let key = setup.key.as_deref().unwrap_or("");
    let voice = setup.voice_id.as_deref();
    let name = setup.source.name();
    let bytes = match setup.source {
        VoiceSource::Elevenlabs => eleven_speak(client, &setup.base, key, text, voice).await,
        VoiceSource::Fishaudio => fish_speak(client, &setup.base, key, text, voice, language).await,
        VoiceSource::Voicestudio => voicestudio_speak(client, &setup.base, text, language).await,
        VoiceSource::Tayang => Err(VoiceError::Failed),
    }
    .map_err(|e| e.refusal(name))?;
    let rel = if is_wav(&bytes) { out.with_extension("wav") } else { out.to_path_buf() };
    let dest = folder.join(&rel);
    let saved = async {
        if let Some(dir) = dest.parent() {
            tokio::fs::create_dir_all(dir).await?;
        }
        let tmp = dest.with_extension("part");
        tokio::fs::write(&tmp, &bytes).await?;
        tokio::fs::rename(&tmp, &dest).await
    };
    saved.await.map_err(|_| VoiceError::Failed.refusal(name))?;
    Ok(json!({
        "files": [rel.to_string_lossy().replace('\\', "/")],
        "creditsCharged": 0,
        "creditsLeft": Value::Null,
    }))
}

/// `/usage` when the user's own voice is on: the same answer, plus that `/voice` costs nothing.
pub fn usage_with_own_voice(usage: Option<Value>, source: VoiceSource) -> Value {
    let mut u = usage.unwrap_or_else(|| json!({ "signedIn": false, "credits": 0, "posts": 0 }));
    let name = match source {
        VoiceSource::Voicestudio => "VoiceStudio on this computer".to_string(),
        other => format!("their {} account", other.name()),
    };
    let images = if u.get("credits").and_then(Value::as_i64).unwrap_or(0) > 0 {
        "Tayang's /image for AI pictures"
    } else {
        "no AI credits for pictures, so build them in code"
    };
    u["ownVoice"] = json!(true);
    u["message"] = json!(format!("The user's own voice is on ({name}): use Tayang's /voice for every voice-over, it costs no credits; {images}"));
    u
}

/// What the Settings screen shows after trying a source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceCheck {
    pub ok: bool,
    /// Why not, as a `VoiceError` code.
    pub error: Option<String>,
    /// The account has credit left; unknown when the key isn't allowed to read it. Fish Audio
    /// without credit speaks with its free model.
    pub has_credit: Option<bool>,
}

impl VoiceCheck {
    fn failed(e: VoiceError) -> Self {
        Self { ok: false, error: Some(e.code().to_string()), has_credit: None }
    }
}

/// Whether Fish Audio takes this key, and whether the account has API credit.
pub async fn fish_check(client: &reqwest::Client, base: &str, key: &str) -> VoiceCheck {
    if key.is_empty() {
        return VoiceCheck::failed(VoiceError::NoKey);
    }
    let res = client.get(format!("{base}/wallet/self/api-credit")).bearer_auth(key).timeout(Duration::from_secs(20)).send().await;
    let Ok(res) = res else { return VoiceCheck::failed(VoiceError::Failed) };
    match res.status().as_u16() {
        200..=299 => {
            let credit = res
                .bytes()
                .await
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                .and_then(|v| v.get("credit").map(|c| c.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| c.as_f64()).unwrap_or(0.0)));
            VoiceCheck { ok: true, error: None, has_credit: credit.map(|c| c > 0.0) }
        }
        401 | 403 => VoiceCheck::failed(VoiceError::BadKey),
        429 => VoiceCheck::failed(VoiceError::Busy),
        _ => VoiceCheck::failed(VoiceError::Failed),
    }
}

/// Whether ElevenLabs takes this key, and whether the account has characters left.
pub async fn eleven_check(client: &reqwest::Client, base: &str, key: &str) -> VoiceCheck {
    if key.is_empty() {
        return VoiceCheck::failed(VoiceError::NoKey);
    }
    let res = client.get(format!("{base}/v1/user/subscription")).header("xi-api-key", key).timeout(Duration::from_secs(20)).send().await;
    let Ok(res) = res else { return VoiceCheck::failed(VoiceError::Failed) };
    if !res.status().is_success() {
        let status = res.status().as_u16();
        let body = res.bytes().await.ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).unwrap_or(Value::Null);
        // A key limited to text-to-speech is a good key that just can't read the account.
        if body.pointer("/detail/status").and_then(Value::as_str) == Some("missing_permissions") {
            return VoiceCheck { ok: true, error: None, has_credit: None };
        }
        return VoiceCheck::failed(match status {
            401 | 403 => VoiceError::BadKey,
            429 => VoiceError::Busy,
            _ => VoiceError::Failed,
        });
    }
    let sub = res.bytes().await.ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok()).unwrap_or(Value::Null);
    let n = |k: &str| sub.get(k).and_then(Value::as_i64);
    let has_credit = match (n("character_count"), n("character_limit")) {
        (Some(used), Some(limit)) => Some(used < limit),
        _ => None,
    };
    VoiceCheck { ok: true, error: None, has_credit }
}

/// Checks a key for a source that has one.
pub async fn key_check(client: &reqwest::Client, source: VoiceSource, base: &str, key: &str) -> VoiceCheck {
    match source {
        VoiceSource::Elevenlabs => eleven_check(client, base, key).await,
        VoiceSource::Fishaudio => fish_check(client, base, key).await,
        VoiceSource::Tayang | VoiceSource::Voicestudio => VoiceCheck::failed(VoiceError::Failed),
    }
}

/// Whether VoiceStudio is open on this computer.
pub async fn voicestudio_check(client: &reqwest::Client, base: &str) -> VoiceCheck {
    match client.get(format!("{base}/v1/audio/voices")).timeout(Duration::from_millis(2500)).send().await {
        Ok(res) if res.status().is_success() => VoiceCheck { ok: true, error: None, has_credit: None },
        Ok(_) => VoiceCheck::failed(VoiceError::Failed),
        Err(_) => VoiceCheck::failed(VoiceError::NotRunning),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::http_client;
    use crate::auth::tests::{dead_base, fake};

    fn setup(source: VoiceSource, base: &str) -> VoiceSetup {
        VoiceSetup { source, key: Some("fk-1".into()), voice_id: Some("voice9".into()), base: base.to_string() }
    }

    #[tokio::test]
    async fn fish_audio_speaks_with_the_users_key_and_voice() {
        let f = fake(|_, _| (200, "ID3-mp3-bytes".into())).await;
        let dir = tempfile::tempdir().unwrap();
        let s = setup(VoiceSource::Fishaudio, &f.base);
        let answer = speak(&http_client().unwrap(), &s, "Halo dunia", Some("id"), Path::new("audio/intro.mp3"), dir.path()).await.unwrap();
        assert_eq!(answer, json!({ "files": ["audio/intro.mp3"], "creditsCharged": 0, "creditsLeft": null }));
        assert_eq!(std::fs::read(dir.path().join("audio/intro.mp3")).unwrap(), b"ID3-mp3-bytes");
        let hits = f.hits("/api/v1/tts");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].auth.as_deref(), Some("Bearer fk-1"));
        let sent: Value = serde_json::from_str(&hits[0].body).unwrap();
        assert_eq!(sent, json!({ "text": "Halo dunia", "format": "mp3", "reference_id": "voice9", "language": "id" }));
    }

    #[tokio::test]
    async fn fish_audio_without_credit_falls_back_to_the_free_model() {
        // The paid model answers 402 first; the second call is the free model.
        let f = fake(|_, nth| if nth == 0 { (402, r#"{"message":"no credit","status":402}"#.into()) } else { (200, "ID3".into()) }).await;
        let got = fish_speak(&http_client().unwrap(), &f.base, "fk-1", "Halo", None, None).await;
        assert_eq!(got, Ok(b"ID3".to_vec()));
        assert_eq!(f.hits("/api/v1/tts").len(), 2);
        // No voice id: none is sent, so Fish Audio picks its default.
        let sent: Value = serde_json::from_str(&f.hits("/api/v1/tts")[0].body).unwrap();
        assert_eq!(sent, json!({ "text": "Halo", "format": "mp3" }));
    }

    #[tokio::test]
    async fn fish_audio_refusals_tell_the_agent_what_to_do() {
        let client = http_client().unwrap();
        assert_eq!(fish_speak(&client, "http://unused", "", "Halo", None, None).await, Err(VoiceError::NoKey));
        for (status, voice, want) in [
            (401, None, VoiceError::BadKey),
            (402, None, VoiceError::NoBalance),
            (404, Some("gone"), VoiceError::BadVoice),
            (400, None, VoiceError::Failed),
            (429, None, VoiceError::Busy),
            (500, None, VoiceError::Failed),
        ] {
            let f = fake(move |_, _| (status, "{}".into())).await;
            assert_eq!(fish_speak(&client, &f.base, "fk-1", "Halo", voice, None).await, Err(want), "{status}");
        }
        let (status, body) = VoiceError::BadKey.refusal("Fish Audio");
        assert_eq!((status, body["error"].as_str()), (401, Some("bad-key")));
        let message = body["message"].as_str().unwrap();
        assert!(message.contains("Fish Audio API key was refused") && message.contains("Settings › Video"), "{message}");
    }

    #[tokio::test]
    async fn voicestudio_speaks_locally_and_keeps_a_wav_as_wav() {
        let f = fake(|_, _| (200, "RIFF....WAVEfmt ".into())).await;
        let dir = tempfile::tempdir().unwrap();
        let s = setup(VoiceSource::Voicestudio, &f.base);
        let answer = speak(&http_client().unwrap(), &s, "Halo dunia", Some("id"), Path::new("audio/intro.mp3"), dir.path()).await.unwrap();
        // No mp3 encoder on that install: the file says what it is.
        assert_eq!(answer["files"], json!(["audio/intro.wav"]));
        assert!(dir.path().join("audio/intro.wav").is_file());
        let hits = f.hits("/api/v1/audio/speech");
        assert_eq!(hits[0].auth, None);
        let sent: Value = serde_json::from_str(&hits[0].body).unwrap();
        assert_eq!(sent, json!({ "model": "tts-1", "voice": "default", "input": "Halo dunia", "response_format": "mp3", "language": "id" }));
    }

    #[tokio::test]
    async fn voicestudio_closed_or_too_much_text() {
        let client = http_client().unwrap();
        assert_eq!(voicestudio_speak(&client, &dead_base().await, "Halo", None).await, Err(VoiceError::NotRunning));
        let long = "a".repeat(VOICESTUDIO_MAX_CHARS + 1);
        assert_eq!(voicestudio_speak(&client, "http://unused", &long, None).await, Err(VoiceError::TooLong));
        let (status, body) = VoiceError::NotRunning.refusal("VoiceStudio");
        assert_eq!(status, 503);
        assert!(body["message"].as_str().unwrap().contains("open VoiceStudio"));
        assert!(!voicestudio_check(&client, &dead_base().await).await.ok);
        let f = fake(|_, _| (200, "{}".into())).await;
        assert!(voicestudio_check(&client, &f.base).await.ok);
    }

    #[tokio::test]
    async fn fish_check_reads_the_key_and_the_credit() {
        let client = http_client().unwrap();
        let paid = fake(|_, _| (200, r#"{"credit":"12.5"}"#.into())).await;
        assert_eq!(fish_check(&client, &paid.base, "fk-1").await, VoiceCheck { ok: true, error: None, has_credit: Some(true) });
        assert_eq!(paid.hits("/api/wallet/self/api-credit")[0].auth.as_deref(), Some("Bearer fk-1"));
        let free = fake(|_, _| (200, r#"{"credit":"0"}"#.into())).await;
        assert_eq!(fish_check(&client, &free.base, "fk-1").await.has_credit, Some(false));
        let bad = fake(|_, _| (401, r#"{"message":"Invalid Token","status":401}"#.into())).await;
        assert_eq!(fish_check(&client, &bad.base, "nope").await, VoiceCheck { ok: false, error: Some("bad-key".into()), has_credit: None });
        assert_eq!(fish_check(&client, "http://unused", "").await.error.as_deref(), Some("no-key"));
    }

    #[tokio::test]
    async fn elevenlabs_speaks_with_the_users_key_and_voice() {
        let f = fake(|_, _| (200, "ID3-eleven".into())).await;
        let dir = tempfile::tempdir().unwrap();
        let s = VoiceSetup { source: VoiceSource::Elevenlabs, key: Some("sk_1".into()), voice_id: Some("Voice123".into()), base: f.base.clone() };
        let answer = speak(&http_client().unwrap(), &s, "Halo dunia", Some("id"), Path::new("audio/intro.mp3"), dir.path()).await.unwrap();
        assert_eq!(answer["files"], json!(["audio/intro.mp3"]));
        assert_eq!(std::fs::read(dir.path().join("audio/intro.mp3")).unwrap(), b"ID3-eleven");
        let hits = f.hits("/api/v1/text-to-speech/Voice123?output_format=mp3_44100_128");
        assert_eq!(hits.len(), 1);
        // The key goes in ElevenLabs' own header, and the multilingual model takes no language.
        assert_eq!(hits[0].auth, None);
        let sent: Value = serde_json::from_str(&hits[0].body).unwrap();
        assert_eq!(sent, json!({ "text": "Halo dunia", "model_id": "eleven_multilingual_v2" }));

        // No voice in Settings: the default voice every account has.
        let got = eleven_speak(&http_client().unwrap(), &f.base, "sk_1", "Halo", None).await;
        assert_eq!(got, Ok(b"ID3-eleven".to_vec()));
        assert_eq!(f.hits("/api/v1/text-to-speech/JBFqnCBsd6RMkjVDRZzb?output_format=mp3_44100_128").len(), 1);
    }

    #[tokio::test]
    async fn elevenlabs_refusals_are_read_from_its_answer() {
        let client = http_client().unwrap();
        assert_eq!(eleven_speak(&client, "http://unused", "", "Halo", None).await, Err(VoiceError::NoKey));
        // A voice id can't carry a path or a query.
        assert_eq!(eleven_speak(&client, "http://unused", "sk_1", "Halo", Some("a/b?x=1")).await, Err(VoiceError::BadVoice));
        for (status, detail, want) in [
            (401, "invalid_api_key", VoiceError::BadKey),
            (401, "quota_exceeded", VoiceError::NoBalance),
            (401, "missing_permissions", VoiceError::BadKey),
            (400, "voice_not_found", VoiceError::BadVoice),
            (429, "too_many_concurrent_requests", VoiceError::Busy),
            (500, "", VoiceError::Failed),
        ] {
            let f = fake(move |_, _| (status, format!(r#"{{"detail":{{"status":"{detail}","message":"x"}}}}"#))).await;
            assert_eq!(eleven_speak(&client, &f.base, "sk_1", "Halo", None).await, Err(want), "{status} {detail}");
        }
        let (status, body) = VoiceError::NoBalance.refusal("ElevenLabs");
        assert_eq!(status, 402);
        assert!(body["message"].as_str().unwrap().contains("ElevenLabs account has no credit left"));
    }

    #[tokio::test]
    async fn elevenlabs_check_reads_the_key_and_the_quota() {
        let client = http_client().unwrap();
        let left = fake(|_, _| (200, r#"{"character_count":1200,"character_limit":10000,"tier":"free"}"#.into())).await;
        assert_eq!(key_check(&client, VoiceSource::Elevenlabs, &left.base, "sk_1").await, VoiceCheck { ok: true, error: None, has_credit: Some(true) });
        let used = fake(|_, _| (200, r#"{"character_count":10000,"character_limit":10000}"#.into())).await;
        assert_eq!(eleven_check(&client, &used.base, "sk_1").await.has_credit, Some(false));
        let bad = fake(|_, _| (401, r#"{"detail":{"status":"invalid_api_key","message":"Invalid API key"}}"#.into())).await;
        assert_eq!(eleven_check(&client, &bad.base, "nope").await.error.as_deref(), Some("bad-key"));
        // A key limited to text-to-speech can't read the account, but it is a good key.
        let limited = fake(|_, _| (401, r#"{"detail":{"status":"missing_permissions","message":"x"}}"#.into())).await;
        assert_eq!(eleven_check(&client, &limited.base, "sk_tts").await, VoiceCheck { ok: true, error: None, has_credit: None });
    }

    #[test]
    fn usage_says_the_own_voice_is_free() {
        let u = usage_with_own_voice(Some(json!({ "signedIn": true, "credits": 0, "posts": 0, "message": "No AI credits left" })), VoiceSource::Voicestudio);
        assert_eq!(u["ownVoice"], json!(true));
        let m = u["message"].as_str().unwrap();
        assert!(m.contains("VoiceStudio") && m.contains("costs no credits") && m.contains("build them in code"), "{m}");
        // Signed out, or Tayang unreachable: the voice still works.
        let u = usage_with_own_voice(None, VoiceSource::Fishaudio);
        assert_eq!((u["signedIn"].clone(), u["ownVoice"].clone()), (json!(false), json!(true)));
        assert!(u["message"].as_str().unwrap().contains("their Fish Audio account"));
        assert!(usage_with_own_voice(None, VoiceSource::Elevenlabs)["message"].as_str().unwrap().contains("their ElevenLabs account"));
    }
}
