//! Seeded dialogue with facts in it.
//!
//! A corpus is a set of sessions between a user and an assistant. The user
//! states facts about a small world — who owns which component of which
//! project, when milestones fall, where people are based, which tool a
//! project uses for what, what a project's budget is — restates some of them
//! later, and changes a few. Around those statements is chatter that names
//! the same people and projects but answers nothing, which is what makes the
//! retrieval problem hard rather than a string match.
//!
//! Every fact the generator writes it also records, so each labeled query
//! knows which turns state its current value (grade 2) and which state a
//! value that was later changed (grade 1). Nothing here is annotated by hand.
//!
//! Sessions are given ids, turns are given explicit uuids and millisecond
//! timestamps, and all of it is a pure function of the [`Profile`].

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::rng::Rng;

/// One turn, in the engine's JSONL ingest shape.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Turn {
    pub session_id: String,
    pub speaker: String,
    pub text: String,
    pub ts: i64,
    pub uuid: String,
}

/// A query and the turns that answer it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Query {
    pub id: String,
    /// Which fact family this asks about — `owner`, `date`, `location`, `tool` or `budget`.
    pub kind: String,
    pub query: String,
    /// The session the fact was most recently stated in. A recall that
    /// excludes the current session should still find earlier statements.
    pub latest_session_id: String,
    pub relevant: Vec<Relevance>,
    /// What the question wants. Left out for `current`, so the queries the
    /// floors were set on read as they always did.
    #[serde(default, skip_serializing_if = "Ask::is_current")]
    pub ask: Ask,
}

/// What a question wants of a fact. `queries.jsonl` holds only `current`;
/// the other three are the probes in `probes.jsonl`, which measure what
/// "the current value" cannot: whether recall can go back, and whether it
/// knows when it has nothing.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord, Hash)]
#[serde(rename_all = "snake_case")]
pub enum Ask {
    /// The value that holds now. Grade 2 states it, grade 1 an older one.
    #[default]
    Current,
    /// The value before the last change. Grade 2 states that one, grade 1
    /// any other, the current value included.
    History,
    /// The value in force during a named month. Grade 2 states it.
    AsOf,
    /// A fact the corpus never states. Nothing is relevant; the right
    /// answer is no answer.
    Abstain,
}

impl Ask {
    pub fn is_current(&self) -> bool {
        *self == Ask::Current
    }

    pub fn name(self) -> &'static str {
        match self {
            Ask::Current => "current",
            Ask::History => "history",
            Ask::AsOf => "as_of",
            Ask::Abstain => "abstain",
        }
    }
}

/// Graded relevance: 2 states the current value, 1 states a superseded one.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Relevance {
    pub uuid: String,
    pub grade: u8,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Corpus {
    pub turns: Vec<Turn>,
    pub queries: Vec<Query>,
    /// Questions about history, a point in time, and facts never stated.
    /// Kept apart from `queries` so everything measured on those — the
    /// floors, the goldens, the upstream comparison — is untouched by them.
    pub probes: Vec<Query>,
}

/// How the turns are written. The facts, the labels and the queries are the
/// same either way; only the surface form differs, which is the point — the
/// entity extractor reads shape, so the register it is handed decides how
/// much of it works.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Register {
    /// Tidy sentences with proper nouns capitalised, as a person writing
    /// notes for someone else. What the first two corpora are written in.
    Prose,
    /// What an agent's transcript actually looks like: mostly lowercase, with
    /// file paths, qualified symbols and env vars left as typed, and chatter
    /// that opens on a capital which is not a name.
    Transcript,
}

impl Register {
    /// Applied to every turn as it is emitted. Pure, so it adds no draw to
    /// the generator's stream.
    fn render(self, text: &str) -> String {
        match self {
            Register::Prose => text.to_string(),
            Register::Transcript => lowercase_prose(text, KEEP_CAPITAL_IN),
        }
    }

    /// Applied to every question. A user types their question lowercase even
    /// when the same user capitalised the name while stating the fact, and
    /// that asymmetry is the whole point of the transcript corpus.
    fn render_question(self, text: &str) -> String {
        match self {
            Register::Prose => text.to_string(),
            Register::Transcript => lowercase_prose(text, 0),
        }
    }
}

/// One in this many capitalised words keeps its capital in the transcript
/// register. Not zero, because a real session is not uniformly lowercase: a
/// name is typed `Maya` sometimes and `maya` the rest of the time, so the
/// store learns the key from the capitalised mentions and is then blind to
/// the lowercase ones. Not one, because that is just prose. Three leaves
/// roughly a third of each entity's mentions within reach of the shape
/// rules, which is the asymmetry the query side has to close.
const KEEP_CAPITAL_IN: u64 = 3;

/// Lowercase the prose and leave the technical tokens as written: anything
/// holding a `/`, `_` or `:`, and anything with an inner capital or a digit,
/// is how it was typed. So `Maya Okafor` flattens to `maya okafor` while
/// `server/src/engine/embed-worker.ts`, `ZEROMEM_EMBEDDING_URL`,
/// `retrieve::hand_over`, `TODO:` and `$230k` survive intact.
fn lowercase_prose(text: &str, keep_capital_in: u64) -> String {
    let mut out: Vec<String> = Vec::new();
    for (i, word) in text.split(' ').enumerate() {
        let technical =
            word.contains(['/', '_', ':']) || word.chars().skip(1).any(|c| c.is_uppercase() || c.is_ascii_digit());
        let capitalised = word.starts_with(char::is_uppercase);
        if technical || (capitalised && keeps_capital(word, i, keep_capital_in)) {
            out.push(word.to_string());
        } else {
            out.push(word.to_lowercase());
        }
    }
    out.join(" ")
}

/// A pure, stable coin: the same word in the same position of a turn is
/// always cased the same way, so the corpus stays a function of the seed
/// alone and this takes no draw from the generator's stream. FNV-1a over
/// the lowercased word and its position.
fn keeps_capital(word: &str, position: usize, keep_capital_in: u64) -> bool {
    if keep_capital_in == 0 {
        return false;
    }
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in word.to_lowercase().bytes().chain(position.to_le_bytes()) {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h % keep_capital_in == 0
}

/// What to generate. Three are committed; see [`SMALL`], [`LARGE`] and
/// [`TRANSCRIPT`].
#[derive(Debug, Clone, Copy)]
pub struct Profile {
    pub name: &'static str,
    pub seed: u64,
    pub sessions: usize,
    /// Inclusive bounds on the number of fact statements per session.
    pub facts_per_session: (u64, u64),
    pub register: Register,
}

/// ~50 turns: enough for a golden snapshot a human can read.
pub const SMALL: Profile = Profile {
    name: "small",
    seed: 0x5EED_0000_0001,
    sessions: 5,
    facts_per_session: (2, 4),
    register: Register::Prose,
};

/// ~5k turns across a few hundred sessions: enough that the graph, the
/// timeline and the lexical index all have real structure to get wrong.
pub const LARGE: Profile = Profile {
    name: "large",
    seed: 0x5EED_0000_0002,
    sessions: 325,
    facts_per_session: (3, 7),
    register: Register::Prose,
};

/// The same world in the register an agent's memory is actually written in.
/// Sized like `LARGE` so the two are comparable row by row on the Eval page:
/// the gap between them is what the extractor loses to case.
pub const TRANSCRIPT: Profile = Profile {
    name: "transcript",
    seed: 0x5EED_0000_0003,
    sessions: 325,
    facts_per_session: (3, 7),
    register: Register::Transcript,
};

pub const PROFILES: &[Profile] = &[SMALL, LARGE, TRANSCRIPT];

pub fn generate(profile: &Profile) -> Corpus {
    Generator::new(profile).run()
}

// --- the world -------------------------------------------------------------

const PEOPLE: &[&str] = &[
    "Maya Okafor",
    "Tomasz Wierzbicki",
    "Priya Raghunathan",
    "Diego Salcedo",
    "Ingrid Halvorsen",
    "Kenji Morimoto",
    "Amara Nwosu",
    "Luca Ferrante",
    "Sofia Lindqvist",
    "Rafael Ibarra",
    "Chidi Anyanwu",
    "Noor Haddad",
    "Elias Brandt",
    "Yuki Tanaka",
    "Fatima Zahra",
    "Oskar Vidal",
    "Leila Farahani",
    "Mateo Quiroga",
    "Hana Petrova",
    "Samuel Adeyemi",
    "Beatriz Moura",
    "Arjun Menon",
    "Greta Solberg",
    "Idris Bello",
];

const PROJECTS: &[&str] = &[
    "Heron",
    "Basalt",
    "Lantern",
    "Quill",
    "Meridian",
    "Cobalt",
    "Tidewater",
    "Sparrow",
    "Obsidian",
    "Juniper",
    "Halcyon",
    "Ferrous",
];

const COMPONENTS: &[&str] = &[
    "billing service",
    "auth gateway",
    "ingest pipeline",
    "search index",
    "notification worker",
    "admin console",
    "mobile client",
    "reporting layer",
    "data warehouse",
    "edge cache",
];

const CITIES: &[&str] = &[
    "Lisbon",
    "Toronto",
    "Nairobi",
    "Kraków",
    "Melbourne",
    "Osaka",
    "Bogotá",
    "Oslo",
    "Austin",
    "Berlin",
    "Bangalore",
    "Montréal",
    "Cape Town",
    "Dublin",
    "Santiago",
];

const TOOLS: &[&str] = &[
    "Postgres",
    "Kafka",
    "Redis",
    "Terraform",
    "Grafana",
    "ClickHouse",
    "RabbitMQ",
    "Vault",
    "Argo",
    "OpenTelemetry",
    "Flagsmith",
    "Airflow",
    "Nomad",
    "Elasticsearch",
];

const PURPOSES: &[&str] =
    &["queueing", "metrics", "feature flags", "secrets", "deployments", "scheduling", "caching", "tracing"];

const MILESTONES: &[&str] = &["launch", "code freeze", "beta", "security review", "migration cutover", "retro"];

/// Where an env var in the transcript corpus points. Shaped like what gets
/// pasted into a session: hosts, ports, the odd bare IP.
const ENDPOINTS: &[&str] = &[
    "db-primary.internal:5432",
    "10.0.4.17:6379",
    "queue-2.internal:9092",
    "ledger-west.internal:8443",
    "10.0.9.3:4317",
    "cache-a.internal:11211",
    "search-1.internal:9200",
    "10.0.12.40:8080",
    "vault.internal:8200",
    "metrics-gw.internal:9091",
];

const MONTHS: &[&str] = &[
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];

const ACKS: &[&str] = &[
    "Noted.",
    "Got it, I'll keep that in mind.",
    "Understood.",
    "Thanks, that's recorded.",
    "Okay. Anything else on that?",
    "Makes sense.",
    "Right, thanks for the update.",
    "Noted, I'll remember that.",
];

const OPENERS: &[&str] = &[
    "Quick sync on Project {project} before standup.",
    "Picking up where we left off on {project}.",
    "A few things from today's {project} planning.",
    "Catching you up on Project {project}.",
    "Some notes from the {project} review.",
];

const CLOSERS: &[&str] = &[
    "That's everything for now.",
    "That's all I have today.",
    "Okay, let's pick this up tomorrow.",
    "I'll send the rest after lunch.",
];

/// Chatter that names the same entities but states no fact a query asks for.
const FILLER: &[&str] = &[
    "Had a good conversation with {person} about {project} this morning.",
    "{person} pinged me about the {component} again.",
    "The {project} channel was noisy today, mostly about the {component}.",
    "Reminder to loop {person} in on the {project} thread.",
    "{person} thinks the {component} needs another pass before {milestone}.",
    "Spent the afternoon reading through {project} tickets.",
    "{person} and {person2} were debating {tool} versus {tool2} over lunch.",
    "Need to book a room for the {project} {milestone} prep.",
    "The {component} tests were flaky again on {project}.",
    "{person} is out this week, so the {component} work waits.",
    "Coffee with {person} turned into an hour on {project}.",
    "Still waiting on feedback from {person} about the {project} plan.",
];

/// Chatter in the shape the [`Register::Transcript`] corpus adds on top of
/// [`FILLER`]: paths, qualified symbols, env vars and pasted output. It
/// answers no query either, so a mention found in one of these is a false
/// positive that costs entity-view precision — which is the whole reason
/// these turns are here.
const DEV_FILLER: &[&str] = &[
    "moved the {component} handler into services/{slug}/src/handler.ts today.",
    "TODO: the {slug}_worker retry loop still double-counts on timeout.",
    "See {slug}::rebuild_aggregates for why the {component} numbers drifted.",
    "set {ENV}_URL to the box in the corner and the {component} came back.",
    "the {slug} tests pass locally and fail in CI, {component} again.",
    "$ cargo test -p {slug} --test {component_slug}\n    Finished in 4.2s, 0 failed",
    "reading through packages/{slug}/README.md, the {component} section is stale.",
    "{ENV}_TIMEOUT_MS=5000 is too tight for the {component} on a cold start.",
    "Noted. the {slug} migration needs a backfill before the {component} cutover.",
    "grep -rn '{slug}' src/ turns up the {component} in four places.",
];

// --- facts -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Owner,
    Date,
    Location,
    Tool,
    Budget,
    /// Transcript only: which endpoint `HERON_BILLING_SERVICE_URL` points at.
    Env,
    /// Transcript only: who last changed `src/heron/billing_service.rs`. Not
    /// "owns" — that would be a confuser for [`Kind::Owner`] and bury the
    /// signal this family exists to carry.
    File,
    /// Transcript only: what `heron::billing_service::flush` writes to.
    Symbol,
}

impl Kind {
    const ALL: [Kind; 5] = [Kind::Owner, Kind::Date, Kind::Location, Kind::Tool, Kind::Budget];
    /// The prose families plus three whose *question* names a technical
    /// token — the only way a path, env var or symbol extractor can show up
    /// in the metrics, since a question about a person or a project reaches
    /// its answer through a name either way.
    const TRANSCRIPT: [Kind; 8] =
        [Kind::Owner, Kind::Date, Kind::Location, Kind::Tool, Kind::Budget, Kind::Env, Kind::File, Kind::Symbol];

    fn name(self) -> &'static str {
        match self {
            Kind::Owner => "owner",
            Kind::Date => "date",
            Kind::Location => "location",
            Kind::Tool => "tool",
            Kind::Budget => "budget",
            Kind::Env => "env",
            Kind::File => "file",
            Kind::Symbol => "symbol",
        }
    }
}

/// The thing a query asks about: kind plus its subject indexes into the world.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Key {
    kind: Kind,
    a: usize,
    b: usize,
}

#[derive(Debug, Clone)]
struct Fact {
    key: Key,
    /// Values stated over time, most recent last.
    values: Vec<String>,
    /// (uuid, index into `values`) for every turn that states this fact.
    statements: Vec<(String, usize)>,
    latest_session: String,
}

impl Key {
    /// The technical token a transcript-only fact is about, derived from the
    /// key alone so the statement and the question always agree on it.
    fn subject(self) -> String {
        let project = PROJECTS[self.a].to_lowercase();
        let component = COMPONENTS[self.b].replace(' ', "_");
        match self.kind {
            Kind::Env => format!("{}_{}_URL", project.to_uppercase(), component.to_uppercase()),
            Kind::File => format!("src/{project}/{component}.rs"),
            Kind::Symbol => format!("{project}::{component}::flush"),
            _ => unreachable!("only the transcript families have a technical subject"),
        }
    }

    fn subject_project(self) -> Option<usize> {
        match self.kind {
            Kind::Owner | Kind::Date | Kind::Tool | Kind::Budget | Kind::Env | Kind::File | Kind::Symbol => {
                Some(self.a)
            }
            Kind::Location => None,
        }
    }
}

struct Generator<'p> {
    profile: &'p Profile,
    rng: Rng,
    facts: Vec<Fact>,
    turns: Vec<Turn>,
    clock_ms: i64,
    turn_counter: u64,
}

/// 2025-01-06T09:00:00Z, a Monday.
const EPOCH_MS: i64 = 1_736_154_000_000;

/// Folded into the seed for the probes' own stream.
const PROBE_STREAM: u64 = 0x50_52_4F_42_45;
/// One unanswerable question for every this many answerable ones…
const ABSTAIN_ONE_IN: usize = 4;
/// …and never fewer than this, so the small corpus has some.
const ABSTAIN_AT_LEAST: usize = 3;

pub(crate) const DAY_MS: i64 = 86_400_000;

/// Days from 1970-01-01 to a civil date, UTC.
pub(crate) fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    month_start(year * 12 + month - 1) / DAY_MS + day - 1
}

/// A calendar month as `year * 12 + (month - 1)`, UTC.
fn month_of(ts_ms: i64) -> i64 {
    // Civil-from-days, after Howard Hinnant's public-domain algorithm.
    let z = ts_ms.div_euclid(DAY_MS) + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    year * 12 + month - 1
}

/// The first millisecond of a month counted as [`month_of`] counts them.
fn month_start(month: i64) -> i64 {
    let (y, m) = (month.div_euclid(12), month.rem_euclid(12) + 1);
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    (era * 146_097 + doe - 719_468) * DAY_MS
}

impl<'p> Generator<'p> {
    fn new(profile: &'p Profile) -> Self {
        Generator {
            profile,
            rng: Rng::new(profile.seed),
            facts: Vec::new(),
            turns: Vec::new(),
            clock_ms: EPOCH_MS,
            turn_counter: 0,
        }
    }

    fn run(mut self) -> Corpus {
        for n in 0..self.profile.sessions {
            let session_id = format!("{}-s{:04}", self.profile.name, n + 1);
            self.session(&session_id);
            // Sessions are 2–36 hours apart, so timestamps spread over months
            // in the large profile and the timeline has something to segment.
            self.clock_ms += self.rng.range(2, 36) as i64 * 3_600_000;
        }
        let queries = self.queries();
        let probes = self.probes(queries.len());
        Corpus { turns: self.turns, queries, probes }
    }

    fn session(&mut self, session_id: &str) {
        let mut project = self.rng.below(PROJECTS.len() as u64) as usize;
        let opener = self.rng.pick(OPENERS).replace("{project}", PROJECTS[project]);
        self.say(session_id, "user", opener);
        self.ack(session_id);

        let (lo, hi) = self.profile.facts_per_session;
        let facts = self.rng.range(lo, hi);
        for _ in 0..facts {
            if self.rng.chance(0.35) {
                let filler = self.filler(project);
                self.say(session_id, "user", filler);
                if self.rng.chance(0.5) {
                    self.ack(session_id);
                }
            }
            // Topic drift: a session that started on one project wanders.
            if self.rng.chance(0.15) {
                project = self.rng.below(PROJECTS.len() as u64) as usize;
            }
            let statement = self.statement(session_id, project);
            self.say_fact(session_id, statement);
            self.ack(session_id);
        }

        if self.rng.chance(0.6) {
            let closer = (*self.rng.pick(CLOSERS)).to_string();
            self.say(session_id, "user", closer);
        }
    }

    /// Decide whether to introduce, restate or change a fact, and phrase it.
    fn statement(&mut self, session_id: &str, project: usize) -> (String, usize) {
        let roll = self.rng.next_u64() % 100;
        let existing: Vec<usize> = (0..self.facts.len()).collect();
        let idx = if !existing.is_empty() && roll < 25 {
            // Restate the current value of a fact, preferring this project's.
            self.pick_fact(project)
        } else if !existing.is_empty() && roll < 40 {
            let i = self.pick_fact(project);
            let key = self.facts[i].key;
            let previous = self.facts[i].values.clone();
            let new_value = self.fresh_value(key, Some(&previous));
            self.facts[i].values.push(new_value);
            i
        } else {
            let key = self.fresh_key(project);
            match self.facts.iter().position(|f| f.key == key) {
                Some(i) => i,
                None => {
                    let value = self.fresh_value(key, None);
                    self.facts.push(Fact {
                        key,
                        values: vec![value],
                        statements: Vec::new(),
                        latest_session: String::new(),
                    });
                    self.facts.len() - 1
                }
            }
        };
        self.facts[idx].latest_session = session_id.to_string();
        let value_index = self.facts[idx].values.len() - 1;
        let changed = value_index > 0 && self.facts[idx].statements.iter().all(|(_, v)| *v < value_index);
        let restated = !changed && !self.facts[idx].statements.is_empty();
        let key = self.facts[idx].key;
        let value = self.facts[idx].values[value_index].clone();
        let text = self.phrase(key, &value, changed, restated);
        (text, idx)
    }

    fn pick_fact(&mut self, project: usize) -> usize {
        let mine: Vec<usize> = self
            .facts
            .iter()
            .enumerate()
            .filter(|(_, f)| f.key.subject_project() == Some(project))
            .map(|(i, _)| i)
            .collect();
        if !mine.is_empty() && self.rng.chance(0.7) {
            *self.rng.pick(&mine)
        } else {
            self.rng.below(self.facts.len() as u64) as usize
        }
    }

    fn fresh_key(&mut self, project: usize) -> Key {
        // Same slice length for the prose corpora, so the same draw.
        let kinds: &[Kind] = if self.profile.register == Register::Transcript { &Kind::TRANSCRIPT } else { &Kind::ALL };
        let kind = *self.rng.pick(kinds);
        match kind {
            Kind::Owner => Key { kind, a: project, b: self.rng.below(COMPONENTS.len() as u64) as usize },
            Kind::Date => Key { kind, a: project, b: self.rng.below(MILESTONES.len() as u64) as usize },
            Kind::Location => Key { kind, a: self.rng.below(PEOPLE.len() as u64) as usize, b: 0 },
            Kind::Tool => Key { kind, a: project, b: self.rng.below(PURPOSES.len() as u64) as usize },
            Kind::Budget => Key { kind, a: project, b: 0 },
            Kind::Env | Kind::File | Kind::Symbol => {
                Key { kind, a: project, b: self.rng.below(COMPONENTS.len() as u64) as usize }
            }
        }
    }

    /// A value for `key` that differs from every value in `previous` — or,
    /// once a fact has changed so often that the world has no unused value
    /// left (a few dozen cities or people), from the latest one only.
    fn fresh_value(&mut self, key: Key, previous: Option<&Vec<String>>) -> String {
        for attempt in 0.. {
            let unused_only = attempt < 64;
            let candidate = match key.kind {
                Kind::Owner => (*self.rng.pick(PEOPLE)).to_string(),
                Kind::Date => {
                    let month = *self.rng.pick(MONTHS);
                    format!("{month} {}", self.rng.range(1, 28))
                }
                Kind::Location => (*self.rng.pick(CITIES)).to_string(),
                Kind::Tool => (*self.rng.pick(TOOLS)).to_string(),
                Kind::Budget => format!("${}k", self.rng.range(4, 90) * 10),
                Kind::Env => (*self.rng.pick(ENDPOINTS)).to_string(),
                Kind::File => (*self.rng.pick(PEOPLE)).to_string(),
                Kind::Symbol => (*self.rng.pick(TOOLS)).to_string(),
            };
            let taken = match previous {
                None => false,
                Some(p) if unused_only => p.contains(&candidate),
                Some(p) => p.last() == Some(&candidate),
            };
            if !taken {
                return candidate;
            }
        }
        unreachable!("every value space has at least two members")
    }

    fn phrase(&mut self, key: Key, value: &str, changed: bool, restated: bool) -> String {
        let project = PROJECTS[key.a.min(PROJECTS.len() - 1)];
        let prefix = if changed {
            *self.rng.pick(&["Change of plan: ", "Update: ", "Correction — ", "Heads up, "])
        } else if restated {
            *self.rng.pick(&["As I mentioned, ", "Just to confirm, ", "Reminder: ", "Still the case: "])
        } else {
            ""
        };
        let body = match key.kind {
            Kind::Owner => {
                let component = COMPONENTS[key.b];
                let t = self.rng.pick(&[
                    "{value} owns the {component} on Project {project}.",
                    "the {component} for {project} is {value}'s responsibility now.",
                    "{value} is the point person for {project}'s {component}.",
                ]);
                t.replace("{component}", component)
            }
            Kind::Date => {
                let milestone = MILESTONES[key.b];
                let t = self.rng.pick(&[
                    "the {project} {milestone} is on {value}.",
                    "we've set {project}'s {milestone} for {value}.",
                    "{project} {milestone} date is {value}.",
                ]);
                t.replace("{milestone}", milestone)
            }
            Kind::Location => {
                let person = PEOPLE[key.a];
                let t = self.rng.pick(&[
                    "{person} is based in {value}.",
                    "{person} works out of {value} these days.",
                    "{person}'s home office is in {value}.",
                ]);
                t.replace("{person}", person)
            }
            Kind::Tool => {
                let purpose = PURPOSES[key.b];
                let t = self.rng.pick(&[
                    "we're using {value} for {purpose} on {project}.",
                    "{project} does {purpose} with {value}.",
                    "for {purpose}, {project} standardised on {value}.",
                ]);
                t.replace("{purpose}", purpose)
            }
            Kind::Budget => (*self.rng.pick(&[
                "the {project} budget is {value} for the quarter.",
                "{project} has {value} to spend this quarter.",
                "finance approved {value} for {project}.",
            ]))
            .to_string(),
            Kind::Env => (*self.rng.pick(&[
                "on {project}, {subject} points at {value}.",
                "we set {subject} to {value} for {project}.",
                "the {project} deploy reads {subject}, which is {value}.",
            ]))
            .to_string(),
            Kind::File => (*self.rng.pick(&[
                "{value} was the last one in {subject}.",
                "blame on {subject} says {value} rewrote it.",
                "the last change to {subject} came from {value}.",
            ]))
            .to_string(),
            Kind::Symbol => (*self.rng.pick(&[
                "on {project}, {subject} writes to {value}.",
                "we pointed {subject} at {value}.",
                "the {project} batch calls {subject}, which lands in {value}.",
            ]))
            .to_string(),
        };
        let mut sentence = body.replace("{project}", project).replace("{value}", value);
        if matches!(key.kind, Kind::Env | Kind::File | Kind::Symbol) {
            sentence = sentence.replace("{subject}", &key.subject());
        }
        if prefix.is_empty() {
            capitalise(&mut sentence);
        }
        format!("{prefix}{sentence}")
    }

    fn filler(&mut self, project: usize) -> String {
        // The draw sits inside the register test so the prose corpora keep
        // the stream they were generated with; see `fixtures_are_fresh`.
        if self.profile.register == Register::Transcript && self.rng.chance(0.45) {
            return self.dev_filler(project);
        }
        let template = *self.rng.pick(FILLER);
        let person = *self.rng.pick(PEOPLE);
        let mut person2 = *self.rng.pick(PEOPLE);
        while person2 == person {
            person2 = *self.rng.pick(PEOPLE);
        }
        let tool = *self.rng.pick(TOOLS);
        let mut tool2 = *self.rng.pick(TOOLS);
        while tool2 == tool {
            tool2 = *self.rng.pick(TOOLS);
        }
        template
            .replace("{person2}", person2)
            .replace("{person}", person)
            .replace("{project}", PROJECTS[project])
            .replace("{component}", self.rng.pick(COMPONENTS))
            .replace("{milestone}", self.rng.pick(MILESTONES))
            .replace("{tool2}", tool2)
            .replace("{tool}", tool)
    }

    /// [`DEV_FILLER`] with the world's words slugified into the shapes a
    /// transcript carries them in: `edge cache` becomes `edge-cache` in a
    /// path and `EDGE_CACHE` in an env var.
    fn dev_filler(&mut self, project: usize) -> String {
        let template = *self.rng.pick(DEV_FILLER);
        let component = *self.rng.pick(COMPONENTS);
        let slug = PROJECTS[project].to_lowercase();
        template
            .replace("{component_slug}", &component.replace(' ', "-"))
            .replace("{component}", component)
            .replace("{ENV}", &slug.to_uppercase())
            .replace("{slug}", &slug)
    }

    fn ack(&mut self, session_id: &str) {
        let ack = (*self.rng.pick(ACKS)).to_string();
        self.say(session_id, "assistant", ack);
    }

    fn say_fact(&mut self, session_id: &str, (text, fact): (String, usize)) {
        let uuid = self.say(session_id, "user", text);
        let value_index = self.facts[fact].values.len() - 1;
        self.facts[fact].statements.push((uuid, value_index));
    }

    fn say(&mut self, session_id: &str, speaker: &str, text: String) -> String {
        self.clock_ms += self.rng.range(15, 180) as i64 * 1_000;
        let uuid = self.uuid();
        let text = self.profile.register.render(&text);
        self.turns.push(Turn {
            session_id: session_id.to_string(),
            speaker: speaker.to_string(),
            text,
            ts: self.clock_ms,
            uuid: uuid.clone(),
        });
        uuid
    }

    /// Stable per-turn id: a hash of the profile seed and the turn ordinal,
    /// laid out like a UUID so it reads as one.
    fn uuid(&mut self) -> String {
        self.turn_counter += 1;
        let mut r = Rng::new(self.profile.seed ^ self.turn_counter.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        let a = r.next_u64();
        let b = r.next_u64();
        format!(
            "{:08x}-{:04x}-4{:03x}-{:04x}-{:012x}",
            a >> 32,
            (a >> 16) & 0xFFFF,
            a & 0x0FFF,
            0x8000 | ((b >> 48) & 0x3FFF),
            b & 0xFFFF_FFFF_FFFF
        )
    }

    fn queries(&mut self) -> Vec<Query> {
        let mut out = Vec::new();
        let facts = self.facts.clone();
        for (n, fact) in facts.iter().enumerate() {
            if fact.statements.is_empty() {
                continue;
            }
            let current = fact.values.len() - 1;
            let relevant = fact
                .statements
                .iter()
                .map(|(uuid, v)| Relevance { uuid: uuid.clone(), grade: if *v == current { 2 } else { 1 } })
                .collect();
            out.push(Query {
                id: format!("{}-q{:04}", self.profile.name, n + 1),
                kind: fact.key.kind.name().to_string(),
                query: self.question(fact.key),
                latest_session_id: fact.latest_session.clone(),
                relevant,
                ask: Ask::Current,
            });
        }
        out
    }

    /// The probes, drawn from a stream of their own: the turns and the
    /// `current` queries are already generated and must not move when a
    /// probe is added or rephrased.
    fn probes(&mut self, answerable: usize) -> Vec<Query> {
        self.rng = Rng::new(self.profile.seed ^ PROBE_STREAM);
        let said_at: HashMap<String, i64> = self.turns.iter().map(|t| (t.uuid.clone(), t.ts)).collect();
        let facts = self.facts.clone();
        let mut drafts: Vec<(Ask, Key, String, &Fact, Vec<Relevance>)> = Vec::new();
        for fact in &facts {
            if fact.values.len() < 2 {
                continue;
            }
            let graded = |wanted: usize| -> Vec<Relevance> {
                fact.statements
                    .iter()
                    .map(|(uuid, v)| Relevance { uuid: uuid.clone(), grade: if *v == wanted { 2 } else { 1 } })
                    .collect()
            };
            let previous = fact.values.len() - 2;
            drafts.push((Ask::History, fact.key, self.history_question(fact.key), fact, graded(previous)));

            // When each value was first stated; a value holds until the next one is.
            let starts: Vec<i64> = (0..fact.values.len())
                .map(|v| fact.statements.iter().filter(|(_, i)| *i == v).map(|(u, _)| said_at[u]).min())
                .map(|ts| ts.expect("every value was stated when it was introduced"))
                .collect();
            let mut held: Vec<(usize, i64)> = Vec::new();
            for v in 0..previous + 1 {
                let (from, to) = (starts[v], starts[v + 1]);
                for month in month_of(from)..=month_of(to - 1) {
                    // Only this value was in force at any point of the month.
                    let whole = (v == 0 || from <= month_start(month)) && to >= month_start(month + 1);
                    if whole {
                        held.push((v, month));
                    }
                }
            }
            if !held.is_empty() {
                let (v, month) = *self.rng.pick(&held);
                let when = format!("{} {}", MONTHS[month.rem_euclid(12) as usize], month.div_euclid(12));
                drafts.push((Ask::AsOf, fact.key, self.as_of_question(fact.key, &when), fact, graded(v)));
            }
        }

        let mut out: Vec<Query> = Vec::new();
        for (ask, key, query, fact, relevant) in drafts {
            out.push(Query {
                id: format!("{}-p{:04}", self.profile.name, out.len() + 1),
                kind: key.kind.name().to_string(),
                query,
                latest_session_id: fact.latest_session.clone(),
                relevant,
                ask,
            });
        }

        let mut unstated: Vec<Key> =
            self.every_key().into_iter().filter(|k| !facts.iter().any(|f| f.key == *k)).collect();
        self.rng.shuffle(&mut unstated);
        unstated.truncate((answerable / ABSTAIN_ONE_IN).max(ABSTAIN_AT_LEAST));
        for key in unstated {
            out.push(Query {
                id: format!("{}-p{:04}", self.profile.name, out.len() + 1),
                kind: key.kind.name().to_string(),
                query: self.question(key),
                latest_session_id: String::new(),
                relevant: Vec::new(),
                ask: Ask::Abstain,
            });
        }
        out
    }

    /// Every key this profile could have stated a fact about.
    fn every_key(&self) -> Vec<Key> {
        let kinds: &[Kind] = if self.profile.register == Register::Transcript { &Kind::TRANSCRIPT } else { &Kind::ALL };
        let mut out = Vec::new();
        for &kind in kinds {
            let (subjects, parts) = match kind {
                Kind::Owner | Kind::Env | Kind::File | Kind::Symbol => (PROJECTS.len(), COMPONENTS.len()),
                Kind::Date => (PROJECTS.len(), MILESTONES.len()),
                Kind::Tool => (PROJECTS.len(), PURPOSES.len()),
                Kind::Location => (PEOPLE.len(), 1),
                Kind::Budget => (PROJECTS.len(), 1),
            };
            for a in 0..subjects {
                for b in 0..parts {
                    out.push(Key { kind, a, b });
                }
            }
        }
        out
    }

    fn history_question(&mut self, key: Key) -> String {
        let q = match key.kind {
            Kind::Owner => self
                .rng
                .pick(&["Who owned the {component} on {project} before?", "Who used to own {project}'s {component}?"])
                .replace("{component}", COMPONENTS[key.b]),
            Kind::Date => self
                .rng
                .pick(&[
                    "What was the {project} {milestone} date before it changed?",
                    "When was {project}'s {milestone} previously scheduled?",
                ])
                .replace("{milestone}", MILESTONES[key.b]),
            Kind::Location => self
                .rng
                .pick(&["Where was {person} based before?", "Which city did {person} previously work from?"])
                .replace("{person}", PEOPLE[key.a]),
            Kind::Tool => self
                .rng
                .pick(&[
                    "What did {project} use for {purpose} before?",
                    "Which tool previously handled {purpose} on {project}?",
                ])
                .replace("{purpose}", PURPOSES[key.b]),
            Kind::Env => self
                .rng
                .pick(&["What was {subject} set to before?", "Where did {subject} previously point?"])
                .replace("{subject}", &key.subject()),
            Kind::File => self
                .rng
                .pick(&["Who changed {subject} before the latest change?", "Who previously touched {subject}?"])
                .replace("{subject}", &key.subject()),
            Kind::Symbol => self
                .rng
                .pick(&["What did {subject} write to before?", "Where did {subject} previously land its output?"])
                .replace("{subject}", &key.subject()),
            Kind::Budget => (*self.rng.pick(&[
                "What was the {project} budget before it changed?",
                "How much could {project} spend previously?",
            ]))
            .to_string(),
        };
        self.render_question(key, &q)
    }

    fn as_of_question(&mut self, key: Key, when: &str) -> String {
        let q = match key.kind {
            Kind::Owner => self
                .rng
                .pick(&[
                    "Who owned the {component} on {project} in {when}?",
                    "Who was responsible for {project}'s {component} in {when}?",
                ])
                .replace("{component}", COMPONENTS[key.b]),
            Kind::Date => self
                .rng
                .pick(&[
                    "What was the {project} {milestone} date as of {when}?",
                    "In {when}, when was {project}'s {milestone} scheduled?",
                ])
                .replace("{milestone}", MILESTONES[key.b]),
            Kind::Location => self
                .rng
                .pick(&["Where was {person} based in {when}?", "Which city did {person} work from in {when}?"])
                .replace("{person}", PEOPLE[key.a]),
            Kind::Tool => self
                .rng
                .pick(&[
                    "What did {project} use for {purpose} in {when}?",
                    "Which tool handled {purpose} on {project} in {when}?",
                ])
                .replace("{purpose}", PURPOSES[key.b]),
            Kind::Env => self
                .rng
                .pick(&["What was {subject} set to in {when}?", "Where did {subject} point in {when}?"])
                .replace("{subject}", &key.subject()),
            Kind::File => self
                .rng
                .pick(&["Who had last changed {subject} as of {when}?", "In {when}, who had touched {subject} last?"])
                .replace("{subject}", &key.subject()),
            Kind::Symbol => self
                .rng
                .pick(&["What did {subject} write to in {when}?", "Where did {subject} land its output in {when}?"])
                .replace("{subject}", &key.subject()),
            Kind::Budget => (*self
                .rng
                .pick(&["What was the {project} budget in {when}?", "How much could {project} spend as of {when}?"]))
            .to_string(),
        };
        self.render_question(key, &q.replace("{when}", when))
    }

    fn render_question(&self, key: Key, q: &str) -> String {
        let project = PROJECTS[key.a.min(PROJECTS.len() - 1)];
        self.profile.register.render_question(&q.replace("{project}", project))
    }

    fn question(&mut self, key: Key) -> String {
        let project = PROJECTS[key.a.min(PROJECTS.len() - 1)];
        let q = match key.kind {
            Kind::Owner => self
                .rng
                .pick(&["Who owns the {component} on {project}?", "Who is responsible for {project}'s {component}?"])
                .replace("{component}", COMPONENTS[key.b]),
            Kind::Date => self
                .rng
                .pick(&["When is the {project} {milestone}?", "What date is {project}'s {milestone}?"])
                .replace("{milestone}", MILESTONES[key.b]),
            Kind::Location => self
                .rng
                .pick(&["Where is {person} based?", "Which city does {person} work from?"])
                .replace("{person}", PEOPLE[key.a]),
            Kind::Tool => self
                .rng
                .pick(&["What does {project} use for {purpose}?", "Which tool handles {purpose} on {project}?"])
                .replace("{purpose}", PURPOSES[key.b]),
            Kind::Env => self
                .rng
                .pick(&["What is {subject} set to?", "Where does {subject} point?"])
                .replace("{subject}", &key.subject()),
            Kind::File => self
                .rng
                .pick(&["Who last changed {subject}?", "Who touched {subject} last?"])
                .replace("{subject}", &key.subject()),
            Kind::Symbol => self
                .rng
                .pick(&["What does {subject} write to?", "Where does {subject} land its output?"])
                .replace("{subject}", &key.subject()),
            Kind::Budget => {
                (*self.rng.pick(&["What is the {project} budget?", "How much can {project} spend this quarter?"]))
                    .to_string()
            }
        };
        self.profile.register.render_question(&q.replace("{project}", project))
    }
}

fn capitalise(s: &mut String) {
    if let Some(first) = s.chars().next() {
        let upper: String = first.to_uppercase().collect();
        s.replace_range(..first.len_utf8(), &upper);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn generation_is_deterministic() {
        assert_eq!(generate(&SMALL), generate(&SMALL));
        assert_ne!(generate(&SMALL).turns, generate(&LARGE).turns);
    }

    #[test]
    fn profiles_hit_their_size_targets() {
        let small = generate(&SMALL);
        assert!((35..=80).contains(&small.turns.len()), "small: {}", small.turns.len());
        let large = generate(&LARGE);
        assert!((4_000..=6_500).contains(&large.turns.len()), "large: {}", large.turns.len());
        let sessions: HashSet<_> = large.turns.iter().map(|t| &t.session_id).collect();
        assert_eq!(sessions.len(), LARGE.sessions);
    }

    #[test]
    fn corpus_is_internally_consistent() {
        for profile in PROFILES {
            let corpus = generate(profile);
            let uuids: HashSet<_> = corpus.turns.iter().map(|t| t.uuid.as_str()).collect();
            assert_eq!(uuids.len(), corpus.turns.len(), "{}: duplicate uuid", profile.name);
            let texts: HashSet<_> = corpus.turns.iter().map(|t| (&t.session_id, &t.text, t.ts)).collect();
            assert_eq!(texts.len(), corpus.turns.len(), "{}: duplicate content", profile.name);
            assert!(corpus.turns.windows(2).all(|w| w[0].ts < w[1].ts), "{}: ts not increasing", profile.name);
            assert!(!corpus.queries.is_empty());
            for q in &corpus.queries {
                assert!(!q.relevant.is_empty(), "{}: query {} has no relevant turns", profile.name, q.id);
                assert!(q.relevant.iter().any(|r| r.grade == 2), "{}: {} has no current statement", profile.name, q.id);
                for r in &q.relevant {
                    assert!(uuids.contains(r.uuid.as_str()), "{}: {} points at unknown uuid", profile.name, q.id);
                }
                assert!(corpus.turns.iter().any(|t| t.session_id == q.latest_session_id));
            }
        }
    }

    #[test]
    fn probes_are_labeled_for_what_they_ask() {
        for profile in PROFILES {
            let corpus = generate(profile);
            let uuids: HashSet<_> = corpus.turns.iter().map(|t| t.uuid.as_str()).collect();
            let current: HashSet<_> =
                corpus.queries.iter().flat_map(|q| &q.relevant).filter(|r| r.grade == 2).map(|r| &r.uuid).collect();
            assert!(corpus.queries.iter().all(|q| q.ask == Ask::Current));
            let ids: HashSet<_> = corpus.probes.iter().map(|q| &q.id).collect();
            assert_eq!(ids.len(), corpus.probes.len(), "{}: duplicate probe id", profile.name);
            for q in &corpus.probes {
                assert!(q.relevant.iter().all(|r| uuids.contains(r.uuid.as_str())), "{}: {}", profile.name, q.id);
                match q.ask {
                    Ask::Current => panic!("{}: {} is not a probe", profile.name, q.id),
                    Ask::Abstain => assert!(q.relevant.is_empty(), "{}: {} has an answer", profile.name, q.id),
                    Ask::History | Ask::AsOf => {
                        let wanted: Vec<_> = q.relevant.iter().filter(|r| r.grade == 2).collect();
                        assert!(!wanted.is_empty(), "{}: {} wants nothing", profile.name, q.id);
                        // The answer is an older value, never the one that holds now.
                        assert!(wanted.iter().all(|r| !current.contains(&r.uuid)), "{}: {}", profile.name, q.id);
                        assert!(q.relevant.iter().any(|r| r.grade == 1), "{}: {} never changed", profile.name, q.id);
                    }
                }
            }
            assert!(corpus.probes.iter().any(|q| q.ask == Ask::Abstain), "{}", profile.name);
            assert!(corpus.probes.iter().any(|q| q.ask == Ask::History), "{}", profile.name);
        }
        assert!(generate(&LARGE).probes.iter().filter(|q| q.ask == Ask::AsOf).count() > 50);
    }

    #[test]
    fn months_round_trip() {
        // 2025-01-06T09:00:00Z, the corpus epoch.
        assert_eq!(month_of(EPOCH_MS), 2025 * 12);
        assert_eq!(month_start(2025 * 12), 1_735_689_600_000);
        assert_eq!(month_start(2025 * 12 + 2), 1_740_787_200_000);
        for month in (1999 * 12)..(2031 * 12) {
            assert_eq!(month_of(month_start(month)), month);
            assert_eq!(month_of(month_start(month + 1) - 1), month);
        }
    }

    #[test]
    fn the_transcript_register_keeps_technical_tokens() {
        let got = lowercase_prose(
            "Maya Okafor moved it to server/src/engine/embed-worker.ts; See retrieve::hand_over. TODO: set ZEROMEM_EMBEDDING_URL, v2.1 costs $230k",
            0,
        );
        assert_eq!(
            got,
            "maya okafor moved it to server/src/engine/embed-worker.ts; see retrieve::hand_over. TODO: set ZEROMEM_EMBEDDING_URL, v2.1 costs $230k"
        );
    }

    #[test]
    fn the_transcript_register_keeps_some_capitals_and_keeps_them_stably() {
        let sentence = "Maya Okafor owns the billing service on Project Heron";
        let mixed = lowercase_prose(sentence, KEEP_CAPITAL_IN);
        assert_eq!(mixed, lowercase_prose(sentence, KEEP_CAPITAL_IN), "the coin has to be a function of the word");
        let kept = mixed.split(' ').filter(|w| w.starts_with(char::is_uppercase)).count();
        assert!(kept > 0 && kept < 7, "{mixed}");
        assert_eq!(mixed.to_lowercase(), lowercase_prose(sentence, 0), "only the case may differ");
    }

    #[test]
    fn the_transcript_corpus_is_mixed_case_and_asks_lowercase_questions() {
        let corpus = generate(&TRANSCRIPT);
        let (mut capitals, mut words) = (0usize, 0usize);
        for turn in &corpus.turns {
            for word in turn.text.split(' ') {
                words += 1;
                capitals += usize::from(word.starts_with(char::is_uppercase));
            }
        }
        assert!(capitals * 5 < words, "capitalised words: {capitals}/{words}");
        // Every question is typed the way a user types one, so a name the
        // store learned from a capitalised mention is out of the shape
        // rules' reach on the query side. That asymmetry is the corpus.
        // Technical tokens (an env var) keep their case, as they would.
        assert!(
            corpus.queries.iter().all(|q| q.query == lowercase_prose(&q.query, 0)),
            "a question kept a prose capital"
        );
        assert!(corpus.queries.iter().any(|q| q.query.contains("_URL")), "no question names an env var");
        assert!(corpus.queries.iter().any(|q| q.query.contains("::")), "no question names a symbol");
        // A name has to appear both ways, or there is nothing to resolve.
        let both = |name: &str| {
            corpus.turns.iter().any(|t| t.text.contains(name))
                && corpus.turns.iter().any(|t| t.text.contains(&name.to_lowercase()))
        };
        assert!(both("Maya"), "maya okafor is only ever written one way");
        // The prose corpora must not have moved.
        assert_eq!(generate(&LARGE).turns, generate(&LARGE).turns);
        assert!(generate(&LARGE).turns.iter().any(|t| t.text.contains("Project ")));
    }

    #[test]
    fn large_corpus_has_updates_and_restatements() {
        let large = generate(&LARGE);
        let superseded = large.queries.iter().filter(|q| q.relevant.iter().any(|r| r.grade == 1)).count();
        let restated = large.queries.iter().filter(|q| q.relevant.len() > 1).count();
        assert!(superseded > 20, "superseded: {superseded}");
        assert!(restated > 40, "restated: {restated}");
    }
}
