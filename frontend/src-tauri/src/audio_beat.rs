//! Real-time Windows WASAPI Loopback bass-beat detector and tempo/phase tracker
//! for AIDEN's Spotify PiP music bopping (Beat Head-Nod <-> Crisp Beat Hop).

use std::collections::VecDeque;
use std::f64::consts::{FRAC_PI_2, PI};

/// Active sway style selected automatically every 8 beats.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BopSwayKind {
    HeadNod,
    BeatHop,
}

impl BopSwayKind {
    pub fn as_str(self) -> &'static str {
        match self {
            BopSwayKind::HeadNod => "head_nod",
            BopSwayKind::BeatHop => "beat_hop",
        }
    }
}

/// Snapshot emitted for syncing frontend eye/rim groove to the native VSync beat clock.
#[derive(Clone, Copy, Debug)]
pub struct BeatClockState {
    pub bpm: f64,
    pub beat_count: f64,
    pub beat_phase: f64,
    pub sway: BopSwayKind,
    pub energy_scale: f64,
}

/// Real-time low-pass bass onset detector + median-filtered BPM tracker + phase-locked beat clock.
pub struct BassBeatTracker {
    sample_rate: f64,
    lp1: f64,
    lp2: f64,
    lp_alpha: f64,

    // Frame energy accumulation (~10ms hop)
    frame_samples: usize,
    frame_target: usize,
    frame_sq_sum: f64,

    // Adaptive onset detection state
    avg_energy: f64,
    prev_energy: f64,
    elapsed_sec: f64,
    last_onset_sec: f64,
    recent_intervals: VecDeque<f64>,

    // Phase-locked beat clock
    bpm: f64,
    beat_count: f64,
    last_audio_sec: f64,
    energy_scale: f64,
}

impl BassBeatTracker {
    pub fn new(sample_rate: u32) -> Self {
        let sr = (sample_rate.max(8000)) as f64;
        // 1-pole RC low-pass coefficient for ~140Hz cutoff (cascaded twice for steeper kick isolation)
        let rc = 1.0 / (2.0 * PI * 140.0);
        let dt = 1.0 / sr;
        let lp_alpha = dt / (rc + dt);
        let frame_target = ((sr * 0.010).round() as usize).max(64);

        Self {
            sample_rate: sr,
            lp1: 0.0,
            lp2: 0.0,
            lp_alpha,
            frame_samples: 0,
            frame_target,
            frame_sq_sum: 0.0,
            avg_energy: 0.002,
            prev_energy: 0.0,
            elapsed_sec: 0.0,
            last_onset_sec: -10.0,
            recent_intervals: VecDeque::with_capacity(10),
            bpm: 108.0,
            beat_count: 0.0,
            last_audio_sec: -10.0,
            energy_scale: 0.72,
        }
    }

    pub fn set_sample_rate(&mut self, sample_rate: u32) {
        let sr = (sample_rate.max(8000)) as f64;
        if (sr - self.sample_rate).abs() < 1.0 {
            return;
        }
        self.sample_rate = sr;
        let rc = 1.0 / (2.0 * PI * 140.0);
        let dt = 1.0 / sr;
        self.lp_alpha = dt / (rc + dt);
        self.frame_target = ((sr * 0.010).round() as usize).max(64);
        self.frame_samples = 0;
        self.frame_sq_sum = 0.0;
    }

    /// Resets short-term onset history (e.g., on track change) while keeping smooth phase continuity.
    pub fn reset_for_new_track(&mut self) {
        self.recent_intervals.clear();
        self.last_onset_sec = -10.0;
    }

    /// Feeds interleaved audio frames (downmixed to mono internally).
    /// Returns true if a bass-kick beat onset was detected in this buffer.
    pub fn push_mono_samples(&mut self, samples: &[f64]) -> bool {
        let mut onset_hit = false;
        let a = self.lp_alpha;
        for &s in samples {
            self.lp1 += a * (s - self.lp1);
            self.lp2 += a * (self.lp1 - self.lp2);
            self.frame_sq_sum += self.lp2 * self.lp2;
            self.frame_samples += 1;
            if self.frame_samples >= self.frame_target {
                let rms = (self.frame_sq_sum / self.frame_samples as f64).sqrt();
                let hop_sec = self.frame_samples as f64 / self.sample_rate;
                self.frame_samples = 0;
                self.frame_sq_sum = 0.0;
                if self.process_energy_frame(rms, hop_sec) {
                    onset_hit = true;
                }
            }
        }
        onset_hit
    }

    fn process_energy_frame(&mut self, energy: f64, hop_sec: f64) -> bool {
        self.elapsed_sec += hop_sec;

        if energy > 0.0005 {
            self.last_audio_sec = self.elapsed_sec;
        }

        let mut hit = false;
        let since_last = self.elapsed_sec - self.last_onset_sec;

        // Rising bass transient above adaptive rolling floor with 280ms refractory window
        let threshold = (self.avg_energy * 1.42).max(0.0012);
        if since_last >= 0.28 && energy > threshold && energy > self.prev_energy * 1.06 {
            hit = true;
            if since_last < 2.2 {
                // Fold inter-onset interval into natural nodding tempo range [72..152 BPM]
                // => interval in [0.3947s .. 0.8333s]
                let mut norm = since_last;
                while norm < 0.395 {
                    norm *= 2.0;
                }
                while norm > 0.835 {
                    norm *= 0.5;
                }
                if (0.39..=0.84).contains(&norm) {
                    if self.recent_intervals.len() >= 8 {
                        self.recent_intervals.pop_front();
                    }
                    self.recent_intervals.push_back(norm);
                    self.update_bpm_from_intervals();
                }
            }
            self.last_onset_sec = self.elapsed_sec;
            self.nudge_phase_to_downbeat();
        }

        // Slow decay on average energy so sustained bass still lets crisp kicks punch through
        let avg_alpha = if energy > self.avg_energy { 0.14 } else { 0.06 };
        self.avg_energy += avg_alpha * (energy - self.avg_energy);
        self.prev_energy = energy;
        hit
    }

    fn update_bpm_from_intervals(&mut self) {
        if self.recent_intervals.len() < 2 {
            return;
        }
        let mut sorted: Vec<f64> = self.recent_intervals.iter().copied().collect();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let mid = sorted.len() / 2;
        let median_sec = if sorted.len() % 2 == 1 {
            sorted[mid]
        } else {
            0.5 * (sorted[mid - 1] + sorted[mid])
        };
        let target_bpm = (60.0 / median_sec).clamp(72.0, 152.0);
        // Slew smoothly so stray percussion fills never cause jerky jumps
        let slew = if self.recent_intervals.len() <= 3 { 0.45 } else { 0.22 };
        self.bpm += slew * (target_bpm - self.bpm);
    }

    fn nudge_phase_to_downbeat(&mut self) {
        let frac = self.beat_count.fract();
        // Signed distance to nearest integer downbeat in [-0.5 .. +0.5]
        let err = if frac > 0.5 { frac - 1.0 } else { frac };
        // Pull phase smoothly toward exact kick hit (gentle enough never to jump backwards visually)
        if err.abs() <= 0.34 {
            let pull = -err * 0.45;
            self.beat_count = (self.beat_count + pull).max(0.0);
        }
    }

    /// Advances the continuous VSync beat clock by `dt_sec` and returns current state.
    pub fn advance_clock(&mut self, dt_sec: f64) -> BeatClockState {
        let dt = dt_sec.clamp(0.001, 0.05);
        self.beat_count += dt * (self.bpm / 60.0);

        let audio_fresh = (self.elapsed_sec - self.last_audio_sec) < 1.8;
        let target_scale = if audio_fresh { 1.0 } else { 0.62 };
        self.energy_scale += (target_scale - self.energy_scale) * (1.0 - (-6.0 * dt).exp());

        let beat_idx = self.beat_count.floor() as u64;
        let beat_phase = self.beat_count.fract();
        let sway = if ((beat_idx / 8) % 2) == 0 {
            BopSwayKind::HeadNod
        } else {
            BopSwayKind::BeatHop
        };

        BeatClockState {
            bpm: self.bpm,
            beat_count: self.beat_count,
            beat_phase,
            sway,
            energy_scale: self.energy_scale,
        }
    }

    #[cfg(test)]
    pub fn locked_bpm(&self) -> f64 {
        self.bpm
    }
}

/// Computes compact target logical `(dx, dy)` offset for AIDEN's two approved sways:
/// - `HeadNod` (up/down nodding on every beat, `ΔX = 0`, compact `~4px` down-nod)
/// - `BeatHop` (tighter left/right beat hop, `±4.8px` X, light `2.2px` hop arc)
pub fn compute_bop_target_logical(clock: BeatClockState) -> (f64, f64) {
    let amp = clock.energy_scale;
    let beat_idx = clock.beat_count.floor() as u64;
    let phase = clock.beat_phase;

    match clock.sway {
        BopSwayKind::HeadNod => {
            let nod_y = 4.2 * amp;
            let nod_curve = if phase < 0.22 {
                let u = phase / 0.22;
                (u * FRAC_PI_2).sin()
            } else {
                let u = (phase - 0.22) / 0.78;
                (u * FRAC_PI_2).cos() - (u * PI).sin() * 0.16
            };
            (0.0, nod_curve * nod_y - nod_y * 0.14)
        }
        BopSwayKind::BeatHop => {
            let hop_x = 4.8 * amp;
            let hop_y = 2.2 * amp;
            let side = if (beat_idx % 2) == 0 { -1.0 } else { 1.0 };
            let step_ease = 1.0 - (1.0 - (phase * 2.2).min(1.0)).powi(3);
            let x_pos = -side + (2.0 * side) * step_ease;
            let hop_arc = -((phase * 1.7).min(1.0) * PI).sin() * hop_y;
            (x_pos * hop_x, hop_arc + hop_y * 0.25)
        }
    }
}

#[cfg(target_os = "windows")]
pub mod wasapi {
    use windows::Win32::Media::Audio::{
        eConsole, eRender, IAudioCaptureClient, IAudioClient, IMMDeviceEnumerator,
        MMDeviceEnumerator, AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK, WAVEFORMATEX, WAVEFORMATEXTENSIBLE,
    };
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoTaskMemFree, CLSCTX_ALL, COINIT_MULTITHREADED,
    };

    const WAVE_FORMAT_PCM: u16 = 1;
    const WAVE_FORMAT_IEEE_FLOAT: u16 = 3;
    const WAVE_FORMAT_EXTENSIBLE: u16 = 0xFFFE;
    // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = {00000003-0000-0010-8000-00aa00389b71}
    const SUBTYPE_IEEE_FLOAT_DATA1: u32 = 3;

    #[derive(Clone, Copy, Debug)]
    enum SampleFmt {
        Float32,
        Int16,
    }

    /// Lightweight non-blocking Windows WASAPI loopback audio reader.
    pub struct LoopbackReader {
        client: IAudioClient,
        capture: IAudioCaptureClient,
        channels: usize,
        sample_rate: u32,
        fmt: SampleFmt,
        mono_scratch: Vec<f64>,
    }

    impl LoopbackReader {
        pub fn open() -> Option<Self> {
            unsafe {
                let _ = CoInitializeEx(None, COINIT_MULTITHREADED);

                let enumerator: IMMDeviceEnumerator =
                    CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL).ok()?;
                let device = enumerator
                    .GetDefaultAudioEndpoint(eRender, eConsole)
                    .ok()?;
                let client: IAudioClient = device.Activate(CLSCTX_ALL, None).ok()?;
                let mix_ptr: *mut WAVEFORMATEX = client.GetMixFormat().ok()?;
                if mix_ptr.is_null() {
                    return None;
                }

                let wf = *mix_ptr;
                let channels = (wf.nChannels as usize).max(1);
                let sample_rate = wf.nSamplesPerSec.max(8000);

                let fmt = if wf.wFormatTag == WAVE_FORMAT_IEEE_FLOAT && wf.wBitsPerSample == 32 {
                    Some(SampleFmt::Float32)
                } else if wf.wFormatTag == WAVE_FORMAT_PCM && wf.wBitsPerSample == 16 {
                    Some(SampleFmt::Int16)
                } else if wf.wFormatTag == WAVE_FORMAT_EXTENSIBLE && wf.wBitsPerSample == 32 {
                    let ext = &*(mix_ptr as *const WAVEFORMATEXTENSIBLE);
                    let sub_data1 = std::ptr::addr_of!(ext.SubFormat.data1).read_unaligned();
                    if sub_data1 == SUBTYPE_IEEE_FLOAT_DATA1 {
                        Some(SampleFmt::Float32)
                    } else {
                        None
                    }
                } else if wf.wFormatTag == WAVE_FORMAT_EXTENSIBLE && wf.wBitsPerSample == 16 {
                    Some(SampleFmt::Int16)
                } else {
                    None
                };

                // 50ms shared loopback buffer (100ns units: 500_000)
                let init_res = client.Initialize(
                    AUDCLNT_SHAREMODE_SHARED,
                    AUDCLNT_STREAMFLAGS_LOOPBACK,
                    500_000,
                    0,
                    mix_ptr,
                    None,
                );
                CoTaskMemFree(Some(mix_ptr as *const _));

                let fmt = fmt?;
                init_res.ok()?;

                let capture: IAudioCaptureClient = client.GetService().ok()?;
                client.Start().ok()?;

                Some(Self {
                    client,
                    capture,
                    channels,
                    sample_rate,
                    fmt,
                    mono_scratch: Vec::with_capacity(2048),
                })
            }
        }

        pub fn sample_rate(&self) -> u32 {
            self.sample_rate
        }

        /// Drains all currently queued loopback packets into mono f64 samples.
        /// Returns `None` if the audio device was invalidated/disconnected.
        pub fn drain_mono(&mut self) -> Option<&[f64]> {
            self.mono_scratch.clear();
            unsafe {
                loop {
                    let packet_len = self.capture.GetNextPacketSize().ok()?;
                    if packet_len == 0 {
                        break;
                    }
                    let mut data_ptr = std::ptr::null_mut();
                    let mut num_frames = 0u32;
                    let mut flags = 0u32;
                    self.capture
                        .GetBuffer(&mut data_ptr, &mut num_frames, &mut flags, None, None)
                        .ok()?;

                    let frames = num_frames as usize;
                    let is_silent = (flags & (AUDCLNT_BUFFERFLAGS_SILENT.0 as u32)) != 0 || data_ptr.is_null();

                    if is_silent {
                        self.mono_scratch.resize(self.mono_scratch.len() + frames, 0.0);
                    } else {
                        let ch = self.channels;
                        let inv_ch = 1.0 / ch as f64;
                        match self.fmt {
                            SampleFmt::Float32 => {
                                let slice = std::slice::from_raw_parts(
                                    data_ptr as *const f32,
                                    frames * ch,
                                );
                                for f in 0..frames {
                                    let mut sum = 0.0f64;
                                    let base = f * ch;
                                    for c in 0..ch {
                                        sum += slice[base + c] as f64;
                                    }
                                    self.mono_scratch.push(sum * inv_ch);
                                }
                            }
                            SampleFmt::Int16 => {
                                let slice = std::slice::from_raw_parts(
                                    data_ptr as *const i16,
                                    frames * ch,
                                );
                                for f in 0..frames {
                                    let mut sum = 0.0f64;
                                    let base = f * ch;
                                    for c in 0..ch {
                                        sum += (slice[base + c] as f64) / 32768.0;
                                    }
                                    self.mono_scratch.push(sum * inv_ch);
                                }
                            }
                        }
                    }

                    let _ = self.capture.ReleaseBuffer(num_frames);
                    // Avoid unbounded buffer buildup if system stalled
                    if self.mono_scratch.len() >= 16384 {
                        break;
                    }
                }
            }
            Some(&self.mono_scratch)
        }
    }

    impl Drop for LoopbackReader {
        fn drop(&mut self) {
            unsafe {
                let _ = self.client.Stop();
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{compute_bop_target_logical, BassBeatTracker, BeatClockState, BopSwayKind};
    use std::f64::consts::PI;

    fn synth_kick_train(bpm: f64, sr: u32, seconds: f64) -> Vec<f64> {
        let total = (sr as f64 * seconds) as usize;
        let beat_samples = (sr as f64 * 60.0 / bpm).round() as usize;
        let mut buf = vec![0.0f64; total];
        for i in 0..total {
            let pos = i % beat_samples;
            let t = pos as f64 / sr as f64;
            // Short 65Hz kick thump decaying over ~85ms
            if t < 0.095 {
                let env = (-t * 36.0).exp();
                buf[i] = (2.0 * PI * 65.0 * t).sin() * env * 0.85;
            }
        }
        buf
    }

    #[test]
    fn bass_tracker_locks_across_distinct_song_tempos() {
        let sr = 48_000;
        for &target_bpm in &[82.0, 105.0, 123.0, 142.0] {
            let mut tracker = BassBeatTracker::new(sr);
            let samples = synth_kick_train(target_bpm, sr, 9.0);
            for chunk in samples.chunks(960) {
                tracker.push_mono_samples(chunk);
                tracker.advance_clock(960.0 / sr as f64);
            }
            let est = tracker.locked_bpm();
            assert!(
                (est - target_bpm).abs() <= 4.0,
                "Expected BPM ~{}, got {:.2}",
                target_bpm,
                est
            );
        }
    }

    #[test]
    fn silence_never_panics_and_coasts_gently() {
        let mut tracker = BassBeatTracker::new(48_000);
        let silence = vec![0.0f64; 4800];
        assert!(!tracker.push_mono_samples(&silence));
        let st = tracker.advance_clock(0.016);
        assert!(st.bpm >= 72.0 && st.bpm <= 152.0);
        assert!(st.energy_scale <= 0.80);
    }

    #[test]
    fn bop_offsets_stay_compact_and_autoswitch_every_8_beats() {
        let nod = compute_bop_target_logical(BeatClockState {
            bpm: 105.0,
            beat_count: 2.22,
            beat_phase: 0.22,
            sway: BopSwayKind::HeadNod,
            energy_scale: 1.0,
        });
        assert_eq!(nod.0, 0.0);
        assert!(nod.1 > 2.5 && nod.1 <= 4.5);

        let hop = compute_bop_target_logical(BeatClockState {
            bpm: 105.0,
            beat_count: 9.5,
            beat_phase: 0.5,
            sway: BopSwayKind::BeatHop,
            energy_scale: 1.0,
        });
        assert!(hop.0.abs() <= 5.0);
        assert!(hop.1.abs() <= 3.0);
    }
}
