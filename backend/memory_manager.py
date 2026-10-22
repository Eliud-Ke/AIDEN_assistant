import sys
import json
import os
import threading
import datetime

# Ensure Windows stdout/stderr handles UTF-8 cleanly without charmap errors
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

from auth_manager import get_api_key
from openai import OpenAI
from configuration import USER_DATA_DIR

# ⚡ ROUTED TO SECURE OS PERSISTENT STORAGE
MEMORY_FILE = USER_DATA_DIR / "memory.json"
EPISODIC_FILE = USER_DATA_DIR / "episodic_ledger.json"

memory_lock = threading.Lock()
episodic_lock = threading.Lock()


def init_memory():
    """Ensures the memory files exist with the correct schemas. Safely backs up corrupted files."""
    # 1. Init Semantic Memory (Dictionary)
    with memory_lock:
        if not os.path.exists(MEMORY_FILE):
            with open(MEMORY_FILE, 'w', encoding='utf-8') as f:
                json.dump({"general": []}, f, indent=4)
        else:
            try:
                with open(MEMORY_FILE, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    if not isinstance(data, dict):
                        raise ValueError("Memory file is not a dictionary.")
            except (json.JSONDecodeError, ValueError) as e:
                backup_name = str(MEMORY_FILE).replace(
                    ".json", f"_corrupted_{int(datetime.datetime.now().timestamp())}.json")
                os.rename(MEMORY_FILE, backup_name)
                print(
                    f"\n🚨 [CRITICAL MEMORY ERROR] {MEMORY_FILE} was corrupted and backed up to {backup_name}!\nError: {e}\n")
                with open(MEMORY_FILE, 'w', encoding='utf-8') as f:
                    json.dump({"general": []}, f, indent=4)

    # 2. Init Episodic Ledger (Array)
    with episodic_lock:
        if not os.path.exists(EPISODIC_FILE):
            with open(EPISODIC_FILE, 'w', encoding='utf-8') as f:
                json.dump([], f, indent=4)
        else:
            try:
                with open(EPISODIC_FILE, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                    if not isinstance(data, list):
                        raise ValueError("Episodic file is not a list.")
            except (json.JSONDecodeError, ValueError) as e:
                backup_name = str(EPISODIC_FILE).replace(
                    ".json", f"_corrupted_{int(datetime.datetime.now().timestamp())}.json")
                os.rename(EPISODIC_FILE, backup_name)
                print(
                    f"\n🚨 [CRITICAL MEMORY ERROR] {EPISODIC_FILE} was corrupted and backed up to {backup_name}!\nError: {e}\n")
                with open(EPISODIC_FILE, 'w', encoding='utf-8') as f:
                    json.dump([], f, indent=4)


def get_memory_context():
    """Reads the long-term semantic memory and formats it for the Brain's prompt."""
    init_memory()
    try:
        with memory_lock:
            with open(MEMORY_FILE, 'r', encoding='utf-8') as f:
                memories = json.load(f)

        if not memories:
            return "No long-term memories established yet."

        context_str = "LONG-TERM USER MEMORIES:\n"
        for category, facts in memories.items():
            if facts:
                context_str += f"\n[{category.upper()}]\n"
                for fact in facts:
                    context_str += f"- {fact}\n"
        return context_str
    except Exception as e:
        return f"Error loading memories: {e}"


def get_recent_episodes(limit=10):
    """LEVEL 0 MEMORY: Injects L1 (Last 5 Messages) and L2 (Next 15 Summaries) into the prompt."""
    init_memory()
    try:
        with episodic_lock:
            with open(EPISODIC_FILE, 'r', encoding='utf-8') as f:
                ledger = json.load(f)

        if not ledger:
            return ""

        recent_l1_episodes = ledger[:5]
        recent_l2 = ledger[5:limit]

        context_str = "\n[LEVEL 0 MEMORY: YOUR CONTINUOUS CONVERSATION CACHE]\n"

        if recent_l1_episodes:
            flattened_turns = []
            for ep in reversed(recent_l1_episodes):
                flattened_turns.extend(ep.get("actual_context", []))

            last_5_messages = flattened_turns[-5:]

            if last_5_messages:
                context_str += "--- L1 CACHE: EXACT TRANSCRIPT (LAST 5 MESSAGES) ---\n"
                for turn in last_5_messages:
                    context_str += f"USER: {turn.get('user', '')}\n"
                    context_str += f"AIDEN: {turn.get('aiden', '')}\n\n"

        if recent_l2:
            context_str += "--- L2 CACHE: SUMMARIES ONLY (PREVIOUS SESSIONS) ---\n"
            for i, ep in enumerate(recent_l2):
                context_str += f"{i+6}. DATE: {ep.get('date', 'Unknown')} | TOPIC: {ep.get('main_agenda', 'Unknown')}\n"
                context_str += f"   SUMMARY: {ep.get('details', '')}\n\n"

        return context_str + "\n"
    except Exception as e:
        print(f"⚠️ [SYSTEM] Failed to load recent episodes: {e}")
        return ""


def _consolidate_task(chat_history):
    """The ultra-safe Append-Only background task for Dual-Memory extraction."""
    if not chat_history:
        return

    try:
        print("📚 [LIBRARIAN] Background memory extraction started...")
        existing_keys = []
        try:
            with memory_lock:
                with open(MEMORY_FILE, 'r', encoding='utf-8') as f:
                    mem_data = json.load(f)
                    existing_keys = list(mem_data.keys())
        except Exception:
            pass

        keys_string = ", ".join(
            existing_keys) if existing_keys else "general, personal, preferences"

        # ⚡ Authentic API Key fetch
        openai_client = OpenAI(api_key=get_api_key())

        chat_transcript = ""
        for entry in chat_history:
            if not entry['user'].startswith("[SYSTEM EVENT"):
                chat_transcript += f"User: {entry['user']}\nAIDEN: {entry['aiden']}\n\n"

        if not chat_transcript.strip():
            print("📚 [LIBRARIAN] No meaningful dialogue to extract.")
            return

        system_prompt = f"""You are the Memory Archivist for an AI named A.I.D.E.N. 
        You have TWO parallel jobs based on the latest chat transcript:
        
        1. Extract BRAND NEW, permanent facts about the user (preferences, hardware, family, habits).
        2. Create a brief, 2-sentence summary of the entire session to serve as an episodic memory.
        
        RULES:
        - Keep facts concise and factual.
        - CATEGORIZATION: The existing database categories are: [{keys_string}]. 
          You MUST try to map new facts into these existing categories if they fit conceptually. 
          ONLY create a new simple, one-word lowercase category if the fact completely falls outside the existing ones.
        - The session summary MUST capture the actual work or topic discussed.
        
        You MUST return STRICTLY a JSON object in this exact format:
        {{
            "new_facts": [
                {{"category": "dreams", "fact": "Wishes to work at Microsoft."}}
            ],
            "session_summary": {{
                "main_agenda": "A short, 4-6 word title",
                "details": "A 2-sentence summary of the conversation.",
                "key_tools_used": ["search_youtube", "launch_app"]
            }}
        }}
        If there are NO new permanent facts to extract, return an empty array for "new_facts". 
        Always provide a "session_summary" if the user actually requested something."""

        # ⚡ Upgraded to GPT-6-Luna and removed the temperature parameter
        response = openai_client.chat.completions.create(
            model="gpt-6-luna",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": chat_transcript}
            ]
        )

        result_str = response.choices[0].message.content
        result = json.loads(result_str)

        new_facts = result.get("new_facts", [])
        session_summary = result.get("session_summary", {})

        # TASK A: Semantic Fact Appending
        if new_facts:
            with memory_lock:
                with open(MEMORY_FILE, 'r', encoding='utf-8') as f:
                    existing_memories = json.load(f)

                added_count = 0
                for item in new_facts:
                    cat = item.get("category", "general").lower()
                    fact = item.get("fact", "").strip()

                    if fact:
                        if cat not in existing_memories:
                            existing_memories[cat] = []
                        if fact not in existing_memories[cat]:
                            existing_memories[cat].append(fact)
                            added_count += 1

                if added_count > 0:
                    with open(MEMORY_FILE, 'w', encoding='utf-8') as f:
                        json.dump(existing_memories, f, indent=4)
                    print(
                        f"📚 [LIBRARIAN] Successfully appended {added_count} new memory entries.")
                else:
                    print(
                        "📚 [LIBRARIAN] Extracted facts were already known. No updates needed.")
        else:
            print("📚 [LIBRARIAN] No new permanent facts detected.")

        # TASK B: Episodic Ledger Appending
        if session_summary and session_summary.get("main_agenda"):
            now = datetime.datetime.now()

            clean_history = [
                entry for entry in chat_history if not entry['user'].startswith("[SYSTEM EVENT")]

            new_episode = {
                "timestamp": now.isoformat(timespec='seconds'),
                "date": now.strftime("%A, %B %d, %Y"),
                "main_agenda": session_summary.get("main_agenda", "General Conversation"),
                "details": session_summary.get("details", ""),
                "key_tools_used": session_summary.get("key_tools_used", []),
                "actual_context": clean_history
            }

            with episodic_lock:
                with open(EPISODIC_FILE, 'r', encoding='utf-8') as f:
                    ledger = json.load(f)

                ledger.insert(0, new_episode)

                with open(EPISODIC_FILE, 'w', encoding='utf-8') as f:
                    json.dump(ledger, f, indent=4)

            print(
                f"🗓️ [LIBRARIAN] Session logged to Episodic Ledger: '{new_episode['main_agenda']}'")

    except Exception as e:
        print(f"⚠️ [LIBRARIAN] Error during memory extraction: {e}")


def trigger_consolidation(chat_history, wait=False):
    """Spins up the Librarian in a daemon thread. If wait=True, blocks until finished."""
    thread = threading.Thread(
        target=_consolidate_task,
        args=(chat_history.copy(),),
        daemon=not wait
    )
    thread.start()

    if wait:
        thread.join()


def get_all_memories() -> dict:
    """Reads and returns all categories and facts from memory.json."""
    init_memory()
    with memory_lock:
        try:
            with open(MEMORY_FILE, 'r', encoding='utf-8') as f:
                data = json.load(f)
                if isinstance(data, dict):
                    return data
                return {"general": []}
        except Exception:
            return {"general": []}


def save_all_memories(memories: dict) -> dict:
    """Saves a normalized dictionary of category -> list of facts."""
    init_memory()
    if not isinstance(memories, dict):
        raise ValueError("Memories payload must be a JSON object/dict.")

    cleaned_memories = {}
    for cat, facts in memories.items():
        cat_clean = str(cat).strip().lower()
        if not cat_clean:
            continue
        if not isinstance(facts, list):
            facts = [str(facts)] if facts else []
        clean_facts = []
        for fact in facts:
            fact_str = str(fact).strip()
            if fact_str and fact_str not in clean_facts:
                clean_facts.append(fact_str)
        cleaned_memories[cat_clean] = clean_facts

    # Always ensure at least "general" category exists
    if "general" not in cleaned_memories:
        cleaned_memories["general"] = []

    with memory_lock:
        with open(MEMORY_FILE, 'w', encoding='utf-8') as f:
            json.dump(cleaned_memories, f, indent=4)

    return cleaned_memories


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    if "--get" in sys.argv:
        try:
            memories = get_all_memories()
            print(json.dumps({"ok": True, "memories": memories}))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)

    elif "--save-stdin" in sys.argv:
        try:
            raw_input = sys.stdin.read().strip()
            payload = json.loads(raw_input) if raw_input else {}
            memories_data = payload.get("memories", payload)
            saved = save_all_memories(memories_data)
            print(json.dumps({"ok": True, "memories": saved}))
            sys.exit(0)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}))
            sys.exit(1)
