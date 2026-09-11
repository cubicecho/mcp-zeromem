//! A tiny seeded generator, so the fixtures do not change when a third-party
//! RNG crate changes its algorithm between versions.

/// SplitMix64. Good enough statistics for picking from short lists and
/// exactly one implementation forever.
#[derive(Debug, Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Rng(seed)
    }

    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform in `0..n`. `n` must be positive.
    pub fn below(&mut self, n: u64) -> u64 {
        assert!(n > 0, "Rng::below(0)");
        // Lemire's multiply-shift is overkill for lists of a few dozen; the
        // bias of a plain modulus at these sizes is well under 1e-15.
        self.next_u64() % n
    }

    /// Uniform in `lo..=hi`.
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.below(hi - lo + 1)
    }

    pub fn pick<'a, T>(&mut self, items: &'a [T]) -> &'a T {
        &items[self.below(items.len() as u64) as usize]
    }

    /// True with probability `p` (0..=1).
    pub fn chance(&mut self, p: f64) -> bool {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64 <= p
    }

    /// Fisher–Yates in place.
    pub fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            let j = self.below(i as u64 + 1) as usize;
            items.swap(i, j);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_stream() {
        let a: Vec<u64> = (0..8).map(|_| Rng::new(7).next_u64()).collect();
        let mut r1 = Rng::new(7);
        let mut r2 = Rng::new(7);
        for _ in 0..8 {
            assert_eq!(r1.next_u64(), r2.next_u64());
        }
        assert!(a.iter().all(|&x| x == a[0]), "a fresh rng always starts the same");
    }

    #[test]
    fn below_and_range_stay_in_bounds() {
        let mut r = Rng::new(1);
        for _ in 0..10_000 {
            assert!(r.below(7) < 7);
            let x = r.range(3, 5);
            assert!((3..=5).contains(&x));
        }
    }

    #[test]
    fn chance_is_roughly_calibrated() {
        let mut r = Rng::new(2);
        let hits = (0..20_000).filter(|_| r.chance(0.25)).count();
        assert!((4_500..5_500).contains(&hits), "{hits}");
    }
}
