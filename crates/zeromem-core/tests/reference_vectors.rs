//! The model is what it says it is.
//!
//! A fixed set of sentences is embedded with the ONNX model and compared
//! with vectors committed in `tests/golden/reference_vectors.json`. Model
//! or tokenizer drift — a different download, a changed runtime — shows up
//! here rather than as a slow, silent decay in recall. The hash fallback
//! is checked the same way, and the two must never be confused for each
//! other.
//!
//! The model (~130 MB) is downloaded on first run into `target/models`, or
//! `ZEROMEM_MODELS` when set, so CI can cache it. Set `ZEROMEM_SKIP_ONNX=1`
//! to skip the model half offline; the skip is printed, never silent.

use std::fs;
use std::path::PathBuf;

use zeromem_core::dense::{self, Embedder, HASH_NAME, ONNX_NAME};

const SENTENCES: &[&str] = &[
    "Maya Okafor owns the billing service on Project Heron.",
    "Who is responsible for billing on Heron?",
    "The Basalt launch moved to March 14.",
    "Lunch was fine, nothing to report.",
    "Finance approved $230k for Quill this quarter.",
    "Kenji Morimoto is based in Osaka these days.",
];

fn golden_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/reference_vectors.json")
}

fn cache_dir() -> PathBuf {
    match std::env::var_os(dense::MODELS_ENV).filter(|v| !v.is_empty()) {
        Some(dir) => PathBuf::from(dir),
        None => PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/models"),
    }
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    dense::dot(a, b)
}

fn check(embedder: &mut dyn Embedder, golden: &serde_json::Value, tolerance: f32) -> Vec<Vec<f32>> {
    let vectors = embedder.embed(SENTENCES).unwrap();
    assert_eq!(vectors.len(), SENTENCES.len());
    for v in &vectors {
        assert_eq!(v.len(), embedder.dim());
        assert!((cosine(v, v) - 1.0).abs() < 1e-4, "vectors are unit length");
    }
    if std::env::var_os("UPDATE_GOLDEN").is_some() {
        return vectors;
    }
    let want =
        golden[embedder.name()].as_array().unwrap_or_else(|| panic!("no reference vectors for {}", embedder.name()));
    for (i, (got, want)) in vectors.iter().zip(want).enumerate() {
        let want: Vec<f32> = want.as_array().unwrap().iter().map(|x| x.as_f64().unwrap() as f32).collect();
        let sim = cosine(got, &want);
        assert!(sim > 1.0 - tolerance, "{}: sentence {i} drifted, cosine to reference {sim:.5}", embedder.name());
    }
    vectors
}

#[test]
fn embedders_match_their_reference_vectors() {
    let path = golden_path();
    let updating = std::env::var_os("UPDATE_GOLDEN").is_some();
    let golden: serde_json::Value = if updating {
        serde_json::json!({})
    } else {
        serde_json::from_str(&fs::read_to_string(&path).expect("tests/golden/reference_vectors.json")).unwrap()
    };
    let mut out = serde_json::Map::new();

    let mut hash = dense::HashEmbedder;
    let hash_vectors = check(&mut hash, &golden, 1e-5);
    out.insert(HASH_NAME.into(), serde_json::to_value(&hash_vectors).unwrap());

    if std::env::var_os("ZEROMEM_SKIP_ONNX").is_some() {
        eprintln!("ZEROMEM_SKIP_ONNX is set: the ONNX half of this test did not run");
    } else {
        let mut onnx = dense::open_onnx(&cache_dir()).expect("the ONNX model loads (downloaded on first run)");
        assert_eq!(onnx.name(), ONNX_NAME);
        assert!(!onnx.is_fallback());
        let vectors = check(onnx.as_mut(), &golden, 2e-3);
        // Meaning survives: a question about billing on Heron is closer to
        // the statement about it than to lunch, and the hash embedder does
        // not get to claim the same.
        let owner_vs_question = cosine(&vectors[0], &vectors[1]);
        let owner_vs_lunch = cosine(&vectors[0], &vectors[3]);
        assert!(owner_vs_question > owner_vs_lunch + 0.2, "{owner_vs_question} vs {owner_vs_lunch}");
        assert!(cosine(&vectors[0], &hash_vectors[0]).abs() < 0.5, "onnx and hash vectors are not interchangeable");
        out.insert(ONNX_NAME.into(), serde_json::to_value(&vectors).unwrap());
    }

    if updating {
        let mut merged = golden;
        if let Some(existing) =
            fs::read_to_string(&path).ok().and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        {
            merged = existing;
        }
        for (k, v) in out {
            merged[k] = v;
        }
        fs::write(&path, serde_json::to_string(&merged).unwrap() + "\n").unwrap();
    }
}
