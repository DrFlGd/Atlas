//! Which games a title asked for by another program (`--show-game`) names:
//! the games whose own title is that title, whose pack file says the game
//! is shown under it, or that are under it in the person's titles
//! (`game-groups.json`, see `gamegroups.rs`). Titles are compared without
//! regard to case, to space around them and to runs of punctuation and
//! space inside them, so "ruined keep" and " Ruined-Keep! " are the same.
//!
//! What is found is a list of games in the Library's order, with the
//! titles that hold several of them; the web app picks the one shown last,
//! else the first, and within one title the source used last, which only
//! it knows (see `state/background.ts`).

use serde::Serialize;
use serde_json::Value;

use crate::{gamegroups, packs::is_valid_pack_id};

/// The longest title read from the person's titles, as the schema says.
const MAX_TITLE_CHARS: usize = 200;
/// The most titles and games of one title read.
const MAX_GROUPS: usize = 1000;
const MAX_MEMBERS: usize = 80;

/// A title tidied for comparing (see the module).
pub fn title_key(title: &str) -> String {
    title
        .split(|c: char| !c.is_alphanumeric())
        .filter(|word| !word.is_empty())
        .map(str::to_lowercase)
        .collect::<Vec<_>>()
        .join(" ")
}

/// One of the person's titles: several games shown as one.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Group {
    pub id: String,
    pub title: String,
    pub members: Vec<String>,
}

/// The person's titles, from the text of `game-groups.json`, read as
/// untrusted: a title that cannot be read is left out, not the file.
pub fn read_groups(text: &str) -> Vec<Group> {
    if text.len() > gamegroups::MAX_GAME_GROUPS_BYTES {
        return Vec::new();
    }
    let Ok(value) = serde_json::from_str::<Value>(text) else {
        return Vec::new();
    };
    if value.get("format").and_then(Value::as_str) != Some(gamegroups::FORMAT) {
        return Vec::new();
    }
    let Some(groups) = value.get("groups").and_then(Value::as_array) else {
        return Vec::new();
    };
    groups
        .iter()
        .take(MAX_GROUPS)
        .filter_map(|group| {
            let id = group.get("id")?.as_str()?;
            let title = group.get("title")?.as_str()?.trim();
            let id_ok = !id.is_empty()
                && id.len() <= 64
                && id
                    .chars()
                    .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
            if !id_ok || title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
                return None;
            }
            let members = group
                .get("members")?
                .as_array()?
                .iter()
                .take(MAX_MEMBERS)
                .filter_map(|member| member.get("gameId")?.as_str())
                .filter(|id| is_valid_pack_id(id))
                .map(str::to_owned)
                .collect();
            Some(Group {
                id: id.to_owned(),
                title: title.to_owned(),
                members,
            })
        })
        .collect()
}

/// A game the Library lists, as far as a title is concerned.
#[derive(Clone, Copy, Debug)]
pub struct Listed<'a> {
    pub id: &'a str,
    pub title: &'a str,
    /// The title its pack file says it is shown under, if it is read from one.
    pub game_title: Option<&'a str>,
}

/// A title that holds several of the games found.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FoundGroup {
    pub id: String,
    /// Its games that were found, in its own order.
    pub members: Vec<String>,
}

/// The games a title names (see the module).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Found {
    /// In the Library's order.
    pub packs: Vec<String>,
    pub groups: Vec<FoundGroup>,
}

/// The games of the Library that `asked` names, with the person's titles.
pub fn find(asked: &str, listed: &[Listed<'_>], groups: &[Group]) -> Found {
    let key = title_key(asked);
    if key.is_empty() {
        return Found::default();
    }
    let named_groups: Vec<&Group> = groups
        .iter()
        .filter(|group| title_key(&group.title) == key)
        .collect();
    let packs: Vec<String> = listed
        .iter()
        .filter(|pack| {
            title_key(pack.title) == key
                || pack.game_title.is_some_and(|title| title_key(title) == key)
                || named_groups
                    .iter()
                    .any(|group| group.members.iter().any(|id| id == pack.id))
        })
        .map(|pack| pack.id.to_owned())
        .collect();
    let groups = groups
        .iter()
        .filter_map(|group| {
            let members: Vec<String> = group
                .members
                .iter()
                .filter(|id| packs.contains(id))
                .cloned()
                .collect();
            (members.len() > 1).then(|| FoundGroup {
                id: group.id.clone(),
                members,
            })
        })
        .collect();
    Found { packs, groups }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn listed<'a>(id: &'a str, title: &'a str, game_title: Option<&'a str>) -> Listed<'a> {
        Listed {
            id,
            title,
            game_title,
        }
    }

    #[test]
    fn tidies_titles() {
        assert_eq!(title_key("  Ruined Keep  "), "ruined keep");
        assert_eq!(
            title_key("Ruined-Keep: The  Return!"),
            "ruined keep the return"
        );
        assert_eq!(title_key("RUINED   KEEP"), title_key("ruined keep"));
        assert_eq!(title_key("Ölberg Höhle"), "ölberg höhle");
        assert_eq!(title_key("?!  --"), "");
    }

    #[test]
    fn finds_the_games_a_title_names() {
        let games = [
            listed("keep-a", "Ruined Keep", None),
            listed("valley", "Test Valley", None),
            listed("keep-wiki", "Keep wiki", Some("Ruined Keep")),
            listed("keep-b", "ruined keep", None),
            listed("keep-map", "Keep map", None),
        ];
        let groups = read_groups(
            r#"{"format":"atlas-game-groups","version":1,"groups":[
                {"id":"g1","title":"Ruined Keep","members":[{"gameId":"keep-map"},{"gameId":"keep-a"},{"gameId":"gone"}]},
                {"id":"g2","title":"Other","members":[{"gameId":"valley"}]}
            ]}"#,
        );
        let found = find(" RUINED keep ", &games, &groups);
        assert_eq!(found.packs, ["keep-a", "keep-wiki", "keep-b", "keep-map"]);
        assert_eq!(
            found.groups,
            [FoundGroup {
                id: "g1".to_owned(),
                members: vec!["keep-map".to_owned(), "keep-a".to_owned()]
            }]
        );

        let found = find("test valley", &games, &groups);
        assert_eq!(found.packs, ["valley"]);
        assert!(found.groups.is_empty());

        // By a title of the person's only.
        assert_eq!(find("other", &games, &groups).packs, ["valley"]);
        // Nothing, and nothing for a title with no letters.
        assert_eq!(find("Ruined", &games, &groups), Found::default());
        assert_eq!(find("!!", &games, &groups), Found::default());
    }

    #[test]
    fn reads_the_titles_file_as_untrusted() {
        for bad in [
            "",
            "{}",
            r#"{"format":"other","groups":[{"id":"g","title":"T","members":[]}]}"#,
            r#"{"format":"atlas-game-groups","groups":{}}"#,
        ] {
            assert!(read_groups(bad).is_empty(), "{bad}");
        }
        let groups = read_groups(
            r#"{"format":"atlas-game-groups","version":1,"groups":[
                {"id":"Bad Id","title":"T","members":[]},
                {"id":"g","title":"   ","members":[]},
                {"id":"g2","title":"T","members":"none"},
                {"id":"g3","title":"Fine","members":[{"gameId":"ok"},{"gameId":"../x"},{"gameId":5},"x"]}
            ]}"#,
        );
        assert_eq!(
            groups,
            [Group {
                id: "g3".to_owned(),
                title: "Fine".to_owned(),
                members: vec!["ok".to_owned()]
            }]
        );
    }
}
