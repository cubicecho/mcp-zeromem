//! Calendar arithmetic in UTC, written by hand so neither the engine nor the
//! CLI pulls a date crate in for a timestamp field and a handful of phrases.

pub const DAY_MS: i64 = 86_400_000;

/// Days since 1970-01-01 for a proleptic Gregorian date.
pub fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (i64::from(m) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// The date `days` after 1970-01-01, as `(year, month, day)`.
pub fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

/// `2025-03-14T10:20:30.123Z` (or without fraction, or with a numeric
/// offset) to milliseconds since the epoch.
pub fn parse_rfc3339_ms(s: &str) -> Option<i64> {
    let s = s.trim();
    let (date, rest) = s.split_once(['T', 't', ' '])?;
    let mut d = date.split('-');
    let (y, m, day): (i64, u32, u32) = (d.next()?.parse().ok()?, d.next()?.parse().ok()?, d.next()?.parse().ok()?);
    let (time, offset) = match rest.find(['Z', 'z', '+', '-']) {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "Z"),
    };
    let mut t = time.split(':');
    let (h, min): (i64, i64) = (t.next()?.parse().ok()?, t.next()?.parse().ok()?);
    let sec_str = t.next().unwrap_or("0");
    let (sec, frac) = sec_str.split_once('.').unwrap_or((sec_str, ""));
    let sec: i64 = sec.parse().ok()?;
    let millis: i64 = if frac.is_empty() {
        0
    } else {
        let digits: String = frac.chars().filter(char::is_ascii_digit).take(3).collect();
        let padded = format!("{digits:0<3}");
        padded.parse().ok()?
    };
    let offset_min: i64 = match offset {
        "Z" | "z" => 0,
        _ => {
            let sign = if offset.starts_with('-') { -1 } else { 1 };
            let body = &offset[1..];
            let (oh, om) = body.split_once(':').unwrap_or((body.get(..2)?, body.get(2..).unwrap_or("0")));
            sign * (oh.parse::<i64>().ok()? * 60 + om.parse::<i64>().unwrap_or(0))
        }
    };
    let days = days_from_civil(y, m, day);
    Some(((days * 86_400 + h * 3_600 + min * 60 + sec - offset_min * 60) * 1_000) + millis)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dates() {
        assert_eq!(parse_rfc3339_ms("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_rfc3339_ms("2025-03-14T10:20:30.123Z"), Some(1_741_947_630_123));
        assert_eq!(parse_rfc3339_ms("2025-03-14T10:20:30+02:00"), Some(1_741_947_630_000 - 7_200_000));
        assert_eq!(parse_rfc3339_ms("nope"), None);
    }

    #[test]
    fn days_round_trip() {
        assert_eq!(civil_from_days(0), (1970, 1, 1));
        assert_eq!(civil_from_days(days_from_civil(2024, 2, 29)), (2024, 2, 29));
        for days in (-1_000..40_000).step_by(17) {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days);
        }
    }
}
