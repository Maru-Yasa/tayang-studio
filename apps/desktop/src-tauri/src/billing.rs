//! Paid plans. Checkout and status go to the Tayang API with the stored sign-in token, which
//! stays in Rust: the webview only ever sees the pay link and the plan state.
//!
//! Every link opened to pay is on the API itself (`<api>/pay/…`), which redirects to wherever the
//! buyer pays now: a provider's page, or a WhatsApp chat while payments are off. So the app never
//! needs to know a provider, and a new one needs no app update.

use crate::styles_sync::endpoint;
use crate::types::{BillingError, BillingStatus, Checkout, CheckoutStart};

/// The plans for sale (shared `PAID_PLAN_IDS`).
pub const PAID_PLANS: [&str; 3] = ["lite", "creator", "pro"];

/// A link the app may open to pay: `<api>/pay/<something>` on the API this app talks to (same
/// scheme, host and port, under its path), with no user info or fragment, and only `plan` and
/// `email` in the query. The API redirects it on.
pub fn is_pay_link(u: &str, base: &str) -> bool {
    let (Ok(url), Ok(root)) = (reqwest::Url::parse(u.trim()), reqwest::Url::parse(&endpoint(base, "/pay/"))) else { return false };
    let rest = url.path().strip_prefix(root.path()).unwrap_or("");
    url.scheme() == root.scheme()
        && url.host_str() == root.host_str()
        && url.port_or_known_default() == root.port_or_known_default()
        && url.username().is_empty()
        && url.password().is_none()
        && url.fragment().is_none()
        && !rest.is_empty()
        && !rest.contains('/')
        && url.query_pairs().all(|(k, _)| k == "plan" || k == "email")
}

/// The pay link in a 503 `billing_unavailable` answer, if it is one that may open.
fn pay_link_in(body: &[u8], base: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_slice(body).ok()?;
    let url = v.get("payUrl")?.as_str()?;
    is_pay_link(url, base).then(|| url.to_string())
}

async fn send(req: reqwest::RequestBuilder) -> Result<(u16, Vec<u8>), BillingError> {
    let res = req.send().await.map_err(|_| BillingError::Network)?;
    let status = res.status().as_u16();
    let body = res.bytes().await.map_err(|_| BillingError::Network)?;
    Ok((status, body.to_vec()))
}

fn error_for(status: u16) -> BillingError {
    match status {
        401 => BillingError::SignedOut,
        400 => BillingError::InvalidPlan,
        409 => BillingError::DowngradeNotAllowed,
        429 => BillingError::RateLimited,
        503 => BillingError::Unavailable,
        502 => BillingError::PaymentProvider,
        _ => BillingError::Server,
    }
}

/// `POST /v1/billing/checkout { plan }`. Never asks for a plan that isn't for sale. While payments
/// are off, a 503 that carries this API's pay link (see `is_pay_link`) is a `Whatsapp` start, not an error.
pub async fn checkout(client: &reqwest::Client, base: &str, token: &str, plan: &str) -> Result<CheckoutStart, BillingError> {
    if !PAID_PLANS.contains(&plan) {
        return Err(BillingError::InvalidPlan);
    }
    let req = client
        .post(endpoint(base, "/v1/billing/checkout"))
        .bearer_auth(token)
        .header(reqwest::header::CONTENT_TYPE, "application/json")
        .body(serde_json::json!({ "plan": plan }).to_string());
    match send(req).await? {
        (200..=299, body) => {
            let c = serde_json::from_slice::<Checkout>(&body).ok().filter(|c| !c.order_id.is_empty()).ok_or(BillingError::Server)?;
            if is_pay_link(&c.pay_url, base) {
                Ok(CheckoutStart::Qris(c))
            } else {
                Err(BillingError::BadLink)
            }
        }
        (503, body) => pay_link_in(&body, base).map(|url| CheckoutStart::Whatsapp { url }).ok_or(BillingError::Unavailable),
        (status, _) => Err(error_for(status)),
    }
}

/// `GET /v1/billing/status`. A pending payment without a pay link on this API is dropped.
pub async fn status(client: &reqwest::Client, base: &str, token: &str) -> Result<BillingStatus, BillingError> {
    match send(client.get(endpoint(base, "/v1/billing/status")).bearer_auth(token)).await? {
        (200..=299, body) => {
            let mut s = serde_json::from_slice::<BillingStatus>(&body).map_err(|_| BillingError::Server)?;
            s.pending = s.pending.filter(|p| is_pay_link(&p.pay_url, base));
            Ok(s)
        }
        (status, _) => Err(match error_for(status) {
            BillingError::InvalidPlan => BillingError::Server,
            e => e,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::auth::http_client;
    use crate::auth::tests::{dead_base, fake, Fake, Req};

    // `{BASE}` is the fake API's own base, filled in as it answers (it is known only once it runs).
    const CHECKOUT: &str = r#"{"orderId":"TYG-ABCDEFGH-1793793600","payUrl":"{BASE}/pay/TYG-ABCDEFGH-1793793600","paymentLinkUrl":"https://pay.sumopod.com/p/1","expiresAt":"2026-11-04T13:00:00.000Z","amount":50000}"#;
    const STATUS: &str = r#"{"plan":"creator","lastPlan":"creator","currentPeriodEnd":"2026-12-04T12:00:00.000Z","active":true,"pending":{"orderId":"TYG-X","plan":"pro","payUrl":"{BASE}/pay/TYG-X","paymentLinkUrl":"https://checkout.pymnt.global/p/2","expiresAt":"2026-11-04T13:00:00.000Z"},"lastPaidOrderId":"TYG-OLD"}"#;

    async fn api(handler: impl Fn(&Req) -> (u16, String) + Send + Sync + 'static) -> Fake {
        let slot = std::sync::Arc::new(std::sync::OnceLock::<String>::new());
        let seen = slot.clone();
        let f = fake(move |r, _| {
            let (status, body) = handler(r);
            (status, body.replace("{BASE}", seen.get().map(String::as_str).unwrap_or("")))
        })
        .await;
        slot.set(f.base.clone()).unwrap();
        f
    }

    #[tokio::test]
    async fn checkout_posts_the_plan_with_the_token_and_opens_the_api_pay_link() {
        let f = api(|r| match r.path.as_str() {
            "/api/v1/billing/checkout" => (200, CHECKOUT.into()),
            _ => (404, "{}".into()),
        })
        .await;
        let Ok(CheckoutStart::Qris(c)) = checkout(&http_client().unwrap(), &f.base, "tyg_abc", "creator").await else { panic!("not a QRIS start") };
        assert_eq!((c.order_id.as_str(), c.amount), ("TYG-ABCDEFGH-1793793600", 50000));
        assert_eq!(c.pay_url, format!("{}/pay/TYG-ABCDEFGH-1793793600", f.base));
        let hits = f.hits("/api/v1/billing/checkout");
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].method, "POST");
        assert_eq!(hits[0].auth.as_deref(), Some("Bearer tyg_abc"));
        assert_eq!(serde_json::from_str::<serde_json::Value>(&hits[0].body).unwrap(), serde_json::json!({ "plan": "creator" }));
    }

    #[tokio::test]
    async fn checkout_refuses_a_pay_link_off_this_api() {
        for body in [
            CHECKOUT.replace("{BASE}/pay/", "https://pay.sumopod.com/"),
            CHECKOUT.replace(r#""payUrl":"{BASE}/pay/TYG-ABCDEFGH-1793793600","#, ""),
            CHECKOUT.replace("{BASE}/pay/", "https://evil.example/api/pay/"),
        ] {
            let f = api(move |_| (200, body.clone())).await;
            assert_eq!(checkout(&http_client().unwrap(), &f.base, "tyg_abc", "lite").await, Err(BillingError::BadLink));
        }
        assert_eq!(serde_json::to_value(BillingError::BadLink).unwrap(), "bad_link");
        assert_eq!(serde_json::to_value(BillingError::DowngradeNotAllowed).unwrap(), "downgrade_not_allowed");
    }

    #[tokio::test]
    async fn checkout_while_off_opens_the_api_pay_link_when_offered() {
        let f = api(|_| (503, r#"{"error":"billing_unavailable","payUrl":"{BASE}/pay/whatsapp?plan=creator&email=ana%40example.com"}"#.into())).await;
        let start = checkout(&http_client().unwrap(), &f.base, "tyg_abc", "creator").await.unwrap();
        let want = format!("{}/pay/whatsapp?plan=creator&email=ana%40example.com", f.base);
        assert_eq!(start, CheckoutStart::Whatsapp { url: want.clone() });
        assert_eq!(serde_json::to_value(&start).unwrap(), serde_json::json!({ "kind": "whatsapp", "url": want }));
        // A link anywhere else (even straight to wa.me) is never opened: plain "unavailable".
        for other in ["https://wa.me/6281234567890", "https://evil.example/api/pay/whatsapp?plan=creator"] {
            let bad = fake(move |_, _| (503, format!(r#"{{"error":"billing_unavailable","payUrl":"{other}"}}"#))).await;
            assert_eq!(checkout(&http_client().unwrap(), &bad.base, "tyg_abc", "creator").await, Err(BillingError::Unavailable), "{other}");
        }
    }

    #[test]
    fn only_pay_links_on_this_api_may_open() {
        let base = "https://studio.tayang.app/api";
        for ok in [
            "https://studio.tayang.app/api/pay/TYG-ABCDEFGH-1793793600",
            "https://studio.tayang.app/api/pay/whatsapp?plan=creator",
            "https://studio.tayang.app/api/pay/whatsapp?plan=pro&email=ana%40example.com",
            "https://STUDIO.tayang.app:443/api/pay/x",
        ] {
            assert!(is_pay_link(ok, base), "{ok}");
        }
        for bad in [
            "http://studio.tayang.app/api/pay/x",
            "https://studio.tayang.app.evil.com/api/pay/x",
            "https://evil.com/api/pay/x",
            "https://studio.tayang.app/api/pay/",
            "https://studio.tayang.app/api/pay/a/b",
            "https://studio.tayang.app/api/pay/../v1/billing/checkout",
            "https://studio.tayang.app/api/v1/billing/checkout",
            "https://studio.tayang.app/pay/x",
            "https://studio.tayang.app/api/pay/x?next=https://evil.com",
            "https://user@studio.tayang.app/api/pay/x",
            "https://studio.tayang.app:8443/api/pay/x",
            "https://studio.tayang.app/api/pay/x#y",
            "https://pay.sumopod.com/p/1",
            "https://wa.me/6281234567890",
            "javascript:alert(1)",
            "not a url",
        ] {
            assert!(!is_pay_link(bad, base), "{bad}");
        }
        // A self-hosted API: its own pay links, nobody else's.
        assert!(is_pay_link("http://localhost:8787/api/pay/whatsapp?plan=lite", "http://localhost:8787/api"));
        assert!(!is_pay_link("https://studio.tayang.app/api/pay/whatsapp?plan=lite", "http://localhost:8787/api"));
    }

    #[tokio::test]
    async fn checkout_refuses_an_unknown_plan_without_asking() {
        let f = fake(|_, _| (200, CHECKOUT.into())).await;
        for plan in ["free", "gold", ""] {
            assert_eq!(checkout(&http_client().unwrap(), &f.base, "tyg_abc", plan).await, Err(BillingError::InvalidPlan));
        }
        assert!(f.hits.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn checkout_errors_map_to_codes() {
        for (status, body, want) in [
            (401, "{}", BillingError::SignedOut),
            (502, r#"{"error":"payment_provider"}"#, BillingError::PaymentProvider),
            (500, "{}", BillingError::Server),
            (200, "nope", BillingError::Server),
            (200, r#"{"orderId":"x","payUrl":"file:///etc/passwd","paymentLinkUrl":"x","expiresAt":"x","amount":1}"#, BillingError::BadLink),
            (503, r#"{"error":"billing_unavailable"}"#, BillingError::Unavailable),
            (429, r#"{"error":"rate_limited"}"#, BillingError::RateLimited),
            (409, r#"{"error":"downgrade_not_allowed"}"#, BillingError::DowngradeNotAllowed),
        ] {
            let f = fake(move |_, _| (status, body.into())).await;
            assert_eq!(checkout(&http_client().unwrap(), &f.base, "tyg_abc", "lite").await, Err(want), "{status} {body}");
        }
        assert_eq!(checkout(&http_client().unwrap(), &dead_base().await, "tyg_abc", "lite").await, Err(BillingError::Network));
    }

    #[tokio::test]
    async fn status_reads_the_plan_and_pending_payment() {
        let f = api(|r| match (r.path.as_str(), r.auth.as_deref()) {
            ("/api/v1/billing/status", Some("Bearer tyg_abc")) => (200, STATUS.into()),
            _ => (401, "{}".into()),
        })
        .await;
        let s = status(&http_client().unwrap(), &f.base, "tyg_abc").await.unwrap();
        assert_eq!((s.plan.as_str(), s.active, s.current_period_end.as_deref()), ("creator", true, Some("2026-12-04T12:00:00.000Z")));
        assert_eq!(s.last_plan.as_deref(), Some("creator"));
        assert_eq!(s.last_paid_order_id.as_deref(), Some("TYG-OLD"));
        assert_eq!(s.pending.map(|p| (p.order_id, p.pay_url)), Some(("TYG-X".into(), format!("{}/pay/TYG-X", f.base))));
        assert_eq!(status(&http_client().unwrap(), &f.base, "tyg_other").await, Err(BillingError::SignedOut));
    }

    #[tokio::test]
    async fn status_drops_a_pending_payment_without_a_pay_link_on_this_api() {
        for body in [STATUS.replace("{BASE}/pay/TYG-X", "javascript:alert(1)"), STATUS.replace(r#""payUrl":"{BASE}/pay/TYG-X","#, "")] {
            let f = api(move |_| (200, body.clone())).await;
            let s = status(&http_client().unwrap(), &f.base, "tyg_abc").await.unwrap();
            assert!(s.pending.is_none());
        }
        let free = fake(|_, _| (200, r#"{"plan":"free","currentPeriodEnd":null,"active":false,"pending":null}"#.into())).await;
        let s = status(&http_client().unwrap(), &free.base, "tyg_abc").await.unwrap();
        assert_eq!((s.plan.as_str(), s.active, s.current_period_end, s.pending), ("free", false, None, None));
    }

    #[tokio::test]
    async fn status_errors_map_to_codes() {
        for (st, want) in [(500, BillingError::Server), (400, BillingError::Server), (502, BillingError::PaymentProvider), (503, BillingError::Unavailable)] {
            let f = fake(move |_, _| (st, "{}".into())).await;
            assert_eq!(status(&http_client().unwrap(), &f.base, "t").await, Err(want));
        }
        assert_eq!(status(&http_client().unwrap(), &dead_base().await, "t").await, Err(BillingError::Network));
    }
}
