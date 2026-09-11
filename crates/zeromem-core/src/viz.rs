//! Read-only views of the store's structure for the admin UI: the entity
//! graph, the temporal hierarchy, a session's turns with their entity spans,
//! a 2-D projection of the vector space, and growth over time.
//!
//! Every read here is capped. A 50k-turn store must never be serialised
//! whole into a browser tab, so each snapshot takes a limit, clamps it, and
//! says when it was truncated.

use std::collections::{BTreeSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::dense;
use crate::entities::Mention;
use crate::error::Result;
use crate::store::Store;
use crate::timeline::Level;
use crate::types::{SessionSummary, Turn};

// --- entity graph ------------------------------------------------------------

pub const GRAPH_MAX_NODES: usize = 2000;
pub const GRAPH_MAX_HOPS: u32 = 3;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct GraphOptions {
    /// At most this many nodes; default 200, capped at [`GRAPH_MAX_NODES`].
    pub limit: Option<u32>,
    /// Drop edges seen in fewer turns than this; default 1.
    pub min_weight: Option<u32>,
    /// Start from this entity and expand `hops` steps instead of taking the
    /// most-mentioned entities overall.
    pub focus: Option<String>,
    /// Default 1, capped at [`GRAPH_MAX_HOPS`].
    pub hops: Option<u32>,
    /// Only entities of this kind (`name`, `date`, `quantity`).
    pub kind: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphNode {
    pub entity: String,
    pub kind: String,
    pub turns: u32,
    /// Edges touching this entity in the whole graph, not only the snapshot.
    pub degree: u32,
    pub first_ts: i64,
    pub last_ts: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphEdge {
    pub a: String,
    pub b: String,
    pub turns: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GraphSnapshot {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub total_entities: u64,
    pub total_edges: u64,
    /// The node cap cut the selection short.
    pub truncated: bool,
    pub generation: i64,
}

pub fn graph_snapshot(store: &Store, opts: &GraphOptions) -> Result<GraphSnapshot> {
    let limit = (opts.limit.unwrap_or(200) as usize).clamp(1, GRAPH_MAX_NODES);
    let min_weight = opts.min_weight.unwrap_or(1).max(1);
    let hops = opts.hops.unwrap_or(1).min(GRAPH_MAX_HOPS);

    let mut keys: Vec<String> = Vec::new();
    let mut truncated = false;
    match &opts.focus {
        Some(focus) => {
            // Breadth-first from the focus, most-shared neighbours first, so
            // the cap keeps the strongest part of the neighbourhood.
            let mut seen: BTreeSet<String> = BTreeSet::new();
            let mut queue: VecDeque<(String, u32)> = VecDeque::new();
            if store.entity_stat(focus)?.is_some() {
                seen.insert(focus.clone());
                keys.push(focus.clone());
                queue.push_back((focus.clone(), 0));
            }
            'bfs: while let Some((key, depth)) = queue.pop_front() {
                if depth >= hops {
                    continue;
                }
                for (other, weight) in store.neighbours(&key, limit)? {
                    if weight < min_weight || !seen.insert(other.clone()) {
                        continue;
                    }
                    if keys.len() >= limit {
                        truncated = true;
                        break 'bfs;
                    }
                    keys.push(other.clone());
                    queue.push_back((other, depth + 1));
                }
            }
        }
        None => {
            let stats = match &opts.kind {
                Some(kind) => store.top_entities_of_kind(kind, limit + 1)?,
                None => store.top_entities(limit + 1)?,
            };
            truncated = stats.len() > limit;
            keys.extend(stats.into_iter().take(limit).map(|s| s.entity));
        }
    }
    if let Some(kind) = &opts.kind {
        if opts.focus.is_some() {
            let mut kept = Vec::new();
            for key in keys {
                if store.entity_stat(&key)?.is_some_and(|s| &s.kind == kind) || Some(&key) == opts.focus.as_ref() {
                    kept.push(key);
                }
            }
            keys = kept;
        }
    }

    let in_set: BTreeSet<&String> = keys.iter().collect();
    let mut nodes = Vec::with_capacity(keys.len());
    let mut edges = Vec::new();
    for key in &keys {
        let Some(stat) = store.entity_stat(key)? else { continue };
        nodes.push(GraphNode {
            entity: stat.entity,
            kind: stat.kind,
            turns: stat.turns,
            degree: store.degree(key)?,
            first_ts: stat.first_ts,
            last_ts: stat.last_ts,
        });
        for (other, weight) in store.neighbours(key, GRAPH_MAX_NODES)? {
            // Each undirected edge once: from the lexically smaller end.
            if weight >= min_weight && key < &other && in_set.contains(&other) {
                edges.push(GraphEdge { a: key.clone(), b: other, turns: weight });
            }
        }
    }
    edges.sort_by(|x, y| y.turns.cmp(&x.turns).then_with(|| (&x.a, &x.b).cmp(&(&y.a, &y.b))));
    Ok(GraphSnapshot {
        nodes,
        edges,
        total_entities: store.count_entities()?,
        total_edges: store.count_edges()?,
        truncated,
        generation: store.generation()?,
    })
}

// --- temporal hierarchy -------------------------------------------------------

pub const HIERARCHY_MAX_SESSIONS: usize = 500;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct HierarchyOptions {
    /// Sessions per page; default 50, capped at [`HIERARCHY_MAX_SESSIONS`].
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    /// Only sessions active at or after this (ms).
    pub since: Option<i64>,
    /// Only sessions active at or before this (ms).
    pub until: Option<i64>,
    /// Just this one session.
    pub session: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HierarchySegment {
    pub start_ts: i64,
    pub end_ts: i64,
    pub first_turn_id: i64,
    pub last_turn_id: i64,
    pub turns: u32,
    pub entities: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HierarchySession {
    pub session_id: String,
    pub turns: u32,
    pub first_ts: i64,
    pub last_ts: i64,
    pub windows: Vec<HierarchySegment>,
    pub episodes: Vec<HierarchySegment>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HierarchySnapshot {
    pub sessions: Vec<HierarchySession>,
    /// Sessions matching the range, before paging.
    pub total_sessions: u64,
    pub generation: i64,
}

pub fn hierarchy(store: &Store, opts: &HierarchyOptions) -> Result<HierarchySnapshot> {
    let limit = (opts.limit.unwrap_or(50) as usize).clamp(1, HIERARCHY_MAX_SESSIONS) as u32;
    let offset = opts.offset.unwrap_or(0);
    let (summaries, total): (Vec<SessionSummary>, u64) = match &opts.session {
        Some(id) => {
            let one: Vec<SessionSummary> = store.session(id)?.into_iter().collect();
            let n = one.len() as u64;
            (one, n)
        }
        None => (
            store.list_sessions_between(opts.since, opts.until, limit, offset)?,
            store.count_sessions_between(opts.since, opts.until)?,
        ),
    };
    let segments = |session_id: &str, level: Level| -> Result<Vec<HierarchySegment>> {
        Ok(store
            .segments(session_id, level)?
            .into_iter()
            .map(|s| HierarchySegment {
                start_ts: s.start_ts,
                end_ts: s.end_ts,
                first_turn_id: s.first_turn_id,
                last_turn_id: s.last_turn_id,
                turns: s.turns,
                entities: s.entities,
            })
            .collect())
    };
    let mut sessions = Vec::with_capacity(summaries.len());
    for s in summaries {
        sessions.push(HierarchySession {
            windows: segments(&s.session_id, Level::Window)?,
            episodes: segments(&s.session_id, Level::Episode)?,
            session_id: s.session_id,
            turns: s.turns,
            first_ts: s.first_ts,
            last_ts: s.last_ts,
        });
    }
    Ok(HierarchySnapshot { sessions, total_sessions: total, generation: store.generation()? })
}

// --- a session's turns with entity spans ---------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TurnWithEntities {
    #[serde(flatten)]
    pub turn: Turn,
    pub entities: Vec<Mention>,
}

pub fn session_turns_with_entities(
    store: &Store,
    session_id: &str,
    limit: u32,
    offset: u32,
) -> Result<Vec<TurnWithEntities>> {
    let mut out = Vec::new();
    for turn in store.session_turns(session_id, limit, offset)? {
        let entities = store.mentions(turn.id)?;
        out.push(TurnWithEntities { turn, entities });
    }
    Ok(out)
}

// --- 2-D projection of the vector space ----------------------------------------

pub const PROJECTION_MAX_POINTS: usize = 10_000;
/// How much of a turn's text a point carries, for hover labels.
pub const POINT_TEXT_CHARS: usize = 160;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProjectionOptions {
    /// At most this many points; default 2000, capped at
    /// [`PROJECTION_MAX_POINTS`]. The sample is every n-th turn, so it is
    /// the same for the same store.
    pub limit: Option<u32>,
    /// Only this session's turns.
    pub session: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Point2D {
    pub turn_id: i64,
    pub session_id: String,
    pub speaker: String,
    pub ts: i64,
    pub text: String,
    pub x: f64,
    pub y: f64,
}

/// The two principal axes of a sample, so a query can be dropped onto the
/// same plane later.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Basis {
    pub mean: Vec<f32>,
    pub axes: [Vec<f32>; 2],
    /// Fraction of the sample's variance each axis carries.
    pub variance_explained: [f64; 2],
}

/// A query dropped onto the plane, with its nearest turns in the full
/// vector space (not the plane: the plane loses most of the distance).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct QueryPoint {
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub neighbours: Vec<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Projection {
    pub points: Vec<Point2D>,
    pub basis: Basis,
    /// Set when the caller asked for a query overlay.
    pub query: Option<QueryPoint>,
    pub embedder: String,
    /// Vectors in the population the sample was drawn from.
    pub total: u64,
    pub generation: i64,
}

/// A key that changes whenever the projection would: any write moves
/// `max_id`, a backfilled vector moves `embedded`, and a delete or an
/// embedder switch moves the generation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectionKey {
    pub generation: i64,
    pub max_id: i64,
    /// The highest embedding sequence the engine has loaded.
    pub embedded: i64,
    pub embedder: String,
    pub dim: usize,
    pub opts: ProjectionOptions,
}

pub fn projection(store: &Store, embedder: &str, dim: usize, opts: &ProjectionOptions) -> Result<Projection> {
    let limit = (opts.limit.unwrap_or(2000) as usize).clamp(1, PROJECTION_MAX_POINTS);
    let (sample, total) = store.embeddings_sample(embedder, dim, opts.session.as_deref(), limit)?;
    let basis = pca2(sample.iter().map(|(_, v)| v.as_slice()), dim);
    let ids: Vec<i64> = sample.iter().map(|(id, _)| *id).collect();
    let turns = store.turns_by_ids(&ids)?;
    let mut points = Vec::with_capacity(sample.len());
    for (id, vec) in &sample {
        let Some(turn) = turns.get(id) else { continue };
        let (x, y) = project(&basis, vec);
        points.push(Point2D {
            turn_id: *id,
            session_id: turn.session_id.clone(),
            speaker: turn.speaker.clone(),
            ts: turn.ts,
            text: truncate_chars(&turn.text, POINT_TEXT_CHARS),
            x,
            y,
        });
    }
    Ok(Projection {
        points,
        basis,
        query: None,
        embedder: embedder.to_string(),
        total,
        generation: store.generation()?,
    })
}

/// Drop a vector onto a projection's plane.
pub fn project(basis: &Basis, v: &[f32]) -> (f64, f64) {
    let centred: Vec<f32> = v.iter().zip(&basis.mean).map(|(a, m)| a - m).collect();
    (f64::from(dense::dot(&centred, &basis.axes[0])), f64::from(dense::dot(&centred, &basis.axes[1])))
}

fn truncate_chars(s: &str, n: usize) -> String {
    match s.char_indices().nth(n) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_string(),
    }
}

/// The first two principal components by power iteration with deflation:
/// deterministic (fixed start vector, fixed iteration count, sign pinned by
/// the largest component) and cheap at a few hundred dims. Every vector
/// must have length `dim`.
pub fn pca2<'a>(vectors: impl Iterator<Item = &'a [f32]> + Clone, dim: usize) -> Basis {
    let n = vectors.clone().count();
    let dim = dim.max(2);
    let mut mean = vec![0f32; dim];
    if n == 0 {
        return Basis { mean, axes: [unit(0, dim), unit(1, dim)], variance_explained: [0.0, 0.0] };
    }
    for v in vectors.clone() {
        for (m, x) in mean.iter_mut().zip(v) {
            *m += x;
        }
    }
    for m in &mut mean {
        *m /= n as f32;
    }
    // Covariance, upper triangle mirrored. n × dim² multiply-adds; at the
    // default sample and 384 dims that is a few hundred million, well
    // under a second.
    let mut cov = vec![0f64; dim * dim];
    let mut centred = vec![0f32; dim];
    for v in vectors {
        for ((c, x), m) in centred.iter_mut().zip(v).zip(&mean) {
            *c = x - m;
        }
        for i in 0..dim {
            let ci = f64::from(centred[i]);
            if ci == 0.0 {
                continue;
            }
            let row = &mut cov[i * dim..(i + 1) * dim];
            for (j, cj) in centred.iter().enumerate().skip(i) {
                row[j] += ci * f64::from(*cj);
            }
        }
    }
    for i in 0..dim {
        for j in (i + 1)..dim {
            cov[j * dim + i] = cov[i * dim + j];
        }
    }
    let scale = 1.0 / n as f64;
    for c in &mut cov {
        *c *= scale;
    }
    let total_variance: f64 = (0..dim).map(|i| cov[i * dim + i]).sum();

    let (axis0, var0) = power_iteration(&cov, dim);
    // Deflate: remove the first component's variance from the matrix.
    for i in 0..dim {
        for j in 0..dim {
            cov[i * dim + j] -= var0 * f64::from(axis0[i]) * f64::from(axis0[j]);
        }
    }
    let (axis1, var1) = power_iteration(&cov, dim);
    let explained = |v: f64| if total_variance > 0.0 { v / total_variance } else { 0.0 };
    Basis { mean, axes: [axis0, axis1], variance_explained: [explained(var0), explained(var1)] }
}

fn unit(i: usize, dim: usize) -> Vec<f32> {
    let mut v = vec![0f32; dim];
    v[i] = 1.0;
    v
}

/// Dominant eigenvector and eigenvalue of a symmetric `dim × dim` matrix.
fn power_iteration(m: &[f64], dim: usize) -> (Vec<f32>, f64) {
    let mut v: Vec<f64> = (0..dim).map(|i| 1.0 + (i as f64) * 1e-3).collect();
    normalise(&mut v);
    let mut lambda = 0.0;
    for _ in 0..200 {
        let mut next = vec![0f64; dim];
        for i in 0..dim {
            let row = &m[i * dim..(i + 1) * dim];
            next[i] = row.iter().zip(&v).map(|(a, b)| a * b).sum();
        }
        lambda = next.iter().zip(&v).map(|(a, b)| a * b).sum();
        let norm = next.iter().map(|x| x * x).sum::<f64>().sqrt();
        if norm == 0.0 {
            break;
        }
        for x in &mut next {
            *x /= norm;
        }
        let delta: f64 = next.iter().zip(&v).map(|(a, b)| (a - b).abs()).sum();
        v = next;
        if delta < 1e-9 {
            break;
        }
    }
    // Pin the sign so the same data always lands the same way round.
    let (idx, _) = v.iter().enumerate().fold((0, 0.0), |acc, (i, x)| if x.abs() > acc.1 { (i, x.abs()) } else { acc });
    if v[idx] < 0.0 {
        for x in &mut v {
            *x = -*x;
        }
    }
    (v.into_iter().map(|x| x as f32).collect(), lambda.max(0.0))
}

fn normalise(v: &mut [f64]) {
    let norm = v.iter().map(|x| x * x).sum::<f64>().sqrt();
    if norm > 0.0 {
        for x in v.iter_mut() {
            *x /= norm;
        }
    }
}

// --- growth over time ------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct GrowthDay {
    /// `YYYY-MM-DD`, UTC.
    pub day: String,
    pub turns: u32,
    pub sessions: u32,
    /// Turns in the store up to and including this day.
    pub cumulative_turns: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Growth {
    pub days: Vec<GrowthDay>,
    pub generation: i64,
}

pub fn growth(store: &Store, since: Option<i64>, until: Option<i64>) -> Result<Growth> {
    let mut cumulative = 0u64;
    let days = store
        .turns_per_day(since, until)?
        .into_iter()
        .map(|(day, turns, sessions)| {
            cumulative += u64::from(turns);
            GrowthDay { day, turns, sessions, cumulative_turns: cumulative }
        })
        .collect();
    Ok(Growth { days, generation: store.generation()? })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn basis_of(vectors: &[Vec<f32>]) -> Basis {
        let dim = vectors.first().map_or(dense::HASH_DIM, Vec::len);
        pca2(vectors.iter().map(|v| v.as_slice()), dim)
    }

    #[test]
    fn pca_finds_the_axis_the_data_varies_along() {
        // Points spread along dimension 3, with a little along 7.
        let vectors: Vec<Vec<f32>> = (0..20)
            .map(|i| {
                let mut v = vec![0f32; 16];
                v[3] = i as f32;
                v[7] = (i % 3) as f32 * 0.1;
                v
            })
            .collect();
        let basis = basis_of(&vectors);
        assert!(basis.axes[0][3].abs() > 0.99, "first axis is dimension 3: {:?}", &basis.axes[0][..8]);
        assert!(basis.axes[1][7].abs() > 0.99, "second axis is dimension 7");
        assert!(basis.variance_explained[0] > 0.99);
        // Sign is pinned positive on the largest component.
        assert!(basis.axes[0][3] > 0.0);
    }

    #[test]
    fn pca_is_deterministic() {
        let vectors: Vec<Vec<f32>> =
            (0..50).map(|i| dense::hash_embed(&format!("turn number {i} about things"))).collect();
        assert_eq!(basis_of(&vectors), basis_of(&vectors));
    }

    #[test]
    fn empty_sample_projects_to_the_first_two_dimensions() {
        let basis = basis_of(&[]);
        let mut v = vec![0f32; dense::HASH_DIM];
        v[0] = 2.0;
        v[1] = -1.0;
        assert_eq!(project(&basis, &v), (2.0, -1.0));
    }

    #[test]
    fn text_is_truncated_on_a_char_boundary() {
        assert_eq!(truncate_chars("héllo wörld", 5), "héllo…");
        assert_eq!(truncate_chars("short", 10), "short");
    }
}
