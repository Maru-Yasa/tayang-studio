//! Sign in with Google through the Tayang API, device-authorization style. The desktop asks
//! the API for a device code, opens the browser, and polls until the user approves; the
//! token it gets back lives in the OS keychain and never reaches the webview.

use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::styles_sync::endpoint;
use crate::types::{Account, AuthError, AuthStart, AuthState, AuthStatus};
use serde::Deserialize;

/// Keychain service name for every stored token.
pub const SERVICE: &str = "app.tayang.studio";

/// The keychain account for an API base: `api:` + origin + path, without a trailing slash,
/// so a token is bound to the API it came from. Every sign-in path goes through here, so it is
/// also the one guard against plain http: a token only travels over https, or over http to
/// this computer (`localhost`, 127.0.0.0/8, `::1`). Anything else is `Insecure` and has no key.
pub fn account_key(base: &str) -> Result<String, AuthError> {
    let url = reqwest::Url::parse(base.trim()).map_err(|_| AuthError::Server)?;
    let Some(host) = url.host_str() else { return Err(AuthError::Server) };
    let secure = match url.scheme() {
        "https" => true,
        // The URL parser has already lower-cased the host and normalised IPv4 (`127.1`).
        "http" => {
            host == "localhost"
                || host.parse::<std::net::Ipv4Addr>().is_ok_and(|ip| ip.is_loopback())
                || host.trim_start_matches('[').trim_end_matches(']').parse::<std::net::Ipv6Addr>().is_ok_and(|ip| ip.is_loopback())
        }
        _ => return Err(AuthError::Server),
    };
    if !secure {
        return Err(AuthError::Insecure);
    }
    Ok(format!("api:{}{}", url.origin().ascii_serialization(), url.path().trim_end_matches('/')))
}

// ---- token storage ----

/// Why a token store call failed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StoreError {
    /// There's no keychain on this computer (no backend, no Secret Service): auth.json stands in.
    Unavailable(String),
    /// The keychain is there but said no (the user clicked Deny, or it stayed locked). Never a
    /// reason to put the token in a file instead.
    Refused(String),
    /// Anything else, such as auth.json that couldn't be written.
    Failed(String),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unavailable(e) => write!(f, "no keychain: {e}"),
            Self::Refused(e) => write!(f, "the keychain refused: {e}"),
            Self::Failed(e) => f.write_str(e),
        }
    }
}

fn io_err(e: impl ToString) -> StoreError {
    StoreError::Failed(e.to_string())
}

/// Where sign-in tokens live, by keychain account. Injectable so tests never touch the OS keychain.
pub trait TokenStore: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<String>, StoreError>;
    fn set(&self, account: &str, token: &str) -> Result<(), StoreError>;
    /// Deleting a token that isn't there is not an error.
    fn delete(&self, account: &str) -> Result<(), StoreError>;
}

/// In-memory store, for tests.
#[derive(Default)]
pub struct MemoryStore(Mutex<HashMap<String, String>>);

impl TokenStore for MemoryStore {
    fn get(&self, account: &str) -> Result<Option<String>, StoreError> {
        Ok(self.0.lock().unwrap_or_else(|e| e.into_inner()).get(account).cloned())
    }
    fn set(&self, account: &str, token: &str) -> Result<(), StoreError> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).insert(account.into(), token.into());
        Ok(())
    }
    fn delete(&self, account: &str) -> Result<(), StoreError> {
        self.0.lock().unwrap_or_else(|e| e.into_inner()).remove(account);
        Ok(())
    }
}

/// The OS keychain (macOS Keychain, Windows Credential Manager, Secret Service on Linux).
pub struct KeyringStore;

impl KeyringStore {
    fn entry(account: &str) -> Result<keyring::Entry, StoreError> {
        keyring::Entry::new(SERVICE, account).map_err(classify)
    }
}

/// Only "there is no keychain here" is `Unavailable`; a keychain that is there but says no
/// (Deny, a dismissed or locked prompt) is `Refused`.
/// - macOS: no keychain / not available is `NoStorageAccess`; Deny is a `PlatformFailure`
///   (errSecUserCanceled, errSecAuthFailed).
/// - Windows: `NoStorageAccess` is no logon session.
/// - Linux: no Secret Service on the bus fails to connect, a `PlatformFailure`; a locked
///   collection or a dismissed prompt is `NoStorageAccess`.
pub fn classify(e: keyring::Error) -> StoreError {
    let none_here = if cfg!(target_os = "linux") {
        matches!(e, keyring::Error::PlatformFailure(_))
    } else {
        matches!(e, keyring::Error::NoStorageAccess(_))
    };
    if none_here {
        StoreError::Unavailable(e.to_string())
    } else {
        StoreError::Refused(e.to_string())
    }
}

impl TokenStore for KeyringStore {
    fn get(&self, account: &str) -> Result<Option<String>, StoreError> {
        match Self::entry(account)?.get_password() {
            Ok(t) => Ok(Some(t)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(classify(e)),
        }
    }
    fn set(&self, account: &str, token: &str) -> Result<(), StoreError> {
        Self::entry(account)?.set_password(token).map_err(classify)
    }
    fn delete(&self, account: &str) -> Result<(), StoreError> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(classify(e)),
        }
    }
}

/// `<app_data>/auth.json`, `{ account: token }`, readable by this user only (0600 on unix).
/// Used only when the keychain can't be.
pub struct FileStore {
    path: PathBuf,
}

impl FileStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// A missing or damaged file holds no tokens.
    fn read(&self) -> Result<FileMap, StoreError> {
        match std::fs::read(&self.path) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or_default()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(FileMap::new()),
            Err(e) => Err(io_err(e)),
        }
    }

    /// Writes a fresh 0600 file and renames it into place; no tokens left means no file.
    fn write(&self, map: &FileMap) -> Result<(), StoreError> {
        if map.is_empty() {
            return match std::fs::remove_file(&self.path) {
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(io_err(e)),
                _ => Ok(()),
            };
        }
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(io_err)?;
        }
        let tmp = self.path.with_extension("json.tmp");
        let _ = std::fs::remove_file(&tmp);
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        let body = serde_json::to_vec(map).map_err(io_err)?;
        let written = opts.open(&tmp).and_then(|mut f| {
            std::io::Write::write_all(&mut f, &body)?;
            f.sync_all()
        });
        if let Err(e) = written.and_then(|_| std::fs::rename(&tmp, &self.path)) {
            let _ = std::fs::remove_file(&tmp);
            return Err(io_err(e));
        }
        Ok(())
    }
}

impl TokenStore for FileStore {
    fn get(&self, account: &str) -> Result<Option<String>, StoreError> {
        Ok(self.read()?.remove(account))
    }
    fn set(&self, account: &str, token: &str) -> Result<(), StoreError> {
        let mut map = self.read()?;
        map.insert(account.into(), token.into());
        self.write(&map)
    }
    fn delete(&self, account: &str) -> Result<(), StoreError> {
        let mut map = self.read()?;
        if map.remove(account).is_none() {
            return Ok(());
        }
        self.write(&map)
    }
}

/// The keychain, falling back to the file only when there is no keychain at all. A keychain
/// that refuses (Deny) is an error, never a quiet move to the file. The fallback is logged once.
pub struct SecureStore<K: TokenStore> {
    keychain: K,
    file: FileStore,
    warned: AtomicBool,
}

impl<K: TokenStore> SecureStore<K> {
    pub fn new(keychain: K, file: FileStore) -> Self {
        Self { keychain, file, warned: AtomicBool::new(false) }
    }

    fn fallback(&self, why: &StoreError) {
        if !self.warned.swap(true, Ordering::Relaxed) {
            eprintln!("[auth] the keychain isn't available ({why}); keeping the sign-in token in auth.json instead");
        }
    }
}

impl<K: TokenStore> TokenStore for SecureStore<K> {
    /// The keychain first; the file holds a token saved while there was no keychain.
    fn get(&self, account: &str) -> Result<Option<String>, StoreError> {
        match self.keychain.get(account) {
            Ok(Some(t)) => Ok(Some(t)),
            Ok(None) => self.file.get(account),
            Err(e @ StoreError::Unavailable(_)) => {
                self.fallback(&e);
                self.file.get(account)
            }
            Err(e) => Err(e),
        }
    }
    fn set(&self, account: &str, token: &str) -> Result<(), StoreError> {
        match self.keychain.set(account, token) {
            Ok(()) => {
                // A copy from a keychain outage would otherwise linger in the file.
                let _ = self.file.delete(account);
                Ok(())
            }
            Err(e @ StoreError::Unavailable(_)) => {
                self.fallback(&e);
                self.file.set(account, token)
            }
            Err(e) => Err(e),
        }
    }
    fn delete(&self, account: &str) -> Result<(), StoreError> {
        let keychain = self.keychain.delete(account);
        let file = self.file.delete(account);
        match keychain {
            Ok(()) => Ok(()),
            Err(e @ StoreError::Unavailable(_)) => {
                self.fallback(&e);
                file
            }
            Err(e) => Err(e),
        }
    }
}

type FileMap = BTreeMap<String, String>;

// ---- the API ----

/// Per-request timeout for every auth call.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(15);
/// Polls in a row that may fail (network or server) before signing in gives up.
const MAX_POLL_FAILURES: u32 = 3;

/// The client for every auth call. It never follows a redirect: the API doesn't send any, and
/// this way a body holding the device code (or a bearer token) is never replayed elsewhere.
pub fn http_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent(concat!("tayang-studio/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

/// `POST /v1/auth/device` (shared `AuthDeviceResponse`). The device code never leaves Rust.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceCode {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub verification_uri_complete: String,
    pub expires_in: u64,
    pub interval: u64,
}

/// `POST /v1/auth/token`, 200 (shared `AuthTokenResponse`).
#[derive(Debug, Clone, Deserialize)]
pub struct Issued {
    pub token: String,
    pub account: Account,
}

/// One answer from `POST /v1/auth/token`.
#[derive(Debug)]
pub enum PollReply {
    Pending,
    SlowDown,
    Expired,
    Denied,
    Issued(Issued),
    Network,
    Server,
}

/// `GET /v1/me` with a stored token.
#[derive(Debug)]
pub enum Me {
    Account(Account),
    /// 401: the token is no good any more.
    Unauthorized,
    /// Offline, or the API is having a bad moment: keep the token.
    Unavailable,
}

/// The status and body of a response; `None` when the API couldn't be reached.
async fn send(req: reqwest::RequestBuilder) -> Option<(u16, Vec<u8>)> {
    let res = req.send().await.ok()?;
    let status = res.status().as_u16();
    Some((status, res.bytes().await.ok()?.to_vec()))
}

pub async fn request_device(client: &reqwest::Client, base: &str) -> Result<DeviceCode, AuthError> {
    let (status, body) =
        send(client.post(endpoint(base, "/v1/auth/device"))).await.ok_or(AuthError::Network)?;
    match status {
        200..=299 => serde_json::from_slice::<DeviceCode>(&body)
            .ok()
            .filter(|d| !d.device_code.is_empty() && !d.user_code.is_empty())
            .ok_or(AuthError::Server),
        429 => Err(AuthError::RateLimited),
        _ => Err(AuthError::Server),
    }
}

pub async fn poll_token(client: &reqwest::Client, base: &str, device_code: &str) -> PollReply {
    let req = client
        .post(endpoint(base, "/v1/auth/token"))
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::json!({ "deviceCode": device_code }).to_string());
    let Some((status, body)) = send(req).await else { return PollReply::Network };
    #[derive(Deserialize)]
    struct TokenError {
        error: String,
    }
    match status {
        200..=299 => match serde_json::from_slice::<Issued>(&body) {
            Ok(i) if i.token.starts_with("tyg_") && i.token.len() > 4 => PollReply::Issued(i),
            _ => PollReply::Server,
        },
        429 => PollReply::SlowDown,
        400 => match serde_json::from_slice::<TokenError>(&body).map(|e| e.error) {
            Ok(e) if e == "authorization_pending" => PollReply::Pending,
            Ok(e) if e == "slow_down" => PollReply::SlowDown,
            Ok(e) if e == "expired_token" => PollReply::Expired,
            Ok(e) if e == "access_denied" => PollReply::Denied,
            _ => PollReply::Server,
        },
        _ => PollReply::Server,
    }
}

pub async fn fetch_me(client: &reqwest::Client, base: &str, token: &str) -> Me {
    let Some((status, body)) = send(client.get(endpoint(base, "/v1/me")).bearer_auth(token)).await else {
        return Me::Unavailable;
    };
    match status {
        200..=299 => serde_json::from_slice(&body).map(Me::Account).unwrap_or(Me::Unavailable),
        401 => Me::Unauthorized,
        _ => Me::Unavailable,
    }
}

/// `POST /v1/auth/logout`; best effort, the result is ignored.
pub async fn revoke(client: &reqwest::Client, base: &str, token: &str) {
    let req = client.post(endpoint(base, "/v1/auth/logout")).bearer_auth(token).timeout(Duration::from_secs(5));
    let _ = send(req).await;
}

// ---- polling ----

/// What the poller does after a reply.
#[derive(Debug)]
pub enum Step {
    /// Poll again after this many seconds.
    Wait(u64),
    Done(Result<Issued, AuthError>),
}

/// The polling state machine: the interval (seconds) and the failures in a row.
pub struct PollState {
    pub interval: u64,
    failures: u32,
}

impl PollState {
    pub fn new(interval: u64) -> Self {
        Self { interval: interval.clamp(1, 60), failures: 0 }
    }

    pub fn next(&mut self, reply: PollReply) -> Step {
        let failed = |st: &mut Self, why: AuthError| {
            st.failures += 1;
            if st.failures >= MAX_POLL_FAILURES {
                Step::Done(Err(why))
            } else {
                Step::Wait(st.interval)
            }
        };
        match reply {
            PollReply::Pending => {
                self.failures = 0;
                Step::Wait(self.interval)
            }
            PollReply::SlowDown => {
                self.failures = 0;
                self.interval += 5;
                Step::Wait(self.interval)
            }
            PollReply::Expired => Step::Done(Err(AuthError::Expired)),
            PollReply::Denied => Step::Done(Err(AuthError::Denied)),
            PollReply::Issued(i) => Step::Done(Ok(i)),
            PollReply::Network => failed(self, AuthError::Network),
            PollReply::Server => failed(self, AuthError::Server),
        }
    }
}

/// Polls until the code is approved, refused or runs out. One `tick` is a second in the app;
/// tests shrink it.
pub async fn poll_until_done(
    client: &reqwest::Client,
    base: &str,
    device: &DeviceCode,
    tick: Duration,
) -> Result<Issued, AuthError> {
    use tokio::time::{sleep_until, Instant};
    let mut st = PollState::new(device.interval);
    let deadline = Instant::now() + tick * device.expires_in.min(3600) as u32;
    let mut wait = st.interval;
    loop {
        let at = Instant::now() + tick * wait as u32;
        if at > deadline {
            sleep_until(deadline).await;
            return Err(AuthError::Expired);
        }
        sleep_until(at).await;
        match st.next(poll_token(client, base, &device.device_code).await) {
            Step::Wait(w) => wait = w,
            Step::Done(r) => return r,
        }
    }
}

// ---- the signed-in state ----

/// The cached account per keychain account; the app keeps it in the settings table.
pub trait AccountCache: Send + Sync {
    fn load(&self, key: &str) -> Option<Account>;
    fn save(&self, key: &str, account: Option<&Account>);
}

impl AccountCache for crate::db::Db {
    fn load(&self, key: &str) -> Option<Account> {
        self.auth_account(key)
    }
    fn save(&self, key: &str, account: Option<&Account>) {
        if let Err(e) = self.set_auth_account(key, account) {
            eprintln!("[auth] couldn't cache the account: {e}");
        }
    }
}

/// Where `auth://changed` goes.
pub trait AuthSink: Send + Sync {
    fn changed(&self, status: &AuthStatus);
}

pub const EVENT: &str = "auth://changed";

fn make_status(state: AuthState, base: &str, account: Option<Account>, error: Option<AuthError>, offline: bool) -> AuthStatus {
    AuthStatus { state, signed_in: state == AuthState::SignedIn, account, error, offline, api_url: base.to_string() }
}

struct Inner {
    base: String,
    status: AuthStatus,
    /// Bumped by every status change: a refresh applies only when nothing changed meanwhile.
    version: u64,
    /// Bumped by every start, cancel, logout and API switch: a sign-in finishes only while current.
    attempt: u64,
    poll: Option<tokio::task::AbortHandle>,
}

/// Signing in and out, and the state the UI shows. At most one poll task runs.
pub struct Auth {
    store: Arc<dyn TokenStore>,
    /// Held around every store call, so a check-then-delete can't interleave with a save.
    store_lock: Arc<Mutex<()>>,
    cache: Arc<dyn AccountCache>,
    sink: Arc<dyn AuthSink>,
    client: reqwest::Client,
    tick: Duration,
    inner: Mutex<Inner>,
}

impl Auth {
    pub fn new(
        store: Arc<dyn TokenStore>,
        cache: Arc<dyn AccountCache>,
        sink: Arc<dyn AuthSink>,
        tick: Duration,
    ) -> Result<Arc<Self>, String> {
        let inner = Inner {
            base: String::new(),
            status: make_status(AuthState::SignedOut, "", None, None, false),
            version: 0,
            attempt: 0,
            poll: None,
        };
        Ok(Arc::new(Self {
            store,
            store_lock: Arc::default(),
            cache,
            sink,
            client: http_client()?,
            tick,
            inner: Mutex::new(inner),
        }))
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn set(&self, inner: &mut Inner, status: AuthStatus) {
        inner.version += 1;
        inner.status = status.clone();
        self.sink.changed(&status);
    }

    /// Ends the current sign-in, if any; a poll still in flight finds itself out of date.
    fn stop_poll(inner: &mut Inner) {
        inner.attempt += 1;
        if let Some(h) = inner.poll.take() {
            h.abort();
        }
    }

    /// The keychain can block (or ask the user), so it runs off the async threads.
    async fn blocking<T: Send + 'static>(
        &self,
        f: impl FnOnce(&dyn TokenStore) -> Result<T, StoreError> + Send + 'static,
    ) -> Result<T, StoreError> {
        let store = self.store.clone();
        let lock = self.store_lock.clone();
        tokio::task::spawn_blocking(move || {
            let _held = lock.lock().unwrap_or_else(|e| e.into_inner());
            f(store.as_ref())
        })
        .await
        .map_err(io_err)?
    }

    async fn load_token(&self, key: &str) -> Option<String> {
        let key = key.to_string();
        self.blocking(move |s| s.get(&key)).await.unwrap_or_else(|e| {
            eprintln!("[auth] couldn't read the sign-in token: {e}");
            None
        })
    }

    /// The stored token for `base`, for the other API calls Rust makes for the signed-in user
    /// (billing). It never goes to the webview. None when signed out or the address isn't safe.
    pub async fn token(&self, base: &str) -> Option<String> {
        let key = account_key(base.trim()).ok()?;
        self.load_token(&key).await
    }

    /// The no-redirect client every call with the token goes through.
    pub fn client(&self) -> &reqwest::Client {
        &self.client
    }

    /// The current state; never the token.
    pub fn status(&self) -> AuthStatus {
        self.lock().status.clone()
    }

    /// Applies `status` only if nothing else changed the state since `version` was read and no
    /// sign-in has started. Returns the new version.
    fn apply_if(&self, base: &str, version: u64, status: AuthStatus) -> Option<u64> {
        let mut i = self.lock();
        if i.base != base || i.version != version || i.poll.is_some() {
            return None;
        }
        self.set(&mut i, status);
        Some(i.version)
    }

    /// Works out the state for `base`: no token is signed out; otherwise `/v1/me` decides. A 401
    /// clears the token; no answer keeps it and shows the cached account as offline. A new
    /// base stops any sign-in in progress for the old one.
    pub async fn refresh(self: &Arc<Self>, base: &str) {
        let base = base.trim().to_string();
        let mut version = {
            let mut i = self.lock();
            if i.base != base {
                Self::stop_poll(&mut i);
                i.base = base.clone();
            } else if i.poll.is_some() {
                return;
            }
            i.version
        };
        let signed_out = || make_status(AuthState::SignedOut, &base, None, None, false);
        let Ok(key) = account_key(&base) else {
            self.apply_if(&base, version, signed_out());
            return;
        };
        let Some(token) = self.load_token(&key).await else {
            self.cache.save(&key, None);
            self.apply_if(&base, version, signed_out());
            return;
        };
        // Show the account we know right away; /v1/me confirms it.
        if let Some(cached) = self.cache.load(&key) {
            let shown = make_status(AuthState::SignedIn, &base, Some(cached), None, false);
            match self.apply_if(&base, version, shown) {
                Some(v) => version = v,
                None => return,
            }
        }
        let status = match fetch_me(&self.client, &base, &token).await {
            Me::Account(a) => {
                self.cache.save(&key, Some(&a));
                make_status(AuthState::SignedIn, &base, Some(a), None, false)
            }
            Me::Unauthorized => {
                // Only this token: a sign-in may have saved a newer one while /v1/me answered.
                let k = key.clone();
                let removed = self
                    .blocking(move |s| match s.get(&k)? {
                        Some(t) if t == token => s.delete(&k).map(|()| true),
                        _ => Ok(false),
                    })
                    .await;
                match removed {
                    Ok(true) => self.cache.save(&key, None),
                    Ok(false) => return,
                    Err(e) => eprintln!("[auth] couldn't remove a revoked token: {e}"),
                }
                signed_out()
            }
            Me::Unavailable => make_status(AuthState::SignedIn, &base, self.cache.load(&key), None, true),
        };
        self.apply_if(&base, version, status);
    }

    /// Asks the API for a device code and starts the one poll task; any earlier one stops.
    /// `Ok(None)` when it was cancelled before the API answered.
    pub async fn start(self: &Arc<Self>, base: &str) -> Result<Option<AuthStart>, AuthError> {
        let base = base.trim().to_string();
        let attempt = {
            let mut i = self.lock();
            Self::stop_poll(&mut i);
            i.base = base.clone();
            i.attempt
        };
        // No request at all to an address a token couldn't safely come back from.
        if let Err(e) = account_key(&base) {
            let mut i = self.lock();
            if i.attempt == attempt {
                self.set(&mut i, make_status(AuthState::Error, &base, None, Some(e), false));
            }
            return Err(e);
        }
        let device = request_device(&self.client, &base).await.and_then(|d| {
            // Only a web page may be opened from what the API says.
            let ok = |u: &str| reqwest::Url::parse(u).is_ok_and(|u| matches!(u.scheme(), "http" | "https"));
            if ok(&d.verification_uri) && ok(&d.verification_uri_complete) {
                Ok(d)
            } else {
                Err(AuthError::Server)
            }
        });
        let mut i = self.lock();
        if i.attempt != attempt {
            return Ok(None);
        }
        let device = match device {
            Ok(d) => d,
            Err(e) => {
                self.set(&mut i, make_status(AuthState::Error, &base, None, Some(e), false));
                return Err(e);
            }
        };
        let shown = AuthStart {
            user_code: device.user_code.clone(),
            verification_uri: device.verification_uri.clone(),
            verification_uri_complete: device.verification_uri_complete.clone(),
            expires_in: device.expires_in,
        };
        let this = Arc::clone(self);
        let poll_base = base.clone();
        let task = tokio::spawn(async move { this.finish(poll_base, device, attempt).await });
        i.poll = Some(task.abort_handle());
        self.set(&mut i, make_status(AuthState::Pending, &base, None, None, false));
        Ok(Some(shown))
    }

    /// The poll task: waits for the token, keeps it, and says how it went.
    async fn finish(self: Arc<Self>, base: String, device: DeviceCode, attempt: u64) {
        let result = poll_until_done(&self.client, &base, &device, self.tick).await;
        if self.lock().attempt != attempt {
            return;
        }
        let status = match result {
            Ok(Issued { token, account }) => match account_key(&base) {
                Ok(key) => {
                    let k = key.clone();
                    let token_copy = token.clone();
                    match self.blocking(move |s| s.set(&k, &token)).await {
                        Ok(()) => {
                            self.cache.save(&key, Some(&account));
                            make_status(AuthState::SignedIn, &base, Some(account), None, false)
                        }
                        Err(e) => {
                            eprintln!("[auth] couldn't save the sign-in token: {e}");
                            // Nobody holds it now, so it shouldn't stay live at the API.
                            revoke(&self.client, &base, &token_copy).await;
                            let why = if matches!(e, StoreError::Refused(_)) { AuthError::Keychain } else { AuthError::Storage };
                            make_status(AuthState::Error, &base, None, Some(why), false)
                        }
                    }
                }
                Err(e) => make_status(AuthState::Error, &base, None, Some(e), false),
            },
            Err(e) => make_status(AuthState::Error, &base, None, Some(e), false),
        };
        let mut i = self.lock();
        if i.attempt == attempt {
            i.poll = None;
            self.set(&mut i, status);
        }
    }

    /// Stops signing in.
    pub fn cancel(&self) {
        let mut i = self.lock();
        Self::stop_poll(&mut i);
        if matches!(i.status.state, AuthState::Pending | AuthState::Error) {
            let base = i.base.clone();
            self.set(&mut i, make_status(AuthState::SignedOut, &base, None, None, false));
        }
    }

    /// Revokes the token at the API (best effort) and forgets it here.
    pub async fn logout(self: &Arc<Self>, base: &str) -> Result<(), AuthError> {
        let base = base.trim().to_string();
        {
            let mut i = self.lock();
            Self::stop_poll(&mut i);
            i.base = base.clone();
        }
        if let Ok(key) = account_key(&base) {
            if let Some(token) = self.load_token(&key).await {
                revoke(&self.client, &base, &token).await;
            }
            let k = key.clone();
            self.blocking(move |s| s.delete(&k)).await.map_err(|e| {
                eprintln!("[auth] couldn't remove the sign-in token: {e}");
                AuthError::Storage
            })?;
            self.cache.save(&key, None);
        }
        let mut i = self.lock();
        self.set(&mut i, make_status(AuthState::SignedOut, &base, None, None, false));
        Ok(())
    }

    /// App exit: stop polling.
    pub fn shutdown(&self) {
        Self::stop_poll(&mut self.lock());
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn account_key_is_origin_plus_path() {
        assert_eq!(account_key("https://studio.tayang.app/api").unwrap(), "api:https://studio.tayang.app/api");
        assert_eq!(account_key(" https://Studio.Tayang.app:443/api/ ").unwrap(), "api:https://studio.tayang.app/api");
        assert_eq!(account_key("http://localhost:8787/api").unwrap(), "api:http://localhost:8787/api");
        assert_eq!(account_key("http://localhost:8787").unwrap(), "api:http://localhost:8787");
        assert_ne!(account_key("http://localhost:8787/api").unwrap(), account_key("http://127.0.0.1:8787/api").unwrap());
        assert!(account_key("not a url").is_err());
        assert!(account_key("file:///etc/passwd").is_err());
    }

    #[test]
    fn plain_http_is_only_for_this_computer() {
        for ok in ["http://localhost:8787/api", "http://LOCALHOST/api", "http://127.0.0.1:8787/api", "http://127.9.8.7/api", "http://127.1/api", "http://[::1]:8787/api", "https://example.com/api"] {
            assert!(account_key(ok).is_ok(), "{ok}");
        }
        for bad in ["http://studio.tayang.app/api", "http://192.168.1.20:8787/api", "http://10.0.0.1/api", "http://[::2]/api", "http://localhost.evil.com/api", "http://127.0.0.1.evil.com/api", "http://[::ffff:192.168.1.1]/api"] {
            assert_eq!(account_key(bad), Err(AuthError::Insecure), "{bad}");
        }
        assert_eq!(account_key("not a url"), Err(AuthError::Server));
    }

    /// A keychain that always fails the same way.
    struct Broken(StoreError);
    impl TokenStore for Broken {
        fn get(&self, _: &str) -> Result<Option<String>, StoreError> {
            Err(self.0.clone())
        }
        fn set(&self, _: &str, _: &str) -> Result<(), StoreError> {
            Err(self.0.clone())
        }
        fn delete(&self, _: &str) -> Result<(), StoreError> {
            Err(self.0.clone())
        }
    }

    fn no_keychain() -> Broken {
        Broken(StoreError::Unavailable("no backend".into()))
    }

    fn denied() -> Broken {
        Broken(StoreError::Refused("user canceled".into()))
    }

    #[test]
    fn file_store_round_trips_per_account() {
        let dir = tempfile::tempdir().unwrap();
        let f = FileStore::new(dir.path().join("auth.json"));
        assert_eq!(f.get("api:a").unwrap(), None);
        f.set("api:a", "tyg_a").unwrap();
        f.set("api:b", "tyg_b").unwrap();
        assert_eq!(f.get("api:a").unwrap().as_deref(), Some("tyg_a"));
        f.delete("api:a").unwrap();
        f.delete("api:a").unwrap();
        assert_eq!(f.get("api:a").unwrap(), None);
        assert_eq!(f.get("api:b").unwrap().as_deref(), Some("tyg_b"));
        f.delete("api:b").unwrap();
        assert!(!dir.path().join("auth.json").exists(), "no tokens, no file");
    }

    #[cfg(unix)]
    #[test]
    fn file_store_is_private_to_the_user() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        std::fs::write(&path, "{}").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        FileStore::new(path.clone()).set("api:a", "tyg_a").unwrap();
        assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
    }

    #[test]
    fn file_store_survives_a_damaged_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        std::fs::write(&path, "not json").unwrap();
        let f = FileStore::new(path);
        assert_eq!(f.get("api:a").unwrap(), None);
        f.set("api:a", "tyg_a").unwrap();
        assert_eq!(f.get("api:a").unwrap().as_deref(), Some("tyg_a"));
    }

    #[test]
    fn secure_store_uses_the_keychain_and_leaves_no_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let s = SecureStore::new(MemoryStore::default(), FileStore::new(path.clone()));
        s.set("api:a", "tyg_a").unwrap();
        assert_eq!(s.get("api:a").unwrap().as_deref(), Some("tyg_a"));
        assert!(!path.exists());
        assert_eq!(s.keychain.get("api:a").unwrap().as_deref(), Some("tyg_a"));
        s.delete("api:a").unwrap();
        assert_eq!(s.get("api:a").unwrap(), None);
    }

    #[test]
    fn secure_store_falls_back_to_the_file_when_there_is_no_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let s = SecureStore::new(no_keychain(), FileStore::new(path.clone()));
        s.set("api:a", "tyg_a").unwrap();
        assert!(path.exists());
        assert!(s.warned.load(Ordering::Relaxed));
        assert_eq!(s.get("api:a").unwrap().as_deref(), Some("tyg_a"));
        s.delete("api:a").unwrap();
        assert_eq!(s.get("api:a").unwrap(), None);
    }

    #[test]
    fn a_keychain_that_says_no_is_an_error_and_never_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let s = SecureStore::new(denied(), FileStore::new(path.clone()));
        assert!(matches!(s.set("api:a", "tyg_a"), Err(StoreError::Refused(_))));
        assert!(!path.exists(), "a Deny never moves the token to a file");
        assert!(!s.warned.load(Ordering::Relaxed));
        assert!(matches!(s.get("api:a"), Err(StoreError::Refused(_))));
        assert!(matches!(s.delete("api:a"), Err(StoreError::Refused(_))));
    }

    #[test]
    fn keychain_errors_are_sorted_into_none_here_and_said_no() {
        let boxed = || -> Box<dyn std::error::Error + Send + Sync> { "x".into() };
        let (none_here, said_no) = if cfg!(target_os = "linux") {
            (keyring::Error::PlatformFailure(boxed()), keyring::Error::NoStorageAccess(boxed()))
        } else {
            (keyring::Error::NoStorageAccess(boxed()), keyring::Error::PlatformFailure(boxed()))
        };
        assert!(matches!(classify(none_here), StoreError::Unavailable(_)));
        assert!(matches!(classify(said_no), StoreError::Refused(_)));
    }

    #[test]
    fn a_token_saved_while_the_keychain_was_down_is_still_found_and_moves_on_the_next_save() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        FileStore::new(path.clone()).set("api:a", "tyg_old").unwrap();
        let s = SecureStore::new(MemoryStore::default(), FileStore::new(path.clone()));
        assert_eq!(s.get("api:a").unwrap().as_deref(), Some("tyg_old"));
        s.set("api:a", "tyg_new").unwrap();
        assert!(!path.exists(), "the file copy is removed once the keychain holds the token");
        s.delete("api:a").unwrap();
        assert_eq!(s.get("api:a").unwrap(), None);
    }

    // ---- a fake API ----

    #[derive(Debug, Clone)]
    pub(crate) struct Req {
        pub method: String,
        pub path: String,
        pub auth: Option<String>,
        /// Google's `x-goog-api-key` header.
        pub goog_key: Option<String>,
        pub body: String,
    }

    type Handler = Arc<dyn Fn(&Req, usize) -> (u16, String) + Send + Sync>;

    /// A tiny HTTP/1.1 server on 127.0.0.1. `handler` gets each request and how many
    /// requests came before it to the same path; every request is recorded.
    pub(crate) struct Fake {
        pub base: String,
        pub hits: Arc<Mutex<Vec<Req>>>,
    }

    impl Fake {
        pub fn hits(&self, path: &str) -> Vec<Req> {
            self.hits.lock().unwrap().iter().filter(|r| r.path == path).cloned().collect()
        }
    }

    pub(crate) async fn fake(handler: impl Fn(&Req, usize) -> (u16, String) + Send + Sync + 'static) -> Fake {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let handler: Handler = Arc::new(handler);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let base = format!("http://{}/api", listener.local_addr().unwrap());
        let hits: Arc<Mutex<Vec<Req>>> = Arc::default();
        let recorded = hits.clone();
        tokio::spawn(async move {
            while let Ok((mut s, _)) = listener.accept().await {
                let handler = handler.clone();
                let hits = recorded.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let (head, body) = loop {
                        let n = s.read(&mut chunk).await.unwrap_or(0);
                        buf.extend_from_slice(&chunk[..n]);
                        let text = String::from_utf8_lossy(&buf).to_string();
                        if let Some(i) = text.find("\r\n\r\n") {
                            let len = text[..i]
                                .lines()
                                .find_map(|l| l.to_ascii_lowercase().strip_prefix("content-length:").map(|v| v.trim().parse().unwrap_or(0)))
                                .unwrap_or(0usize);
                            if buf.len() >= i + 4 + len || n == 0 {
                                break (text[..i].to_string(), text[i + 4..].to_string());
                            }
                        }
                        if n == 0 {
                            return;
                        }
                    };
                    let mut first = head.lines().next().unwrap_or("").split(' ');
                    let method = first.next().unwrap_or("").to_string();
                    let path = first.next().unwrap_or("").to_string();
                    let auth = head
                        .lines()
                        .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("authorization")).map(|(_, v)| v.trim().to_string()));
                    let goog_key = head
                        .lines()
                        .find_map(|l| l.split_once(':').filter(|(k, _)| k.eq_ignore_ascii_case("x-goog-api-key")).map(|(_, v)| v.trim().to_string()));
                    let req = Req { method, path, auth, goog_key, body };
                    let nth = {
                        let mut h = hits.lock().unwrap();
                        let nth = h.iter().filter(|r| r.path == req.path).count();
                        h.push(req.clone());
                        nth
                    };
                    let (status, body) = handler(&req, nth);
                    // A 3xx body is where it redirects to.
                    let location = if (300..400).contains(&status) { format!("Location: {body}\r\n") } else { String::new() };
                    let res = format!(
                        "HTTP/1.1 {status} X\r\n{location}Content-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                        body.len()
                    );
                    let _ = s.write_all(res.as_bytes()).await;
                    let _ = s.shutdown().await;
                });
            }
        });
        Fake { base, hits }
    }

    /// An address nothing listens on.
    pub(crate) async fn dead_base() -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        drop(l);
        format!("http://{addr}/api")
    }

    pub(crate) const DEVICE: &str = r#"{"deviceCode":"dev-secret","userCode":"ABCD-EFGH","verificationUri":"http://x/api/auth/device","verificationUriComplete":"http://x/api/auth/device?code=ABCD-EFGH","expiresIn":600,"interval":1}"#;
    pub(crate) const ISSUED: &str = r#"{"token":"tyg_abc","account":{"id":"acc_1","email":"a@b.c","name":"Ana","plan":"free","features":[]}}"#;
    pub(crate) const ME: &str = r#"{"id":"acc_1","email":"a@b.c","name":"Ana","plan":"pro","features":["voiceover"],"credits":310}"#;
    pub(crate) fn err(code: &str) -> (u16, String) {
        (400, format!(r#"{{"error":"{code}"}}"#))
    }
    pub(crate) const TICK: Duration = Duration::from_millis(2);

    fn device(interval: u64, expires_in: u64) -> DeviceCode {
        let mut d: DeviceCode = serde_json::from_str(DEVICE).unwrap();
        d.interval = interval;
        d.expires_in = expires_in;
        d
    }

    #[tokio::test]
    async fn request_device_keeps_the_base_path() {
        let f = fake(|_, _| (200, DEVICE.into())).await;
        let d = request_device(&http_client().unwrap(), &format!("{}/", f.base)).await.unwrap();
        assert_eq!((d.user_code.as_str(), d.device_code.as_str(), d.interval), ("ABCD-EFGH", "dev-secret", 1));
        let hits = f.hits("/api/v1/auth/device");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].method, "POST");
    }

    #[tokio::test]
    async fn request_device_errors() {
        let c = http_client().unwrap();
        let f = fake(|_, _| (429, r#"{"error":"rate_limited"}"#.into())).await;
        assert_eq!(request_device(&c, &f.base).await.unwrap_err(), AuthError::RateLimited);
        let f = fake(|_, _| (404, "{}".into())).await;
        assert_eq!(request_device(&c, &f.base).await.unwrap_err(), AuthError::Server);
        let f = fake(|_, _| (200, "<html>".into())).await;
        assert_eq!(request_device(&c, &f.base).await.unwrap_err(), AuthError::Server);
        assert_eq!(request_device(&c, &dead_base().await).await.unwrap_err(), AuthError::Network);
    }

    #[test]
    fn poll_state_respects_interval_and_slow_down() {
        let mut st = PollState::new(5);
        assert!(matches!(st.next(PollReply::Pending), Step::Wait(5)));
        assert!(matches!(st.next(PollReply::SlowDown), Step::Wait(10)));
        assert!(matches!(st.next(PollReply::Pending), Step::Wait(10)));
        assert!(matches!(st.next(PollReply::SlowDown), Step::Wait(15)));
        assert!(matches!(st.next(PollReply::Expired), Step::Done(Err(AuthError::Expired))));
        assert!(matches!(PollState::new(5).next(PollReply::Denied), Step::Done(Err(AuthError::Denied))));
        assert_eq!(PollState::new(0).interval, 1, "never hammer the API");
    }

    #[test]
    fn poll_state_tolerates_a_few_failures_in_a_row() {
        let mut st = PollState::new(5);
        assert!(matches!(st.next(PollReply::Network), Step::Wait(5)));
        assert!(matches!(st.next(PollReply::Server), Step::Wait(5)));
        assert!(matches!(st.next(PollReply::Pending), Step::Wait(5)), "a good reply resets the count");
        assert!(matches!(st.next(PollReply::Network), Step::Wait(5)));
        assert!(matches!(st.next(PollReply::Network), Step::Wait(5)));
        assert!(matches!(st.next(PollReply::Network), Step::Done(Err(AuthError::Network))));
        let mut st = PollState::new(5);
        st.next(PollReply::Server);
        st.next(PollReply::Server);
        assert!(matches!(st.next(PollReply::Server), Step::Done(Err(AuthError::Server))));
    }

    #[tokio::test]
    async fn polls_through_pending_and_slow_down_to_a_token() {
        let f = fake(|r, n| {
            assert_eq!(r.path, "/api/v1/auth/token");
            match n {
                0 => err("authorization_pending"),
                1 => err("slow_down"),
                2 => err("authorization_pending"),
                _ => (200, ISSUED.into()),
            }
        })
        .await;
        let started = std::time::Instant::now();
        let issued = poll_until_done(&http_client().unwrap(), &f.base, &device(1, 600), TICK).await.unwrap();
        assert_eq!(issued.token, "tyg_abc");
        assert_eq!(issued.account.email.as_deref(), Some("a@b.c"));
        let hits = f.hits("/api/v1/auth/token");
        assert_eq!(hits.len(), 4);
        assert!(hits.iter().all(|h| h.method == "POST" && h.body.contains(r#""deviceCode":"dev-secret""#)));
        // 1 + 1 + 6 + 6 ticks: slow_down added five seconds to every wait after it.
        assert!(started.elapsed() >= TICK * 14, "{:?}", started.elapsed());
    }

    #[tokio::test]
    async fn polling_stops_on_deny_and_expiry() {
        let c = http_client().unwrap();
        let f = fake(|_, n| if n == 0 { err("authorization_pending") } else { err("access_denied") }).await;
        assert_eq!(poll_until_done(&c, &f.base, &device(1, 600), TICK).await.unwrap_err(), AuthError::Denied);
        let f = fake(|_, _| err("expired_token")).await;
        assert_eq!(poll_until_done(&c, &f.base, &device(1, 600), TICK).await.unwrap_err(), AuthError::Expired);
        // The code runs out on this side too, even while the server keeps saying pending.
        let f = fake(|_, _| err("authorization_pending")).await;
        assert_eq!(poll_until_done(&c, &f.base, &device(1, 5), TICK).await.unwrap_err(), AuthError::Expired);
        assert!(f.hits("/api/v1/auth/token").len() <= 5);
    }

    #[tokio::test]
    async fn a_token_without_the_tyg_prefix_is_refused() {
        let f = fake(|_, _| (200, ISSUED.replace("tyg_abc", "abc"))).await;
        assert!(matches!(poll_token(&http_client().unwrap(), &f.base, "d").await, PollReply::Server));
    }

    #[tokio::test]
    async fn me_sends_the_bearer_token_and_reads_401() {
        let c = http_client().unwrap();
        let f = fake(|r, _| if r.auth.as_deref() == Some("Bearer tyg_ok") { (200, ME.into()) } else { (401, r#"{"error":"unauthorized"}"#.into()) }).await;
        let Me::Account(a) = fetch_me(&c, &f.base, "tyg_ok").await else { panic!("expected the account") };
        assert_eq!((a.plan.as_str(), a.features.as_slice(), a.credits), ("pro", ["voiceover".to_string()].as_slice(), 310));
        assert_eq!(f.hits("/api/v1/me")[0].method, "GET");
        assert!(matches!(fetch_me(&c, &f.base, "tyg_old").await, Me::Unauthorized));
        let f = fake(|_, _| (503, "{}".into())).await;
        assert!(matches!(fetch_me(&c, &f.base, "tyg_ok").await, Me::Unavailable));
        assert!(matches!(fetch_me(&c, &dead_base().await, "tyg_ok").await, Me::Unavailable));
    }

    #[tokio::test]
    async fn revoke_posts_logout_with_the_token() {
        let f = fake(|_, _| (204, String::new())).await;
        revoke(&http_client().unwrap(), &f.base, "tyg_ok").await;
        let hits = f.hits("/api/v1/auth/logout");
        assert_eq!((hits[0].method.as_str(), hits[0].auth.as_deref()), ("POST", Some("Bearer tyg_ok")));
        revoke(&http_client().unwrap(), &dead_base().await, "tyg_ok").await;
    }

    // ---- the signed-in state ----

    #[derive(Default)]
    struct MemCache(Mutex<HashMap<String, Account>>);
    impl AccountCache for MemCache {
        fn load(&self, key: &str) -> Option<Account> {
            self.0.lock().unwrap().get(key).cloned()
        }
        fn save(&self, key: &str, account: Option<&Account>) {
            let mut m = self.0.lock().unwrap();
            match account {
                Some(a) => m.insert(key.into(), a.clone()),
                None => m.remove(key),
            };
        }
    }

    #[derive(Default)]
    struct Rec(Mutex<Vec<AuthStatus>>);
    impl AuthSink for Rec {
        fn changed(&self, status: &AuthStatus) {
            self.0.lock().unwrap().push(status.clone());
        }
    }
    impl Rec {
        fn all(&self) -> Vec<AuthStatus> {
            self.0.lock().unwrap().clone()
        }
        fn last(&self) -> Option<AuthStatus> {
            self.0.lock().unwrap().last().cloned()
        }
    }

    struct Rig {
        auth: Arc<Auth>,
        store: Arc<MemoryStore>,
        cache: Arc<MemCache>,
        rec: Arc<Rec>,
    }

    fn rig() -> Rig {
        let store = Arc::new(MemoryStore::default());
        let cache = Arc::new(MemCache::default());
        let rec = Arc::new(Rec::default());
        let auth = Auth::new(store.clone(), cache.clone(), rec.clone(), TICK).unwrap();
        Rig { auth, store, cache, rec }
    }

    fn account(plan: &str) -> Account {
        Account { id: "acc_1".into(), email: Some("a@b.c".into()), name: Some("Ana".into()), plan: plan.into(), features: vec![], credits: 0 }
    }

    fn key(base: &str) -> String {
        account_key(base).unwrap()
    }

    async fn until(rec: &Rec, want: impl Fn(&AuthStatus) -> bool) -> AuthStatus {
        for _ in 0..500 {
            if let Some(s) = rec.last().filter(|s| want(s)) {
                return s;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("never got there; events: {:?}", rec.all());
    }

    /// A fake API that issues a token after two pending polls and knows that token at /v1/me.
    async fn api() -> Fake {
        fake(|r, n| match r.path.as_str() {
            "/api/v1/auth/device" => (200, DEVICE.into()),
            "/api/v1/auth/token" if n < 2 => err("authorization_pending"),
            "/api/v1/auth/token" => (200, ISSUED.into()),
            "/api/v1/me" if r.auth.as_deref() == Some("Bearer tyg_abc") => (200, ME.into()),
            "/api/v1/me" => (401, r#"{"error":"unauthorized"}"#.into()),
            "/api/v1/auth/logout" => (204, String::new()),
            _ => (404, "{}".into()),
        })
        .await
    }

    #[tokio::test]
    async fn token_is_the_stored_one_for_that_base_only() {
        let r = rig();
        r.store.set(&key("http://localhost:8787/api"), "tyg_abc").unwrap();
        assert_eq!(r.auth.token(" http://localhost:8787/api/ ").await.as_deref(), Some("tyg_abc"));
        assert_eq!(r.auth.token("https://studio.tayang.app/api").await, None);
        assert_eq!(r.auth.token("http://example.com/api").await, None, "never over plain http to another computer");
    }

    #[tokio::test]
    async fn no_token_is_signed_out() {
        let r = rig();
        let f = api().await;
        r.auth.refresh(&f.base).await;
        let s = r.auth.status();
        assert_eq!((s.state, s.signed_in, s.api_url.as_str()), (AuthState::SignedOut, false, f.base.as_str()));
        assert_eq!(r.rec.last(), Some(s));
        assert!(f.hits("/api/v1/me").is_empty(), "nothing to check without a token");
    }

    #[tokio::test]
    async fn a_stored_token_is_checked_at_me_and_the_account_cached() {
        let r = rig();
        let f = api().await;
        r.store.set(&key(&f.base), "tyg_abc").unwrap();
        r.auth.refresh(&f.base).await;
        let s = r.auth.status();
        assert_eq!((s.state, s.offline), (AuthState::SignedIn, false));
        assert_eq!(s.account.as_ref().map(|a| a.plan.as_str()), Some("pro"));
        assert_eq!(r.cache.load(&key(&f.base)).map(|a| a.plan), Some("pro".into()));
    }

    #[tokio::test]
    async fn a_401_clears_the_token_and_the_cache() {
        let r = rig();
        let f = api().await;
        r.store.set(&key(&f.base), "tyg_revoked").unwrap();
        r.cache.save(&key(&f.base), Some(&account("free")));
        r.auth.refresh(&f.base).await;
        assert_eq!(r.auth.status().state, AuthState::SignedOut);
        assert_eq!(r.store.get(&key(&f.base)).unwrap(), None);
        assert_eq!(r.cache.load(&key(&f.base)), None);
    }

    #[tokio::test]
    async fn a_late_401_for_an_old_token_leaves_a_newer_one_alone() {
        let store = Arc::new(MemoryStore::default());
        let cache = Arc::new(MemCache::default());
        let rec = Arc::new(Rec::default());
        let auth = Auth::new(store.clone(), cache.clone(), rec.clone(), TICK).unwrap();
        let during = store.clone();
        let slot: Arc<Mutex<String>> = Arc::default();
        let k = slot.clone();
        let f = fake(move |_, _| {
            // While /v1/me checks the old token, a sign-in saves a new one.
            during.set(&k.lock().unwrap(), "tyg_new").unwrap();
            (401, r#"{"error":"unauthorized"}"#.into())
        })
        .await;
        *slot.lock().unwrap() = key(&f.base);
        store.set(&key(&f.base), "tyg_old").unwrap();
        cache.save(&key(&f.base), Some(&account("pro")));
        auth.refresh(&f.base).await;
        assert_eq!(store.get(&key(&f.base)).unwrap().as_deref(), Some("tyg_new"));
        assert_eq!(cache.load(&key(&f.base)), Some(account("pro")), "the newer sign-in's account stays");
    }

    #[tokio::test]
    async fn offline_keeps_the_token_and_shows_the_cached_account() {
        let r = rig();
        let base = dead_base().await;
        r.store.set(&key(&base), "tyg_abc").unwrap();
        r.cache.save(&key(&base), Some(&account("pro")));
        r.auth.refresh(&base).await;
        let s = r.auth.status();
        assert_eq!((s.state, s.offline, s.account), (AuthState::SignedIn, true, Some(account("pro"))));
        assert_eq!(r.store.get(&key(&base)).unwrap().as_deref(), Some("tyg_abc"));
    }

    #[tokio::test]
    async fn signing_in_stores_the_token_and_never_shows_it() {
        let r = rig();
        let f = api().await;
        let started = r.auth.start(&f.base).await.unwrap().unwrap();
        assert_eq!(started.user_code, "ABCD-EFGH");
        assert_eq!(started.verification_uri_complete, "http://x/api/auth/device?code=ABCD-EFGH");
        assert_eq!(r.auth.status().state, AuthState::Pending);
        let s = until(&r.rec, |s| s.state == AuthState::SignedIn).await;
        assert_eq!(s.account.as_ref().and_then(|a| a.email.as_deref()), Some("a@b.c"));
        assert_eq!(r.store.get(&key(&f.base)).unwrap().as_deref(), Some("tyg_abc"));
        assert_eq!(r.cache.load(&key(&f.base)).map(|a| a.id), Some("acc_1".into()));
        let shown = serde_json::to_string(&(r.rec.all(), started, r.auth.status())).unwrap();
        assert!(!shown.contains("tyg_") && !shown.contains("dev-secret"), "{shown}");
    }

    #[tokio::test]
    async fn a_keychain_deny_fails_the_sign_in_and_leaves_no_token_anywhere() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("auth.json");
        let store = Arc::new(SecureStore::new(denied(), FileStore::new(path.clone())));
        let rec = Arc::new(Rec::default());
        let auth = Auth::new(store, Arc::new(MemCache::default()), rec.clone(), TICK).unwrap();
        let f = api().await;
        auth.start(&f.base).await.unwrap();
        let s = until(&rec, |s| s.state == AuthState::Error).await;
        assert_eq!((s.error, s.signed_in, s.account), (Some(AuthError::Keychain), false, None));
        assert!(!path.exists());
        let revoked = f.hits("/api/v1/auth/logout");
        assert_eq!(revoked.first().and_then(|r| r.auth.as_deref()), Some("Bearer tyg_abc"), "the unsaved token is revoked");
    }

    #[tokio::test]
    async fn a_denied_sign_in_is_an_error() {
        let r = rig();
        let f = fake(|r, _| if r.path.ends_with("/device") { (200, DEVICE.into()) } else { err("access_denied") }).await;
        r.auth.start(&f.base).await.unwrap();
        let s = until(&r.rec, |s| s.state == AuthState::Error).await;
        assert_eq!((s.error, s.signed_in), (Some(AuthError::Denied), false));
        assert_eq!(r.store.get(&key(&f.base)).unwrap(), None);
    }

    #[tokio::test]
    async fn signing_in_over_plain_http_to_another_computer_is_refused_without_a_request() {
        let r = rig();
        let base = "http://example.test/api";
        assert_eq!(r.auth.start(base).await.unwrap_err(), AuthError::Insecure);
        let s = r.auth.status();
        assert_eq!((s.state, s.error, s.signed_in), (AuthState::Error, Some(AuthError::Insecure), false));
        r.auth.refresh(base).await;
        assert_eq!(r.auth.status().state, AuthState::SignedOut);
    }

    #[tokio::test]
    async fn auth_calls_never_follow_a_redirect() {
        let target = fake(|_, _| (200, DEVICE.into())).await;
        let to = format!("{}/v1/auth/device", target.base);
        let f = fake(move |_, _| (307, to.clone())).await;
        let c = http_client().unwrap();
        assert_eq!(request_device(&c, &f.base).await.unwrap_err(), AuthError::Server);
        assert!(matches!(poll_token(&c, &f.base, "dev-secret").await, PollReply::Server));
        assert!(target.hits.lock().unwrap().is_empty(), "the device code went nowhere else");
    }

    #[tokio::test]
    async fn an_unreachable_api_fails_the_start() {
        let r = rig();
        let base = dead_base().await;
        assert_eq!(r.auth.start(&base).await.unwrap_err(), AuthError::Network);
        assert_eq!((r.auth.status().state, r.auth.status().error), (AuthState::Error, Some(AuthError::Network)));
    }

    /// Pending forever, so a test can stop it.
    async fn slow_api() -> Fake {
        fake(|r, _| if r.path.ends_with("/device") { (200, DEVICE.into()) } else { err("authorization_pending") }).await
    }

    #[tokio::test]
    async fn cancel_stops_polling() {
        let r = rig();
        let f = slow_api().await;
        r.auth.start(&f.base).await.unwrap();
        tokio::time::sleep(TICK * 10).await;
        r.auth.cancel();
        assert_eq!(r.auth.status().state, AuthState::SignedOut);
        let polls = f.hits("/api/v1/auth/token").len();
        tokio::time::sleep(TICK * 20).await;
        assert!(f.hits("/api/v1/auth/token").len() <= polls + 1, "at most the poll already in flight");
        assert_eq!(r.rec.last().unwrap().state, AuthState::SignedOut);
    }

    #[tokio::test]
    async fn a_second_start_replaces_the_first() {
        let r = rig();
        let first = slow_api().await;
        let second = api().await;
        r.auth.start(&first.base).await.unwrap();
        tokio::time::sleep(TICK * 5).await;
        r.auth.start(&second.base).await.unwrap();
        let polls = first.hits("/api/v1/auth/token").len();
        until(&r.rec, |s| s.state == AuthState::SignedIn).await;
        assert!(first.hits("/api/v1/auth/token").len() <= polls + 1);
        assert_eq!(r.auth.status().api_url, second.base);
    }

    #[tokio::test]
    async fn switching_the_api_shows_that_apis_own_state() {
        let r = rig();
        let a = api().await;
        let b = api().await;
        r.store.set(&key(&a.base), "tyg_abc").unwrap();
        r.auth.refresh(&a.base).await;
        assert!(r.auth.status().signed_in);
        r.auth.refresh(&b.base).await;
        let s = r.auth.status();
        assert_eq!((s.state, s.api_url.as_str()), (AuthState::SignedOut, b.base.as_str()));
        assert_eq!(r.store.get(&key(&a.base)).unwrap().as_deref(), Some("tyg_abc"), "a's token stays for later");
        r.auth.refresh(&a.base).await;
        assert!(r.auth.status().signed_in);
    }

    #[tokio::test]
    async fn switching_the_api_mid_sign_in_stops_it() {
        let r = rig();
        let a = slow_api().await;
        let b = api().await;
        r.auth.start(&a.base).await.unwrap();
        tokio::time::sleep(TICK * 5).await;
        r.auth.refresh(&b.base).await;
        assert_eq!(r.auth.status().state, AuthState::SignedOut);
        let polls = a.hits("/api/v1/auth/token").len();
        tokio::time::sleep(TICK * 20).await;
        assert!(a.hits("/api/v1/auth/token").len() <= polls + 1);
    }

    #[tokio::test]
    async fn refreshing_the_same_api_leaves_a_sign_in_alone() {
        let r = rig();
        let f = api().await;
        r.auth.start(&f.base).await.unwrap();
        r.auth.refresh(&f.base).await;
        until(&r.rec, |s| s.state == AuthState::SignedIn).await;
    }

    #[tokio::test]
    async fn logout_revokes_and_forgets() {
        let r = rig();
        let f = api().await;
        r.store.set(&key(&f.base), "tyg_abc").unwrap();
        r.auth.refresh(&f.base).await;
        r.auth.logout(&f.base).await.unwrap();
        let hits = f.hits("/api/v1/auth/logout");
        assert_eq!(hits[0].auth.as_deref(), Some("Bearer tyg_abc"));
        assert_eq!(r.store.get(&key(&f.base)).unwrap(), None);
        assert_eq!(r.cache.load(&key(&f.base)), None);
        assert_eq!(r.auth.status().state, AuthState::SignedOut);
    }

    #[tokio::test]
    async fn logout_offline_still_forgets_the_token() {
        let r = rig();
        let base = dead_base().await;
        r.store.set(&key(&base), "tyg_abc").unwrap();
        r.auth.logout(&base).await.unwrap();
        assert_eq!(r.store.get(&key(&base)).unwrap(), None);
    }

    #[tokio::test]
    async fn shutdown_stops_polling() {
        let r = rig();
        let f = slow_api().await;
        r.auth.start(&f.base).await.unwrap();
        tokio::time::sleep(TICK * 5).await;
        r.auth.shutdown();
        let polls = f.hits("/api/v1/auth/token").len();
        tokio::time::sleep(TICK * 20).await;
        assert!(f.hits("/api/v1/auth/token").len() <= polls + 1);
    }
}
