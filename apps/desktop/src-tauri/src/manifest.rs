//! Reading and updating a pack's `manifest.json` from the shell.
//!
//! The shell reads only a few fields of a manifest (to list packs before the
//! web app validates them in full), and writes only the image summaries of a
//! version 2 manifest (`contents.maps[].layers[].images`) when map images are
//! downloaded into a pack folder. Every other field is left exactly as it is.

use std::{
    fs,
    io::Write,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::packs::is_valid_pack_id;

pub const MANIFEST_FILE: &str = "manifest.json";
/// Manifests larger than this are not read.
pub const MAX_MANIFEST_BYTES: u64 = 4 << 20;

/// What the shell needs to know about a pack before the web app loads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ManifestHead {
    pub id: String,
    pub title: String,
    pub pack_version: String,
    /// The importer that made the pack, if the manifest names one.
    pub importer: Option<(String, String)>,
    /// The web pages the pack was made from (`source.pages`), as far as
    /// they are usable: web addresses, at most [`MAX_SOURCE_PAGES`].
    pub pages: Vec<SourcePage>,
}

/// A page an imported pack was made from.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SourcePage {
    pub url: String,
    pub map_id: Option<String>,
}

/// Recorded pages a listing carries at most, and the longest address kept.
pub const MAX_SOURCE_PAGES: usize = 1000;
const MAX_SOURCE_URL_CHARS: usize = 2048;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawHead {
    schema_version: u32,
    game_id: String,
    title: String,
    pack_version: String,
    #[serde(default)]
    source: Option<RawSource>,
}

#[derive(Deserialize)]
struct RawSource {
    importer: Option<RawImporter>,
    /// Read loosely: an entry that is not a usable page is left out.
    #[serde(default)]
    pages: Vec<Value>,
}

/// The usable pages of a manifest's `source.pages`.
fn source_pages(pages: &[Value]) -> Vec<SourcePage> {
    pages
        .iter()
        .filter_map(|page| {
            let url = page.get("url")?.as_str()?;
            let web = url.starts_with("https://") || url.starts_with("http://");
            (web && url.len() <= MAX_SOURCE_URL_CHARS).then(|| SourcePage {
                url: url.to_owned(),
                map_id: page
                    .get("mapId")
                    .and_then(Value::as_str)
                    .filter(|id| id.len() <= 200)
                    .map(str::to_owned),
            })
        })
        .take(MAX_SOURCE_PAGES)
        .collect()
}

#[derive(Deserialize)]
struct RawImporter {
    id: String,
    title: String,
}

/// Reads the identifying fields of a pack folder's manifest.
pub fn read_head(dir: &Path) -> Result<ManifestHead, String> {
    let path = dir.join(MANIFEST_FILE);
    let metadata = fs::metadata(&path).map_err(|_| "it has no manifest.json".to_owned())?;
    if !metadata.is_file() {
        return Err("its manifest.json is not a file".to_owned());
    }
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Err("its manifest.json is too large".to_owned());
    }
    let text =
        fs::read_to_string(&path).map_err(|error| format!("cannot read manifest.json: {error}"))?;
    let raw: RawHead = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("its manifest.json is not a pack manifest: {error}"))?;
    if !matches!(raw.schema_version, 1 | 2) {
        return Err(format!(
            "it uses pack format version {}, which this app does not read",
            raw.schema_version
        ));
    }
    if !is_valid_pack_id(&raw.game_id) {
        return Err(format!("its pack id {:?} is not usable", raw.game_id));
    }
    let title = raw.title.trim();
    if title.is_empty() || title.chars().count() > 200 {
        return Err("its title is empty or too long".to_owned());
    }
    let pages = raw
        .source
        .as_ref()
        .map(|source| source_pages(&source.pages))
        .unwrap_or_default();
    Ok(ManifestHead {
        id: raw.game_id,
        title: title.to_owned(),
        pack_version: raw.pack_version,
        importer: raw
            .source
            .and_then(|source| source.importer)
            .map(|importer| (importer.id, importer.title)),
        pages,
    })
}

/// Compares two `major.minor.patch` versions; anything else compares as 0.0.0.
pub fn version_key(version: &str) -> (u64, u64, u64) {
    let core = version.split(['-', '+']).next().unwrap_or_default();
    let mut parts = core.split('.').map(|part| part.parse::<u64>().unwrap_or(0));
    (
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
        parts.next().unwrap_or(0),
    )
}

/// The current time as an RFC 3339 UTC timestamp, for example `2026-11-10T21:30:00Z`.
pub fn now_rfc3339() -> String {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| duration.as_secs());
    rfc3339(seconds)
}

/// Formats seconds since 1970 as RFC 3339 UTC.
pub fn rfc3339(seconds: u64) -> String {
    let days = i64::try_from(seconds / 86_400).unwrap_or(0);
    let rest = seconds % 86_400;
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        rest / 3600,
        (rest % 3600) / 60,
        rest % 60
    )
}

/// The images of one layer as last recorded.
pub struct ImagesUpdate<'a> {
    pub layer_id: &'a str,
    pub levels: Vec<u8>,
    pub complete: bool,
    /// Image files and bytes, when they were counted.
    pub counts: Option<(u64, u64)>,
}

/// Records the images of layers in a version 2 manifest's `contents`.
/// Manifests of version 1, or without a `contents` entry for the layer, are
/// left alone. Returns whether the file was changed.
pub fn update_images(dir: &Path, updates: &[ImagesUpdate<'_>]) -> Result<bool, String> {
    let path = dir.join(MANIFEST_FILE);
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Ok(false);
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let Ok(mut manifest) = serde_json::from_str::<Value>(&text) else {
        return Ok(false);
    };
    if manifest.get("schemaVersion") != Some(&json!(2)) {
        return Ok(false);
    }
    let now = now_rfc3339();
    let mut changed = false;
    let Some(maps) = manifest
        .pointer_mut("/contents/maps")
        .and_then(Value::as_array_mut)
    else {
        return Ok(false);
    };
    for map in maps {
        let Some(layers) = map.get_mut("layers").and_then(Value::as_array_mut) else {
            continue;
        };
        for layer in layers {
            let Some(update) = updates
                .iter()
                .find(|update| layer.get("id").and_then(Value::as_str) == Some(update.layer_id))
            else {
                continue;
            };
            let mut images = json!({
                "levels": update.levels,
                "complete": update.complete,
            });
            if let Some((files, bytes)) = update.counts {
                images["files"] = json!(files);
                images["bytes"] = json!(bytes);
            }
            images["updatedAt"] = json!(now);
            if let Some(object) = layer.as_object_mut() {
                object.insert("images".to_owned(), images);
                changed = true;
            }
        }
    }
    if changed {
        write_atomic(
            &path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?
            )
            .as_bytes(),
        )
        .map_err(|error| format!("could not update manifest.json: {error}"))?;
    }
    Ok(changed)
}

/// Removes the image summaries of layers from a version 2 manifest, after
/// their downloaded images were deleted. Every other field is kept. Returns
/// whether the file was changed.
pub fn clear_images(dir: &Path, layer_ids: &[&str]) -> Result<bool, String> {
    let path = dir.join(MANIFEST_FILE);
    let metadata = fs::metadata(&path).map_err(|error| error.to_string())?;
    if metadata.len() > MAX_MANIFEST_BYTES {
        return Ok(false);
    }
    let text = fs::read_to_string(&path).map_err(|error| error.to_string())?;
    let Ok(mut manifest) = serde_json::from_str::<Value>(&text) else {
        return Ok(false);
    };
    let Some(maps) = manifest
        .pointer_mut("/contents/maps")
        .and_then(Value::as_array_mut)
    else {
        return Ok(false);
    };
    let mut changed = false;
    for layer in maps
        .iter_mut()
        .filter_map(|map| map.get_mut("layers").and_then(Value::as_array_mut))
        .flatten()
    {
        let named = layer
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| layer_ids.contains(&id));
        if named {
            if let Some(object) = layer.as_object_mut() {
                changed |= object.remove("images").is_some();
            }
        }
    }
    if changed {
        write_atomic(
            &path,
            format!(
                "{}\n",
                serde_json::to_string_pretty(&manifest).map_err(|e| e.to_string())?
            )
            .as_bytes(),
        )
        .map_err(|error| format!("could not update manifest.json: {error}"))?;
    }
    Ok(changed)
}

/// Writes a file through a `.part` file and a rename, so readers never see
/// half of it. Retries the rename a few times: on Windows another process
/// reading the file can make it fail for a moment.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let part = path.with_file_name(format!(".{name}.part"));
    let mut file = fs::File::create(&part)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    let mut attempt = 0;
    loop {
        match fs::rename(&part, path) {
            Ok(()) => return Ok(()),
            Err(error) if attempt < 5 => {
                attempt += 1;
                let _ = error;
                std::thread::sleep(std::time::Duration::from_millis(50 * attempt));
            }
            Err(error) => {
                let _ = fs::remove_file(&part);
                return Err(error);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::tiles::store::tests::TempDir;

    #[test]
    fn formats_times() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_767_225_600), "2026-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_794_000_000), "2026-11-06T21:20:00Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
    }

    #[test]
    fn compares_versions() {
        assert!(version_key("1.10.0") > version_key("1.9.3"));
        assert!(version_key("2.0.0-beta") > version_key("1.99.99"));
        assert_eq!(version_key("x"), (0, 0, 0));
    }

    #[test]
    fn reads_manifest_heads() {
        let dir = TempDir::new("manifest-head");
        assert!(read_head(&dir.0).unwrap_err().contains("no manifest.json"));
        fs::write(
            dir.0.join(MANIFEST_FILE),
            r#"{"schemaVersion":2,"gameId":"test-valley","title":" Test Valley ","packVersion":"1.2.0",
               "source":{"importer":{"id":"demo-maps","title":"Demo"},"pages":[]}}"#,
        )
        .unwrap();
        let head = read_head(&dir.0).unwrap();
        assert_eq!(head.id, "test-valley");
        assert_eq!(head.title, "Test Valley");
        assert_eq!(head.importer, Some(("demo-maps".into(), "Demo".into())));
        assert!(head.pages.is_empty());
        // Recorded pages: web addresses only; an odd entry does not spoil the rest.
        fs::write(
            dir.0.join(MANIFEST_FILE),
            r#"{"schemaVersion":2,"gameId":"t","title":"T","packVersion":"1.0.0",
               "source":{"importer":{"id":"demo-maps","title":"Demo"},"pages":[
                 {"url":"https://maps.example.com/t/a","mapId":"t:map:a"},
                 {"url":"file:///etc/passwd"},{"nope":1},7,
                 {"url":"http://127.0.0.1:4432/demo-maps/t/b"}]}}"#,
        )
        .unwrap();
        assert_eq!(
            read_head(&dir.0).unwrap().pages,
            [
                SourcePage {
                    url: "https://maps.example.com/t/a".into(),
                    map_id: Some("t:map:a".into())
                },
                SourcePage {
                    url: "http://127.0.0.1:4432/demo-maps/t/b".into(),
                    map_id: None
                }
            ]
        );
        for bad in [
            r#"{"schemaVersion":3,"gameId":"a","title":"A","packVersion":"1.0.0"}"#,
            r#"{"schemaVersion":1,"gameId":"../a","title":"A","packVersion":"1.0.0"}"#,
            r#"{"schemaVersion":1,"gameId":"a","title":"","packVersion":"1.0.0"}"#,
            r#"[1,2,3]"#,
        ] {
            fs::write(dir.0.join(MANIFEST_FILE), bad).unwrap();
            assert!(read_head(&dir.0).is_err(), "{bad}");
        }
    }

    #[test]
    fn updates_image_summaries_of_version_2_manifests_only() {
        let dir = TempDir::new("manifest-images");
        let manifest = r#"{"schemaVersion":2,"gameId":"t","title":"T","packVersion":"1.0.0",
          "contents":{"maps":[{"id":"t:map:a","layers":[{"id":"t:layer:a","name":"Map"},{"id":"t:layer:b"}]}]}}"#;
        fs::write(dir.0.join(MANIFEST_FILE), manifest).unwrap();
        let update = ImagesUpdate {
            layer_id: "t:layer:a",
            levels: vec![0, 1],
            complete: false,
            counts: Some((5, 1234)),
        };
        assert!(update_images(&dir.0, &[update]).unwrap());
        let written: Value =
            serde_json::from_str(&fs::read_to_string(dir.0.join(MANIFEST_FILE)).unwrap()).unwrap();
        let images = &written["contents"]["maps"][0]["layers"][0]["images"];
        assert_eq!(images["levels"], json!([0, 1]));
        assert_eq!(images["files"], json!(5));
        assert!(images["updatedAt"].as_str().unwrap().ends_with('Z'));
        assert!(written["contents"]["maps"][0]["layers"][1]
            .get("images")
            .is_none());
        // Field order is kept.
        let text = fs::read_to_string(dir.0.join(MANIFEST_FILE)).unwrap();
        assert!(text.find("schemaVersion").unwrap() < text.find("gameId").unwrap());

        fs::write(
            dir.0.join(MANIFEST_FILE),
            r#"{"schemaVersion":1,"gameId":"t","title":"T","packVersion":"1.0.0"}"#,
        )
        .unwrap();
        let update = ImagesUpdate {
            layer_id: "t:layer:a",
            levels: vec![0],
            complete: true,
            counts: None,
        };
        assert!(!update_images(&dir.0, &[update]).unwrap());
    }

    #[test]
    fn clears_image_summaries_of_named_layers_only() {
        let dir = TempDir::new("manifest-clear");
        let manifest = r#"{"schemaVersion":2,"gameId":"t","title":"T","packVersion":"1.0.0",
          "contents":{"maps":[{"id":"t:map:a","layers":[
            {"id":"t:layer:a","name":"Map","images":{"levels":[0],"complete":false}},
            {"id":"t:layer:b","images":{"levels":[0,1],"complete":true}}]}]}}"#;
        fs::write(dir.0.join(MANIFEST_FILE), manifest).unwrap();
        assert!(clear_images(&dir.0, &["t:layer:a"]).unwrap());
        let written: Value =
            serde_json::from_str(&fs::read_to_string(dir.0.join(MANIFEST_FILE)).unwrap()).unwrap();
        let layers = &written["contents"]["maps"][0]["layers"];
        assert!(layers[0].get("images").is_none());
        assert_eq!(layers[0]["name"], "Map");
        assert_eq!(layers[1]["images"]["levels"], json!([0, 1]));
        assert_eq!(written["gameId"], "t");
        // Nothing left to clear: the file is not written again.
        assert!(!clear_images(&dir.0, &["t:layer:a"]).unwrap());
    }
}
