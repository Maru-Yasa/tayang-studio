//! The voice and subtitle layers under the Preview panel's film strip, the same for every engine.
//!
//! Where they come from, first match wins:
//! - voice: `.tayang/layers.json` (`voice`), else the HyperFrames `<audio>` that holds the voice-over,
//!   else the audio track of the newest render;
//! - subtitles: `.tayang/layers.json` (`captions`) only. Compositions compute their own subtitles in
//!   code, so the agent writes them there (see the skills prompt).
//!
//! `.tayang/layers.json`, times in seconds:
//! `{ "voice": [{ "file": "audio/voice.mp3", "start": 0 }], "captions": [{ "start": 0.1, "end": 1.4, "text": "Tahun 1667" }] }`

use crate::media::{self, MediaTools};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, SystemTime};

pub const LAYERS_FILE: &str = ".tayang/layers.json";
/// Waveform points per second of audio.
const PEAKS_PER_SEC: f64 = 25.0;
/// ffmpeg decodes at this rate for the waveform: plenty for peaks, quick to decode.
const DECODE_RATE: u32 = 4000;
/// Never more than this many waveform points for one clip.
const MAX_PEAKS: usize = 4000;
const MAX_CAPTIONS: usize = 5000;

#[derive(Debug, Clone, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TimelineLayers {
    pub voice: Vec<VoiceTrack>,
    pub captions: Vec<Caption>,
    /// Where the voice came from: `layers` / `hyperframes` / `render`, or `None` with no voice.
    pub voice_source: Option<&'static str>,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct VoiceTrack {
    pub start_sec: f64,
    pub duration_sec: f64,
    /// 0..1, `PEAKS_PER_SEC` per second.
    pub peaks: Vec<f32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Caption {
    pub start_sec: f64,
    pub end_sec: f64,
    pub text: String,
}

/// A voice clip as a project names it: a file inside the project, placed at `start`, cut to `duration`.
#[derive(Debug, Clone, PartialEq)]
struct Clip {
    file: String,
    start: f64,
    duration: Option<f64>,
}

#[derive(Deserialize, Default)]
struct LayersFile {
    #[serde(default)]
    voice: Vec<serde_json::Value>,
    #[serde(default)]
    captions: Vec<serde_json::Value>,
}

fn num(v: &serde_json::Value, key: &str) -> Option<f64> {
    v.get(key).and_then(|n| n.as_f64()).filter(|n| n.is_finite())
}

/// `.tayang/layers.json`, leaving out entries that don't make sense. `None` when there is no such file
/// or it isn't JSON.
fn read_layers_file(folder: &Path) -> Option<(Vec<Clip>, Vec<Caption>)> {
    let raw = std::fs::read_to_string(folder.join(LAYERS_FILE)).ok()?;
    let file: LayersFile = serde_json::from_str(&raw).ok()?;
    let clips = file
        .voice
        .iter()
        .filter_map(|v| {
            let name = v.get("file")?.as_str()?.to_string();
            Some(Clip { file: name, start: num(v, "start").unwrap_or(0.0).max(0.0), duration: num(v, "duration").filter(|d| *d > 0.0) })
        })
        .collect();
    let mut captions: Vec<Caption> = file
        .captions
        .iter()
        .filter_map(|c| {
            let text = c.get("text")?.as_str()?.trim().to_string();
            let (start, end) = (num(c, "start")?.max(0.0), num(c, "end")?);
            (!text.is_empty() && end > start).then_some(Caption { start_sec: start, end_sec: end, text })
        })
        .take(MAX_CAPTIONS)
        .collect();
    captions.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));
    Some((clips, captions))
}

/// The attributes of every `<audio ...>` tag in `html`.
fn audio_tags(html: &str) -> Vec<HashMap<String, String>> {
    let lower = html.to_ascii_lowercase();
    let mut tags = Vec::new();
    let mut from = 0;
    while let Some(i) = lower[from..].find("<audio") {
        let start = from + i + "<audio".len();
        let Some(len) = html[start..].find('>') else { break };
        tags.push(attributes(&html[start..start + len]));
        from = start + len;
    }
    tags
}

/// `name="value"` / `name='value'` / `name=value` / `name` pairs, names lowercased.
fn attributes(s: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let b = s.as_bytes();
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        let name_start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && b[i] != b'=' && b[i] != b'/' {
            i += 1;
        }
        if i == name_start {
            break;
        }
        let name = s[name_start..i].to_ascii_lowercase();
        let mut value = String::new();
        if i < b.len() && b[i] == b'=' {
            i += 1;
            if i < b.len() && (b[i] == b'"' || b[i] == b'\'') {
                let q = b[i];
                let v_start = i + 1;
                let end = s[v_start..].bytes().position(|c| c == q).map_or(b.len(), |p| v_start + p);
                value = s[v_start..end].to_string();
                i = (end + 1).min(b.len());
            } else {
                let v_start = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                value = s[v_start..i].to_string();
            }
        }
        out.insert(name, value);
    }
    out
}

/// The voice-over in a HyperFrames `index.html`: the `<audio>` tags whose id or file says voice
/// (`vo`, `voice`, `narration`, `vox`), else the only `<audio>` when there is just one.
fn hyperframes_voice(folder: &Path) -> Vec<Clip> {
    let Ok(html) = std::fs::read_to_string(folder.join("index.html")) else { return Vec::new() };
    let clips: Vec<(Clip, bool)> = audio_tags(&html)
        .into_iter()
        .filter_map(|a| {
            let src = a.get("src").filter(|s| !s.is_empty() && !s.contains("://") && !s.starts_with("data:"))?.clone();
            let id = a.get("id").map(|s| s.to_ascii_lowercase()).unwrap_or_default();
            let words = format!("{id} {}", src.to_ascii_lowercase());
            let voice = words
                .split(|c: char| !c.is_ascii_alphanumeric())
                .any(|w| matches!(w, "vo" | "voice" | "voiceover" | "narration" | "narrator" | "vox"));
            let parse = |k: &str| a.get(k).and_then(|v| v.trim().parse::<f64>().ok()).filter(|n| n.is_finite());
            let clip = Clip { file: src, start: parse("data-start").unwrap_or(0.0).max(0.0), duration: parse("data-duration").filter(|d| *d > 0.0) };
            Some((clip, voice))
        })
        .collect();
    if clips.iter().any(|(_, v)| *v) {
        clips.into_iter().filter(|(_, v)| *v).map(|(c, _)| c).collect()
    } else if clips.len() == 1 {
        clips.into_iter().map(|(c, _)| c).collect()
    } else {
        Vec::new()
    }
}

/// `rel` inside the project folder, following links; `None` when it leaves the folder or isn't a file.
fn inside(folder: &Path, rel: &str) -> Option<PathBuf> {
    let root = folder.canonicalize().ok()?;
    let path = root.join(rel.trim_start_matches("./")).canonicalize().ok()?;
    (path.starts_with(&root) && path.is_file()).then_some(path)
}

/// Peaks of 16-bit mono samples: the loudest sample in each `per` samples, scaled so the loudest is 1.
fn peaks_of(samples: &[i16], per: usize) -> Vec<f32> {
    let per = per.max(1);
    let mut peaks: Vec<f32> = samples
        .chunks(per)
        .map(|c| c.iter().map(|s| (*s as i32).unsigned_abs()).max().unwrap_or(0) as f32)
        .collect();
    if peaks.len() > MAX_PEAKS {
        let step = peaks.len().div_ceil(MAX_PEAKS);
        peaks = peaks.chunks(step).map(|c| c.iter().cloned().fold(0.0, f32::max)).collect();
    }
    let max = peaks.iter().cloned().fold(0.0, f32::max);
    if max > 0.0 {
        for p in &mut peaks {
            *p = (*p / max * 1000.0).round() / 1000.0;
        }
    }
    peaks
}

type PeaksKey = (PathBuf, SystemTime, u64);
/// A waveform and its audio's length in seconds.
type Peaks = (Vec<f32>, f64);
/// Decoded waveforms by file, path and mtime and size: polling the layers doesn't decode again.
static PEAKS: Mutex<Option<HashMap<PeaksKey, Peaks>>> = Mutex::new(None);

/// The waveform of `file`'s audio and its length in seconds.
fn audio_peaks(tools: &MediaTools, file: &Path) -> Option<Peaks> {
    let meta = std::fs::metadata(file).ok()?;
    let key = (file.to_path_buf(), meta.modified().ok()?, meta.len());
    if let Some(hit) = PEAKS.lock().ok()?.as_ref().and_then(|m| m.get(&key)) {
        return Some(hit.clone());
    }
    let mut cmd = media::command(&tools.ffmpeg);
    cmd.args(["-v", "error", "-nostdin", "-i"])
        .arg(file)
        .args(["-vn", "-ac", "1", "-ar", &DECODE_RATE.to_string(), "-f", "s16le", "-"]);
    let out = media::run_within(cmd, "ffmpeg", Duration::from_secs(60)).ok()?;
    let samples: Vec<i16> = out.stdout.as_chunks::<2>().0.iter().map(|b| i16::from_le_bytes(*b)).collect();
    if samples.is_empty() {
        return None;
    }
    let duration = samples.len() as f64 / DECODE_RATE as f64;
    let peaks = peaks_of(&samples, (DECODE_RATE as f64 / PEAKS_PER_SEC) as usize);
    let value = (peaks, duration);
    if let Ok(mut cache) = PEAKS.lock() {
        let map = cache.get_or_insert_with(HashMap::new);
        if map.len() > 64 {
            map.clear();
        }
        map.insert(key, value.clone());
    }
    Some(value)
}

/// A clip's waveform, cut to its `duration` when that is shorter than the audio.
fn track(tools: &MediaTools, file: &Path, start: f64, duration: Option<f64>) -> Option<VoiceTrack> {
    let (peaks, length) = audio_peaks(tools, file)?;
    let shown = duration.map_or(length, |d| d.min(length));
    let keep = ((shown / length) * peaks.len() as f64).ceil() as usize;
    Some(VoiceTrack { start_sec: start, duration_sec: shown, peaks: peaks.into_iter().take(keep.max(1)).collect() })
}

/// The project's voice and subtitle layers.
pub fn timeline_layers(tools: &MediaTools, folder: &Path) -> TimelineLayers {
    let (mut clips, captions) = read_layers_file(folder).unwrap_or_default();
    let mut source = "layers";
    if clips.is_empty() {
        clips = hyperframes_voice(folder);
        source = "hyperframes";
    }
    let mut voice: Vec<VoiceTrack> = clips
        .iter()
        .filter_map(|c| track(tools, &inside(folder, &c.file)?, c.start, c.duration))
        .collect();
    if voice.is_empty() {
        source = "render";
        voice = media::latest_render(folder).and_then(|v| track(tools, &v, 0.0, None)).into_iter().collect();
    }
    voice.sort_by(|a, b| a.start_sec.total_cmp(&b.start_sec));
    TimelineLayers { voice_source: (!voice.is_empty()).then_some(source), voice, captions }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tools() -> MediaTools {
        MediaTools::from_env_or_path()
    }

    fn has_ffmpeg() -> bool {
        media::command(&tools().ffmpeg).arg("-version").output().is_ok_and(|o| o.status.success())
    }

    /// A short tone: `secs` long, loud in the first half and quiet in the second.
    fn tone(path: &Path, secs: f64) {
        let half = secs / 2.0;
        let filter = format!("sine=frequency=440:duration={secs},volume='if(lt(t,{half}),1,0.1)':eval=frame");
        let ok = media::command(&tools().ffmpeg)
            .args(["-v", "error", "-y", "-f", "lavfi", "-i", &filter])
            .arg(path)
            .status()
            .unwrap();
        assert!(ok.success());
    }

    #[test]
    fn reads_the_layers_file_and_leaves_out_what_makes_no_sense() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(dir.path().join(".tayang")).unwrap();
        std::fs::write(
            dir.path().join(LAYERS_FILE),
            r#"{"voice":[{"file":"audio/vo.mp3","start":1.5,"duration":3},{"start":2}],
                "captions":[{"start":2,"end":3,"text":" dua "},{"start":0,"end":1,"text":"satu"},
                            {"start":4,"end":4,"text":"kosong"},{"start":5,"end":6,"text":"  "},{"end":2,"text":"x"}]}"#,
        )
        .unwrap();
        let (clips, captions) = read_layers_file(dir.path()).unwrap();
        assert_eq!(clips, vec![Clip { file: "audio/vo.mp3".into(), start: 1.5, duration: Some(3.0) }]);
        assert_eq!(
            captions,
            vec![
                Caption { start_sec: 0.0, end_sec: 1.0, text: "satu".into() },
                Caption { start_sec: 2.0, end_sec: 3.0, text: "dua".into() },
            ]
        );
        std::fs::write(dir.path().join(LAYERS_FILE), "not json").unwrap();
        assert!(read_layers_file(dir.path()).is_none());
    }

    #[test]
    fn finds_the_voice_over_among_the_hyperframes_audio() {
        let dir = tempfile::tempdir().unwrap();
        let html = r#"<div id="root" data-composition-id="main">
            <AUDIO id="music" src="audio/bed.mp3" data-start="0"></AUDIO>
            <audio id="vo" src='audio/voice.mp3' data-start="0.5" data-duration="74.3" data-track-index="1"></audio>
            <audio src="https://cdn.example/x.mp3"></audio></div>"#;
        std::fs::write(dir.path().join("index.html"), html).unwrap();
        assert_eq!(hyperframes_voice(dir.path()), vec![Clip { file: "audio/voice.mp3".into(), start: 0.5, duration: Some(74.3) }]);

        // One audio that doesn't say voice: it is the voice. Two that don't: none is.
        std::fs::write(dir.path().join("index.html"), r#"<audio src="a/s01.mp3" data-start="2">"#).unwrap();
        assert_eq!(hyperframes_voice(dir.path()), vec![Clip { file: "a/s01.mp3".into(), start: 2.0, duration: None }]);
        std::fs::write(dir.path().join("index.html"), r#"<audio src="a.mp3"><audio src="b.mp3">"#).unwrap();
        assert!(hyperframes_voice(dir.path()).is_empty());
    }

    #[test]
    fn attributes_take_every_quoting() {
        let a = attributes(r#" id=vo src="a b.mp3" data-start='1' muted/"#);
        assert_eq!(a["id"], "vo");
        assert_eq!(a["src"], "a b.mp3");
        assert_eq!(a["data-start"], "1");
        assert_eq!(a["muted"], "");
    }

    #[test]
    fn a_file_outside_the_project_is_not_read() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("p");
        std::fs::create_dir_all(project.join("audio")).unwrap();
        std::fs::write(dir.path().join("secret.mp3"), b"x").unwrap();
        std::fs::write(project.join("audio/v.mp3"), b"x").unwrap();
        assert!(inside(&project, "../secret.mp3").is_none());
        assert!(inside(&project, "/etc/hosts").is_none());
        assert!(inside(&project, "audio").is_none());
        assert_eq!(inside(&project, "./audio/v.mp3"), Some(project.join("audio/v.mp3").canonicalize().unwrap()));
    }

    #[test]
    fn peaks_scale_to_the_loudest_and_stay_bounded() {
        assert_eq!(peaks_of(&[0, 100, -200, 50], 2), vec![0.5, 1.0]);
        assert_eq!(peaks_of(&[0, 0], 1), vec![0.0, 0.0]);
        assert!(peaks_of(&vec![1; MAX_PEAKS * 3 + 7], 1).len() <= MAX_PEAKS);
    }

    #[test]
    fn draws_the_voice_from_the_layers_file_then_hyperframes_then_the_render() {
        if !has_ffmpeg() {
            eprintln!("skipped: no ffmpeg");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        std::fs::create_dir_all(p.join("audio")).unwrap();
        std::fs::create_dir_all(p.join("renders")).unwrap();
        tone(&p.join("audio/voice.wav"), 2.0);
        tone(&p.join("renders/out.mp4"), 4.0);

        // Only the render.
        let l = timeline_layers(&tools(), p);
        assert_eq!(l.voice_source, Some("render"));
        assert!((l.voice[0].duration_sec - 4.0).abs() < 0.1);

        // HyperFrames names the voice: its place and cut.
        std::fs::write(p.join("index.html"), r#"<audio id="vo" src="audio/voice.wav" data-start="1" data-duration="1.5">"#).unwrap();
        let l = timeline_layers(&tools(), p);
        assert_eq!(l.voice_source, Some("hyperframes"));
        let v = &l.voice[0];
        assert_eq!(v.start_sec, 1.0);
        assert!((v.duration_sec - 1.5).abs() < 0.01);
        assert!((v.peaks.len() as f64 - 1.5 * PEAKS_PER_SEC).abs() <= 2.0, "{}", v.peaks.len());
        // Loud first half, quiet second half.
        assert!(v.peaks[2] > 0.9 && v.peaks[v.peaks.len() - 2] < 0.2, "{:?}", v.peaks);

        // The layers file wins, and brings the subtitles.
        std::fs::create_dir_all(p.join(".tayang")).unwrap();
        std::fs::write(
            p.join(LAYERS_FILE),
            r#"{"voice":[{"file":"audio/voice.wav","start":0.25}],"captions":[{"start":0.3,"end":1,"text":"Halo"}]}"#,
        )
        .unwrap();
        let l = timeline_layers(&tools(), p);
        assert_eq!(l.voice_source, Some("layers"));
        assert_eq!(l.voice[0].start_sec, 0.25);
        assert!((l.voice[0].duration_sec - 2.0).abs() < 0.05);
        assert_eq!(l.captions, vec![Caption { start_sec: 0.3, end_sec: 1.0, text: "Halo".into() }]);
    }

    #[test]
    fn nothing_to_draw_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(timeline_layers(&tools(), dir.path()), TimelineLayers::default());
    }
}
