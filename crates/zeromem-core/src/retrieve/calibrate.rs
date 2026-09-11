//! From fused scores to something a caller can act on: a confidence
//! relative to the best answer, a role, and a cut below which nothing is
//! returned however many were asked for.

use serde::{Deserialize, Serialize};

use super::fuse::{round6, Fused};
use super::route::ViewKind;
use super::Dropped;

/// Below this fraction of the best score a candidate is noise.
pub const DROP_BELOW: f64 = 0.35;
/// At or above this fraction it is a primary answer rather than support.
pub const PRIMARY_AT: f64 = 0.7;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Role {
    Primary,
    Supporting,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Kept {
    pub id: i64,
    pub score: f64,
    pub confidence: f64,
    pub role: Role,
    pub sources: Vec<ViewKind>,
}

#[derive(Debug, Default, PartialEq)]
pub struct Calibrated {
    pub kept: Vec<Kept>,
    pub dropped: Vec<Dropped>,
}

pub fn calibrate(fused: &[Fused], top_k: usize) -> Calibrated {
    let Some(best) = fused.first().map(|f| f.score).filter(|s| *s > 0.0) else {
        return Calibrated::default();
    };
    let mut out = Calibrated::default();
    for (i, f) in fused.iter().enumerate() {
        let confidence = round6(f.score / best);
        if i >= top_k {
            out.dropped.push(Dropped { id: f.id, score: f.score, reason: format!("beyond top_k={top_k}") });
        } else if confidence < DROP_BELOW {
            out.dropped.push(Dropped {
                id: f.id,
                score: f.score,
                reason: format!("confidence {confidence:.3} below {DROP_BELOW}"),
            });
        } else {
            let role = if confidence >= PRIMARY_AT { Role::Primary } else { Role::Supporting };
            out.kept.push(Kept { id: f.id, score: f.score, confidence, role, sources: f.sources.clone() });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fused(id: i64, score: f64) -> Fused {
        Fused { id, score, sources: vec![ViewKind::Lexical], ts: 0, uuid: format!("u{id}") }
    }

    #[test]
    fn roles_and_cut() {
        let c = calibrate(&[fused(1, 1.0), fused(2, 0.8), fused(3, 0.5), fused(4, 0.1)], 10);
        assert_eq!(
            c.kept.iter().map(|k| (k.id, k.role)).collect::<Vec<_>>(),
            vec![(1, Role::Primary), (2, Role::Primary), (3, Role::Supporting)]
        );
        assert_eq!(c.dropped.len(), 1);
        assert!(c.dropped[0].reason.contains("below"));
    }

    #[test]
    fn top_k_cuts_after_calibration() {
        let c = calibrate(&[fused(1, 1.0), fused(2, 0.9), fused(3, 0.9)], 2);
        assert_eq!(c.kept.len(), 2);
        assert_eq!(c.dropped[0].reason, "beyond top_k=2");
    }

    #[test]
    fn nothing_in_nothing_out() {
        assert_eq!(calibrate(&[], 5), Calibrated::default());
    }
}
