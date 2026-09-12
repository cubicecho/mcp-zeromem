//! Query-side entity resolution: a lowercase question reaches the entity
//! view.
//!
//! `entities::extract` reads shape, so it finds `Project Heron` in a
//! capitalised question and nothing at all in the same question typed the
//! way a user types one. `route::plan` then drops the entity view entirely,
//! which is the extraction analogue of mixing vectors from two embedders:
//! documents and questions have to produce keys in the same space or the
//! view silently returns nothing. Resolution closes that by looking the
//! question's n-grams up against the keys the store already holds.

mod common;

use common::*;
use zeromem_core::retrieve::{ViewKind, MAX_ENTITY_SHARE};
use zeromem_core::{QueryOptions, TurnInput, ZeroMem};

fn turn(uuid: &str, ts: i64, text: &str) -> TurnInput {
    TurnInput {
        session_id: "s".into(),
        speaker: "user".into(),
        text: text.into(),
        ts: Some(ts),
        uuid: Some(uuid.into()),
    }
}

fn entity_keys(zm: &mut ZeroMem, query: &str) -> Vec<String> {
    zm.query_trace(query, &QueryOptions::default()).unwrap().profile.entities
}

fn entity_candidates(zm: &mut ZeroMem, query: &str) -> usize {
    let trace = zm.query_trace(query, &QueryOptions::default()).unwrap();
    trace.views.iter().find(|v| v.view == ViewKind::Entity).map_or(0, |v| v.candidates.len())
}

#[test]
fn a_lowercase_question_resolves_to_the_keys_the_store_holds() {
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&[
        turn("a1", 1_000, "Maya Okafor owns the billing service on Project Heron."),
        turn("a2", 2_000, "Lunch was quiet today."),
    ])
    .unwrap();

    assert_eq!(entity_keys(&mut zm, "Who owns billing on Project Heron?"), vec!["project heron"]);
    // Same question, typed the way it is actually typed.
    assert_eq!(entity_keys(&mut zm, "who owns billing on project heron?"), vec!["project heron"]);
    assert!(entity_candidates(&mut zm, "who owns billing on project heron?") > 0);
    // Resolution is exact lookup in `name_key` space, so it recovers case
    // and nothing else: this store only ever wrote `Project Heron`, so the
    // bare `heron` a question might use still resolves to nothing. Bridging
    // that would be a substring match, which is a different decision.
    assert!(entity_keys(&mut zm, "who owns billing on heron?").is_empty());
}

#[test]
fn resolution_only_ever_adds_and_keeps_the_shape_rules_first() {
    let (_dir, mut zm) = open_temp();
    zm.ingest_many(&[turn("a1", 1_000, "Maya Okafor owns the billing service on Project Heron.")]).unwrap();
    // The shape rules already found `maya okafor`; resolution finds the
    // same key and must not append it a second time.
    let keys = entity_keys(&mut zm, "Does maya okafor still own project heron?");
    assert_eq!(keys.first().map(String::as_str), Some("maya okafor"), "{keys:?}");
    assert!(keys.contains(&"project heron".to_string()), "resolution has to add the lowercase one: {keys:?}");
    assert_eq!(keys.iter().filter(|k| *k == "maya okafor").count(), 1, "a shape-rule key must not be added twice");
}

#[test]
fn a_key_in_most_of_the_store_does_not_resolve() {
    let (_dir, mut zm) = open_temp();
    // `sparrow` in every turn, `heron` in one: the first narrows nothing
    // down, and it is keys like that — `see`, `todo` — the share cap is
    // there to keep out of a question's profile.
    let mut turns: Vec<TurnInput> =
        (0..10).map(|i| turn(&format!("s{i}"), 1_000 + i, "Sparrow shipped another quiet release today.")).collect();
    turns.push(turn("h", 2_000, "Heron is the one with the billing service."));
    zm.ingest_many(&turns).unwrap();

    let share = |key: &str| {
        let snap = zm.snapshot().unwrap();
        f64::from(snap.entities.iter().find(|e| e.entity == key).unwrap().turns) / snap.turns.len() as f64
    };
    assert!(share("sparrow") > MAX_ENTITY_SHARE, "fixture: sparrow has to be over the cap");
    assert!(share("heron") < MAX_ENTITY_SHARE, "fixture: heron has to be under it");

    assert!(entity_keys(&mut zm, "what did sparrow ship?").is_empty(), "sparrow is not discriminative");
    assert_eq!(entity_keys(&mut zm, "who owns billing on heron?"), vec!["heron"]);
}
