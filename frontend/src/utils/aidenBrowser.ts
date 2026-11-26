import { openUrl } from "@tauri-apps/plugin-opener";

export const AIDEN_BROWSER_OPEN_EVENT = "aiden:open-inbuilt-browser";

export interface AidenBrowserOpenDetail {
  url: string;
}

/**
 * Normalizes a URL for Aiden Browser navigation (adds https:// when missing)
 * and rejects unsafe non-web schemes such as javascript: or data:.
 */
export function normalizeBrowserUrl(rawUrl: string): string {
  const trimmed = (rawUrl || "").trim();
  if (!trimmed) return "";
  const candidate = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "";
    }
    return parsed.toString();
  } catch {
    return "";
  }
}

/**
 * Opens a web URL in Aiden Browser by default inside the chat pill.
 * Hold Shift while clicking (or pass forceExternal=true) to launch the OS browser.
 */
export async function openInAidenBrowser(
  rawUrl: string,
  forceExternal = false
): Promise<void> {
  const cleanUrl = normalizeBrowserUrl(rawUrl);
  if (!cleanUrl) return;

  if (!forceExternal && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent<AidenBrowserOpenDetail>(AIDEN_BROWSER_OPEN_EVENT, {
        detail: { url: cleanUrl },
      })
    );
    return;
  }

  try {
    await openUrl(cleanUrl);
  } catch {
    if (typeof window !== "undefined") {
      window.open(cleanUrl, "_blank", "noopener,noreferrer");
    }
  }
}
