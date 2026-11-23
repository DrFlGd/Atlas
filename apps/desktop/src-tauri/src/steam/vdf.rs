//! Steam's two file formats that Atlas reads: the binary VDF of a user's
//! non-Steam games (`userdata/<id>/config/shortcuts.vdf`), read and written
//! back, and the text VDF of the users signed in (`config/loginusers.vdf`),
//! only read. Strings of the binary file are kept as bytes, so every
//! shortcut that is not Atlas's own is written back exactly as it was.

use std::path::Path;

/// A value in a binary VDF file.
#[derive(Clone, Debug, PartialEq)]
pub enum Vdf {
    Map(Vec<(Vec<u8>, Vdf)>),
    Str(Vec<u8>),
    Int(u32),
    /// Any other type (a float, a 64-bit number): its type byte and bytes.
    Raw(u8, Vec<u8>),
}

impl Vdf {
    /// A value of a map, by its key (any case).
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        match self {
            Vdf::Map(m) => m
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key.as_bytes()))
                .map(|(_, v)| v),
            _ => None,
        }
    }

    pub fn str(&self, key: &str) -> Option<String> {
        match self.get(key)? {
            Vdf::Str(s) => Some(String::from_utf8_lossy(s).into_owned()),
            _ => None,
        }
    }

    pub fn int(&self, key: &str) -> Option<u32> {
        match self.get(key)? {
            Vdf::Int(n) => Some(*n),
            _ => None,
        }
    }
}

/// The top level of a binary VDF file.
pub type Top = Vec<(Vec<u8>, Vdf)>;

struct Reader<'a> {
    b: &'a [u8],
    at: usize,
}

const ENDS_EARLY: &str = "shortcuts.vdf ends early";

impl Reader<'_> {
    fn byte(&mut self) -> Result<u8, String> {
        let v = *self.b.get(self.at).ok_or(ENDS_EARLY)?;
        self.at += 1;
        Ok(v)
    }

    fn cstr(&mut self) -> Result<Vec<u8>, String> {
        let rest = &self.b[self.at..];
        let end = rest
            .iter()
            .position(|&c| c == 0)
            .ok_or("shortcuts.vdf ends inside a name")?;
        self.at += end + 1;
        Ok(rest[..end].to_vec())
    }

    fn take(&mut self, n: usize) -> Result<Vec<u8>, String> {
        let v = self.b.get(self.at..self.at + n).ok_or(ENDS_EARLY)?.to_vec();
        self.at += n;
        Ok(v)
    }

    fn map(&mut self, depth: usize) -> Result<Top, String> {
        if depth > 32 {
            return Err("shortcuts.vdf is nested too deep".into());
        }
        let mut m = vec![];
        loop {
            let t = match self.b.get(self.at) {
                None if depth == 0 => return Ok(m),
                None => return Err(ENDS_EARLY.into()),
                Some(_) => self.byte()?,
            };
            if t == 0x08 {
                return Ok(m);
            }
            let k = self.cstr()?;
            let v = match t {
                0x00 => Vdf::Map(self.map(depth + 1)?),
                0x01 => Vdf::Str(self.cstr()?),
                0x02 => {
                    let b = self.take(4)?;
                    Vdf::Int(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
                }
                0x03 | 0x04 | 0x06 => Vdf::Raw(t, self.take(4)?),
                0x07 | 0x0a => Vdf::Raw(t, self.take(8)?),
                other => {
                    return Err(format!(
                        "shortcuts.vdf has a value of a type Atlas does not know ({other})"
                    ))
                }
            };
            m.push((k, v));
        }
    }
}

/// Reads a binary VDF file: its top level.
pub fn parse(b: &[u8]) -> Result<Top, String> {
    Reader { b, at: 0 }.map(0)
}

fn put(out: &mut Vec<u8>, m: &[(Vec<u8>, Vdf)]) {
    for (k, v) in m {
        let (t, body): (u8, Vec<u8>) = match v {
            Vdf::Map(inner) => {
                let mut b = vec![];
                put(&mut b, inner);
                b.push(0x08);
                (0x00, b)
            }
            Vdf::Str(s) => {
                let mut b = s.clone();
                b.push(0);
                (0x01, b)
            }
            Vdf::Int(n) => (0x02, n.to_le_bytes().to_vec()),
            Vdf::Raw(t, b) => (*t, b.clone()),
        };
        out.push(t);
        out.extend_from_slice(k);
        out.push(0);
        out.extend(body);
    }
}

/// Writes a binary VDF file's top level.
pub fn write(m: &[(Vec<u8>, Vdf)]) -> Vec<u8> {
    let mut out = vec![];
    put(&mut out, m);
    out.push(0x08);
    out
}

/// Steam's id of a non-Steam shortcut: the CRC32 of its program (as the
/// shortcut writes it, in quotes) and its name, with the top bit set. The
/// pictures of the grid folder are named by it.
pub fn shortcut_id(exe: &str, name: &str) -> u32 {
    let mut h = crc32fast::Hasher::new();
    h.update(exe.as_bytes());
    h.update(name.as_bytes());
    h.finalize() | 0x8000_0000
}

/// A path in quotes, as Steam writes a shortcut's program and folder.
pub fn quoted(p: &str) -> String {
    format!("\"{}\"", p.trim_matches('"'))
}

/// A non-Steam shortcut, as Atlas writes its own.
#[derive(Clone, Debug, PartialEq)]
pub struct Shortcut {
    pub name: String,
    /// The program, in quotes as Steam writes it.
    pub exe: String,
    /// Its folder, in quotes.
    pub start_dir: String,
    pub icon: String,
    pub appid: u32,
}

impl Shortcut {
    /// A shortcut to `program`, started in `start_dir`, its id worked out
    /// as Steam does.
    pub fn new(name: &str, program: &Path, start_dir: &Path, icon: &str) -> Shortcut {
        let exe = quoted(&program.display().to_string());
        Shortcut {
            appid: shortcut_id(&exe, name),
            name: name.to_owned(),
            exe,
            start_dir: quoted(&start_dir.display().to_string()),
            icon: icon.to_owned(),
        }
    }

    /// As shortcuts.vdf has it, with the tag that marks it as `tag`'s.
    pub fn to_vdf(&self, tag: &str) -> Vdf {
        let s = |k: &str, v: &str| (k.as_bytes().to_vec(), Vdf::Str(v.as_bytes().to_vec()));
        let i = |k: &str, v: u32| (k.as_bytes().to_vec(), Vdf::Int(v));
        Vdf::Map(vec![
            i("appid", self.appid),
            s("AppName", &self.name),
            s("Exe", &self.exe),
            s("StartDir", &self.start_dir),
            s("icon", &self.icon),
            s("ShortcutPath", ""),
            s("LaunchOptions", ""),
            i("IsHidden", 0),
            i("AllowDesktopConfig", 1),
            i("AllowOverlay", 1),
            i("OpenVR", 0),
            i("Devkit", 0),
            s("DevkitGameID", ""),
            i("DevkitOverrideAppID", 0),
            i("LastPlayTime", 0),
            s("FlatpakAppID", ""),
            (
                b"tags".to_vec(),
                Vdf::Map(vec![(b"0".to_vec(), Vdf::Str(tag.as_bytes().to_vec()))]),
            ),
        ])
    }
}

/// Whether a shortcut of the file carries the tag `tag` (exactly).
pub fn is_tagged(v: &Vdf, tag: &str) -> bool {
    match v.get("tags") {
        Some(Vdf::Map(tags)) => tags
            .iter()
            .any(|(_, t)| matches!(t, Vdf::Str(s) if s == tag.as_bytes())),
        _ => false,
    }
}

/// The shortcuts of a shortcuts.vdf (the values of its "shortcuts" map).
pub fn shortcuts_of(top: &[(Vec<u8>, Vdf)]) -> Vec<Vdf> {
    top.iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(b"shortcuts"))
        .and_then(|(_, v)| match v {
            Vdf::Map(m) => Some(m.iter().map(|(_, v)| v.clone()).collect()),
            _ => None,
        })
        .unwrap_or_default()
}

/// The file with `list` as its shortcuts, numbered from 0, anything else in
/// it kept.
pub fn with_shortcuts(top: Top, list: Vec<Vdf>) -> Top {
    let mut new_top: Top = top
        .into_iter()
        .filter(|(k, _)| !k.eq_ignore_ascii_case(b"shortcuts"))
        .collect();
    new_top.insert(
        0,
        (
            b"shortcuts".to_vec(),
            Vdf::Map(
                list.into_iter()
                    .enumerate()
                    .map(|(i, v)| (i.to_string().into_bytes(), v))
                    .collect(),
            ),
        ),
    );
    new_top
}

// ------------------------------------------------------------ text VDF

/// A value of a text VDF file.
#[derive(Clone, Debug, PartialEq)]
pub enum Text {
    Str(String),
    Map(Vec<(String, Text)>),
}

impl Text {
    pub fn str(&self, key: &str) -> Option<String> {
        match self {
            Text::Map(m) => m.iter().find_map(|(k, v)| match v {
                Text::Str(s) if k.eq_ignore_ascii_case(key) => Some(s.clone()),
                _ => None,
            }),
            Text::Str(_) => None,
        }
    }
}

enum Token {
    Word(String),
    Open,
    Close,
}

fn tokens(text: &str) -> Vec<Token> {
    let mut out = vec![];
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                let mut s = String::new();
                while let Some(c) = chars.next() {
                    match c {
                        '\\' => match chars.next() {
                            Some('n') => s.push('\n'),
                            Some('t') => s.push('\t'),
                            Some(n) => s.push(n),
                            None => {}
                        },
                        '"' => break,
                        _ => s.push(c),
                    }
                }
                out.push(Token::Word(s));
            }
            '{' => out.push(Token::Open),
            '}' => out.push(Token::Close),
            // A comment, to the end of its line.
            '/' if chars.peek() == Some(&'/') => {
                for c in chars.by_ref() {
                    if c == '\n' {
                        break;
                    }
                }
            }
            // A condition (`[$WIN32]`): passed over.
            '[' => {
                for c in chars.by_ref() {
                    if c == ']' {
                        break;
                    }
                }
            }
            c if c.is_whitespace() => {}
            c => {
                let mut s = String::from(c);
                while let Some(&n) = chars.peek() {
                    if n.is_whitespace() || n == '"' || n == '{' || n == '}' {
                        break;
                    }
                    s.push(n);
                    chars.next();
                }
                out.push(Token::Word(s));
            }
        }
    }
    out
}

fn block(t: &[Token], at: &mut usize, depth: usize) -> Result<Vec<(String, Text)>, String> {
    if depth > 64 {
        return Err("the file is nested too deep".into());
    }
    let mut m = vec![];
    while *at < t.len() {
        match &t[*at] {
            Token::Close if depth > 0 => {
                *at += 1;
                return Ok(m);
            }
            Token::Close | Token::Open => {
                return Err("the file has a brace where a name should be".into())
            }
            Token::Word(k) => {
                *at += 1;
                match t.get(*at) {
                    Some(Token::Word(v)) => {
                        *at += 1;
                        m.push((k.clone(), Text::Str(v.clone())));
                    }
                    Some(Token::Open) => {
                        *at += 1;
                        m.push((k.clone(), Text::Map(block(t, at, depth + 1)?)));
                    }
                    _ => return Err(format!("{k} has no value")),
                }
            }
        }
    }
    if depth > 0 {
        return Err("the file ends inside a block".into());
    }
    Ok(m)
}

/// Reads a text VDF file: its top level.
pub fn parse_text(text: &str) -> Result<Vec<(String, Text)>, String> {
    block(&tokens(text), &mut 0, 0)
}
