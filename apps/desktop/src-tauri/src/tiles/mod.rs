//! "Download map images": copies a pack's tiles from the remote source its
//! layers name into a per-user overlay folder, politely and resumably.

pub mod download;
pub mod downscale;
pub mod manager;
pub mod pyramid;
pub mod status;
pub mod store;

pub use manager::DownloadManager;
