// ── Notification system ──
function showNotification(message, type = "info") {
  const container = document.getElementById("toast-container");
  if (!container) return;
  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.3s ease";
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

// ── Feature detection ──
function checkCompatibility() {
  const issues = [];

  if (typeof WebAssembly === "undefined") {
    issues.push("WebAssembly is not supported or is disabled by your browser/network policy. This is required for the x86 emulator.");
  }

  if (typeof SharedArrayBuffer === "undefined") {
    // Not fatal, but v86 runs faster with it
    showNotification("SharedArrayBuffer unavailable — terminals will work but may be slower.", "warning");
  }

  if (issues.length > 0) {
    const viewport = document.getElementById("viewport");

    const wrapper = document.createElement("div");
    wrapper.className = "empty-state";

    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("class", "empty-state__icon");
    svg.setAttribute("style", "color:var(--danger)");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.5");
    svg.setAttribute("aria-hidden", "true");
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "12");
    circle.setAttribute("cy", "12");
    circle.setAttribute("r", "10");
    const line1 = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line1.setAttribute("x1", "15"); line1.setAttribute("y1", "9");
    line1.setAttribute("x2", "9");  line1.setAttribute("y2", "15");
    const line2 = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line2.setAttribute("x1", "9");  line2.setAttribute("y1", "9");
    line2.setAttribute("x2", "15"); line2.setAttribute("y2", "15");
    svg.appendChild(circle);
    svg.appendChild(line1);
    svg.appendChild(line2);

    const title = document.createElement("h2");
    title.className = "empty-state__title";
    title.style.color = "var(--danger)";
    title.textContent = "Incompatible Browser";

    const desc = document.createElement("p");
    desc.className = "empty-state__desc";
    desc.textContent = issues.join(" ");

    const hint = document.createElement("p");
    hint.className = "empty-state__desc";
    hint.style.fontSize = "11px";
    hint.textContent = "If you're on a managed device, ask IT to allow WebAssembly. Test compatibility at ";
    const link = document.createElement("a");
    link.href = "https://copy.sh/v86/";
    link.textContent = "copy.sh/v86";
    hint.appendChild(link);

    wrapper.appendChild(svg);
    wrapper.appendChild(title);
    wrapper.appendChild(desc);
    wrapper.appendChild(hint);

    viewport.innerHTML = "";
    viewport.appendChild(wrapper);

    document.getElementById("btn-new").disabled = true;
    return false;
  }

  return true;
}

// ── Service worker registration ──
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").then(() => {
      // After first install, reload to activate COOP/COEP headers
      if (!navigator.serviceWorker.controller) {
        navigator.serviceWorker.ready.then(() => {
          window.location.reload();
        });
      }
    }).catch(() => {
      // Service workers may be blocked — not fatal
    });
  }
}

// ── Initialize ──
document.addEventListener("DOMContentLoaded", () => {
  registerServiceWorker();

  if (!checkCompatibility()) return;

  const terminalManager = new TerminalManager();
  const uiManager = new UIManager(terminalManager);

  // Initialize file transfer
  const fileTransfer = new FileTransfer(terminalManager);
  terminalManager.setFileTransfer(fileTransfer);

  // ── Copy/paste helpers ──
  function doCopy(id) {
    if (!id) return;
    terminalManager.copyScreen(id).then((text) => {
      if (text) showNotification("Screen text copied", "success");
    }).catch(() => {
      showNotification("Clipboard write failed — check browser permissions.", "warning");
    });
  }

  function doPaste(id) {
    if (!id) return;
    navigator.clipboard.readText().then((text) => {
      if (text) terminalManager.pasteText(id, text);
    }).catch(() => {
      showNotification("Clipboard read failed — check browser permissions.", "warning");
    });
  }

  // Wire toolbar buttons
  document.getElementById("btn-new").addEventListener("click", () => {
    uiManager.addTab();
  });

  const emptyBtn = document.getElementById("btn-new-empty");
  if (emptyBtn) {
    emptyBtn.addEventListener("click", () => uiManager.addTab());
  }

  document.getElementById("btn-layout").addEventListener("click", () => {
    uiManager.toggleLayout();
  });

  document.getElementById("btn-copy").addEventListener("click", () => {
    doCopy(uiManager.activeId);
  });

  document.getElementById("btn-paste").addEventListener("click", () => {
    doPaste(uiManager.activeId);
  });

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (e.ctrlKey && e.shiftKey) {
      if (e.key === "C") {
        e.preventDefault();
        doCopy(uiManager.activeId);
      } else if (e.key === "V") {
        e.preventDefault();
        doPaste(uiManager.activeId);
      }
    }
  });

  // Warn before leaving with running terminals
  window.addEventListener("beforeunload", (e) => {
    if (terminalManager.count > 0) {
      e.preventDefault();
      e.returnValue = "";
    }
  });
});
