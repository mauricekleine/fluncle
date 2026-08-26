//! Strict client and verifier for the `sonar.track@1/1` artifact protocol.

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::decode::BLOB_LEN;
use crate::index::TrackMeta;

pub const STREAM: &str = "sonar.track";
pub const STREAM_VERSION: u32 = 1;
pub const FORMAT_VERSION: u32 = 1;
pub const CONTRACT: &str = "sonar.track@1/1";
pub const EMPTY_DIGEST: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct SonarPayload {
    pub anchored: bool,
    pub bpm: Option<f64>,
    pub certified: bool,
    pub dismissed: bool,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<u32>,
    #[serde(rename = "hasFinding")]
    pub has_finding: bool,
    #[serde(rename = "isDuplicate")]
    pub is_duplicate: bool,
    pub key: Option<String>,
    #[serde(rename = "nearestFindingScore")]
    pub nearest_finding_score: Option<f64>,
}

impl SonarPayload {
    pub fn meta(&self) -> TrackMeta {
        TrackMeta {
            key: self.key.clone(),
            bpm: self.bpm.map(|value| value as f32),
            anchored: self.anchored,
            certified: self.certified,
            has_finding: self.has_finding,
            dismissed: self.dismissed,
            is_duplicate: self.is_duplicate,
            nearest_finding_score: self.nearest_finding_score.map(|value| value as f32),
            duration_ms: self.duration_ms,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Contract {
    #[serde(rename = "formatVersion")]
    pub format_version: u32,
    pub stream: String,
    #[serde(rename = "streamVersion")]
    pub stream_version: u32,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RebuildCheckpoint {
    #[serde(rename = "completedAt")]
    pub completed_at: Option<String>,
    #[serde(rename = "consumerDigest")]
    pub consumer_digest: String,
    #[serde(rename = "consumerItemCount")]
    pub consumer_item_count: u64,
    pub cursor: Option<String>,
    #[serde(rename = "formatVersion")]
    pub format_version: u32,
    pub generation: String,
    #[serde(rename = "snapshotSeq")]
    pub snapshot_seq: u64,
    #[serde(rename = "sourceDigest")]
    pub source_digest: String,
    #[serde(rename = "sourceItemCount")]
    pub source_item_count: u64,
    #[serde(rename = "startedAt")]
    pub started_at: String,
    pub state: String,
    pub stream: String,
    #[serde(rename = "streamVersion")]
    pub stream_version: u32,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ConsumerStatus {
    #[serde(rename = "appliedThroughSeq")]
    pub applied_through_seq: Option<u64>,
    #[serde(rename = "checkpointedAt")]
    pub checkpointed_at: Option<String>,
    #[serde(rename = "compactionBarrier")]
    pub compaction_barrier: Option<u64>,
    #[serde(rename = "consumerId")]
    pub consumer_id: String,
    pub contracts: Vec<Contract>,
    #[serde(rename = "earliestSeq")]
    pub earliest_seq: Option<u64>,
    #[serde(rename = "headSeq")]
    pub head_seq: u64,
    pub rebuilds: Vec<RebuildCheckpoint>,
    #[serde(rename = "registeredAt")]
    pub registered_at: String,
    pub state: String,
    #[serde(rename = "stateChangedAt")]
    pub state_changed_at: String,
    #[serde(rename = "snapshotSeq")]
    pub snapshot_seq: Option<u64>,
    #[serde(rename = "updatedAt")]
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ConsumerResponse {
    consumer: ConsumerStatus,
    ok: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CheckpointResponse {
    checkpoint: RebuildCheckpoint,
    ok: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangeEvent {
    #[serde(rename = "createdAt")]
    pub created_at: String,
    #[serde(rename = "formatRegistered")]
    pub format_registered: bool,
    #[serde(rename = "formatVersion")]
    pub format_version: u32,
    pub operation: String,
    #[serde(rename = "payloadBlobBase64")]
    pub payload_blob_base64: Option<String>,
    #[serde(rename = "payloadDigest")]
    pub payload_digest: String,
    #[serde(rename = "payloadJson")]
    pub payload_json: String,
    pub producer: String,
    pub revision: u64,
    pub seq: u64,
    pub stream: String,
    #[serde(rename = "streamVersion")]
    pub stream_version: u32,
    #[serde(rename = "subjectId")]
    pub subject_id: String,
    #[serde(rename = "subjectType")]
    pub subject_type: String,
    #[serde(rename = "supportedByConsumer")]
    pub supported_by_consumer: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ChangePage {
    #[serde(rename = "batchDigest")]
    pub batch_digest: String,
    #[serde(rename = "consumerId")]
    pub consumer_id: String,
    pub events: Vec<ChangeEvent>,
    #[serde(rename = "fromSeq")]
    pub from_seq: u64,
    #[serde(rename = "hasMore")]
    pub has_more: bool,
    #[serde(rename = "headSeq")]
    pub head_seq: u64,
    pub ok: bool,
    #[serde(rename = "throughSeq")]
    pub through_seq: u64,
}

#[derive(Clone, Debug)]
pub enum ValidatedOperation {
    Upsert {
        blob: Vec<u8>,
        payload: SonarPayload,
    },
    Delete,
    Skip,
}

#[derive(Clone, Debug)]
pub struct ValidatedEvent {
    pub operation: ValidatedOperation,
    pub payload_digest: String,
    pub revision: u64,
    pub seq: u64,
    pub subject_id: String,
}

#[derive(Clone, Debug)]
pub struct ValidatedBatch {
    pub batch_digest: String,
    pub events: Vec<ValidatedEvent>,
    pub from_seq: u64,
    pub head_seq: u64,
    pub through_seq: u64,
}

pub fn sha256_hex(parts: &[&[u8]]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        hasher.update(part);
    }
    format!("{:x}", hasher.finalize())
}

pub fn extend_digest(previous: &str, items: &[String]) -> Result<String> {
    if items.is_empty() {
        return Ok(previous.to_string());
    }
    let previous = decode_hex(previous)?;
    let mut owned = Vec::with_capacity(items.len());
    for item in items {
        owned.push(decode_hex(item)?);
    }
    let mut hasher = Sha256::new();
    hasher.update(previous);
    for item in owned {
        hasher.update(item);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn decode_hex(value: &str) -> Result<Vec<u8>> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        bail!("invalid lowercase SHA-256 digest");
    }
    (0..value.len())
        .step_by(2)
        .map(|offset| u8::from_str_radix(&value[offset..offset + 2], 16).context("digest hex"))
        .collect()
}

fn event_digest(event: &ChangeEvent, blob: &[u8]) -> Result<String> {
    let envelope = json!({
        "createdAt": event.created_at,
        "formatVersion": event.format_version,
        "operation": event.operation,
        "payloadJson": event.payload_json,
        "producer": event.producer,
        "revision": event.revision,
        "seq": event.seq,
        "stream": event.stream,
        "streamVersion": event.stream_version,
        "subjectId": event.subject_id,
        "subjectType": event.subject_type,
    });
    let header = serde_json::to_vec(&envelope).context("serializing artifact digest envelope")?;
    let length = u64::try_from(blob.len())
        .context("artifact blob length overflow")?
        .to_be_bytes();
    Ok(sha256_hex(&[&header, &length, blob]))
}

pub fn snapshot_item_digest(subject_id: &str, payload_json: &str, blob: &[u8]) -> Result<String> {
    let envelope = json!({
        "formatVersion": FORMAT_VERSION,
        "operation": "upsert",
        "payloadJson": payload_json,
        "stream": STREAM,
        "streamVersion": STREAM_VERSION,
        "subjectId": subject_id,
        "subjectType": "track",
    });
    let header = serde_json::to_vec(&envelope).context("serializing snapshot digest envelope")?;
    let length = u64::try_from(blob.len())
        .context("snapshot blob length overflow")?
        .to_be_bytes();
    Ok(sha256_hex(&[&header, &length, blob]))
}

pub fn validate_change_page(
    page: ChangePage,
    consumer_id: &str,
    checkpoint: u64,
) -> Result<ValidatedBatch> {
    if !page.ok || page.consumer_id != consumer_id || page.from_seq != checkpoint {
        bail!("artifact change page identity/checkpoint mismatch");
    }
    if page.events.len() > 500 {
        bail!("artifact change batch exceeds 500 events");
    }
    if page.has_more && page.events.is_empty() {
        bail!("artifact change page claims more events after an empty page");
    }
    let expected_through = page.events.last().map_or(checkpoint, |event| event.seq);
    if page.through_seq != expected_through || page.head_seq < page.through_seq {
        bail!("artifact change page boundary mismatch");
    }

    let mut previous_seq = checkpoint;
    let mut digests = Vec::with_capacity(page.events.len());
    let mut validated = Vec::with_capacity(page.events.len());
    for event in page.events {
        if event.seq <= previous_seq {
            bail!("artifact change sequence is not strictly increasing");
        }
        previous_seq = event.seq;
        if !event.format_registered {
            bail!("artifact event uses an unknown registered format");
        }
        if event.format_version == 0
            || event.stream_version == 0
            || event.revision == 0
            || event.stream.is_empty()
            || event.stream.len() > 128
            || event.subject_id.is_empty()
            || event.subject_id.len() > 1_024
            || event.subject_type.is_empty()
            || event.subject_type.len() > 128
            || event.payload_json.len() > 256 * 1_024
            || !matches!(event.operation.as_str(), "delete" | "upsert")
        {
            bail!("artifact event violates the protocol bounds");
        }
        if event.supported_by_consumer != (event.stream == STREAM) {
            bail!("artifact event support marker disagrees with the consumer contract");
        }
        let blob = match event.payload_blob_base64.as_deref() {
            Some(encoded) if encoded.len() <= 6_000 => STANDARD
                .decode(encoded)
                .context("decoding artifact vector base64")?,
            Some(_) => bail!("artifact vector base64 exceeds the protocol bound"),
            None => Vec::new(),
        };
        let digest = event_digest(&event, &blob)?;
        if digest != event.payload_digest {
            bail!("artifact event payload digest mismatch");
        }
        digests.push(digest.clone());

        let operation = if event.stream == STREAM {
            if !event.supported_by_consumer
                || event.stream_version != STREAM_VERSION
                || event.format_version != FORMAT_VERSION
                || event.subject_type != "track"
            {
                bail!("incompatible sonar.track artifact event");
            }
            match event.operation.as_str() {
                "delete" if event.payload_json == "{}" && blob.is_empty() => {
                    ValidatedOperation::Delete
                }
                "upsert" if blob.len() == BLOB_LEN => {
                    let payload: SonarPayload = serde_json::from_str(&event.payload_json)
                        .context("decoding sonar.track payload JSON")?;
                    for value in [payload.bpm, payload.nearest_finding_score]
                        .into_iter()
                        .flatten()
                    {
                        if !value.is_finite() || f64::from(value as f32) != value {
                            bail!("sonar.track f32 JSON value is not an exact widened f32");
                        }
                    }
                    if serde_json::to_string(&payload)? != event.payload_json {
                        bail!("sonar.track payload JSON is not canonical");
                    }
                    ValidatedOperation::Upsert { blob, payload }
                }
                _ => bail!("invalid sonar.track operation/payload shape"),
            }
        } else {
            ValidatedOperation::Skip
        };
        validated.push(ValidatedEvent {
            operation,
            payload_digest: digest,
            revision: event.revision,
            seq: event.seq,
            subject_id: event.subject_id,
        });
    }
    let computed_batch = extend_digest(EMPTY_DIGEST, &digests)?;
    if computed_batch != page.batch_digest {
        bail!("artifact batch digest mismatch");
    }
    Ok(ValidatedBatch {
        batch_digest: page.batch_digest,
        events: validated,
        from_seq: page.from_seq,
        head_seq: page.head_seq,
        through_seq: page.through_seq,
    })
}

#[derive(Clone)]
pub struct ArtifactClient {
    base_url: String,
    client: reqwest::Client,
    consumer_id: String,
}

impl ArtifactClient {
    pub fn new(base_url: String, token: &str, consumer_id: String) -> Result<Self> {
        let mut headers = HeaderMap::new();
        headers.insert(
            AUTHORIZATION,
            HeaderValue::from_str(&format!("Bearer {token}"))
                .context("invalid artifact API token")?,
        );
        let client = reqwest::Client::builder()
            .default_headers(headers)
            .build()?;
        Ok(Self {
            base_url: base_url.trim_end_matches('/').to_string(),
            client,
            consumer_id,
        })
    }

    fn url(&self, path: &str) -> String {
        format!("{}/api/v1{}", self.base_url, path)
    }

    async fn checked(response: reqwest::Response) -> Result<reqwest::Response> {
        let status = response.status();
        if status.is_success() {
            return Ok(response);
        }
        let body = response.text().await.unwrap_or_default();
        bail!(
            "artifact API returned {status}: {}",
            body.chars().take(240).collect::<String>()
        )
    }

    pub async fn status(&self) -> Result<ConsumerStatus> {
        let response = Self::checked(
            self.client
                .get(self.url(&format!("/admin/artifacts/consumers/{}", self.consumer_id)))
                .send()
                .await?,
        )
        .await?;
        let decoded: ConsumerResponse = response.json().await?;
        if !decoded.ok {
            bail!("artifact status response was not ok");
        }
        Ok(decoded.consumer)
    }

    pub async fn register(&self) -> Result<ConsumerStatus> {
        let response = Self::checked(self.client.post(self.url("/admin/artifacts/consumers")).json(&json!({
            "consumerId": self.consumer_id,
            "contracts": [{"stream": STREAM, "streamVersion": STREAM_VERSION, "formatVersion": FORMAT_VERSION}],
        })).send().await?).await?;
        let decoded: ConsumerResponse = response.json().await?;
        if !decoded.ok {
            bail!("artifact registration response was not ok");
        }
        Ok(decoded.consumer)
    }

    pub async fn checkpoint_rebuild(
        &self,
        generation: &str,
        page_limit: usize,
        page_digest: &str,
        consumer_digest: &str,
        consumer_item_count: u64,
    ) -> Result<RebuildCheckpoint> {
        let response = Self::checked(
            self.client
                .post(self.url(&format!(
                    "/admin/artifacts/consumers/{}/rebuilds/{STREAM}/checkpoint",
                    self.consumer_id
                )))
                .json(&json!({
                    "consumerDigest": consumer_digest,
                    "consumerId": self.consumer_id,
                    "consumerItemCount": consumer_item_count,
                    "generation": generation,
                    "pageDigest": page_digest,
                    "pageLimit": page_limit,
                    "stream": STREAM,
                    "streamVersion": STREAM_VERSION,
                }))
                .send()
                .await?,
        )
        .await?;
        let decoded: CheckpointResponse = response.json().await?;
        if !decoded.ok {
            bail!("artifact rebuild checkpoint response was not ok");
        }
        Ok(decoded.checkpoint)
    }

    pub async fn activate(&self) -> Result<ConsumerStatus> {
        let response = Self::checked(
            self.client
                .post(self.url(&format!(
                    "/admin/artifacts/consumers/{}/activate",
                    self.consumer_id
                )))
                .json(&json!({"consumerId": self.consumer_id}))
                .send()
                .await?,
        )
        .await?;
        let decoded: ConsumerResponse = response.json().await?;
        if !decoded.ok {
            bail!("artifact activation response was not ok");
        }
        Ok(decoded.consumer)
    }

    pub async fn changes(&self, limit: usize) -> Result<ChangePage> {
        let response = Self::checked(
            self.client
                .get(self.url("/admin/artifacts/changes"))
                .query(&[
                    ("consumerId", self.consumer_id.as_str()),
                    ("limit", &limit.to_string()),
                ])
                .send()
                .await?,
        )
        .await?;
        response
            .json()
            .await
            .context("decoding artifact change page")
    }

    pub async fn acknowledge(&self, batch: &ValidatedBatch) -> Result<ConsumerStatus> {
        self.acknowledge_exact(
            &batch.batch_digest,
            batch.events.len(),
            batch.from_seq,
            batch.through_seq,
        )
        .await
    }

    pub async fn acknowledge_exact(
        &self,
        batch_digest: &str,
        event_count: usize,
        from_seq: u64,
        through_seq: u64,
    ) -> Result<ConsumerStatus> {
        let response = Self::checked(
            self.client
                .post(self.url(&format!(
                    "/admin/artifacts/consumers/{}/checkpoint",
                    self.consumer_id
                )))
                .json(&json!({
                    "batchDigest": batch_digest,
                    "consumerId": self.consumer_id,
                    "eventCount": event_count,
                    "fromSeq": from_seq,
                    "throughSeq": through_seq,
                }))
                .send()
                .await?,
        )
        .await?;
        let decoded: ConsumerResponse = response.json().await?;
        if !decoded.ok {
            bail!("artifact acknowledgement response was not ok");
        }
        Ok(decoded.consumer)
    }
}

pub fn canonical_payload(meta: &TrackMeta) -> Result<String> {
    serde_json::to_string(&SonarPayload {
        anchored: meta.anchored,
        bpm: meta.bpm.map(f64::from),
        certified: meta.certified,
        dismissed: meta.dismissed,
        duration_ms: meta.duration_ms,
        has_finding: meta.has_finding,
        is_duplicate: meta.is_duplicate,
        key: meta.key.clone(),
        nearest_finding_score: meta.nearest_finding_score.map(f64::from),
    })
    .context("serializing sonar payload")
}

pub fn validate_contract(status: &ConsumerStatus) -> Result<()> {
    if status.contracts.len() != 1 {
        bail!("artifact consumer has an unexpected contract count");
    }
    let contract = &status.contracts[0];
    if contract.stream != STREAM
        || contract.stream_version != STREAM_VERSION
        || contract.format_version != FORMAT_VERSION
    {
        bail!("artifact consumer contract is not {CONTRACT}");
    }
    Ok(())
}

pub fn parse_cursor(cursor: Option<&str>) -> Result<Option<String>> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let mut standard = cursor.replace('-', "+").replace('_', "/");
    while standard.len() % 4 != 0 {
        standard.push('=');
    }
    let bytes = STANDARD
        .decode(standard)
        .context("decoding artifact snapshot cursor")?;
    let value: Value =
        serde_json::from_slice(&bytes).context("decoding artifact snapshot cursor JSON")?;
    let values = value
        .as_array()
        .context("artifact snapshot cursor is not an array")?;
    if values.len() != 1 {
        bail!("artifact snapshot cursor has wrong width");
    }
    let id = values[0]
        .as_str()
        .context("artifact snapshot cursor is not a string")?;
    if id.is_empty() {
        bail!("artifact snapshot cursor is empty");
    }
    Ok(Some(id.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(
        seq: u64,
        operation: &str,
        payload_json: String,
        blob: Option<Vec<u8>>,
    ) -> ChangeEvent {
        let mut event = ChangeEvent {
            created_at: "2030-01-02T03:04:05.000Z".into(),
            format_registered: true,
            format_version: 1,
            operation: operation.into(),
            payload_blob_base64: blob.as_ref().map(|bytes| STANDARD.encode(bytes)),
            payload_digest: String::new(),
            payload_json,
            producer: "test".into(),
            revision: seq,
            seq,
            stream: STREAM.into(),
            stream_version: 1,
            subject_id: "track-a".into(),
            subject_type: "track".into(),
            supported_by_consumer: true,
        };
        event.payload_digest = event_digest(&event, blob.as_deref().unwrap_or_default()).unwrap();
        event
    }

    fn page(checkpoint: u64, events: Vec<ChangeEvent>) -> ChangePage {
        let digests = events
            .iter()
            .map(|event| event.payload_digest.clone())
            .collect::<Vec<_>>();
        let through = events.last().map_or(checkpoint, |event| event.seq);
        ChangePage {
            batch_digest: extend_digest(EMPTY_DIGEST, &digests).unwrap(),
            consumer_id: "sonar-test".into(),
            events,
            from_seq: checkpoint,
            has_more: false,
            head_seq: through,
            ok: true,
            through_seq: through,
        }
    }

    fn payload() -> String {
        canonical_payload(&TrackMeta {
            bpm: Some(0.1),
            anchored: true,
            duration_ms: Some(123),
            ..TrackMeta::default()
        })
        .unwrap()
    }

    #[test]
    fn canonical_payload_widens_f32_exactly_like_json_number() {
        assert_eq!(payload(), "{\"anchored\":true,\"bpm\":0.10000000149011612,\"certified\":false,\"dismissed\":false,\"durationMs\":123,\"hasFinding\":false,\"isDuplicate\":false,\"key\":null,\"nearestFindingScore\":null}");
        let blob = vec![0_u8; BLOB_LEN];
        assert_eq!(
            snapshot_item_digest("track-a", &payload(), &blob).unwrap(),
            "e31b2bf1247fcf00fb444df68d62410c6b1dd01c41cf5043785908238c514b9c"
        );
    }

    #[test]
    fn validates_exact_upsert_and_tombstone_bytes() {
        let upsert = event(8, "upsert", payload(), Some(vec![0_u8; BLOB_LEN]));
        let delete = event(9, "delete", "{}".into(), None);
        let batch = validate_change_page(page(7, vec![upsert, delete]), "sonar-test", 7).unwrap();
        assert!(matches!(
            batch.events[0].operation,
            ValidatedOperation::Upsert { .. }
        ));
        assert!(matches!(
            batch.events[1].operation,
            ValidatedOperation::Delete
        ));
    }

    #[test]
    fn accepts_numeric_gaps_but_rejects_ordering_and_payload_corruption() {
        let gap = event(9, "delete", "{}".into(), None);
        assert!(validate_change_page(page(7, vec![gap]), "sonar-test", 7).is_ok());

        let duplicate = event(8, "delete", "{}".into(), None);
        assert!(
            validate_change_page(page(7, vec![duplicate.clone(), duplicate]), "sonar-test", 7)
                .is_err()
        );

        let mut unknown = event(8, "delete", "{}".into(), None);
        unknown.format_registered = false;
        assert!(validate_change_page(page(7, vec![unknown]), "sonar-test", 7).is_err());

        let mut corrupt = event(8, "delete", "{}".into(), None);
        corrupt.payload_digest.replace_range(..2, "00");
        assert!(validate_change_page(page(7, vec![corrupt]), "sonar-test", 7).is_err());

        let noncanonical = event(
            8,
            "upsert",
            format!(" {}", payload()),
            Some(vec![0_u8; BLOB_LEN]),
        );
        assert!(validate_change_page(page(7, vec![noncanonical]), "sonar-test", 7).is_err());

        let mut future = event(8, "delete", "{}".into(), None);
        future.format_version = 2;
        future.payload_digest = event_digest(&future, &[]).unwrap();
        assert!(validate_change_page(page(7, vec![future]), "sonar-test", 7).is_err());
    }

    #[test]
    fn skips_known_undeclared_stream_but_keeps_global_order() {
        let mut other = event(8, "delete", "{}".into(), None);
        other.stream = "device.track".into();
        other.subject_type = "track".into();
        other.supported_by_consumer = false;
        other.payload_digest = event_digest(&other, &[]).unwrap();
        let batch = validate_change_page(page(7, vec![other]), "sonar-test", 7).unwrap();
        assert!(matches!(
            batch.events[0].operation,
            ValidatedOperation::Skip
        ));
    }
}
