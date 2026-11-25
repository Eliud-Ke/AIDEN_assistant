"""
AIDEN ANTIGRAVITY WORK CONNECTOR TOOLS
Bridges AIDEN to the local Antigravity CLI agent (`agy.exe`) using:
  - Phase 1 (`agy_plan_task` / `agy_revise_plan`): Read-only planning mode returning
    a structured summary, steps, paths affected, and risk assessment before any edits.
  - Phase 2 (`agy_execute_task`): Resumes the planned conversation asynchronously in
    Full Turbo mode (`--mode auto --dangerously-skip-permissions`) with live
    `stream-json` progress broadcast to the Floating Work Glass / Worker Cube UI.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

DEFAULT_AGY_MODEL = "gemini-4-hydrogen-medium"
DEFAULT_AGY_PROJECT = "System"
CREATE_NO_WINDOW = 0x08000000 if os.name == "nt" else 0

COMPACT_PLAN_SCHEMA = json.dumps({
    "type": "object",
    "properties": {
        "summary": {
            "type": "string",
            "description": "1-2 sentence plain-English summary of how you will accomplish the task.",
        },
        "steps": {
            "type": "array",
            "items": {"type": "string"},
            "description": "3 to 5 short, concrete execution steps.",
        },
        "paths_affected": {
            "type": "array",
            "items": {"type": "string"},
            "description": "Key files, folders, or commands that will be created, modified, or executed.",
        },
        "serious_harm_or_risks": {
            "type": "string",
            "description": "Explicitly state any destructive, irreversible, or system-impacting risk, or 'None — safe operation' if harmless.",
        },
        "risk_level": {
            "type": "string",
            "enum": ["low", "medium", "high"],
        },
    },
    "required": [
        "summary",
        "steps",
        "paths_affected",
        "serious_harm_or_risks",
        "risk_level",
    ],
})

_JOBS: Dict[str, Dict[str, Any]] = {}
_PROCESSES: Dict[str, subprocess.Popen] = {}
_JOBS_LOCK = threading.Lock()
_JOB_COUNTER = 0

_ANSI_RE = re.compile(r"\x1B\[[0-?]*[ -/]*[@-~]")


def _broadcast(payload: Dict[str, Any]) -> None:
    """Thread-safe broadcast helper to WebSocket UI clients."""
    try:
        try:
            import server
        except ImportError:
            from backend import server  # type: ignore
        server.broadcast_event(payload)
    except Exception:
        pass


def _enqueue_completion_report(
    job_id: str,
    task: str,
    status: str,
    elapsed_sec: int,
    summary: str,
) -> None:
    """Queues an Antigravity completion report into the Turn-Barrier Mailbox."""
    try:
        try:
            import server
        except ImportError:
            from backend import server  # type: ignore
        server.remove_system_turns_for_job(job_id, kinds=("agy_dismissed",))
        report_prompt = (
            f"[ANTIGRAVITY TASK FINISHED - {job_id}]: "
            f"The background Antigravity task '{task}' just finished with status '{status}' "
            f"in {elapsed_sec}s. Give the user a crisp, warm, natural update summarizing what "
            f"was accomplished (or what went wrong if failed) based on this outcome: {summary}. "
            f"Do NOT call any tools unless the user asks for follow-up action."
        )
        server.enqueue_system_turn(
            kind="agy_done",
            prompt=report_prompt,
            job_id=job_id,
            require_maximized=True,
            ui_tag="Antigravity finished" if status == "completed" else "Antigravity stopped",
        )
    except Exception:
        pass


def _clear_mailbox_for_job(job_id: str, kinds: Optional[tuple] = None) -> None:
    """Removes any pending Turn-Barrier Mailbox entries for a job."""
    try:
        try:
            import server
        except ImportError:
            from backend import server  # type: ignore
        server.remove_system_turns_for_job(job_id, kinds=kinds)
    except Exception:
        pass


def _resolve_agy_bin() -> str:
    """Finds the local agy.exe CLI executable path."""
    for cmd_name in ("agy", "agy.exe"):
        found = shutil.which(cmd_name)
        if found:
            return found

    home_bin = Path.home() / ".gemini" / "bin" / "agy.exe"
    if home_bin.is_file():
        return str(home_bin)

    userprofile = os.environ.get("USERPROFILE", "").strip()
    if userprofile:
        prof_bin = Path(userprofile) / ".gemini" / "bin" / "agy.exe"
        if prof_bin.is_file():
            return str(prof_bin)

    return "agy"


def _resolve_working_dir(working_dir: str = "") -> str:
    """Resolves user shorthand folders or explicit paths into an existing directory."""
    raw = (working_dir or "").strip().strip('"').strip("'")
    if raw:
        lower = raw.lower()
        shorthand_map = {
            "desktop": Path.home() / "Desktop",
            "downloads": Path.home() / "Downloads",
            "documents": Path.home() / "Documents",
            "pictures": Path.home() / "Pictures",
            "videos": Path.home() / "Videos",
            "music": Path.home() / "Music",
            "home": Path.home(),
            "userprofile": Path.home(),
            "c:": Path("C:/"),
            "c:\\": Path("C:/"),
            "c drive": Path("C:/"),
        }
        if lower in shorthand_map and shorthand_map[lower].is_dir():
            return str(shorthand_map[lower].resolve())
        if lower in ("my projects", "projects") and Path("C:/My Projects").is_dir():
            return str(Path("C:/My Projects").resolve())

        expanded = os.path.expandvars(os.path.expanduser(raw))
        candidate = Path(expanded)
        if candidate.is_dir():
            return str(candidate.resolve())

    return str(Path.home().resolve())


def _extract_json_object(raw_text: str) -> Dict[str, Any]:
    """Parses JSON from CLI stdout, tolerating leading banners or ANSI sequences."""
    cleaned = _ANSI_RE.sub("", raw_text or "").strip()
    if not cleaned:
        return {}
    try:
        parsed = json.loads(cleaned)
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        pass

    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start != -1 and end > start:
        try:
            parsed = json.loads(cleaned[start : end + 1])
            return parsed if isinstance(parsed, dict) else {}
        except Exception:
            pass
    return {}


def _find_job_locked(job_id: str = "", statuses: Optional[tuple] = None) -> Optional[Dict[str, Any]]:
    """Must be called with _JOBS_LOCK held."""
    if job_id and job_id in _JOBS:
        return _JOBS[job_id]
    for jid in reversed(list(_JOBS.keys())):
        job = _JOBS[jid]
        if statuses is None or job.get("status") in statuses:
            return job
    return None


def _shorten_path_display(raw_path: str) -> str:
    """Formats a filesystem path or folder target cleanly for display in the Work Glass."""
    cleaned = (raw_path or "").strip().strip('"').strip("'").replace("\\", "/")
    if not cleaned:
        return ""
    while cleaned.endswith("/") and len(cleaned) > 3:
        cleaned = cleaned[:-1]
    parts = [p for p in cleaned.split("/") if p]
    if len(parts) >= 2:
        short = f"{parts[-2]}/{parts[-1]}"
    elif parts:
        short = parts[0]
    else:
        short = cleaned
    if len(short) > 34:
        return short[:31] + "..."
    return short


def _translate_stream_event_to_step(evt: Dict[str, Any]) -> Optional[str]:
    """Translates agy stream-json init/step_update events into real step-by-step CLI procedures."""
    evt_type = evt.get("event")
    if evt_type == "init":
        init_obj = evt.get("init") or {}
        cwd = str(init_obj.get("cwd") or "").strip() if isinstance(init_obj, dict) else ""
        short_cwd = _shorten_path_display(cwd)
        return f"Workspace: {short_cwd}" if short_cwd else "Session initialized"

    if evt_type != "step_update":
        return None

    su = evt.get("step_update") or {}
    if not isinstance(su, dict):
        return None

    step_type = str(su.get("step_type") or "").lower()
    state = str(su.get("state") or "").upper()
    tool_info = su.get("tool_info") or {}
    if not isinstance(tool_info, dict):
        tool_info = {}

    tool_name = str(su.get("tool_name") or tool_info.get("name") or "").lower().strip()
    params = tool_info.get("parameters") or {}
    if not isinstance(params, dict):
        params = {}

    if step_type == "tool":
        if state == "ERROR":
            clean_err = tool_name.replace("_", " ").strip() or "action"
            return f"Retry/skip: {clean_err}"
        if state != "ACTIVE":
            return None

        explicit_summary = str(
            params.get("toolSummary")
            or params.get("Description")
            or params.get("description")
            or params.get("TaskName")
            or ""
        ).strip()
        if explicit_summary:
            return explicit_summary

        if tool_name in ("run_command", "execute_command"):
            cmd_line = " ".join(str(params.get("CommandLine") or params.get("command") or "").split())
            return f"Run: {cmd_line}" if cmd_line else "Running command"

        if tool_name in ("view_file", "read_file", "view_file_outline", "view_code_item"):
            target = str(
                params.get("AbsolutePath")
                or params.get("Path")
                or params.get("path")
                or params.get("file_path")
                or params.get("File")
                or ""
            )
            short = _shorten_path_display(target)
            return f"Read: {short}" if short else "Reading file"

        if tool_name == "list_dir":
            target = str(params.get("DirectoryPath") or params.get("Path") or params.get("path") or "")
            short = _shorten_path_display(target)
            return f"List: {short}" if short else "Listing directory"

        if tool_name in ("find_by_name", "glob"):
            pat = str(params.get("Pattern") or params.get("pattern") or "*").strip()
            d = _shorten_path_display(str(params.get("SearchDirectory") or params.get("path") or ""))
            return f"Find {pat} in {d}" if d else f"Find: {pat}"

        if tool_name == "grep_search":
            q = str(params.get("Query") or params.get("query") or "").strip()
            return f"Search: {q}" if q else "Searching file contents"

        if tool_name in ("write_to_file", "write_file", "create_file"):
            target = str(params.get("TargetFile") or params.get("Path") or params.get("file_path") or "")
            short = _shorten_path_display(target)
            return f"Write: {short}" if short else "Writing file"

        if tool_name in ("replace_file_content", "multi_replace_file_content", "edit_file", "sed_file"):
            target = str(params.get("TargetFile") or params.get("Path") or params.get("file_path") or "")
            short = _shorten_path_display(target)
            return f"Edit: {short}" if short else "Editing file"

        if tool_name in ("search_web", "read_url_content", "open_browser_url"):
            target = str(params.get("query") or params.get("Url") or params.get("url") or "").strip()
            return f"Web: {target}" if target else "Searching web"

        if tool_name in ("invoke_subagent", "browser_subagent"):
            target = str(params.get("Role") or params.get("TaskName") or params.get("TypeName") or "").strip()
            return f"Agent: {target}" if target else "Running subagent"

        if tool_name:
            clean_tool = tool_name.replace("_", " ").strip()
            first_arg = ""
            for v in params.values():
                if isinstance(v, str) and v.strip():
                    first_arg = _shorten_path_display(v.strip())
                    break
            return f"{clean_tool}: {first_arg}" if first_arg else clean_tool

    if step_type in ("agent_response", "thinking", "thought") and state == "ACTIVE":
        return "Thinking & verifying"

    return None


def _append_job_step(job: Dict[str, Any], label: str, max_steps: int = 8) -> bool:
    """Appends a new active step if distinct from the tail step. Must hold _JOBS_LOCK."""
    clean = " ".join((label or "").strip().split())[:72]
    if not clean:
        return False

    steps: List[Dict[str, str]] = job.setdefault("steps", [])
    if steps and steps[-1].get("text") == clean and steps[-1].get("status") == "active":
        return False

    for item in steps:
        item["status"] = "done"

    steps.append({"text": clean, "status": "active"})
    if len(steps) > max_steps:
        del steps[:-max_steps]

    job["last_step_change_at"] = time.time()
    return True


def _format_plan_brief(job: Dict[str, Any]) -> str:
    """Formats a compact, low-token plan summary for AIDEN to present conversationally."""
    plan = job.get("plan") or {}
    summary = str(plan.get("summary") or "Plan prepared.").strip()
    steps = plan.get("steps") or []
    paths = plan.get("paths_affected") or []
    risks = str(plan.get("serious_harm_or_risks") or "None stated").strip()
    risk_level = str(plan.get("risk_level") or "low").strip().upper()

    steps_text = "\n".join(f"{idx + 1}. {s}" for idx, s in enumerate(steps[:6])) or "1. Execute requested task"
    paths_text = ", ".join(str(p) for p in paths[:6]) or job.get("working_dir", "")

    plan_card_tag = ""
    try:
        try:
            from tools_a2ui import build_antigravity_plan_a2ui_tag
        except ImportError:
            from backend.tools_a2ui import build_antigravity_plan_a2ui_tag  # type: ignore
        plan_card_tag = build_antigravity_plan_a2ui_tag(job)
    except Exception as exc:
        print(f"⚠️ [AGY PLAN A2UI] Failed to build plan card tag: {exc}")

    card_directive = (
        "\n[A2UI PLAN GATE CARD QUEUED AUTOMATICALLY]: The interactive Plan Gate glass card (with one-click "
        "Approve & Run / Revise / Cancel buttons) will mount automatically below your reply.\n"
        "[DIRECTIVE FOR AIDEN]: Summarize the plan and any serious risks in 1-2 crisp conversational sentences "
        "in your natural voice and ask for approval. Do NOT write any JSON or `::a2ui-card` tags and do NOT "
        "recite the full step list in prose (the card displays it). "
        "Do NOT call `agy_execute_task` until the user explicitly approves (via button or text). "
        "If they deny, call `agy_cancel_task`. If they request changes, call `agy_revise_plan`."
        if plan_card_tag
        else "\n[DIRECTIVE FOR AIDEN]: Explain this plan, key affected locations, and any serious risks/harm "
        "to the user in 2-4 concise conversational sentences and ask for their approval before executing. "
        "Do NOT call `agy_execute_task` until the user explicitly approves. "
        "If they deny, call `agy_cancel_task`. If they request modifications, call `agy_revise_plan`."
    )

    return (
        f"[ANTIGRAVITY PLAN READY - JOB {job['job_id']}]\n"
        f"MODEL: {job['model']} | PROJECT: {job['project']} | CWD: {job['working_dir']}\n"
        f"RISK_LEVEL: {risk_level}\n"
        f"SUMMARY: {summary}\n"
        f"STEPS:\n{steps_text}\n"
        f"PATHS_AFFECTED: {paths_text}\n"
        f"SERIOUS_HARM_OR_RISKS: {risks}\n"
        f"{card_directive}"
    )


def _run_plan_subprocess(
    prompt_text: str,
    cwd: str,
    project: str,
    conversation_id: str = "",
) -> Dict[str, Any]:
    """Executes agy.exe in non-interactive plan mode and returns parsed envelope."""
    agy_bin = _resolve_agy_bin()
    cmd = [agy_bin, "-p", prompt_text]
    if conversation_id:
        cmd.extend(["--conversation", conversation_id])
    else:
        cmd.extend(["--project", project or DEFAULT_AGY_PROJECT])

    cmd.extend([
        "--mode", "plan",
        "--model", DEFAULT_AGY_MODEL,
        "--output-format", "json",
        "--json-schema", COMPACT_PLAN_SCHEMA,
        "--dangerously-skip-permissions",
        "--print-timeout", "3m",
    ])

    proc = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=195,
        creationflags=CREATE_NO_WINDOW,
    )

    envelope = _extract_json_object(proc.stdout)
    if not envelope and proc.returncode != 0:
        err = (proc.stderr or proc.stdout or f"exit code {proc.returncode}").strip()
        raise RuntimeError(f"Antigravity CLI plan error: {err[:500]}")

    return envelope


def agy_plan_task(task: str, working_dir: str = "", project: str = DEFAULT_AGY_PROJECT) -> str:
    """
    Phase 1 (Plan Mode): Asks Antigravity CLI to inspect the task and produce a
    summarized execution plan + serious harm/risk assessment without modifying anything.
    """
    global _JOB_COUNTER

    clean_task = (task or "").strip()
    if not clean_task:
        return "Error: `task` cannot be empty when planning with Antigravity."

    cwd = _resolve_working_dir(working_dir)
    proj = (project or DEFAULT_AGY_PROJECT).strip() or DEFAULT_AGY_PROJECT

    plan_prompt = (
        f"TASK REQUEST FROM USER:\n{clean_task}\n\n"
        f"TARGET WORKING DIRECTORY: {cwd}\n"
        "Analyze this task in PLAN MODE only. Inspect what you need, but DO NOT create, edit, "
        "or delete files and DO NOT execute state-changing actions yet. "
        "Provide a compact, clear execution plan, the paths/resources affected, and any serious "
        "harm or irreversible risks that could occur."
    )

    try:
        envelope = _run_plan_subprocess(plan_prompt, cwd=cwd, project=proj)
    except FileNotFoundError:
        return "Error: `agy.exe` was not found on this PC. Ensure Antigravity CLI is installed at `~/.gemini/bin/agy.exe`."
    except subprocess.TimeoutExpired:
        return "Error: Antigravity planning timed out after 3 minutes. Ask the user if they want to narrow the scope and retry."
    except Exception as e:
        return f"Error planning task with Antigravity: {str(e)}"

    conversation_id = str(envelope.get("conversation_id") or "").strip()
    raw_resp = str(envelope.get("response") or "").strip()
    structured = envelope.get("structured_output")
    if not isinstance(structured, dict) or not structured.get("summary"):
        fallback_obj = _extract_json_object(raw_resp)
        if fallback_obj.get("summary"):
            structured = fallback_obj
        else:
            structured = {
                "summary": raw_resp[:400] if raw_resp else "Plan generated by Antigravity.",
                "steps": ["Inspect target scope", "Apply planned changes", "Verify results"],
                "paths_affected": [cwd],
                "serious_harm_or_risks": "Review before approving — structured risk block was unavailable.",
                "risk_level": "medium",
            }

    with _JOBS_LOCK:
        _JOB_COUNTER += 1
        job_id = f"agy-{_JOB_COUNTER}"
        job = {
            "job_id": job_id,
            "conversation_id": conversation_id,
            "task": clean_task,
            "working_dir": cwd,
            "project": proj,
            "model": DEFAULT_AGY_MODEL,
            "status": "awaiting_approval",
            "plan": structured,
            "steps": [],
            "started_at": None,
            "finished_at": None,
            "elapsed_sec": 0,
            "last_step_change_at": time.time(),
            "flavor_idx": 0,
            "final_summary": "",
            "error": "",
            "merged_reported": False,
            "card_dismissed": False,
        }
        _JOBS[job_id] = job

    return _format_plan_brief(job)


def agy_revise_plan(feedback: str, job_id: str = "") -> str:
    """
    Revises a pending Antigravity plan using user feedback before execution.
    """
    clean_feedback = (feedback or "").strip()
    if not clean_feedback:
        return "Error: `feedback` cannot be empty when revising an Antigravity plan."

    with _JOBS_LOCK:
        job = _find_job_locked(job_id, statuses=("awaiting_approval",))
        if not job:
            return "No pending Antigravity plan awaiting approval was found to revise."
        snapshot = dict(job)

    revise_prompt = (
        f"USER FEEDBACK ON YOUR PROPOSED PLAN:\n{clean_feedback}\n\n"
        "Revise the plan in PLAN MODE only without making changes yet, and return the updated compact plan JSON."
    )

    try:
        envelope = _run_plan_subprocess(
            revise_prompt,
            cwd=snapshot["working_dir"],
            project=snapshot["project"],
            conversation_id=snapshot.get("conversation_id", ""),
        )
    except Exception as e:
        return f"Error revising Antigravity plan: {str(e)}"

    raw_resp = str(envelope.get("response") or "").strip()
    structured = envelope.get("structured_output")
    if not isinstance(structured, dict) or not structured.get("summary"):
        fallback_obj = _extract_json_object(raw_resp)
        if fallback_obj.get("summary"):
            structured = fallback_obj
        else:
            structured = {
                "summary": raw_resp[:400] if raw_resp else snapshot["plan"].get("summary", "Plan revised."),
                "steps": snapshot["plan"].get("steps", []),
                "paths_affected": snapshot["plan"].get("paths_affected", [snapshot["working_dir"]]),
                "serious_harm_or_risks": snapshot["plan"].get("serious_harm_or_risks", "Review updated scope."),
                "risk_level": snapshot["plan"].get("risk_level", "medium"),
            }

    with _JOBS_LOCK:
        target = _JOBS.get(snapshot["job_id"])
        if not target:
            return "Job no longer exists."
        if envelope.get("conversation_id"):
            target["conversation_id"] = str(envelope["conversation_id"]).strip()
        target["plan"] = structured
        brief = _format_plan_brief(target)

    return brief


def _run_agy_turbo_worker(job_id: str) -> None:
    """Background daemon thread driving agy.exe stream-json execution and UI telemetry."""
    with _JOBS_LOCK:
        job = _JOBS.get(job_id)
        if not job:
            return
        conv_id = job.get("conversation_id", "")
        cwd = job["working_dir"]
        project = job["project"]
        task = job["task"]
        plan_summary = str((job.get("plan") or {}).get("summary") or "")

    agy_bin = _resolve_agy_bin()
    if conv_id:
        exec_prompt = (
            "The user explicitly approved your plan. Execute the approved plan now in Full Turbo mode. "
            "Verify your work and conclude with a concise summary of what was completed and any files created or modified."
        )
        cmd = [agy_bin, "-p", exec_prompt, "--conversation", conv_id]
    else:
        exec_prompt = (
            f"TASK:\n{task}\n\nAPPROVED PLAN:\n{plan_summary}\n\n"
            "Execute this approved plan now in Full Turbo mode inside the working directory and conclude "
            "with a concise summary of what was accomplished."
        )
        cmd = [agy_bin, "-p", exec_prompt, "--project", project]

    cmd.extend([
        "--mode", "auto",
        "--model", DEFAULT_AGY_MODEL,
        "--output-format", "stream-json",
        "--dangerously-skip-permissions",
        "--print-timeout", "15m",
    ])

    result_text = ""
    err_text = ""
    proc: Optional[subprocess.Popen] = None

    try:
        proc = subprocess.Popen(
            cmd,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            creationflags=CREATE_NO_WINDOW,
        )
        with _JOBS_LOCK:
            _PROCESSES[job_id] = proc
    except Exception as exc:
        fail_payload: Optional[Dict[str, Any]] = None
        fail_task = task
        fail_elapsed = 0
        fail_summary = f"Failed to launch Antigravity worker: {exc}"
        with _JOBS_LOCK:
            j = _JOBS.get(job_id)
            if j:
                j["status"] = "failed"
                j["finished_at"] = time.time()
                j["elapsed_sec"] = int(j["finished_at"] - (j["started_at"] or j["finished_at"]))
                j["error"] = str(exc)
                j["final_summary"] = fail_summary
                _append_job_step(j, "launch failed")
                j["steps"][-1]["status"] = "done"
                fail_task = j["task"]
                fail_elapsed = j["elapsed_sec"]
                fail_payload = {
                    "type": "agy_work_done",
                    "job_id": job_id,
                    "status": "failed",
                    "steps": list(j["steps"]),
                    "elapsed_sec": j["elapsed_sec"],
                    "summary": j["final_summary"],
                    "card_dismissed": bool(j.get("card_dismissed", False)),
                }
        if fail_payload:
            _broadcast(fail_payload)
            _enqueue_completion_report(job_id, fail_task, "failed", fail_elapsed, fail_summary)
        return

    stop_ticker = threading.Event()

    def _ticker() -> None:
        while not stop_ticker.is_set():
            time.sleep(1.0)
            if stop_ticker.is_set():
                break
            with _JOBS_LOCK:
                j = _JOBS.get(job_id)
                if not j or j.get("status") != "running":
                    break
                now = time.time()
                elapsed = max(0, int(now - (j["started_at"] or now)))
                j["elapsed_sec"] = elapsed

                payload = {
                    "type": "agy_work_step",
                    "job_id": job_id,
                    "steps": list(j["steps"]),
                    "elapsed_sec": elapsed,
                }
            _broadcast(payload)

    ticker_thread = threading.Thread(target=_ticker, daemon=True)
    ticker_thread.start()

    final_status_from_stream = ""
    try:
        if proc.stdout is not None:
            for raw_line in proc.stdout:
                line = raw_line.strip()
                if not line:
                    continue
                try:
                    evt = json.loads(line)
                except Exception:
                    continue
                if not isinstance(evt, dict):
                    continue

                evt_type = evt.get("event")
                if evt_type == "init":
                    new_conv = str(evt.get("conversation_id") or "").strip()
                    init_label = _translate_stream_event_to_step(evt)
                    init_payload: Optional[Dict[str, Any]] = None
                    with _JOBS_LOCK:
                        j = _JOBS.get(job_id)
                        if j:
                            if new_conv:
                                j["conversation_id"] = new_conv
                            if init_label and _append_job_step(j, init_label):
                                now = time.time()
                                j["elapsed_sec"] = max(0, int(now - (j["started_at"] or now)))
                                init_payload = {
                                    "type": "agy_work_step",
                                    "job_id": job_id,
                                    "steps": list(j["steps"]),
                                    "elapsed_sec": j["elapsed_sec"],
                                }
                    if init_payload:
                        _broadcast(init_payload)
                elif evt_type == "step_update":
                    step_label = _translate_stream_event_to_step(evt)
                    if step_label:
                        with _JOBS_LOCK:
                            j = _JOBS.get(job_id)
                            if not j or j.get("status") != "running":
                                continue
                            changed = _append_job_step(j, step_label)
                            now = time.time()
                            j["elapsed_sec"] = max(0, int(now - (j["started_at"] or now)))
                            payload = (
                                {
                                    "type": "agy_work_step",
                                    "job_id": job_id,
                                    "steps": list(j["steps"]),
                                    "elapsed_sec": j["elapsed_sec"],
                                }
                                if changed
                                else None
                            )
                        if payload:
                            _broadcast(payload)
                elif evt_type == "result":
                    res_obj = evt.get("result") or {}
                    if isinstance(res_obj, dict):
                        final_status_from_stream = str(res_obj.get("status") or "").upper()
                        result_text = str(res_obj.get("response") or "").strip()
                        err_text = str(res_obj.get("error") or "").strip()

        proc.wait()
        stderr_tail = ""
        if proc.stderr is not None:
            stderr_tail = proc.stderr.read().strip()
        if not err_text and stderr_tail:
            err_text = stderr_tail
    except Exception as exc:
        err_text = str(exc)
    finally:
        stop_ticker.set()
        with _JOBS_LOCK:
            _PROCESSES.pop(job_id, None)

    with _JOBS_LOCK:
        j = _JOBS.get(job_id)
        if not j:
            return
        if j.get("status") == "canceled":
            return

        now = time.time()
        j["finished_at"] = now
        j["elapsed_sec"] = max(0, int(now - (j["started_at"] or now)))

        failed = (
            final_status_from_stream in ("ERROR", "FAILED")
            or (proc is not None and proc.returncode != 0 and not result_text)
        )
        if failed:
            j["status"] = "failed"
            j["error"] = err_text[:500]
            j["final_summary"] = err_text[:500] if err_text else f"Antigravity exited with code {proc.returncode if proc else -1}."
            _append_job_step(j, "Stopped with error")
        else:
            j["status"] = "completed"
            compact_summary = " ".join((result_text or "Completed all planned steps successfully.").split())
            if len(compact_summary) > 700:
                compact_summary = compact_summary[:697] + "..."
            j["final_summary"] = compact_summary
            _append_job_step(j, "Completed")

        for item in j.get("steps", []):
            item["status"] = "done"

        done_payload = {
            "type": "agy_work_done",
            "job_id": job_id,
            "status": j["status"],
            "steps": list(j["steps"]),
            "elapsed_sec": j["elapsed_sec"],
            "summary": j["final_summary"],
            "card_dismissed": bool(j.get("card_dismissed", False)),
        }
        final_task = j["task"]
        final_status = j["status"]
        final_elapsed = j["elapsed_sec"]
        final_summary = j["final_summary"]

    _broadcast(done_payload)
    _enqueue_completion_report(job_id, final_task, final_status, final_elapsed, final_summary)


def agy_execute_task(job_id: str = "") -> str:
    """
    Phase 2 (Full Turbo Execution): Launches the approved Antigravity job asynchronously
    in the background and detaches the Floating Work Glass UI window. Returns immediately (<50ms).
    """
    with _JOBS_LOCK:
        job = _find_job_locked(job_id, statuses=("awaiting_approval",))
        if not job:
            return (
                "No planned Antigravity job awaiting approval was found. "
                "Call `agy_plan_task` first to generate a plan and get user approval."
            )

        jid = job["job_id"]
        job["status"] = "running"
        job["started_at"] = time.time()
        job["elapsed_sec"] = 0
        job["card_dismissed"] = False
        job["last_step_change_at"] = job["started_at"]
        short_dir = _shorten_path_display(job["working_dir"]) or "workspace"
        job["steps"] = [{"text": f"Starting in {short_dir}", "status": "active"}]
        start_payload = {
            "type": "agy_work_start",
            "job_id": jid,
            "task": job["task"],
            "working_dir": job["working_dir"],
            "steps": list(job["steps"]),
            "elapsed_sec": 0,
            "card_dismissed": False,
        }
        cwd = job["working_dir"]

    _broadcast(start_payload)

    worker = threading.Thread(
        target=_run_agy_turbo_worker,
        args=(jid,),
        name=f"agy-worker-{jid}",
        daemon=True,
    )
    worker.start()

    return (
        f"[ANTIGRAVITY TURBO WORKER LAUNCHED: {jid}]\n"
        f"Running asynchronously in `{cwd}` with model `{DEFAULT_AGY_MODEL}`.\n"
        "The live inline Antigravity card is now visible in chat (the user can also hover-minimize it "
        "to continue chatting freely while it runs). Let the user know briefly in 1 crisp sentence that "
        "Antigravity is on it in the background."
    )


def agy_check_status(job_id: str = "") -> str:
    """
    Checks live progress or final outcome of an active or recently completed Antigravity job.
    """
    clear_done_jid: Optional[str] = None

    with _JOBS_LOCK:
        job = _find_job_locked(job_id)
        if not job:
            return "No active or recent Antigravity background jobs in this session."

        jid = job["job_id"]
        status = job["status"]
        if status == "running" and job.get("started_at"):
            elapsed = max(0, int(time.time() - job["started_at"]))
        else:
            elapsed = int(job.get("elapsed_sec") or 0)

        steps = [s.get("text", "") for s in job.get("steps", [])]
        steps_str = " -> ".join(s for s in steps if s) or "initializing"
        summary = job.get("final_summary", "")

        if status in ("completed", "failed") and not job.get("merged_reported"):
            job["merged_reported"] = True
            clear_done_jid = jid

        task_desc = job.get("task", "")

    if clear_done_jid:
        _clear_mailbox_for_job(clear_done_jid, kinds=("agy_done",))

    if status in ("completed", "failed"):
        return (
            f"[ANTIGRAVITY JOB {jid} — {status.upper()} in {elapsed}s]\n"
            f"TASK: {task_desc}\n"
            f"SUMMARY: {summary}"
        )

    return (
        f"[ANTIGRAVITY JOB {jid} — {status.upper()} ({elapsed}s elapsed)]\n"
        f"TASK: {task_desc}\n"
        f"RECENT_STEPS: {steps_str}"
    )


def agy_cancel_task(job_id: str = "") -> str:
    """Cancels a pending plan or forcefully terminates a running Antigravity background worker tree."""
    proc_to_kill: Optional[subprocess.Popen] = None
    jid = ""
    with _JOBS_LOCK:
        job = _find_job_locked(job_id, statuses=("awaiting_approval", "running"))
        if not job:
            fallback = _find_job_locked(job_id)
            if fallback:
                jid = fallback["job_id"]
                _broadcast({"type": "agy_work_hide", "job_id": jid, "reason": "canceled"})
                return f"Cleared Antigravity task card for job {jid} (no active process was still running)."
            _broadcast({"type": "agy_work_hide", "job_id": "", "reason": "canceled"})
            return "No active Antigravity background job was running."

        jid = job["job_id"]
        job["status"] = "canceled"
        job["finished_at"] = time.time()
        job["merged_reported"] = True
        proc_to_kill = _PROCESSES.pop(jid, None)

    _clear_mailbox_for_job(jid)

    if proc_to_kill is not None:
        if os.name == "nt":
            try:
                subprocess.run(
                    ["taskkill", "/F", "/T", "/PID", str(proc_to_kill.pid)],
                    capture_output=True,
                    creationflags=CREATE_NO_WINDOW,
                    timeout=4,
                )
            except Exception:
                pass
        try:
            proc_to_kill.kill()
        except Exception:
            pass
        for stream in (proc_to_kill.stdout, proc_to_kill.stderr):
            if stream is not None:
                try:
                    stream.close()
                except Exception:
                    pass

    _broadcast({"type": "agy_work_hide", "job_id": jid, "reason": "canceled"})
    return f"Stopped and canceled Antigravity job {jid}. The background worker process tree has been terminated."


def has_active_or_unreported_job() -> bool:
    """Returns True if any Antigravity job is pending, running, or finished-but-unreported."""
    with _JOBS_LOCK:
        for job in _JOBS.values():
            status = job.get("status")
            if status in ("awaiting_approval", "running"):
                return True
            if status in ("completed", "failed") and not job.get("merged_reported"):
                return True
    return False


def mark_job_dismissed(job_id: str = "") -> Optional[Dict[str, Any]]:
    """Marks a running job's inline card as minimized/dismissed by the user."""
    with _JOBS_LOCK:
        job = _find_job_locked(job_id, statuses=("running",))
        if not job or job.get("card_dismissed"):
            return None
        job["card_dismissed"] = True
        elapsed = max(0, int(time.time() - (job.get("started_at") or time.time())))
        return {
            "job_id": job["job_id"],
            "task": job["task"],
            "elapsed_sec": elapsed,
        }


def mark_job_reported(job_id: str = "") -> None:
    """Marks a finished job as reported once the Turn-Barrier Mailbox claims it."""
    with _JOBS_LOCK:
        job = _find_job_locked(job_id, statuses=("completed", "failed"))
        if job:
            job["merged_reported"] = True


def get_ans_work_jobs_line() -> str:
    """Returns a compact 1-line summary of running or unmerged completed jobs for ANS injection."""
    with _JOBS_LOCK:
        now = time.time()
        items = []
        for jid in reversed(list(_JOBS.keys())):
            job = _JOBS[jid]
            status = job.get("status")
            if status == "running":
                elapsed = max(0, int(now - (job.get("started_at") or now)))
                tail = (job.get("steps") or [{}])[-1].get("text", "working")
                bg_tag = " [card minimized]" if job.get("card_dismissed") else ""
                items.append(f"{jid} [RUNNING {elapsed}s: '{tail}'{bg_tag}]")
            elif status in ("completed", "failed") and not job.get("merged_reported"):
                elapsed = int(job.get("elapsed_sec") or 0)
                items.append(f"{jid} [{status.upper()} in {elapsed}s — ready to report]")
            if len(items) >= 3:
                break
        return " | ".join(items)


def get_active_work_ui_snapshot() -> Optional[Dict[str, Any]]:
    """Returns current work UI state for newly connected WebSocket clients."""
    with _JOBS_LOCK:
        for jid in reversed(list(_JOBS.keys())):
            job = _JOBS[jid]
            status = job.get("status")
            if status == "running":
                elapsed = max(0, int(time.time() - (job.get("started_at") or time.time())))
                return {
                    "type": "agy_work_start",
                    "job_id": jid,
                    "task": job["task"],
                    "working_dir": job["working_dir"],
                    "steps": list(job.get("steps") or []),
                    "elapsed_sec": elapsed,
                    "card_dismissed": bool(job.get("card_dismissed", False)),
                }
            if status in ("completed", "failed") and not job.get("merged_reported"):
                return {
                    "type": "agy_work_done",
                    "job_id": jid,
                    "status": status,
                    "steps": list(job.get("steps") or []),
                    "elapsed_sec": int(job.get("elapsed_sec") or 0),
                    "summary": job.get("final_summary", ""),
                    "card_dismissed": bool(job.get("card_dismissed", False)),
                }
    return None


def pop_completed_job_for_report(job_id: str = "") -> Optional[Dict[str, Any]]:
    """Marks a completed job as reported upon merge-back and returns its details."""
    with _JOBS_LOCK:
        job = _find_job_locked(job_id, statuses=("completed", "failed"))
        if not job:
            return None
        if job.get("merged_reported"):
            return None
        job["merged_reported"] = True
        return {
            "job_id": job["job_id"],
            "task": job["task"],
            "status": job["status"],
            "elapsed_sec": int(job.get("elapsed_sec") or 0),
            "final_summary": job.get("final_summary") or "Completed.",
            "working_dir": job.get("working_dir", ""),
        }


ANTIGRAVITY_TOOLS = {
    "agy_plan_task": agy_plan_task,
    "agy_revise_plan": agy_revise_plan,
    "agy_execute_task": agy_execute_task,
    "agy_check_status": agy_check_status,
    "agy_cancel_task": agy_cancel_task,
}

ANTIGRAVITY_TOOLS_SCHEMA = [
    {
        "type": "function",
        "function": {
            "name": "agy_plan_task",
            "description": (
                "Submits a multi-step PC, coding, or file automation task to the Antigravity CLI "
                "agent (`agy.exe`) in read-only PLAN mode first. Returns a concise plan, affected paths, "
                "and any serious harm or risks so you can confirm with the user before executing."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "task": {
                        "type": "string",
                        "description": "Clear, complete description of what the user wants Antigravity to accomplish.",
                    },
                    "working_dir": {
                        "type": "string",
                        "description": "Target folder path or shorthand like 'Desktop', 'Downloads', 'C:/My Projects'. Defaults to the user's home folder if omitted.",
                    },
                    "project": {
                        "type": "string",
                        "description": "Antigravity project context name. Defaults to 'System'.",
                    },
                },
                "required": ["task"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "agy_revise_plan",
            "description": "Revises a pending Antigravity execution plan in PLAN mode based on the user's feedback before approval.",
            "parameters": {
                "type": "object",
                "properties": {
                    "feedback": {
                        "type": "string",
                        "description": "User's requested adjustments or constraints for the plan.",
                    },
                    "job_id": {
                        "type": "string",
                        "description": "Optional job ID (defaults to the most recent pending plan).",
                    },
                },
                "required": ["feedback"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "agy_execute_task",
            "description": (
                "Executes an already-planned Antigravity job asynchronously in Full Turbo mode ONLY AFTER "
                "the user has explicitly approved the plan. Streams live progress into the inline Antigravity chat card and returns immediately."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "job_id": {
                        "type": "string",
                        "description": "Optional job ID from agy_plan_task (defaults to the most recent pending plan).",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "agy_check_status",
            "description": "Instantly checks live progress, recent steps, or completion summary for an active or completed Antigravity background job.",
            "parameters": {
                "type": "object",
                "properties": {
                    "job_id": {
                        "type": "string",
                        "description": "Optional job ID (defaults to the latest job).",
                    },
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "agy_cancel_task",
            "description": "Cancels a pending Antigravity plan when the user denies approval, or terminates a running background worker.",
            "parameters": {
                "type": "object",
                "properties": {
                    "job_id": {
                        "type": "string",
                        "description": "Optional job ID (defaults to the latest pending or running job).",
                    },
                },
                "required": [],
            },
        },
    },
]
