//! How the HTTP server makes itself discoverable on the local network.
//!
//! Stored in `meta.discovery_config` so the admin UI can change it. The
//! engine only keeps it: the HTTP server reads it and starts or stops its
//! mDNS announcement to match.

use serde::{Deserialize, Serialize};

use crate::error::Result;
use crate::store::Store;

/// The `meta` key the settings are stored under, as JSON.
const META_KEY: &str = "discovery_config";

/// Whether the HTTP server announces itself on the LAN.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct DiscoveryConfig {
    /// Announce the server over mDNS as an `_mcp._tcp` service. Off unless
    /// someone turns it on: an announcement tells the whole network where
    /// the memory store is.
    pub lan_advertise: bool,
}

impl Store {
    /// The discovery settings as stored, or the defaults when none are.
    pub fn discovery_config(&self) -> Result<DiscoveryConfig> {
        Ok(match self.meta(META_KEY)? {
            Some(json) => serde_json::from_str(&json)?,
            None => DiscoveryConfig::default(),
        })
    }

    /// Replace the discovery settings.
    pub fn set_discovery_config(&mut self, config: &DiscoveryConfig) -> Result<()> {
        self.set_meta(META_KEY, &serde_json::to_string(config)?)
    }
}
