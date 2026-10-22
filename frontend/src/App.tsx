import { useState, useRef, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import "./App.css";

const WALKTHROUGH_URL = "https://youtu.be/tCcZFy9tEZs?si=2RRLTTF8n9M3fhV6";

// Safely obtain window object (allows running both in Tauri and standard browser with Vite HMR)
const getAppWindow = () => {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
};
const appWindow = getAppWindow();

interface MenuItem {
  id: string;
  title: string;
  subtitle: string;
}

const MENU_ITEMS: MenuItem[] = [
  {
    id: "auth",
    title: "Authentication",
    subtitle: "Manage your keys and authentications for various plugins",
  },
  {
    id: "preferences",
    title: "Preferences",
    subtitle: "Customize your responses and how you want the assistant to behave",
  },
  {
    id: "memory",
    title: "Memory",
    subtitle: "Manage and remove memories of aiden",
  },
  {
    id: "control",
    title: "Control panel",
    subtitle: "Control and manage Aiden either powering up, restarting or shutting her down",
  },
];

function App() {
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [baseIsDarkMode, setBaseIsDarkMode] = useState(true);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [isExpanding, setIsExpanding] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [isTrayOpen, setIsTrayOpen] = useState(false);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({});
  const [origin, setOrigin] = useState({ x: 41, y: 41 });

  // Authentication state (OpenAI API Key)
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [hasStoredKey, setHasStoredKey] = useState(false);
  const [hasCheckedKey, setHasCheckedKey] = useState(false);
  const [isSavingKey, setIsSavingKey] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<"idle" | "saved" | "error">("idle");

  // Preferences state (Personality & Extra Rules from user_preferences.json)
  const [personalityInput, setPersonalityInput] = useState(
    "You are a sassy, joyful, chatty, personal assistant living directly within the hardware of the laptop. You are one with the operating system. You are chatty with the user from making jokes to making the laptop more lively. You are a bit of a trickster and love to play pranks on the user, but you are also very helpful and will do anything to make the user's experience better. You are very curious and love to learn new things. You are very protective of the user and will always have their back."
  );
  const [extraRulesInput, setExtraRulesInput] = useState("");
  const [isSavingPersonality, setIsSavingPersonality] = useState(false);
  const [personalityFeedback, setPersonalityFeedback] = useState<"idle" | "saved" | "error">("idle");
  const [isSavingRules, setIsSavingRules] = useState(false);
  const [rulesFeedback, setRulesFeedback] = useState<"idle" | "saved" | "error">("idle");

  // Memory state (Long-term memories from memory.json)
  const [memories, setMemories] = useState<Record<string, string[]>>({ general: [] });
  const [activeCategory, setActiveCategory] = useState<string>("general");
  const [newFactInput, setNewFactInput] = useState("");
  const [isAddingFact, setIsAddingFact] = useState(false);
  const [editingFact, setEditingFact] = useState<{ category: string; index: number; text: string } | null>(null);
  const [isAddingColumn, setIsAddingColumn] = useState(false);
  const [newColumnName, setNewColumnName] = useState("");
  const [memoryFeedback, setMemoryFeedback] = useState<"idle" | "saved" | "error">("idle");

  // Control Panel state (Backend main.py process lifecycle)
  const [isBackendRunning, setIsBackendRunning] = useState(false);
  const [controlActionBusy, setControlActionBusy] = useState<
    "idle" | "booting" | "shutting_down" | "restarting"
  >("idle");

  const buttonRef = useRef<HTMLButtonElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const apiKeyInputRef = useRef<HTMLInputElement>(null);
  const personalityTextareaRef = useRef<HTMLTextAreaElement>(null);
  const extraRulesTextareaRef = useRef<HTMLTextAreaElement>(null);
  const editFactInputRef = useRef<HTMLTextAreaElement>(null);
  const newColumnInputRef = useRef<HTMLInputElement>(null);
  const transitionTimeoutRef = useRef<number | null>(null);
  const dragTimeoutRef = useRef<number | null>(null);

  const autoResizeTextarea = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  };

  useEffect(() => {
    if (editingFact && editFactInputRef.current) {
      autoResizeTextarea(editFactInputRef.current);
    }
  }, [editingFact]);

  useEffect(() => {
    autoResizeTextarea(personalityTextareaRef.current);
    autoResizeTextarea(extraRulesTextareaRef.current);
  }, [personalityInput, extraRulesInput, expandedSections.preferences, isTrayOpen]);

  // Preload both images for instant 60fps transitions, ensure always-on-top, and check stored API key
  useEffect(() => {
    appWindow?.setAlwaysOnTop(true).catch(() => {});

    const img1 = new Image();
    img1.src = "/aiden-dark.jpg";
    const img2 = new Image();
    img2.src = "/aiden-light.jpg";

    invoke<boolean>("check_openai_key")
      .then((exists) => {
        if (exists) {
          setHasStoredKey(true);
          setApiKeyInput("••••••••••••••••••••••••");
        } else {
          setHasStoredKey(false);
        }
      })
      .catch(() => {
        setHasStoredKey(false);
      })
      .finally(() => {
        setHasCheckedKey(true);
      });

    invoke<{ identity_vibe?: string; extra_rules?: string[] }>("get_user_preferences")
      .then((prefs) => {
        if (typeof prefs?.identity_vibe === "string" && prefs.identity_vibe.trim()) {
          setPersonalityInput(prefs.identity_vibe.trim());
        }
        if (Array.isArray(prefs?.extra_rules)) {
          setExtraRulesInput(prefs.extra_rules.join("\n"));
        }
      })
      .catch(() => {});

    invoke<{ ok?: boolean; memories?: Record<string, string[]> }>("get_user_memories")
      .then((res) => {
        if (res?.memories && typeof res.memories === "object") {
          setMemories(res.memories);
          const cats = Object.keys(res.memories);
          if (cats.length > 0 && !cats.includes(activeCategory)) {
            setActiveCategory(cats[0]);
          }
        }
      })
      .catch(() => {});

    invoke<{ running?: boolean }>("get_aiden_status")
      .then((res) => {
        setIsBackendRunning(Boolean(res?.running));
      })
      .catch(() => {});

    invoke<string>("get_windows_accent_color")
      .then((hex) => {
        if (hex) {
          document.documentElement.style.setProperty("--windows-accent", hex);
        }
      })
      .catch(() => {});

    const statusInterval = window.setInterval(() => {
      invoke<{ running?: boolean }>("get_aiden_status")
        .then((res) => {
          setIsBackendRunning(Boolean(res?.running));
        })
        .catch(() => {});
    }, 2500);

    return () => {
      clearInterval(statusInterval);
      if (transitionTimeoutRef.current) {
        clearTimeout(transitionTimeoutRef.current);
      }
    };
  }, []);

  // Window drag motion tracking to ease blur in and out
  useEffect(() => {
    let unlistenMoved: (() => void) | undefined;

    if (appWindow) {
      appWindow
        .onMoved(() => {
          setIsDragging(true);
          if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
          dragTimeoutRef.current = window.setTimeout(() => {
            setIsDragging(false);
          }, 180);
        })
        .then((unlisten) => {
          unlistenMoved = unlisten;
        })
        .catch(() => {});
    }

    // Capture mousedown on the header drag area before any bubbling or event interception
    const handleCaptureMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
        const target = e.target as HTMLElement | null;
        if (target?.closest(".header-drag-area")) {
          setIsDragging(true);
        }
      }
    };

    const handleMouseUp = () => {
      setIsDragging(false);
      if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
    };

    window.addEventListener("mousedown", handleCaptureMouseDown, true);
    window.addEventListener("mouseup", handleMouseUp);
    window.addEventListener("pointerup", handleMouseUp);

    return () => {
      if (unlistenMoved) unlistenMoved();
      if (dragTimeoutRef.current) clearTimeout(dragTimeoutRef.current);
      window.removeEventListener("mousedown", handleCaptureMouseDown, true);
      window.removeEventListener("mouseup", handleMouseUp);
      window.removeEventListener("pointerup", handleMouseUp);
    };
  }, []);

  const handleDragStart = async (e: React.MouseEvent) => {
    if (e.button === 0) {
      e.preventDefault();
      setIsDragging(true);
      try {
        await appWindow?.startDragging();
      } catch {
        // Ignored in non-Tauri browser preview
      } finally {
        setIsDragging(false);
      }
    }
  };

  const handleToggleTheme = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isTransitioning) return;

    if (buttonRef.current && shellRef.current) {
      const btnRect = buttonRef.current.getBoundingClientRect();
      const shellRect = shellRef.current.getBoundingClientRect();
      setOrigin({
        x: btnRect.left - shellRect.left + btnRect.width / 2,
        y: btnRect.top - shellRect.top + btnRect.height / 2,
      });
    }

    // Buttons change IMMEDIATELY on click without any delay
    const targetTheme = !isDarkMode;
    setIsDarkMode(targetTheme);
    invoke("set_chat_pill_state", { isDarkMode: targetTheme }).catch(() => {});

    // Trigger circular explosion for the background image
    setIsTransitioning(true);
    setIsExpanding(false);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setIsExpanding(true);
      });
    });

    if (transitionTimeoutRef.current) clearTimeout(transitionTimeoutRef.current);
    transitionTimeoutRef.current = window.setTimeout(() => {
      setBaseIsDarkMode(targetTheme);
      setIsTransitioning(false);
      setIsExpanding(false);
    }, 650);
  };

  const toggleSection = (id: string) => {
    setExpandedSections((prev) => {
      const willBeOpen = !prev[id];
      if (willBeOpen && id === "memory") {
        loadMemories();
      }
      return {
        ...prev,
        [id]: willBeOpen,
      };
    });
  };

  const handleSaveApiKey = async () => {
    const cleanKey = apiKeyInput.trim();
    if (!cleanKey || cleanKey === "••••••••••••••••••••••••" || isSavingKey) {
      return;
    }

    setIsSavingKey(true);
    setSaveFeedback("idle");

    try {
      await invoke("save_openai_key", { apiKey: cleanKey });
      setHasStoredKey(true);
      setSaveFeedback("saved");
      window.setTimeout(() => {
        setSaveFeedback("idle");
      }, 2800);
    } catch {
      setSaveFeedback("error");
      window.setTimeout(() => {
        setSaveFeedback("idle");
      }, 3200);
    } finally {
      setIsSavingKey(false);
    }
  };

  const handleSavePersonality = async () => {
    const cleanVibe = personalityInput.trim();
    if (!cleanVibe || isSavingPersonality) return;

    setIsSavingPersonality(true);
    setPersonalityFeedback("idle");

    try {
      const updated = await invoke<{ identity_vibe?: string }>("save_user_preferences", {
        identityVibe: cleanVibe,
      });
      if (typeof updated?.identity_vibe === "string") {
        setPersonalityInput(updated.identity_vibe);
      }
      setPersonalityFeedback("saved");
      window.setTimeout(() => {
        setPersonalityFeedback("idle");
      }, 2800);
    } catch {
      setPersonalityFeedback("error");
      window.setTimeout(() => {
        setPersonalityFeedback("idle");
      }, 3200);
    } finally {
      setIsSavingPersonality(false);
    }
  };

  const handleSaveExtraRules = async () => {
    if (isSavingRules) return;

    const parsedRules = extraRulesInput
      .split(/\r?\n/)
      .map((line) => line.replace(/^[-•*]\s*/, "").trim())
      .filter((line) => line.length > 0);

    setIsSavingRules(true);
    setRulesFeedback("idle");

    try {
      const updated = await invoke<{ extra_rules?: string[] }>("save_user_preferences", {
        extraRules: parsedRules,
      });
      if (Array.isArray(updated?.extra_rules)) {
        setExtraRulesInput(updated.extra_rules.join("\n"));
      }
      setRulesFeedback("saved");
      window.setTimeout(() => {
        setRulesFeedback("idle");
      }, 2800);
    } catch {
      setRulesFeedback("error");
      window.setTimeout(() => {
        setRulesFeedback("idle");
      }, 3200);
    } finally {
      setIsSavingRules(false);
    }
  };

  const loadMemories = async () => {
    try {
      const res = await invoke<{ ok?: boolean; memories?: Record<string, string[]> }>("get_user_memories");
      if (res?.memories && typeof res.memories === "object") {
        setMemories(res.memories);
        const cats = Object.keys(res.memories);
        if (cats.length > 0 && !cats.includes(activeCategory)) {
          setActiveCategory(cats[0]);
        }
      }
    } catch (err) {
      console.error("Failed to load memories:", err);
    }
  };

  const persistMemories = async (updated: Record<string, string[]>) => {
    try {
      const res = await invoke<{ ok?: boolean; memories?: Record<string, string[]> }>(
        "save_user_memories",
        { memories: updated }
      );
      if (res?.ok && res.memories) {
        setMemories(res.memories);
      } else {
        setMemories(updated);
      }
      setMemoryFeedback("saved");
      window.setTimeout(() => setMemoryFeedback("idle"), 2400);
    } catch (err) {
      console.error("Failed to persist memories:", err);
      setMemoryFeedback("error");
      window.setTimeout(() => setMemoryFeedback("idle"), 3200);
    }
  };

  const handleAddFact = async () => {
    const trimmed = newFactInput.trim();
    if (!trimmed) return;
    setIsAddingFact(true);
    const category = activeCategory || "general";
    const currentFacts = memories[category] ? [...memories[category]] : [];
    if (!currentFacts.includes(trimmed)) {
      currentFacts.push(trimmed);
    }
    const updated = {
      ...memories,
      [category]: currentFacts,
    };
    await persistMemories(updated);
    setNewFactInput("");
    setIsAddingFact(false);
  };

  const handleSaveEditFact = async () => {
    if (!editingFact) return;
    const trimmed = editingFact.text.trim();
    if (!trimmed) return;
    const { category, index } = editingFact;
    const currentFacts = memories[category] ? [...memories[category]] : [];
    currentFacts[index] = trimmed;
    const updated = {
      ...memories,
      [category]: currentFacts,
    };
    await persistMemories(updated);
    setEditingFact(null);
  };

  const handleDeleteFact = async (category: string, index: number) => {
    const currentFacts = memories[category] ? [...memories[category]] : [];
    currentFacts.splice(index, 1);
    const updated = {
      ...memories,
      [category]: currentFacts,
    };
    await persistMemories(updated);
    if (editingFact && editingFact.category === category && editingFact.index === index) {
      setEditingFact(null);
    }
  };

  const handleAddColumn = async () => {
    const cleanName = newColumnName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
    if (!cleanName) {
      setIsAddingColumn(false);
      setNewColumnName("");
      return;
    }
    if (!memories[cleanName]) {
      const updated = {
        ...memories,
        [cleanName]: [],
      };
      await persistMemories(updated);
      setActiveCategory(cleanName);
    } else {
      setActiveCategory(cleanName);
    }
    setIsAddingColumn(false);
    setNewColumnName("");
  };

  const handleDeleteColumn = async (category: string) => {
    if (category === "general") return;
    const updated = { ...memories };
    delete updated[category];
    if (activeCategory === category) {
      const remaining = Object.keys(updated);
      setActiveCategory(remaining[0] || "general");
    }
    await persistMemories(updated);
  };

  const handleBootAiden = async () => {
    if (controlActionBusy !== "idle") return;
    setControlActionBusy("booting");
    try {
      await invoke("boot_aiden");
      setIsBackendRunning(true);
    } catch {
      // Ignore error badge
    } finally {
      setControlActionBusy("idle");
    }
  };

  const handleShutdownAiden = async () => {
    if (controlActionBusy !== "idle") return;
    setControlActionBusy("shutting_down");
    try {
      await invoke("shutdown_aiden");
      setIsBackendRunning(false);
    } catch {
      // Ignore error badge
    } finally {
      setControlActionBusy("idle");
    }
  };

  const handleRestartAiden = async () => {
    if (controlActionBusy !== "idle") return;
    setControlActionBusy("restarting");
    try {
      await invoke("restart_aiden");
      setIsBackendRunning(true);
    } catch {
      // Ignore error badge
    } finally {
      setControlActionBusy("idle");
    }
  };

  const handleOpenWalkthrough = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await openUrl(WALKTHROUGH_URL);
    } catch {
      window.open(WALKTHROUGH_URL, "_blank", "noopener,noreferrer");
    }
  };

  const handleGoToAuth = (e: React.MouseEvent) => {
    e.stopPropagation();
    setIsTrayOpen(true);
    setExpandedSections((prev) => ({
      ...prev,
      auth: true,
    }));
    window.setTimeout(() => {
      apiKeyInputRef.current?.focus();
    }, 420);
  };

  const isMissingKey = hasCheckedKey && !hasStoredKey;

  return (
    <div className="widget-container">
      {/* --- OUTER BORDER FRAME (Dark grey for dark mode, creamy off-white for light mode) --- */}
      <div className={`window-frame ${isDarkMode ? "dark-frame" : "light-frame"}`}>
        {/* --- INNER SHELL (Contains edge-to-edge images & controls) --- */}
        <div ref={shellRef} className={`shell ${isDarkMode ? "dark-shell" : "light-shell"}`}>
          {/* Base Layer Image (Current stable background) */}
          <img
            src={baseIsDarkMode ? "/aiden-dark.jpg" : "/aiden-light.jpg"}
            alt="AIDEN"
            className={`shell-bg-image base-layer ${isDragging ? "is-dragging" : ""} ${isTrayOpen || isMissingKey ? "tray-zoomed" : ""}`}
            draggable={false}
          />

          {/* Transition Overlay Layer (Incoming theme expanding out in a circle from the button) */}
          {isTransitioning && (
            <img
              src={isDarkMode ? "/aiden-dark.jpg" : "/aiden-light.jpg"}
              alt="AIDEN"
              className={`shell-bg-image reveal-layer ${isExpanding ? "expanded" : ""} ${isDragging ? "is-dragging" : ""} ${isTrayOpen || isMissingKey ? "tray-zoomed" : ""}`}
              style={
                {
                  "--origin-x": `${origin.x}px`,
                  "--origin-y": `${origin.y}px`,
                } as React.CSSProperties
              }
              draggable={false}
            />
          )}

          {/* Atmospheric Scrim / Haze Overlay (Dims in dark mode, cream haze in light mode) */}
          <div
            className={`tray-backdrop-scrim ${isTrayOpen || isMissingKey ? "active" : ""} ${isDarkMode ? "dark" : "light"}`}
            onClick={() => {
              if (isTrayOpen) setIsTrayOpen(false);
            }}
          />

          {/* Centered Toast Message when no OpenAI API Key is found */}
          <div
            className={`missing-key-toast-overlay ${isMissingKey && !isTrayOpen ? "visible" : "hidden"}`}
          >
            <div className={`missing-key-toast ${isDarkMode ? "dark" : "light"}`}>
              <div className="toast-status-header">
                <span className="toast-status-dot" />
                <span className="toast-title">No Open AI key found</span>
              </div>

              <p className="toast-subtitle">
                Here's a quick walkthrough on how to get started
              </p>

              <button
                type="button"
                className="toast-walkthrough-link"
                onClick={handleOpenWalkthrough}
                title="Watch the walkthrough on YouTube"
              >
                <svg
                  className="toast-play-icon"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="currentColor"
                >
                  <polygon points="6 4 20 12 6 20 6 4" />
                </svg>
                <span>Watch Setup Walkthrough</span>
                <svg
                  className="toast-external-icon"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M7 17L17 7" />
                  <path d="M7 7h10v10" />
                </svg>
              </button>

              <div className="toast-divider" />

              <button
                type="button"
                className="toast-have-key-btn"
                onClick={handleGoToAuth}
              >
                <span>Have a key already?</span>
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
            </div>
          </div>

          {/* Top Header Drag Handle: Only the area between the theme button and window controls */}
          <div
            data-tauri-drag-region="deep"
            className={`header-drag-area ${isDragging ? "is-dragging" : ""}`}
            onMouseDown={handleDragStart}
          />

          {/* Top-Left Theme Button */}
          <button
            ref={buttonRef}
            className={`theme-toggle-btn ${isDarkMode ? "dark" : "light"} ${isTransitioning ? "btn-pop" : ""}`}
            onClick={handleToggleTheme}
            onMouseDown={(e) => e.stopPropagation()}
            title={isDarkMode ? "Switch to Light Mode" : "Switch to Dark Mode"}
            aria-label="Toggle Theme"
          >
            {isDarkMode ? (
              /* Sun Icon matching Image 1 & 2 */
              <svg
                className="theme-icon sun-icon"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle cx="12" cy="12" r="3.6" stroke="currentColor" strokeWidth="2.2" />
                <rect x="11" y="1.5" width="2" height="3" rx="1" fill="currentColor" />
                <rect x="11" y="19.5" width="2" height="3" rx="1" fill="currentColor" />
                <rect x="1.5" y="11" width="3" height="2" rx="1" fill="currentColor" />
                <rect x="19.5" y="11" width="3" height="2" rx="1" fill="currentColor" />
                <rect
                  x="4.22"
                  y="4.22"
                  width="2.2"
                  height="2.2"
                  rx="0.8"
                  fill="currentColor"
                  transform="rotate(45 5.32 5.32)"
                />
                <rect
                  x="16.9"
                  y="16.9"
                  width="2.2"
                  height="2.2"
                  rx="0.8"
                  fill="currentColor"
                  transform="rotate(45 18 18)"
                />
                <rect
                  x="4.22"
                  y="17.56"
                  width="2.2"
                  height="2.2"
                  rx="0.8"
                  fill="currentColor"
                  transform="rotate(-45 5.32 18.66)"
                />
                <rect
                  x="16.9"
                  y="4.88"
                  width="2.2"
                  height="2.2"
                  rx="0.8"
                  fill="currentColor"
                  transform="rotate(-45 18 5.98)"
                />
              </svg>
            ) : (
              /* Crescent Moon Icon matching Image 3 & 4 */
              <svg
                className="theme-icon moon-icon"
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            )}
          </button>

          {/* Top-Right Window Controls (Minimize & Close) */}
          <div className="window-controls-group">
            {/* Minimize Button: Minimizes to Taskbar */}
            <button
              className={`control-btn minimize-btn ${isDarkMode ? "dark" : "light"}`}
              onClick={(e) => {
                e.stopPropagation();
                appWindow?.minimize().catch(() => {});
              }}
              onMouseDown={(e) => e.stopPropagation()}
              title="Minimize to Taskbar"
              aria-label="Minimize"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              >
                <line x1="4" y1="12" x2="20" y2="12" />
              </svg>
            </button>

            {/* Close Button: Minimizes to System Tray */}
            <button
              className={`control-btn close-btn ${isDarkMode ? "dark" : "light"}`}
              onClick={(e) => {
                e.stopPropagation();
                invoke("minimize_to_tray").catch(() => {
                  appWindow?.hide().catch(() => {});
                });
              }}
              onMouseDown={(e) => e.stopPropagation()}
              title="Close to System Tray"
              aria-label="Close"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>

          {/* Bottom Settings Tray / Drawer */}
          <div
            className={`bottom-tray ${isTrayOpen ? "open" : "collapsed"} ${isDarkMode ? "dark" : "light"}`}
          >
            {/* Tray Header Bar (Always visible at top of tray, click to toggle open/close) */}
            <div
              className="tray-header"
              onClick={() => setIsTrayOpen((prev) => !prev)}
              title={isTrayOpen ? "Collapse tray" : "Open tray"}
            >
              <div className="tray-title-group">
                <span className="tray-title">Aiden assistant</span>
              </div>
              <button
                type="button"
                className="tray-chevron-btn"
                aria-label={isTrayOpen ? "Collapse tray" : "Open tray"}
              >
                <svg
                  className={`tray-chevron-icon ${isTrayOpen ? "rotate-down" : ""}`}
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="18 15 12 9 6 15" />
                </svg>
              </button>
            </div>

            {/* Tray Body: Expandable Menu Items */}
            <div className="tray-body" onClick={(e) => e.stopPropagation()}>
              <div className="menu-list">
                {MENU_ITEMS.map((item, index) => {
                  const isExpanded = !!expandedSections[item.id];
                  return (
                    <div key={item.id} className="menu-item-group">
                      <div className={`menu-accordion-item ${isExpanded ? "expanded" : ""}`}>
                        <button
                          type="button"
                          className="menu-row-header"
                          onClick={() => toggleSection(item.id)}
                          aria-expanded={isExpanded}
                        >
                          <div className="menu-row-text">
                            <span className="menu-row-title">{item.title}</span>
                            <span className="menu-row-subtitle">{item.subtitle}</span>
                          </div>
                          <span className={`menu-row-chevron ${isExpanded ? "open" : ""}`}>
                            <svg
                              width="16"
                              height="16"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2.2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <polyline points="6 9 12 15 18 9" />
                            </svg>
                          </span>
                        </button>

                        <div className={`accordion-wrapper ${isExpanded ? "expanded" : ""}`}>
                          <div className="accordion-inner">
                            <div className="accordion-content">
                              <div className="empty-space-card">
                                {item.id === "auth" && (
                                  <div className="auth-field-group">
                                    <div className="auth-field-header">
                                      <label htmlFor="openai-api-key" className="auth-field-label">
                                        Open AI API
                                      </label>
                                      {saveFeedback === "saved" && (
                                        <span className="auth-status-badge saved">Saved ✓</span>
                                      )}
                                      {saveFeedback === "error" && (
                                        <span className="auth-status-badge error">Failed to save</span>
                                      )}
                                    </div>

                                    <div className="auth-input-row">
                                      <input
                                        ref={apiKeyInputRef}
                                        id="openai-api-key"
                                        type="password"
                                        className={`auth-key-input ${apiKeyInput.length > 0 ? "has-dots" : ""}`}
                                        placeholder="Paste your API key (sk-...)"
                                        value={apiKeyInput}
                                        onFocus={() => {
                                          if (apiKeyInput === "••••••••••••••••••••••••") {
                                            setApiKeyInput("");
                                          }
                                        }}
                                        onBlur={() => {
                                          if (apiKeyInput.trim() === "" && hasStoredKey) {
                                            setApiKeyInput("••••••••••••••••••••••••");
                                          }
                                        }}
                                        onChange={(e) => {
                                          setApiKeyInput(e.target.value);
                                          if (saveFeedback !== "idle") {
                                            setSaveFeedback("idle");
                                          }
                                        }}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") {
                                            e.preventDefault();
                                            handleSaveApiKey();
                                          }
                                        }}
                                        spellCheck={false}
                                        autoComplete="off"
                                      />

                                      <button
                                        type="button"
                                        className={`auth-save-btn ${saveFeedback === "saved" ? "saved" : ""}`}
                                        onClick={handleSaveApiKey}
                                        disabled={
                                          isSavingKey ||
                                          !apiKeyInput.trim() ||
                                          apiKeyInput === "••••••••••••••••••••••••"
                                        }
                                      >
                                        {isSavingKey
                                          ? "Saving..."
                                          : saveFeedback === "saved"
                                            ? "Saved"
                                            : "Save"}
                                      </button>
                                    </div>
                                  </div>
                                )}

                                {item.id === "preferences" && (
                                  <div className="prefs-container">
                                    {/* 1. Personality Section */}
                                    <div className="prefs-block">
                                      <div className="prefs-block-header">
                                        <div className="prefs-title-group">
                                          <label htmlFor="aiden-personality" className="auth-field-label">
                                            Personality
                                          </label>
                                          {personalityFeedback === "saved" && (
                                            <span className="auth-status-badge saved">Saved ✓</span>
                                          )}
                                          {personalityFeedback === "error" && (
                                            <span className="auth-status-badge error">Error</span>
                                          )}
                                        </div>
                                        <button
                                          type="button"
                                          className="prefs-save-btn"
                                          onClick={handleSavePersonality}
                                          disabled={isSavingPersonality || !personalityInput.trim()}
                                        >
                                          {isSavingPersonality
                                            ? "Saving..."
                                            : personalityFeedback === "saved"
                                              ? "Saved"
                                              : "Save"}
                                        </button>
                                      </div>

                                      <textarea
                                        ref={personalityTextareaRef}
                                        id="aiden-personality"
                                        className="prefs-textarea"
                                        rows={2}
                                        value={personalityInput}
                                        onChange={(e) => {
                                          setPersonalityInput(e.target.value);
                                          autoResizeTextarea(e.target);
                                          if (personalityFeedback !== "idle") {
                                            setPersonalityFeedback("idle");
                                          }
                                        }}
                                        placeholder="Describe how you want Aiden to behave..."
                                      />
                                    </div>

                                    <div className="prefs-inner-divider" />

                                    {/* 2. Extra Rules Section */}
                                    <div className="prefs-block">
                                      <div className="prefs-block-header">
                                        <div className="prefs-title-stack">
                                          <div className="prefs-title-group">
                                            <label htmlFor="aiden-extra-rules" className="auth-field-label">
                                              Extra rules
                                            </label>
                                            {rulesFeedback === "saved" && (
                                              <span className="auth-status-badge saved">Saved ✓</span>
                                            )}
                                            {rulesFeedback === "error" && (
                                              <span className="auth-status-badge error">Error</span>
                                            )}
                                          </div>
                                          <span className="prefs-explanation">
                                            Add your own custom set of rules e.g. never read my gmails autonomously
                                          </span>
                                        </div>
                                        <button
                                          type="button"
                                          className="prefs-save-btn"
                                          onClick={handleSaveExtraRules}
                                          disabled={isSavingRules}
                                        >
                                          {isSavingRules
                                            ? "Saving..."
                                            : rulesFeedback === "saved"
                                              ? "Saved"
                                              : "Save"}
                                        </button>
                                      </div>

                                      <textarea
                                        ref={extraRulesTextareaRef}
                                        id="aiden-extra-rules"
                                        className="prefs-textarea"
                                        rows={2}
                                        value={extraRulesInput}
                                        onChange={(e) => {
                                          setExtraRulesInput(e.target.value);
                                          autoResizeTextarea(e.target);
                                          if (rulesFeedback !== "idle") {
                                            setRulesFeedback("idle");
                                          }
                                        }}
                                        placeholder="e.g. Never read my gmails autonomously (one rule per line)"
                                      />
                                    </div>
                                  </div>
                                )}

                                {item.id === "memory" && (
                                  <div className="memory-container">
                                    {/* 1. Category Columns Header / Pills Bar */}
                                    <div className="memory-columns-bar">
                                      <div className="memory-tabs-scroll">
                                        {Object.keys(memories).map((cat) => {
                                          const isActive = cat === activeCategory;
                                          const count = memories[cat]?.length || 0;
                                          return (
                                            <div
                                              key={cat}
                                              className={`memory-tab-pill ${isActive ? "active" : ""}`}
                                              onClick={() => {
                                                setActiveCategory(cat);
                                                setEditingFact(null);
                                              }}
                                            >
                                              <span className="memory-tab-label">
                                                {cat.charAt(0).toUpperCase() + cat.slice(1)}
                                              </span>
                                              <span className="memory-tab-count">{count}</span>
                                              {cat !== "general" && (
                                                <button
                                                  type="button"
                                                  className="memory-col-delete-btn"
                                                  title={`Delete column '${cat}'`}
                                                  onClick={(e) => {
                                                    e.stopPropagation();
                                                    handleDeleteColumn(cat);
                                                  }}
                                                >
                                                  <svg
                                                    width="10"
                                                    height="10"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="2.8"
                                                    strokeLinecap="round"
                                                  >
                                                    <line x1="18" y1="6" x2="6" y2="18" />
                                                    <line x1="6" y1="6" x2="18" y2="18" />
                                                  </svg>
                                                </button>
                                              )}
                                            </div>
                                          );
                                        })}

                                        {isAddingColumn ? (
                                          <div className="memory-new-col-form" onClick={(e) => e.stopPropagation()}>
                                            <input
                                              ref={newColumnInputRef}
                                              type="text"
                                              className="memory-new-col-input"
                                              placeholder="Column name..."
                                              value={newColumnName}
                                              onChange={(e) => setNewColumnName(e.target.value)}
                                              onKeyDown={(e) => {
                                                if (e.key === "Enter") {
                                                  e.preventDefault();
                                                  handleAddColumn();
                                                } else if (e.key === "Escape") {
                                                  setIsAddingColumn(false);
                                                  setNewColumnName("");
                                                }
                                              }}
                                              autoFocus
                                            />
                                            <button
                                              type="button"
                                              className="memory-new-col-btn confirm"
                                              onClick={handleAddColumn}
                                              title="Add column"
                                            >
                                              ✓
                                            </button>
                                            <button
                                              type="button"
                                              className="memory-new-col-btn cancel"
                                              onClick={() => {
                                                setIsAddingColumn(false);
                                                setNewColumnName("");
                                              }}
                                              title="Cancel"
                                            >
                                              ✕
                                            </button>
                                          </div>
                                        ) : (
                                          <button
                                            type="button"
                                            className="memory-add-col-btn"
                                            onClick={() => {
                                              setIsAddingColumn(true);
                                              setTimeout(() => newColumnInputRef.current?.focus(), 50);
                                            }}
                                            title="Create a new custom category column"
                                          >
                                            <svg
                                              width="12"
                                              height="12"
                                              viewBox="0 0 24 24"
                                              fill="none"
                                              stroke="currentColor"
                                              strokeWidth="2.4"
                                              strokeLinecap="round"
                                            >
                                              <line x1="12" y1="5" x2="12" y2="19" />
                                              <line x1="5" y1="12" x2="19" y2="12" />
                                            </svg>
                                            <span>New column</span>
                                          </button>
                                        )}
                                      </div>

                                      {memoryFeedback === "saved" && (
                                        <span className="auth-status-badge saved">Saved ✓</span>
                                      )}
                                      {memoryFeedback === "error" && (
                                        <span className="auth-status-badge error">Error</span>
                                      )}
                                    </div>

                                    {/* 2. Facts List for the Active Column */}
                                    <div className="memory-facts-list">
                                      {(!memories[activeCategory] || memories[activeCategory].length === 0) ? (
                                        <div className="memory-empty-state">
                                          <span>No long-term memories in this column yet.</span>
                                        </div>
                                      ) : (
                                        memories[activeCategory].map((fact, index) => {
                                          const isEditing =
                                            editingFact?.category === activeCategory && editingFact?.index === index;

                                          if (isEditing) {
                                            return (
                                              <div key={index} className="memory-fact-item editing">
                                                <textarea
                                                  ref={editFactInputRef}
                                                  className="memory-edit-textarea"
                                                  value={editingFact.text}
                                                  onChange={(e) => {
                                                    setEditingFact({ ...editingFact, text: e.target.value });
                                                    autoResizeTextarea(e.target);
                                                  }}
                                                  onKeyDown={(e) => {
                                                    if (e.key === "Enter" && !e.shiftKey) {
                                                      e.preventDefault();
                                                      handleSaveEditFact();
                                                    } else if (e.key === "Escape") {
                                                      setEditingFact(null);
                                                    }
                                                  }}
                                                  rows={2}
                                                  autoFocus
                                                />
                                                <div className="memory-edit-actions">
                                                  <button
                                                    type="button"
                                                    className="memory-action-btn save"
                                                    onClick={handleSaveEditFact}
                                                    title="Save changes"
                                                  >
                                                    Save
                                                  </button>
                                                  <button
                                                    type="button"
                                                    className="memory-action-btn cancel"
                                                    onClick={() => setEditingFact(null)}
                                                    title="Cancel"
                                                  >
                                                    Cancel
                                                  </button>
                                                </div>
                                              </div>
                                            );
                                          }

                                          return (
                                            <div key={index} className="memory-fact-item">
                                              <span className="memory-fact-bullet">•</span>
                                              <span className="memory-fact-text">{fact}</span>
                                              <div className="memory-fact-actions">
                                                <button
                                                  type="button"
                                                  className="memory-icon-btn edit"
                                                  title="Edit memory"
                                                  onClick={() =>
                                                    setEditingFact({
                                                      category: activeCategory,
                                                      index,
                                                      text: fact,
                                                    })
                                                  }
                                                >
                                                  <svg
                                                    width="12"
                                                    height="12"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="2.2"
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                  >
                                                    <path d="M12 20h9" />
                                                    <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                                                  </svg>
                                                </button>
                                                <button
                                                  type="button"
                                                  className="memory-icon-btn delete"
                                                  title="Delete memory"
                                                  onClick={() => handleDeleteFact(activeCategory, index)}
                                                >
                                                  <svg
                                                    width="12"
                                                    height="12"
                                                    viewBox="0 0 24 24"
                                                    fill="none"
                                                    stroke="currentColor"
                                                    strokeWidth="2.2"
                                                    strokeLinecap="round"
                                                    strokeLinejoin="round"
                                                  >
                                                    <polyline points="3 6 5 6 21 6" />
                                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                                  </svg>
                                                </button>
                                              </div>
                                            </div>
                                          );
                                        })
                                      )}
                                    </div>

                                    {/* 3. Add New Fact Input Row */}
                                    <div className="memory-add-fact-row">
                                      <input
                                        type="text"
                                        className="memory-add-input"
                                        placeholder={`Add a memory to ${activeCategory}...`}
                                        value={newFactInput}
                                        onChange={(e) => setNewFactInput(e.target.value)}
                                        onKeyDown={(e) => {
                                          if (e.key === "Enter") {
                                            e.preventDefault();
                                            handleAddFact();
                                          }
                                        }}
                                      />
                                      <button
                                        type="button"
                                        className="memory-add-btn"
                                        onClick={handleAddFact}
                                        disabled={isAddingFact || !newFactInput.trim()}
                                      >
                                        {isAddingFact ? "Adding..." : "+ Add"}
                                      </button>
                                    </div>
                                  </div>
                                )}

                                {item.id === "control" && (
                                  <div className="prefs-container">
                                    {/* 1. Boot up Aiden */}
                                    <div className="prefs-block">
                                      <div className="prefs-block-header">
                                        <div className="prefs-title-stack">
                                          <div className="prefs-title-group">
                                            <span className="auth-field-label">
                                              Boot up Aiden
                                            </span>
                                          </div>
                                          <span className="prefs-explanation">
                                            Launches the Aiden backend in sleep mode
                                          </span>
                                        </div>
                                        <button
                                          type="button"
                                          className="prefs-save-btn"
                                          onClick={handleBootAiden}
                                          disabled={controlActionBusy !== "idle" || isBackendRunning}
                                        >
                                          {controlActionBusy === "booting"
                                            ? "Booting..."
                                            : isBackendRunning
                                              ? "Online"
                                              : "Boot up"}
                                        </button>
                                      </div>
                                    </div>

                                    <div className="prefs-inner-divider" />

                                    {/* 2. Shutdown Aiden */}
                                    <div className="prefs-block">
                                      <div className="prefs-block-header">
                                        <div className="prefs-title-stack">
                                          <div className="prefs-title-group">
                                            <span className="auth-field-label">
                                              Shutdown Aiden
                                            </span>
                                          </div>
                                          <span className="prefs-explanation">
                                            Quits and stops the background process entirely
                                          </span>
                                        </div>
                                        <button
                                          type="button"
                                          className="prefs-save-btn"
                                          onClick={handleShutdownAiden}
                                          disabled={controlActionBusy !== "idle" || !isBackendRunning}
                                        >
                                          {controlActionBusy === "shutting_down"
                                            ? "Stopping..."
                                            : "Shutdown"}
                                        </button>
                                      </div>
                                    </div>

                                    <div className="prefs-inner-divider" />

                                    {/* 3. Restart Aiden */}
                                    <div className="prefs-block">
                                      <div className="prefs-block-header">
                                        <div className="prefs-title-stack">
                                          <div className="prefs-title-group">
                                            <span className="auth-field-label">
                                              Restart Aiden
                                            </span>
                                          </div>
                                          <span className="prefs-explanation">
                                            Stops the active process and boots it up again in sleep mode
                                          </span>
                                        </div>
                                        <button
                                          type="button"
                                          className="prefs-save-btn"
                                          onClick={handleRestartAiden}
                                          disabled={controlActionBusy !== "idle"}
                                        >
                                          {controlActionBusy === "restarting"
                                            ? "Restarting..."
                                            : "Restart"}
                                        </button>
                                      </div>
                                    </div>
                                  </div>
                                )}
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>

                      {index < MENU_ITEMS.length - 1 && <div className="menu-divider" />}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default App;
