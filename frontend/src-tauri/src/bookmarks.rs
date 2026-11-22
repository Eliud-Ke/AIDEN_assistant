//! Cross-browser bookmark reader & offline favicon extractor for AIDEN Search.
//! - Supports Chromium-family browsers (Microsoft Edge, Google Chrome, Brave, Vivaldi, Opera / GX)
//!   via their UTF-8 JSON `Bookmarks` file + `Favicons` SQLite DB.
//! - Supports Gecko-family browsers (Zen Browser, Mozilla Firefox) via lock-free temp snapshots
//!   of `places.sqlite` + `favicons.sqlite` (including `-wal` / `-shm`).
//! - Deduplicates identical URLs across browsers (preferring higher-priority browsers like Edge),
//!   extracts domain & folder search aliases, and caches real site favicons locally with zero
//!   network calls.

use crate::search_index::{fnv1a_64, SearchItem};
use rusqlite::{Connection, OpenFlags};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant, UNIX_EPOCH};

static SNAPSHOT_SEQ: AtomicU64 = AtomicU64::new(1);
const MAX_FAVICON_BYTES: usize = 262_144;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BrowserFamily {
    Chromium,
    Gecko,
}

#[derive(Clone, Debug)]
pub struct BookmarkSource {
    pub browser_name: &'static str,
    pub family: BrowserFamily,
    pub priority: u8,
    pub bookmark_path: PathBuf,
    pub favicon_db_path: Option<PathBuf>,
}

#[derive(Clone, Debug)]
struct RawBookmark {
    title: String,
    url: String,
    norm_url: String,
    host: String,
    folders: Vec<String>,
    priority: u8,
    browser_name: &'static str,
    icon_key: String,
}

pub struct BookmarkWatcherState {
    last_checked: Option<Instant>,
    last_fingerprint: Vec<(PathBuf, u64, u64)>,
    pub reloading: Arc<AtomicBool>,
}

impl BookmarkWatcherState {
    pub fn new() -> Self {
        Self {
            last_checked: None,
            last_fingerprint: Vec::new(),
            reloading: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn update_fingerprint(&mut self, fp: Vec<(PathBuf, u64, u64)>) {
        self.last_fingerprint = fp;
        self.last_checked = Some(Instant::now());
    }

    /// Cheap throttled `mtime` + size check (runs at most once every 2 seconds).
    pub fn check_for_changes(&mut self) -> bool {
        if let Some(last) = self.last_checked {
            if last.elapsed() < Duration::from_secs(2) {
                return false;
            }
        }
        self.last_checked = Some(Instant::now());
        let sources = discover_bookmark_sources();
        let fp = compute_sources_fingerprint(&sources);
        if fp != self.last_fingerprint {
            self.last_fingerprint = fp;
            true
        } else {
            false
        }
    }
}

/// Sniffs image MIME type from raw bytes so PNG, SVG, ICO, JPEG, WebP, and GIF favicons
/// all render cleanly as `data:` URIs without format conversion.
pub fn sniff_image_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() < 4 {
        return None;
    }
    if bytes.len() >= 8 && &bytes[..8] == b"\x89PNG\r\n\x1a\n" {
        return Some("image/png");
    }
    if &bytes[..4] == b"\x00\x00\x01\x00" {
        return Some("image/x-icon");
    }
    if bytes.len() >= 3 && bytes[0] == 0xFF && bytes[1] == 0xD8 && bytes[2] == 0xFF {
        return Some("image/jpeg");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
        return Some("image/gif");
    }
    // Check UTF-8 SVG (optional UTF-8 BOM + leading whitespace)
    let stripped = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]).unwrap_or(bytes);
    if let Ok(head) = std::str::from_utf8(&stripped[..stripped.len().min(256)]) {
        let trimmed = head.trim_start();
        let lower = trimmed.to_ascii_lowercase();
        if lower.starts_with("<svg")
            || (lower.starts_with("<?xml") && lower.contains("<svg"))
            || (lower.starts_with("<!--") && lower.contains("<svg"))
        {
            return Some("image/svg+xml");
        }
    }
    None
}

/// Computes a lightweight metadata fingerprint `(path, modified_unix_secs, byte_len)` for live reload.
pub fn compute_sources_fingerprint(sources: &[BookmarkSource]) -> Vec<(PathBuf, u64, u64)> {
    let mut fp: Vec<(PathBuf, u64, u64)> = sources
        .iter()
        .map(|s| {
            let mut best_mtime = 0u64;
            let mut total_len = 0u64;
            // Check both main file and Gecko -wal journal so live Zen/Firefox edits trigger reload
            let mut candidates = vec![s.bookmark_path.clone()];
            if s.family == BrowserFamily::Gecko {
                let mut wal = s.bookmark_path.as_os_str().to_os_string();
                wal.push("-wal");
                candidates.push(PathBuf::from(wal));
            }
            for p in candidates {
                if let Ok(meta) = std::fs::metadata(&p) {
                    total_len = total_len.saturating_add(meta.len());
                    if let Ok(modified) = meta.modified() {
                        if let Ok(dur) = modified.duration_since(UNIX_EPOCH) {
                            best_mtime = best_mtime.max(dur.as_secs());
                        }
                    }
                }
            }
            (s.bookmark_path.clone(), best_mtime, total_len)
        })
        .collect();
    fp.sort_by(|a, b| a.0.cmp(&b.0));
    fp
}

/// Discovers installed Chromium & Gecko bookmark stores across all user profiles on Windows.
pub fn discover_bookmark_sources() -> Vec<BookmarkSource> {
    let mut sources = Vec::new();

    #[cfg(target_os = "windows")]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            let local = PathBuf::from(local_app_data);
            let chromium_roots: &[(&'static str, u8, &[&str])] = &[
                ("Microsoft Edge", 10, &["Microsoft", "Edge", "User Data"]),
                ("Google Chrome", 8, &["Google", "Chrome", "User Data"]),
                ("Brave", 7, &["BraveSoftware", "Brave-Browser", "User Data"]),
                ("Vivaldi", 6, &["Vivaldi", "User Data"]),
            ];
            for (browser_name, priority, segs) in chromium_roots {
                let mut root = local.clone();
                for s in *segs {
                    root.push(s);
                }
                scan_chromium_user_data(&root, browser_name, *priority, &mut sources);
            }
        }

        if let Ok(roaming_app_data) = std::env::var("APPDATA") {
            let roaming = PathBuf::from(roaming_app_data);

            // Opera / Opera GX (Chromium format stored directly in profile folder)
            let opera_dirs: &[(&'static str, u8, &[&str])] = &[
                ("Opera", 5, &["Opera Software", "Opera Stable"]),
                ("Opera GX", 5, &["Opera Software", "Opera GX Stable"]),
            ];
            for (browser_name, priority, segs) in opera_dirs {
                let mut profile = roaming.clone();
                for s in *segs {
                    profile.push(s);
                }
                push_chromium_profile(&profile, browser_name, *priority, &mut sources);
            }

            // Gecko browsers (Zen Browser, Mozilla Firefox)
            let gecko_roots: &[(&'static str, u8, &[&str])] = &[
                ("Zen Browser", 9, &["zen", "Profiles"]),
                ("Firefox", 7, &["Mozilla", "Firefox", "Profiles"]),
            ];
            for (browser_name, priority, segs) in gecko_roots {
                let mut root = roaming.clone();
                for s in *segs {
                    root.push(s);
                }
                scan_gecko_profiles(&root, browser_name, *priority, &mut sources);
            }
        }
    }

    // Order highest-priority browsers first (Edge -> Zen -> Chrome -> Brave/Firefox -> ...)
    sources.sort_by(|a, b| b.priority.cmp(&a.priority).then_with(|| a.bookmark_path.cmp(&b.bookmark_path)));
    sources
}

#[cfg(target_os = "windows")]
fn scan_chromium_user_data(
    user_data_dir: &Path,
    browser_name: &'static str,
    priority: u8,
    out: &mut Vec<BookmarkSource>,
) {
    if !user_data_dir.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(user_data_dir) else {
        return;
    };
    let mut profile_dirs: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| {
            if !p.is_dir() {
                return false;
            }
            let Some(name) = p.file_name().and_then(|n| n.to_str()) else {
                return false;
            };
            name.eq_ignore_ascii_case("Default") || name.starts_with("Profile ")
        })
        .collect();
    // Put "Default" profile before numbered profiles
    profile_dirs.sort_by(|a, b| {
        let a_def = a
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("Default"))
            .unwrap_or(false);
        let b_def = b
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.eq_ignore_ascii_case("Default"))
            .unwrap_or(false);
        b_def.cmp(&a_def).then_with(|| a.cmp(b))
    });

    for dir in profile_dirs {
        push_chromium_profile(&dir, browser_name, priority, out);
    }
}

#[cfg(target_os = "windows")]
fn push_chromium_profile(
    profile_dir: &Path,
    browser_name: &'static str,
    priority: u8,
    out: &mut Vec<BookmarkSource>,
) {
    let bm_path = profile_dir.join("Bookmarks");
    if !bm_path.is_file() {
        return;
    }
    let fav_path = profile_dir.join("Favicons");
    out.push(BookmarkSource {
        browser_name,
        family: BrowserFamily::Chromium,
        priority,
        bookmark_path: bm_path,
        favicon_db_path: if fav_path.is_file() {
            Some(fav_path)
        } else {
            None
        },
    });
}

#[cfg(target_os = "windows")]
fn scan_gecko_profiles(
    profiles_dir: &Path,
    browser_name: &'static str,
    priority: u8,
    out: &mut Vec<BookmarkSource>,
) {
    if !profiles_dir.is_dir() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(profiles_dir) else {
        return;
    };
    for entry in entries.flatten() {
        let profile_dir = entry.path();
        if !profile_dir.is_dir() {
            continue;
        }
        let places = profile_dir.join("places.sqlite");
        if !places.is_file() {
            continue;
        }
        let favicons = profile_dir.join("favicons.sqlite");
        out.push(BookmarkSource {
            browser_name,
            family: BrowserFamily::Gecko,
            priority,
            bookmark_path: places,
            favicon_db_path: if favicons.is_file() {
                Some(favicons)
            } else {
                None
            },
        });
    }
}

/// Loads all browser bookmarks, deduplicates overlapping URLs, batch-extracts offline cached
/// favicons into `icon_cache_dir`, and returns ready-to-score `SearchItem`s + fingerprint.
pub fn load_all_bookmarks(icon_cache_dir: &Path) -> (Vec<SearchItem>, Vec<(PathBuf, u64, u64)>) {
    let sources = discover_bookmark_sources();
    let fingerprint = compute_sources_fingerprint(&sources);
    let items = load_bookmarks_from_sources(&sources, Some(icon_cache_dir));
    (items, fingerprint)
}

/// Core loader accepting explicit sources (also used directly in unit tests).
pub fn load_bookmarks_from_sources(
    sources: &[BookmarkSource],
    icon_cache_dir: Option<&Path>,
) -> Vec<SearchItem> {
    let mut raw: Vec<RawBookmark> = Vec::new();
    for src in sources {
        match src.family {
            BrowserFamily::Chromium => {
                if let Ok(content) = std::fs::read_to_string(&src.bookmark_path) {
                    parse_chromium_bookmarks_json(
                        &content,
                        src.browser_name,
                        src.priority,
                        &mut raw,
                    );
                }
            }
            BrowserFamily::Gecko => {
                let parsed = read_gecko_bookmarks_sqlite(
                    &src.bookmark_path,
                    src.browser_name,
                    src.priority,
                );
                raw.extend(parsed);
            }
        }
    }

    let deduped = deduplicate_raw_bookmarks(raw);

    // Batch-extract offline cached favicons from all discovered browser favicon DBs (0 network calls)
    if let Some(cache_dir) = icon_cache_dir {
        let _ = std::fs::create_dir_all(cache_dir);
        populate_bookmark_favicons(&deduped, sources, cache_dir);
    }

    deduped.into_iter().map(raw_to_search_item).collect()
}

/// Strips browser tab unread-count prefixes like `(18) Pinterest` or `(99+) YouTube`
/// while preserving genuine titles like `(2025) Tax Guide`.
pub fn clean_bookmark_title(raw: &str, fallback_host: &str) -> String {
    let collapsed: String = raw
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let trimmed = collapsed.trim();
    let stripped = strip_unread_badge_prefix(trimmed);
    if stripped.is_empty() {
        fallback_host.to_string()
    } else {
        stripped.to_string()
    }
}

fn strip_unread_badge_prefix(s: &str) -> &str {
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'(') {
        return s;
    }
    let Some(close_idx) = s.find(')') else {
        return s;
    };
    let inside = &s[1..close_idx];
    let digits_part = inside.strip_suffix('+').unwrap_or(inside);
    if !digits_part.is_empty()
        && digits_part.len() <= 3
        && digits_part.bytes().all(|b| b.is_ascii_digit())
    {
        let rest = s[close_idx + 1..].trim_start();
        if !rest.is_empty() {
            return rest;
        }
    }
    s
}

/// Extracts `(scheme, raw_host, clean_host, normalized_dedup_key)` from an `http(s)` URL.
pub fn parse_http_url(raw_url: &str) -> Option<(String, String, String, String)> {
    let trimmed = raw_url.trim();
    let (scheme, after_scheme) = if let Some(rest) = trimmed
        .strip_prefix("https://")
        .or_else(|| trimmed.strip_prefix("HTTPS://"))
    {
        ("https", rest)
    } else if let Some(rest) = trimmed
        .strip_prefix("http://")
        .or_else(|| trimmed.strip_prefix("HTTP://"))
    {
        ("http", rest)
    } else {
        // Handle mixed-case scheme
        let lower_head: String = trimmed.chars().take(8).collect::<String>().to_ascii_lowercase();
        if lower_head.starts_with("https://") {
            ("https", &trimmed[8..])
        } else if lower_head.starts_with("http://") {
            ("http", &trimmed[7..])
        } else {
            return None;
        }
    };

    let auth_end = after_scheme
        .find(|c| c == '/' || c == '?' || c == '#')
        .unwrap_or(after_scheme.len());
    let authority = &after_scheme[..auth_end];
    let remainder = &after_scheme[auth_end..];

    // Drop optional userinfo@
    let host_port = authority.rsplit('@').next().unwrap_or(authority);
    let raw_host = if host_port.starts_with('[') {
        // IPv6 literal
        host_port
            .find(']')
            .map(|end| &host_port[..=end])
            .unwrap_or(host_port)
    } else {
        host_port.split(':').next().unwrap_or(host_port)
    }
    .to_ascii_lowercase();

    if raw_host.is_empty() || !raw_host.contains('.') && raw_host != "localhost" {
        return None;
    }

    let clean_host = raw_host.strip_prefix("www.").unwrap_or(&raw_host).to_string();

    // Normalize path/query for deduplication (strip empty fragment and trailing slash on bare root)
    let rem_clean = remainder.strip_suffix('#').unwrap_or(remainder);
    let rem_norm = if rem_clean == "/" { "" } else { rem_clean.trim_end_matches('/') };
    let norm_url = format!("{}{}", clean_host, rem_norm);

    Some((scheme.to_string(), raw_host, clean_host, norm_url))
}

fn is_structural_folder_name(folder: &str) -> bool {
    let lower = folder.trim().to_ascii_lowercase();
    matches!(
        lower.as_str(),
        "" | "bookmarks bar"
            | "favorites bar"
            | "other bookmarks"
            | "other favorites"
            | "synced bookmarks"
            | "mobile bookmarks"
            | "bookmarks toolbar"
            | "bookmarks menu"
            | "toolbar"
            | "menu"
            | "unfiled"
            | "other"
            | "tags"
            | "root"
            | "speed dial"
            | "unsorted bookmarks"
    )
}

fn build_bookmark_aliases(clean_host: &str, folders: &[String], title: &str) -> Vec<String> {
    const IGNORED_HOST_PARTS: &[&str] = &[
        "www", "m", "mobile", "com", "org", "net", "gov", "edu", "co", "io", "ai", "app", "dev",
        "uk", "ke", "us", "de", "fr", "jp", "au", "ca", "in", "cn", "tv", "me", "info", "biz",
        "online", "site", "xyz", "ac", "go", "or",
    ];

    let mut set: HashSet<String> = HashSet::new();
    set.insert(title.to_ascii_lowercase());
    if !clean_host.is_empty() {
        set.insert(clean_host.to_string());
        for label in clean_host.split('.') {
            if label.len() >= 2 && !IGNORED_HOST_PARTS.contains(&label) {
                set.insert(label.to_string());
            }
        }
    }
    for folder in folders {
        if !is_structural_folder_name(folder) {
            set.insert(folder.trim().to_ascii_lowercase());
        }
    }

    let mut out: Vec<String> = set.into_iter().collect();
    out.sort();
    out
}

fn make_raw_bookmark(
    raw_title: &str,
    raw_url: &str,
    folder: &str,
    browser_name: &'static str,
    priority: u8,
) -> Option<RawBookmark> {
    let (_, _, clean_host, norm_url) = parse_http_url(raw_url)?;
    let title = clean_bookmark_title(raw_title, &clean_host);
    let mut folders = Vec::new();
    let f = folder.trim();
    if !f.is_empty() && !is_structural_folder_name(f) {
        folders.push(f.to_string());
    }
    let icon_key = format!("bmicon:{:016x}", fnv1a_64(norm_url.as_bytes()));
    Some(RawBookmark {
        title,
        url: raw_url.trim().to_string(),
        norm_url,
        host: clean_host,
        folders,
        priority,
        browser_name,
        icon_key,
    })
}

/// Parses a Chromium-format `Bookmarks` JSON string (Edge, Chrome, Brave, Vivaldi, Opera).
fn parse_chromium_bookmarks_json(
    json_str: &str,
    browser_name: &'static str,
    priority: u8,
    out: &mut Vec<RawBookmark>,
) {
    let Ok(val) = serde_json::from_str::<serde_json::Value>(json_str) else {
        return;
    };
    let Some(roots) = val.get("roots").and_then(|r| r.as_object()) else {
        return;
    };
    for root_node in roots.values() {
        walk_chromium_node(root_node, "", browser_name, priority, out);
    }
}

fn walk_chromium_node(
    node: &serde_json::Value,
    parent_folder: &str,
    browser_name: &'static str,
    priority: u8,
    out: &mut Vec<RawBookmark>,
) {
    let Some(obj) = node.as_object() else {
        return;
    };
    let node_type = obj.get("type").and_then(|t| t.as_str()).unwrap_or("");
    let node_name = obj.get("name").and_then(|n| n.as_str()).unwrap_or("");

    if node_type == "url" {
        if let Some(url) = obj.get("url").and_then(|u| u.as_str()) {
            if let Some(bm) = make_raw_bookmark(node_name, url, parent_folder, browser_name, priority)
            {
                out.push(bm);
            }
        }
        return;
    }

    if let Some(children) = obj.get("children").and_then(|c| c.as_array()) {
        let next_folder = if is_structural_folder_name(node_name) {
            parent_folder
        } else {
            node_name
        };
        for child in children {
            walk_chromium_node(child, next_folder, browser_name, priority, out);
        }
    }
}

/// Copies a SQLite database (plus optional `-wal` and `-shm` sidecars) to a unique temp directory,
/// opens it read-only, runs `f`, and deletes the temp directory cleanly afterward.
fn with_sqlite_snapshot<T, F>(db_path: &Path, f: F) -> Option<T>
where
    F: FnOnce(&Connection) -> T,
{
    if !db_path.is_file() {
        return None;
    }
    let seq = SNAPSHOT_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_dir = std::env::temp_dir().join(format!(
        "aiden_bm_snap_{}_{}",
        std::process::id(),
        seq
    ));
    if std::fs::create_dir_all(&tmp_dir).is_err() {
        return None;
    }

    let tmp_db = tmp_dir.join("snap.sqlite");
    if std::fs::copy(db_path, &tmp_db).is_err() {
        let _ = std::fs::remove_dir_all(&tmp_dir);
        return None;
    }

    for suffix in ["-wal", "-shm"] {
        let mut src_sidecar = db_path.as_os_str().to_os_string();
        src_sidecar.push(suffix);
        let src_path = PathBuf::from(src_sidecar);
        if src_path.is_file() {
            let dst_path = tmp_dir.join(format!("snap.sqlite{}", suffix));
            let _ = std::fs::copy(&src_path, &dst_path);
        }
    }

    let result = Connection::open_with_flags(
        &tmp_db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()
    .map(|conn| {
        let out = f(&conn);
        drop(conn);
        out
    });

    let _ = std::fs::remove_dir_all(&tmp_dir);
    result
}

/// Reads bookmarks from a Gecko `places.sqlite` database (Zen Browser, Firefox).
fn read_gecko_bookmarks_sqlite(
    places_path: &Path,
    browser_name: &'static str,
    priority: u8,
) -> Vec<RawBookmark> {
    with_sqlite_snapshot(places_path, |conn| {
        let mut out = Vec::new();
        let Ok(mut stmt) = conn.prepare(
            "SELECT COALESCE(b.title, p.title, ''), p.url, COALESCE(parent.title, '') \
             FROM moz_bookmarks b \
             JOIN moz_places p ON b.fk = p.id \
             LEFT JOIN moz_bookmarks parent ON b.parent = parent.id \
             WHERE b.type = 1 \
               AND (p.url LIKE 'http://%' OR p.url LIKE 'https://%')",
        ) else {
            return out;
        };

        let Ok(rows) = stmt.query_map([], |row| {
            let title: String = row.get(0)?;
            let url: String = row.get(1)?;
            let folder: String = row.get(2)?;
            Ok((title, url, folder))
        }) else {
            return out;
        };

        for row in rows.flatten() {
            let (title, url, folder) = row;
            if let Some(bm) = make_raw_bookmark(&title, &url, &folder, browser_name, priority) {
                out.push(bm);
            }
        }
        out
    })
    .unwrap_or_default()
}

fn deduplicate_raw_bookmarks(items: Vec<RawBookmark>) -> Vec<RawBookmark> {
    let mut by_url: HashMap<String, RawBookmark> = HashMap::new();

    for mut item in items {
        if let Some(existing) = by_url.get_mut(&item.norm_url) {
            let existing_https = existing.url.starts_with("https://");
            let item_https = item.url.starts_with("https://");

            // Merge folders from both browsers
            let mut merged_folders = existing.folders.clone();
            for f in &item.folders {
                if !merged_folders.iter().any(|ef| ef.eq_ignore_ascii_case(f)) {
                    merged_folders.push(f.clone());
                }
            }

            let replace = item.priority > existing.priority
                || (item.priority == existing.priority && item_https && !existing_https);
            if replace {
                item.folders = merged_folders;
                *existing = item;
            } else {
                existing.folders = merged_folders;
            }
        } else {
            by_url.insert(item.norm_url.clone(), item);
        }
    }

    let mut out: Vec<RawBookmark> = by_url.into_values().collect();
    out.sort_by(|a, b| a.title.to_ascii_lowercase().cmp(&b.title.to_ascii_lowercase()));
    out
}

fn raw_to_search_item(bm: RawBookmark) -> SearchItem {
    let aliases = build_bookmark_aliases(&bm.host, &bm.folders, &bm.title);
    let subtitle = if bm.folders.is_empty() {
        format!("{} · {}", bm.host, bm.browser_name)
    } else {
        format!("{} · {}", bm.host, bm.folders[0])
    };
    SearchItem {
        id: format!("bm:{:016x}", fnv1a_64(bm.norm_url.as_bytes())),
        name: bm.title,
        subtitle,
        kind: "Bookmark".to_string(),
        launch_kind: "url".to_string(),
        target: bm.url,
        icon_key: bm.icon_key,
        icon_data_url: None,
        aliases,
    }
}

pub fn favicon_cache_path(icon_cache_dir: &Path, icon_key: &str) -> PathBuf {
    icon_cache_dir.join(format!("{:016x}.favicon", fnv1a_64(icon_key.as_bytes())))
}

/// Builds origin prefix patterns (e.g. `https://www.pinterest.com/%`, `https://pinterest.com/%`)
/// for matching host-level cached favicons when the exact bookmark URL isn't in the DB.
fn origin_like_patterns(url: &str) -> Vec<String> {
    let Some((scheme, raw_host, clean_host, _)) = parse_http_url(url) else {
        return Vec::new();
    };
    let mut patterns = Vec::new();
    let mut push_unique = |p: String| {
        if !patterns.contains(&p) {
            patterns.push(p);
        }
    };
    push_unique(format!("{}://{}/%", scheme, raw_host));
    if raw_host != clean_host {
        push_unique(format!("{}://{}/%", scheme, clean_host));
    } else {
        push_unique(format!("{}://www.{}/%", scheme, clean_host));
    }
    if scheme == "http" {
        push_unique(format!("https://{}/%", raw_host));
        push_unique(format!("https://{}/%", clean_host));
    }
    patterns
}

/// Batch-extracts offline cached site favicons for any bookmarks not already on disk.
fn populate_bookmark_favicons(
    bookmarks: &[RawBookmark],
    sources: &[BookmarkSource],
    icon_cache_dir: &Path,
) {
    let mut missing: Vec<usize> = bookmarks
        .iter()
        .enumerate()
        .filter(|(_, bm)| {
            let p = favicon_cache_path(icon_cache_dir, &bm.icon_key);
            std::fs::metadata(&p).map(|m| m.len() == 0).unwrap_or(true)
        })
        .map(|(i, _)| i)
        .collect();

    if missing.is_empty() {
        return;
    }

    for src in sources {
        if missing.is_empty() {
            break;
        }
        let Some(fav_db) = src.favicon_db_path.as_ref() else {
            continue;
        };

        let extracted: Vec<(usize, Vec<u8>)> = with_sqlite_snapshot(fav_db, |conn| {
            let mut hits = Vec::new();
            match src.family {
                BrowserFamily::Chromium => {
                    let exact_sql = "SELECT fb.image_data \
                         FROM icon_mapping im \
                         JOIN favicon_bitmaps fb ON fb.icon_id = im.icon_id \
                         WHERE im.page_url = ?1 \
                           AND length(fb.image_data) > 0 \
                           AND length(fb.image_data) <= ?2 \
                         ORDER BY CASE WHEN fb.width >= 32 AND fb.width <= 192 THEN 0 ELSE 1 END, \
                                  ABS(fb.width - 48) ASC \
                         LIMIT 1";
                    let like_sql = "SELECT fb.image_data \
                         FROM icon_mapping im \
                         JOIN favicon_bitmaps fb ON fb.icon_id = im.icon_id \
                         WHERE im.page_url LIKE ?1 \
                           AND length(fb.image_data) > 0 \
                           AND length(fb.image_data) <= ?2 \
                         ORDER BY CASE WHEN fb.width >= 32 AND fb.width <= 192 THEN 0 ELSE 1 END, \
                                  ABS(fb.width - 48) ASC \
                         LIMIT 1";
                    let mut exact_stmt = conn.prepare(exact_sql).ok();
                    let mut like_stmt = conn.prepare(like_sql).ok();

                    for &idx in &missing {
                        let bm = &bookmarks[idx];
                        let mut found: Option<Vec<u8>> = None;

                        if let Some(ref mut stmt) = exact_stmt {
                            if let Ok(bytes) = stmt.query_row(
                                rusqlite::params![&bm.url, MAX_FAVICON_BYTES as i64],
                                |r| r.get::<_, Vec<u8>>(0),
                            ) {
                                if sniff_image_mime(&bytes).is_some() {
                                    found = Some(bytes);
                                }
                            }
                        }

                        if found.is_none() {
                            if let Some(ref mut stmt) = like_stmt {
                                for pat in origin_like_patterns(&bm.url) {
                                    if let Ok(bytes) = stmt.query_row(
                                        rusqlite::params![&pat, MAX_FAVICON_BYTES as i64],
                                        |r| r.get::<_, Vec<u8>>(0),
                                    ) {
                                        if sniff_image_mime(&bytes).is_some() {
                                            found = Some(bytes);
                                            break;
                                        }
                                    }
                                }
                            }
                        }

                        if let Some(bytes) = found {
                            hits.push((idx, bytes));
                        }
                    }
                }
                BrowserFamily::Gecko => {
                    let exact_sql = "SELECT i.data \
                         FROM moz_pages_w_icons p \
                         JOIN moz_icons_to_pages m ON p.id = m.page_id \
                         JOIN moz_icons i ON m.icon_id = i.id \
                         WHERE p.page_url = ?1 \
                           AND length(i.data) > 0 \
                           AND length(i.data) <= ?2 \
                         ORDER BY CASE WHEN i.width = 65535 THEN 0 \
                                       WHEN i.width >= 32 AND i.width <= 192 THEN 1 \
                                       ELSE 2 END, \
                                  ABS(i.width - 48) ASC \
                         LIMIT 1";
                    let like_sql = "SELECT i.data \
                         FROM moz_pages_w_icons p \
                         JOIN moz_icons_to_pages m ON p.id = m.page_id \
                         JOIN moz_icons i ON m.icon_id = i.id \
                         WHERE p.page_url LIKE ?1 \
                           AND length(i.data) > 0 \
                           AND length(i.data) <= ?2 \
                         ORDER BY CASE WHEN i.width = 65535 THEN 0 \
                                       WHEN i.width >= 32 AND i.width <= 192 THEN 1 \
                                       ELSE 2 END, \
                                  ABS(i.width - 48) ASC \
                         LIMIT 1";
                    let root_sql = "SELECT i.data \
                         FROM moz_icons i \
                         WHERE i.root = 1 \
                           AND i.icon_url LIKE ?1 \
                           AND length(i.data) > 0 \
                           AND length(i.data) <= ?2 \
                         ORDER BY CASE WHEN i.width = 65535 THEN 0 \
                                       WHEN i.width >= 32 AND i.width <= 192 THEN 1 \
                                       ELSE 2 END, \
                                  ABS(i.width - 48) ASC \
                         LIMIT 1";

                    let mut exact_stmt = conn.prepare(exact_sql).ok();
                    let mut like_stmt = conn.prepare(like_sql).ok();
                    let mut root_stmt = conn.prepare(root_sql).ok();

                    for &idx in &missing {
                        let bm = &bookmarks[idx];
                        let mut found: Option<Vec<u8>> = None;

                        if let Some(ref mut stmt) = exact_stmt {
                            if let Ok(bytes) = stmt.query_row(
                                rusqlite::params![&bm.url, MAX_FAVICON_BYTES as i64],
                                |r| r.get::<_, Vec<u8>>(0),
                            ) {
                                if sniff_image_mime(&bytes).is_some() {
                                    found = Some(bytes);
                                }
                            }
                        }

                        if found.is_none() {
                            let pats = origin_like_patterns(&bm.url);
                            if let Some(ref mut stmt) = like_stmt {
                                for pat in &pats {
                                    if let Ok(bytes) = stmt.query_row(
                                        rusqlite::params![pat, MAX_FAVICON_BYTES as i64],
                                        |r| r.get::<_, Vec<u8>>(0),
                                    ) {
                                        if sniff_image_mime(&bytes).is_some() {
                                            found = Some(bytes);
                                            break;
                                        }
                                    }
                                }
                            }
                            if found.is_none() {
                                if let Some(ref mut stmt) = root_stmt {
                                    for pat in &pats {
                                        if let Ok(bytes) = stmt.query_row(
                                            rusqlite::params![pat, MAX_FAVICON_BYTES as i64],
                                            |r| r.get::<_, Vec<u8>>(0),
                                        ) {
                                            if sniff_image_mime(&bytes).is_some() {
                                                found = Some(bytes);
                                                break;
                                            }
                                        }
                                    }
                                }
                            }
                        }

                        if let Some(bytes) = found {
                            hits.push((idx, bytes));
                        }
                    }
                }
            }
            hits
        })
        .unwrap_or_default();

        let mut resolved_indices: HashSet<usize> = HashSet::new();
        for (idx, bytes) in extracted {
            let path = favicon_cache_path(icon_cache_dir, &bookmarks[idx].icon_key);
            if std::fs::write(&path, &bytes).is_ok() {
                resolved_indices.insert(idx);
            }
        }
        missing.retain(|idx| !resolved_indices.contains(idx));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::search_index::score_search_item;

    #[test]
    fn cleans_unread_badge_and_preserves_year_titles() {
        assert_eq!(clean_bookmark_title("(18) Pinterest", "pinterest.com"), "Pinterest");
        assert_eq!(clean_bookmark_title("(99+) YouTube", "youtube.com"), "YouTube");
        assert_eq!(
            clean_bookmark_title("(2025) Tax Guide", "kra.go.ke"),
            "(2025) Tax Guide"
        );
        assert_eq!(clean_bookmark_title("   ", "github.com"), "github.com");
    }

    #[test]
    fn normalizes_and_deduplicates_chromium_and_gecko_bookmarks() {
        let tmp = std::env::temp_dir().join(format!("aiden_bm_test_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        // 1. Synthetic Chromium Bookmarks JSON (Edge, priority 10)
        let edge_json = r#"{
            "roots": {
                "bookmark_bar": {
                    "type": "folder",
                    "name": "Bookmarks bar",
                    "children": [
                        { "type": "url", "name": "(18) Pinterest", "url": "https://www.pinterest.com/" },
                        {
                            "type": "folder",
                            "name": "Finance",
                            "children": [
                                { "type": "url", "name": "Kenya Revenue Authority", "url": "https://itax.kra.go.ke/KRA-Portal/main.htm" }
                            ]
                        },
                        { "type": "url", "name": "Internal Edge", "url": "edge://settings" }
                    ]
                }
            }
        }"#;
        let edge_bm = tmp.join("Bookmarks");
        std::fs::write(&edge_bm, edge_json).unwrap();

        // 2. Synthetic Chromium Favicons SQLite with a tiny PNG
        let edge_fav = tmp.join("Favicons");
        let fake_png: Vec<u8> = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0];
        {
            let conn = Connection::open(&edge_fav).unwrap();
            conn.execute_batch(
                "CREATE TABLE icon_mapping(id INTEGER PRIMARY KEY, page_url TEXT, icon_id INTEGER);
                 CREATE TABLE favicon_bitmaps(id INTEGER PRIMARY KEY, icon_id INTEGER, image_data BLOB, width INTEGER, height INTEGER);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO icon_mapping(id, page_url, icon_id) VALUES (1, 'https://www.pinterest.com/', 10)",
                [],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO favicon_bitmaps(id, icon_id, image_data, width, height) VALUES (1, 10, ?1, 32, 32)",
                rusqlite::params![fake_png],
            )
            .unwrap();
        }

        // 3. Synthetic Gecko places.sqlite (Zen, priority 9) with 1 duplicate + 1 unique bookmark
        let zen_places = tmp.join("places.sqlite");
        {
            let conn = Connection::open(&zen_places).unwrap();
            conn.execute_batch(
                "CREATE TABLE moz_places(id INTEGER PRIMARY KEY, url TEXT, title TEXT);
                 CREATE TABLE moz_bookmarks(id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, title TEXT);",
            )
            .unwrap();
            conn.execute_batch(
                "INSERT INTO moz_bookmarks(id, type, fk, parent, title) VALUES (1, 2, NULL, 0, 'Bookmarks Toolbar');
                 INSERT INTO moz_bookmarks(id, type, fk, parent, title) VALUES (2, 2, NULL, 1, 'Coding');
                 INSERT INTO moz_places(id, url, title) VALUES (10, 'https://pinterest.com', 'Pinterest');
                 INSERT INTO moz_places(id, url, title) VALUES (11, 'https://github.com/rust-lang/rust', 'Rust GitHub');
                 INSERT INTO moz_bookmarks(id, type, fk, parent, title) VALUES (3, 1, 10, 1, 'Pinterest');
                 INSERT INTO moz_bookmarks(id, type, fk, parent, title) VALUES (4, 1, 11, 2, 'Rust GitHub');",
            )
            .unwrap();
        }

        // 4. Synthetic Gecko favicons.sqlite with an SVG icon for github.com
        let zen_fav = tmp.join("favicons.sqlite");
        let fake_svg = b"<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 16 16\"></svg>".to_vec();
        {
            let conn = Connection::open(&zen_fav).unwrap();
            conn.execute_batch(
                "CREATE TABLE moz_icons(id INTEGER PRIMARY KEY, icon_url TEXT, width INTEGER, root INTEGER, data BLOB);
                 CREATE TABLE moz_pages_w_icons(id INTEGER PRIMARY KEY, page_url TEXT);
                 CREATE TABLE moz_icons_to_pages(page_id INTEGER, icon_id INTEGER);",
            )
            .unwrap();
            conn.execute(
                "INSERT INTO moz_icons(id, icon_url, width, root, data) VALUES (1, 'https://github.com/favicon.svg', 65535, 1, ?1)",
                rusqlite::params![fake_svg],
            )
            .unwrap();
        }

        let cache_dir = tmp.join("cache");
        let sources = vec![
            BookmarkSource {
                browser_name: "Microsoft Edge",
                family: BrowserFamily::Chromium,
                priority: 10,
                bookmark_path: edge_bm,
                favicon_db_path: Some(edge_fav),
            },
            BookmarkSource {
                browser_name: "Zen Browser",
                family: BrowserFamily::Gecko,
                priority: 9,
                bookmark_path: zen_places,
                favicon_db_path: Some(zen_fav),
            },
        ];

        let items = load_bookmarks_from_sources(&sources, Some(&cache_dir));
        // Pinterest deduplicated + KRA + Rust GitHub = 3 (edge://settings ignored)
        assert_eq!(items.len(), 3);

        let pinterest = items.iter().find(|i| i.name == "Pinterest").unwrap();
        assert_eq!(pinterest.kind, "Bookmark");
        assert_eq!(pinterest.launch_kind, "url");
        // Typo-tolerant match works on bookmark title & domain
        assert!(score_search_item(pinterest, "pintrest", 0) >= 550);

        // Edge PNG favicon extracted & cached on disk
        let pin_cache = favicon_cache_path(&cache_dir, &pinterest.icon_key);
        let pin_bytes = std::fs::read(&pin_cache).unwrap();
        assert_eq!(sniff_image_mime(&pin_bytes), Some("image/png"));

        // Zen root SVG favicon extracted & cached on disk for Rust GitHub
        let gh = items.iter().find(|i| i.name == "Rust GitHub").unwrap();
        let gh_cache = favicon_cache_path(&cache_dir, &gh.icon_key);
        let gh_bytes = std::fs::read(&gh_cache).unwrap();
        assert_eq!(sniff_image_mime(&gh_bytes), Some("image/svg+xml"));

        // Folder alias ("finance") and domain alias ("kra") match KRA bookmark, including multi-word
        let kra = items
            .iter()
            .find(|i| i.name == "Kenya Revenue Authority")
            .unwrap();
        assert!(score_search_item(kra, "finance", 0) >= 820);
        assert!(score_search_item(kra, "kra", 0) >= 820);
        assert!(score_search_item(kra, "finance kra", 0) >= 700);
        assert!(score_search_item(kra, "kenya kra", 0) >= 700);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[test]
    #[ignore]
    fn smoke_real_local_browser_bookmarks() {
        let tmp = std::env::temp_dir().join(format!("aiden_bm_live_{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let t0 = Instant::now();
        let sources = discover_bookmark_sources();
        let (items, _fp) = load_all_bookmarks(&tmp);
        let elapsed = t0.elapsed();

        let with_favicon = items
            .iter()
            .filter(|i| {
                let p = favicon_cache_path(&tmp, &i.icon_key);
                std::fs::read(&p)
                    .ok()
                    .and_then(|b| sniff_image_mime(&b))
                    .is_some()
            })
            .count();

        println!(
            "LIVE_SMOKE: {} sources, {} deduplicated bookmarks, {}/{} favicons cached in {:?}",
            sources.len(),
            items.len(),
            with_favicon,
            items.len(),
            elapsed
        );
        for s in &sources {
            println!("  SOURCE: {} ({:?})", s.browser_name, s.family);
        }

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
