//! In-process API test: build a tiny synthetic index (no Turso), drive the axum
//! router via `tower::ServiceExt::oneshot`, and assert the wire contract + auth.

use std::sync::Arc;

use axum::body::{to_bytes, Body};
use axum::http::{Request, StatusCode};
use serde_json::{json, Value};
use tower::ServiceExt; // for `oneshot`

use sonar::index::{Entry, Index, TrackMeta};
use sonar::server::{router, AppState};

const SECRET: &str = "test-secret";

fn padded(values: &[f32]) -> Vec<f32> {
    let mut v = values.to_vec();
    v.resize(sonar::decode::DIM, 0.0);
    v
}

fn test_state() -> Arc<AppState> {
    let tracks = Index::from_entries(vec![
        Entry {
            id: "near".into(),
            vector: padded(&[1.0, 0.0]),
            meta: Some(TrackMeta {
                key: Some("Amin".into()),
                bpm: Some(174.0),
                anchored: true,
                certified: true,
            }),
        },
        Entry {
            id: "far".into(),
            vector: padded(&[0.0, 1.0]),
            meta: Some(TrackMeta {
                key: Some("Gmaj".into()),
                bpm: Some(140.0),
                anchored: false,
                certified: false,
            }),
        },
    ]);
    let centroids = Index::from_entries(vec![Entry {
        id: "artist1".into(),
        vector: padded(&[1.0, 0.0]),
        meta: None,
    }]);
    Arc::new(AppState::new(tracks, centroids, SECRET.into()))
}

async fn body_json(resp: axum::response::Response) -> Value {
    let bytes = to_bytes(resp.into_body(), usize::MAX).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn search_returns_sorted_matches() {
    let app = router(test_state());
    let body = json!({
        "index": "tracks",
        "probes": [padded(&[1.0, 0.0])],
        "top_k": 5
    });
    let req = Request::builder()
        .method("POST")
        .uri("/search")
        .header("content-type", "application/json")
        .header("x-sonar-secret", SECRET)
        .body(Body::from(body.to_string()))
        .unwrap();

    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    let matches = v["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 2);
    assert_eq!(matches[0]["id"], "near");
    assert_eq!(matches[1]["id"], "far");
    let s0 = matches[0]["score"].as_f64().unwrap();
    let s1 = matches[1]["score"].as_f64().unwrap();
    assert!(s0 >= s1);
    assert!((s0 - 1.0).abs() < 1e-5);
}

#[tokio::test]
async fn search_honors_metadata_filter() {
    let app = router(test_state());
    let body = json!({
        "index": "tracks",
        "probes": [padded(&[1.0, 0.0])],
        "filter": { "certified": true },
        "top_k": 5
    });
    let req = Request::builder()
        .method("POST")
        .uri("/search")
        .header("x-sonar-secret", SECRET)
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    let matches = v["matches"].as_array().unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0]["id"], "near");
}

#[tokio::test]
async fn missing_secret_is_401() {
    let app = router(test_state());
    let body = json!({ "index": "tracks", "probes": [padded(&[1.0, 0.0])], "top_k": 5 });
    let req = Request::builder()
        .method("POST")
        .uri("/search")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn wrong_secret_is_401() {
    let app = router(test_state());
    let body = json!({ "index": "tracks", "probes": [padded(&[1.0, 0.0])], "top_k": 5 });
    let req = Request::builder()
        .method("POST")
        .uri("/search")
        .header("x-sonar-secret", "wrong")
        .body(Body::from(body.to_string()))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn invalid_body_returns_empty_matches_not_panic() {
    let app = router(test_state());
    let req = Request::builder()
        .method("POST")
        .uri("/search")
        .header("x-sonar-secret", SECRET)
        .body(Body::from("{ not valid json"))
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert!(v["matches"].as_array().unwrap().is_empty());
}

#[tokio::test]
async fn health_is_open_and_reports_counts() {
    let app = router(test_state());
    let req = Request::builder()
        .method("GET")
        .uri("/health")
        .body(Body::empty())
        .unwrap();
    let resp = app.oneshot(req).await.unwrap();
    assert_eq!(resp.status(), StatusCode::OK);
    let v = body_json(resp).await;
    assert_eq!(v["tracks"], 2);
    assert_eq!(v["centroids"], 1);
    assert_eq!(v["ok"], true);
    assert!(v["last_refresh_unix"].as_i64().unwrap() > 0);
}
