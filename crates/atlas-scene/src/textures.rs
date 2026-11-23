//! Textures of a model. Not built yet: this version keeps each material's
//! colour and vertex colours and leaves its textures out, counting them in
//! the report (`texturesLeftOut`), so a model made for this version is
//! plain but whole.
//!
//! Where they will go (a later version): the reader ([`crate::gltf`]) reads
//! each material's base colour texture and its `TEXCOORD_0`; the cells keep
//! the texture coordinates through simplification (as another weighted
//! attribute) and the welding key; this module turns each texture into KTX2
//! with Basis Universal (`KHR_texture_basisu`, which Atlas reads), at most
//! [`TextureOptions::max_size`] pixels a side, with smaller copies for the
//! coarser levels; and the writer ([`crate::glb`]) stores it in each file
//! that uses it. The budgets of the 3D view count texture bytes already.

use serde::Deserialize;

use crate::gltf::Model;

/// What to do with a model's textures.
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TextureMode {
    /// Leave them out; keep each material's colour. The only choice for now.
    #[default]
    LeaveOut,
}

/// How textures are to be made, once they are.
#[derive(Clone, Copy, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextureOptions {
    #[serde(default)]
    pub mode: TextureMode,
    /// The longest side of a texture, in pixels (for later).
    #[serde(default)]
    pub max_size: Option<u32>,
}

/// The materials with a texture, which this version leaves out.
pub fn left_out(model: &Model) -> usize {
    model.materials.iter().filter(|m| m.textured).count()
}
