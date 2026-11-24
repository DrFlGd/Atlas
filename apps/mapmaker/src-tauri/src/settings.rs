//! The Map Maker's settings, in `settings.json` in the app's config folder: the last game folder, whether Make
//! map also makes 3D maps, the map style, how floors are found, the last make (so its report, and Adjust floors,
//! are there when the app opens again; for a map made from a 3D model, the model file and how it was set up, so it
//! can be read again), the folder a model was last chosen in, and per area how a picture to compare with was laid
//! over its map.
//! The player's own floor cuts are in `floor-overrides.json` beside it (see overrides.rs).

use std::{fs, path::Path};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub last_folder: Option<String>,
    /// "Also make 3D maps"; on when never chosen.
    #[serde(rename = "make3d", skip_serializing_if = "Option::is_none")]
    pub make_3d: Option<bool>,
    /// "Map style" (the helper's render.MAP_STYLES): how the floors are drawn; "shaded" when never chosen.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub map_style: Option<String>,
    /// "Floors" (FLOOR_METHODS): how Make map finds floors; none when never chosen (as suits the game).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub floor_method: Option<String>,
    /// The last make: its game folder (or model file) and output folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_make: Option<LastMake>,
    /// The folder of the 3D model chosen last ("Make a map from a 3D model…").
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_model_folder: Option<String>,
    /// "Compare with a picture…": per `game:mAA_BB`, the picture and how it lies over the map (clean_alignment).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compare: Option<Map<String, Value>>,
}

#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LastMake {
    /// The game folder, or for a map made from a 3D model, the model file.
    pub folder: String,
    pub out: String,
    /// How the model was set up, for a map made from a 3D model.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelSetup>,
}

/// How a 3D model is made into a map (the setup of "Make a map from a 3D model…", the helper's `make-model`).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelSetup {
    /// The map's name: the pack id is made from it.
    pub name: String,
    /// The pack's title, as Atlas lists it.
    pub title: String,
    /// The model's up axis: `+y`, `+z`, `-y`, `-z`, `+x` or `-x`.
    pub up: String,
    /// Metres per model unit.
    pub scale: f64,
    /// What the scale is: `metres`, `centimetres`, `millimetres`, `inches`, `feet` or `custom`.
    pub units: String,
    /// `keep` the model's textures, or `plain` colours.
    pub textures: String,
    /// Both sides of every face drawn: `auto` (as the file says), `yes` or `no`.
    pub double_sided: String,
    /// How floors are found: `ground` (by ground area), `passages` or `none`.
    pub floors: String,
    /// Ground area: floor levels at least this far apart (metres); `None` for the helper's own.
    #[serde(default)]
    pub floor_separation: Option<f64>,
    /// Ground area: levels closer than this are joined (metres).
    #[serde(default)]
    pub merge_gap: Option<f64>,
    /// "Allow very large models": up to LARGEST_TRIANGLES triangles instead of DEFAULT_TRIANGLES.
    #[serde(default)]
    pub allow_large: bool,
    /// How the floors are drawn (MODEL_MAP_STYLES).
    pub map_style: String,
}

/// The triangles a model may have, and with "Allow very large models" (as atlas-scene's formats.rs).
pub const DEFAULT_TRIANGLES: u64 = 5_000_000;
pub const LARGEST_TRIANGLES: u64 = 50_000_000;
pub const UP_AXES: [&str; 6] = ["+y", "+z", "-y", "-z", "+x", "-x"];
pub const UNITS: [&str; 6] = [
    "metres",
    "centimetres",
    "millimetres",
    "inches",
    "feet",
    "custom",
];
/// A model is drawn in its own textures and colours, so the textured styles can be chosen for it.
pub const MODEL_MAP_STYLES: [&str; 5] = [
    "shaded",
    "outlines",
    "floors",
    "textured",
    "textured-outlines",
];
const MODEL_FLOORS: [&str; 3] = ["ground", "passages", "none"];
const MAX_NAME: usize = 80;

fn plain_text(text: &str, what: &str) -> Result<(), String> {
    if text.trim().is_empty() {
        return Err(format!("Give the map {what}."));
    }
    if text.chars().count() > MAX_NAME || text.chars().any(char::is_control) {
        return Err(format!(
            "The {what} is too long, or has characters that cannot be used."
        ));
    }
    Ok(())
}

impl ModelSetup {
    /// The setup when it can be used, or what is wrong with it.
    pub fn checked(self) -> Result<Self, String> {
        plain_text(&self.name, "a name")?;
        plain_text(&self.title, "a title")?;
        let choice = |value: &str, choices: &[&str], what: &str| {
            if choices.contains(&value) {
                Ok(())
            } else {
                Err(format!("{value} is not {what}."))
            }
        };
        choice(&self.up, &UP_AXES, "an up axis")?;
        choice(&self.units, &UNITS, "a unit")?;
        choice(
            &self.textures,
            &["keep", "plain"],
            "a way of drawing textures",
        )?;
        choice(
            &self.double_sided,
            &["auto", "yes", "no"],
            "a choice of sides",
        )?;
        choice(&self.floors, &MODEL_FLOORS, "a way of finding floors")?;
        choice(&self.map_style, &MODEL_MAP_STYLES, "a map style")?;
        if !(self.scale.is_finite() && (1e-6..=1e6).contains(&self.scale)) {
            return Err(
                "The scale must be a number above 0.000001 and up to 1,000,000.".to_owned(),
            );
        }
        let within = |value: Option<f64>, low: f64, high: f64, what: &str| match value {
            Some(n) if !(n.is_finite() && (low..=high).contains(&n)) => Err(format!(
                "The {what} must be between {low} and {high} metres."
            )),
            _ => Ok(()),
        };
        within(self.floor_separation, 0.5, 50.0, "floor separation")?;
        within(self.merge_gap, 0.0, 20.0, "merge gap")?;
        Ok(ModelSetup {
            name: self.name.trim().to_owned(),
            title: self.title.trim().to_owned(),
            ..self
        })
    }

    /// The most triangles the helper is to read.
    pub fn max_triangles(&self) -> u64 {
        if self.allow_large {
            LARGEST_TRIANGLES
        } else {
            DEFAULT_TRIANGLES
        }
    }
}

impl Settings {
    pub fn make_3d(&self) -> bool {
        self.make_3d.unwrap_or(true)
    }

    pub fn map_style(&self) -> &str {
        self.map_style
            .as_deref()
            .filter(|style| is_map_style(style))
            .unwrap_or(DEFAULT_MAP_STYLE)
    }

    /// "Floors", when chosen: `passages` or `cuts`.
    pub fn floor_method(&self) -> Option<&str> {
        self.floor_method
            .as_deref()
            .filter(|method| is_floor_method(method))
    }

    /// The pictures to compare with, and how each lies over its area's map.
    pub fn compare(&self) -> Map<String, Value> {
        let mut out = Map::new();
        for (key, value) in self.compare.iter().flatten() {
            if let (true, Some(value)) = (is_compare_key(key), clean_alignment(value)) {
                out.insert(key.clone(), value);
            }
        }
        out
    }

    /// Sets (or with `None` forgets) the picture of one area. Returns them all.
    pub fn set_compare(
        &mut self,
        key: &str,
        alignment: Option<&Value>,
    ) -> Result<Map<String, Value>, String> {
        if !is_compare_key(key) {
            return Err(format!("{key} is not an area of a game."));
        }
        let mut all = self.compare();
        match alignment.and_then(clean_alignment) {
            Some(value) => {
                if !all.contains_key(key) && all.len() >= MAX_COMPARED {
                    return Err("Too many pictures are remembered: forget one first.".to_owned());
                }
                all.insert(key.to_owned(), value);
            }
            None => {
                all.remove(key);
            }
        }
        self.compare = (!all.is_empty()).then(|| all.clone());
        Ok(all)
    }

    /// Whether `path` is a picture remembered for some area (only those are opened again without asking).
    pub fn remembers_picture(&self, path: &str) -> bool {
        self.compare()
            .values()
            .any(|value| value.get("picture").and_then(Value::as_str) == Some(path))
    }
}

/// How floors can be found (the helper's `--floor-method`).
pub const FLOOR_METHODS: [&str; 2] = ["passages", "cuts"];

pub fn is_floor_method(method: &str) -> bool {
    FLOOR_METHODS.contains(&method)
}

const MAX_COMPARED: usize = 256;
const MAX_PICTURE_PATH: usize = 1024;

/// `game:mAA_BB`, the key of one area's picture.
pub fn is_compare_key(key: &str) -> bool {
    match key.split_once(':') {
        Some((game, area)) => {
            crate::overrides::is_game(game)
                && crate::overrides::area_key(area).as_deref() == Some(area)
        }
        None => false,
    }
}

fn number(value: &Value, key: &str, low: f64, high: f64, default: f64) -> Value {
    let n = value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|n| n.is_finite())
        .map_or(default, |n| n.clamp(low, high));
    serde_json::json!((n * 10_000.0).round() / 10_000.0)
}

/// One area's picture to compare with: `picture` (its path on this computer), `x` and `y` (where its middle lies
/// over the map, as fractions of the map picture's width and height), `scale` (its width as a fraction of the
/// map's), `turn` (degrees, clockwise), `opacity` (0 to 1, over the map) and `view` (`overlay` or `side`). Numbers
/// are kept in range; `None` without a picture.
pub fn clean_alignment(value: &Value) -> Option<Value> {
    let picture = value.get("picture")?.as_str()?;
    if picture.is_empty()
        || picture.chars().count() > MAX_PICTURE_PATH
        || picture.chars().any(char::is_control)
    {
        return None;
    }
    let view = match value.get("view").and_then(Value::as_str) {
        Some("side") => "side",
        _ => "overlay",
    };
    Some(serde_json::json!({
        "picture": picture,
        "x": number(value, "x", -1e6, 1e6, 0.0),
        "y": number(value, "y", -1e6, 1e6, 0.0),
        "scale": number(value, "scale", 0.001, 1000.0, 1.0),
        "turn": number(value, "turn", -360.0, 360.0, 0.0),
        "opacity": number(value, "opacity", 0.0, 1.0, 0.5),
        "view": view,
    }))
}

/// The map styles the helper can draw now (the textured ones need the game's textures, not read yet).
pub const MAP_STYLES: [&str; 3] = ["shaded", "outlines", "floors"];
pub const DEFAULT_MAP_STYLE: &str = "shaded";

pub fn is_map_style(style: &str) -> bool {
    MAP_STYLES.contains(&style)
}

pub fn read(file: &Path) -> Settings {
    fs::read_to_string(file)
        .ok()
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default()
}

pub fn write(file: &Path, settings: &Settings) -> Result<(), String> {
    if let Some(parent) = file.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let text = serde_json::to_string_pretty(settings).map_err(|error| error.to_string())?;
    // Written next to it first, so a crash never leaves half a file.
    let partial = file.with_extension("json.partial");
    fs::write(&partial, text).map_err(|error| error.to_string())?;
    fs::rename(&partial, file).map_err(|error| error.to_string())
}

/// Where Steam installs Dark Souls Remastered by default, when that folder exists here.
pub fn typical_folder() -> Option<String> {
    let candidates = [
        r"C:\Program Files (x86)\Steam\steamapps\common\DARK SOULS REMASTERED",
        r"C:\Program Files\Steam\steamapps\common\DARK SOULS REMASTERED",
    ];
    candidates
        .iter()
        .find(|path| cfg!(windows) && Path::new(path).is_dir())
        .map(|path| (*path).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_bad_files() {
        let dir =
            std::env::temp_dir().join(format!("atlas-mapmaker-settings-{}", std::process::id()));
        let file = dir.join("settings.json");
        assert_eq!(read(&file), Settings::default());
        assert!(read(&file).make_3d(), "3D maps are on until turned off");
        assert_eq!(read(&file).map_style(), "shaded");
        let mut settings = Settings {
            last_folder: Some(r"C:\Games\DARK SOULS REMASTERED".into()),
            make_3d: Some(false),
            map_style: Some("outlines".into()),
            floor_method: Some("passages".into()),
            last_make: Some(LastMake {
                folder: r"C:\Games\DARK SOULS REMASTERED".into(),
                out: r"C:\Users\Someone\AppData\Local\Atlas Map Maker\makes\run-1".into(),
                model: None,
            }),
            last_model_folder: Some(r"C:\Users\Someone\Documents\3D Models ü".into()),
            compare: None,
        };
        settings
            .set_compare(
                "bloodborne:m24_01",
                Some(&serde_json::json!({"picture": r"C:\Pictures\made-up.png", "scale": 2.5, "turn": 900, "view": "side"})),
            )
            .unwrap();
        write(&file, &settings).unwrap();
        assert_eq!(read(&file), settings);
        assert!(!read(&file).make_3d());
        assert_eq!(read(&file).map_style(), "outlines");
        assert_eq!(read(&file).floor_method(), Some("passages"));
        let compared = read(&file).compare();
        assert_eq!(
            compared["bloodborne:m24_01"]["turn"], 360.0,
            "kept in range"
        );
        assert_eq!(compared["bloodborne:m24_01"]["opacity"], 0.5);
        assert_eq!(compared["bloodborne:m24_01"]["view"], "side");
        assert!(read(&file).remembers_picture(r"C:\Pictures\made-up.png"));
        assert!(!read(&file).remembers_picture(r"C:\Windows\win.ini"));
        let mut forget = read(&file);
        assert!(forget
            .set_compare("bloodborne:m24_01", None)
            .unwrap()
            .is_empty());
        assert_eq!(forget.compare, None);
        assert!(forget.set_compare("../x", None).is_err());
        assert!(
            forget
                .set_compare("g:m10_01", Some(&serde_json::json!({"x": 1})))
                .unwrap()
                .is_empty(),
            "no picture, nothing kept"
        );
        let unknown = Settings {
            map_style: Some("textured".into()),
            ..Settings::default()
        };
        assert_eq!(
            unknown.map_style(),
            "shaded",
            "not a style that can be drawn yet"
        );
        let text = fs::read_to_string(&file).unwrap();
        assert!(
            text.contains("lastFolder")
                && text.contains("make3d")
                && text.contains("mapStyle")
                && text.contains("lastMake"),
            "{text}"
        );
        fs::write(&file, "not json").unwrap();
        assert_eq!(read(&file), Settings::default());
        let _ = fs::remove_dir_all(&dir);
    }

    fn setup() -> ModelSetup {
        ModelSetup {
            name: "  Made-up House ".into(),
            title: "Made-up House".into(),
            up: "+z".into(),
            scale: 0.01,
            units: "centimetres".into(),
            textures: "keep".into(),
            double_sided: "auto".into(),
            floors: "ground".into(),
            floor_separation: Some(3.0),
            merge_gap: None,
            allow_large: false,
            map_style: "textured".into(),
        }
    }

    #[test]
    fn model_setups_are_checked_and_kept() {
        let checked = setup().checked().unwrap();
        assert_eq!(checked.name, "Made-up House", "trimmed");
        assert_eq!(checked.max_triangles(), DEFAULT_TRIANGLES);
        let large = ModelSetup {
            allow_large: true,
            ..setup()
        };
        assert_eq!(large.max_triangles(), LARGEST_TRIANGLES);
        for bad in [
            ModelSetup {
                name: " ".into(),
                ..setup()
            },
            ModelSetup {
                title: "a\u{7}b".into(),
                ..setup()
            },
            ModelSetup {
                up: "up".into(),
                ..setup()
            },
            ModelSetup {
                scale: 0.0,
                ..setup()
            },
            ModelSetup {
                scale: f64::NAN,
                ..setup()
            },
            ModelSetup {
                floors: "stacked".into(),
                ..setup()
            },
            ModelSetup {
                floor_separation: Some(0.1),
                ..setup()
            },
            ModelSetup {
                map_style: "watercolour".into(),
                ..setup()
            },
        ] {
            assert!(bad.clone().checked().is_err(), "{bad:?}");
        }
        let dir = std::env::temp_dir().join(format!(
            "atlas-mapmaker-settings-model-{}",
            std::process::id()
        ));
        let file = dir.join("settings.json");
        let settings = Settings {
            last_make: Some(LastMake {
                folder: r"C:\Users\Someone\3D Models\house ü.obj".into(),
                out: r"C:\Users\Someone\AppData\Local\Atlas Map Maker\makes\run-2".into(),
                model: Some(checked),
            }),
            ..Settings::default()
        };
        write(&file, &settings).unwrap();
        assert_eq!(read(&file), settings);
        let text = fs::read_to_string(&file).unwrap();
        assert!(
            text.contains("doubleSided") && text.contains("allowLarge"),
            "{text}"
        );
        let _ = fs::remove_dir_all(&dir);
    }
}
