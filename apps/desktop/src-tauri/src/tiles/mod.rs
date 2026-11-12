//! Map images of packs whose layers name a remote source.
//!
//! Every build reads them: the tile maths (`pyramid`), the status files
//! (`status`), where the images go (`store`, `images`), so that images an
//! earlier version or another Atlas app downloaded are shown, counted and
//! deleted. Only a build with the `downloads` feature fetches them: "Download
//! map images" copies a pack's tiles from its remote source, politely and
//! resumably (`download`, `downscale`, `manager`), and measures how large
//! an imported map's picture is (`measure`).

#[cfg(feature = "downloads")]
pub mod download;
#[cfg(feature = "downloads")]
pub mod downscale;
pub mod images;
#[cfg(feature = "downloads")]
pub mod manager;
#[cfg(feature = "downloads")]
pub mod measure;
pub mod pyramid;
#[cfg(feature = "downloads")]
pub mod renumber;
pub mod status;
pub mod store;

#[cfg(feature = "downloads")]
pub use manager::DownloadManager;
