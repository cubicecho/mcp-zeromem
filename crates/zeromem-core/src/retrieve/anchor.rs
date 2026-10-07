//! Does a turn mention what the question names?
//!
//! A question that names something — a project, a person, a path — is about
//! that thing, and the views do not know it. They rank by words and
//! vectors, so in a store that never says who owns the search index on
//! Tidewater, the best match for that question is the owner of the search
//! index on some other project: every word but the one that matters.
//!
//! So a candidate that misses a name is scaled down ([`MISS_PENALTY`]),
//! which sorts the ranking, and the best turn left is then asked the same
//! thing. If it still misses a name, or mentions them all and matches
//! weakly ([`ABSTAIN_BELOW`]), recall says memory most likely does not hold
//! the answer ([`Abstained`]) and returns only the [`CLOSEST`] turns,
//! rather than five near misses a reader would take for an answer.
//!
//! A question that names nothing is never abstained on: its best score
//! alone separates the answerable from the unanswerable too poorly to act
//! on (an AUC of 0.80 on the large corpus).

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use super::calibrate::{Kept, Role};
use super::fuse::Fused;
use crate::entities::{self, EntityKind};
use crate::text;

/// What a candidate that mentions none of the question's names loses of its
/// fused score; one that mentions half of them loses half as much. Replayed
/// over the fused pools of the current-value questions under hash, recall@5
/// / MRR / nDCG@5: on the large corpus 0.856 / 0.952 / 0.783 at 0, 0.893 /
/// 0.968 / 0.818 at 0.2, 0.906 / 0.973 / 0.829 at 0.3 and 0.928 / 0.983 /
/// 0.846 at 0.5; on the transcript corpus 0.907 / 0.954 / 0.842, then 0.934
/// / 0.979 / 0.882, 0.943 / 0.983 / 0.891 and 0.958 / 0.987 / 0.901. It
/// stops at 0.3 because the corpora flatter it: every generated statement
/// names its project, and a real turn often leaves the name to the turns
/// around it.
pub const MISS_PENALTY: f64 = 0.3;
/// Under this, the best turn that mentions every name is not an answer.
/// With the penalty above, hash keeps 98% of answerable questions on the
/// large corpus and 99% on the transcript one while abstaining on 81% and
/// 89% of the unanswerable; the model keeps every answerable one and
/// abstains on 76% and 87%. At 0.55 hash on the large corpus gives up
/// another 2% of the answerable for 7% of the unanswerable.
pub const ABSTAIN_BELOW: f64 = 0.5;
/// How many turns an abstaining answer still carries. Not none: the check
/// reads names off the page, and a turn that leaves its subject to the
/// conversation around it should still reach the reader.
pub const CLOSEST: usize = 2;

/// Recall's own verdict that memory most likely does not hold the answer.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Abstained {
    /// What the question names that the best match does not mention. Empty
    /// when it mentions everything and only matches weakly.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub missing: Vec<String>,
    /// The best match's score.
    pub best: f64,
}

/// The entity keys a turn has to mention to be about this question: its
/// entities without dates, calendar words and quantities, which say when
/// and how much and not what, and without a key a longer one already holds
/// (`maya` beside `maya okafor`).
pub fn names(question: &str, entities: &[String]) -> Vec<String> {
    let measures: Vec<String> = entities::extract(question)
        .into_iter()
        .filter(|m| matches!(m.kind, EntityKind::Date | EntityKind::Quantity))
        .map(|m| m.key)
        .collect();
    let kept: Vec<&String> = entities
        .iter()
        .filter(|k| {
            !measures.contains(k)
                && !entities::is_calendar_word(k)
                && !k.chars().all(|c| c.is_ascii_digit() || c == '-')
        })
        .collect();
    let within = |short: &str, long: &str| {
        let long: Vec<&str> = long.split(' ').collect();
        let short: Vec<&str> = short.split(' ').collect();
        short.len() < long.len() && short.iter().all(|w| long.contains(w))
    };
    kept.iter().filter(|k| !kept.iter().any(|other| within(k, other))).map(|k| (*k).clone()).collect()
}

/// A turn's text, read once for every name asked of it.
pub struct Page {
    words: HashSet<String>,
    lower: String,
}

impl Page {
    pub fn new(text: &str) -> Self {
        Page {
            words: text::words(text).into_iter().map(|w| text::normalise(w.text)).collect(),
            lower: text.to_lowercase(),
        }
    }

    /// A path, symbol or env var has to appear as written. A name has to
    /// appear word for word, or by its last word alone when it has several:
    /// `project heron` is mentioned by `Heron's rollout`, and not by
    /// `Project Lantern`.
    pub fn mentions(&self, key: &str) -> bool {
        if key.contains(['_', '/', ':']) {
            return self.lower.contains(key);
        }
        let words: Vec<&str> = key.split(' ').collect();
        if words.iter().all(|w| self.words.contains(*w)) {
            return true;
        }
        let last = words[words.len() - 1];
        words.len() > 1
            && last.chars().count() >= 3
            && !last.chars().all(|c| c.is_ascii_digit())
            && self.words.contains(last)
    }

    pub fn missing(&self, names: &[String]) -> Vec<String> {
        names.iter().filter(|n| !self.mentions(n)).cloned().collect()
    }

    /// The share of `names` mentioned; 1 when there are none to mention.
    pub fn share(&self, names: &[String]) -> f64 {
        if names.is_empty() {
            return 1.0;
        }
        (names.len() - self.missing(names).len()) as f64 / names.len() as f64
    }
}

/// What a candidate keeps of its score for mentioning `share` of the names.
pub fn factor(share: f64) -> f64 {
    1.0 - MISS_PENALTY * (1.0 - share)
}

/// Whether the answer led by `best` should be given as one. `text` is the
/// best turn's own; `best.anchor` may be higher than its text earns when it
/// replaced a turn that did name the subject, and then it stands.
pub fn verdict(names: &[String], best: &Fused, text: &str) -> Option<Abstained> {
    if names.is_empty() {
        return None;
    }
    let missing = if best.anchor < 1.0 { Page::new(text).missing(names) } else { Vec::new() };
    (!missing.is_empty() || best.score < ABSTAIN_BELOW).then_some(Abstained { missing, best: best.score })
}

/// Cut an abstaining answer down to the closest turns. None of them is a
/// primary answer: that is what abstaining means.
pub fn cut(kept: &mut Vec<Kept>) -> Vec<Kept> {
    let rest = kept.split_off(CLOSEST.min(kept.len()));
    for k in kept.iter_mut() {
        k.role = Role::Supporting;
    }
    rest
}

#[cfg(test)]
mod tests {
    use super::*;

    fn keys(ks: &[&str]) -> Vec<String> {
        ks.iter().map(|k| (*k).to_string()).collect()
    }

    #[test]
    fn names_leave_out_dates_and_keys_a_longer_one_holds() {
        let q = "In January 2025, what did Maya Okafor say about Heron on March 14?";
        let got = names(q, &keys(&["january", "maya okafor", "maya", "okafor", "heron", "03-14", "2025"]));
        assert_eq!(got, keys(&["maya okafor", "heron"]));
        assert_eq!(names("what changed?", &[]), Vec::<String>::new());
    }

    #[test]
    fn a_name_is_mentioned_by_its_words_or_its_last_word() {
        let page = Page::new("Heron's rollout slipped; see heron::billing_service::flush and Phase 3.");
        assert!(page.mentions("heron"));
        assert!(page.mentions("project heron"), "the last word of a longer name is enough");
        assert!(!Page::new("Project Lantern slipped.").mentions("project heron"));
        assert!(!page.mentions("phase 2"), "a number is not a name's last word");
        assert!(!Page::new("Chapter 12 of the io guide.").mentions("node io"), "nor is a two-letter word");
        assert!(page.mentions("heron::billing_service::flush"));
        assert!(!page.mentions("heron::billing_service::drain"));
        assert!(Page::new("We set HERON_QUEUE_URL yesterday.").mentions("heron_queue_url"));
    }

    #[test]
    fn share_and_factor() {
        let page = Page::new("Maya owns the importer on Atlas.");
        assert_eq!(page.share(&[]), 1.0);
        assert_eq!(page.share(&keys(&["atlas", "kenji sato"])), 0.5);
        assert_eq!(page.missing(&keys(&["atlas", "kenji sato"])), keys(&["kenji sato"]));
        assert_eq!(factor(1.0), 1.0);
        assert!((factor(0.0) - (1.0 - MISS_PENALTY)).abs() < 1e-12);
    }

    fn fused(score: f64, anchor: f64) -> Fused {
        Fused { id: 1, score, sources: Vec::new(), ts: 0, uuid: "u".into(), anchor }
    }

    #[test]
    fn the_verdict_needs_a_name_and_a_miss_or_a_weak_match() {
        let tidewater = keys(&["tidewater"]);
        let elsewhere = "Rafael owns the search index on Project Lantern.";
        assert_eq!(verdict(&[], &fused(0.1, 1.0), elsewhere), None, "nothing named, nothing to miss");
        assert_eq!(
            verdict(&tidewater, &fused(0.9, 0.0), elsewhere),
            Some(Abstained { missing: tidewater.clone(), best: 0.9 })
        );
        let there = "Tidewater standup moved to ten.";
        assert_eq!(verdict(&tidewater, &fused(0.4, 1.0), there), Some(Abstained { missing: Vec::new(), best: 0.4 }));
        assert_eq!(verdict(&tidewater, &fused(0.6, 1.0), there), None);
        // It replaced a turn that named Tidewater, so its own silence stands.
        assert_eq!(verdict(&tidewater, &fused(0.6, 1.0), "Moved it to Flagsmith."), None);
    }

    #[test]
    fn an_abstaining_answer_keeps_the_closest_as_support() {
        let k = |id| Kept { id, score: 0.5, confidence: 1.0, role: Role::Primary, sources: Vec::new() };
        let mut kept = vec![k(1), k(2), k(3)];
        let rest = cut(&mut kept);
        assert_eq!(
            kept.iter().map(|k| (k.id, k.role)).collect::<Vec<_>>(),
            [(1, Role::Supporting), (2, Role::Supporting)]
        );
        assert_eq!(rest.iter().map(|k| k.id).collect::<Vec<_>>(), [3]);
        let mut one = vec![k(1)];
        assert!(cut(&mut one).is_empty());
    }
}
