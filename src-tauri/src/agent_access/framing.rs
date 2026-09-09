//! Newline-delimited JSON framing shared by the pipe transport (app <-> companion) and the MCP
//! stdio transport (companion <-> agent host). `serde_json` never emits a raw, unescaped newline
//! inside a serialized value, so splitting on `\n` is a safe and simple frame boundary in both
//! directions — no length-prefix parsing needed.

use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncWrite, AsyncWriteExt, BufReader};

#[derive(Debug)]
pub enum FrameError {
    /// The peer closed the stream (or reached EOF) without sending a further frame.
    Closed,
    /// A single line exceeded the bound before a newline was seen.
    TooLarge,
    Io(std::io::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FrameError::Closed => write!(f, "connection closed"),
            FrameError::TooLarge => write!(f, "frame exceeded the maximum size"),
            FrameError::Io(error) => write!(f, "io error: {error}"),
        }
    }
}

/// Reads one newline-delimited frame, enforcing `max_bytes` on the line (including its
/// terminator) so a single oversized line cannot grow an unbounded buffer. `.take()` cannot be
/// used to bound this (it drops the `AsyncBufRead` impl `read_until` needs), so this scans
/// `fill_buf`/`consume` chunks by hand instead.
pub async fn read_frame<R>(
    reader: &mut BufReader<R>,
    max_bytes: usize,
) -> Result<Vec<u8>, FrameError>
where
    R: AsyncRead + Unpin,
{
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let available = reader.fill_buf().await.map_err(FrameError::Io)?;
        if available.is_empty() {
            return Err(FrameError::Closed);
        }
        if let Some(pos) = available.iter().position(|&b| b == b'\n') {
            if buf.len() + pos + 1 > max_bytes {
                reader.consume(pos + 1);
                return Err(FrameError::TooLarge);
            }
            buf.extend_from_slice(&available[..=pos]);
            reader.consume(pos + 1);
            while buf.last() == Some(&b'\n') || buf.last() == Some(&b'\r') {
                buf.pop();
            }
            return Ok(buf);
        }
        if buf.len() + available.len() > max_bytes {
            let consumed = available.len();
            reader.consume(consumed);
            return Err(FrameError::TooLarge);
        }
        buf.extend_from_slice(available);
        let consumed = available.len();
        reader.consume(consumed);
    }
}

pub async fn write_frame<W>(writer: &mut W, payload: &[u8]) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin,
{
    writer.write_all(payload).await.map_err(FrameError::Io)?;
    writer.write_all(b"\n").await.map_err(FrameError::Io)?;
    writer.flush().await.map_err(FrameError::Io)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, AsyncWriteExt};

    #[tokio::test]
    async fn round_trips_a_single_frame() {
        let (mut client, server) = duplex(1024);
        let mut server_reader = BufReader::new(server);
        client.write_all(b"{\"hello\":true}\n").await.unwrap();
        let frame = read_frame(&mut server_reader, 1024).await.unwrap();
        assert_eq!(frame, b"{\"hello\":true}");
    }

    #[tokio::test]
    async fn reads_multiple_frames_in_order() {
        let (mut client, server) = duplex(1024);
        let mut server_reader = BufReader::new(server);
        client.write_all(b"one\ntwo\n").await.unwrap();
        assert_eq!(read_frame(&mut server_reader, 1024).await.unwrap(), b"one");
        assert_eq!(read_frame(&mut server_reader, 1024).await.unwrap(), b"two");
    }

    #[tokio::test]
    async fn rejects_a_frame_that_exceeds_the_bound() {
        let (mut client, server) = duplex(1024);
        let mut server_reader = BufReader::new(server);
        client.write_all(&[b'a'; 200]).await.unwrap();
        client.write_all(b"\n").await.unwrap();
        let error = read_frame(&mut server_reader, 100).await.unwrap_err();
        assert!(matches!(error, FrameError::TooLarge));
    }

    #[tokio::test]
    async fn reports_closed_when_the_peer_disconnects_without_a_final_newline() {
        let (client, server) = duplex(1024);
        drop(client);
        let mut server_reader = BufReader::new(server);
        let error = read_frame(&mut server_reader, 1024).await.unwrap_err();
        assert!(matches!(error, FrameError::Closed));
    }

    #[tokio::test]
    async fn write_frame_appends_exactly_one_newline() {
        let (client, mut server) = duplex(1024);
        write_frame(&mut server, b"{\"a\":1}").await.unwrap();
        drop(server);
        let mut reader = BufReader::new(client);
        let frame = read_frame(&mut reader, 1024).await.unwrap();
        assert_eq!(frame, b"{\"a\":1}");
    }
}
