//! Native Windows Raycast-grade unified search index for AIDEN:
//! - Merges Start Menu `.lnk` shortcuts (`ProgramData` + `%APPDATA%`), UWP/Store/PWA apps
//!   (`shell:AppsFolder`), Registry `App Paths`, and core Windows administrative utilities.
//! - Queries Voidtools Everything CLI (`es.exe /a-d` — strictly files only, zero folders)
//!   with automatic noise filtering and graceful fallback when Everything IPC is offline.
//! - Extracts crisp native 48x48 Windows 11 icons via Win32 Shell (`IShellItemImageFactory` +
//!   `SHGetFileInfoW`) with an in-memory + on-disk PNG cache.
//! - Tracks frecency & recent launches in `%LOCALAPPDATA%\AidenAssistant\recent_searches.json`.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub const MAX_APPS_RESULTS: usize = 5;
pub const MAX_FILES_RESULTS: usize = 5;
pub const MAX_RECENTS: usize = 8;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchItem {
    pub id: String,
    pub name: String,
    pub subtitle: String,
    /// `"App" | "System" | "File" | "Program"`
    pub kind: String,
    /// `"path" | "aumid"`
    pub launch_kind: String,
    pub target: String,
    pub icon_key: String,
    pub icon_data_url: Option<String>,
    #[serde(default)]
    pub aliases: Vec<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub query: String,
    /// `"recents" | "search"`
    pub mode: String,
    pub recents: Vec<SearchItem>,
    pub apps: Vec<SearchItem>,
    pub files: Vec<SearchItem>,
    pub everything_available: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
struct PersistedRecents {
    recents: Vec<SearchItem>,
    frecency: HashMap<String, u32>,
}

pub struct SearchIndexManager {
    apps: Mutex<Vec<SearchItem>>,
    recents: Mutex<PersistedRecents>,
    icon_cache: Mutex<HashMap<String, Option<String>>>,
    data_dir: PathBuf,
    icon_cache_dir: PathBuf,
}

impl SearchIndexManager {
    pub fn new(data_dir: PathBuf) -> Arc<Self> {
        let icon_cache_dir = data_dir.join("icon_cache");
        let _ = std::fs::create_dir_all(&icon_cache_dir);
        let persisted = load_recents(&data_dir);

        let mgr = Arc::new(Self {
            apps: Mutex::new(Vec::new()),
            recents: Mutex::new(persisted),
            icon_cache: Mutex::new(HashMap::new()),
            data_dir,
            icon_cache_dir,
        });

        // Immediately populate fast local Start Menu + core tools (< 10ms), then merge
        // UWP/Store apps + App Paths & pre-warm top icons in background.
        let bg = Arc::clone(&mgr);
        std::thread::spawn(move || {
            bg.rebuild_app_index();
        });

        mgr
    }

    pub fn rebuild_app_index(&self) {
        let mut collected: Vec<SearchItem> = Vec::new();

        // 1. Instant Rust walk of Start Menu .lnk shortcuts (all users + current user)
        #[cfg(target_os = "windows")]
        {
            if let Ok(program_data) = std::env::var("ProgramData") {
                let p = PathBuf::from(program_data)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs");
                scan_start_menu_dir(&p, &mut collected);
            }
            if let Ok(app_data) = std::env::var("APPDATA") {
                let p = PathBuf::from(app_data)
                    .join("Microsoft")
                    .join("Windows")
                    .join("Start Menu")
                    .join("Programs");
                scan_start_menu_dir(&p, &mut collected);
            }
        }

        // 2. Curated Windows system utilities with power-user aliases (regedit, svc, taskmgr, wt...)
        #[cfg(target_os = "windows")]
        collected.extend(curated_system_tools());

        // Publish fast initial list immediately so search works within milliseconds of app launch
        let initial_merged = deduplicate_apps(collected.clone());
        if let Ok(mut guard) = self.apps.lock() {
            *guard = initial_merged;
        }

        // 3. Merge UWP/Store/PWA apps (Get-StartApps) + Registry App Paths
        #[cfg(target_os = "windows")]
        {
            let ps_apps = scan_start_apps_and_registry();
            collected.extend(ps_apps);
            let final_merged = deduplicate_apps(collected);
            println!(
                "[SEARCH_INDEX] Unified app index ready: {} deduplicated apps & system tools.",
                final_merged.len()
            );
            if let Ok(mut guard) = self.apps.lock() {
                *guard = final_merged;
            }
        }

        // 4. Warm icons for recents + first batch of popular apps silently in background
        let to_warm: Vec<SearchItem> = {
            let mut list = Vec::new();
            if let Ok(r) = self.recents.lock() {
                list.extend(r.recents.iter().cloned());
            }
            if let Ok(a) = self.apps.lock() {
                list.extend(a.iter().take(24).cloned());
            }
            list
        };
        for item in to_warm {
            let _ = self.resolve_icon(&item);
        }
    }

    /// Runs a unified search:
    /// - Empty query -> returns Recents (up to 6).
    /// - Non-empty query -> strictly matched Apps (max 5) + optional Everything CLI Files (max 5).
    pub fn search(&self, raw_query: &str, include_files: bool) -> SearchResponse {
        let trimmed = raw_query.trim();
        let frecency_snap = self
            .recents
            .lock()
            .map(|r| r.frecency.clone())
            .unwrap_or_default();

        if trimmed.is_empty() {
            let mut recent_items: Vec<SearchItem> = self
                .recents
                .lock()
                .map(|r| r.recents.iter().take(6).cloned().collect())
                .unwrap_or_default();
            for item in &mut recent_items {
                item.icon_data_url = self.resolve_icon(item);
            }
            return SearchResponse {
                query: String::new(),
                mode: "recents".to_string(),
                recents: recent_items,
                apps: Vec::new(),
                files: Vec::new(),
                everything_available: is_es_installed(),
            };
        }

        // 1. Sub-millisecond in-memory app filtering (strict relevance, never pads fake rows)
        let mut matched_apps: Vec<(i32, SearchItem)> = {
            let guard = self.apps.lock().ok();
            match guard {
                Some(list) => list
                    .iter()
                    .filter_map(|item| {
                        let frec = *frecency_snap.get(&item.id).unwrap_or(&0);
                        let score = score_search_item(item, trimmed, frec);
                        if score > 0 {
                            Some((score, item.clone()))
                        } else {
                            None
                        }
                    })
                    .collect(),
                None => Vec::new(),
            }
        };

        matched_apps.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
        let mut top_apps: Vec<SearchItem> = matched_apps
            .into_iter()
            .take(MAX_APPS_RESULTS)
            .map(|(_, item)| item)
            .collect();

        // 2. Everything CLI (`es.exe /a-d`) file search (files only, zero folders, skipped for AI sentences)
        let (mut top_files, everything_ok) = if include_files && should_query_files(trimmed) {
            query_everything_files(trimmed, &frecency_snap)
        } else {
            (Vec::new(), is_es_installed())
        };

        // 3. Populate crisp native icons for ONLY the <= 10 visible results
        for item in &mut top_apps {
            item.icon_data_url = self.resolve_icon(item);
        }
        for item in &mut top_files {
            item.icon_data_url = self.resolve_icon(item);
        }

        SearchResponse {
            query: trimmed.to_string(),
            mode: "search".to_string(),
            recents: Vec::new(),
            apps: top_apps,
            files: top_files,
            everything_available: everything_ok,
        }
    }

    pub fn launch_item(
        &self,
        item: &SearchItem,
        reveal_in_explorer: bool,
        run_as_admin: bool,
    ) -> Result<(), String> {
        #[cfg(target_os = "windows")]
        {
            if reveal_in_explorer && item.launch_kind == "path" {
                let mut cmd = Command::new("explorer.exe");
                cmd.arg(format!("/select,{}", item.target));
                cmd.creation_flags(CREATE_NO_WINDOW);
                cmd.spawn()
                    .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
            } else {
                shell_launch_windows(&item.launch_kind, &item.target, &item.kind, run_as_admin)?;
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (item, reveal_in_explorer, run_as_admin);
        }

        self.record_launch(item);

        // Teach Everything's native run-count ranking when launching files
        #[cfg(target_os = "windows")]
        if item.launch_kind == "path" && !reveal_in_explorer && (item.kind == "File" || item.kind == "Program") {
            let target_path = item.target.clone();
            std::thread::spawn(move || {
                if let Some(es) = find_es_exe() {
                    let mut cmd = Command::new(es);
                    cmd.args(["-inc-run-count", &target_path])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .creation_flags(CREATE_NO_WINDOW);
                    let _ = cmd.status();
                }
            });
        }

        Ok(())
    }

    pub fn record_launch(&self, item: &SearchItem) {
        let mut clean_item = item.clone();
        clean_item.icon_data_url = None; // Don't bloat recents JSON with base64 PNGs

        if let Ok(mut guard) = self.recents.lock() {
            let count = guard.frecency.entry(clean_item.id.clone()).or_insert(0);
            *count = count.saturating_add(1);

            guard.recents.retain(|r| r.id != clean_item.id);
            guard.recents.insert(0, clean_item);
            guard.recents.truncate(MAX_RECENTS);

            save_recents(&self.data_dir, &guard);
        }
    }

    fn resolve_icon(&self, item: &SearchItem) -> Option<String> {
        let key = &item.icon_key;
        if let Ok(cache) = self.icon_cache.lock() {
            if let Some(existing) = cache.get(key) {
                return existing.clone();
            }
        }

        // Check on-disk PNG cache first
        let cache_file = self.icon_cache_dir.join(format!("{:016x}.png", fnv1a_64(key.as_bytes())));
        if let Ok(bytes) = std::fs::read(&cache_file) {
            if !bytes.is_empty() {
                let data_url = encode_png_data_url(&bytes);
                if let Ok(mut cache) = self.icon_cache.lock() {
                    cache.insert(key.clone(), Some(data_url.clone()));
                }
                return Some(data_url);
            }
        }

        // Extract natively via Windows Shell
        #[cfg(target_os = "windows")]
        let png_bytes = extract_native_icon_png(item);
        #[cfg(not(target_os = "windows"))]
        let png_bytes: Option<Vec<u8>> = None;

        let data_url = png_bytes.map(|bytes| {
            let _ = std::fs::write(&cache_file, &bytes);
            encode_png_data_url(&bytes)
        });

        if let Ok(mut cache) = self.icon_cache.lock() {
            cache.insert(key.clone(), data_url.clone());
        }
        data_url
    }
}

fn encode_png_data_url(png_bytes: &[u8]) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    format!("data:image/png;base64,{}", STANDARD.encode(png_bytes))
}

fn fnv1a_64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf29ce484222325;
    for &b in bytes {
        hash ^= b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    hash
}

fn load_recents(data_dir: &Path) -> PersistedRecents {
    let path = data_dir.join("recent_searches.json");
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<PersistedRecents>(&s).ok())
        .unwrap_or_default()
}

fn save_recents(data_dir: &Path, data: &PersistedRecents) {
    let _ = std::fs::create_dir_all(data_dir);
    let path = data_dir.join("recent_searches.json");
    if let Ok(json) = serde_json::to_string_pretty(data) {
        let _ = std::fs::write(path, json);
    }
}

/// Cleans noisy trademark symbols & `.exe` suffixes from app display names.
pub fn clean_app_name(raw: &str) -> String {
    let mut s = raw
        .replace('®', "")
        .replace('™', "")
        .replace('\u{2122}', "")
        .trim()
        .to_string();
    if s.to_ascii_lowercase().ends_with(".exe") && s.len() > 4 {
        s.truncate(s.len() - 4);
    }
    s.trim().to_string()
}

/// Filters out noisy Start Menu shortcuts (uninstallers, help docs, web links).
pub fn is_noisy_shortcut_name(name: &str) -> bool {
    let lower = name.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return true;
    }
    let blocked_substrings = [
        "uninstall",
        "readme",
        "read me",
        "release notes",
        "documentation",
        "user guide",
        "user manual",
        "manual",
        "license",
        "licence",
        "website",
        "web site",
        "visit ",
        "help ",
        " help",
        "about ",
        "check for updates",
        "online support",
        "feedback hub",
        "get started",
    ];
    if lower == "help" || lower == "readme" || lower == "uninstall" {
        return true;
    }
    blocked_substrings.iter().any(|b| lower.contains(b))
}

/// Determines whether a query looks like a file/app search vs a conversational AI prompt.
pub fn should_query_files(query: &str) -> bool {
    let q = query.trim();
    if q.len() < 2 || q.len() > 64 {
        return false;
    }
    if q.contains('?') || q.contains('\n') {
        return false;
    }
    let word_count = q.split_whitespace().count();
    word_count <= 4
}

fn split_search_words(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut current = String::new();
    let mut prev_was_lower = false;

    for ch in text.chars() {
        if !ch.is_ascii_alphanumeric() {
            if !current.is_empty() {
                words.push(std::mem::take(&mut current));
            }
            prev_was_lower = false;
            continue;
        }
        let is_upper = ch.is_ascii_uppercase();
        if is_upper && prev_was_lower && !current.is_empty() {
            words.push(std::mem::take(&mut current));
        }
        current.push(ch.to_ascii_lowercase());
        prev_was_lower = ch.is_ascii_lowercase();
    }
    if !current.is_empty() {
        words.push(current);
    }
    words
}

/// Optimal string alignment Damerau-Levenshtein edit distance (insertion, deletion,
/// substitution, and adjacent character transposition each cost 1).
pub fn damerau_levenshtein_ascii(a: &str, b: &str) -> usize {
    let a_bytes = a.as_bytes();
    let b_bytes = b.as_bytes();
    let m = a_bytes.len();
    let n = b_bytes.len();
    if m == 0 {
        return n;
    }
    if n == 0 {
        return m;
    }

    let width = n + 1;
    let mut dp = vec![0usize; (m + 1) * width];
    for i in 0..=m {
        dp[i * width] = i;
    }
    for j in 0..=n {
        dp[j] = j;
    }

    for i in 1..=m {
        for j in 1..=n {
            let cost = usize::from(a_bytes[i - 1] != b_bytes[j - 1]);
            let del = dp[(i - 1) * width + j] + 1;
            let ins = dp[i * width + (j - 1)] + 1;
            let sub = dp[(i - 1) * width + (j - 1)] + cost;
            let mut best = del.min(ins).min(sub);

            if i > 1
                && j > 1
                && a_bytes[i - 1] == b_bytes[j - 2]
                && a_bytes[i - 2] == b_bytes[j - 1]
            {
                best = best.min(dp[(i - 2) * width + (j - 2)] + 1);
            }
            dp[i * width + j] = best;
        }
    }
    dp[m * width + n]
}

/// Word-start anchored subsequence match (e.g. "ytube" -> "youtube", "pwsh" -> "powershell").
/// Requires the first character to anchor at the start of the candidate word and high contiguous density.
fn score_subsequence_word(q: &str, candidate: &str) -> i32 {
    let qb = q.as_bytes();
    let cb = candidate.as_bytes();
    if qb.len() < 3 || cb.len() <= qb.len() || qb[0] != cb[0] {
        return 0;
    }
    // Coverage guard: prevent short queries from matching very long unrelated filenames
    if (qb.len() * 100) / cb.len() < 45 {
        return 0;
    }

    let mut qi = 0usize;
    let mut prev_match_ci: Option<usize> = None;
    let mut consecutive = 0usize;

    for (ci, &c) in cb.iter().enumerate() {
        if qi < qb.len() && c == qb[qi] {
            if let Some(prev) = prev_match_ci {
                if ci == prev + 1 {
                    consecutive += 1;
                }
            }
            prev_match_ci = Some(ci);
            qi += 1;
        }
    }

    if qi == qb.len() && consecutive + 1 >= qb.len().saturating_sub(1) {
        555 + (consecutive.min(6) as i32) * 6
    } else {
        0
    }
}

/// Typo-tolerant token matcher against a single candidate word or alias.
/// Handles substitutions ("youtune" -> "youtube"), transpositions ("spoitfy" -> "spotify"),
/// missing/extra chars ("calclator" -> "calculator"), and in-progress prefix typos ("youtun" -> "youtub").
fn score_fuzzy_typo_token(q: &str, candidate: &str) -> i32 {
    if !q.is_ascii() || !candidate.is_ascii() {
        return 0;
    }
    let qlen = q.len();
    let clen = candidate.len();
    if qlen < 4 || clen < 3 {
        return 0;
    }

    let qb = q.as_bytes();
    let cb = candidate.as_bytes();
    let common_prefix = qb
        .iter()
        .zip(cb.iter())
        .take_while(|(a, b)| a == b)
        .count();

    let first_two_transposed = qlen >= 5
        && clen >= 5
        && qb[0] == cb[1]
        && qb[1] == cb[0]
        && qb[2] == cb[2];

    // Anchor start of word so mid-word substrings like "yout" vs "layout" never match
    if common_prefix < 2 && !first_two_transposed {
        return 0;
    }

    // 1. Full word edit distance
    if qlen.abs_diff(clen) <= 2 {
        let dist = damerau_levenshtein_ascii(q, candidate);
        if dist == 1 {
            return 615 + (common_prefix.min(6) as i32) * 6;
        }
        if dist == 2 && qlen >= 6 && common_prefix >= 3 {
            return 525 + (common_prefix.min(6) as i32) * 5;
        }
    }

    // 2. Prefix edit distance (user is mid-typing a longer word with a 1-char slip, e.g. "youtun" -> "youtube")
    if clen > qlen {
        let cand_pref = &candidate[..qlen];
        let dist_pref = damerau_levenshtein_ascii(q, cand_pref);
        if dist_pref == 1 && common_prefix >= 2 {
            return 585 + (common_prefix.min(6) as i32) * 5;
        }
        if dist_pref == 2 && qlen >= 7 && common_prefix >= 3 {
            return 505 + (common_prefix.min(6) as i32) * 4;
        }
    }

    // 3. Prefix with 1 skipped letter (e.g. "calcl" -> "calcul" prefix of "calculator")
    if qlen >= 5 && clen > qlen + 1 && common_prefix >= 3 {
        let cand_pref_plus = &candidate[..qlen + 1];
        if damerau_levenshtein_ascii(q, cand_pref_plus) == 1 {
            return 560 + (common_prefix.min(6) as i32) * 4;
        }
    }

    0
}

/// Strict relevance scorer (returns `0` on non-match — never pads fake filler rows!).
pub fn score_search_item(item: &SearchItem, query: &str, frecency: u32) -> i32 {
    let q = query.trim().to_ascii_lowercase();
    if q.is_empty() || q.contains('?') || q.contains('\n') {
        return 0;
    }

    let name = item.name.to_ascii_lowercase();
    let frec_boost = (frecency.min(20) as i32) * 8;
    let is_single_token = !q.contains(' ');

    // 1. Exact match on display name or alias
    if name == q || item.aliases.iter().any(|a| a.eq_ignore_ascii_case(&q)) {
        return 1000 + frec_boost;
    }

    // 2. Prefix match on display name
    if name.starts_with(&q) {
        return 880 + frec_boost;
    }

    // 3. Prefix match on any alias (e.g. "reged" -> "regedit" -> Registry Editor, "svc" -> Services)
    if item
        .aliases
        .iter()
        .any(|a| a.to_ascii_lowercase().starts_with(&q))
    {
        return 820 + frec_boost;
    }

    // 4. Word-start match (e.g. "edge" -> "Microsoft Edge", "tube" -> "YouTube")
    let raw_words: Vec<&str> = name
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let words = split_search_words(&item.name);
    if is_single_token
        && (raw_words.iter().any(|w| w.starts_with(&q)) || words.iter().any(|w| w.starts_with(&q)))
    {
        return 760 + frec_boost;
    }

    // 5. Multi-word token-prefix & typo-tolerant match (e.g. "mic edg" -> "Microsoft Edge")
    if !is_single_token {
        let q_tokens: Vec<&str> = q.split_whitespace().collect();
        if q_tokens.len() <= 3 {
            if q_tokens.iter().all(|qt| {
                raw_words.iter().any(|w| w.starts_with(qt))
                    || words.iter().any(|w| w.starts_with(qt))
            }) {
                return 700 + frec_boost;
            }
            if q_tokens.iter().all(|qt| {
                raw_words
                    .iter()
                    .any(|w| w.starts_with(qt) || score_fuzzy_typo_token(qt, w) > 0)
                    || words
                        .iter()
                        .any(|w| w.starts_with(qt) || score_fuzzy_typo_token(qt, w) > 0)
            }) {
                return 570 + frec_boost;
            }
        }
        return 0;
    }

    // 6. Acronym match for short queries (e.g. "vsc" -> Visual Studio Code, "wt" -> Windows Terminal)
    if q.len() >= 2 && q.len() <= 5 {
        let initials: String = raw_words.iter().filter_map(|w| w.chars().next()).collect();
        let camel_initials: String = words.iter().filter_map(|w| w.chars().next()).collect();
        if initials.starts_with(&q) || camel_initials.starts_with(&q) {
            return 660 + frec_boost;
        }
    }

    // 7. Typo-tolerant Damerau-Levenshtein & word-anchored subsequence fuzzy match
    //    (e.g. "youtune" -> "YouTube", "spoitfy" -> "Spotify", "databeses" -> "...DATABASES.pdf")
    let mut best_fuzzy = 0;
    for w in &raw_words {
        best_fuzzy = best_fuzzy
            .max(score_fuzzy_typo_token(&q, w))
            .max(score_subsequence_word(&q, w));
    }
    for w in &words {
        best_fuzzy = best_fuzzy
            .max(score_fuzzy_typo_token(&q, w))
            .max(score_subsequence_word(&q, w));
    }
    for alias in &item.aliases {
        let al = alias.to_ascii_lowercase();
        for aw in al
            .split(|c: char| !c.is_ascii_alphanumeric())
            .filter(|s| !s.is_empty())
        {
            best_fuzzy = best_fuzzy
                .max(score_fuzzy_typo_token(&q, aw))
                .max(score_subsequence_word(&q, aw));
        }
    }
    if best_fuzzy > 0 {
        return best_fuzzy + frec_boost;
    }

    // 8. Substring fallback (only for 5+ char app queries; files strictly require word-prefix match)
    if q.len() >= 5 && item.kind != "File" && name.contains(&q) {
        return 540 + frec_boost;
    }
    if q.len() >= 5
        && item.kind != "File"
        && item
            .aliases
            .iter()
            .any(|a| a.to_ascii_lowercase().contains(&q))
    {
        return 480 + frec_boost;
    }

    0
}

/// Filters noisy system/cache/dev-build file paths returned by Everything CLI.
pub fn is_noisy_file_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let blocked_segments = [
        "\\$recycle.bin\\",
        "\\system volume information\\",
        "\\windows\\",
        "\\programdata\\",
        "\\appdata\\",
        "\\.vscode\\extensions\\",
        "\\.cursor\\extensions\\",
        "\\site-packages\\",
        "\\dist-packages\\",
        "\\anaconda3\\",
        "\\miniconda3\\",
        "\\pkgs\\",
        "\\.rustup\\",
        "\\.gradle\\",
        "\\.m2\\",
        "\\.nuget\\",
        "\\windows\\winsxs\\",
        "\\windows\\servicing\\",
        "\\windows\\installer\\",
        "\\windows\\prefetch\\",
        "\\windows\\softwaredistribution\\",
        "\\windows\\assembly\\",
        "\\windows\\system32\\catroot",
        "\\windows\\system32\\driverstore\\",
        "\\appdata\\local\\temp\\",
        "\\appdata\\local\\packages\\",
        "\\appdata\\local\\microsoft\\windows\\inetcache\\",
        "\\appdata\\local\\microsoft\\windows\\webcache\\",
        "\\appdata\\local\\google\\chrome\\user data\\",
        "\\appdata\\local\\microsoft\\edge\\user data\\",
        "\\appdata\\roaming\\microsoft\\windows\\recent\\",
        "\\programdata\\microsoft\\windows\\start menu\\",
        "\\appdata\\roaming\\microsoft\\windows\\start menu\\",
        "\\node_modules\\",
        "\\.git\\",
        "\\__pycache__\\",
        "\\.venv\\",
        "\\venv\\",
        "\\target\\debug\\",
        "\\target\\release\\",
        "\\.cargo\\registry\\",
    ];
    if blocked_segments.iter().any(|seg| lower.contains(seg)) {
        return true;
    }

    let blocked_exts = [
        ".tmp", ".temp", ".log", ".etl", ".pf", ".mui", ".dll", ".sys", ".cat", ".cab", ".lnk",
        ".ini", ".dat", ".db", ".db-wal", ".db-shm", ".db-journal", ".sqlite-wal",
        ".sqlite-journal", ".journal", ".lock", ".idx", ".pack", ".toc", ".bak", ".old", ".orig",
        ".cache", ".map", ".d.ts", ".min.js", ".min.css", ".manifest", ".mum", ".cdf-ms", ".pyc",
        ".pyo", ".o", ".obj", ".pdb", ".d", ".rmeta", ".rlib",
    ];
    blocked_exts.iter().any(|ext| lower.ends_with(ext))
}

/// Scores file usefulness by extension tier and directory signal so real documents
/// (PDFs, Office files, notes, user folders) outrank extension SVGs and clutter.
pub fn file_priority_adjustment(path: &str, ext: &str) -> i32 {
    let lower_ext = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    let lower_path = path.to_ascii_lowercase();

    let ext_bonus = match lower_ext.as_str() {
        // Tier 1: Primary documents, spreadsheets, presentations & e-books
        "pdf" | "docx" | "doc" | "xlsx" | "xls" | "pptx" | "ppt" | "odt" | "ods" | "odp"
        | "epub" => 180,
        // Tier 2: Notes, text, notebooks & data tables
        "md" | "txt" | "csv" | "rtf" | "ipynb" | "tex" => 135,
        // Tier 3: Programs, source code & scripts
        "exe" | "msi" | "py" | "rs" | "ts" | "tsx" | "js" | "jsx" | "go" | "java" | "c"
        | "cpp" | "h" | "cs" | "sql" | "sh" | "ps1" | "bat" | "html" | "css" | "json"
        | "yaml" | "yml" | "toml" => 95,
        // Tier 4: User photos, videos, audio & archives
        "png" | "jpg" | "jpeg" | "webp" | "gif" | "mp4" | "mkv" | "mov" | "mp3" | "wav"
        | "flac" | "m4a" | "zip" | "7z" | "rar" | "tar" | "gz" => 65,
        // Tier 5: Vector/icon/font/XML asset files
        "svg" | "ico" | "cur" | "ttf" | "otf" | "woff" | "woff2" | "eot" | "xml"
        | "plist" => -120,
        _ => 0,
    };

    let user_folders = [
        "\\documents\\",
        "\\my documents\\",
        "\\desktop\\",
        "\\downloads\\",
        "\\my projects\\",
        "\\projects\\",
        "\\pictures\\",
        "\\videos\\",
        "\\music\\",
        "\\onedrive\\",
    ];
    let mut path_bonus = 0;
    if user_folders.iter().any(|seg| lower_path.contains(seg)) {
        path_bonus += 95;
    }
    if lower_path.contains("\\.") {
        path_bonus -= 160;
    }

    ext_bonus + path_bonus
}

fn app_priority(item: &SearchItem) -> u8 {
    if item.launch_kind == "path" && item.target.to_ascii_lowercase().ends_with(".lnk") {
        3
    } else if item.launch_kind == "aumid" {
        2
    } else {
        1
    }
}

pub fn deduplicate_apps(items: Vec<SearchItem>) -> Vec<SearchItem> {
    let mut by_key: HashMap<String, SearchItem> = HashMap::new();

    for mut item in items {
        let norm_name = item.name.trim().to_ascii_lowercase();
        if norm_name.is_empty() {
            continue;
        }
        if let Some(existing) = by_key.get_mut(&norm_name) {
            // Merge aliases from both sources
            let mut merged_aliases: HashSet<String> = existing
                .aliases
                .iter()
                .chain(item.aliases.iter())
                .map(|a| a.to_ascii_lowercase())
                .collect();
            merged_aliases.insert(norm_name.clone());
            let mut alias_vec: Vec<String> = merged_aliases.into_iter().collect();
            alias_vec.sort();

            if app_priority(&item) > app_priority(existing) {
                item.aliases = alias_vec;
                *existing = item;
            } else {
                existing.aliases = alias_vec;
            }
        } else {
            by_key.insert(norm_name, item);
        }
    }

    let mut out: Vec<SearchItem> = by_key.into_values().collect();
    out.sort_by(|a, b| a.name.to_ascii_lowercase().cmp(&b.name.to_ascii_lowercase()));
    out
}

#[cfg(target_os = "windows")]
fn scan_start_menu_dir(dir: &Path, out: &mut Vec<SearchItem>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            scan_start_menu_dir(&path, out);
            continue;
        }
        let is_lnk = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("lnk"))
            .unwrap_or(false);
        if !is_lnk {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        let display = clean_app_name(stem);
        if display.is_empty() || is_noisy_shortcut_name(&display) {
            continue;
        }

        let full_path = path.to_string_lossy().to_string();
        let lower_path = full_path.to_ascii_lowercase();
        let is_system = lower_path.contains("\\administrative tools\\")
            || lower_path.contains("\\windows system\\")
            || lower_path.contains("\\windows accessories\\")
            || lower_path.contains("\\windows powershell\\");
        let kind = if is_system { "System" } else { "App" };
        let subtitle = if is_system {
            "Windows System Tool · Start Menu".to_string()
        } else {
            "App · Start Menu".to_string()
        };

        let key = display.to_ascii_lowercase();
        out.push(SearchItem {
            id: format!("app:{}", key),
            name: display,
            subtitle,
            kind: kind.to_string(),
            launch_kind: "path".to_string(),
            target: full_path.clone(),
            icon_key: format!("path:{}", full_path.to_ascii_lowercase()),
            icon_data_url: None,
            aliases: vec![key],
        });
    }
}

#[cfg(target_os = "windows")]
fn curated_system_tools() -> Vec<SearchItem> {
    let sys32 = std::env::var("SystemRoot")
        .map(|r| PathBuf::from(r).join("System32"))
        .unwrap_or_else(|_| PathBuf::from(r"C:\Windows\System32"));

    let specs: &[(&str, &str, &[&str])] = &[
        ("Registry Editor", "regedit.exe", &["regedit", "registry", "reg"]),
        ("Services", "services.msc", &["services", "services.msc", "svc"]),
        ("Task Manager", "taskmgr.exe", &["taskmgr", "task", "processes"]),
        ("Device Manager", "devmgmt.msc", &["devmgmt", "devmgmt.msc", "device manager", "devices"]),
        ("Control Panel", "control.exe", &["control", "cpl", "control panel"]),
        ("Event Viewer", "eventvwr.msc", &["eventvwr", "eventvwr.msc", "events"]),
        ("Disk Management", "diskmgmt.msc", &["diskmgmt", "diskmgmt.msc", "partitions"]),
        ("System Configuration", "msconfig.exe", &["msconfig", "startup"]),
        ("Remote Desktop Connection", "mstsc.exe", &["mstsc", "rdp", "remote desktop"]),
        ("Command Prompt", "cmd.exe", &["cmd", "command prompt"]),
        ("Windows PowerShell", r"WindowsPowerShell\v1.0\powershell.exe", &["powershell", "ps"]),
        ("Resource Monitor", "resmon.exe", &["resmon", "resource monitor"]),
        ("System Information", "msinfo32.exe", &["msinfo32", "sysinfo"]),
        ("Notepad", "notepad.exe", &["notepad"]),
        ("Calculator", "calc.exe", &["calc", "calculator"]),
    ];

    let mut out = Vec::new();
    for (name, rel, aliases) in specs {
        let full = sys32.join(rel);
        if !full.exists() {
            continue;
        }
        let target = full.to_string_lossy().to_string();
        let key = name.to_ascii_lowercase();
        let mut alias_list: Vec<String> = aliases.iter().map(|s| s.to_string()).collect();
        alias_list.push(key.clone());
        out.push(SearchItem {
            id: format!("app:{}", key),
            name: (*name).to_string(),
            subtitle: "Windows System Tool · System32".to_string(),
            kind: "System".to_string(),
            launch_kind: "path".to_string(),
            target: target.clone(),
            icon_key: format!("path:{}", target.to_ascii_lowercase()),
            icon_data_url: None,
            aliases: alias_list,
        });
    }
    out
}

#[cfg(target_os = "windows")]
#[derive(Deserialize)]
struct PsAppRow {
    #[serde(rename = "Name")]
    name: Option<String>,
    #[serde(rename = "Target")]
    target: Option<String>,
    #[serde(rename = "LaunchKind")]
    launch_kind: Option<String>,
}

#[cfg(target_os = "windows")]
fn scan_start_apps_and_registry() -> Vec<SearchItem> {
    let ps_script = r#"
$ErrorActionPreference = 'SilentlyContinue'
$list = @()
Get-StartApps | ForEach-Object {
    if ($_.Name -and $_.AppID) {
        $list += [PSCustomObject]@{
            Name = $_.Name
            Target = $_.AppID
            LaunchKind = 'aumid'
        }
    }
}
Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths', 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths' | ForEach-Object {
    $p = (Get-ItemProperty $_.PSPath).'(default)'
    if ($p) {
        $clean = $p.Trim('"')
        if (Test-Path $clean) {
            $list += [PSCustomObject]@{
                Name = $_.PSChildName -replace '\.exe$',''
                Target = $clean
                LaunchKind = 'path'
            }
        }
    }
}
$list | ConvertTo-Json -Compress
"#;

    let output = Command::new("powershell")
        .args(["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", ps_script])
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .creation_flags(CREATE_NO_WINDOW)
        .output();

    let Ok(out) = output else {
        return Vec::new();
    };
    if !out.status.success() {
        return Vec::new();
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return Vec::new();
    }

    let rows: Vec<PsAppRow> = if trimmed.starts_with('[') {
        serde_json::from_str(trimmed).unwrap_or_default()
    } else {
        serde_json::from_str::<PsAppRow>(trimmed)
            .map(|r| vec![r])
            .unwrap_or_default()
    };

    let mut items = Vec::new();
    for row in rows {
        let Some(raw_name) = row.name else { continue };
        let Some(target) = row.target else { continue };
        let launch_kind = row.launch_kind.unwrap_or_else(|| "aumid".to_string());
        let display = clean_app_name(&raw_name);
        if display.is_empty() || is_noisy_shortcut_name(&display) {
            continue;
        }
        let key = display.to_ascii_lowercase();
        let mut aliases = vec![key.clone()];
        if display.eq_ignore_ascii_case("Visual Studio Code") {
            aliases.extend(["vsc".to_string(), "vscode".to_string(), "code".to_string()]);
        } else if display.eq_ignore_ascii_case("Microsoft Edge") {
            aliases.extend(["edge".to_string(), "msedge".to_string()]);
        } else if display.eq_ignore_ascii_case("Terminal") || display.eq_ignore_ascii_case("Windows Terminal") {
            aliases.extend(["wt".to_string(), "terminal".to_string()]);
        }

        let (subtitle, icon_key) = if launch_kind == "aumid" {
            ("App · Windows Apps".to_string(), format!("aumid:{}", target))
        } else {
            (
                "App · Installed Program".to_string(),
                format!("path:{}", target.to_ascii_lowercase()),
            )
        };

        items.push(SearchItem {
            id: format!("app:{}", key),
            name: display,
            subtitle,
            kind: "App".to_string(),
            launch_kind,
            target,
            icon_key,
            icon_data_url: None,
            aliases,
        });
    }
    items
}

static ES_EXE_CACHE: OnceLock<Option<PathBuf>> = OnceLock::new();

fn find_es_exe() -> Option<PathBuf> {
    ES_EXE_CACHE
        .get_or_init(|| {
            #[cfg(target_os = "windows")]
            {
                if let Ok(local) = std::env::var("LOCALAPPDATA") {
                    let winapps = PathBuf::from(local)
                        .join("Microsoft")
                        .join("WindowsApps")
                        .join("es.exe");
                    if winapps.exists() {
                        return Some(winapps);
                    }
                }
                if let Ok(path_var) = std::env::var("PATH") {
                    for dir in std::env::split_paths(&path_var) {
                        let candidate = dir.join("es.exe");
                        if candidate.exists() {
                            return Some(candidate);
                        }
                    }
                }
                for fallback in [
                    r"C:\Program Files\Everything\es.exe",
                    r"C:\Program Files (x86)\Everything\es.exe",
                ] {
                    let p = PathBuf::from(fallback);
                    if p.exists() {
                        return Some(p);
                    }
                }
            }
            None
        })
        .clone()
}

fn is_es_installed() -> bool {
    find_es_exe().is_some()
}

fn run_es_command(es_path: &Path, args_tokens: &[String]) -> Option<String> {
    let mut cmd = Command::new(es_path);
    cmd.args(["/a-d", "-prefix", "-n", "60", "-sort", "run-count-descending"]);
    for tok in args_tokens {
        cmd.arg(tok);
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd.output().ok()?;
    if !output.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).into_owned())
}

fn collect_es_candidates(
    stdout: &str,
    query: &str,
    frecency: &HashMap<String, u32>,
) -> Vec<(i32, SearchItem)> {
    let mut candidates: Vec<(i32, SearchItem)> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();

    for line in stdout.lines() {
        let full = line.trim();
        if full.is_empty() || is_noisy_file_path(full) {
            continue;
        }
        let lower_full = full.to_ascii_lowercase();
        if !seen_paths.insert(lower_full.clone()) {
            continue;
        }
        let p = Path::new(full);
        let Some(fname) = p.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let parent_str = p
            .parent()
            .map(|par| par.to_string_lossy().to_string())
            .unwrap_or_default();
        let ext = p
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .unwrap_or_default();

        let is_exe = ext == "exe";
        let kind = if is_exe { "Program" } else { "File" };
        let icon_key = if is_exe {
            format!("path:{}", lower_full)
        } else if !ext.is_empty() {
            format!("ext:.{}", ext)
        } else {
            "ext:generic".to_string()
        };

        let item = SearchItem {
            id: format!("file:{}", lower_full),
            name: fname.to_string(),
            subtitle: parent_str,
            kind: kind.to_string(),
            launch_kind: "path".to_string(),
            target: full.to_string(),
            icon_key,
            icon_data_url: None,
            aliases: Vec::new(),
        };

        let frec = *frecency.get(&item.id).unwrap_or(&0);
        let base_score = score_search_item(&item, query, frec);
        if base_score == 0 {
            continue;
        }
        let priority_adj = file_priority_adjustment(full, &ext);
        let final_score = base_score + priority_adj;
        candidates.push((final_score, item));
    }

    candidates
}

fn query_everything_files(
    query: &str,
    frecency: &HashMap<String, u32>,
) -> (Vec<SearchItem>, bool) {
    let Some(es_path) = find_es_exe() else {
        return (Vec::new(), false);
    };

    let tokens: Vec<&str> = query.split_whitespace().collect();
    if tokens.is_empty() {
        return (Vec::new(), true);
    }

    let exact_tokens: Vec<String> = tokens.iter().map(|t| (*t).to_string()).collect();
    let Some(stdout) = run_es_command(&es_path, &exact_tokens) else {
        // Error 8 (Everything IPC not running) or similar -> fail silently without disrupting app search
        return (Vec::new(), false);
    };

    let mut candidates = collect_es_candidates(&stdout, query, frecency);

    // Typo-prefix fallback: if exact tokens matched 0 files and a token >= 5 ASCII chars has a typo
    // (e.g. "databeses"), query Everything by its 4-char prefix and let Damerau-Levenshtein rank hits.
    if candidates.is_empty() && tokens.iter().any(|t| t.len() >= 5 && t.is_ascii()) {
        let prefix_tokens: Vec<String> = tokens
            .iter()
            .map(|t| {
                if t.len() >= 5 && t.is_ascii() {
                    t[..4].to_string()
                } else {
                    (*t).to_string()
                }
            })
            .collect();
        if let Some(pref_out) = run_es_command(&es_path, &prefix_tokens) {
            candidates = collect_es_candidates(&pref_out, query, frecency);
        }
    }

    candidates.sort_by(|a, b| b.0.cmp(&a.0));
    let top = candidates
        .into_iter()
        .take(MAX_FILES_RESULTS)
        .map(|(_, item)| item)
        .collect();
    (top, true)
}

#[cfg(target_os = "windows")]
fn to_wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

#[cfg(target_os = "windows")]
unsafe fn exec_shell_verb(
    verb: windows::core::PCWSTR,
    file: windows::core::PCWSTR,
    params: windows::core::PCWSTR,
    dir: windows::core::PCWSTR,
) -> windows::core::Result<()> {
    use windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_ASYNCOK, SEE_MASK_FLAG_NO_UI, SEE_MASK_NOZONECHECKS,
        SHELLEXECUTEINFOW,
    };
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    let mut sei = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_ASYNCOK | SEE_MASK_NOZONECHECKS | SEE_MASK_FLAG_NO_UI,
        hwnd: windows::Win32::Foundation::HWND::default(),
        lpVerb: verb,
        lpFile: file,
        lpParameters: params,
        lpDirectory: dir,
        nShow: SW_SHOWNORMAL.0,
        ..Default::default()
    };
    unsafe { ShellExecuteExW(&mut sei) }
}

#[cfg(target_os = "windows")]
fn shell_launch_windows(
    launch_kind: &str,
    target: &str,
    item_kind: &str,
    run_as_admin: bool,
) -> Result<(), String> {
    use windows::core::{w, PCWSTR};
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
        COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::{ApplicationActivationManager, IApplicationActivationManager, AO_NONE};
    use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};

    let lower_target = target.to_ascii_lowercase();
    let is_elevatable_file = lower_target.ends_with(".exe")
        || lower_target.ends_with(".lnk")
        || lower_target.ends_with(".msc")
        || lower_target.ends_with(".msi")
        || lower_target.ends_with(".bat")
        || lower_target.ends_with(".cmd")
        || lower_target.ends_with(".ps1");
    let want_admin = run_as_admin && (item_kind != "File" || is_elevatable_file);

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        let did_init = hr.is_ok();
        let _ = AllowSetForegroundWindow(ASFW_ANY);

        let try_activate_aumid = || -> bool {
            let aumid_w = to_wide_null(target);
            if let Ok(activator) = CoCreateInstance::<_, IApplicationActivationManager>(
                &ApplicationActivationManager,
                None,
                CLSCTX_ALL,
            ) {
                return activator
                    .ActivateApplication(PCWSTR(aumid_w.as_ptr()), PCWSTR::null(), AO_NONE)
                    .is_ok();
            }
            false
        };

        // Fast path 1: direct IApplicationActivationManager for Store/UWP/PWA apps when not elevating
        if !want_admin && launch_kind == "aumid" && try_activate_aumid() {
            if did_init {
                CoUninitialize();
            }
            return Ok(());
        }

        let dir_w = if launch_kind == "path" {
            Path::new(target)
                .parent()
                .map(|p| to_wide_null(&p.to_string_lossy()))
        } else {
            None
        };
        let dir_ptr = dir_w
            .as_ref()
            .map(|d| PCWSTR(d.as_ptr()))
            .unwrap_or(PCWSTR::null());

        // Administrative snap-ins (.msc) must be launched via elevated mmc.exe
        if want_admin && launch_kind == "path" && lower_target.ends_with(".msc") {
            let params_w = to_wide_null(&format!("\"{}\"", target));
            let res = exec_shell_verb(
                w!("runas"),
                w!("mmc.exe"),
                PCWSTR(params_w.as_ptr()),
                dir_ptr,
            );
            if did_init {
                CoUninitialize();
            }
            res.map_err(|e| format!("Elevated mmc.exe launch failed for {}: {}", target, e))?;
            return Ok(());
        }

        let open_target = if launch_kind == "aumid" {
            format!("shell:AppsFolder\\{}", target)
        } else {
            target.to_string()
        };
        let target_w = to_wide_null(&open_target);
        let verb = if want_admin { w!("runas") } else { w!("open") };

        let mut launch_res = exec_shell_verb(verb, PCWSTR(target_w.as_ptr()), PCWSTR::null(), dir_ptr);

        // Pure UWP/PWA apps may reject "runas"; fall back gracefully to normal launch
        if launch_res.is_err() && want_admin && launch_kind == "aumid" {
            if try_activate_aumid() {
                launch_res = Ok(());
            } else {
                launch_res =
                    exec_shell_verb(w!("open"), PCWSTR(target_w.as_ptr()), PCWSTR::null(), dir_ptr);
            }
        }

        if did_init {
            CoUninitialize();
        }
        launch_res
            .map_err(|e| format!("Windows ShellExecuteExW failed for {}: {}", open_target, e))?;
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn extract_native_icon_png(item: &SearchItem) -> Option<Vec<u8>> {
    use windows::Win32::System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED};

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
        let did_init = hr.is_ok();

        let result = if let Some(ext) = item.icon_key.strip_prefix("ext:") {
            extract_ext_icon_png(ext)
        } else if item.launch_kind == "aumid" {
            // Store/UWP/PWA apps live in shell:AppsFolder (not hooked by file-system shell extensions)
            let parsing = format!("shell:AppsFolder\\{}", item.target);
            extract_shell_item_png(&parsing)
        } else {
            // Fast SHGetFileInfoW icon-cache lookup for .lnk / .exe / files:
            // avoids instantiating third-party shell extensions (e.g. Google Drive drivefsext.dll)
            extract_path_icon_png(&item.target).or_else(|| {
                let ext = Path::new(&item.target)
                    .extension()
                    .and_then(|e| e.to_str())
                    .map(|e| format!(".{}", e))
                    .unwrap_or_else(|| ".exe".to_string());
                extract_ext_icon_png(&ext)
            })
        };

        if did_init {
            CoUninitialize();
        }
        result
    }
}

#[cfg(target_os = "windows")]
unsafe fn extract_path_icon_png(full_path: &str) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ};
    use windows::Win32::Storage::FileSystem::FILE_FLAGS_AND_ATTRIBUTES;
    use windows::Win32::UI::Shell::{SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON};
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    let wide = to_wide_null(full_path);
    let mut shfi = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_FLAGS_AND_ATTRIBUTES(0),
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON,
        )
    };
    if ok == 0 || shfi.hIcon.0.is_null() {
        return None;
    }

    let mut ii = ICONINFO::default();
    let got_info = unsafe { GetIconInfo(shfi.hIcon, &mut ii).is_ok() };
    let png = if got_info && !ii.hbmColor.0.is_null() {
        let mask_opt = if !ii.hbmMask.0.is_null() {
            Some(ii.hbmMask)
        } else {
            None
        };
        unsafe { hbitmap_to_png(ii.hbmColor, mask_opt) }
    } else {
        None
    };

    unsafe {
        if !ii.hbmColor.0.is_null() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
        }
        if !ii.hbmMask.0.is_null() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
        }
        let _ = DestroyIcon(shfi.hIcon);
    }
    png
}

#[cfg(target_os = "windows")]
unsafe fn extract_shell_item_png(parsing_name: &str) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::SIZE;
    use windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ};
    use windows::Win32::UI::Shell::{
        IShellItemImageFactory, SHCreateItemFromParsingName, SIIGBF_BIGGERSIZEOK, SIIGBF_ICONONLY,
    };

    let wide = to_wide_null(parsing_name);
    let factory: IShellItemImageFactory =
        unsafe { SHCreateItemFromParsingName(PCWSTR(wide.as_ptr()), None).ok()? };
    let hbitmap = unsafe {
        factory
            .GetImage(SIZE { cx: 48, cy: 48 }, SIIGBF_ICONONLY | SIIGBF_BIGGERSIZEOK)
            .ok()?
    };

    let png = unsafe { hbitmap_to_png(hbitmap, None) };
    unsafe {
        let _ = DeleteObject(HGDIOBJ(hbitmap.0));
    }
    png
}

#[cfg(target_os = "windows")]
unsafe fn extract_ext_icon_png(ext: &str) -> Option<Vec<u8>> {
    use windows::core::PCWSTR;
    use windows::Win32::Graphics::Gdi::{DeleteObject, HGDIOBJ};
    use windows::Win32::Storage::FileSystem::FILE_ATTRIBUTE_NORMAL;
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_USEFILEATTRIBUTES,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    let dummy = if ext.starts_with('.') {
        format!("file{}", ext)
    } else {
        "file.bin".to_string()
    };
    let wide = to_wide_null(&dummy);
    let mut shfi = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            FILE_ATTRIBUTE_NORMAL,
            Some(&mut shfi),
            std::mem::size_of::<SHFILEINFOW>() as u32,
            SHGFI_ICON | SHGFI_LARGEICON | SHGFI_USEFILEATTRIBUTES,
        )
    };
    if ok == 0 || shfi.hIcon.0.is_null() {
        return None;
    }

    let mut ii = ICONINFO::default();
    let got_info = unsafe { GetIconInfo(shfi.hIcon, &mut ii).is_ok() };
    let png = if got_info && !ii.hbmColor.0.is_null() {
        let mask_opt = if !ii.hbmMask.0.is_null() {
            Some(ii.hbmMask)
        } else {
            None
        };
        unsafe { hbitmap_to_png(ii.hbmColor, mask_opt) }
    } else {
        None
    };

    unsafe {
        if !ii.hbmColor.0.is_null() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmColor.0));
        }
        if !ii.hbmMask.0.is_null() {
            let _ = DeleteObject(HGDIOBJ(ii.hbmMask.0));
        }
        let _ = DestroyIcon(shfi.hIcon);
    }
    png
}

#[cfg(target_os = "windows")]
unsafe fn hbitmap_to_png(
    hbm_color: windows::Win32::Graphics::Gdi::HBITMAP,
    hbm_mask: Option<windows::Win32::Graphics::Gdi::HBITMAP>,
) -> Option<Vec<u8>> {
    use windows::Win32::Graphics::Gdi::{
        CreateCompatibleDC, DeleteDC, GetDC, GetDIBits, GetObjectW, ReleaseDC, BITMAP, BITMAPINFO,
        BITMAPINFOHEADER, BI_RGB, DIB_RGB_COLORS, HGDIOBJ,
    };

    let mut bm = BITMAP::default();
    let got = unsafe {
        GetObjectW(
            HGDIOBJ(hbm_color.0),
            std::mem::size_of::<BITMAP>() as i32,
            Some(&mut bm as *mut _ as *mut _),
        )
    };
    if got == 0 || bm.bmWidth <= 0 || bm.bmHeight <= 0 {
        return None;
    }

    let w = bm.bmWidth as usize;
    let h = bm.bmHeight as usize;
    if w > 256 || h > 256 {
        return None;
    }

    let screen_dc = unsafe { GetDC(None) };
    let mem_dc = unsafe { CreateCompatibleDC(Some(screen_dc)) };
    if mem_dc.0.is_null() {
        unsafe {
            ReleaseDC(None, screen_dc);
        }
        return None;
    }

    let mut bmi = BITMAPINFO {
        bmiHeader: BITMAPINFOHEADER {
            biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
            biWidth: w as i32,
            biHeight: -(h as i32), // Top-down DIB
            biPlanes: 1,
            biBitCount: 32,
            biCompression: BI_RGB.0,
            ..Default::default()
        },
        ..Default::default()
    };

    let mut bgra = vec![0u8; w * h * 4];
    let lines = unsafe {
        GetDIBits(
            mem_dc,
            hbm_color,
            0,
            h as u32,
            Some(bgra.as_mut_ptr() as *mut _),
            &mut bmi,
            DIB_RGB_COLORS,
        )
    };

    if lines == 0 {
        unsafe {
            let _ = DeleteDC(mem_dc);
            ReleaseDC(None, screen_dc);
        }
        return None;
    }

    // Check if the bitmap carries any non-zero alpha channel; if legacy 0-alpha, synthesize from mask
    let has_alpha = bgra.chunks_exact(4).any(|px| px[3] != 0);
    if !has_alpha {
        if let Some(mask_bm) = hbm_mask {
            let mut mask_bgra = vec![0u8; w * h * 4];
            let mask_lines = unsafe {
                GetDIBits(
                    mem_dc,
                    mask_bm,
                    0,
                    h as u32,
                    Some(mask_bgra.as_mut_ptr() as *mut _),
                    &mut bmi,
                    DIB_RGB_COLORS,
                )
            };
            if mask_lines > 0 {
                for (px, mpx) in bgra.chunks_exact_mut(4).zip(mask_bgra.chunks_exact(4)) {
                    // In Windows icon masks, white (255) is transparent and black (0) is opaque
                    px[3] = if mpx[0] > 128 { 0 } else { 255 };
                }
            }
        } else {
            for px in bgra.chunks_exact_mut(4) {
                if px[0] != 0 || px[1] != 0 || px[2] != 0 {
                    px[3] = 255;
                }
            }
        }
    }

    unsafe {
        let _ = DeleteDC(mem_dc);
        ReleaseDC(None, screen_dc);
    }

    // Convert BGRA -> RGBA (non-premultiplied safe)
    let mut rgba = Vec::with_capacity(w * h * 4);
    for px in bgra.chunks_exact(4) {
        rgba.push(px[2]);
        rgba.push(px[1]);
        rgba.push(px[0]);
        rgba.push(px[3]);
    }

    let mut out = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut out, w as u32, h as u32);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        let mut writer = encoder.write_header().ok()?;
        writer.write_image_data(&rgba).ok()?;
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::{
        clean_app_name, deduplicate_apps, file_priority_adjustment, is_noisy_file_path,
        is_noisy_shortcut_name, score_search_item, should_query_files, SearchItem,
    };

    fn dummy_app(name: &str, kind: &str, launch_kind: &str, target: &str, aliases: &[&str]) -> SearchItem {
        SearchItem {
            id: format!("app:{}", name.to_ascii_lowercase()),
            name: name.to_string(),
            subtitle: "App".to_string(),
            kind: kind.to_string(),
            launch_kind: launch_kind.to_string(),
            target: target.to_string(),
            icon_key: format!("k:{}", name),
            icon_data_url: None,
            aliases: aliases.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn strict_scoring_ranks_edge_and_acronyms_without_fake_matches() {
        let edge = dummy_app("Microsoft Edge", "App", "aumid", "MSEdge", &["edge", "msedge"]);
        let vscode = dummy_app("Visual Studio Code", "App", "path", "code.lnk", &["vscode", "vsc"]);
        let services = dummy_app("Services", "System", "path", "services.msc", &["svc", "services"]);
        let spotify = dummy_app("Spotify", "App", "aumid", "Spotify", &["spotify"]);

        assert!(score_search_item(&edge, "edge", 0) >= 1000);
        assert!(score_search_item(&vscode, "vsc", 0) >= 820);
        assert!(score_search_item(&services, "svc", 0) >= 1000);
        // Long conversational AI prompt must return 0 (never force fake filler rows!)
        assert_eq!(score_search_item(&edge, "explain how async rust works", 5), 0);
        assert_eq!(score_search_item(&spotify, "edge", 5), 0);
        assert!(!should_query_files("explain how async rust works please"));
        assert!(!should_query_files("what is the weather?"));
        assert!(should_query_files("report"));
        assert!(should_query_files("q4 report"));
    }

    #[test]
    fn deduplication_prefers_lnk_and_merges_aliases() {
        let reg = dummy_app("Microsoft Edge", "App", "path", r"C:\Edge\msedge.exe", &["msedge"]);
        let lnk = dummy_app("Microsoft Edge", "App", "path", r"C:\Start\Microsoft Edge.lnk", &["edge"]);
        let aumid = dummy_app("Microsoft Edge", "App", "aumid", "MSEdge", &["microsoft edge"]);

        let merged = deduplicate_apps(vec![reg, aumid, lnk]);
        assert_eq!(merged.len(), 1);
        assert!(merged[0].target.ends_with(".lnk"));
        assert!(merged[0].aliases.contains(&"msedge".to_string()));
        assert!(merged[0].aliases.contains(&"edge".to_string()));
    }

    #[test]
    fn noise_filters_drop_uninstallers_and_system_junk() {
        assert_eq!(clean_app_name("Spotify® Music.exe"), "Spotify Music");
        assert!(is_noisy_shortcut_name("Uninstall Visual Studio Code"));
        assert!(is_noisy_shortcut_name("Python 3.12 Documentation"));
        assert!(!is_noisy_shortcut_name("Registry Editor"));
        assert!(!is_noisy_shortcut_name("Services"));

        assert!(is_noisy_file_path(r"C:\Windows\WinSxS\foo\edge.dll"));
        assert!(is_noisy_file_path(r"C:\My Projects\app\node_modules\pkg\index.js"));
        assert!(is_noisy_file_path(r"C:\Users\eliud\AppData\Local\Temp\cache.tmp"));
        assert!(!is_noisy_file_path(r"C:\Users\eliud\Documents\Q4_Report.pdf"));
        assert!(!is_noisy_file_path(r"C:\Tools\ffmpeg\ffmpeg.exe"));
    }

    #[test]
    fn file_priority_ranks_pdfs_and_user_docs_above_svgs_and_filters_journals() {
        assert!(is_noisy_file_path(
            r"C:\ProgramData\Windhawk\UIData\user-data\databases\Databases.db-journal"
        ));
        assert!(is_noisy_file_path(
            r"C:\Users\eliud\.vscode\extensions\hediet.vscode-drawio-1.19.0\drawio\src\main\webapp\img\lib\mscae\Databases.svg"
        ));
        assert!(
            file_priority_adjustment(
                r"C:\My Documents\Introduction to database systems\INTRODUCTION TO DATABASES.pdf",
                "pdf",
            ) > file_priority_adjustment(r"C:\Assets\databases.svg", "svg") + 250
        );

        let youtube = dummy_app("YouTube", "App", "aumid", "YouTube", &["youtube"]);
        let spotify = dummy_app("Spotify", "App", "aumid", "Spotify", &["spotify"]);
        let calculator = dummy_app("Calculator", "App", "aumid", "Calc", &["calculator"]);
        let db_pdf = dummy_app(
            "INTRODUCTION TO DATABASES.pdf",
            "File",
            "path",
            r"C:\My Documents\INTRODUCTION TO DATABASES.pdf",
            &[],
        );
        let layout_file = dummy_app("_constrained_layout.py", "File", "path", r"C:\Docs\_constrained_layout.py", &[]);
        assert!(score_search_item(&youtube, "yout", 0) >= 880);
        assert!(score_search_item(&youtube, "youtune", 0) >= 550);
        assert!(score_search_item(&youtube, "youtun", 0) >= 550);
        assert!(score_search_item(&youtube, "yotuube", 0) >= 550);
        assert!(score_search_item(&youtube, "ytube", 0) >= 550);
        assert!(score_search_item(&spotify, "spoitfy", 0) >= 550);
        assert!(score_search_item(&calculator, "calclator", 0) >= 550);
        assert!(score_search_item(&db_pdf, "databeses", 0) >= 550);
        assert_eq!(score_search_item(&layout_file, "yout", 0), 0);
        assert_eq!(score_search_item(&layout_file, "youtune", 0), 0);
        assert!(score_search_item(&layout_file, "layout", 0) > 0);
    }
}
