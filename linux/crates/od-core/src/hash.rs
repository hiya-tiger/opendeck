//! Streamed SHA-256 of a file (sha256File in src/main/separation.ts), via ring
//! (the same BoringSSL assembly Node's crypto uses).
use std::io::Read;
use std::path::Path;

pub fn sha256_file(p: &Path) -> std::io::Result<String> {
    let mut f = std::fs::File::open(p)?;
    let mut h = ring::digest::Context::new(&ring::digest::SHA256);
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf)?;
        if n == 0 { break; }
        h.update(&buf[..n]);
    }
    Ok(hex(h.finish().as_ref()))
}
pub fn sha256_bytes(b: &[u8]) -> String { hex(ring::digest::digest(&ring::digest::SHA256, b).as_ref()) }
fn hex(d: &[u8]) -> String { d.iter().map(|b| format!("{b:02x}")).collect() }
