//! The temporal hierarchy: session → window → episode.
//!
//! A window is a stretch of one session with no long silence in it. An
//! episode is a run of consecutive windows that keep talking about the same
//! things, measured by entity overlap. Both are a pure function of the
//! session's turns in time order, so a session is re-segmented whenever a
//! turn is added to it and the result never depends on arrival order.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// Silence longer than this starts a new window.
pub const WINDOW_GAP_MS: i64 = 30 * 60 * 1000;
/// A window never holds more turns than this, however dense the talk.
pub const WINDOW_MAX_TURNS: usize = 50;
/// Consecutive windows sharing at least this Jaccard overlap of entities
/// stay in one episode.
pub const EPISODE_MIN_OVERLAP: f64 = 0.15;
/// How many entity keys a segment summarises itself with.
pub const SEGMENT_ENTITIES: usize = 8;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum Level {
    Window,
    Episode,
}

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::Window => "window",
            Level::Episode => "episode",
        }
    }

    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "window" => Some(Level::Window),
            "episode" => Some(Level::Episode),
            _ => None,
        }
    }
}

/// One turn as the segmenter sees it.
#[derive(Debug, Clone)]
pub struct TurnRef {
    pub id: i64,
    pub ts: i64,
    pub entities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Segment {
    pub level: Level,
    pub start_ts: i64,
    pub end_ts: i64,
    pub first_turn_id: i64,
    pub last_turn_id: i64,
    pub turns: u32,
    /// Most frequent entity keys, most frequent first, ties alphabetical.
    pub entities: Vec<String>,
}

/// Segment one session. `turns` must be sorted by `(ts, id)`.
pub fn segment(turns: &[TurnRef]) -> Vec<Segment> {
    if turns.is_empty() {
        return Vec::new();
    }
    let mut windows: Vec<(usize, usize)> = Vec::new();
    let mut start = 0;
    for i in 1..turns.len() {
        let gap = turns[i].ts - turns[i - 1].ts;
        if gap > WINDOW_GAP_MS || i - start >= WINDOW_MAX_TURNS {
            windows.push((start, i));
            start = i;
        }
    }
    windows.push((start, turns.len()));

    let window_segments: Vec<Segment> = windows.iter().map(|&(a, b)| build(Level::Window, &turns[a..b])).collect();

    let mut episodes: Vec<(usize, usize)> = Vec::new();
    let mut start = 0;
    for i in 1..windows.len() {
        let prev = &window_segments[i - 1];
        let next = &window_segments[i];
        if jaccard(&prev.entities, &next.entities) < EPISODE_MIN_OVERLAP {
            episodes.push((start, i));
            start = i;
        }
    }
    episodes.push((start, windows.len()));
    let episode_segments = episodes.iter().map(|&(a, b)| {
        let turn_a = windows[a].0;
        let turn_b = windows[b - 1].1;
        build(Level::Episode, &turns[turn_a..turn_b])
    });

    window_segments.into_iter().chain(episode_segments).collect()
}

fn build(level: Level, turns: &[TurnRef]) -> Segment {
    let mut counts: BTreeMap<&str, u32> = BTreeMap::new();
    for t in turns {
        for e in &t.entities {
            *counts.entry(e.as_str()).or_default() += 1;
        }
    }
    let mut ranked: Vec<(&str, u32)> = counts.into_iter().collect();
    ranked.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    Segment {
        level,
        start_ts: turns[0].ts,
        end_ts: turns[turns.len() - 1].ts,
        first_turn_id: turns[0].id,
        last_turn_id: turns[turns.len() - 1].id,
        turns: turns.len() as u32,
        entities: ranked.into_iter().take(SEGMENT_ENTITIES).map(|(e, _)| e.to_string()).collect(),
    }
}

fn jaccard(a: &[String], b: &[String]) -> f64 {
    if a.is_empty() && b.is_empty() {
        // Two windows with no entities at all are chatter; keep them together.
        return 1.0;
    }
    let inter = a.iter().filter(|x| b.contains(x)).count();
    let union = a.len() + b.len() - inter;
    if union == 0 {
        1.0
    } else {
        inter as f64 / union as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn t(id: i64, ts_min: i64, ents: &[&str]) -> TurnRef {
        TurnRef { id, ts: ts_min * 60_000, entities: ents.iter().map(|s| s.to_string()).collect() }
    }

    #[test]
    fn a_gap_splits_windows_and_topic_change_splits_episodes() {
        let turns = vec![
            t(1, 0, &["heron", "maya"]),
            t(2, 1, &["heron"]),
            t(3, 45, &["heron", "maya"]), // 44 min gap: new window, same topic
            t(4, 46, &["heron"]),
            t(5, 120, &["basalt", "kenji"]), // new window, new topic
        ];
        let segs = segment(&turns);
        let windows: Vec<_> = segs.iter().filter(|s| s.level == Level::Window).collect();
        let episodes: Vec<_> = segs.iter().filter(|s| s.level == Level::Episode).collect();
        assert_eq!(windows.len(), 3);
        assert_eq!(episodes.len(), 2);
        assert_eq!((episodes[0].first_turn_id, episodes[0].last_turn_id, episodes[0].turns), (1, 4, 4));
        assert_eq!(episodes[1].first_turn_id, 5);
        assert_eq!(windows[0].entities, vec!["heron", "maya"]);
    }

    #[test]
    fn a_long_window_is_capped() {
        let turns: Vec<_> = (0..120).map(|i| t(i, i, &["x"])).collect();
        let windows = segment(&turns).into_iter().filter(|s| s.level == Level::Window).count();
        assert_eq!(windows, 3);
    }

    #[test]
    fn empty_input_yields_nothing() {
        assert!(segment(&[]).is_empty());
    }
}
