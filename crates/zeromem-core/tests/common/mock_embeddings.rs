//! A tiny OpenAI-compatible `/v1/embeddings` server on a local port, for
//! testing the remote embedder without a model or the network. Vectors are
//! a deterministic feature hash into a small dimension, so the same text
//! always gets the same vector and similar texts land near each other.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

pub const DIM: usize = 8;

#[derive(Debug, Clone, Default)]
pub struct Request {
    pub authorization: Option<String>,
    pub model: String,
    pub inputs: Vec<String>,
}

#[derive(Default)]
pub struct State {
    pub requests: Vec<Request>,
    /// Respond with HTTP 500 this many more times.
    pub fail_next: u32,
    /// Sleep this long before answering.
    pub delay: Duration,
    /// Send the vectors in reverse `index` order, as some servers do.
    pub shuffle: bool,
    /// Vector length to return; `DIM` unless a test wants a mismatch.
    pub dim: usize,
    /// Reject requests without this bearer token.
    pub require_key: Option<String>,
}

pub struct MockServer {
    pub url: String,
    pub state: Arc<Mutex<State>>,
    stop: Arc<AtomicBool>,
    addr: std::net::SocketAddr,
}

impl MockServer {
    pub fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        let addr = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let state = Arc::new(Mutex::new(State { dim: DIM, ..Default::default() }));
        let stop = Arc::new(AtomicBool::new(false));
        let (st, sp) = (state.clone(), stop.clone());
        thread::spawn(move || {
            while !sp.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let st = st.clone();
                        thread::spawn(move || serve(stream, &st));
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => thread::sleep(Duration::from_millis(5)),
                    Err(_) => break,
                }
            }
        });
        MockServer { url: format!("http://{addr}/v1"), state, stop, addr }
    }

    pub fn requests(&self) -> Vec<Request> {
        self.state.lock().unwrap().requests.clone()
    }

    pub fn set<F: FnOnce(&mut State)>(&self, f: F) {
        f(&mut self.state.lock().unwrap());
    }

    /// The URL of a port nothing listens on, for connection failures.
    pub fn dead_url(&self) -> String {
        let probe = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        format!("http://127.0.0.1:{port}/v1")
    }

    pub fn port(&self) -> u16 {
        self.addr.port()
    }
}

impl Drop for MockServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
    }
}

pub fn embed(text: &str, dim: usize) -> Vec<f32> {
    let mut v = vec![0f32; dim];
    for word in text.split_whitespace() {
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        for b in word.to_lowercase().bytes() {
            h ^= u64::from(b);
            h = h.wrapping_mul(0x0100_0000_01b3);
        }
        let slot = (h % dim as u64) as usize;
        v[slot] += if (h >> 63) == 0 { 1.0 } else { -1.0 };
    }
    let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        v.iter_mut().for_each(|x| *x /= norm);
    }
    v
}

fn serve(stream: TcpStream, state: &Mutex<State>) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut request_line = String::new();
    if reader.read_line(&mut request_line).is_err() || request_line.is_empty() {
        return;
    }
    let mut content_length = 0usize;
    let mut authorization = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line).is_err() || line == "\r\n" || line.is_empty() {
            break;
        }
        let (name, value) = line.split_once(':').unwrap_or(("", ""));
        match name.to_ascii_lowercase().as_str() {
            "content-length" => content_length = value.trim().parse().unwrap_or(0),
            "authorization" => authorization = Some(value.trim().to_string()),
            _ => {}
        }
    }
    let mut body = vec![0u8; content_length];
    reader.read_exact(&mut body).ok();
    let mut stream = stream;
    if !request_line.starts_with("POST /v1/embeddings ") {
        respond(&mut stream, 404, r#"{"error":{"message":"not found"}}"#);
        return;
    }
    let json: serde_json::Value = match serde_json::from_slice(&body) {
        Ok(j) => j,
        Err(_) => {
            respond(&mut stream, 400, r#"{"error":{"message":"bad json"}}"#);
            return;
        }
    };
    let model = json["model"].as_str().unwrap_or_default().to_string();
    let inputs: Vec<String> = json["input"]
        .as_array()
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default();
    let (delay, fail, shuffle, dim, key_error) = {
        let mut st = state.lock().unwrap();
        st.requests.push(Request {
            authorization: authorization.clone(),
            model: model.clone(),
            inputs: inputs.clone(),
        });
        let fail = if st.fail_next > 0 {
            st.fail_next -= 1;
            true
        } else {
            false
        };
        let key_error =
            st.require_key.as_ref().is_some_and(|k| authorization.as_deref() != Some(&format!("Bearer {k}")));
        (st.delay, fail, st.shuffle, st.dim, key_error)
    };
    if !delay.is_zero() {
        thread::sleep(delay);
    }
    if key_error {
        respond(&mut stream, 401, r#"{"error":{"message":"invalid api key"}}"#);
        return;
    }
    if fail {
        respond(&mut stream, 500, r#"{"error":{"message":"model overloaded"}}"#);
        return;
    }
    let mut data: Vec<serde_json::Value> = inputs
        .iter()
        .enumerate()
        .map(|(i, t)| serde_json::json!({"object": "embedding", "index": i, "embedding": embed(t, dim)}))
        .collect();
    if shuffle {
        data.reverse();
    }
    let body = serde_json::json!({"object": "list", "data": data, "model": model}).to_string();
    respond(&mut stream, 200, &body);
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        _ => "Internal Server Error",
    };
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes()).ok();
    stream.write_all(body.as_bytes()).ok();
    stream.flush().ok();
}
