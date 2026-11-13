//! Reading a page for an importer that reads by fetching (the web app's
//! `fetching.ts` in the importer contract): one request, made by the app
//! itself, never in a window.
//!
//! The request names the app (`Atlas/<version>`, as map image downloads
//! do), sends no cookies, no referrer and nothing a browser would add, and
//! follows at most five redirects, and only on the same site. The answer is
//! handed back whatever its status: the web app decides what a refusal is
//! and stops there. Pacing, robots.txt and the limit of pages in one go
//! are the web app's, which asks for one address at a time.

use std::time::Duration;

use reqwest::{header, redirect, Client, Url};
use serde::Serialize;

use crate::tiles::download::USER_AGENT;

/// Text longer than this is cut off (the importer contract's limit).
pub const MAX_FETCHED_BYTES: usize = 8 << 20;
/// How long one request may take, all of it.
const TIMEOUT: Duration = Duration::from_secs(30);
const MAX_REDIRECTS: usize = 5;

/// One answer, as the web app hands it to the importer.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FetchedPage {
    pub url: String,
    pub final_url: String,
    pub status: u16,
    /// Lowercase, without parameters; empty when absent.
    pub content_type: String,
    pub text: String,
    /// The `Retry-After` header, when the site sent one.
    pub retry_after: Option<String>,
}

/// The site of a host: without a leading `www.`, lowercase.
fn site_of(host: &str) -> String {
    let host = host.to_ascii_lowercase();
    host.strip_prefix("www.").map(str::to_owned).unwrap_or(host)
}

/// Whether `next` is on the site of `start`: the same scheme, and the same
/// host or one of its sub-domains, ignoring a leading `www.` (the import
/// window's rule).
pub fn same_site(start: &Url, next: &Url) -> bool {
    if start.scheme() != next.scheme()
        || (start.scheme() == "http"
            && start.port_or_known_default() != next.port_or_known_default())
    {
        return false;
    }
    let (Some(a), Some(b)) = (start.host_str(), next.host_str()) else {
        return false;
    };
    let site = site_of(a);
    let host = b.to_ascii_lowercase();
    !site.is_empty() && (host == site || host.ends_with(&format!(".{site}")))
}

/// Whether the app reads `url`: `https`, or `http` on this computer (tests),
/// with no user name or password.
pub fn is_allowed(url: &Url) -> bool {
    if !url.username().is_empty() || url.password().is_some() {
        return false;
    }
    match url.scheme() {
        "https" => url.host_str().is_some_and(|host| !host.is_empty()),
        "http" => matches!(url.host_str(), Some("127.0.0.1" | "localhost")),
        _ => false,
    }
}

fn client_for(start: Url) -> reqwest::Result<Client> {
    Client::builder()
        .user_agent(USER_AGENT)
        // A redirect would otherwise send the address it came from.
        .referer(false)
        .redirect(redirect::Policy::custom(move |attempt| {
            if attempt.previous().len() >= MAX_REDIRECTS {
                attempt.error("too many redirects")
            } else if same_site(&start, attempt.url()) && is_allowed(attempt.url()) {
                attempt.follow()
            } else {
                attempt.stop()
            }
        }))
        .connect_timeout(Duration::from_secs(20))
        .timeout(TIMEOUT)
        .build()
}

/// Fetches `address`: its answer, whatever the status, or why there is none.
pub async fn fetch_page(address: &str) -> Result<FetchedPage, String> {
    let url = Url::parse(address.trim()).map_err(|_| "That is not a web address.".to_owned())?;
    if !is_allowed(&url) {
        return Err("This app does not read that address.".to_owned());
    }
    let client = client_for(url.clone()).map_err(|error| error.to_string())?;
    let mut response = client
        .get(url.clone())
        .header(
            header::ACCEPT,
            "text/html, application/json;q=0.9, application/xml;q=0.8, text/*;q=0.5",
        )
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                "The site did not answer in time.".to_owned()
            } else {
                "The site could not be reached.".to_owned()
            }
        })?;
    let status = response.status().as_u16();
    let final_url = response.url().to_string();
    let text_header = |name: header::HeaderName| {
        response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned)
    };
    let content_type = text_header(header::CONTENT_TYPE)
        .map(|value| {
            value
                .split(';')
                .next()
                .unwrap_or_default()
                .trim()
                .to_ascii_lowercase()
        })
        .unwrap_or_default();
    let retry_after = text_header(header::RETRY_AFTER);
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The answer was cut off.".to_owned())?
    {
        let room = MAX_FETCHED_BYTES - body.len();
        body.extend_from_slice(&chunk[..chunk.len().min(room)]);
        if body.len() >= MAX_FETCHED_BYTES {
            break;
        }
    }
    Ok(FetchedPage {
        url: url.to_string(),
        final_url,
        status,
        content_type,
        text: String::from_utf8_lossy(&body).into_owned(),
        retry_after,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::tiles::download::tests::{MockServer, Reply};

    fn ensure_crypto() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    #[tokio::test]
    async fn reads_a_page_as_the_app_without_cookies_or_browser_headers() {
        ensure_crypto();
        let server = MockServer::start(Arc::new(|path, _| match path {
            "/wiki/Start" => Reply {
                body: "<p>Hello</p>".into(),
                ..Reply::status(200)
            }
            .header("Content-Type", "text/html; charset=UTF-8")
            .header("Set-Cookie", "session=1"),
            "/moved" => Reply::status(301).header("Location", "/wiki/Start"),
            "/away" => Reply::status(302).header("Location", "https://elsewhere.invalid/x"),
            "/slow-down" => Reply::status(429).header("Retry-After", "120"),
            _ => Reply::status(404),
        }))
        .await;

        let page = fetch_page(&server.url("/wiki/Start")).await.unwrap();
        assert_eq!(page.status, 200);
        assert_eq!(page.content_type, "text/html");
        assert_eq!(page.text, "<p>Hello</p>");
        // A second request carries no cookie from the first.
        let moved = fetch_page(&server.url("/moved")).await.unwrap();
        assert_eq!(moved.status, 200);
        assert!(moved.final_url.ends_with("/wiki/Start"));
        for seen in server.seen() {
            assert_eq!(seen.headers["user-agent"], USER_AGENT);
            for absent in ["cookie", "referer", "origin", "sec-fetch-mode"] {
                assert!(!seen.headers.contains_key(absent), "{absent} was sent");
            }
        }

        // A redirect off the site is not followed; the answer is handed back.
        let away = fetch_page(&server.url("/away")).await.unwrap();
        assert_eq!(away.status, 302);
        let slow = fetch_page(&server.url("/slow-down")).await.unwrap();
        assert_eq!(
            (slow.status, slow.retry_after.as_deref()),
            (429, Some("120"))
        );
        assert_eq!(fetch_page(&server.url("/gone")).await.unwrap().status, 404);
    }

    #[tokio::test]
    async fn refuses_addresses_it_does_not_read() {
        for address in [
            "ftp://example.org/x",
            "http://example.org/x",
            "https://user:secret@example.org/x",
            "not an address",
        ] {
            assert!(fetch_page(address).await.is_err(), "{address}");
        }
    }

    #[test]
    fn tells_the_same_site() {
        let url = |text: &str| Url::parse(text).unwrap();
        let start = url("https://www.example.org/wiki/A");
        assert!(same_site(&start, &url("https://example.org/b")));
        assert!(same_site(&start, &url("https://en.example.org/b")));
        assert!(!same_site(&start, &url("https://example.com/b")));
        assert!(!same_site(&start, &url("http://example.org/b")));
        assert!(!same_site(&start, &url("https://badexample.org/b")));
    }
}
