(function () {
  if (window !== window.top) return;

  var HOST_ID = "__aiden_browser_corners_host";
  var SVG_NS = "http://www.w3.org/2000/svg";
  var RADIUS = 12;
  var DARK_FILL = "#111318";
  var LIGHT_FILL = "#f2f4f8";

  function sendHud(payload) {
    try {
      if (window.chrome && window.chrome.webview && typeof window.chrome.webview.postMessage === "function") {
        window.chrome.webview.postMessage(payload);
      }
    } catch (_) {}
  }

  function makeCornerSvg(side, fillColor) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(RADIUS));
    svg.setAttribute("height", String(RADIUS));
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("aria-hidden", "true");
    svg.style.cssText =
      "position:fixed;top:0;" +
      (side === "left" ? "left:0;" : "right:0;") +
      "width:12px;height:12px;display:block;pointer-events:none;z-index:2147483647;";

    var path = document.createElementNS(SVG_NS, "path");
    // Inverted quarter-circle fillet bleeding seamlessly from the 44px top bar into the inner edge
    path.setAttribute(
      "d",
      side === "left"
        ? "M0 0 H12 A12 12 0 0 0 0 12 Z"
        : "M0 0 H12 V12 A12 12 0 0 0 0 0 Z"
    );
    path.setAttribute("fill", fillColor);
    svg.appendChild(path);
    return { svg: svg, path: path };
  }

  function mountCorners() {
    var root = document.documentElement;
    if (!root) return;

    if (window.__aidenBrowserCornersApi && document.getElementById(HOST_ID)) {
      window.__aidenBrowserCornersApi.syncFullscreen();
      return;
    }

    var existing = document.getElementById(HOST_ID);
    if (existing && existing.parentNode) {
      existing.parentNode.removeChild(existing);
    }

    var initialDark =
      typeof window.__aidenBrowserDarkMode === "boolean"
        ? window.__aidenBrowserDarkMode
        : true;
    var fill = initialDark ? DARK_FILL : LIGHT_FILL;

    var host = document.createElement("div");
    host.id = HOST_ID;
    host.style.cssText =
      "position:fixed!important;top:0!important;left:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;";

    var shadow = host.attachShadow({ mode: "closed" });
    var leftCorner = makeCornerSvg("left", fill);
    var rightCorner = makeCornerSvg("right", fill);
    shadow.appendChild(leftCorner.svg);
    shadow.appendChild(rightCorner.svg);
    root.appendChild(host);

    var lastFs = null;
    function syncFullscreen() {
      var isFs = Boolean(document.fullscreenElement || document.webkitFullscreenElement);
      host.style.setProperty("display", isFs ? "none" : "block", "important");
      if (isFs !== lastFs) {
        lastFs = isFs;
        sendHud(isFs ? "__aiden_hud__:fs:1" : "__aiden_hud__:fs:0");
      }
    }

    function setDarkMode(isDark) {
      window.__aidenBrowserDarkMode = Boolean(isDark);
      var nextFill = isDark ? DARK_FILL : LIGHT_FILL;
      leftCorner.path.setAttribute("fill", nextFill);
      rightCorner.path.setAttribute("fill", nextFill);
    }

    window.__aidenBrowserCornersApi = {
      setDarkMode: setDarkMode,
      syncFullscreen: syncFullscreen,
    };

    syncFullscreen();
    document.addEventListener("fullscreenchange", syncFullscreen);
    document.addEventListener("webkitfullscreenchange", syncFullscreen);

    // Keep corner fillets attached across SPA DOM rewrites (e.g. YouTube/Gmail)
    window.setInterval(function () {
      if (!document.getElementById(HOST_ID) && document.documentElement) {
        document.documentElement.appendChild(host);
      }
    }, 900);
  }

  if (document.documentElement) {
    mountCorners();
  }
  document.addEventListener("DOMContentLoaded", mountCorners, { once: true });
})();
