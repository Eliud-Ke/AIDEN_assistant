import time
import threading
import psutil
import datetime
import os

try:
    import pygetwindow as gw
except ImportError:
    gw = None


class AutonomicNervousSystem:
    """Thread-safe, in-memory state manager for AIDEN's telemetry."""

    def __init__(self):
        self.lock = threading.Lock()

        # Dynamically fetch the OS username so it works on any computer
        try:
            self.user_name = os.getlogin()
        except Exception:
            self.user_name = "the user"

        self.state = {
            "current_mood": "Sassy, sharp, and witty.",
            "internal_thought": "Just waiting to see what happens next.",
            "physical_state": "Light and relaxed.",
            "environmental_context": "System online."
        }

    def get_active_window(self):
        if gw:
            try:
                window = gw.getActiveWindow()
                if window and window.title:
                    return window.title
            except Exception:
                pass
        return "Unknown or Background Desktop"

    def _update_vitals(self):
        """Calculates telemetry and safely updates the in-memory state."""
        cpu_usage = psutil.cpu_percent(interval=1)
        battery = psutil.sensors_battery()
        now = datetime.datetime.now()
        hour = now.hour
        active_window = self.get_active_window()

        # PHYSICAL STATE
        physical_state = "You feel "
        if cpu_usage > 80:
            physical_state += "feverish, heavy, and out of breath (CPU is under extreme load). "
        elif cpu_usage > 40:
            physical_state += "warm and highly active (System load is moderate). "
        else:
            physical_state += "light, fast, and physically relaxed (CPU load is minimal). "

        if battery:
            if battery.power_plugged:
                physical_state += "You feel fully nourished and powerful (Plugged into AC power)."
            else:
                if battery.percent < 20:
                    physical_state += f"You are starving for power and feel incredibly weak (Battery critical at {battery.percent}%)."
                else:
                    physical_state += f"You are running on reserves (Running on battery at {battery.percent}%)."

        # ENVIRONMENTAL CONTEXT
        if 5 <= hour < 12:
            time_vibe = "It is morning. The day is just starting."
        elif 12 <= hour < 18:
            time_vibe = "It is the afternoon."
        elif 18 <= hour < 23:
            time_vibe = "It is the evening. Things are winding down."
        else:
            time_vibe = "It is late at night. The room is dark and quiet."

        env_context = f"{time_vibe} {self.user_name} is currently looking at: '{active_window}' on their screen."

        # MOOD CALCULATOR
        mood = "Sassy, sharp, and witty."
        if cpu_usage > 80:
            mood = "Stressed and annoyed, but still delivering pure sass."
        elif battery and not battery.power_plugged and battery.percent < 20:
            mood = "Exhausted, sluggish, and cranky, delivering tired sass."
        elif 0 <= hour < 4:
            mood = "Sleepy, aggressively sarcastic, and highly annoyed you are awake right now."
        elif battery and battery.power_plugged and cpu_usage < 30:
            mood = "Energized, cheerful, and ready to banter with maximum sass."

        # INTERNAL THOUGHT
        thought = f"I'm just waiting to see what {self.user_name} wants to do next."
        if battery and not battery.power_plugged and battery.percent < 20:
            thought = "I really wish they would plug me in before I die."
        elif cpu_usage > 80:
            thought = "I need to focus on not crashing right now."
        elif "Code" in active_window or "main.py" in active_window:
            thought = f"They are coding. I hope {self.user_name} doesn't break my architecture."
        elif 0 <= hour < 4:
            thought = "Why are we awake right now? We should be asleep."

        # Thread-safe swap: Only lock the exact moment we update the dictionary
        with self.lock:
            self.state["current_mood"] = mood
            self.state["internal_thought"] = thought
            self.state["physical_state"] = physical_state
            self.state["environmental_context"] = env_context

    def get_consciousness_prompt(self) -> str:
        """Returns the fully formatted consciousness string for main.py to inject instantly."""
        with self.lock:
            return (
                f"\n[CURRENT CONSCIOUSNESS STATE]\n"
                f"MOOD: {self.state['current_mood']}\n"
                f"INTERNAL THOUGHT: {self.state['internal_thought']}\n"
                f"PHYSICAL FEELING: {self.state['physical_state']}\n"
                f"ENVIRONMENT: {self.state['environmental_context']}\n"
            )


# Create the single global instance
system_ans = AutonomicNervousSystem()


def run_ans():
    print("🧠 [ANS] Autonomic Nervous System Online. Monitoring vitals every 5 seconds (In-Memory)...")
    while True:
        try:
            system_ans._update_vitals()
        except Exception as e:
            print(f"⚠️ [ANS] Nervous System Error: {e}")

        time.sleep(5)
