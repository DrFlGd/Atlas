//! Which cell each triangle goes in.
//!
//! By default ([`grid`]) the cells are a square grid over the model, each
//! triangle in the cell of its centre. A picture used all over the model is
//! then in the files of every cell it shows in, so a map of a few large
//! pictures shared by many cells holds them many times over.
//!
//! With textures kept once ([`crate::textures::TextureOptions::once`]),
//! [`by_picture`] puts each picture's triangles in one cell, so each picture
//! is in one file of each level, whatever the cells: the cells are those of
//! the grid and of coarser grids above it (each twice the side of the one
//! below), a picture going to the finest grid whose side its triangles'
//! centres fit in, in the cell of that grid that holds the middle of them.
//! A picture used in one house is in the cell of that house; one used all
//! over a town is in one cell as large as the town. A cell's bounds are its
//! square, grown to hold all its triangles, so cells of different grids
//! overlap, as the format allows: the 3D view chooses each cell's level by
//! its distance in its own sides, so a large cell is shown finely from
//! farther away. Triangles without a picture stay in the grid's cells.
//!
//! A cell whose pictures would come to more than [`PICTURE_CELL_BYTES`] or
//! whose triangles to more than [`PICTURE_CELL_TRIANGLES`] is shared out
//! among several cells of the same square (`<id>-1`, `<id>-2`, …), each
//! picture still in one of them. A picture shown by more triangles than one
//! cell may hold stays on the grid, in each cell it shows in.

use std::collections::{BTreeMap, HashMap};

/// The most bytes of pictures (as the finest level keeps them) one cell's
/// files hold when each picture is kept once: half a model file's 256 MB,
/// leaving room for the triangles.
pub const PICTURE_CELL_BYTES: u64 = 128 << 20;
/// The most triangles one cell holds when each picture is kept once.
pub const PICTURE_CELL_TRIANGLES: usize = 1_500_000;

/// A cell as the builder makes it: its id, its square (`[x0, y0, side]`),
/// and whether its bounds are the square itself (a grid's cell) or the
/// square grown to hold its triangles.
#[derive(Clone, Debug)]
pub struct Slot {
    pub id: String,
    pub square: [f64; 3],
    pub grows: bool,
}

/// A cell of one of the grids: the grid (0 the finest), its row and column.
type CellKey = (u32, usize, usize);
/// A picture in a cell: its bytes, its triangles and its image.
type Picture = (u64, usize, usize);

/// How many cells a grid of `side` has across and down over `low`..`high`.
pub fn grid_size(low: [f64; 3], high: [f64; 3], side: f64) -> (usize, usize) {
    (
        (((high[0] - low[0]) / side).floor() as usize + 1).max(1),
        (((high[1] - low[1]) / side).floor() as usize + 1).max(1),
    )
}

/// The cell of a grid of `side` (with `columns` and `rows`) that holds `point`.
fn grid_cell(
    point: [f64; 2],
    low: [f64; 3],
    side: f64,
    columns: usize,
    rows: usize,
) -> (usize, usize) {
    (
        (((point[0] - low[0]) / side).floor().max(0.0) as usize).min(columns - 1),
        (((point[1] - low[1]) / side).floor().max(0.0) as usize).min(rows - 1),
    )
}

/// The grid: every cell of it (`cy * columns + cx`), and each triangle's.
pub fn grid(
    centres: &[[f64; 2]],
    low: [f64; 3],
    high: [f64; 3],
    side: f64,
) -> (Vec<Slot>, Vec<u32>) {
    let (columns, rows) = grid_size(low, high, side);
    let slots = (0..rows)
        .flat_map(|cy| (0..columns).map(move |cx| (cx, cy)))
        .map(|(cx, cy)| Slot {
            id: format!("c{cx}-{cy}"),
            square: [low[0] + cx as f64 * side, low[1] + cy as f64 * side, side],
            grows: false,
        })
        .collect();
    let cell_of = centres
        .iter()
        .map(|&c| {
            let (cx, cy) = grid_cell(c, low, side, columns, rows);
            (cy * columns + cx) as u32
        })
        .collect();
    (slots, cell_of)
}

/// Each picture's triangles in one cell (see the module's description):
/// the cells and each triangle's. `picture_of[t]` is triangle `t`'s picture
/// and its bytes, if it has one. `None` when that would make more than
/// `max_cells` cells.
pub fn by_picture(
    centres: &[[f64; 2]],
    picture_of: &[Option<(usize, u64)>],
    low: [f64; 3],
    high: [f64; 3],
    side: f64,
    max_cells: usize,
) -> Option<(Vec<Slot>, Vec<u32>)> {
    // Where each picture's triangles are: their centres' box and how many.
    struct Spread {
        low: [f64; 2],
        high: [f64; 2],
        triangles: usize,
        bytes: u64,
    }
    let mut spread: HashMap<usize, Spread> = HashMap::new();
    for (t, picture) in picture_of.iter().enumerate() {
        let Some((image, bytes)) = *picture else {
            continue;
        };
        let c = centres[t];
        let entry = spread.entry(image).or_insert(Spread {
            low: c,
            high: c,
            triangles: 0,
            bytes,
        });
        for k in 0..2 {
            entry.low[k] = entry.low[k].min(c[k]);
            entry.high[k] = entry.high[k].max(c[k]);
        }
        entry.triangles += 1;
    }
    // Each picture's grid (0 the finest, each above twice the side) and cell
    // there; `None` for a picture that stays on the finest grid.
    let extent = (high[0] - low[0]).max(high[1] - low[1]);
    let mut home: HashMap<usize, Option<(u32, usize, usize)>> = HashMap::new();
    // Per cell (grid, cy, cx): its pictures, largest first, and its triangles without one.
    let mut cells: BTreeMap<CellKey, (Vec<Picture>, usize)> = BTreeMap::new();
    let mut images: Vec<usize> = spread.keys().copied().collect();
    images.sort_unstable();
    for image in images {
        let s = &spread[&image];
        if s.triangles > PICTURE_CELL_TRIANGLES {
            home.insert(image, None);
            continue;
        }
        let wide = (s.high[0] - s.low[0]).max(s.high[1] - s.low[1]);
        let mut level = 0u32;
        while side * f64::from(1u32 << level) < wide
            && side * f64::from(1u32 << level) < extent
            && level < 20
        {
            level += 1;
        }
        let level_side = side * f64::from(1u32 << level);
        let (columns, rows) = grid_size(low, high, level_side);
        let middle = [(s.low[0] + s.high[0]) / 2.0, (s.low[1] + s.high[1]) / 2.0];
        let (cx, cy) = grid_cell(middle, low, level_side, columns, rows);
        home.insert(image, Some((level, cx, cy)));
        cells
            .entry((level, cy, cx))
            .or_default()
            .0
            .push((s.bytes, s.triangles, image));
    }
    let (columns, rows) = grid_size(low, high, side);
    for (t, picture) in picture_of.iter().enumerate() {
        let stays = match picture {
            None => true,
            Some((image, _)) => home[image].is_none(),
        };
        if stays {
            let (cx, cy) = grid_cell(centres[t], low, side, columns, rows);
            cells.entry((0, cy, cx)).or_default().1 += 1;
        }
    }
    // Shared out when heavy: each picture in the first share it fits in.
    let mut slots: Vec<Slot> = Vec::new();
    let mut slot_of_picture: HashMap<usize, u32> = HashMap::new();
    let mut slot_of_cell: HashMap<CellKey, u32> = HashMap::new();
    for (&(level, cy, cx), (pictures, plain)) in cells.iter_mut() {
        pictures.sort_by(|a, b| b.0.cmp(&a.0).then(a.2.cmp(&b.2)));
        let mut shares: Vec<(u64, usize)> = vec![(0, *plain)];
        let mut share_of: Vec<(usize, usize)> = Vec::new();
        for &(bytes, triangles, image) in pictures.iter() {
            let fits = shares.iter().position(|&(b, t)| {
                (b == 0 && t == 0)
                    || (b + bytes <= PICTURE_CELL_BYTES && t + triangles <= PICTURE_CELL_TRIANGLES)
            });
            let share = fits.unwrap_or_else(|| {
                shares.push((0, 0));
                shares.len() - 1
            });
            shares[share].0 += bytes;
            shares[share].1 += triangles;
            share_of.push((image, share));
        }
        let level_side = side * f64::from(1u32 << level);
        let base = if level == 0 {
            format!("c{cx}-{cy}")
        } else {
            format!("t{level}-{cx}-{cy}")
        };
        let first = slots.len() as u32;
        for share in 0..shares.len() {
            slots.push(Slot {
                id: if share == 0 {
                    base.clone()
                } else {
                    format!("{base}-{share}")
                },
                square: [
                    low[0] + cx as f64 * level_side,
                    low[1] + cy as f64 * level_side,
                    level_side,
                ],
                grows: true,
            });
        }
        if slots.len() > max_cells {
            return None;
        }
        for (image, share) in share_of {
            slot_of_picture.insert(image, first + share as u32);
        }
        slot_of_cell.insert((level, cy, cx), first);
    }
    let cell_of = picture_of
        .iter()
        .enumerate()
        .map(
            |(t, picture)| match picture.and_then(|(image, _)| slot_of_picture.get(&image)) {
                Some(&slot) => slot,
                None => {
                    let (cx, cy) = grid_cell(centres[t], low, side, columns, rows);
                    slot_of_cell[&(0, cy, cx)]
                }
            },
        )
        .collect();
    Some((slots, cell_of))
}
