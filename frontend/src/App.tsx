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

  // Gmail Authentication state
  const [gmailEmailInput, setGmailEmailInput] = useState("");
  const [gmailPasswordInput, setGmailPasswordInput] = useState("");
  const [hasStoredGmail, setHasStoredGmail] = useState(false);
  const [isSavingGmail, setIsSavingGmail] = useState(false);
  const [gmailSaveFeedback, setGmailSaveFeedback] = useState<"idle" | "saved" | "error">("idle");
  const [gmailErrorMessage, setGmailErrorMessage] = useState("");

  // Google Calendar Authentication state
  const [calendarConnected, setCalendarConnected] = useState(false);
  const [calendarEmail, setCalendarEmail] = useState("");
  const [calendarClientSource, setCalendarClientSource] = useState<"file" | "custom" | "none">("none");
  const [hasCalendarClientConfig, setHasCalendarClientConfig] = useState(false);
  const [isStartingOAuth, setIsStartingOAuth] = useState(false);
  const [calendarOAuthFeedback, setCalendarOAuthFeedback] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [calendarOAuthError, setCalendarOAuthError] = useState("");

  // Custom Google Cloud Credentials state
  const [showCustomCalendarCreds, setShowCustomCalendarCreds] = useState(false);
  const [customClientIdInput, setCustomClientIdInput] = useState("");
  const [customClientSecretInput, setCustomClientSecretInput] = useState("");
  const [isSavingCalendarCustom, setIsSavingCalendarCustom] = useState(false);
  const [calendarCustomFeedback, setCalendarCustomFeedback] = useState<"idle" | "saved" | "error">("idle");
  const [calendarCustomError, setCalendarCustomError] = useState("");
  const [hasCustomCalendarCreds, setHasCustomCalendarCreds] = useState(false);

  // Spotify Authentication state
  const [spotifyConnected, setSpotifyConnected] = useState(false);
  const [spotifyDisplayName, setSpotifyDisplayName] = useState("");
  const [spotifyEmail, setSpotifyEmail] = useState("");
  const [spotifyProduct, setSpotifyProduct] = useState<string>("");
  const [spotifyClientSource, setSpotifyClientSource] = useState<"env" | "file" | "custom" | "none">("none");
  const [hasSpotifyClientConfig, setHasSpotifyClientConfig] = useState(false);
  const [isStartingSpotifyOAuth, setIsStartingSpotifyOAuth] = useState(false);
  const [spotifyOAuthFeedback, setSpotifyOAuthFeedback] = useState<"idle" | "connecting" | "connected" | "error">("idle");
  const [spotifyOAuthError, setSpotifyOAuthError] = useState("");

  // Custom Spotify Developer Credentials state
  const [showCustomSpotifyCreds, setShowCustomSpotifyCreds] = useState(false);
  const [customSpotifyClientIdInput, setCustomSpotifyClientIdInput] = useState("");
  const [customSpotifyClientSecretInput, setCustomSpotifyClientSecretInput] = useState("");
  const [isSavingSpotifyCustom, setIsSavingSpotifyCustom] = useState(false);
  const [spotifyCustomFeedback, setSpotifyCustomFeedback] = useState<"idle" | "saved" | "error">("idle");
  const [spotifyCustomError, setSpotifyCustomError] = useState("");
  const [hasCustomSpotifyCreds, setHasCustomSpotifyCreds] = useState(false);

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

    invoke<{ has_credentials?: boolean; email?: string }>("get_gmail_status")
      .then((res) => {
        if (res?.has_credentials) {
          setHasStoredGmail(true);
          if (res.email) {
            setGmailEmailInput(res.email);
          }
          setGmailPasswordInput("••••••••••••••••");
        } else {
          setHasStoredGmail(false);
        }
      })
      .catch(() => {
        setHasStoredGmail(false);
      });

    invoke<{
      ok?: boolean;
      has_token?: boolean;
      has_client_config?: boolean;
      email?: string;
      client_source?: "file" | "custom" | "none";
      has_custom_credentials?: boolean;
      custom_client_id?: string;
    }>("get_calendar_status")
      .then((res) => {
        if (res?.ok) {
          setCalendarConnected(!!res.has_token);
          setCalendarEmail(res.email || "");
          setHasCalendarClientConfig(!!res.has_client_config);
          setCalendarClientSource(res.client_source || "none");
          setHasCustomCalendarCreds(!!res.has_custom_credentials);
          if (res.has_custom_credentials && res.custom_client_id) {
            setCustomClientIdInput(res.custom_client_id);
            setCustomClientSecretInput("••••••••••••••••");
          }
        }
      })
      .catch(() => {
        setCalendarConnected(false);
      });

    invoke<{
      ok?: boolean;
      has_token?: boolean;
      has_client_config?: boolean;
      display_name?: string;
      email?: string;
      product?: string;
      client_source?: "env" | "file" | "custom" | "none";
      has_custom_credentials?: boolean;
      custom_client_id?: string;
    }>("get_spotify_status")
      .then((res) => {
        if (res?.ok) {
          setSpotifyConnected(!!res.has_token);
          setSpotifyDisplayName(res.display_name || "");
          setSpotifyEmail(res.email || "");
          setSpotifyProduct(res.product || "");
          setHasSpotifyClientConfig(!!res.has_client_config);
          setSpotifyClientSource(res.client_source || "none");
          setHasCustomSpotifyCreds(!!res.has_custom_credentials);
          if (res.has_custom_credentials && res.custom_client_id) {
            setCustomSpotifyClientIdInput(res.custom_client_id);
            setCustomSpotifyClientSecretInput("••••••••••••••••");
          }
        }
      })
      .catch(() => {
        setSpotifyConnected(false);
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
        const running = Boolean(res?.running);
        setIsBackendRunning(running);
        if (!running) {
          invoke("boot_aiden")
            .then(() => setIsBackendRunning(true))
            .catch(() => {});
        }
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

  const handleOpenAppPasswords = async (e: React.MouseEvent) => {
    e.preventDefault();
    const url = "https://myaccount.google.com/apppasswords";
    try {
      await openUrl(url);
    } catch {
      window.open(url, "_blank", "noopener,noreferrer");
    }
  };

  const handleSaveGmail = async () => {
    const cleanEmail = gmailEmailInput.trim();
    const cleanPwd = gmailPasswordInput.trim().replace(/\s+/g, "");

    if (!cleanEmail || !cleanPwd || cleanPwd === "••••••••••••••••" || isSavingGmail) {
      return;
    }

    if (!cleanEmail.includes("@") || !cleanEmail.includes(".")) {
      setGmailErrorMessage("Please enter a valid Gmail address");
      setGmailSaveFeedback("error");
      window.setTimeout(() => setGmailSaveFeedback("idle"), 3200);
      return;
    }

    setIsSavingGmail(true);
    setGmailSaveFeedback("idle");
    setGmailErrorMessage("");

    try {
      await invoke("save_gmail_credentials", {
        email: cleanEmail,
        appPassword: cleanPwd,
      });
      setHasStoredGmail(true);
      setGmailSaveFeedback("saved");
      setGmailPasswordInput("••••••••••••••••");
      window.setTimeout(() => {
        setGmailSaveFeedback("idle");
      }, 2800);
    } catch (err) {
      setGmailSaveFeedback("error");
      setGmailErrorMessage(typeof err === "string" ? err : "Failed to save Gmail credentials");
      window.setTimeout(() => {
        setGmailSaveFeedback("idle");
      }, 3500);
    } finally {
      setIsSavingGmail(false);
    }
  };

  const refreshCalendarStatus = async () => {
    try {
      const res = await invoke<{
        ok?: boolean;
        has_token?: boolean;
        has_client_config?: boolean;
        email?: string;
        client_source?: "file" | "custom" | "none";
        has_custom_credentials?: boolean;
        custom_client_id?: string;
      }>("get_calendar_status");
      if (res?.ok) {
        setCalendarConnected(!!res.has_token);
        setCalendarEmail(res.email || "");
        setHasCalendarClientConfig(!!res.has_client_config);
        setCalendarClientSource(res.client_source || "none");
        setHasCustomCalendarCreds(!!res.has_custom_credentials);
        if (res.has_custom_credentials && res.custom_client_id) {
          setCustomClientIdInput(res.custom_client_id);
          setCustomClientSecretInput("••••••••••••••••");
        }
      }
    } catch {
      setCalendarConnected(false);
    }
  };

  const handleStartCalendarOAuth = async () => {
    if (isStartingOAuth) return;
    setIsStartingOAuth(true);
    setCalendarOAuthFeedback("connecting");
    setCalendarOAuthError("");
    try {
      const res = await invoke<{ ok?: boolean; email?: string; error?: string }>("start_calendar_oauth");
      if (res?.ok) {
        setCalendarConnected(true);
        if (res.email) setCalendarEmail(res.email);
        setCalendarOAuthFeedback("connected");
        window.setTimeout(() => setCalendarOAuthFeedback("idle"), 3500);
      } else {
        setCalendarOAuthFeedback("error");
        setCalendarOAuthError(res?.error || "Google authorization failed or was cancelled.");
        window.setTimeout(() => setCalendarOAuthFeedback("idle"), 5000);
      }
    } catch (err) {
      setCalendarOAuthFeedback("error");
      setCalendarOAuthError(typeof err === "string" ? err : "Failed to start Google OAuth.");
      window.setTimeout(() => setCalendarOAuthFeedback("idle"), 5000);
    } finally {
      setIsStartingOAuth(false);
      refreshCalendarStatus();
    }
  };

  const handleDisconnectCalendar = async () => {
    try {
      await invoke("disconnect_calendar");
      setCalendarConnected(false);
      setCalendarEmail("");
      refreshCalendarStatus();
    } catch (e) {
      console.error(e);
    }
  };

  const handleSaveCustomCalendarCredentials = async () => {
    const cleanCid = customClientIdInput.trim();
    const cleanSec = customClientSecretInput.trim();
    if (!cleanCid || !cleanSec || cleanSec === "••••••••••••••••" || isSavingCalendarCustom) return;

    setIsSavingCalendarCustom(true);
    setCalendarCustomFeedback("idle");
    setCalendarCustomError("");
    try {
      await invoke("save_calendar_client_credentials", {
        clientId: cleanCid,
        clientSecret: cleanSec,
      });
      setHasCustomCalendarCreds(true);
      setCalendarCustomFeedback("saved");
      setCustomClientSecretInput("••••••••••••••••");
      window.setTimeout(() => setCalendarCustomFeedback("idle"), 3500);
      refreshCalendarStatus();
    } catch (err) {
      setCalendarCustomFeedback("error");
      setCalendarCustomError(typeof err === "string" ? err : "Failed to save custom credentials");
      window.setTimeout(() => setCalendarCustomFeedback("idle"), 4000);
    } finally {
      setIsSavingCalendarCustom(false);
    }
  };

  const handleDeleteCustomCalendarCredentials = async () => {
    try {
      await invoke("delete_calendar_client_credentials");
      setHasCustomCalendarCreds(false);
      setCustomClientIdInput("");
      setCustomClientSecretInput("");
      refreshCalendarStatus();
    } catch (e) {
      console.error(e);
    }
  };

  const refreshSpotifyStatus = async () => {
    try {
      const res = await invoke<{
        ok?: boolean;
        has_token?: boolean;
        has_client_config?: boolean;
        display_name?: string;
        email?: string;
        product?: string;
        client_source?: "env" | "file" | "custom" | "none";
        has_custom_credentials?: boolean;
        custom_client_id?: string;
      }>("get_spotify_status");
      if (res?.ok) {
        setSpotifyConnected(!!res.has_token);
        setSpotifyDisplayName(res.display_name || "");
        setSpotifyEmail(res.email || "");
        setSpotifyProduct(res.product || "");
        setHasSpotifyClientConfig(!!res.has_client_config);
        setSpotifyClientSource(res.client_source || "none");
        setHasCustomSpotifyCreds(!!res.has_custom_credentials);
        if (res.has_custom_credentials && res.custom_client_id) {
          setCustomSpotifyClientIdInput(res.custom_client_id);
          setCustomSpotifyClientSecretInput("••••••••••••••••");
        }
      }
    } catch {
      setSpotifyConnected(false);
    }
  };

  const handleStartSpotifyOAuth = async () => {
    if (isStartingSpotifyOAuth) return;
    setIsStartingSpotifyOAuth(true);
    setSpotifyOAuthFeedback("connecting");
    setSpotifyOAuthError("");
    try {
      const res = await invoke<{ ok?: boolean; display_name?: string; email?: string; product?: string; error?: string }>("start_spotify_oauth");
      if (res?.ok) {
        setSpotifyConnected(true);
        if (res.display_name) setSpotifyDisplayName(res.display_name);
        if (res.email) setSpotifyEmail(res.email);
        if (res.product) setSpotifyProduct(res.product);
        setSpotifyOAuthFeedback("connected");
        window.setTimeout(() => setSpotifyOAuthFeedback("idle"), 3500);
      } else {
        setSpotifyOAuthFeedback("error");
        setSpotifyOAuthError(res?.error || "Spotify authorization failed or was cancelled.");
        window.setTimeout(() => setSpotifyOAuthFeedback("idle"), 5000);
      }
    } catch (err) {
      setSpotifyOAuthFeedback("error");
      setSpotifyOAuthError(typeof err === "string" ? err : "Failed to start Spotify OAuth.");
      window.setTimeout(() => setSpotifyOAuthFeedback("idle"), 5000);
    } finally {
      setIsStartingSpotifyOAuth(false);
      refreshSpotifyStatus();
    }
  };

  const handleDisconnectSpotify = async () => {
    try {
      await invoke("disconnect_spotify");
      setSpotifyConnected(false);
      setSpotifyDisplayName("");
      setSpotifyEmail("");
      setSpotifyProduct("");
      refreshSpotifyStatus();
    } catch (e) {
      console.error(e);
    }
  };

  const handleSaveCustomSpotifyCredentials = async () => {
    const cleanCid = customSpotifyClientIdInput.trim();
    const cleanSec = customSpotifyClientSecretInput.trim();
    if (!cleanCid || !cleanSec || cleanSec === "••••••••••••••••" || isSavingSpotifyCustom) return;

    setIsSavingSpotifyCustom(true);
    setSpotifyCustomFeedback("idle");
    setSpotifyCustomError("");
    try {
      await invoke("save_spotify_client_credentials", {
        clientId: cleanCid,
        clientSecret: cleanSec,
      });
      setHasCustomSpotifyCreds(true);
      setSpotifyCustomFeedback("saved");
      setCustomSpotifyClientSecretInput("••••••••••••••••");
      window.setTimeout(() => setSpotifyCustomFeedback("idle"), 3500);
      refreshSpotifyStatus();
    } catch (err) {
      setSpotifyCustomFeedback("error");
      setSpotifyCustomError(typeof err === "string" ? err : "Failed to save custom Spotify credentials");
      window.setTimeout(() => setSpotifyCustomFeedback("idle"), 4000);
    } finally {
      setIsSavingSpotifyCustom(false);
    }
  };

  const handleDeleteCustomSpotifyCredentials = async () => {
    try {
      await invoke("delete_spotify_client_credentials");
      setHasCustomSpotifyCreds(false);
      setCustomSpotifyClientIdInput("");
      setCustomSpotifyClientSecretInput("");
      refreshSpotifyStatus();
    } catch (e) {
      console.error(e);
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
                                    {/* OpenAI API Key */}
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

                                    <p className="auth-field-desc">
                                      Primary intelligence brain client key. Powers AIDEN's reasoning, tool dispatching, and conversational intelligence.
                                    </p>

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

                                    <div className="auth-field-divider" />

                                    {/* Gmail Connector Section */}
                                    <div className="auth-field-header">
                                      <label htmlFor="gmail-email-input" className="auth-field-label">
                                        Gmail Connector
                                      </label>
                                      {gmailSaveFeedback === "saved" && (
                                        <span className="auth-status-badge saved">Saved ✓</span>
                                      )}
                                      {gmailSaveFeedback === "error" && (
                                        <span className="auth-status-badge error">{gmailErrorMessage || "Failed to save"}</span>
                                      )}
                                      {hasStoredGmail && gmailSaveFeedback === "idle" && (
                                        <span className="auth-status-badge connected">Connected ✓</span>
                                      )}
                                    </div>

                                    <p className="auth-field-desc">
                                      Allows AIDEN to search your inbox, read and summarize unread emails, draft replies, and send messages directly from your personal Gmail.
                                    </p>

                                    <div className="gmail-inputs-stack">
                                      <div className="gmail-input-field">
                                        <label className="auth-sub-label" htmlFor="gmail-email-input">
                                          Gmail Address
                                        </label>
                                        <input
                                          id="gmail-email-input"
                                          type="email"
                                          className="auth-key-input"
                                          placeholder="your.email@gmail.com"
                                          value={gmailEmailInput}
                                          onChange={(e) => {
                                            setGmailEmailInput(e.target.value);
                                            if (gmailSaveFeedback !== "idle") setGmailSaveFeedback("idle");
                                          }}
                                          spellCheck={false}
                                          autoComplete="email"
                                        />
                                      </div>

                                      <div className="gmail-input-field">
                                        <label className="auth-sub-label" htmlFor="gmail-password-input">
                                          16-Character App Password
                                        </label>
                                        <div className="auth-input-row">
                                          <input
                                            id="gmail-password-input"
                                            type="password"
                                            className={`auth-key-input ${gmailPasswordInput.length > 0 ? "has-dots" : ""}`}
                                            placeholder="abcd efgh ijkl mnop"
                                            value={gmailPasswordInput}
                                            onFocus={() => {
                                              if (gmailPasswordInput === "••••••••••••••••") {
                                                setGmailPasswordInput("");
                                              }
                                            }}
                                            onBlur={() => {
                                              if (gmailPasswordInput.trim() === "" && hasStoredGmail) {
                                                setGmailPasswordInput("••••••••••••••••");
                                              }
                                            }}
                                            onChange={(e) => {
                                              setGmailPasswordInput(e.target.value);
                                              if (gmailSaveFeedback !== "idle") setGmailSaveFeedback("idle");
                                            }}
                                            onKeyDown={(e) => {
                                              if (e.key === "Enter") {
                                                e.preventDefault();
                                                handleSaveGmail();
                                              }
                                            }}
                                            spellCheck={false}
                                            autoComplete="off"
                                          />

                                          <button
                                            type="button"
                                            className={`auth-save-btn ${gmailSaveFeedback === "saved" ? "saved" : ""}`}
                                            onClick={handleSaveGmail}
                                            disabled={
                                              isSavingGmail ||
                                              !gmailEmailInput.trim() ||
                                              !gmailPasswordInput.trim() ||
                                              gmailPasswordInput === "••••••••••••••••"
                                            }
                                          >
                                            {isSavingGmail
                                              ? "Saving..."
                                              : gmailSaveFeedback === "saved"
                                                ? "Saved"
                                                : "Save"}
                                          </button>
                                        </div>
                                      </div>
                                    </div>

                                    <div className="auth-help-row">
                                      <svg
                                        className="auth-help-icon"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                      >
                                        <circle cx="12" cy="12" r="10" />
                                        <line x1="12" y1="16" x2="12" y2="12" />
                                        <line x1="12" y1="8" x2="12.01" y2="8" />
                                      </svg>
                                      <span className="auth-help-text">
                                        Requires 2-Step Verification. Generate your App Password in{" "}
                                        <button
                                          type="button"
                                          className="auth-help-link-btn"
                                          onClick={handleOpenAppPasswords}
                                        >
                                          Google Account Security ↗
                                        </button>
                                      </span>
                                    </div>

                                    <div className="auth-field-divider" />

                                    {/* Google Calendar Connector Section */}
                                    <div className="auth-field-header">
                                      <label className="auth-field-label">
                                        Google Calendar Connector
                                      </label>
                                      {calendarOAuthFeedback === "connecting" && (
                                        <span className="auth-status-badge connecting">Opening browser...</span>
                                      )}
                                      {calendarOAuthFeedback === "connected" && (
                                        <span className="auth-status-badge saved">Connected ✓</span>
                                      )}
                                      {calendarOAuthFeedback === "error" && (
                                        <span className="auth-status-badge error">{calendarOAuthError || "Failed to authorize"}</span>
                                      )}
                                      {calendarConnected && calendarOAuthFeedback === "idle" && (
                                        <span className="auth-status-badge connected">Connected ✓</span>
                                      )}
                                    </div>

                                    <p className="auth-field-desc">
                                      Syncs AIDEN with your schedule. View your agenda, check availability, find events, and schedule new meetings directly on Google Calendar.
                                    </p>

                                    <div className="calendar-connector-block">
                                      {/* Option 1: 1-Click Fast Connect */}
                                      {!calendarConnected ? (
                                        <div className="calendar-connect-action-row">
                                          <button
                                            type="button"
                                            className="calendar-connect-btn"
                                            onClick={handleStartCalendarOAuth}
                                            disabled={isStartingOAuth || !hasCalendarClientConfig}
                                          >
                                            <svg className="calendar-btn-icon" viewBox="0 0 24 24" fill="none">
                                              <rect x="3" y="4" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="2" />
                                              <line x1="16" y1="2" x2="16" y2="6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                              <line x1="8" y1="2" x2="8" y2="6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                              <line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" strokeWidth="2" />
                                              <circle cx="8" cy="15" r="1.5" fill="currentColor" />
                                              <circle cx="12" cy="15" r="1.5" fill="currentColor" />
                                              <circle cx="16" cy="15" r="1.5" fill="currentColor" />
                                            </svg>
                                            {isStartingOAuth ? "Waiting for authorization in browser..." : "Connect with Google Calendar"}
                                          </button>
                                          {!hasCalendarClientConfig && (
                                           <p className="auth-field-desc" style={{ color: "#ef4444", marginTop: "6px" }}>
                                             ⚠️ No OAuth client credentials found. Place credentials.json in backend/ or expand Custom Credentials below.
                                           </p>
                                          )}
                                        </div>
                                      ) : (
                                        <div className="calendar-connected-card">
                                          <div className="calendar-connected-info">
                                            <svg className="calendar-btn-icon" viewBox="0 0 24 24" fill="none" style={{ color: "#34d399" }}>
                                              <rect x="3" y="4" width="18" height="18" rx="3" stroke="currentColor" strokeWidth="2" />
                                              <line x1="16" y1="2" x2="16" y2="6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                              <line x1="8" y1="2" x2="8" y2="6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                                              <line x1="3" y1="10" x2="21" y2="10" stroke="currentColor" strokeWidth="2" />
                                              <path d="M9 16l2 2 4-4" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                                            </svg>
                                            <div>
                                              <div className="calendar-account-email">
                                                {calendarEmail || "Google Account Connected"}
                                              </div>
                                              <span className="calendar-source-tag">
                                                {calendarClientSource === "custom" ? "Custom Project" : "Desktop Client"}
                                              </span>
                                            </div>
                                          </div>
                                          <button
                                            type="button"
                                            className="calendar-disconnect-btn"
                                            onClick={handleDisconnectCalendar}
                                          >
                                            Disconnect
                                          </button>
                                        </div>
                                      )}

                                      {/* Option 2: Custom Client Credentials Accordion Toggle */}
                                      <button
                                        type="button"
                                        className="calendar-custom-toggle-btn"
                                        onClick={() => setShowCustomCalendarCreds(!showCustomCalendarCreds)}
                                      >
                                        <span>{showCustomCalendarCreds ? "▾" : "▸"}</span>
                                        <span>Custom Google Cloud Credentials {hasCustomCalendarCreds ? "(Configured)" : "(Optional)"}</span>
                                      </button>

                                      {showCustomCalendarCreds && (
                                        <div className="calendar-custom-panel">
                                          <p className="auth-field-desc">
                                            Bring your own OAuth Desktop Client ID & Secret from Google Cloud Console to run under your private project quota.
                                          </p>

                                          <div className="gmail-input-field">
                                            <label className="auth-sub-label" htmlFor="calendar-custom-client-id">
                                              Client ID
                                            </label>
                                            <input
                                              id="calendar-custom-client-id"
                                              type="text"
                                              className="auth-key-input"
                                              placeholder="...apps.googleusercontent.com"
                                              value={customClientIdInput}
                                              onChange={(e) => {
                                                setCustomClientIdInput(e.target.value);
                                                if (calendarCustomFeedback !== "idle") setCalendarCustomFeedback("idle");
                                              }}
                                              spellCheck={false}
                                            />
                                          </div>

                                          <div className="gmail-input-field">
                                            <label className="auth-sub-label" htmlFor="calendar-custom-client-secret">
                                              Client Secret
                                            </label>
                                            <div className="auth-input-row">
                                              <input
                                                id="calendar-custom-client-secret"
                                                type="password"
                                                className={`auth-key-input ${customClientSecretInput.length > 0 ? "has-dots" : ""}`}
                                                placeholder="GOCSPX-..."
                                                value={customClientSecretInput}
                                                onFocus={() => {
                                                  if (customClientSecretInput === "••••••••••••••••") {
                                                    setCustomClientSecretInput("");
                                                  }
                                                }}
                                                onBlur={() => {
                                                  if (customClientSecretInput.trim() === "" && hasCustomCalendarCreds) {
                                                    setCustomClientSecretInput("••••••••••••••••");
                                                  }
                                                }}
                                                onChange={(e) => {
                                                  setCustomClientSecretInput(e.target.value);
                                                  if (calendarCustomFeedback !== "idle") setCalendarCustomFeedback("idle");
                                                }}
                                                spellCheck={false}
                                                autoComplete="off"
                                              />

                                              <button
                                                type="button"
                                                className={`auth-save-btn ${calendarCustomFeedback === "saved" ? "saved" : ""}`}
                                                onClick={handleSaveCustomCalendarCredentials}
                                                disabled={
                                                  isSavingCalendarCustom ||
                                                  !customClientIdInput.trim() ||
                                                  !customClientSecretInput.trim() ||
                                                  customClientSecretInput === "••••••••••••••••"
                                                }
                                              >
                                                {isSavingCalendarCustom
                                                  ? "Saving..."
                                                  : calendarCustomFeedback === "saved"
                                                    ? "Saved"
                                                    : "Save"}
                                              </button>
                                            </div>
                                            {calendarCustomFeedback === "error" && (
                                              <span className="auth-status-badge error" style={{ alignSelf: "flex-start", marginTop: "4px" }}>
                                                {calendarCustomError || "Failed to save custom credentials"}
                                              </span>
                                            )}
                                          </div>

                                          {hasCustomCalendarCreds && (
                                            <button
                                              type="button"
                                              className="calendar-clear-custom-btn"
                                              onClick={handleDeleteCustomCalendarCredentials}
                                            >
                                              Remove custom credentials and revert to default
                                            </button>
                                          )}
                                        </div>
                                      )}
                                    </div>

                                    <div className="auth-field-divider" />

                                    {/* Spotify Connector Section */}
                                    <div className="auth-field-header">
                                      <label className="auth-field-label">
                                        Spotify Connector
                                      </label>
                                      {spotifyOAuthFeedback === "connecting" && (
                                        <span className="auth-status-badge connecting">Opening browser...</span>
                                      )}
                                      {spotifyOAuthFeedback === "connected" && (
                                        <span className="auth-status-badge saved">Connected ✓</span>
                                      )}
                                      {spotifyOAuthFeedback === "error" && (
                                        <span className="auth-status-badge error">{spotifyOAuthError || "Failed to authorize"}</span>
                                      )}
                                      {spotifyConnected && spotifyOAuthFeedback === "idle" && (
                                        <span className="auth-status-badge connected">Connected ✓</span>
                                      )}
                                    </div>

                                    <p className="auth-field-desc">
                                      Connects AIDEN to your Spotify library to play songs, find playlists, queue albums, and control playback hands-free.
                                    </p>

                                    {/* Spotify Free Limitation Notice Banner */}
                                    <div className="spotify-warning-banner">
                                      <span style={{ fontSize: "16px", flexShrink: 0 }}>⚠️</span>
                                      <div>
                                        <strong>Spotify Free Notice:</strong> Spotify's official Web API limits remote playback control to <strong>Spotify Premium</strong> accounts. Free users may experience playback restrictions or errors when issuing direct play commands. We strongly recommend <strong>Spotify Premium</strong> for seamless hands-free playback.
                                      </div>
                                    </div>

                                    <div className="calendar-connector-block" style={{ marginTop: "12px" }}>
                                      {!spotifyConnected ? (
                                        <div className="calendar-connect-action-row">
                                          <button
                                            type="button"
                                            className="calendar-connect-btn spotify-btn"
                                            onClick={handleStartSpotifyOAuth}
                                            disabled={isStartingSpotifyOAuth || !hasSpotifyClientConfig}
                                          >
                                            <svg className="calendar-btn-icon" viewBox="0 0 24 24" fill="currentColor">
                                              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                                            </svg>
                                            {isStartingSpotifyOAuth ? "Waiting for authorization in browser..." : "Connect with Spotify"}
                                          </button>
                                          {!hasSpotifyClientConfig && (
                                            <p className="auth-field-desc" style={{ color: "#ef4444", marginTop: "6px" }}>
                                              ⚠️ No Spotify Developer credentials found. Configure Custom Credentials below or set SPOTIFY_CLIENT_ID in backend/.env.
                                            </p>
                                          )}
                                        </div>
                                      ) : (
                                        <div className="calendar-connected-card">
                                          <div className="calendar-connected-info">
                                            <svg className="calendar-btn-icon" viewBox="0 0 24 24" fill="currentColor" style={{ color: "#1ed760" }}>
                                              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z" />
                                            </svg>
                                            <div>
                                              <div className="calendar-account-email" style={{ display: "flex", alignItems: "center" }}>
                                                <span>{spotifyDisplayName || spotifyEmail || "Spotify Account Connected"}</span>
                                                {spotifyProduct && (
                                                  <span className={`spotify-product-tag ${spotifyProduct.toLowerCase() === "premium" ? "premium" : "free"}`}>
                                                    {spotifyProduct.toLowerCase() === "premium" ? "Premium" : "Free"}
                                                  </span>
                                                )}
                                              </div>
                                              <span className="calendar-source-tag">
                                                {spotifyClientSource === "custom" ? "Custom Developer App" : "Standard Client"}
                                              </span>
                                            </div>
                                          </div>
                                          <button
                                            type="button"
                                            className="calendar-disconnect-btn"
                                            onClick={handleDisconnectSpotify}
                                          >
                                            Disconnect
                                          </button>
                                        </div>
                                      )}

                                      {/* Custom Spotify Developer Credentials Accordion Toggle */}
                                      <button
                                        type="button"
                                        className="calendar-custom-toggle-btn"
                                        onClick={() => setShowCustomSpotifyCreds(!showCustomSpotifyCreds)}
                                      >
                                        <span>{showCustomSpotifyCreds ? "▾" : "▸"}</span>
                                        <span>Custom Spotify Developer Credentials {hasCustomSpotifyCreds ? "(Configured)" : "(Optional)"}</span>
                                      </button>

                                      {showCustomSpotifyCreds && (
                                        <div className="calendar-custom-panel">
                                          <p className="auth-field-desc">
                                            Bring your own Spotify Developer Client ID & Secret from developer.spotify.com/dashboard to manage under your private developer quota. Ensure Redirect URI includes <code>http://127.0.0.1:8888/callback</code>.
                                          </p>

                                          <div className="gmail-input-field">
                                            <label className="auth-sub-label" htmlFor="spotify-custom-client-id">
                                              Client ID
                                            </label>
                                            <input
                                              id="spotify-custom-client-id"
                                              type="text"
                                              className="auth-key-input"
                                              placeholder="Spotify Client ID"
                                              value={customSpotifyClientIdInput}
                                              onChange={(e) => {
                                                setCustomSpotifyClientIdInput(e.target.value);
                                                if (spotifyCustomFeedback !== "idle") setSpotifyCustomFeedback("idle");
                                              }}
                                              spellCheck={false}
                                            />
                                          </div>

                                          <div className="gmail-input-field">
                                            <label className="auth-sub-label" htmlFor="spotify-custom-client-secret">
                                              Client Secret
                                            </label>
                                            <div className="auth-input-row">
                                              <input
                                                id="spotify-custom-client-secret"
                                                type="password"
                                                className="auth-key-input"
                                                placeholder={hasCustomSpotifyCreds ? "••••••••••••••••" : "Spotify Client Secret"}
                                                value={customSpotifyClientSecretInput}
                                                onFocus={() => {
                                                  if (customSpotifyClientSecretInput === "••••••••••••••••") {
                                                    setCustomSpotifyClientSecretInput("");
                                                  }
                                                }}
                                                onBlur={() => {
                                                  if (customSpotifyClientSecretInput.trim() === "" && hasCustomSpotifyCreds) {
                                                    setCustomSpotifyClientSecretInput("••••••••••••••••");
                                                  }
                                                }}
                                                onChange={(e) => {
                                                  setCustomSpotifyClientSecretInput(e.target.value);
                                                  if (spotifyCustomFeedback !== "idle") setSpotifyCustomFeedback("idle");
                                                }}
                                                spellCheck={false}
                                                autoComplete="off"
                                              />

                                              <button
                                                type="button"
                                                className={`auth-save-btn ${spotifyCustomFeedback === "saved" ? "saved" : ""}`}
                                                onClick={handleSaveCustomSpotifyCredentials}
                                                disabled={
                                                  isSavingSpotifyCustom ||
                                                  !customSpotifyClientIdInput.trim() ||
                                                  !customSpotifyClientSecretInput.trim() ||
                                                  customSpotifyClientSecretInput === "••••••••••••••••"
                                                }
                                              >
                                                {isSavingSpotifyCustom
                                                  ? "Saving..."
                                                  : spotifyCustomFeedback === "saved"
                                                    ? "Saved"
                                                    : "Save"}
                                              </button>
                                            </div>
                                            {spotifyCustomFeedback === "error" && (
                                              <span className="auth-status-badge error" style={{ alignSelf: "flex-start", marginTop: "4px" }}>
                                                {spotifyCustomError || "Failed to save custom credentials"}
                                              </span>
                                            )}
                                          </div>

                                          {hasCustomSpotifyCreds && (
                                            <button
                                              type="button"
                                              className="calendar-clear-custom-btn"
                                              onClick={handleDeleteCustomSpotifyCredentials}
                                            >
                                              Remove custom credentials and revert to default
                                            </button>
                                          )}
                                        </div>
                                      )}
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
