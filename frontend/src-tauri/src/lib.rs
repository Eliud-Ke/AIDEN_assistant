use std::io::Write;
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

#[cfg(target_os = "windows")]
mod composition;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Position, State,
};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

struct BackendState(Mutex<Option<Child>>);

#[cfg(target_os = "windows")]
struct CompositionState(std::sync::Mutex<Option<composition::CompositionHost>>);


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
                "Get-NetTCPConnection -LocalPort 8765 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }",
            ])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .creation_flags(CREATE_NO_WINDOW);
        let _ = ps_cmd.status();
    }
}

fn spawn_aiden_backend(state: &BackendState) -> Result<u32, String> {
    let mut cmd = build_backend_command("main.py")?;
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());

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

#[tauri::command]
fn boot_aiden(state: State<'_, BackendState>) -> Result<serde_json::Value, String> {
    // Check if tracked child is still alive
    let mut already_alive = false;
    if let Ok(mut guard) = state.0.lock() {
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => already_alive = true,
                _ => {
                    *guard = None;
                }
            }
        }
    }

    if already_alive || is_port_8765_active() {
        return Ok(serde_json::json!({
            "ok": true,
            "running": true,
            "status": "already_running",
            "message": "Aiden is already active in the background."
        }));
    }

    let pid = spawn_aiden_backend(&state)?;
    Ok(serde_json::json!({
        "ok": true,
        "running": true,
        "pid": pid,
        "status": "booted",
        "message": "Aiden booted in sleep mode."
    }))
}

#[tauri::command]
fn shutdown_aiden(
    app: AppHandle,
    state: State<'_, BackendState>,
) -> Result<serde_json::Value, String> {
    stop_all_aiden_processes(&state);

    if let Some(pill_win) = app.get_webview_window("chat_pill") {
        let _ = pill_win.set_ignore_cursor_events(true);
        let _ = pill_win.hide();
        let _ = pill_win.set_size(LogicalSize::new(640.0, 130.0));

        #[cfg(target_os = "windows")]
        {
            let comp_state = app.state::<CompositionState>();
            if let Ok(guard) = comp_state.0.lock() {
                if let Some(host) = guard.as_ref() {
                    let _ = host.set_visible(false);
                    let _ = host.update_shape(40.0, 18.0, 560.0, 60.0, 30.0);
                }
            }
        }
    }
    let _ = app.emit(
        "chat-pill-sync",
        serde_json::json!({
            "isAwake": false,
            "reply": serde_json::Value::Null,
        }),
    );

    Ok(serde_json::json!({
        "ok": true,
        "running": false,
        "status": "stopped",
        "message": "Aiden has been shut down completely."
    }))
}

#[tauri::command]
fn restart_aiden(
    app: AppHandle,
    state: State<'_, BackendState>,
) -> Result<serde_json::Value, String> {
    stop_all_aiden_processes(&state);

    if let Some(pill_win) = app.get_webview_window("chat_pill") {
        let _ = pill_win.set_ignore_cursor_events(true);
        let _ = pill_win.hide();
        let _ = pill_win.set_size(LogicalSize::new(640.0, 130.0));

        #[cfg(target_os = "windows")]
        {
            let comp_state = app.state::<CompositionState>();
            if let Ok(guard) = comp_state.0.lock() {
                if let Some(host) = guard.as_ref() {
                    let _ = host.set_visible(false);
                    let _ = host.update_shape(40.0, 18.0, 560.0, 60.0, 30.0);
                }
            }
        }
    }
    let _ = app.emit(
        "chat-pill-sync",
        serde_json::json!({
            "isAwake": false,
            "reply": serde_json::Value::Null,
        }),
    );

    std::thread::sleep(Duration::from_millis(400));

    let pid = spawn_aiden_backend(&state)?;
    Ok(serde_json::json!({
        "ok": true,
        "running": true,
        "pid": pid,
        "status": "restarted",
        "message": "Aiden restarted in sleep mode."
    }))
}

#[tauri::command]
fn get_aiden_status(state: State<'_, BackendState>) -> Result<serde_json::Value, String> {
    let mut tracked_alive = false;
    if let Ok(mut guard) = state.0.lock() {
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => tracked_alive = true,
                _ => {
                    *guard = None;
                }
            }
        }
    }

    let ws_online = is_port_8765_active();
    Ok(serde_json::json!({
        "running": tracked_alive || ws_online,
        "wsOnline": ws_online
    }))
}

#[tauri::command]
fn get_windows_accent_color() -> Result<String, String> {
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
}

#[tauri::command]
fn save_openai_key(api_key: String) -> Result<String, String> {
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
}

#[tauri::command]
fn check_openai_key() -> Result<bool, String> {
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
}

#[tauri::command]
fn save_gmail_credentials(email: String, app_password: String) -> Result<String, String> {
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
}

#[tauri::command]
fn get_gmail_status() -> Result<serde_json::Value, String> {
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
}

#[tauri::command]
fn get_user_preferences() -> Result<serde_json::Value, String> {
    let mut cmd = build_backend_command("configuration.py")?;
    cmd.arg("--get")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to read user preferences: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let parsed: serde_json::Value = serde_json::from_str(&stdout)
            .map_err(|e| format!("Failed to parse user preferences JSON: {}", e))?;
        Ok(parsed)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("Failed reading preferences: {}", stderr.trim()))
    }
}

#[tauri::command]
fn save_user_preferences(
    identity_vibe: Option<String>,
    extra_rules: Option<Vec<String>>,
) -> Result<serde_json::Value, String> {
    let mut payload = serde_json::Map::new();
    if let Some(vibe) = identity_vibe {
        payload.insert("identity_vibe".to_string(), serde_json::Value::String(vibe));
    }
    if let Some(rules) = extra_rules {
        let arr = rules
            .into_iter()
            .map(serde_json::Value::String)
            .collect::<Vec<_>>();
        payload.insert("extra_rules".to_string(), serde_json::Value::Array(arr));
    }
    let payload_str = serde_json::Value::Object(payload).to_string();

    let mut cmd = build_backend_command("configuration.py")?;
    cmd.arg("--save-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch configuration manager: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(payload_str.as_bytes())
            .map_err(|e| format!("Failed to pass preferences payload: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed waiting for configuration manager: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let parsed: serde_json::Value = serde_json::from_str(&stdout)
            .map_err(|e| format!("Failed to parse saved preferences JSON: {}", e))?;
        Ok(parsed)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("Failed saving preferences: {}", stderr.trim()))
    }
}

#[tauri::command]
fn get_user_memories() -> Result<serde_json::Value, String> {
    let mut cmd = build_backend_command("memory_manager.py")?;
    cmd.arg("--get")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let output = cmd
        .output()
        .map_err(|e| format!("Failed to read user memories: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let parsed: serde_json::Value = serde_json::from_str(&stdout)
            .map_err(|e| format!("Failed to parse user memories JSON: {}", e))?;
        Ok(parsed)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("Failed reading memories: {}", stderr.trim()))
    }
}

#[tauri::command]
fn save_user_memories(memories: serde_json::Value) -> Result<serde_json::Value, String> {
    let payload = serde_json::json!({ "memories": memories });
    let payload_str = payload.to_string();

    let mut cmd = build_backend_command("memory_manager.py")?;
    cmd.arg("--save-stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to launch memory manager: {}", e))?;

    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(payload_str.as_bytes())
            .map_err(|e| format!("Failed to pass memories payload: {}", e))?;
    }

    let output = child
        .wait_with_output()
        .map_err(|e| format!("Failed waiting for memory manager: {}", e))?;

    if output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let parsed: serde_json::Value = serde_json::from_str(&stdout)
            .map_err(|e| format!("Failed to parse saved memories JSON: {}", e))?;
        Ok(parsed)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).to_string();
        Err(format!("Failed saving memories: {}", stderr.trim()))
    }
}

#[tauri::command]
fn set_chat_pill_size(
    app: AppHandle,
    width: Option<f64>,
    height: f64,
    _pill_mode: Option<String>,
) -> Result<(), String> {
    if let Some(pill_win) = app.get_webview_window("chat_pill") {
        let w = width.unwrap_or(640.0);
        let h = height.max(80.0).min(960.0);
        let _ = pill_win.set_size(LogicalSize::new(w, h));

        #[cfg(target_os = "windows")]
        {
            let comp_state = app.state::<CompositionState>();
            if let Ok(guard) = comp_state.0.lock() {
                if let Some(host) = guard.as_ref() {
                    let _ = host.set_visible(true);
                    let card_h = (h - 70.0).max(60.0) as f32;
                    let radius = if card_h > 80.0 { 28.0 } else { 30.0 };
                    let _ = host.update_shape(40.0, 18.0, 560.0, card_h, radius);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn resize_chat_pill(app: AppHandle, expanded: bool) -> Result<(), String> {
    if let Some(pill_win) = app.get_webview_window("chat_pill") {
        let target_h = if expanded { 580.0 } else { 130.0 };
        let _ = pill_win.set_size(LogicalSize::new(640.0, target_h));
    }
    Ok(())
}

#[tauri::command]
fn hide_chat_pill(app: AppHandle) -> Result<(), String> {
    if let Some(pill_win) = app.get_webview_window("chat_pill") {
        let _ = pill_win.set_ignore_cursor_events(true);
        let _ = pill_win.hide();
        let _ = pill_win.set_size(LogicalSize::new(640.0, 130.0));

        #[cfg(target_os = "windows")]
        {
            let comp_state = app.state::<CompositionState>();
            if let Ok(guard) = comp_state.0.lock() {
                if let Some(host) = guard.as_ref() {
                    let _ = host.set_visible(false);
                    let _ = host.update_shape(40.0, 18.0, 560.0, 60.0, 30.0);
                }
            }
        }
    }
    Ok(())
}

#[tauri::command]
fn set_chat_pill_state(
    app: AppHandle,
    is_awake: Option<bool>,
    is_dark_mode: Option<bool>,
    reply: Option<String>,
    expanded: Option<bool>,
) -> Result<(), String> {
    if let Some(pill_win) = app.get_webview_window("chat_pill") {
        let _ = pill_win.set_always_on_top(true);
        if let Some(is_exp) = expanded {
            let target_h = if is_exp { 580.0 } else { 130.0 };
            let _ = pill_win.set_size(LogicalSize::new(640.0, target_h));

            #[cfg(target_os = "windows")]
            {
                let comp_state = app.state::<CompositionState>();
                if let Ok(guard) = comp_state.0.lock() {
                    if let Some(host) = guard.as_ref() {
                        let (w, h, r) = if is_exp {
                            (560.0, 510.0, 28.0)
                        } else {
                            (560.0, 60.0, 30.0)
                        };
                        let _ = host.update_shape(40.0, 18.0, w, h, r);
                    }
                }
            }
        }
        if let Some(awake) = is_awake {
            let _ = pill_win.set_ignore_cursor_events(!awake);
            if awake {
                #[cfg(target_os = "windows")]
                {
                    let comp_state = app.state::<CompositionState>();
                    if let Ok(guard) = comp_state.0.lock() {
                        if let Some(host) = guard.as_ref() {
                            let _ = host.set_visible(true);
                            if expanded != Some(true) {
                                let _ = host.update_shape(40.0, 18.0, 560.0, 60.0, 30.0);
                            }
                        }
                    }
                }

                let _ = pill_win.show();
                let _ = pill_win.unminimize();
                let _ = pill_win.set_always_on_top(true);
                let _ = pill_win.set_focus();
            } else {
                let _ = pill_win.set_ignore_cursor_events(true);

                #[cfg(target_os = "windows")]
                {
                    let comp_state = app.state::<CompositionState>();
                    if let Ok(guard) = comp_state.0.lock() {
                        if let Some(host) = guard.as_ref() {
                            // Immediately hide and reset the composition shape so no lingering blur box hangs in mid-air
                            let _ = host.set_visible(false);
                            let _ = host.update_shape(40.0, 18.0, 560.0, 60.0, 30.0);
                        }
                    }
                }
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(BackendState(Mutex::new(None)))
        .manage(CompositionState(std::sync::Mutex::new(None)))
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_always_on_top(true);
            }

            // Position the floating Siri-style AI Pill in the upper quadrant/third of the screen
            if let Some(pill_win) = app.get_webview_window("chat_pill") {
                let _ = pill_win.set_always_on_top(true);
                let _ = pill_win.set_ignore_cursor_events(true);
                let _ = pill_win.hide();

                #[cfg(target_os = "windows")]
                {
                    if let Ok(hwnd) = pill_win.hwnd() {
                        match composition::CompositionHost::attach(hwnd, 40.0, 18.0, 560.0, 60.0, 30.0) {
                            Ok(host) => {
                                let comp_state = app.state::<CompositionState>();
                                if let Ok(mut guard) = comp_state.0.lock() {
                                    *guard = Some(host);
                                }
                                println!("[DWM] Windows.UI.Composition HostBackdrop attached to chat_pill!");
                            }
                            Err(e) => {
                                eprintln!("[DWM] Failed attaching Windows.UI.Composition: {:?}", e);
                            }
                        }
                    }
                }

                if let Ok(Some(monitor)) = pill_win.primary_monitor() {
                    let screen_size = monitor.size();
                    let monitor_pos = monitor.position();
                    let scale = monitor.scale_factor();

                    let win_width = (640.0 * scale) as i32;
                    let x = monitor_pos.x + ((screen_size.width as i32 - win_width) / 2);
                    // Upper third / top quarter (~15% from top of monitor)
                    let y = monitor_pos.y + ((screen_size.height as f64 * 0.15) as i32);

                    let _ = pill_win.set_position(Position::Physical(PhysicalPosition { x, y }));
                }
            }

            // Context menu with "Open" and "Exit"
            let open_item = MenuItem::with_id(app, "open", "Open", true, None::<&str>)?;
            let exit_item = MenuItem::with_id(app, "exit", "Exit", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &exit_item])?;

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
                    "exit" => {
                        let state = app.state::<BackendState>();
                        stop_all_aiden_processes(&state);
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
            get_user_preferences,
            save_user_preferences,
            get_user_memories,
            save_user_memories,
            set_chat_pill_state,
            hide_chat_pill,
            resize_chat_pill,
            set_chat_pill_size,
            boot_aiden,
            shutdown_aiden,
            restart_aiden,
            get_aiden_status,
            get_windows_accent_color
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
