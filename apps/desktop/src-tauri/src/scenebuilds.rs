//! 3D models of maps for an importer (`ImportContext.sceneModel` of the
//! importer contract): a site that keeps each map as a 3D model. The web
//! app asks for the model, or each of its pieces in order, as it asks for
//! every page it reads by itself (the site's rules file, `robots.txt`, the
//! pause and stopping at the first refusal are its, see `importing.ts`);
//! this module makes each request ([`fetch_model_part`], as `pagefetch.rs`
//! does: the app's own name, no cookies, redirects on the same site only),
//! keeps what came in a hidden folder of the maps folder, joins pieces
//! back into one model, and builds it with Atlas's one 3D builder
//! (`atlas_scene`, [`build_scene`]): the map's model files under
//! `scene/<folder>/` and its pictures drawn from above under
//! `tiles/<folder>/`, in a pack folder of the build's own. The build stays
//! there until the import that names it is saved, which moves it into the
//! pack (`Library::save_import`), or is thrown away ([`discard`]); the
//! folder is cleared at the next start in any case, as every `.importing-`
//! folder is (see `removal::finish_pending_deletes`).
//!
//! In a build with downloads only. Android has no builder, so it builds
//! nothing.

use std::{
    io::Write as _,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

use crate::pagefetch::{request, Head};

/// The hidden folder of the maps folder that holds models and their builds
/// until an import is saved. Its name begins with the prefix of folders a
/// start clears.
pub const BUILDS_DIR: &str = ".importing-scene-builds";
/// A model larger than this, as one file once joined, is not kept (the
/// importer contract's `SCENE_MODEL_MAX_BYTES`).
pub const MAX_MODEL_BYTES: u64 = 1 << 30;
/// One piece larger than this, as a file, is not kept.
pub const MAX_PIECE_BYTES: u64 = 256 << 20;
/// How long the request for one file may take, all of it.
const TIMEOUT: Duration = Duration::from_secs(600);
/// The raw model, as fetched, joined, or sent by the importer (`gamefolders.rs`).
pub const MODEL_FILE: &str = "model.glb";
/// The pieces' base64 text, joined in order, until the model is built.
const PIECES_FILE: &str = "model.b64";
/// The pack folder of a build: `scene/<folder>/` and `tiles/<folder>/`.
pub const BUILT_PACK: &str = "pack";

/// Whether `name` is the app's name of a build: lowercase letters, digits
/// and dashes, as the importer contract's `SCENE_BUILD_PATTERN`.
pub fn is_build_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with('-')
}

/// Whether `folder` is a map's folder of a build, as the contract's
/// `SCENE_FOLDER_PATTERN`.
pub fn is_folder_name(folder: &str) -> bool {
    (1..=64).contains(&folder.len())
        && folder
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
        && folder.starts_with(|c: char| c.is_ascii_lowercase() || c.is_ascii_digit())
}

/// A new name for a build.
fn new_name() -> String {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_nanos());
    format!(
        "{:x}-{:x}-{:x}",
        nanos,
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}

/// The folder of a build.
pub fn build_dir(builds: &Path, name: &str) -> PathBuf {
    builds.join(name)
}

/// One answer for a model or a piece, as the web app reads it.
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FetchedModel {
    pub url: String,
    pub final_url: String,
    pub status: u16,
    /// Lowercase, without parameters; empty when absent.
    pub content_type: String,
    /// The `Retry-After` header, when the site sent one.
    pub retry_after: Option<String>,
    /// The build the answer was kept in, for a successful answer that came
    /// whole and within the limits (and for a piece, had its field).
    pub build: Option<String>,
    /// The answer was larger than the app keeps, so it was not kept.
    pub too_large: bool,
    /// A piece that is not JSON with text at its field.
    pub no_field: bool,
}

/// Reads the whole body of an answer, up to `limit` bytes; `None` when it is larger.
async fn body_of(response: &mut reqwest::Response, limit: u64) -> Result<Option<Vec<u8>>, String> {
    if response.content_length().unwrap_or(0) > limit {
        return Ok(None);
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "The model was cut off.".to_owned())?
    {
        if (body.len() + chunk.len()) as u64 > limit {
            return Ok(None);
        }
        body.extend_from_slice(&chunk);
    }
    Ok(Some(body))
}

/// Fetches the model, or one of its pieces, at `address` as the app, and
/// keeps it in the build `build` (a new one when none is given). A piece
/// (`field` given) is a JSON file whose top object's `field` holds base64
/// text: its text is added after the pieces kept before. Any answer is
/// handed back with its status; only a successful one is kept.
pub async fn fetch_model_part(
    address: &str,
    builds: &Path,
    build: Option<&str>,
    field: Option<&str>,
) -> Result<FetchedModel, String> {
    if build.is_some_and(|name| !is_build_name(name)) {
        return Err("That model is not one this app kept.".to_owned());
    }
    let accept = if field.is_some() {
        "application/json, text/plain;q=0.5"
    } else {
        "model/gltf-binary, application/octet-stream;q=0.8, */*;q=0.5"
    };
    let (url, mut response) = request(address, accept, TIMEOUT).await?;
    let head = Head::of(&response);
    let mut answer = FetchedModel {
        url: url.to_string(),
        final_url: head.final_url,
        status: head.status,
        content_type: head.content_type,
        retry_after: head.retry_after,
        build: None,
        too_large: false,
        no_field: false,
    };
    if !(200..300).contains(&answer.status) {
        return Ok(answer);
    }
    let name = build.map_or_else(new_name, str::to_owned);
    let dir = build_dir(builds, &name);
    if build.is_some() && !dir.is_dir() {
        return Err("That model is not kept any more.".to_owned());
    }
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("Could not write to the maps folder: {error}"))?;
    let keep_error = |error: std::io::Error| format!("Could not keep the model: {error}");
    match field {
        Some(field) => {
            let Some(body) = body_of(&mut response, MAX_PIECE_BYTES).await? else {
                answer.too_large = true;
                return Ok(answer);
            };
            let text = serde_json::from_slice::<serde_json::Value>(&body)
                .ok()
                .and_then(|value| value.get(field)?.as_str().map(str::to_owned));
            let Some(text) = text else {
                answer.no_field = true;
                return Ok(answer);
            };
            let path = dir.join(PIECES_FILE);
            let before = std::fs::metadata(&path).map_or(0, |m| m.len());
            if (before + text.len() as u64) / 4 * 3 > MAX_MODEL_BYTES {
                answer.too_large = true;
                return Ok(answer);
            }
            let mut file = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .map_err(keep_error)?;
            file.write_all(text.trim().as_bytes()).map_err(keep_error)?;
        }
        None => {
            let path = dir.join(MODEL_FILE);
            let Some(body) = body_of(&mut response, MAX_MODEL_BYTES).await? else {
                answer.too_large = true;
                return Ok(answer);
            };
            std::fs::write(&path, body).map_err(keep_error)?;
        }
    }
    answer.build = Some(name);
    Ok(answer)
}

/// The value of one base64 character, or `None` for one that is not.
fn sextet(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some(u32::from(c - b'A')),
        b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
        b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
        b'+' | b'-' => Some(62),
        b'/' | b'_' => Some(63),
        _ => None,
    }
}

/// Decodes base64 text (the standard alphabet or the one for addresses,
/// with or without `=` at the end, white space ignored) into bytes.
pub fn decode_base64(text: &[u8]) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut bits = 0u32;
    let mut count = 0u32;
    let mut ended = false;
    for &c in text {
        if c.is_ascii_whitespace() {
            continue;
        }
        if c == b'=' {
            ended = true;
            continue;
        }
        if ended {
            return Err("The model's pieces are not base64 text.".to_owned());
        }
        let value =
            sextet(c).ok_or_else(|| "The model's pieces are not base64 text.".to_owned())?;
        bits = (bits << 6) | value;
        count += 1;
        if count == 4 {
            out.extend_from_slice(&[(bits >> 16) as u8, (bits >> 8) as u8, bits as u8]);
            bits = 0;
            count = 0;
        }
    }
    match count {
        0 => {}
        2 => out.push((bits >> 4) as u8),
        3 => out.extend_from_slice(&[(bits >> 10) as u8, (bits >> 2) as u8]),
        _ => return Err("The model's pieces are not base64 text.".to_owned()),
    }
    Ok(out)
}

/// A floor to draw from above, as the web app hands it over.
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct BuildFloor {
    pub id: String,
    pub heights: [f64; 2],
}

/// How to build a kept model, as the web app hands it over (checked there
/// with the contract's `checkSceneModelRequest`, and here again).
#[derive(Clone, Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct BuildRequest {
    pub folder: String,
    #[serde(default)]
    pub axes: Option<[String; 3]>,
    #[serde(default)]
    pub scale: Option<f64>,
    #[serde(default)]
    pub offset: Option<[f64; 3]>,
    #[serde(default)]
    pub drop: Vec<String>,
    #[serde(default)]
    pub water: Option<f64>,
    #[serde(default)]
    pub sky: Option<String>,
    #[serde(default)]
    pub floors: Vec<BuildFloor>,
    /// `keep` keeps the model's textures (at their own size in the finest
    /// level, smaller copies in coarser ones); anything else, or none,
    /// keeps each texture's average colour.
    #[serde(default)]
    pub textures: Option<String>,
    /// With `keep`: the longest side of a picture at the finest level, a
    /// power of two; none keeps each picture's own size.
    #[serde(default)]
    pub texture_size: Option<u32>,
}

/// What building a kept model gave, as the web app reads it: the scene and
/// its pictures, or why there is none (`format`, `size`, `missing` or
/// `failed`) with a sentence.
#[derive(Clone, Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SceneBuilt {
    pub ok: bool,
    pub scene: Option<serde_json::Value>,
    pub rendered: Option<serde_json::Value>,
    pub triangles: usize,
    pub warnings: Vec<String>,
    pub problem: Option<String>,
    pub message: Option<String>,
}

impl SceneBuilt {
    fn problem(problem: &str, message: String) -> Self {
        Self {
            problem: Some(problem.to_owned()),
            message: Some(message),
            ..Self::default()
        }
    }
}

/// The builder's options for a request: the map's model files in
/// `scene/<folder>/`, and its pictures, one per floor (or the whole map),
/// in `tiles/<folder>/`.
#[cfg(not(target_os = "android"))]
pub fn options_of(request: &BuildRequest) -> Result<atlas_scene::Options, String> {
    if !is_folder_name(&request.folder) {
        return Err("The map's folder is not one this app takes.".to_owned());
    }
    if request
        .floors
        .iter()
        .any(|floor| !is_folder_name(&floor.id))
    {
        return Err("A floor's id is not one this app takes.".to_owned());
    }
    let mut options = serde_json::json!({
        "folder": format!("scene/{}", request.folder),
        "drop": request.drop,
        "textures": if request.textures.as_deref() == Some("keep") {
            match request.texture_size {
                Some(size) => serde_json::json!({ "mode": "keep", "maxSize": size }),
                None => serde_json::json!({ "mode": "keep" }),
            }
        } else {
            serde_json::json!({ "mode": "average" })
        },
        "render": {
            "folder": format!("tiles/{}", request.folder),
            "floors": if request.floors.len() >= 2 { serde_json::json!(request.floors) } else { serde_json::json!([]) },
        },
    });
    if let Some(axes) = &request.axes {
        options["axes"] = serde_json::json!(axes);
    }
    if let Some(scale) = request.scale {
        options["scale"] = serde_json::json!(scale);
    }
    if let Some(offset) = request.offset {
        options["offset"] = serde_json::json!(offset);
    }
    if let Some(water) = request.water {
        options["water"] = serde_json::json!(water);
    }
    if let Some(sky) = &request.sky {
        options["sky"] = serde_json::json!(sky);
    }
    serde_json::from_value(options)
        .map_err(|error| format!("The model cannot be built so: {error}"))
}

/// Builds the model kept in the build `name` (joining its pieces first)
/// into the build's own pack folder, and lets the raw model go. A model
/// the builder cannot read is not built.
#[cfg(not(target_os = "android"))]
pub fn build_scene(builds: &Path, name: &str, request: &BuildRequest) -> SceneBuilt {
    if !is_build_name(name) {
        return SceneBuilt::problem("failed", "That model is not one this app kept.".into());
    }
    let dir = build_dir(builds, name);
    let model = dir.join(MODEL_FILE);
    let pieces = dir.join(PIECES_FILE);
    let done = (|| {
        let options = match options_of(request) {
            Ok(options) => options,
            Err(error) => return SceneBuilt::problem("failed", error),
        };
        if pieces.is_file() {
            let joined = std::fs::read(&pieces)
                .map_err(|error| error.to_string())
                .and_then(|text| decode_base64(&text));
            match joined {
                Ok(bytes) => {
                    if let Err(error) = std::fs::write(&model, bytes) {
                        return SceneBuilt::problem(
                            "failed",
                            format!("Could not keep the model: {error}"),
                        );
                    }
                    let _ = std::fs::remove_file(&pieces);
                }
                Err(error) => return SceneBuilt::problem("format", error),
            }
        }
        let bytes = match std::fs::read(&model) {
            Ok(bytes) => bytes,
            Err(_) => {
                return SceneBuilt::problem("missing", "That model is not kept any more.".into())
            }
        };
        if !bytes.starts_with(b"glTF") {
            return SceneBuilt::problem("format", "It is not a glTF binary model.".into());
        }
        let raw = match atlas_scene::gltf::read_glb(&bytes) {
            Ok(raw) => raw,
            Err(error) => {
                return SceneBuilt::problem("format", format!("The model cannot be read: {error}."))
            }
        };
        drop(bytes);
        let pack = dir.join(BUILT_PACK);
        let _ = std::fs::remove_dir_all(&pack);
        match atlas_scene::build(&raw, &options, &pack, &mut |_, _| {}) {
            Ok(built) => SceneBuilt {
                ok: true,
                scene: Some(built.scene),
                rendered: built
                    .rendered
                    .as_ref()
                    .and_then(|rendered| serde_json::to_value(rendered).ok()),
                triangles: built.report.triangles,
                warnings: built.report.warnings,
                problem: None,
                message: None,
            },
            Err(error) => {
                SceneBuilt::problem("failed", format!("The model could not be built: {error}."))
            }
        }
    })();
    let _ = std::fs::remove_file(&model);
    let _ = std::fs::remove_file(&pieces);
    done
}

/// Removes kept models and builds no saved import named.
pub fn discard(builds: &Path, names: &[String]) {
    for name in names.iter().filter(|name| is_build_name(name)) {
        let _ = std::fs::remove_dir_all(build_dir(builds, name));
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use crate::tiles::{
        download::tests::{MockServer, Reply},
        store::tests::TempDir,
    };

    fn ensure_crypto() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }

    #[test]
    fn names_and_base64() {
        assert!(is_build_name("18f3a-4c1-0"));
        for bad in ["", "-a", "A", "a/b", "a.b", &"a".repeat(65)] {
            assert!(!is_build_name(bad), "{bad}");
        }
        assert!(is_folder_name("east-isle_2"));
        for bad in ["", "-a", "A", "a/b", "a.b", ".."] {
            assert!(!is_folder_name(bad), "{bad}");
        }
        assert_ne!(new_name(), new_name());
        assert_eq!(decode_base64(b"aGVsbG8=").unwrap(), b"hello");
        assert_eq!(decode_base64(b"aGVs\nbG8").unwrap(), b"hello");
        assert_eq!(decode_base64(b"aGVsbG8h").unwrap(), b"hello!");
        assert!(decode_base64(b"aGVsb").is_err());
        assert!(decode_base64(b"a*==").is_err());
    }

    /// A made-up model: one square of two triangles, 10 units a side, at height 1.
    #[cfg(not(target_os = "android"))]
    fn square_glb() -> Vec<u8> {
        let positions: [[f32; 3]; 4] = [
            [0.0, 1.0, 0.0],
            [10.0, 1.0, 0.0],
            [10.0, 1.0, 10.0],
            [0.0, 1.0, 10.0],
        ];
        let indices: [u16; 6] = [0, 2, 1, 0, 3, 2];
        let mut bin = Vec::new();
        for p in positions {
            for v in p {
                bin.extend_from_slice(&v.to_le_bytes());
            }
        }
        for i in indices {
            bin.extend_from_slice(&i.to_le_bytes());
        }
        while !bin.len().is_multiple_of(4) {
            bin.push(0);
        }
        let json = serde_json::json!({
            "asset": { "version": "2.0" },
            "scene": 0,
            "scenes": [{ "nodes": [0] }],
            "nodes": [{ "mesh": 0, "name": "ground" }],
            "meshes": [{ "primitives": [{ "attributes": { "POSITION": 0 }, "indices": 1, "material": 0 }] }],
            "materials": [{ "name": "grass", "pbrMetallicRoughness": { "baseColorFactor": [0.2, 0.6, 0.2, 1.0] } }],
            "accessors": [
                { "bufferView": 0, "componentType": 5126, "count": 4, "type": "VEC3",
                  "min": [0.0, 1.0, 0.0], "max": [10.0, 1.0, 10.0] },
                { "bufferView": 1, "componentType": 5123, "count": 6, "type": "SCALAR" }
            ],
            "bufferViews": [
                { "buffer": 0, "byteOffset": 0, "byteLength": 48 },
                { "buffer": 0, "byteOffset": 48, "byteLength": 12 }
            ],
            "buffers": [{ "byteLength": bin.len() }]
        });
        let mut text = serde_json::to_vec(&json).unwrap();
        while !text.len().is_multiple_of(4) {
            text.push(b' ');
        }
        let mut glb = Vec::new();
        glb.extend_from_slice(b"glTF");
        glb.extend_from_slice(&2u32.to_le_bytes());
        glb.extend_from_slice(&((12 + 8 + text.len() + 8 + bin.len()) as u32).to_le_bytes());
        glb.extend_from_slice(&(text.len() as u32).to_le_bytes());
        glb.extend_from_slice(b"JSON");
        glb.extend_from_slice(&text);
        glb.extend_from_slice(&(bin.len() as u32).to_le_bytes());
        glb.extend_from_slice(b"BIN\0");
        glb.extend_from_slice(&bin);
        glb
    }

    /// Base64 of bytes, for the made-up pieces.
    fn encode(bytes: &[u8]) -> String {
        const ABC: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = String::new();
        for chunk in bytes.chunks(3) {
            let b = [
                chunk[0],
                *chunk.get(1).unwrap_or(&0),
                *chunk.get(2).unwrap_or(&0),
            ];
            let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
            for k in 0..4 {
                if k <= chunk.len() {
                    out.push(ABC[((n >> (18 - 6 * k)) & 63) as usize] as char);
                } else {
                    out.push('=');
                }
            }
        }
        out
    }

    #[tokio::test]
    async fn fetches_a_model_in_pieces_as_the_app_and_builds_it() {
        ensure_crypto();
        #[cfg(not(target_os = "android"))]
        let glb = square_glb();
        #[cfg(target_os = "android")]
        let glb = b"glTF made up".to_vec();
        let text = encode(&glb);
        // Cut at a place that is not a multiple of four, as a site may cut its text.
        let cut = text.len() / 2 + 1;
        let first = serde_json::json!({ "glb": &text[..cut] }).to_string();
        let second = serde_json::json!({ "glb": &text[cut..] }).to_string();
        let whole = glb.clone();
        let server = MockServer::start(Arc::new(move |path, _| match path {
            "/models/a/scene0.json" => Reply {
                body: first.clone().into_bytes(),
                ..Reply::status(200)
            },
            "/models/a/scene1.json" => Reply {
                body: second.clone().into_bytes(),
                ..Reply::status(200)
            },
            "/models/a/other.json" => Reply {
                body: b"{\"other\": 1}".to_vec(),
                ..Reply::status(200)
            },
            "/models/b/scene.glb" => Reply {
                body: whole.clone(),
                ..Reply::status(200)
            },
            "/slow" => Reply::status(429).header("Retry-After", "60"),
            _ => Reply::status(404),
        }))
        .await;
        let dir = TempDir::new("scene-builds");
        let builds = dir.0.join(BUILDS_DIR);
        let one = fetch_model_part(
            &server.url("/models/a/scene0.json"),
            &builds,
            None,
            Some("glb"),
        )
        .await
        .unwrap();
        let name = one.build.unwrap();
        let two = fetch_model_part(
            &server.url("/models/a/scene1.json"),
            &builds,
            Some(&name),
            Some("glb"),
        )
        .await
        .unwrap();
        assert_eq!(two.build.as_deref(), Some(name.as_str()));
        for seen in server.seen() {
            assert_eq!(
                seen.headers["user-agent"],
                crate::tiles::download::USER_AGENT
            );
            assert!(!seen.headers.contains_key("cookie"));
        }
        let other = fetch_model_part(
            &server.url("/models/a/other.json"),
            &builds,
            None,
            Some("glb"),
        )
        .await
        .unwrap();
        assert!(other.no_field && other.build.is_none());
        let slow = fetch_model_part(&server.url("/slow"), &builds, None, None)
            .await
            .unwrap();
        assert_eq!(
            (slow.status, slow.retry_after.as_deref(), slow.build),
            (429, Some("60"), None)
        );
        assert!(
            fetch_model_part(&server.url("/x"), &builds, Some("../x"), None)
                .await
                .is_err()
        );

        #[cfg(not(target_os = "android"))]
        {
            // The pieces joined are the model, built into the build's own pack folder.
            let request = BuildRequest {
                folder: "east".into(),
                drop: vec!["*invisible*".into()],
                ..BuildRequest::default()
            };
            let built = build_scene(&builds, &name, &request);
            assert!(built.ok, "{built:?}");
            assert_eq!(built.triangles, 2);
            let scene = built.scene.unwrap();
            let file = scene["cells"][0]["lods"][0]["file"].as_str().unwrap();
            assert!(file.starts_with("scene/east/"), "{file}");
            let pack = build_dir(&builds, &name).join(BUILT_PACK);
            assert!(pack.join(file).is_file());
            let rendered = built.rendered.unwrap();
            let url = rendered["layers"][0]["url"].as_str().unwrap();
            assert_eq!(url, "tiles/east/all/{z}/{x}/{y}.png");
            assert!(pack.join("tiles/east/all/0/0/0.png").is_file());
            assert!(!build_dir(&builds, &name).join(MODEL_FILE).exists());

            // One file, with floors drawn one picture each.
            let b = fetch_model_part(&server.url("/models/b/scene.glb"), &builds, None, None)
                .await
                .unwrap()
                .build
                .unwrap();
            let floors = BuildRequest {
                folder: "west".into(),
                floors: vec![
                    BuildFloor {
                        id: "f1".into(),
                        heights: [-5.0, 0.5],
                    },
                    BuildFloor {
                        id: "f2".into(),
                        heights: [0.5, 5.0],
                    },
                ],
                ..BuildRequest::default()
            };
            let built = build_scene(&builds, &b, &floors);
            assert!(built.ok, "{built:?}");
            let layers = &built.rendered.unwrap()["layers"];
            assert_eq!(layers.as_array().unwrap().len(), 2);
            // What is not a model is named as such.
            let text = fetch_model_part(&server.url("/models/a/other.json"), &builds, None, None)
                .await
                .unwrap()
                .build
                .unwrap();
            assert_eq!(
                build_scene(&builds, &text, &floors).problem.as_deref(),
                Some("format")
            );
            discard(&builds, &[name.clone(), b.clone(), "../x".to_owned()]);
            assert!(!build_dir(&builds, &name).exists());
        }
    }
}
