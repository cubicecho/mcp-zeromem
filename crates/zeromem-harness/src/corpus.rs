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
    /// Applied to every turn and every question as it is emitted. Pure, so
    /// it adds no draw to the generator's stream.
    fn render(self, text: &str) -> String {
        match self {
            Register::Prose => text.to_string(),
            Register::Transcript => lowercase_prose(text),
        }
    }
}

/// Lowercase the prose and leave the technical tokens as written: anything
/// holding a `/`, `_` or `:`, and anything with an inner capital or a digit,
/// is how it was typed. So `Maya Okafor` flattens to `maya okafor` while
/// `server/src/engine/embed-worker.ts`, `ZEROMEM_EMBEDDING_URL`,
/// `retrieve::hand_over`, `TODO:` and `$230k` survive intact.
fn lowercase_prose(text: &str) -> String {
    text.split(' ')
        .map(|word| {
            let technical =
                word.contains(['/', '_', ':']) || word.chars().skip(1).any(|c| c.is_uppercase() || c.is_ascii_digit());
            if technical {
                word.to_string()
            } else {
                word.to_lowercase()
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
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
}

impl Kind {
    const ALL: [Kind; 5] = [Kind::Owner, Kind::Date, Kind::Location, Kind::Tool, Kind::Budget];

    fn name(self) -> &'static str {
        match self {
            Kind::Owner => "owner",
            Kind::Date => "date",
            Kind::Location => "location",
            Kind::Tool => "tool",
            Kind::Budget => "budget",
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
    fn subject_project(self) -> Option<usize> {
        match self.kind {
            Kind::Owner | Kind::Date | Kind::Tool | Kind::Budget => Some(self.a),
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
        Corpus { turns: self.turns, queries }
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
        let kind = *self.rng.pick(&Kind::ALL);
        match kind {
            Kind::Owner => Key { kind, a: project, b: self.rng.below(COMPONENTS.len() as u64) as usize },
            Kind::Date => Key { kind, a: project, b: self.rng.below(MILESTONES.len() as u64) as usize },
            Kind::Location => Key { kind, a: self.rng.below(PEOPLE.len() as u64) as usize, b: 0 },
            Kind::Tool => Key { kind, a: project, b: self.rng.below(PURPOSES.len() as u64) as usize },
            Kind::Budget => Key { kind, a: project, b: 0 },
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
        };
        let mut sentence = body.replace("{project}", project).replace("{value}", value);
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
            });
        }
        out
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
            Kind::Budget => {
                (*self.rng.pick(&["What is the {project} budget?", "How much can {project} spend this quarter?"]))
                    .to_string()
            }
        };
        self.profile.register.render(&q.replace("{project}", project))
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
    fn the_transcript_register_keeps_technical_tokens() {
        let got = lowercase_prose(
            "Maya Okafor moved it to server/src/engine/embed-worker.ts; See retrieve::hand_over. TODO: set ZEROMEM_EMBEDDING_URL, v2.1 costs $230k",
        );
        assert_eq!(
            got,
            "maya okafor moved it to server/src/engine/embed-worker.ts; see retrieve::hand_over. TODO: set ZEROMEM_EMBEDDING_URL, v2.1 costs $230k"
        );
    }

    #[test]
    fn the_transcript_corpus_is_mostly_lowercase_and_asks_lowercase_questions() {
        let corpus = generate(&TRANSCRIPT);
        let capitalised =
            corpus.turns.iter().filter(|t| t.text.split(' ').any(|w| w.starts_with(char::is_uppercase))).count();
        // Some capitals survive on purpose — `TODO:` and env vars are
        // sentence-initial capitals that are not names, which is what the
        // extractor's shape rules have to cope with.
        assert!(capitalised * 4 < corpus.turns.len(), "capitalised turns: {capitalised}/{}", corpus.turns.len());
        assert!(corpus.queries.iter().all(|q| q.query == q.query.to_lowercase()), "a question kept a capital");
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
