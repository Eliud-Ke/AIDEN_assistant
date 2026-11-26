use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{
    atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::{Duration, Instant};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

mod audio_beat;
mod bookmarks;
#[cfg(target_os = "windows")]
mod native_window;
mod search_index;
mod win_hotkey;

use base64::Engine as _;
use tauri::{
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    webview::{Color, NewWindowResponse, PageLoadEvent, Url, WebviewBuilder},
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, Position, State,
    WebviewUrl, WebviewWindow, WindowEvent,
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct BackendState(Mutex<Option<Child>>);

struct PipWatchState {
    generation: Arc<AtomicU64>,
    is_dragging: Arc<AtomicBool>,
}

struct PipBubbleState {
    visible: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
    last_flip_right: Arc<AtomicBool>,
}

struct PipHeadphonesState {
    visible: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
}

struct AidenBrowserState {
    generation: Arc<AtomicU64>,
    is_fullscreen: Arc<AtomicBool>,
    is_dark_mode: Arc<AtomicBool>,
}

struct PipBopState {
    generation: Arc<AtomicU64>,
    running: Arc<AtomicBool>,
    target_active: Arc<AtomicBool>,
    track_reset_seq: Arc<AtomicU64>,
    home_pos: Arc<Mutex<Option<(i32, i32)>>>,
}

struct PrevForegroundState(Mutex<Option<isize>>);

struct SearchIndexState(Arc<search_index::SearchIndexManager>);

struct SearchDrawerState {
    visible: Arc<AtomicBool>,
    generation: Arc<AtomicU64>,
    current_h_phys: Arc<AtomicI32>,
    height_gen: Arc<AtomicU64>,
    last_payload: Mutex<Option<serde_json::Value>>,
}

#[cfg(target_os = "windows")]
struct PipPowerState(Mutex<Option<native_window::PowerStatusSnapshot>>);
#[cfg(not(target_os = "windows"))]
struct PipPowerState(Mutex<Option<()>>);

#[cfg(target_os = "windows")]
struct PipSpotifyState(Mutex<Option<native_window::SpotifyMediaSnapshot>>);
#[cfg(not(target_os = "windows"))]
struct PipSpotifyState(Mutex<Option<()>>);

#[cfg(target_os = "windows")]
pub struct MorpherState(pub std::sync::Mutex<Option<native_window::WindowMorpher>>);
#[cfg(not(target_os = "windows"))]
pub struct MorpherState(pub std::sync::Mutex<Option<()>>);


fn find_bundled_engine() -> Option<PathBuf> {
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let candidates = [
                exe_dir.join("aiden-engine").join("aiden-engine.exe"),
                exe_dir.join("resources").join("aiden-engine").join("aiden-engine.exe"),
                exe_dir.join("aiden-engine.exe"),
            ];
            for candidate in candidates {
                if candidate.exists() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

fn find_dev_python(script_name: &str) -> Option<(PathBuf, PathBuf)> {
    let mut candidates: Vec<PathBuf> = Vec::new();

    if let Ok(cwd) = std::env::current_dir() {
        let mut dir = Some(cwd.as_path());
        while let Some(d) = dir {
            candidates.push(d.to_path_buf());
            dir = d.parent();
        }
    }

    if let Ok(exe_path) = std::env::current_exe() {
        let mut dir = exe_path.parent();
        while let Some(d) = dir {
            candidates.push(d.to_path_buf());
            dir = d.parent();
        }
    }

    for root in candidates {
        let python_exe = root
            .join("backend")
            .join("venv")
            .join("Scripts")
            .join("python.exe");
        let script_path = root.join("backend").join(script_name);

        if python_exe.exists() && script_path.exists() {
            return Some((python_exe, script_path));
        }
    }
    None
}

fn build_backend_command(script_name: &str) -> Result<Command, String> {
    let use_bundled = if cfg!(debug_assertions) {
        find_dev_python(script_name).is_none() && find_bundled_engine().is_some()
    } else {
        find_bundled_engine().is_some()
    };

    if use_bundled {
        if let Some(engine_exe) = find_bundled_engine() {
            let mut cmd = Command::new(&engine_exe);
            if let Some(engine_dir) = engine_exe.parent() {
                cmd.current_dir(engine_dir);
            }
            if script_name != "main.py" {
                let mod_name = script_name.trim_end_matches(".py");
                cmd.arg("--cli-module").arg(mod_name);
            }
            return Ok(cmd);
        }
    }

    if let Some((python_exe, script_path)) = find_dev_python(script_name) {
        let mut cmd = Command::new(&python_exe);
        if let Some(backend_dir) = script_path.parent() {
            cmd.current_dir(backend_dir);
        }
        if script_name == "main.py" {
            cmd.arg("-u").arg(&script_path);
        } else {
            cmd.arg(&script_path);
        }
        return Ok(cmd);
    }

    Err(format!(
        "Could not locate bundled Aiden engine or Python environment for {}",
        script_name
    ))
}

fn is_port_8765_active() -> bool {
    if let Ok(addr) = "127.0.0.1:8765".parse::<SocketAddr>() {
        TcpStream::connect_timeout(&addr, Duration::from_millis(90)).is_ok()
    } else {
        false
    }
}

fn kill_pid_tree(pid: u32) {
    #[cfg(target_os = "windows")]
    {
        let mut kill_cmd = Command::new("taskkill");
        kill_cmd
            .args(["/F", "/T", "/PID", &pid.to_string()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let _ = kill_cmd.status();
    }
}

fn stop_all_aiden_processes(state: &BackendState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(mut child) = guard.take() {
            let pid = child.id();
            kill_pid_tree(pid);
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    // Also terminate any external main.py instance holding port 8765
    #[cfg(target_os = "windows")]
    if is_port_8765_active() {
        let mut ps_cmd = Command::new("powershell");
        ps_cmd
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-NetTCPConnection -LocalPort 8765 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let _ = ps_cmd.status();
    }
}

fn spawn_aiden_backend(state: &BackendState) -> Result<u32, String> {
    let mut cmd = build_backend_command("main.py")?;
    cmd.stdin(Stdio::null());

    if cfg!(debug_assertions) {
        cmd.stdout(Stdio::inherit())
            .stderr(Stdio::inherit());
    } else {
        cmd.stdout(Stdio::null())
            .stderr(Stdio::null());
    }

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let child = cmd
        .spawn()
        .map_err(|e| format!("Failed to boot Aiden backend (main.py): {}", e))?;
    let pid = child.id();

    if let Ok(mut guard) = state.0.lock() {
        *guard = Some(child);
    }

    Ok(pid)
}

fn is_tracked_backend_alive(state: &BackendState) -> bool {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => return true,
                _ => {
                    *guard = None;
                }
            }
        }
    }
    false
}

fn reset_chat_pill_on_stop(app: &AppHandle) {
    close_inbuilt_browser_internal(app);
    stop_pip_bop_immediately(app);
    stop_pip_cursor_watcher(app);
    hide_pip_bubble_immediately(app);
    hide_pip_headphones_immediately(app);
    hide_search_drawer_immediately(app);
    #[cfg(target_os = "windows")]
    {
        let morph_state = app.state::<MorpherState>();
        if let Ok(guard) = morph_state.0.lock() {
            if let Some(morpher) = guard.as_ref() {
                morpher.set_awake_flag(false);
            }
        }
    }
    if let Some(pill_win) = app.get_webview_window("chat_pill") {
        let _ = pill_win.set_ignore_cursor_events(true);
        let _ = pill_win.hide();
        let _ = pill_win.set_size(LogicalSize::new(466.0, 60.0));
    }
    let _ = app.emit(
        "chat-pill-sync",
        serde_json::json!({
            "isAwake": false,
            "backendOnline": false,
            "reply": serde_json::Value::Null,
        }),
    );
}

fn perform_boot_aiden(state: &BackendState) -> Result<serde_json::Value, String> {
    win_hotkey::set_engine_paused(false);
    if is_tracked_backend_alive(state) || is_port_8765_active() {
        return Ok(serde_json::json!({
            "ok": true,
            "running": true,
            "status": "already_running",
            "message": "Aiden is already active in the background."
        }));
    }

    let pid = spawn_aiden_backend(state)?;
    Ok(serde_json::json!({
        "ok": true,
        "running": true,
        "pid": pid,
        "status": "booted",
        "message": "Aiden booted in sleep mode."
    }))
}

fn perform_shutdown_aiden(app: &AppHandle, state: &BackendState) -> serde_json::Value {
    win_hotkey::set_engine_paused(true);
    stop_all_aiden_processes(state);
    reset_chat_pill_on_stop(app);

    serde_json::json!({
        "ok": true,
        "running": false,
        "status": "stopped",
        "message": "Aiden has been shut down completely."
    })
}

fn perform_restart_aiden(app: &AppHandle, state: &BackendState) -> Result<serde_json::Value, String> {
    win_hotkey::set_engine_paused(false);
    stop_all_aiden_processes(state);
    reset_chat_pill_on_stop(app);

    std::thread::sleep(Duration::from_millis(400));

    let pid = spawn_aiden_backend(state)?;
    Ok(serde_json::json!({
        "ok": true,
        "running": true,
        "pid": pid,
        "status": "restarted",
        "message": "Aiden restarted in sleep mode."
    }))
}

#[tauri::command]
async fn boot_aiden(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BackendState>();
        perform_boot_aiden(&state)
    })
    .await
    .map_err(|e| format!("Boot background task error: {}", e))?
}

#[tauri::command]
async fn shutdown_aiden(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BackendState>();
        Ok(perform_shutdown_aiden(&app, &state))
    })
    .await
    .map_err(|e| format!("Shutdown background task error: {}", e))?
}

#[tauri::command]
async fn restart_aiden(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BackendState>();
        perform_restart_aiden(&app, &state)
    })
    .await
    .map_err(|e| format!("Restart background task error: {}", e))?
}

#[tauri::command]
async fn get_aiden_status(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<BackendState>();
        let tracked_alive = is_tracked_backend_alive(&state);
        let ws_online = is_port_8765_active();
        Ok(serde_json::json!({
            "running": tracked_alive || ws_online,
            "wsOnline": ws_online
        }))
    })
    .await
    .map_err(|e| format!("Status background task error: {}", e))?
}

#[tauri::command]
async fn get_windows_accent_color() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            let mut cmd = Command::new("reg");
            cmd.args(["query", "HKCU\\Software\\Microsoft\\Windows\\DWM", "/v", "AccentColor"])
                .stdout(Stdio::piped())
                .stderr(Stdio::null());
            cmd.creation_flags(CREATE_NO_WINDOW);
            if let Ok(output) = cmd.output() {
                let text = String::from_utf8_lossy(&output.stdout);
                for line in text.lines() {
                    if line.contains("AccentColor") && line.contains("REG_DWORD") {
                        if let Some(hex_part) = line.split_whitespace().last() {
                            let clean = hex_part.trim_start_matches("0x");
                            if let Ok(val) = u32::from_str_radix(clean, 16) {
                                let r = val & 0xFF;
                                let g = (val >> 8) & 0xFF;
                                let b = (val >> 16) & 0xFF;
                                return Ok(format!("#{:02x}{:02x}{:02x}", r, g, b));
                            }
                        }
                    }
                }
            }
        }
        Ok("#258292".to_string())
    })
    .await
    .map_err(|e| format!("Accent color background task error: {}", e))?
}

#[tauri::command]
async fn save_openai_key(api_key: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let trimmed = api_key.trim();
        if trimmed.is_empty() {
            return Err("API key cannot be empty.".to_string());
        }

        let mut cmd = build_backend_command("auth_manager.py")?;
        cmd.arg("--save-stdin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to launch backend auth manager: {}", e))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(trimmed.as_bytes())
                .map_err(|e| format!("Failed to pass API key to backend: {}", e))?;
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("Failed waiting for backend auth manager: {}", e))?;

        if output.status.success() {
            Ok("API Key saved to Windows Credential Manager.".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            Err(format!(
                "Backend failed to save key: {} {}",
                stdout.trim(),
                stderr.trim()
            ))
        }
    })
    .await
    .map_err(|e| format!("Save API key background task error: {}", e))?
}

#[tauri::command]
async fn check_openai_key() -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = build_backend_command("auth_manager.py")?;
        cmd.arg("--check")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to check key status: {}", e))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&stdout) {
                if let Some(has_key) = parsed.get("has_key").and_then(|v| v.as_bool()) {
                    return Ok(has_key);
                }
            }
            Ok(false)
        } else {
            Ok(false)
        }
    })
    .await
    .map_err(|e| format!("Check API key background task error: {}", e))?
}

#[tauri::command]
async fn save_gmail_credentials(email: String, app_password: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean_email = email.trim();
        let clean_pwd = app_password.trim().replace(" ", "");
        if clean_email.is_empty() || clean_pwd.is_empty() {
            return Err("Email and App Password cannot be empty.".to_string());
        }

        let payload = serde_json::json!({
            "email": clean_email,
            "app_password": clean_pwd,
        });

        let mut cmd = build_backend_command("auth_manager.py")?;
        cmd.arg("--save-gmail-stdin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to launch backend auth manager: {}", e))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(payload.to_string().as_bytes())
                .map_err(|e| format!("Failed to pass Gmail credentials to backend: {}", e))?;
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("Failed waiting for backend auth manager: {}", e))?;

        if output.status.success() {
            Ok("Gmail credentials saved to Windows Credential Manager.".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            Err(format!("Backend failed to save Gmail credentials: {} {}", stdout.trim(), stderr.trim()))
        }
    })
    .await
    .map_err(|e| format!("Save Gmail credentials background task error: {}", e))?
}

#[tauri::command]
async fn get_gmail_status() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = build_backend_command("auth_manager.py")?;
        cmd.arg("--get-gmail")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to check Gmail status: {}", e))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&stdout) {
                return Ok(parsed);
            }
        }
        Ok(serde_json::json!({ "has_credentials": false, "email": "" }))
    })
    .await
    .map_err(|e| format!("Gmail status background task error: {}", e))?
}

#[tauri::command]
async fn get_calendar_status() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = build_backend_command("auth_manager.py")?;
        cmd.arg("--get-calendar")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to check Calendar status: {}", e))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&stdout) {
                return Ok(parsed);
            }
        }
        Ok(serde_json::json!({
            "ok": false,
            "has_token": false,
            "has_client_config": false,
            "email": "",
            "client_source": "none"
        }))
    })
    .await
    .map_err(|e| format!("Calendar status background task error: {}", e))?
}

#[tauri::command]
async fn start_calendar_oauth() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = build_backend_command("auth_manager.py")?;
        cmd.arg("--calendar-oauth")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run Calendar OAuth: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        if output.status.success() {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&stdout) {
                return Ok(parsed);
            }
            Ok(serde_json::json!({ "ok": true }))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&stdout) {
                return Ok(parsed);
            }
            Err(format!("OAuth failed: {} {}", stdout.trim(), stderr.trim()))
        }
    })
    .await
    .map_err(|e| format!("OAuth background task error: {}", e))?
}

#[tauri::command]
async fn save_calendar_client_credentials(client_id: String, client_secret: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean_cid = client_id.trim();
        let clean_sec = client_secret.trim();
        if clean_cid.is_empty() || clean_sec.is_empty() {
            return Err("Client ID and Client Secret cannot be empty.".to_string());
        }

        let payload = serde_json::json!({
            "client_id": clean_cid,
            "client_secret": clean_sec,
        });

        let mut cmd = build_backend_command("auth_manager.py")?;
        cmd.arg("--save-calendar-client-stdin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to launch backend auth manager: {}", e))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(payload.to_string().as_bytes())
                .map_err(|e| format!("Failed to pass custom credentials to backend: {}", e))?;
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("Failed waiting for backend auth manager: {}", e))?;

        if output.status.success() {
            Ok("Custom Google Cloud credentials saved to Windows Credential Manager.".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            Err(format!("Backend failed to save custom credentials: {} {}", stdout.trim(), stderr.trim()))
        }
    })
    .await
    .map_err(|e| format!("Save Calendar credentials background task error: {}", e))?
}

#[tauri::command]
async fn disconnect_calendar() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = build_backend_command("auth_manager.py")?;
        cmd.arg("--delete-calendar")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to disconnect calendar: {}", e))?;

        if output.status.success() {
            Ok("Google Calendar disconnected successfully.".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("Failed to disconnect calendar: {}", stderr.trim()))
        }
    })
    .await
    .map_err(|e| format!("Disconnect Calendar background task error: {}", e))?
}

#[tauri::command]
async fn delete_calendar_client_credentials() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = build_backend_command("auth_manager.py")?;
        cmd.arg("--delete-calendar-client")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to remove custom credentials: {}", e))?;

        if output.status.success() {
            Ok("Custom credentials removed successfully.".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("Failed to remove custom credentials: {}", stderr.trim()))
        }
    })
    .await
    .map_err(|e| format!("Delete Calendar credentials background task error: {}", e))?
}

#[tauri::command]
async fn get_spotify_status() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = build_backend_command("auth_manager.py")?;
        cmd.arg("--get-spotify")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to check Spotify status: {}", e))?;

        if output.status.success() {
            let stdout = String::from_utf8_lossy(&output.stdout);
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&stdout) {
                return Ok(parsed);
            }
        }
        Ok(serde_json::json!({
            "ok": false,
            "has_token": false,
            "has_client_config": false,
            "display_name": "",
            "email": "",
            "product": "",
            "client_source": "none"
        }))
    })
    .await
    .map_err(|e| format!("Spotify status background task error: {}", e))?
}

#[tauri::command]
async fn start_spotify_oauth() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = build_backend_command("auth_manager.py")?;
        cmd.arg("--spotify-oauth")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run Spotify OAuth: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout);
        if output.status.success() {
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&stdout) {
                return Ok(parsed);
            }
            Ok(serde_json::json!({ "ok": true }))
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr);
            if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&stdout) {
                return Ok(parsed);
            }
            Err(format!("Spotify OAuth failed: {} {}", stdout.trim(), stderr.trim()))
        }
    })
    .await
    .map_err(|e| format!("Spotify OAuth background task error: {}", e))?
}

#[tauri::command]
async fn save_spotify_client_credentials(client_id: String, client_secret: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let clean_cid = client_id.trim();
        let clean_sec = client_secret.trim();
        if clean_cid.is_empty() || clean_sec.is_empty() {
            return Err("Client ID and Client Secret cannot be empty.".to_string());
        }

        let payload = serde_json::json!({
            "client_id": clean_cid,
            "client_secret": clean_sec,
        });

        let mut cmd = build_backend_command("auth_manager.py")?;
        cmd.arg("--save-spotify-client-stdin")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to launch backend auth manager: {}", e))?;

        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(payload.to_string().as_bytes())
                .map_err(|e| format!("Failed to pass Spotify credentials to backend: {}", e))?;
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("Failed waiting for backend auth manager: {}", e))?;

        if output.status.success() {
            Ok("Custom Spotify Developer credentials saved to Windows Credential Manager.".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).to_string();
            Err(format!("Backend failed to save custom Spotify credentials: {} {}", stdout.trim(), stderr.trim()))
        }
    })
    .await
    .map_err(|e| format!("Save Spotify credentials background task error: {}", e))?
}

#[tauri::command]
async fn disconnect_spotify() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = build_backend_command("auth_manager.py")?;
        cmd.arg("--disconnect-spotify")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to disconnect Spotify: {}", e))?;

        if output.status.success() {
            Ok("Spotify disconnected successfully.".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("Failed to disconnect Spotify: {}", stderr.trim()))
        }
    })
    .await
    .map_err(|e| format!("Disconnect Spotify background task error: {}", e))?
}

#[tauri::command]
async fn delete_spotify_client_credentials() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = build_backend_command("auth_manager.py")?;
        cmd.arg("--delete-spotify-client")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        #[cfg(target_os = "windows")]
        cmd.creation_flags(CREATE_NO_WINDOW);

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to remove custom Spotify credentials: {}", e))?;

        if output.status.success() {
            Ok("Custom Spotify credentials removed successfully.".to_string())
        } else {
            let stderr = String::from_utf8_lossy(&output.stderr).to_string();
            Err(format!("Failed to remove custom Spotify credentials: {}", stderr.trim()))
        }
    })
    .await
    .map_err(|e| format!("Delete Spotify credentials background task error: {}", e))?
}

fn get_user_data_dir() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        if let Ok(local_app_data) = std::env::var("LOCALAPPDATA") {
            return PathBuf::from(local_app_data).join("AidenAssistant");
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        return PathBuf::from(home).join("AppData").join("Local").join("AidenAssistant");
    }
    PathBuf::from(".")
}

#[tauri::command]
fn get_user_preferences() -> Result<serde_json::Value, String> {
    let path = get_user_data_dir().join("user_preferences.json");
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(mut val) = serde_json::from_str::<serde_json::Value>(&content) {
                if let Some(obj) = val.as_object_mut() {
                    obj.insert("ok".to_string(), serde_json::Value::Bool(true));
                    return Ok(val);
                }
            }
        }
    }
    Ok(serde_json::json!({
        "ok": true,
        "identity_vibe": "You are a sassy, joyful, chatty, personal assistant living directly within the hardware of the laptop. You are one with the operating system. You are chatty with the user from making jokes to making the laptop more lively. You are a bit of a trickster and love to play pranks on the user, but you are also very helpful and will do anything to make the user's experience better. You are very curious and love to learn new things. You are very protective of the user and will always have their back.",
        "extra_rules": [],
        "wake_shortcut": "ctrl+shift+space"
    }))
}

#[tauri::command]
fn save_user_preferences(
    identity_vibe: Option<String>,
    extra_rules: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let dir = get_user_data_dir();
    let path = dir.join("user_preferences.json");

    let mut current = if path.exists() {
        std::fs::read_to_string(&path)
            .ok()
            .and_then(|c| serde_json::from_str::<serde_json::Value>(&c).ok())
            .unwrap_or_else(|| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };

    if !current.is_object() {
        current = serde_json::json!({});
    }

    if let Some(vibe) = identity_vibe {
        current["identity_vibe"] = serde_json::Value::String(vibe);
    }
    if let Some(rules) = extra_rules {
        let arr = rules.into_iter().map(serde_json::Value::String).collect();
        current["extra_rules"] = serde_json::Value::Array(arr);
    }
    if current.get("wake_shortcut").is_none() {
        current["wake_shortcut"] = serde_json::Value::String("ctrl+shift+space".to_string());
    }

    let _ = std::fs::create_dir_all(&dir);
    if let Ok(formatted) = serde_json::to_string_pretty(&current) {
        std::fs::write(&path, formatted).map_err(|e| format!("Failed to write preferences: {}", e))?;
    }

    let mut response = current.clone();
    if let Some(obj) = response.as_object_mut() {
        obj.insert("ok".to_string(), serde_json::Value::Bool(true));
    }
    Ok(response)
}

#[tauri::command]
fn get_user_memories() -> Result<serde_json::Value, String> {
    let path = get_user_data_dir().join("memory.json");
    if path.exists() {
        if let Ok(content) = std::fs::read_to_string(&path) {
            if let Ok(val) = serde_json::from_str::<serde_json::Value>(&content) {
                if val.is_object() {
                    return Ok(serde_json::json!({
                        "ok": true,
                        "memories": val
                    }));
                }
            }
        }
    }
    Ok(serde_json::json!({
        "ok": true,
        "memories": { "general": [] }
    }))
}

#[tauri::command]
fn save_user_memories(memories: serde_json::Value) -> Result<serde_json::Value, String> {
    let dir = get_user_data_dir();
    let path = dir.join("memory.json");

    let memories_map = if let Some(m) = memories.get("memories") {
        m.clone()
    } else {
        memories
    };

    let _ = std::fs::create_dir_all(&dir);
    if let Ok(formatted) = serde_json::to_string_pretty(&memories_map) {
        std::fs::write(&path, formatted).map_err(|e| format!("Failed to write memories: {}", e))?;
    }

    Ok(serde_json::json!({
        "ok": true,
        "memories": memories_map
    }))
}

#[tauri::command]
fn morph_pill(
    app: AppHandle,
    target_width: f64,
    target_height: f64,
    duration_ms: Option<u64>,
) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let scale = app
            .get_webview_window("chat_pill")
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(1.0);
        let morph_state = app.state::<MorpherState>();
        if let Ok(guard) = morph_state.0.lock() {
            if let Some(morpher) = guard.as_ref() {
                morpher.morph(target_width * scale, target_height * scale, duration_ms.unwrap_or(240));
                return Ok(());
            }
        }
    }

    if let Some(pill_win) = app.get_webview_window("chat_pill") {
        let _ = pill_win.set_size(LogicalSize::new(target_width, target_height));
    }
    Ok(())
}

#[tauri::command]
fn set_pill_theme(
    app: AppHandle,
    dark_mode: bool,
) -> Result<(), String> {
    if let Some(browser_state) = app.try_state::<AidenBrowserState>() {
        browser_state.is_dark_mode.store(dark_mode, Ordering::SeqCst);
    }
    if let Some(bv) = app.get_webview("aiden_browser") {
        let bg = if dark_mode {
            Color(17, 19, 24, 255)
        } else {
            Color(242, 244, 248, 255)
        };
        let _ = bv.set_background_color(Some(bg));
        let js = format!(
            "window.__aidenBrowserDarkMode={};window.__aidenBrowserCornersApi&&window.__aidenBrowserCornersApi.setDarkMode({});",
            dark_mode, dark_mode
        );
        let _ = bv.eval(&js);
    }
    #[cfg(target_os = "windows")]
    {
        if let Some(pill_win) = app.get_webview_window("chat_pill") {
            if let Ok(hwnd) = pill_win.hwnd() {
                let _ = native_window::apply_native_pill_chrome(hwnd, dark_mode);
            }
        }
        if let Some(drawer_win) = app.get_webview_window("search_drawer") {
            if let Ok(hwnd) = drawer_win.hwnd() {
                let _ = native_window::apply_native_drawer_chrome(hwnd, dark_mode);
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn animate_chat_pill_shape(
    app: AppHandle,
    _offset_x: f32,
    _offset_y: f32,
    width: f32,
    height: f32,
    _corner_radius: f32,
    duration_ms: u64,
    _window_height: Option<f64>,
) -> Result<(), String> {
    morph_pill(app, width as f64, height as f64, Some(duration_ms))
}

#[tauri::command]
fn set_chat_pill_size(
    app: AppHandle,
    width: Option<f64>,
    height: f64,
    _pill_mode: Option<String>,
    _shape_x: Option<f32>,
    _shape_y: Option<f32>,
    _shape_w: Option<f32>,
    _shape_h: Option<f32>,
    _shape_r: Option<f32>,
) -> Result<(), String> {
    morph_pill(app, width.unwrap_or(466.0), height, Some(220))
}

#[tauri::command]
fn resize_chat_pill(app: AppHandle, expanded: bool) -> Result<(), String> {
    let target_h = if expanded { 580.0 } else { 60.0 };
    morph_pill(app, 466.0, target_h, Some(280))
}

const INVISIBLE_SCROLLBAR_JS: &str = r#"(function(){
  try {
    var css = "html, body, * { scrollbar-width: none !important; -ms-overflow-style: none !important; } ::-webkit-scrollbar { display: none !important; width: 0 !important; height: 0 !important; }";
    var inject = function() {
      var target = document.head || document.documentElement;
      if (!target) return;
      if (document.getElementById("__aiden_invisible_sb")) return;
      var s = document.createElement("style");
      s.id = "__aiden_invisible_sb";
      s.textContent = css;
      target.appendChild(s);
    };
    if (document.documentElement) inject();
    document.addEventListener("DOMContentLoaded", inject, { once: true });
  } catch (_) {}
})();"#;

const AIDEN_BROWSER_BAR_H: f64 = 44.0;
const AIDEN_BROWSER_HUD_JS: &str = include_str!("aiden_browser_hud.js");

fn sync_inbuilt_browser_bounds(app: &AppHandle, phys_size: tauri::PhysicalSize<u32>) {
    let Some(bv) = app.get_webview("aiden_browser") else {
        return;
    };
    if phys_size.width == 0 || phys_size.height == 0 {
        return;
    }
    let fs_flag = app
        .try_state::<AidenBrowserState>()
        .map(|s| s.is_fullscreen.load(Ordering::SeqCst))
        .unwrap_or(false);
    let win_fs = app
        .get_webview_window("chat_pill")
        .and_then(|w| w.is_fullscreen().ok())
        .unwrap_or(false);

    if fs_flag || win_fs {
        let _ = bv.set_position(PhysicalPosition::new(0, 0));
        let _ = bv.set_size(phys_size);
    } else {
        let scale = app
            .get_webview_window("chat_pill")
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(1.0);
        let bar_h = (AIDEN_BROWSER_BAR_H * scale).round() as i32;
        let avail_h = (phys_size.height as i32 - bar_h).max(120) as u32;
        let _ = bv.set_position(PhysicalPosition::new(0, bar_h));
        let _ = bv.set_size(tauri::PhysicalSize::new(phys_size.width, avail_h));
    }
}

fn normalize_browser_url(raw: &str) -> Result<Url, String> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("URL cannot be empty.".to_string());
    }
    let with_scheme = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{}", trimmed)
    };
    let parsed = Url::parse(&with_scheme).map_err(|e| format!("Invalid URL: {}", e))?;
    match parsed.scheme() {
        "http" | "https" => Ok(parsed),
        other => Err(format!("Unsupported URL scheme '{}'; only http and https are allowed.", other)),
    }
}

fn close_inbuilt_browser_internal(app: &AppHandle) {
    if let Some(browser_state) = app.try_state::<AidenBrowserState>() {
        browser_state.generation.fetch_add(1, Ordering::SeqCst);
        browser_state.is_fullscreen.store(false, Ordering::SeqCst);
    }
    if let Some(bv) = app.get_webview("aiden_browser") {
        let _ = bv.close();
    }
    if let Some(pill_win) = app.get_webview_window("chat_pill") {
        if pill_win.is_fullscreen().unwrap_or(false) {
            let _ = pill_win.set_fullscreen(false);
        }
    }
}

fn reveal_inbuilt_browser_on_main(app: AppHandle, seq_gen: u64) {
    let st = app.state::<AidenBrowserState>();
    if st.generation.load(Ordering::SeqCst) != seq_gen {
        return;
    }
    let app_ui = app.clone();
    let _ = app.run_on_main_thread(move || {
        let st_inner = app_ui.state::<AidenBrowserState>();
        if st_inner.generation.load(Ordering::SeqCst) != seq_gen {
            return;
        }
        if let Some(bv) = app_ui.get_webview("aiden_browser") {
            let _ = bv.show();
            let _ = bv.set_focus();
        }
        if let Some(win) = app_ui.get_window("chat_pill") {
            if let Ok(sz) = win.inner_size() {
                sync_inbuilt_browser_bounds(&app_ui, sz);
            }
        }
    });
}

#[tauri::command]
fn open_inbuilt_browser(
    app: AppHandle,
    url: String,
    width: Option<f64>,
    height: Option<f64>,
) -> Result<String, String> {
    let parsed = normalize_browser_url(&url)?;
    let target_w = width.unwrap_or(960.0).clamp(640.0, 1440.0);
    let target_h = height.unwrap_or(600.0).clamp(440.0, 960.0);

    let browser_state = app.state::<AidenBrowserState>();
    let seq_gen = browser_state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    browser_state.is_fullscreen.store(false, Ordering::SeqCst);

    if let Some(pill_win) = app.get_webview_window("chat_pill") {
        let _ = pill_win.set_ignore_cursor_events(false);
        let _ = pill_win.show();
    }

    morph_pill(app.clone(), target_w, target_h, Some(240))?;

    if let Some(existing_bv) = app.get_webview("aiden_browser") {
        if let Some(host) = app.get_window("chat_pill") {
            if let Ok(inner) = host.inner_size() {
                sync_inbuilt_browser_bounds(&app, inner);
            }
        }
        existing_bv
            .navigate(parsed.clone())
            .map_err(|e| format!("Failed to navigate Aiden Browser: {}", e))?;
        let _ = existing_bv.set_focus();
        let _ = app.emit_to(
            "chat_pill",
            "aiden-browser-navigated",
            serde_json::json!({ "url": parsed.as_str() }),
        );
        return Ok(parsed.to_string());
    }

    let _ = app.emit_to(
        "chat_pill",
        "aiden-browser-navigated",
        serde_json::json!({ "url": parsed.as_str() }),
    );
    let _ = app.emit_to(
        "chat_pill",
        "aiden-browser-loading",
        serde_json::json!({ "loading": true }),
    );

    let app_handle = app.clone();
    let parsed_clone = parsed.clone();
    std::thread::spawn(move || {
        // Wait for the liquid-glass 960x600 morph to finish before attaching WebView2 off the main IPC thread.
        std::thread::sleep(Duration::from_millis(250));
        let state = app_handle.state::<AidenBrowserState>();
        if state.generation.load(Ordering::SeqCst) != seq_gen {
            return;
        }
        let Some(pill_host) = app_handle.get_window("chat_pill") else {
            return;
        };
        let full_size = pill_host.inner_size().ok();
        if let Some(existing_bv) = app_handle.get_webview("aiden_browser") {
            if let Some(sz) = full_size {
                sync_inbuilt_browser_bounds(&app_handle, sz);
            }
            let _ = existing_bv.navigate(parsed_clone);
            return;
        }

        let profile_dir = get_user_data_dir().join("browser_profile");
        let _ = std::fs::create_dir_all(&profile_dir);

        let initial_dark = state.is_dark_mode.load(Ordering::SeqCst);
        let initial_bg = if initial_dark {
            Color(17, 19, 24, 255)
        } else {
            Color(242, 244, 248, 255)
        };
        let theme_seed_js = format!("window.__aidenBrowserDarkMode={};", initial_dark);
        let initial_revealed = Arc::new(AtomicBool::new(false));

        let app_for_nav = app_handle.clone();
        let app_for_load = app_handle.clone();
        let app_for_new = app_handle.clone();
        let revealed_for_load = initial_revealed.clone();

        let builder = WebviewBuilder::new("aiden_browser", WebviewUrl::External(parsed_clone))
            .data_directory(profile_dir)
            .background_color(initial_bg)
            .initialization_script_for_all_frames(INVISIBLE_SCROLLBAR_JS)
            .initialization_script(theme_seed_js)
            .initialization_script(AIDEN_BROWSER_HUD_JS)
            .on_navigation(move |nav_url| {
                let allowed = matches!(
                    nav_url.scheme(),
                    "http" | "https" | "about" | "blob" | "data"
                );
                if allowed && (nav_url.scheme() == "http" || nav_url.scheme() == "https") {
                    let _ = app_for_nav.emit_to(
                        "chat_pill",
                        "aiden-browser-navigated",
                        serde_json::json!({ "url": nav_url.as_str() }),
                    );
                }
                allowed
            })
            .on_page_load(move |wv, payload| {
                let is_loading = matches!(payload.event(), PageLoadEvent::Started);
                let _ = app_for_load.emit_to(
                    "chat_pill",
                    "aiden-browser-loading",
                    serde_json::json!({ "loading": is_loading }),
                );
                let u = payload.url().as_str();
                if u.starts_with("http://") || u.starts_with("https://") {
                    let _ = app_for_load.emit_to(
                        "chat_pill",
                        "aiden-browser-navigated",
                        serde_json::json!({ "url": u }),
                    );
                }
                if !is_loading {
                    let is_dark = app_for_load
                        .try_state::<AidenBrowserState>()
                        .map(|s| s.is_dark_mode.load(Ordering::SeqCst))
                        .unwrap_or(true);
                    let _ = wv.eval(INVISIBLE_SCROLLBAR_JS);
                    let _ = wv.eval(&format!("window.__aidenBrowserDarkMode={};", is_dark));
                    let _ = wv.eval(AIDEN_BROWSER_HUD_JS);
                    let _ = wv.eval(&format!(
                        "window.__aidenBrowserCornersApi&&window.__aidenBrowserCornersApi.setDarkMode({});",
                        is_dark
                    ));
                    if u != "about:blank" && !revealed_for_load.swap(true, Ordering::SeqCst) {
                        let app_reveal = app_for_load.clone();
                        std::thread::spawn(move || {
                            // Brief compositor settle so Chromium paints first frame before showing child HWND
                            std::thread::sleep(Duration::from_millis(90));
                            reveal_inbuilt_browser_on_main(app_reveal, seq_gen);
                        });
                    }
                }
            })
            .on_new_window(move |target_url, _features| {
                if target_url.scheme() == "http" || target_url.scheme() == "https" {
                    if let Some(bv) = app_for_new.get_webview("aiden_browser") {
                        let _ = bv.navigate(target_url);
                    }
                }
                NewWindowResponse::Deny
            });

        let attach_res = if let Some(sz) = full_size {
            let scale = app_handle
                .get_webview_window("chat_pill")
                .and_then(|w| w.scale_factor().ok())
                .unwrap_or(1.0);
            let bar_h = (AIDEN_BROWSER_BAR_H * scale).round() as i32;
            let avail_h = (sz.height as i32 - bar_h).max(120) as u32;
            pill_host.add_child(
                builder,
                PhysicalPosition::new(0, bar_h),
                tauri::PhysicalSize::new(sz.width, avail_h),
            )
        } else {
            pill_host.add_child(
                builder,
                LogicalPosition::new(0.0, AIDEN_BROWSER_BAR_H),
                LogicalSize::new(target_w, (target_h - AIDEN_BROWSER_BAR_H).max(240.0)),
            )
        };

        match attach_res {
            Ok(bv) => {
                // Keep WebView2 hidden briefly while Siri Aurora plays cleanly during initial page load
                let _ = bv.hide();
                if let Ok(exact_sz) = pill_host.inner_size() {
                    sync_inbuilt_browser_bounds(&app_handle, exact_sz);
                }
                let app_fallback = app_handle.clone();
                let revealed_fallback = initial_revealed.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(1650));
                    if !revealed_fallback.swap(true, Ordering::SeqCst) {
                        reveal_inbuilt_browser_on_main(app_fallback, seq_gen);
                    }
                });
                #[cfg(target_os = "windows")]
                {
                    let app_for_msg = app_handle.clone();
                    let _ = bv.with_webview(move |platform_wv| {
                        use webview2_com::{take_pwstr, WebMessageReceivedEventHandler};
                        use windows::core::PWSTR;
                        unsafe {
                            if let Ok(core) = platform_wv.controller().CoreWebView2() {
                                let mut token: i64 = 0;
                                let handler = WebMessageReceivedEventHandler::create(Box::new(move |_, args| {
                                    if let Some(args) = args {
                                        let mut msg_ptr = PWSTR::null();
                                        if args.TryGetWebMessageAsString(&mut msg_ptr).is_ok() {
                                            let msg = take_pwstr(msg_ptr);
                                            if msg == "__aiden_hud__:fs:1" || msg == "__aiden_hud__:fs:0" {
                                                let enter_fs = msg.ends_with(":1");
                                                if let Some(st) = app_for_msg.try_state::<AidenBrowserState>() {
                                                    st.is_fullscreen.store(enter_fs, Ordering::SeqCst);
                                                }
                                                let app_fs = app_for_msg.clone();
                                                let _ = app_for_msg.run_on_main_thread(move || {
                                                    if let Some(win) = app_fs.get_window("chat_pill") {
                                                        if let Ok(sz) = win.inner_size() {
                                                            sync_inbuilt_browser_bounds(&app_fs, sz);
                                                        }
                                                    }
                                                });
                                            }
                                        }
                                    }
                                    Ok(())
                                }));
                                let _ = core.add_WebMessageReceived(&handler, &mut token);
                            }
                        }
                    });
                }
                let _ = bv.set_focus();
            }
            Err(err) => {
                eprintln!("[BROWSER] Failed to attach aiden_browser Webview: {}", err);
                let _ = app_handle.emit_to(
                    "chat_pill",
                    "aiden-browser-loading",
                    serde_json::json!({ "loading": false }),
                );
            }
        }
    });

    Ok(parsed.to_string())
}

#[tauri::command]
fn close_inbuilt_browser(app: AppHandle) -> Result<(), String> {
    close_inbuilt_browser_internal(&app);
    let _ = app.emit_to(
        "chat_pill",
        "aiden-browser-loading",
        serde_json::json!({ "loading": false }),
    );
    focus_chat_pill_native(&app);
    Ok(())
}

#[tauri::command]
fn browser_navigate_action(
    app: AppHandle,
    action: String,
    url: Option<String>,
) -> Result<String, String> {
    let Some(bv) = app.get_webview("aiden_browser") else {
        return Err("Aiden Browser is not currently open.".to_string());
    };
    match action.trim().to_ascii_lowercase().as_str() {
        "back" => {
            bv.eval("window.history.back();")
                .map_err(|e| format!("Back failed: {}", e))?;
            Ok("Navigated back in Aiden Browser.".to_string())
        }
        "forward" => {
            bv.eval("window.history.forward();")
                .map_err(|e| format!("Forward failed: {}", e))?;
            Ok("Navigated forward in Aiden Browser.".to_string())
        }
        "reload" | "refresh" => {
            bv.eval("window.location.reload();")
                .map_err(|e| format!("Reload failed: {}", e))?;
            Ok("Reloaded page in Aiden Browser.".to_string())
        }
        "goto" | "navigate" | "open" => {
            let raw = url.ok_or_else(|| "URL is required for goto navigation.".to_string())?;
            let parsed = normalize_browser_url(&raw)?;
            bv.navigate(parsed.clone())
                .map_err(|e| format!("Navigate failed: {}", e))?;
            let _ = app.emit_to(
                "chat_pill",
                "aiden-browser-navigated",
                serde_json::json!({ "url": parsed.as_str() }),
            );
            Ok(format!("Navigated Aiden Browser to {}", parsed))
        }
        other => Err(format!("Unsupported browser navigation action '{}'.", other)),
    }
}

#[tauri::command]
fn browser_scroll_action(
    app: AppHandle,
    direction: String,
    amount: Option<String>,
) -> Result<(), String> {
    let Some(bv) = app.get_webview("aiden_browser") else {
        return Err("Aiden Browser is not currently open.".to_string());
    };
    let dir = direction.trim().to_ascii_lowercase();
    let amt = amount.unwrap_or_else(|| "half".to_string()).trim().to_ascii_lowercase();
    let script = match dir.as_str() {
        "top" => "window.scrollTo({ top: 0, behavior: 'smooth' });".to_string(),
        "bottom" => {
            "window.scrollTo({ top: Math.max(document.body.scrollHeight, document.documentElement.scrollHeight), behavior: 'smooth' });"
                .to_string()
        }
        "up" | "down" => {
            let delta_expr = match amt.as_str() {
                "small" | "short" => "220",
                "page" | "full" => "Math.round(window.innerHeight * 0.88)",
                _ => "Math.round(window.innerHeight * 0.55)",
            };
            let sign = if dir == "up" { "-" } else { "" };
            format!("window.scrollBy({{ top: {}{}, behavior: 'smooth' }});", sign, delta_expr)
        }
        _ => return Err(format!("Unsupported scroll direction '{}'.", direction)),
    };
    bv.eval(&script)
        .map_err(|e| format!("Scroll failed: {}", e))?;
    Ok(())
}

#[tauri::command]
fn hide_chat_pill(app: AppHandle) -> Result<(), String> {
    stop_pip_cursor_watcher(&app);
    #[cfg(target_os = "windows")]
    {
        let morph_state = app.state::<MorpherState>();
        if let Ok(guard) = morph_state.0.lock() {
            if let Some(morpher) = guard.as_ref() {
                // Guard against race if user re-woke AIDEN just before React's safety fallback fired
                if morpher.is_awake() {
                    return Ok(());
                }
            }
        }
    }
    close_inbuilt_browser_internal(&app);
    stop_pip_bop_immediately(&app);
    hide_pip_bubble_immediately(&app);
    hide_pip_headphones_immediately(&app);
    hide_search_drawer_immediately(&app);
    if let Some(pill_win) = app.get_webview_window("chat_pill") {
        let _ = pill_win.set_ignore_cursor_events(true);
        let _ = pill_win.hide();
        let _ = pill_win.set_size(LogicalSize::new(466.0, 60.0));
    }
    Ok(())
}

fn compute_bubble_placement(app: &AppHandle) -> Option<(i32, i32, i32, i32, bool)> {
    #[cfg(target_os = "windows")]
    {
        let pill_win = app.get_webview_window("chat_pill")?;
        let scale = pill_win.scale_factor().unwrap_or(1.0);
        let morph_state = app.state::<MorpherState>();
        let cube_rect = if let Ok(guard) = morph_state.0.lock() {
            guard.as_ref().map(|m| m.live_rect())
        } else {
            None
        }?;
        let bounds = native_window::get_virtual_screen_bounds();
        return Some(native_window::compute_pip_bubble_rect(
            cube_rect.x,
            cube_rect.y,
            cube_rect.width,
            scale,
            bounds,
        ));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        None
    }
}

fn sync_pip_bubble_position(app: &AppHandle) {
    let bubble_state = app.state::<PipBubbleState>();
    if !bubble_state.visible.load(Ordering::Acquire) {
        return;
    }
    if let Some((bx, by, bw, bh, flip_right)) = compute_bubble_placement(app) {
        if let Some(bubble_win) = app.get_webview_window("pip_bubble") {
            #[cfg(target_os = "windows")]
            if let Ok(hwnd) = bubble_win.hwnd() {
                native_window::move_window_topmost_noactivate(hwnd, bx, by, bw, bh);
            }
            let prev_flip = bubble_state.last_flip_right.swap(flip_right, Ordering::SeqCst);
            if prev_flip != flip_right {
                let _ = app.emit_to(
                    "pip_bubble",
                    "pip-bubble-flip",
                    serde_json::json!({ "flipRight": flip_right }),
                );
            }
        }
    }
}

fn hide_pip_bubble_immediately(app: &AppHandle) {
    let bubble_state = app.state::<PipBubbleState>();
    bubble_state.generation.fetch_add(1, Ordering::SeqCst);
    bubble_state.visible.store(false, Ordering::Release);
    let _ = app.emit_to(
        "pip_bubble",
        "pip-bubble-sync",
        serde_json::json!({ "kind": serde_json::Value::Null }),
    );
    if let Some(bubble_win) = app.get_webview_window("pip_bubble") {
        #[cfg(target_os = "windows")]
        if let Ok(hwnd) = bubble_win.hwnd() {
            native_window::hide_window_clean(hwnd);
            return;
        }
        let _ = bubble_win.hide();
    }
}

#[tauri::command]
fn set_pip_bubble(
    app: AppHandle,
    kind: Option<String>,
    dark_mode: Option<bool>,
    battery_pct: Option<u8>,
) -> Result<(), String> {
    let bubble_state = app.state::<PipBubbleState>();
    let gen_id = bubble_state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let is_dark = dark_mode.unwrap_or(true);

    let Some(bubble_win) = app.get_webview_window("pip_bubble") else {
        return Ok(());
    };

    if let Some(k) = kind {
        bubble_state.visible.store(true, Ordering::Release);
        let flip_right = if let Some((bx, by, bw, bh, flip)) = compute_bubble_placement(&app) {
            bubble_state.last_flip_right.store(flip, Ordering::Release);
            #[cfg(target_os = "windows")]
            if let Ok(hwnd) = bubble_win.hwnd() {
                native_window::make_noactivate_tool_window(hwnd);
                native_window::move_window_topmost_noactivate(hwnd, bx, by, bw, bh);
            }
            flip
        } else {
            bubble_state.last_flip_right.load(Ordering::Acquire)
        };

        let _ = bubble_win.set_always_on_top(true);
        let _ = bubble_win.set_ignore_cursor_events(true);
        let _ = app.emit_to(
            "pip_bubble",
            "pip-bubble-sync",
            serde_json::json!({
                "kind": k,
                "flipRight": flip_right,
                "darkMode": is_dark,
                "batteryPct": battery_pct.unwrap_or(100),
            }),
        );

        #[cfg(target_os = "windows")]
        if let Ok(hwnd) = bubble_win.hwnd() {
            native_window::show_window_noactivate(hwnd);
            return Ok(());
        }
        let _ = bubble_win.show();
    } else {
        let flip = bubble_state.last_flip_right.load(Ordering::Acquire);
        let _ = app.emit_to(
            "pip_bubble",
            "pip-bubble-sync",
            serde_json::json!({
                "kind": serde_json::Value::Null,
                "flipRight": flip,
                "darkMode": is_dark,
            }),
        );
        let visible_arc = Arc::clone(&bubble_state.visible);
        let gen_arc = Arc::clone(&bubble_state.generation);
        let app_clone = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(220));
            if gen_arc.load(Ordering::Acquire) == gen_id {
                visible_arc.store(false, Ordering::Release);
                if let Some(bw) = app_clone.get_webview_window("pip_bubble") {
                    #[cfg(target_os = "windows")]
                    if let Ok(hwnd) = bw.hwnd() {
                        native_window::hide_window_clean(hwnd);
                        return;
                    }
                    let _ = bw.hide();
                }
            }
        });
    }
    Ok(())
}

#[tauri::command]
async fn get_pip_power_status(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            if let Some(curr) = native_window::get_system_power_snapshot() {
                let power_state = app.state::<PipPowerState>();
                if let Ok(mut guard) = power_state.0.lock() {
                    if guard.is_none() {
                        *guard = Some(curr);
                    }
                }
                return Ok(serde_json::json!({
                    "hasBattery": curr.has_battery,
                    "pluggedIn": curr.plugged_in,
                    "percent": curr.percent,
                }));
            }
        }
        let _ = app;
        Ok(serde_json::json!({
            "hasBattery": false,
            "pluggedIn": true,
            "percent": 100,
        }))
    })
    .await
    .map_err(|e| format!("Power status background task error: {}", e))?
}

fn compute_headphones_placement(app: &AppHandle) -> Option<(i32, i32, i32, i32)> {
    #[cfg(target_os = "windows")]
    {
        let pill_win = app.get_webview_window("chat_pill")?;
        let scale = pill_win.scale_factor().unwrap_or(1.0);
        let morph_state = app.state::<MorpherState>();
        let cube_rect = if let Ok(guard) = morph_state.0.lock() {
            guard.as_ref().map(|m| m.live_rect())
        } else {
            None
        }?;
        return Some(native_window::compute_pip_headphones_rect(
            cube_rect.x,
            cube_rect.y,
            scale,
        ));
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        None
    }
}

fn sync_pip_headphones_position(app: &AppHandle) {
    let hp_state = app.state::<PipHeadphonesState>();
    if !hp_state.visible.load(Ordering::Acquire) {
        return;
    }
    if let Some((hx, hy, hw, hh)) = compute_headphones_placement(app) {
        if let Some(hp_win) = app.get_webview_window("pip_headphones") {
            #[cfg(target_os = "windows")]
            if let Ok(hwnd) = hp_win.hwnd() {
                native_window::move_window_topmost_noactivate(hwnd, hx, hy, hw, hh);
            }
        }
    }
}

fn hide_pip_headphones_immediately(app: &AppHandle) {
    let hp_state = app.state::<PipHeadphonesState>();
    hp_state.generation.fetch_add(1, Ordering::SeqCst);
    hp_state.visible.store(false, Ordering::Release);
    let _ = app.emit_to(
        "pip_headphones",
        "pip-headphones-sync",
        serde_json::json!({
            "mode": "off",
            "playing": false,
            "paused": false,
        }),
    );
    if let Some(hp_win) = app.get_webview_window("pip_headphones") {
        #[cfg(target_os = "windows")]
        if let Ok(hwnd) = hp_win.hwnd() {
            native_window::hide_window_clean(hwnd);
            return;
        }
        let _ = hp_win.hide();
    }
}

#[tauri::command]
fn set_pip_headphones(
    app: AppHandle,
    mode: String,
    dark_mode: Option<bool>,
    playing: Option<bool>,
    paused: Option<bool>,
    bpm: Option<f64>,
) -> Result<(), String> {
    let hp_state = app.state::<PipHeadphonesState>();
    let gen_id = hp_state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let is_dark = dark_mode.unwrap_or(true);
    let is_playing = playing.unwrap_or(false);
    let is_paused = paused.unwrap_or(false);
    let tempo_bpm = bpm.unwrap_or(112.0);

    let Some(hp_win) = app.get_webview_window("pip_headphones") else {
        return Ok(());
    };

    match mode.as_str() {
        "on" => {
            hp_state.visible.store(true, Ordering::Release);
            if let Some((hx, hy, hw, hh)) = compute_headphones_placement(&app) {
                #[cfg(target_os = "windows")]
                if let Ok(hwnd) = hp_win.hwnd() {
                    native_window::make_noactivate_tool_window(hwnd);
                    native_window::move_window_topmost_noactivate(hwnd, hx, hy, hw, hh);
                }
            }
            let _ = hp_win.set_always_on_top(true);
            let _ = hp_win.set_ignore_cursor_events(true);
            let _ = app.emit_to(
                "pip_headphones",
                "pip-headphones-sync",
                serde_json::json!({
                    "mode": "on",
                    "darkMode": is_dark,
                    "playing": is_playing,
                    "paused": is_paused,
                    "bpm": tempo_bpm,
                }),
            );
            #[cfg(target_os = "windows")]
            if let Ok(hwnd) = hp_win.hwnd() {
                native_window::show_window_noactivate(hwnd);
                // Keep comment bubble above headphones if currently open
                sync_pip_bubble_position(&app);
                return Ok(());
            }
            let _ = hp_win.show();
        }
        "removing" => {
            let _ = app.emit_to(
                "pip_headphones",
                "pip-headphones-sync",
                serde_json::json!({
                    "mode": "removing",
                    "darkMode": is_dark,
                    "playing": false,
                    "paused": false,
                    "bpm": tempo_bpm,
                }),
            );
            let visible_arc = Arc::clone(&hp_state.visible);
            let gen_arc = Arc::clone(&hp_state.generation);
            let app_clone = app.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(540));
                if gen_arc.load(Ordering::Acquire) == gen_id {
                    visible_arc.store(false, Ordering::Release);
                    let _ = app_clone.emit_to(
                        "pip_headphones",
                        "pip-headphones-sync",
                        serde_json::json!({
                            "mode": "off",
                            "playing": false,
                            "paused": false,
                        }),
                    );
                    if let Some(hw) = app_clone.get_webview_window("pip_headphones") {
                        #[cfg(target_os = "windows")]
                        if let Ok(hwnd) = hw.hwnd() {
                            native_window::hide_window_clean(hwnd);
                            return;
                        }
                        let _ = hw.hide();
                    }
                }
            });
        }
        _ => {
            hide_pip_headphones_immediately(&app);
        }
    }
    Ok(())
}

#[tauri::command]
async fn get_pip_spotify_status(app: AppHandle) -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "windows")]
        {
            let curr = native_window::get_spotify_media_snapshot();
            let sp_state = app.state::<PipSpotifyState>();
            if let Ok(mut guard) = sp_state.0.lock() {
                *guard = Some(curr.clone());
            }
            return Ok(serde_json::json!({
                "running": curr.running,
                "playing": curr.playing,
                "paused": curr.paused,
                "hasTrack": curr.has_track,
                "trackKey": curr.track_key,
            }));
        }
        #[cfg(not(target_os = "windows"))]
        {
            let _ = app;
            Ok(serde_json::json!({
                "running": false,
                "playing": false,
                "paused": false,
                "hasTrack": false,
                "trackKey": "",
            }))
        }
    })
    .await
    .map_err(|e| format!("Spotify media status background task error: {}", e))?
}

fn stop_pip_bop_immediately(app: &AppHandle) {
    let bop = app.state::<PipBopState>();
    bop.target_active.store(false, Ordering::Release);
    bop.running.store(false, Ordering::Release);
    bop.generation.fetch_add(1, Ordering::SeqCst);
    if let Ok(mut guard) = bop.home_pos.lock() {
        *guard = None;
    }
    let _ = app.emit_to(
        "chat_pill",
        "pip-beat-sync",
        serde_json::json!({ "active": false }),
    );
}

#[cfg(target_os = "windows")]
fn spawn_pip_bop_loop(app: AppHandle, gen_id: u64) {
    let bop = app.state::<PipBopState>();
    let gen_arc = Arc::clone(&bop.generation);
    let running_arc = Arc::clone(&bop.running);
    let target_active_arc = Arc::clone(&bop.target_active);
    let reset_seq_arc = Arc::clone(&bop.track_reset_seq);
    let home_pos_arc = Arc::clone(&bop.home_pos);

    let dragging_arc = Arc::clone(&app.state::<PipWatchState>().is_dragging);
    let hp_visible_arc = Arc::clone(&app.state::<PipHeadphonesState>().visible);
    let bub_visible_arc = Arc::clone(&app.state::<PipBubbleState>().visible);
    let bub_flip_arc = Arc::clone(&app.state::<PipBubbleState>().last_flip_right);

    std::thread::spawn(move || {
        let mut loopback = audio_beat::wasapi::LoopbackReader::open();
        let initial_sr = loopback.as_ref().map(|r| r.sample_rate()).unwrap_or(48_000);
        let mut tracker = audio_beat::BassBeatTracker::new(initial_sr);
        let mut last_reset_seq = reset_seq_arc.load(Ordering::Acquire);
        let mut last_reopen_try = Instant::now();

        let mut last_frame = Instant::now();
        let mut last_emit = Instant::now();
        let mut last_emitted_beat_idx: u64 = u64::MAX;

        let mut cur_dx = 0.0f64;
        let mut cur_dy = 0.0f64;
        let mut last_applied_pos: Option<(i32, i32)> = None;

        while gen_arc.load(Ordering::Acquire) == gen_id {
            native_window::dwm_flush_vsync();
            if gen_arc.load(Ordering::Acquire) != gen_id {
                break;
            }

            let now = Instant::now();
            let dt = now
                .duration_since(last_frame)
                .as_secs_f64()
                .clamp(0.004, 0.05);
            last_frame = now;

            // Reset BPM interval memory cleanly on track switches
            let seq_now = reset_seq_arc.load(Ordering::Acquire);
            if seq_now != last_reset_seq {
                last_reset_seq = seq_now;
                tracker.reset_for_new_track();
            }

            let Some(pill_win) = app.get_webview_window("chat_pill") else {
                break;
            };
            let Ok(cube_hwnd) = pill_win.hwnd() else {
                break;
            };
            let scale = pill_win.scale_factor().unwrap_or(1.0);

            // Inspect WindowMorpher state safely without holding the lock across Win32 moves
            let (pip_active, is_morphing, live_rect) = {
                let morph_state = app.state::<MorpherState>();
                if let Ok(guard) = morph_state.0.lock() {
                    if let Some(m) = guard.as_ref() {
                        (m.is_pip_active(), m.is_morphing(), m.live_rect())
                    } else {
                        break;
                    }
                } else {
                    break;
                }
            };

            if !pip_active {
                break;
            }

            if is_morphing || dragging_arc.load(Ordering::Acquire) {
                cur_dx = 0.0;
                cur_dy = 0.0;
                last_applied_pos = None;
                if let Ok(mut hp) = home_pos_arc.lock() {
                    *hp = None;
                }
                continue;
            }

            // Capture home resting anchor once after morph or drag settles
            let (home_x, home_y) = {
                let mut guard = home_pos_arc.lock().unwrap();
                if let Some(pos) = *guard {
                    pos
                } else {
                    let pos = (live_rect.x, live_rect.y);
                    *guard = Some(pos);
                    pos
                }
            };

            let want_active = target_active_arc.load(Ordering::Acquire);

            // Pump live WASAPI loopback audio only while actively bopping
            if want_active {
                if loopback.is_none() && now.duration_since(last_reopen_try) >= Duration::from_secs(2) {
                    last_reopen_try = now;
                    loopback = audio_beat::wasapi::LoopbackReader::open();
                    if let Some(ref r) = loopback {
                        tracker.set_sample_rate(r.sample_rate());
                    }
                }
                if let Some(ref mut reader) = loopback {
                    match reader.drain_mono() {
                        Some(samples) if !samples.is_empty() => {
                            tracker.push_mono_samples(samples);
                        }
                        Some(_) => {}
                        None => {
                            // Audio endpoint switched/invalidated — drop cleanly & retry later
                            loopback = None;
                            last_reopen_try = now;
                        }
                    }
                }
            }

            let clock = tracker.advance_clock(dt);
            let (target_dx, target_dy) = if want_active {
                audio_beat::compute_bop_target_logical(clock)
            } else {
                (0.0, 0.0)
            };

            let follow_k = 1.0 - (-24.0 * dt).exp();
            cur_dx += (target_dx - cur_dx) * follow_k;
            cur_dy += (target_dy - cur_dy) * follow_k;

            let settled_home = !want_active && cur_dx.abs() < 0.18 && cur_dy.abs() < 0.18;
            let (raw_x, raw_y) = if settled_home {
                (home_x, home_y)
            } else {
                (
                    home_x + (cur_dx * scale).round() as i32,
                    home_y + (cur_dy * scale).round() as i32,
                )
            };

            let bounds = native_window::get_virtual_screen_bounds();
            let pad = (4.0 * scale).round() as i32;
            let (tx, ty) = native_window::clamp_origin_to_bounds(
                raw_x,
                raw_y,
                live_rect.width,
                live_rect.height,
                bounds,
                pad,
            );

            if last_applied_pos != Some((tx, ty)) {
                last_applied_pos = Some((tx, ty));

                let hp_arg = if hp_visible_arc.load(Ordering::Acquire) {
                    app.get_webview_window("pip_headphones")
                        .and_then(|w| w.hwnd().ok())
                        .map(|h| {
                            let (hx, hy, hw, hh) =
                                native_window::compute_pip_headphones_rect(tx, ty, scale);
                            (h, hx, hy, hw, hh)
                        })
                } else {
                    None
                };

                let mut flip_changed: Option<bool> = None;
                let bubble_arg = if bub_visible_arc.load(Ordering::Acquire) {
                    app.get_webview_window("pip_bubble")
                        .and_then(|w| w.hwnd().ok())
                        .map(|h| {
                            let (bx, by, bw, bh, flip) = native_window::compute_pip_bubble_rect(
                                tx,
                                ty,
                                live_rect.width,
                                scale,
                                bounds,
                            );
                            let prev_flip = bub_flip_arc.swap(flip, Ordering::SeqCst);
                            if prev_flip != flip {
                                flip_changed = Some(flip);
                            }
                            (h, bx, by, bw, bh)
                        })
                } else {
                    None
                };

                native_window::atomic_move_pip_group(cube_hwnd, tx, ty, hp_arg, bubble_arg);

                if let Some(flip) = flip_changed {
                    let _ = app.emit_to(
                        "pip_bubble",
                        "pip-bubble-flip",
                        serde_json::json!({ "flipRight": flip }),
                    );
                }

                let morph_state = app.state::<MorpherState>();
                if let Ok(guard) = morph_state.0.lock() {
                    if let Some(m) = guard.as_ref() {
                        m.sync_bop_rect(tx, ty);
                    }
                }
            }

            // Emit beat sync to frontend eyes/rim (~20Hz or immediately on each new beat)
            let beat_idx = clock.beat_count.floor() as u64;
            if want_active
                && (beat_idx != last_emitted_beat_idx
                    || now.duration_since(last_emit) >= Duration::from_millis(50))
            {
                last_emitted_beat_idx = beat_idx;
                last_emit = now;
                let _ = app.emit_to(
                    "chat_pill",
                    "pip-beat-sync",
                    serde_json::json!({
                        "active": true,
                        "bpm": clock.bpm,
                        "beatCount": clock.beat_count,
                        "beatPhase": clock.beat_phase,
                        "sway": clock.sway.as_str(),
                        "energyScale": clock.energy_scale,
                    }),
                );
            }

            if settled_home {
                let _ = app.emit_to(
                    "chat_pill",
                    "pip-beat-sync",
                    serde_json::json!({ "active": false }),
                );
                break;
            }
        }

        // Only clear `running` if we are still the active generation
        if gen_arc.load(Ordering::Acquire) == gen_id {
            running_arc.store(false, Ordering::Release);
            if let Ok(mut guard) = home_pos_arc.lock() {
                *guard = None;
            }
        }
    });
}

#[tauri::command]
fn set_pip_music_bop(
    app: AppHandle,
    active: bool,
    track_reset: Option<bool>,
) -> Result<(), String> {
    let bop = app.state::<PipBopState>();
    if track_reset.unwrap_or(false) {
        bop.track_reset_seq.fetch_add(1, Ordering::SeqCst);
    }

    if active {
        bop.target_active.store(true, Ordering::Release);
        #[cfg(target_os = "windows")]
        if !bop.running.swap(true, Ordering::SeqCst) {
            let gen_id = bop.generation.fetch_add(1, Ordering::SeqCst) + 1;
            if let Ok(mut guard) = bop.home_pos.lock() {
                *guard = None;
            }
            spawn_pip_bop_loop(app.clone(), gen_id);
        }
    } else {
        bop.target_active.store(false, Ordering::Release);
    }
    Ok(())
}

fn capture_previous_foreground(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let Some(fg_raw) = native_window::get_foreground_hwnd_raw() else {
            return;
        };
        let mut is_own = false;
        for label in ["main", "chat_pill", "pip_bubble", "pip_headphones", "search_drawer"] {
            if let Some(w) = app.get_webview_window(label) {
                if let Ok(h) = w.hwnd() {
                    if (h.0 as isize) == fg_raw {
                        is_own = true;
                        break;
                    }
                }
            }
        }
        if !is_own {
            let prev = app.state::<PrevForegroundState>();
            if let Ok(mut guard) = prev.0.lock() {
                *guard = Some(fg_raw);
            }
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

fn restore_previous_foreground(app: &AppHandle) {
    #[cfg(target_os = "windows")]
    {
        let prev_hwnd = {
            let prev = app.state::<PrevForegroundState>();
            prev.0.lock().ok().and_then(|mut g| g.take())
        };
        if let Some(hwnd_raw) = prev_hwnd {
            native_window::restore_foreground_window(hwnd_raw);
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
    }
}

fn focus_chat_pill_native(app: &AppHandle) {
    let app_for_main = app.clone();
    let _ = app.run_on_main_thread(move || {
        if let Some(pill_win) = app_for_main.get_webview_window("chat_pill") {
            let _ = pill_win.set_always_on_top(true);
            #[cfg(target_os = "windows")]
            if let Ok(hwnd) = pill_win.hwnd() {
                native_window::force_foreground_window(hwnd);
            }
            let _ = pill_win.set_focus();
            // With Tauri's `unstable` multi-webview mode, primary WebviewWindows are WebviewKind::WindowChild,
            // so `Window::set_focus()` alone no longer forwards WM_SETFOCUS -> MoveFocus to WebView2.
            // Explicitly focus the `"chat_pill"` WebView controller so Chromium receives keyboard focus.
            if let Some(pill_wv) = app_for_main.get_webview("chat_pill") {
                let _ = pill_wv.set_focus();
            }
            let _ = app_for_main.emit_to("chat_pill", "aiden-focus-input", serde_json::json!({}));
        }
    });
}

#[tauri::command]
fn set_win_key_override(enabled: bool) -> Result<bool, String> {
    win_hotkey::set_enabled(enabled);
    Ok(win_hotkey::is_enabled())
}

#[tauri::command]
fn get_win_key_override() -> Result<bool, String> {
    Ok(win_hotkey::is_enabled())
}

fn hide_search_drawer_immediately(app: &AppHandle) {
    let drawer_state = app.state::<SearchDrawerState>();
    drawer_state.generation.fetch_add(1, Ordering::SeqCst);
    drawer_state.height_gen.fetch_add(1, Ordering::SeqCst);
    drawer_state.current_h_phys.store(0, Ordering::Release);
    drawer_state.visible.store(false, Ordering::Release);
    if let Ok(mut guard) = drawer_state.last_payload.lock() {
        *guard = Some(serde_json::json!({ "open": false, "closing": false }));
    }
    let _ = app.emit_to(
        "search_drawer",
        "search-drawer-sync",
        serde_json::json!({ "open": false, "closing": false }),
    );
    if let Some(drawer_win) = app.get_webview_window("search_drawer") {
        #[cfg(target_os = "windows")]
        if let Ok(hwnd) = drawer_win.hwnd() {
            native_window::hide_window_clean(hwnd);
            return;
        }
        let _ = drawer_win.hide();
    }
}

#[tauri::command]
fn get_search_drawer_state(state: State<'_, SearchDrawerState>) -> Result<serde_json::Value, String> {
    if let Ok(guard) = state.last_payload.lock() {
        if let Some(val) = guard.as_ref() {
            return Ok(val.clone());
        }
    }
    Ok(serde_json::json!({ "open": false, "closing": false }))
}

#[tauri::command]
async fn search_unified(
    state: State<'_, SearchIndexState>,
    query: String,
    include_files: Option<bool>,
) -> Result<search_index::SearchResponse, String> {
    let mgr = Arc::clone(&state.0);
    let want_files = include_files.unwrap_or(true);
    tauri::async_runtime::spawn_blocking(move || mgr.search(&query, want_files))
        .await
        .map_err(|e| format!("Search worker failed: {}", e))
}

#[tauri::command]
fn launch_search_item(
    app: AppHandle,
    state: State<'_, SearchIndexState>,
    item: search_index::SearchItem,
    reveal_in_explorer: Option<bool>,
    run_as_admin: Option<bool>,
) -> Result<(), String> {
    hide_search_drawer_immediately(&app);
    // Clear previous foreground HWND so collapsing AIDEN into her cube never steals focus
    // away from the newly launched app/file back to the old window!
    if let Ok(mut prev) = app.state::<PrevForegroundState>().0.lock() {
        *prev = None;
    }
    #[cfg(target_os = "windows")]
    native_window::allow_any_foreground_activation();

    let launched_name = item.name.clone();
    let _ = app.emit_to(
        "chat_pill",
        "search-drawer-launched",
        serde_json::json!({ "name": launched_name }),
    );

    let mgr = Arc::clone(&state.0);
    let reveal = reveal_in_explorer.unwrap_or(false);
    let as_admin = run_as_admin.unwrap_or(false);
    std::thread::spawn(move || {
        if let Err(e) = mgr.launch_item(&item, reveal, as_admin) {
            eprintln!("[SEARCH_LAUNCH] Failed to launch {}: {}", item.name, e);
        }
    });
    Ok(())
}

#[tauri::command]
fn sync_search_drawer(
    app: AppHandle,
    visible: bool,
    height: Option<f64>,
    dark_mode: Option<bool>,
    payload: Option<serde_json::Value>,
) -> Result<(), String> {
    let drawer_state = app.state::<SearchDrawerState>();
    let Some(drawer_win) = app.get_webview_window("search_drawer") else {
        return Ok(());
    };

    if !visible {
        let gen_id = drawer_state.generation.fetch_add(1, Ordering::SeqCst) + 1;
        if !drawer_state.visible.swap(false, Ordering::SeqCst) {
            return Ok(());
        }
        if let Ok(mut guard) = drawer_state.last_payload.lock() {
            if let Some(serde_json::Value::Object(ref mut map)) = *guard {
                map.insert("open".to_string(), serde_json::json!(false));
                map.insert("closing".to_string(), serde_json::json!(true));
            } else {
                *guard = Some(serde_json::json!({ "open": false, "closing": true }));
            }
        }
        let _ = app.emit_to(
            "search_drawer",
            "search-drawer-sync",
            serde_json::json!({ "open": false, "closing": true }),
        );

        let app_clone = app.clone();
        let gen_arc = Arc::clone(&drawer_state.generation);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(170));
            if gen_arc.load(Ordering::Acquire) == gen_id {
                let ds = app_clone.state::<SearchDrawerState>();
                ds.height_gen.fetch_add(1, Ordering::SeqCst);
                ds.current_h_phys.store(0, Ordering::Release);
                if let Ok(mut guard) = ds.last_payload.lock() {
                    if let Some(serde_json::Value::Object(ref mut map)) = *guard {
                        map.insert("open".to_string(), serde_json::json!(false));
                        map.insert("closing".to_string(), serde_json::json!(false));
                    } else {
                        *guard = Some(serde_json::json!({ "open": false, "closing": false }));
                    }
                }
                let _ = app_clone.emit_to(
                    "search_drawer",
                    "search-drawer-sync",
                    serde_json::json!({ "open": false, "closing": false }),
                );
                if let Some(dw) = app_clone.get_webview_window("search_drawer") {
                    #[cfg(target_os = "windows")]
                    if let Ok(hwnd) = dw.hwnd() {
                        native_window::hide_window_clean(hwnd);
                        return;
                    }
                    let _ = dw.hide();
                }
            }
        });
        return Ok(());
    }

    drawer_state.generation.fetch_add(1, Ordering::SeqCst);
    let target_h_log = height.unwrap_or(200.0).clamp(56.0, 400.0);
    let is_dark = dark_mode.unwrap_or(true);
    let Some(pill_win) = app.get_webview_window("chat_pill") else {
        return Ok(());
    };

    let scale = pill_win.scale_factor().unwrap_or(1.0);
    let gap_phys = (11.0 * scale).round() as i32;
    let w_phys = (466.0 * scale).round() as i32;
    let h_phys = (target_h_log * scale).round() as i32;

    #[cfg(target_os = "windows")]
    let (dx, dy, dw, dh) = {
        let pill_rect = app
            .state::<MorpherState>()
            .0
            .lock()
            .ok()
            .and_then(|g| g.as_ref().map(|m| m.live_rect()));

        let (px, py, pw, ph) = if let Some(r) = pill_rect {
            (r.x, r.y, r.width.max(w_phys), r.height.max((56.0 * scale).round() as i32))
        } else if let Some((rx, ry, rw, rh, _)) = compute_upper_third_pill_rect(&app, &pill_win) {
            (rx, ry, rw, rh)
        } else {
            (480, 140, w_phys, (60.0 * scale).round() as i32)
        };

        let bounds = native_window::get_virtual_screen_bounds();
        let min_h_phys = (56.0 * scale).round() as i32;
        let avail_h = bounds.1 + bounds.3 - (py + ph + gap_phys) - (16.0 * scale).round() as i32;
        let max_h = avail_h.max(min_h_phys).min(h_phys.max(min_h_phys));
        (px, py + ph + gap_phys, pw, max_h)
    };

    #[cfg(not(target_os = "windows"))]
    let (dx, dy, dw, dh) = (480, 212, w_phys, h_phys);

    if let Some(mut p) = payload {
        if let Some(map) = p.as_object_mut() {
            map.insert("open".to_string(), serde_json::json!(true));
            map.insert("closing".to_string(), serde_json::json!(false));
        }
        if let Ok(mut guard) = drawer_state.last_payload.lock() {
            *guard = Some(p.clone());
        }
        let _ = app.emit_to("search_drawer", "search-drawer-sync", p);
    }

    let was_visible = drawer_state.visible.swap(true, Ordering::SeqCst);
    let prev_h = drawer_state.current_h_phys.load(Ordering::Acquire);
    let h_gen = drawer_state.height_gen.fetch_add(1, Ordering::SeqCst) + 1;
    let _ = drawer_win.set_always_on_top(true);
    let _ = drawer_win.set_ignore_cursor_events(false);

    #[cfg(target_os = "windows")]
    if let Ok(hwnd) = drawer_win.hwnd() {
        native_window::make_noactivate_interactive_tool_window(hwnd);
        let _ = native_window::apply_native_drawer_chrome(hwnd, is_dark);

        if !was_visible || prev_h <= 0 || (dh - prev_h).abs() <= 2 {
            drawer_state.current_h_phys.store(dh, Ordering::Release);
            native_window::move_window_topmost_noactivate(hwnd, dx, dy, dw, dh);
            native_window::show_window_noactivate(hwnd);
        } else {
            native_window::move_window_topmost_noactivate(hwnd, dx, dy, dw, prev_h);
            native_window::show_window_noactivate(hwnd);

            let hwnd_raw = hwnd.0 as isize;
            let h_gen_arc = Arc::clone(&drawer_state.height_gen);
            let h_phys_arc = Arc::clone(&drawer_state.current_h_phys);
            let vis_arc = Arc::clone(&drawer_state.visible);
            std::thread::spawn(move || {
                let start = Instant::now();
                let dur = Duration::from_millis(135);
                loop {
                    std::thread::sleep(Duration::from_millis(8));
                    if h_gen_arc.load(Ordering::Acquire) != h_gen
                        || !vis_arc.load(Ordering::Acquire)
                    {
                        break;
                    }
                    let t = (start.elapsed().as_secs_f64() / dur.as_secs_f64()).clamp(0.0, 1.0);
                    let eased = 1.0 - (1.0 - t).powi(3);
                    let cur_h = (prev_h as f64 + (dh - prev_h) as f64 * eased).round() as i32;
                    h_phys_arc.store(cur_h, Ordering::Release);
                    let target_hwnd = windows::Win32::Foundation::HWND(hwnd_raw as *mut _);
                    native_window::move_window_topmost_noactivate(target_hwnd, dx, dy, dw, cur_h);
                    if t >= 1.0 {
                        break;
                    }
                }
            });
        }
        return Ok(());
    }

    let _ = drawer_win.set_position(Position::Physical(PhysicalPosition { x: dx, y: dy }));
    let _ = drawer_win.set_size(LogicalSize::new(466.0, target_h_log));
    let _ = drawer_win.show();
    Ok(())
}

#[tauri::command]
fn notify_search_drawer_hover(app: AppHandle, index: i32) -> Result<(), String> {
    let _ = app.emit_to(
        "chat_pill",
        "search-drawer-hover",
        serde_json::json!({ "index": index }),
    );
    Ok(())
}

#[tauri::command]
fn refresh_search_index(state: State<'_, SearchIndexState>) -> Result<(), String> {
    let mgr = Arc::clone(&state.0);
    std::thread::spawn(move || {
        mgr.rebuild_app_index();
    });
    Ok(())
}

fn compute_upper_third_pill_rect(app: &AppHandle, pill_win: &WebviewWindow) -> Option<(i32, i32, i32, i32, f64)> {
    let monitor = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| pill_win.primary_monitor().ok().flatten());

    if let Some(monitor) = monitor {
        let screen_size = monitor.size();
        let monitor_pos = monitor.position();
        let scale = monitor.scale_factor();

        let win_width = (466.0 * scale) as i32;
        let win_height = (60.0 * scale) as i32;
        let x = monitor_pos.x + ((screen_size.width as i32 - win_width) / 2);
        // Upper third / top quarter (~15% from top of monitor)
        let y = monitor_pos.y + ((screen_size.height as f64 * 0.15) as i32);
        return Some((x, y, win_width, win_height, scale));
    }
    None
}

fn center_chat_pill_in_upper_third(app: &AppHandle, pill_win: &WebviewWindow) {
    if let Some((x, y, win_width, win_height, _)) = compute_upper_third_pill_rect(app, pill_win) {
        let _ = pill_win.set_position(Position::Physical(PhysicalPosition { x, y }));

        #[cfg(target_os = "windows")]
        {
            let morph_state = app.state::<MorpherState>();
            if let Ok(guard) = morph_state.0.lock() {
                if let Some(morpher) = guard.as_ref() {
                    morpher.update_rect(native_window::RectTarget {
                        x,
                        y,
                        width: win_width,
                        height: win_height,
                    });
                }
            }
        }
    }
}

fn stop_pip_cursor_watcher(app: &AppHandle) {
    let pip_watch = app.state::<PipWatchState>();
    pip_watch.generation.fetch_add(1, Ordering::SeqCst);
    pip_watch.is_dragging.store(false, Ordering::Release);
    #[cfg(target_os = "windows")]
    {
        let morph_state = app.state::<MorpherState>();
        if let Ok(guard) = morph_state.0.lock() {
            if let Some(morpher) = guard.as_ref() {
                morpher.set_pip_active(false);
            }
        }
    }
}

#[cfg(target_os = "windows")]
fn spawn_pip_cursor_watcher(app: AppHandle, hwnd_raw: isize, scale: f64) {
    let pip_watch = app.state::<PipWatchState>();
    let gen_id = pip_watch.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let gen_arc = Arc::clone(&pip_watch.generation);
    let dragging_arc = Arc::clone(&pip_watch.is_dragging);

    // Dedicated low-frequency Spotify GSMTC poller (decoupled from the 45fps cursor/eye loop
    // so a sluggish or wedged Windows NPSMSvc can never stall eye tracking or battery alerts).
    let spotify_app = app.clone();
    let spotify_gen = Arc::clone(&gen_arc);
    std::thread::spawn(move || {
        let _winrt_mta = native_window::WinRtMtaGuard::enter();
        while spotify_gen.load(Ordering::Acquire) == gen_id {
            let curr = native_window::get_spotify_media_snapshot();
            if spotify_gen.load(Ordering::Acquire) != gen_id {
                break;
            }
            let (changed, evt) = {
                let sp_state = spotify_app.state::<PipSpotifyState>();
                let mut guard = sp_state.0.lock().unwrap();
                let chg = guard.as_ref() != Some(&curr);
                let event = if chg {
                    native_window::classify_spotify_event(guard.as_ref(), &curr)
                } else {
                    None
                };
                if chg {
                    *guard = Some(curr.clone());
                }
                (chg, event)
            };
            if changed {
                let _ = spotify_app.emit_to(
                    "chat_pill",
                    "pip-spotify-update",
                    serde_json::json!({
                        "running": curr.running,
                        "playing": curr.playing,
                        "paused": curr.paused,
                        "hasTrack": curr.has_track,
                        "trackKey": curr.track_key,
                        "event": evt,
                    }),
                );
            }
            // Sleep in short slices so stop_pip_cursor_watcher exits promptly
            for _ in 0..9 {
                if spotify_gen.load(Ordering::Acquire) != gen_id {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    });

    std::thread::spawn(move || {
        let mut last_dx = f64::NAN;
        let mut last_dy = f64::NAN;
        let mut was_near = false;
        let mut power_ticks: u32 = 20;
        let mut last_overlay_pos: Option<(i32, i32)> = None;

        while gen_arc.load(Ordering::Acquire) == gen_id {
            if !dragging_arc.load(Ordering::Acquire) {
                if let Some((dx, dy, dist)) = native_window::cursor_delta_for_hwnd(hwnd_raw, scale) {
                    let near = dist <= 560.0;
                    let moved = last_dx.is_nan()
                        || (dx - last_dx).abs() >= 0.45
                        || (dy - last_dy).abs() >= 0.45;
                    if (near && moved) || (!near && was_near) {
                        last_dx = dx;
                        last_dy = dy;
                        was_near = near;
                        let _ = app.emit_to(
                            "chat_pill",
                            "pip-cursor-update",
                            serde_json::json!({ "dx": dx, "dy": dy, "dist": dist }),
                        );
                    }
                }

                // Keep headphones & bubble overlays glued to the cube if a morph just moved it
                // (Skip while PipBopState is driving atomic EndDeferWindowPos moves!)
                let bop_running = app.state::<PipBopState>().running.load(Ordering::Acquire);
                let hp_vis = app.state::<PipHeadphonesState>().visible.load(Ordering::Acquire);
                let bub_vis = app.state::<PipBubbleState>().visible.load(Ordering::Acquire);
                if !bop_running && (hp_vis || bub_vis) {
                    let live_pos = app
                        .state::<MorpherState>()
                        .0
                        .lock()
                        .ok()
                        .and_then(|g| g.as_ref().map(|m| {
                            let r = m.live_rect();
                            (r.x, r.y)
                        }));
                    if live_pos.is_some() && live_pos != last_overlay_pos {
                        last_overlay_pos = live_pos;
                        if hp_vis {
                            sync_pip_headphones_position(&app);
                        }
                        if bub_vis {
                            sync_pip_bubble_position(&app);
                        }
                    }
                }
            }

            power_ticks = power_ticks.saturating_add(1);
            if power_ticks >= 20 {
                power_ticks = 0;
                if let Some(curr) = native_window::get_system_power_snapshot() {
                    let (changed, evt) = {
                        let power_state = app.state::<PipPowerState>();
                        let mut guard = power_state.0.lock().unwrap();
                        let prev = *guard;
                        let chg = prev != Some(curr);
                        let event = if chg {
                            native_window::classify_battery_event(prev, curr)
                        } else {
                            None
                        };
                        if chg {
                            *guard = Some(curr);
                        }
                        (chg, event)
                    };
                    if changed {
                        let _ = app.emit_to(
                            "chat_pill",
                            "pip-power-update",
                            serde_json::json!({
                                "hasBattery": curr.has_battery,
                                "pluggedIn": curr.plugged_in,
                                "percent": curr.percent,
                                "event": evt,
                            }),
                        );
                    }
                }
            }

            std::thread::sleep(Duration::from_millis(22));
        }
    });
}

fn compute_pip_dock_rect(
    app: &AppHandle,
    pill_win: &WebviewWindow,
    pip_logical: f64,
) -> (i32, i32, i32, i32, f64) {
    let scale = pill_win.scale_factor().unwrap_or(1.0);
    let pip_w = (pip_logical * scale).round() as i32;
    let pip_h = pip_w;

    let monitor = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| pill_win.primary_monitor().ok().flatten());

    let (default_x, default_y) = if let Some(mon) = monitor {
        let wa = mon.work_area();
        let margin_r = (40.0 * scale).round() as i32;
        let margin_b = (48.0 * scale).round() as i32;
        (
            wa.position.x + wa.size.width as i32 - pip_w - margin_r,
            wa.position.y + wa.size.height as i32 - pip_h - margin_b,
        )
    } else {
        (900, 700)
    };

    #[cfg(target_os = "windows")]
    {
        let bounds = native_window::get_virtual_screen_bounds();
        let pad = (8.0 * scale).round() as i32;
        let morph_state = app.state::<MorpherState>();
        if let Ok(guard) = morph_state.0.lock() {
            if let Some(morpher) = guard.as_ref() {
                if let Some((sx, sy)) = morpher.get_saved_pip_pos() {
                    let (cx, cy) = native_window::clamp_origin_to_bounds(sx, sy, pip_w, pip_h, bounds, pad);
                    return (cx, cy, pip_w, pip_h, scale);
                }
            }
        }
    }

    (default_x, default_y, pip_w, pip_h, scale)
}

#[tauri::command]
fn minimize_to_pip(app: AppHandle, size: Option<f64>) -> Result<serde_json::Value, String> {
    close_inbuilt_browser_internal(&app);
    hide_search_drawer_immediately(&app);
    let pip_logical = size.unwrap_or(68.0).clamp(48.0, 120.0);
    let pill_win = app
        .get_webview_window("chat_pill")
        .ok_or_else(|| "chat_pill window not found".to_string())?;

    let (target_x, target_y, pip_w, pip_h, scale) = compute_pip_dock_rect(&app, &pill_win, pip_logical);

    #[cfg(target_os = "windows")]
    {
        let morph_state = app.state::<MorpherState>();
        let mut hwnd_raw: isize = 0;

        if let Ok(guard) = morph_state.0.lock() {
            if let Some(morpher) = guard.as_ref() {
                morpher.set_pip_active(true);
                morpher.morph_to_rect(
                    native_window::RectTarget {
                        x: target_x,
                        y: target_y,
                        width: pip_w,
                        height: pip_h,
                    },
                    310,
                    native_window::MorphEasing::QuarticOut,
                );
                hwnd_raw = morpher.hwnd_raw();
            }
        }

        if hwnd_raw != 0 {
            spawn_pip_cursor_watcher(app.clone(), hwnd_raw, scale);
        }

        restore_previous_foreground(&app);

        return Ok(serde_json::json!({
            "x": target_x,
            "y": target_y,
            "width": pip_logical,
            "height": pip_logical,
        }));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = pill_win.set_size(LogicalSize::new(pip_logical, pip_logical));
        let _ = pill_win.set_position(Position::Physical(PhysicalPosition {
            x: target_x,
            y: target_y,
        }));
        Ok(serde_json::json!({
            "x": target_x,
            "y": target_y,
            "width": pip_logical,
            "height": pip_logical,
        }))
    }
}

#[tauri::command]
fn enter_asleep_square(app: AppHandle, size: Option<f64>) -> Result<serde_json::Value, String> {
    close_inbuilt_browser_internal(&app);
    hide_search_drawer_immediately(&app);
    let pip_logical = size.unwrap_or(68.0).clamp(48.0, 120.0);
    let pill_win = app
        .get_webview_window("chat_pill")
        .ok_or_else(|| "chat_pill window not found".to_string())?;

    let (target_x, target_y, pip_w, pip_h, scale) = compute_pip_dock_rect(&app, &pill_win, pip_logical);
    let was_visible = pill_win.is_visible().unwrap_or(false);
    let _ = pill_win.set_ignore_cursor_events(false);
    let _ = pill_win.set_always_on_top(true);

    #[cfg(target_os = "windows")]
    {
        let morph_state = app.state::<MorpherState>();
        let mut hwnd_raw: isize = 0;
        let mut morphed_from_open_pill = false;
        let mut should_show_window = false;

        if let Ok(guard) = morph_state.0.lock() {
            if let Some(morpher) = guard.as_ref() {
                morpher.set_awake_flag(false);
                let live = morpher.live_rect();
                let already_square = was_visible
                    && morpher.is_pip_active()
                    && (live.width - pip_w).abs() <= 4
                    && (live.height - pip_h).abs() <= 4;

                morpher.set_pip_active(true);
                if already_square {
                    // Already sitting cleanly as the paused square: keep eyes & position uninterrupted
                } else if was_visible {
                    morphed_from_open_pill = true;
                    morpher.morph_to_rect(
                        native_window::RectTarget {
                            x: target_x,
                            y: target_y,
                            width: pip_w,
                            height: pip_h,
                        },
                        310,
                        native_window::MorphEasing::QuarticOut,
                    );
                } else {
                    morpher.snap_to_rect(native_window::RectTarget {
                        x: target_x,
                        y: target_y,
                        width: pip_w,
                        height: pip_h,
                    });
                    should_show_window = true;
                }
                hwnd_raw = morpher.hwnd_raw();
            }
        }

        // Release MorpherState BEFORE showing/raising the window so background watcher/bop
        // threads can never collide with Win32 ShowWindow/SetWindowPos message dispatch.
        if should_show_window {
            let _ = pill_win.show();
            let _ = pill_win.set_always_on_top(true);
        }

        if hwnd_raw != 0 {
            spawn_pip_cursor_watcher(app.clone(), hwnd_raw, scale);
        }
        if morphed_from_open_pill {
            restore_previous_foreground(&app);
        }

        return Ok(serde_json::json!({
            "x": target_x,
            "y": target_y,
            "width": pip_logical,
            "height": pip_logical,
        }));
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = pill_win.set_size(LogicalSize::new(pip_logical, pip_logical));
        let _ = pill_win.set_position(Position::Physical(PhysicalPosition {
            x: target_x,
            y: target_y,
        }));
        let _ = pill_win.show();
        Ok(serde_json::json!({
            "x": target_x,
            "y": target_y,
            "width": pip_logical,
            "height": pip_logical,
        }))
    }
}

#[tauri::command]
fn maximize_from_pip(app: AppHandle, width: Option<f64>, height: Option<f64>) -> Result<(), String> {
    capture_previous_foreground(&app);
    stop_pip_bop_immediately(&app);
    stop_pip_cursor_watcher(&app);
    hide_pip_bubble_immediately(&app);
    hide_pip_headphones_immediately(&app);

    let pill_win = app
        .get_webview_window("chat_pill")
        .ok_or_else(|| "chat_pill window not found".to_string())?;

    let scale = pill_win.scale_factor().unwrap_or(1.0);
    let target_w_log = width.unwrap_or(466.0);
    let target_h_log = height.unwrap_or(320.0).clamp(60.0, 640.0);

    let monitor = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| pill_win.primary_monitor().ok().flatten());

    let (rest_x, rest_y, rest_w, rest_h) = if let Some(mon) = monitor {
        let screen_size = mon.size();
        let monitor_pos = mon.position();
        let wa = mon.work_area();
        let m_scale = mon.scale_factor();
        let s = if m_scale > 0.1 { m_scale } else { scale };
        let w = (target_w_log * s).round() as i32;
        let max_h = (wa.size.height as i32 - (40.0 * s).round() as i32).max(120);
        let h = ((target_h_log * s).round() as i32).min(max_h);
        let x = monitor_pos.x + ((screen_size.width as i32 - w) / 2);
        let raw_y = monitor_pos.y + ((screen_size.height as f64 * 0.15) as i32);
        let wa_bottom = wa.position.y + wa.size.height as i32;
        let y = raw_y.min((wa_bottom - h - (16.0 * s).round() as i32).max(wa.position.y + 12));
        (x, y, w, h)
    } else {
        let w = (target_w_log * scale).round() as i32;
        let h = (target_h_log * scale).round() as i32;
        (480, 140, w, h)
    };

    #[cfg(target_os = "windows")]
    {
        let morph_state = app.state::<MorpherState>();
        if let Ok(guard) = morph_state.0.lock() {
            if let Some(morpher) = guard.as_ref() {
                morpher.set_resting_y(rest_y);
                morpher.morph_to_rect(
                    native_window::RectTarget {
                        x: rest_x,
                        y: rest_y,
                        width: rest_w,
                        height: rest_h,
                    },
                    340,
                    native_window::MorphEasing::DynamicSpring,
                );
                drop(guard);
                focus_chat_pill_native(&app);
                return Ok(());
            }
        }
    }

    let _ = pill_win.set_position(Position::Physical(PhysicalPosition {
        x: rest_x,
        y: rest_y,
    }));
    let _ = pill_win.set_size(LogicalSize::new(target_w_log, target_h_log));
    Ok(())
}

#[tauri::command]
fn begin_pip_drag(app: AppHandle) -> Result<serde_json::Value, String> {
    let pip_watch = app.state::<PipWatchState>();
    pip_watch.is_dragging.store(true, Ordering::Release);
    if let Ok(mut guard) = app.state::<PipBopState>().home_pos.lock() {
        *guard = None;
    }

    #[cfg(target_os = "windows")]
    {
        let scale = app
            .get_webview_window("chat_pill")
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(1.0);
        let morph_state = app.state::<MorpherState>();
        if let Ok(guard) = morph_state.0.lock() {
            if let Some(morpher) = guard.as_ref() {
                if let Some((ox, oy, cx, cy)) = morpher.begin_pip_drag() {
                    return Ok(serde_json::json!({
                        "originX": ox,
                        "originY": oy,
                        "cursorX": cx,
                        "cursorY": cy,
                        "scale": scale,
                    }));
                }
            }
        }
    }
    Ok(serde_json::json!({ "ok": false }))
}

#[tauri::command]
fn step_pip_drag(app: AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let scale = app
            .get_webview_window("chat_pill")
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(1.0);
        let morph_state = app.state::<MorpherState>();
        if let Ok(guard) = morph_state.0.lock() {
            if let Some(morpher) = guard.as_ref() {
                if let Some((x, y, cx, cy)) = morpher.step_pip_drag() {
                    drop(guard);
                    sync_pip_headphones_position(&app);
                    sync_pip_bubble_position(&app);
                    return Ok(serde_json::json!({
                        "x": x,
                        "y": y,
                        "cursorX": cx,
                        "cursorY": cy,
                        "scale": scale,
                    }));
                }
            }
        }
    }
    Ok(serde_json::json!({ "ok": false }))
}

#[tauri::command]
fn end_pip_drag(app: AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let morph_state = app.state::<MorpherState>();
        if let Ok(guard) = morph_state.0.lock() {
            if let Some(morpher) = guard.as_ref() {
                if let Some((x, y)) = morpher.end_pip_drag() {
                    drop(guard);
                    if let Ok(mut hp) = app.state::<PipBopState>().home_pos.lock() {
                        *hp = Some((x, y));
                    }
                    let pip_watch = app.state::<PipWatchState>();
                    pip_watch.is_dragging.store(false, Ordering::Release);
                    sync_pip_headphones_position(&app);
                    sync_pip_bubble_position(&app);
                    return Ok(serde_json::json!({ "x": x, "y": y }));
                }
            }
        }
    }
    let pip_watch = app.state::<PipWatchState>();
    pip_watch.is_dragging.store(false, Ordering::Release);
    Ok(serde_json::json!({ "ok": true }))
}

#[tauri::command]
fn get_pip_cursor_delta(app: AppHandle) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "windows")]
    {
        let scale = app
            .get_webview_window("chat_pill")
            .and_then(|w| w.scale_factor().ok())
            .unwrap_or(1.0);
        let morph_state = app.state::<MorpherState>();
        if let Ok(guard) = morph_state.0.lock() {
            if let Some(morpher) = guard.as_ref() {
                if let Some((dx, dy, dist)) = morpher.cursor_delta_logical(scale) {
                    return Ok(serde_json::json!({ "dx": dx, "dy": dy, "dist": dist }));
                }
            }
        }
    }
    Ok(serde_json::json!({ "dx": -9999.0, "dy": -9999.0, "dist": 9999.0 }))
}

#[tauri::command]
fn set_chat_pill_state(
    app: AppHandle,
    is_awake: Option<bool>,
    is_dark_mode: Option<bool>,
    reply: Option<String>,
    expanded: Option<bool>,
) -> Result<(), String> {
    if is_awake.is_some() {
        stop_pip_bop_immediately(&app);
        stop_pip_cursor_watcher(&app);
        hide_pip_bubble_immediately(&app);
        hide_pip_headphones_immediately(&app);
    }
    if let Some(pill_win) = app.get_webview_window("chat_pill") {
        let _ = pill_win.set_always_on_top(true);
        if let Some(is_dark) = is_dark_mode {
            #[cfg(target_os = "windows")]
            {
                if let Ok(hwnd) = pill_win.hwnd() {
                    let _ = native_window::apply_native_pill_chrome(hwnd, is_dark);
                }
            }
        }
        if let Some(awake) = is_awake {
            let _ = pill_win.set_ignore_cursor_events(!awake);
            let rect_info = compute_upper_third_pill_rect(&app, &pill_win);
            if awake {
                capture_previous_foreground(&app);
                #[cfg(target_os = "windows")]
                {
                    if let Some((rx, ry, rw, rh, scale)) = rect_info {
                        let morph_state = app.state::<MorpherState>();
                        if let Ok(guard) = morph_state.0.lock() {
                            if let Some(morpher) = guard.as_ref() {
                                morpher.prepare_wake_orb(rx, ry, rw, rh, scale);
                            }
                        }
                    } else {
                        center_chat_pill_in_upper_third(&app, &pill_win);
                    }
                }
                #[cfg(not(target_os = "windows"))]
                center_chat_pill_in_upper_third(&app, &pill_win);

                let _ = pill_win.show();
                let _ = pill_win.unminimize();
                focus_chat_pill_native(&app);

                #[cfg(target_os = "windows")]
                if let Some((rx, ry, rw, rh, _)) = rect_info {
                    let morph_state = app.state::<MorpherState>();
                    if let Ok(guard) = morph_state.0.lock() {
                        if let Some(morpher) = guard.as_ref() {
                            morpher.start_wake_bloom(rx, ry, rw, rh);
                        }
                    }
                }
            } else {
                let _ = pill_win.set_ignore_cursor_events(true);
                #[cfg(target_os = "windows")]
                {
                    let mut handled = false;
                    if let Some((rx, ry, rw, rh, scale)) = rect_info {
                        let morph_state = app.state::<MorpherState>();
                        if let Ok(guard) = morph_state.0.lock() {
                            if let Some(morpher) = guard.as_ref() {
                                morpher.collapse_and_hide(rx, ry, rw, rh, scale);
                                handled = true;
                            }
                        }
                    }
                    if !handled {
                        let _ = pill_win.hide();
                    }
                }
                #[cfg(not(target_os = "windows"))]
                let _ = pill_win.hide();
            }
        }
    }

    let payload = serde_json::json!({
        "isAwake": is_awake,
        "isDarkMode": is_dark_mode,
        "reply": reply,
        "expanded": expanded,
    });
    let _ = app.emit("chat-pill-sync", payload);
    Ok(())
}

#[tauri::command]
fn minimize_to_tray(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_always_on_top(true);
        let _ = window.set_focus();
    }
}

#[derive(serde::Serialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct DroppedImagePayload {
    name: String,
    data_url: String,
}

fn image_mime_for_extension(ext: &str) -> Option<&'static str> {
    match ext.to_ascii_lowercase().as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "bmp" => Some("image/bmp"),
        _ => None,
    }
}

fn read_dropped_images_from_paths(paths: &[String]) -> Vec<DroppedImagePayload> {
    const MAX_FILES: usize = 4;
    const MAX_BYTES: u64 = 20 * 1024 * 1024;

    let mut out = Vec::new();
    for raw in paths {
        if out.len() >= MAX_FILES {
            break;
        }
        let path = PathBuf::from(raw);
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        let Some(mime) = image_mime_for_extension(ext) else {
            continue;
        };
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_BYTES {
            continue;
        }
        let Ok(bytes) = std::fs::read(&path) else {
            continue;
        };
        let encoded = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("image")
            .to_string();
        out.push(DroppedImagePayload {
            name,
            data_url: format!("data:{};base64,{}", mime, encoded),
        });
    }
    out
}

#[tauri::command]
async fn read_dropped_images(paths: Vec<String>) -> Result<Vec<DroppedImagePayload>, String> {
    tauri::async_runtime::spawn_blocking(move || read_dropped_images_from_paths(&paths))
        .await
        .map_err(|e| format!("Failed to read dropped images: {}", e))
}

#[cfg(test)]
mod dropped_image_tests {
    use super::*;

    #[test]
    fn mime_filter_accepts_images_and_rejects_other_files() {
        assert_eq!(image_mime_for_extension("PNG"), Some("image/png"));
        assert_eq!(image_mime_for_extension("jpg"), Some("image/jpeg"));
        assert_eq!(image_mime_for_extension("jpeg"), Some("image/jpeg"));
        assert_eq!(image_mime_for_extension("webp"), Some("image/webp"));
        assert_eq!(image_mime_for_extension("gif"), Some("image/gif"));
        assert_eq!(image_mime_for_extension("exe"), None);
        assert_eq!(image_mime_for_extension("txt"), None);
    }

    #[test]
    fn read_dropped_images_encodes_valid_image_and_skips_non_image() {
        let dir = std::env::temp_dir().join(format!(
            "aiden_drop_test_{}",
            std::process::id()
        ));
        let _ = std::fs::create_dir_all(&dir);
        let img_path = dir.join("sample.png");
        let txt_path = dir.join("notes.txt");
        let _ = std::fs::write(&img_path, b"\x89PNG\r\n\x1a\nfake");
        let _ = std::fs::write(&txt_path, b"hello");

        let res = read_dropped_images_from_paths(&[
            txt_path.to_string_lossy().to_string(),
            img_path.to_string_lossy().to_string(),
        ]);

        let _ = std::fs::remove_file(&img_path);
        let _ = std::fs::remove_file(&txt_path);
        let _ = std::fs::remove_dir(&dir);

        assert_eq!(res.len(), 1);
        assert_eq!(res[0].name, "sample.png");
        assert!(res[0].data_url.starts_with("data:image/png;base64,"));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackendState(Mutex::new(None)))
        .manage(MorpherState(std::sync::Mutex::new(None)))
        .manage(PipWatchState {
            generation: Arc::new(AtomicU64::new(0)),
            is_dragging: Arc::new(AtomicBool::new(false)),
        })
        .manage(PipBubbleState {
            visible: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
            last_flip_right: Arc::new(AtomicBool::new(false)),
        })
        .manage(PipHeadphonesState {
            visible: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
        })
        .manage(PipBopState {
            generation: Arc::new(AtomicU64::new(0)),
            running: Arc::new(AtomicBool::new(false)),
            target_active: Arc::new(AtomicBool::new(false)),
            track_reset_seq: Arc::new(AtomicU64::new(0)),
            home_pos: Arc::new(Mutex::new(None)),
        })
        .manage(PrevForegroundState(Mutex::new(None)))
        .manage(SearchIndexState(search_index::SearchIndexManager::new(
            get_user_data_dir(),
        )))
        .manage(SearchDrawerState {
            visible: Arc::new(AtomicBool::new(false)),
            generation: Arc::new(AtomicU64::new(0)),
            current_h_phys: Arc::new(AtomicI32::new(0)),
            height_gen: Arc::new(AtomicU64::new(0)),
            last_payload: Mutex::new(None),
        })
        .manage(PipPowerState(Mutex::new(None)))
        .manage(PipSpotifyState(Mutex::new(None)))
        .manage(AidenBrowserState {
            generation: Arc::new(AtomicU64::new(0)),
            is_fullscreen: Arc::new(AtomicBool::new(false)),
            is_dark_mode: Arc::new(AtomicBool::new(true)),
        })
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Auto-boot Aiden backend automatically on app launch
            let state = app.state::<BackendState>();
            if !is_port_8765_active() {
                match spawn_aiden_backend(&state) {
                    Ok(pid) => println!("[BOOT] Auto-booted Aiden backend (PID: {}) on app launch", pid),
                    Err(e) => eprintln!("[BOOT] Failed to auto-boot Aiden backend on launch: {}", e),
                }
            }

            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
            }

            // Position the floating Siri-style AI Pill in the upper quadrant/third of the screen
            if let Some(pill_win) = app.get_webview_window("chat_pill") {
                let _ = pill_win.set_always_on_top(true);
                let _ = pill_win.set_ignore_cursor_events(true);
                let _ = pill_win.hide();

                // 1. Center the pill window in the upper third first
                center_chat_pill_in_upper_third(&app.handle(), &pill_win);

                // Keep child Aiden Browser synced cleanly beneath the 44px bar (or 0,0 full-bleed in YouTube Fullscreen!)
                let app_for_resize = app.handle().clone();
                pill_win.on_window_event(move |event| {
                    if let WindowEvent::Resized(phys_size) = event {
                        sync_inbuilt_browser_bounds(&app_for_resize, *phys_size);
                    }
                });

                #[cfg(target_os = "windows")]
                {
                    if let Ok(hwnd) = pill_win.hwnd() {
                        let _ = native_window::apply_native_pill_chrome(hwnd, true);
                        // 2. Initialize Morpher AFTER window is centered so it captures the centered coordinates!
                        let morpher = native_window::WindowMorpher::new(hwnd);
                        let morph_state = app.state::<MorpherState>();
                        if let Ok(mut guard) = morph_state.0.lock() {
                            *guard = Some(morpher);
                        }
                        println!("[DWM] Native Pill Chrome and WindowMorpher attached to chat_pill!");
                    }
                }
            }

            if let Some(bubble_win) = app.get_webview_window("pip_bubble") {
                let _ = bubble_win.set_always_on_top(true);
                let _ = bubble_win.set_ignore_cursor_events(true);
                let _ = bubble_win.hide();
                #[cfg(target_os = "windows")]
                {
                    if let Ok(hwnd) = bubble_win.hwnd() {
                        native_window::make_noactivate_tool_window(hwnd);
                    }
                }
            }

            if let Some(hp_win) = app.get_webview_window("pip_headphones") {
                let _ = hp_win.set_always_on_top(true);
                let _ = hp_win.set_ignore_cursor_events(true);
                let _ = hp_win.hide();
                #[cfg(target_os = "windows")]
                {
                    if let Ok(hwnd) = hp_win.hwnd() {
                        native_window::make_noactivate_tool_window(hwnd);
                    }
                }
            }

            if let Some(drawer_win) = app.get_webview_window("search_drawer") {
                let _ = drawer_win.set_always_on_top(true);
                let _ = drawer_win.set_ignore_cursor_events(false);
                let _ = drawer_win.hide();
                #[cfg(target_os = "windows")]
                {
                    if let Ok(hwnd) = drawer_win.hwnd() {
                        native_window::make_noactivate_interactive_tool_window(hwnd);
                        let _ = native_window::apply_native_drawer_chrome(hwnd, true);
                    }
                }
            }

            // Native Left-Win solo-tap hook: Awake <-> Minimize AIDEN (preserves Win+* combos & Right Win)
            {
                let win_app_handle = app.handle().clone();
                let toggle_seq = Arc::new(AtomicU64::new(0));
                win_hotkey::start_hook(move || {
                    capture_previous_foreground(&win_app_handle);
                    let seq = toggle_seq.fetch_add(1, Ordering::Relaxed) + 1;
                    let _ = win_app_handle.emit_to(
                        "chat_pill",
                        "aiden-win-key-toggle",
                        serde_json::json!({ "seq": seq }),
                    );
                });
            }

            // Context menu with Open, quick engine controls (Boot up, Restart, Shutdown), and Exit
            let open_item = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let sep1 = PredefinedMenuItem::separator(app)?;
            let boot_item = MenuItem::with_id(app, "boot_up", "Boot up", true, None::<&str>)?;
            let restart_item = MenuItem::with_id(app, "restart", "Restart", true, None::<&str>)?;
            let shutdown_item = MenuItem::with_id(app, "shutdown", "Shutdown", true, None::<&str>)?;
            let sep2 = PredefinedMenuItem::separator(app)?;
            let exit_item = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(
                app,
                &[
                    &open_item,
                    &sep1,
                    &boot_item,
                    &restart_item,
                    &shutdown_item,
                    &sep2,
                    &exit_item,
                ],
            )?;

            let mut tray_builder = TrayIconBuilder::new()
                .tooltip("AIDEN")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_always_on_top(true);
                            let _ = window.set_focus();
                        }
                    }
                    "boot_up" => {
                        let app_handle = app.clone();
                        std::thread::spawn(move || {
                            let state = app_handle.state::<BackendState>();
                            match perform_boot_aiden(&state) {
                                Ok(res) => println!("[TRAY] Boot up: {}", res["status"]),
                                Err(e) => eprintln!("[TRAY] Boot up failed: {}", e),
                            }
                        });
                    }
                    "restart" => {
                        let app_handle = app.clone();
                        std::thread::spawn(move || {
                            let state = app_handle.state::<BackendState>();
                            match perform_restart_aiden(&app_handle, &state) {
                                Ok(res) => println!("[TRAY] Restart: {}", res["status"]),
                                Err(e) => eprintln!("[TRAY] Restart failed: {}", e),
                            }
                        });
                    }
                    "shutdown" => {
                        let app_handle = app.clone();
                        std::thread::spawn(move || {
                            let state = app_handle.state::<BackendState>();
                            let _ = perform_shutdown_aiden(&app_handle, &state);
                            println!("[TRAY] Shutdown completed.");
                        });
                    }
                    "exit" => {
                        win_hotkey::stop_hook();
                        close_inbuilt_browser_internal(app);
                        stop_pip_bop_immediately(app);
                        stop_pip_cursor_watcher(app);
                        hide_pip_bubble_immediately(app);
                        hide_search_drawer_immediately(app);
                        hide_pip_headphones_immediately(app);
                        let state = app.state::<BackendState>();
                        stop_all_aiden_processes(&state);
                        if let Some(drawer_win) = app.get_webview_window("search_drawer") {
                            let _ = drawer_win.destroy();
                        }
                        if let Some(hp_win) = app.get_webview_window("pip_headphones") {
                            let _ = hp_win.destroy();
                        }
                        if let Some(bubble_win) = app.get_webview_window("pip_bubble") {
                            let _ = bubble_win.destroy();
                        }
                        if let Some(pill_win) = app.get_webview_window("chat_pill") {
                            let _ = pill_win.destroy();
                        }
                        if let Some(main_win) = app.get_webview_window("main") {
                            let _ = main_win.destroy();
                        }
                        app.exit(0);
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    // Left click on tray restores/shows the app
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.unminimize();
                            let _ = window.set_always_on_top(true);
                            let _ = window.set_focus();
                        }
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray_builder = tray_builder.icon(icon.clone());
            }

            let _tray = tray_builder.build(app)?;

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            minimize_to_tray,
            show_main_window,
            save_openai_key,
            check_openai_key,
            save_gmail_credentials,
            get_gmail_status,
            get_calendar_status,
            start_calendar_oauth,
            save_calendar_client_credentials,
            disconnect_calendar,
            delete_calendar_client_credentials,
            get_spotify_status,
            start_spotify_oauth,
            save_spotify_client_credentials,
            disconnect_spotify,
            delete_spotify_client_credentials,
            get_user_preferences,
            save_user_preferences,
            get_user_memories,
            save_user_memories,
            set_chat_pill_state,
            morph_pill,
            set_pill_theme,
            hide_chat_pill,
            resize_chat_pill,
            set_chat_pill_size,
            animate_chat_pill_shape,
            minimize_to_pip,
            enter_asleep_square,
            maximize_from_pip,
            begin_pip_drag,
            step_pip_drag,
            end_pip_drag,
            get_pip_cursor_delta,
            set_pip_bubble,
            set_pip_headphones,
            set_pip_music_bop,
            set_win_key_override,
            get_win_key_override,
            search_unified,
            launch_search_item,
            sync_search_drawer,
            get_search_drawer_state,
            notify_search_drawer_hover,
            refresh_search_index,
            get_pip_power_status,
            get_pip_spotify_status,
            boot_aiden,
            shutdown_aiden,
            restart_aiden,
            get_aiden_status,
            get_windows_accent_color,
            read_dropped_images,
            open_inbuilt_browser,
            close_inbuilt_browser,
            browser_navigate_action,
            browser_scroll_action
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
