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
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex, OnceLock};

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub const MAX_APPS_RESULTS: usize = 5;
pub const MAX_BOOKMARKS_RESULTS: usize = 4;
pub const MAX_FILES_RESULTS: usize = 6;
pub const MAX_RECENTS: usize = 8;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchItem {
    pub id: String,
    pub name: String,
    pub subtitle: String,
    /// `"App" | "System" | "Bookmark" | "Folder" | "File" | "Program"`
    pub kind: String,
    /// `"path" | "aumid" | "url"`
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
    pub bookmarks: Vec<SearchItem>,
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
    bookmarks: Arc<Mutex<Vec<SearchItem>>>,
    bookmark_watcher: Mutex<crate::bookmarks::BookmarkWatcherState>,
    recents: Mutex<PersistedRecents>,
    icon_cache: Arc<Mutex<HashMap<String, Option<String>>>>,
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
            bookmarks: Arc::new(Mutex::new(Vec::new())),
            bookmark_watcher: Mutex::new(crate::bookmarks::BookmarkWatcherState::new()),
            recents: Mutex::new(persisted),
            icon_cache: Arc::new(Mutex::new(HashMap::new())),
            data_dir,
            icon_cache_dir,
        });

        // Immediately populate fast local Start Menu + core tools (< 10ms), then merge
        // UWP/Store apps + App Paths & pre-warm top icons in background.
        let bg = Arc::clone(&mgr);
        std::thread::spawn(move || {
            bg.rebuild_app_index();
        });

        // Load cross-browser bookmarks & extract offline cached favicons in parallel (< 40ms)
        let bg_bm = Arc::clone(&mgr);
        std::thread::spawn(move || {
            bg_bm.refresh_bookmarks_sync();
        });

        mgr
    }

    pub fn refresh_bookmarks_sync(&self) {
        let (loaded, fp) = crate::bookmarks::load_all_bookmarks(&self.icon_cache_dir);
        let count = loaded.len();
        if let Ok(mut guard) = self.bookmarks.lock() {
            *guard = loaded;
        }
        if let Ok(mut watcher) = self.bookmark_watcher.lock() {
            watcher.update_fingerprint(fp);
        }
        if let Ok(mut cache) = self.icon_cache.lock() {
            cache.retain(|k, _| !k.starts_with("bmicon:"));
        }
        println!(
            "[SEARCH_INDEX] Browser bookmark index ready: {} deduplicated bookmarks.",
            count
        );
    }

    fn maybe_refresh_bookmarks(&self) {
        let (should_reload, flag) = {
            let Ok(mut watcher) = self.bookmark_watcher.lock() else {
                return;
            };
            (watcher.check_for_changes(), Arc::clone(&watcher.reloading))
        };
        if !should_reload {
            return;
        }
        if flag.swap(true, Ordering::AcqRel) {
            return;
        }
        let bookmarks_arc = Arc::clone(&self.bookmarks);
        let icon_cache_arc = Arc::clone(&self.icon_cache);
        let icon_cache_dir = self.icon_cache_dir.clone();
        std::thread::spawn(move || {
            let (loaded, _fp) = crate::bookmarks::load_all_bookmarks(&icon_cache_dir);
            if let Ok(mut guard) = bookmarks_arc.lock() {
                *guard = loaded;
            }
            if let Ok(mut cache) = icon_cache_arc.lock() {
                cache.retain(|k, _| !k.starts_with("bmicon:"));
            }
            flag.store(false, Ordering::Release);
        });
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
    /// - Non-empty query -> strictly matched Apps (max 5) + Browser Bookmarks (max 4) + optional Everything CLI Files (max 5).
    pub fn search(&self, raw_query: &str, include_files: bool) -> SearchResponse {
        self.maybe_refresh_bookmarks();
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
                bookmarks: Vec::new(),
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

        // 2. Sub-millisecond in-memory browser bookmark filtering (Edge, Zen, Chrome, Brave, Firefox...)
        let mut matched_bookmarks: Vec<(i32, SearchItem)> = {
            let guard = self.bookmarks.lock().ok();
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

        matched_bookmarks.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
        let mut top_bookmarks: Vec<SearchItem> = matched_bookmarks
            .into_iter()
            .take(MAX_BOOKMARKS_RESULTS)
            .map(|(_, item)| item)
            .collect();

        // 3. Everything CLI parallel file (`/a-d`) + folder (`/ad`) search (skipped for AI sentences)
        let (mut top_files, everything_ok) = if include_files && should_query_files(trimmed) {
            query_everything_files_and_folders(trimmed, &frecency_snap)
        } else {
            (Vec::new(), is_es_installed())
        };

        // 4. Populate crisp native icons & cached favicons for ONLY the visible results
        for item in &mut top_apps {
            item.icon_data_url = self.resolve_icon(item);
        }
        for item in &mut top_bookmarks {
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
            bookmarks: top_bookmarks,
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
            if reveal_in_explorer && item.launch_kind == "url" {
                copy_text_to_clipboard_windows(&item.target)?;
            } else if reveal_in_explorer && item.launch_kind == "path" {
                let reveal_target = if item.target.to_ascii_lowercase().ends_with(".lnk") {
                    resolve_lnk_target_windows(&item.target)
                        .filter(|p| Path::new(p).exists())
                        .unwrap_or_else(|| item.target.clone())
                } else {
                    item.target.clone()
                };
                reveal_in_explorer_windows(&reveal_target)?;
            } else {
                shell_launch_windows(&item.launch_kind, &item.target, &item.kind, run_as_admin)?;
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = (item, reveal_in_explorer, run_as_admin);
        }

        if !(reveal_in_explorer && item.launch_kind == "url") {
            self.record_launch(item);
        }

        // Teach Everything's native run-count ranking when launching files & folders
        #[cfg(target_os = "windows")]
        if item.launch_kind == "path"
            && !reveal_in_explorer
            && (item.kind == "File" || item.kind == "Program" || item.kind == "Folder")
        {
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

        // Bookmark favicons are pre-extracted offline into `{hash}.favicon` (PNG/SVG/ICO/JPEG/WebP)
        if item.launch_kind == "url" || key.starts_with("bmicon:") {
            let fav_file = crate::bookmarks::favicon_cache_path(&self.icon_cache_dir, key);
            let data_url = std::fs::read(&fav_file)
                .ok()
                .filter(|b| !b.is_empty())
                .and_then(|bytes| encode_image_data_url(&bytes));
            if let Ok(mut cache) = self.icon_cache.lock() {
                cache.insert(key.clone(), data_url.clone());
            }
            return data_url;
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

fn encode_image_data_url(bytes: &[u8]) -> Option<String> {
    use base64::{engine::general_purpose::STANDARD, Engine as _};
    let mime = crate::bookmarks::sniff_image_mime(bytes)?;
    Some(format!("data:{};base64,{}", mime, STANDARD.encode(bytes)))
}

pub(crate) fn fnv1a_64(bytes: &[u8]) -> u64 {
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

    // 5. Multi-word token-prefix & typo-tolerant match (e.g. "mic edg" -> "Microsoft Edge", "kra tax" -> bookmark)
    if !is_single_token {
        let q_tokens: Vec<&str> = q.split_whitespace().collect();
        if q_tokens.len() <= 3 {
            let alias_words: Vec<String> = item
                .aliases
                .iter()
                .flat_map(|a| split_search_words(a))
                .collect();
            if q_tokens.iter().all(|qt| {
                raw_words.iter().any(|w| w.starts_with(qt))
                    || words.iter().any(|w| w.starts_with(qt))
                    || alias_words.iter().any(|w| w.starts_with(qt))
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
                    || alias_words
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

    // 8. Substring fallback (only for 5+ char app/bookmark queries; files & folders strictly require word-prefix match)
    let is_fs_item = item.kind == "File" || item.kind == "Folder";
    if q.len() >= 5 && !is_fs_item && name.contains(&q) {
        return 540 + frec_boost;
    }
    if q.len() >= 5
        && !is_fs_item
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

/// Counts non-empty path segments (e.g. `C:\My Projects\AIDEN_assistant` -> 3).
fn path_depth(path: &str) -> usize {
    path.split(['\\', '/'])
        .filter(|seg| !seg.is_empty())
        .count()
}

/// Filters noisy Windows system, cache, hidden dot-folders, and deep dev-boilerplate folders
/// returned by Everything CLI `/ad`.
pub fn is_noisy_folder_path(path: &str) -> bool {
    let trimmed = path.trim().trim_end_matches(['\\', '/']);
    let depth = path_depth(trimmed);
    // Reject bare drive roots like `C:` / `C:\`
    if depth <= 1 {
        return true;
    }

    let lower = trimmed.to_ascii_lowercase();
    let lower_slashed = format!("{}\\", lower);

    // Reject any hidden dot-folder (e.g. `.git`, `.vscode`, `.cargo`, `.venv`, `.next`)
    if lower_slashed.contains("\\.") {
        return true;
    }

    let blocked_segments = [
        "\\$recycle.bin\\",
        "\\system volume information\\",
        "\\windows\\",
        "\\programdata\\",
        "\\appdata\\",
        "\\program files\\",
        "\\program files (x86)\\",
        "\\recovery\\",
        "\\perflogs\\",
        "\\msocache\\",
        "\\intel\\",
        "\\amd\\",
        "\\nvidia\\",
        "\\node_modules\\",
        "\\__pycache__\\",
        "\\venv\\",
        "\\site-packages\\",
        "\\dist-packages\\",
        "\\anaconda3\\",
        "\\miniconda3\\",
        "\\miniconda\\",
        "\\pkgs\\",
        "\\target\\debug\\",
        "\\target\\release\\",
        "\\bin\\debug\\",
        "\\bin\\release\\",
        "\\obj\\debug\\",
        "\\obj\\release\\",
    ];
    if blocked_segments.iter().any(|seg| lower_slashed.contains(seg)) {
        return true;
    }

    // Block generic build/asset boilerplate subfolders when nested inside projects (depth >= 4)
    let leaf = Path::new(trimmed)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_ascii_lowercase())
        .unwrap_or_default();
    if leaf.is_empty() {
        return true;
    }
    if depth >= 4 {
        let boilerplate_deep = [
            "dist", "build", "out", "obj", "target", "cache", "tmp", "temp", "logs", "chunks",
            "blobs", "vendor", "locales", "locale", "assets", "static", "fonts", "icons", "img",
            "css", "js", "lib", "libs", "types", "typings", "fixtures", "mocks", "__tests__",
            "migrations", "templates", "coverage",
        ];
        if boilerplate_deep.contains(&leaf.as_str()) {
            return true;
        }
    }

    false
}

/// Detects special Windows shell library folders (Downloads, Desktop, Documents, OneDrive...)
/// so we extract their custom Windows 11 folder icons rather than the generic yellow folder icon.
fn is_special_shell_folder(path: &str) -> bool {
    let trimmed = path.trim().trim_end_matches(['\\', '/']);
    let depth = path_depth(trimmed);
    if depth > 4 {
        return false;
    }
    let leaf = Path::new(trimmed)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_ascii_lowercase())
        .unwrap_or_default();
    matches!(
        leaf.as_str(),
        "desktop"
            | "downloads"
            | "documents"
            | "pictures"
            | "videos"
            | "music"
            | "onedrive"
            | "contacts"
            | "favorites"
            | "links"
            | "saved games"
            | "searches"
    )
}

/// Scores folder usefulness by user-library signal and shallow path depth so primary project
/// and document folders rank naturally alongside/above Tier 1 documents while deep subfolders drop.
pub fn folder_priority_adjustment(path: &str) -> i32 {
    let trimmed = path.trim().trim_end_matches(['\\', '/']);
    let depth = path_depth(trimmed);
    let lower = trimmed.to_ascii_lowercase();
    let lower_slashed = format!("{}\\", lower);

    let leaf = Path::new(trimmed)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.to_ascii_lowercase())
        .unwrap_or_default();

    let is_primary_library = depth <= 4
        && matches!(
            leaf.as_str(),
            "desktop"
                | "downloads"
                | "documents"
                | "my documents"
                | "my projects"
                | "projects"
                | "pictures"
                | "videos"
                | "music"
                | "onedrive"
        );
    if is_primary_library {
        return 295;
    }

    let user_roots = [
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
    let in_user_root = user_roots.iter().any(|seg| lower_slashed.contains(seg));

    if in_user_root {
        let depth_adj = match depth {
            0..=3 => 115,
            4 => 95,
            5 => 45,
            d => -25 * ((d - 5) as i32),
        };
        165 + depth_adj
    } else {
        let depth_adj = match depth {
            0..=3 => 60,
            4 => 20,
            5 => -15,
            d => -35 * ((d - 5) as i32),
        };
        120 + depth_adj
    }
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

fn run_es_command(
    es_path: &Path,
    attr_flag: &str,
    limit: &str,
    args_tokens: &[String],
) -> Option<String> {
    let mut cmd = Command::new(es_path);
    cmd.args([attr_flag, "-prefix", "-n", limit, "-sort", "run-count-descending"]);
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

fn collect_es_folder_candidates(
    stdout: &str,
    query: &str,
    frecency: &HashMap<String, u32>,
) -> Vec<(i32, SearchItem)> {
    let mut candidates: Vec<(i32, SearchItem)> = Vec::new();
    let mut seen_paths: HashSet<String> = HashSet::new();

    for line in stdout.lines() {
        let full = line.trim().trim_end_matches(['\\', '/']);
        if full.is_empty() || is_noisy_folder_path(full) {
            continue;
        }
        let lower_full = full.to_ascii_lowercase();
        if !seen_paths.insert(lower_full.clone()) {
            continue;
        }
        let p = Path::new(full);
        let Some(folder_name) = p.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let parent_str = p
            .parent()
            .map(|par| par.to_string_lossy().to_string())
            .unwrap_or_default();

        let icon_key = if is_special_shell_folder(full) {
            format!("path:{}", lower_full)
        } else {
            "ext:folder".to_string()
        };

        let item = SearchItem {
            id: format!("folder:{}", lower_full),
            name: folder_name.to_string(),
            subtitle: parent_str,
            kind: "Folder".to_string(),
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
        let priority_adj = folder_priority_adjustment(full);
        let final_score = base_score + priority_adj;
        candidates.push((final_score, item));
    }

    candidates
}

/// Merges scored folder & file candidates into the combined Option B bottom tier (`MAX_FILES_RESULTS`):
/// sorts strictly by score, keeping at most 3 folders when files also match so neither crowds the other out.
pub fn merge_files_and_folders(
    file_candidates: Vec<(i32, SearchItem)>,
    folder_candidates: Vec<(i32, SearchItem)>,
    max_total: usize,
) -> Vec<SearchItem> {
    let has_files = !file_candidates.is_empty();
    let mut combined = Vec::with_capacity(file_candidates.len() + folder_candidates.len());
    combined.extend(file_candidates);
    combined.extend(folder_candidates);
    combined.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));

    if !has_files {
        return combined
            .into_iter()
            .take(max_total)
            .map(|(_, item)| item)
            .collect();
    }

    let max_folders_when_mixed = 3usize.min(max_total);
    let mut selected: Vec<SearchItem> = Vec::with_capacity(max_total);
    let mut overflow_folders: Vec<SearchItem> = Vec::new();
    let mut folder_count = 0usize;

    for (_, item) in combined {
        if selected.len() >= max_total {
            break;
        }
        if item.kind == "Folder" {
            if folder_count < max_folders_when_mixed {
                folder_count += 1;
                selected.push(item);
            } else {
                overflow_folders.push(item);
            }
        } else {
            selected.push(item);
        }
    }

    // Never waste open slots if fewer files matched than expected
    for extra in overflow_folders {
        if selected.len() >= max_total {
            break;
        }
        selected.push(extra);
    }

    selected
}

fn build_typo_prefix_tokens(tokens: &[&str]) -> Option<Vec<String>> {
    if !tokens.iter().any(|t| t.len() >= 5 && t.is_ascii()) {
        return None;
    }
    Some(
        tokens
            .iter()
            .map(|t| {
                if t.len() >= 5 && t.is_ascii() {
                    t[..4].to_string()
                } else {
                    (*t).to_string()
                }
            })
            .collect(),
    )
}

fn query_everything_files_and_folders(
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
    let prefix_tokens = build_typo_prefix_tokens(&tokens);

    // Run Everything `/a-d` (files) and `/ad` (folders) in parallel so wall-clock latency stays ~15-25ms
    let (file_res, folder_res) = std::thread::scope(|s| {
        let f_handle = s.spawn(|| -> Option<Vec<(i32, SearchItem)>> {
            let stdout = run_es_command(&es_path, "/a-d", "60", &exact_tokens)?;
            let mut cands = collect_es_candidates(&stdout, query, frecency);
            if cands.is_empty() {
                if let Some(ref ptoks) = prefix_tokens {
                    if let Some(pref_out) = run_es_command(&es_path, "/a-d", "60", ptoks) {
                        cands = collect_es_candidates(&pref_out, query, frecency);
                    }
                }
            }
            Some(cands)
        });

        let d_handle = s.spawn(|| -> Option<Vec<(i32, SearchItem)>> {
            let stdout = run_es_command(&es_path, "/ad", "45", &exact_tokens)?;
            let mut cands = collect_es_folder_candidates(&stdout, query, frecency);
            if cands.is_empty() {
                if let Some(ref ptoks) = prefix_tokens {
                    if let Some(pref_out) = run_es_command(&es_path, "/ad", "45", ptoks) {
                        cands = collect_es_folder_candidates(&pref_out, query, frecency);
                    }
                }
            }
            Some(cands)
        });

        (
            f_handle.join().ok().flatten(),
            d_handle.join().ok().flatten(),
        )
    });

    if file_res.is_none() && folder_res.is_none() {
        // Error 8 (Everything IPC not running) -> fail silently without disrupting app/bookmark search
        return (Vec::new(), false);
    }

    let top = merge_files_and_folders(
        file_res.unwrap_or_default(),
        folder_res.unwrap_or_default(),
        MAX_FILES_RESULTS,
    );
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
fn copy_text_to_clipboard_windows(text: &str) -> Result<(), String> {
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL};
    use windows::Win32::System::DataExchange::{
        CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
    };
    use windows::Win32::System::Memory::{
        GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
    };

    const CF_UNICODETEXT: u32 = 13;
    let wide = to_wide_null(text);
    let byte_len = wide.len() * std::mem::size_of::<u16>();

    unsafe {
        let mut opened = false;
        for _ in 0..5 {
            if OpenClipboard(None).is_ok() {
                opened = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(8));
        }
        if !opened {
            return Err("Failed to open Windows clipboard".to_string());
        }

        let res = (|| -> Result<(), String> {
            EmptyClipboard().map_err(|e| format!("EmptyClipboard failed: {}", e))?;
            let hmem: HGLOBAL = GlobalAlloc(GMEM_MOVEABLE, byte_len)
                .map_err(|e| format!("GlobalAlloc failed: {}", e))?;
            let ptr = GlobalLock(hmem);
            if ptr.is_null() {
                let _ = GlobalFree(Some(hmem));
                return Err("GlobalLock returned null".to_string());
            }
            std::ptr::copy_nonoverlapping(wide.as_ptr() as *const u8, ptr as *mut u8, byte_len);
            let _ = GlobalUnlock(hmem);

            if let Err(e) = SetClipboardData(CF_UNICODETEXT, Some(HANDLE(hmem.0))) {
                let _ = GlobalFree(Some(hmem));
                return Err(format!("SetClipboardData failed: {}", e));
            }
            Ok(())
        })();

        let _ = CloseClipboard();
        res
    }
}

#[cfg(target_os = "windows")]
fn resolve_lnk_target_windows(lnk_path: &str) -> Option<String> {
    use windows::core::{Interface, PCWSTR};
    use windows::Win32::Storage::FileSystem::WIN32_FIND_DATAW;
    use windows::Win32::System::Com::{
        CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile, CLSCTX_INPROC_SERVER,
        COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, STGM_READ,
    };
    use windows::Win32::UI::Shell::{IShellLinkW, ShellLink};

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        let did_init = hr.is_ok();

        let resolved = (|| -> Option<String> {
            let link: IShellLinkW =
                CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER).ok()?;
            let persist: IPersistFile = link.cast().ok()?;
            let wide_lnk = to_wide_null(lnk_path);
            persist.Load(PCWSTR(wide_lnk.as_ptr()), STGM_READ).ok()?;

            let mut buf = [0u16; 1024];
            let mut find_data = WIN32_FIND_DATAW::default();
            link.GetPath(&mut buf, &mut find_data, 0).ok()?;
            let nul_pos = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            if nul_pos == 0 {
                return None;
            }
            let target = String::from_utf16_lossy(&buf[..nul_pos]).trim().to_string();
            if target.is_empty() {
                None
            } else {
                Some(target)
            }
        })();

        if did_init {
            CoUninitialize();
        }
        resolved
    }
}

#[cfg(target_os = "windows")]
fn reveal_in_explorer_windows(target_path: &str) -> Result<(), String> {
    use windows::core::PCWSTR;
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::{ILCreateFromPathW, ILFree, SHOpenFolderAndSelectItems};
    use windows::Win32::UI::WindowsAndMessaging::{AllowSetForegroundWindow, ASFW_ANY};

    unsafe {
        let hr = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        let did_init = hr.is_ok();
        let _ = AllowSetForegroundWindow(ASFW_ANY);

        let wide = to_wide_null(target_path);
        let pidl = ILCreateFromPathW(PCWSTR(wide.as_ptr()));
        let native_ok = if !pidl.is_null() {
            let res = SHOpenFolderAndSelectItems(pidl, None, 0).is_ok();
            ILFree(Some(pidl));
            res
        } else {
            false
        };

        if did_init {
            CoUninitialize();
        }
        if native_ok {
            return Ok(());
        }
    }

    // Quoted fallback if PIDL lookup failed (e.g. disconnected network path)
    let mut cmd = Command::new("explorer.exe");
    cmd.raw_arg(format!("/select,\"{}\"", target_path));
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd.spawn()
        .map_err(|e| format!("Failed to reveal in Explorer: {}", e))?;
    Ok(())
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
    let want_admin = run_as_admin
        && launch_kind != "url"
        && item_kind != "Folder"
        && (item_kind != "File" || is_elevatable_file);

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

        let dir_w = if launch_kind == "path" && item_kind != "Folder" {
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
    use windows::Win32::Storage::FileSystem::{FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_NORMAL};
    use windows::Win32::UI::Shell::{
        SHGetFileInfoW, SHFILEINFOW, SHGFI_ICON, SHGFI_LARGEICON, SHGFI_USEFILEATTRIBUTES,
    };
    use windows::Win32::UI::WindowsAndMessaging::{DestroyIcon, GetIconInfo, ICONINFO};

    let (dummy, attrs) = if ext == "folder" {
        ("folder".to_string(), FILE_ATTRIBUTE_DIRECTORY)
    } else if ext.starts_with('.') {
        (format!("file{}", ext), FILE_ATTRIBUTE_NORMAL)
    } else {
        ("file.bin".to_string(), FILE_ATTRIBUTE_NORMAL)
    };
    let wide = to_wide_null(&dummy);
    let mut shfi = SHFILEINFOW::default();
    let ok = unsafe {
        SHGetFileInfoW(
            PCWSTR(wide.as_ptr()),
            attrs,
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
        clean_app_name, deduplicate_apps, file_priority_adjustment, folder_priority_adjustment,
        is_noisy_file_path, is_noisy_folder_path, is_noisy_shortcut_name, merge_files_and_folders,
        score_search_item, should_query_files, SearchItem,
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

    #[test]
    fn folder_hygiene_priority_and_option_b_merge_work_cleanly() {
        // Noise folders blocked
        assert!(is_noisy_folder_path(r"C:\"));
        assert!(is_noisy_folder_path(r"C:\Windows"));
        assert!(is_noisy_folder_path(r"C:\Windows\System32"));
        assert!(is_noisy_folder_path(r"C:\Users\eliud\AppData\Local\Temp"));
        assert!(is_noisy_folder_path(r"C:\My Projects\app\node_modules"));
        assert!(is_noisy_folder_path(r"C:\My Projects\app\.git"));
        assert!(is_noisy_folder_path(r"C:\My Projects\app\frontend\dist"));
        assert!(is_noisy_folder_path(r"C:\My Projects\app\src\assets"));

        // Real user folders allowed
        assert!(!is_noisy_folder_path(r"C:\Users\eliud\Downloads"));
        assert!(!is_noisy_folder_path(r"C:\My Projects\AIDEN_assistant"));
        assert!(!is_noisy_folder_path(
            r"C:\My Documents\Introduction to database systems"
        ));

        // Priority: primary libraries & shallow user folders strongly outrank deep nested folders
        assert!(
            folder_priority_adjustment(r"C:\Users\eliud\Downloads")
                > folder_priority_adjustment(r"C:\My Projects\a\b\c\d\Downloads")
        );
        assert!(
            folder_priority_adjustment(r"C:\My Documents\Introduction to database systems")
                > folder_priority_adjustment(r"C:\Other\a\b\c\d\database")
        );

        // Folders follow strict word-prefix & typo rules (no mid-word false positives)
        let db_folder = dummy_app(
            "Introduction to database systems",
            "Folder",
            "path",
            r"C:\My Documents\Introduction to database systems",
            &[],
        );
        let layout_folder = dummy_app(
            "my_layout_pack",
            "Folder",
            "path",
            r"C:\My Projects\my_layout_pack",
            &[],
        );
        assert!(score_search_item(&db_folder, "database", 0) >= 760);
        assert!(score_search_item(&db_folder, "databeses", 0) >= 550);
        assert_eq!(score_search_item(&layout_folder, "yout", 0), 0);
        assert_eq!(score_search_item(&layout_folder, "youtune", 0), 0);

        // Option B merge: max 6 total, caps folders at 3 when files also exist
        let folders = vec![
            (1100, dummy_app("F1", "Folder", "path", r"C:\My Projects\F1", &[])),
            (1090, dummy_app("F2", "Folder", "path", r"C:\My Projects\F2", &[])),
            (1080, dummy_app("F3", "Folder", "path", r"C:\My Projects\F3", &[])),
            (1070, dummy_app("F4", "Folder", "path", r"C:\My Projects\F4", &[])),
        ];
        let files = vec![
            (1060, dummy_app("Doc1.pdf", "File", "path", r"C:\Docs\Doc1.pdf", &[])),
            (1050, dummy_app("Doc2.pdf", "File", "path", r"C:\Docs\Doc2.pdf", &[])),
            (1040, dummy_app("Doc3.pdf", "File", "path", r"C:\Docs\Doc3.pdf", &[])),
            (1030, dummy_app("Doc4.pdf", "File", "path", r"C:\Docs\Doc4.pdf", &[])),
        ];
        let merged = merge_files_and_folders(files, folders, 6);
        assert_eq!(merged.len(), 6);
        let folder_cnt = merged.iter().filter(|i| i.kind == "Folder").count();
        let file_cnt = merged.iter().filter(|i| i.kind == "File").count();
        assert_eq!(folder_cnt, 3);
        assert_eq!(file_cnt, 3);
    }
}
