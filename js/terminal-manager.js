const RELAY_URL = "ws://virtual-switch";

class TerminalManager {
  constructor() {
    this.instances = new Map();
    this._availableIds = [1, 2, 3, 4, 5, 6]; // Fix 1: ID pool instead of ever-incrementing _nextId
    this.SOFT_LIMIT = 4;
    this.HARD_LIMIT = 6;
    this._stateReady = false;
    this._savingState = false;
    this._dbName = "shallows";
    this._stateKey = "alpine-boot-state";
    this._switch = new VirtualSwitch();
    this._fileTransfer = null; // set after construction
    this._pendingSockets = new Map(); // id -> FakeWebSocket
    this._installWebSocketProxy();
  }

  setFileTransfer(ft) {
    this._fileTransfer = ft;
  }

  _installWebSocketProxy() {
    const self = this;
    const OrigWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      // Intercept connections to our virtual relay
      if (url && url.startsWith(RELAY_URL)) {
        // Find the pending socket for the VM being created
        for (const [id, socket] of self._pendingSockets) {
          self._pendingSockets.delete(id);
          return socket;
        }
        // Fix 4: return dead stub instead of undefined when no pending socket found
        console.warn("WebSocket proxy: no pending socket for", url);
        const dead = { readyState: 3, send() {}, close() {}, addEventListener() {}, removeEventListener() {} };
        return dead;
      }
      // Everything else uses the real WebSocket
      return new OrigWS(url, protocols);
    };
    // Preserve static properties
    window.WebSocket.CONNECTING = 0;
    window.WebSocket.OPEN = 1;
    window.WebSocket.CLOSING = 2;
    window.WebSocket.CLOSED = 3;
    window.WebSocket.prototype = OrigWS.prototype;
  }

  get count() {
    return this.instances.size;
  }

  canCreate() {
    return this.count < this.HARD_LIMIT;
  }

  isAtSoftLimit() {
    return this.count >= this.SOFT_LIMIT;
  }

  // ── IndexedDB helpers ──

  _openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(this._dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore("states");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async _loadState() {
    try {
      const db = await this._openDB();
      return new Promise((resolve) => {
        const tx = db.transaction("states", "readonly");
        const req = tx.objectStore("states").get(this._stateKey);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
        // Fix 2: close DB connection when transaction finishes
        tx.oncomplete = () => db.close();
        tx.onerror = () => db.close();
      });
    } catch (_) {
      return null;
    }
  }

  async _saveState(state) {
    try {
      const db = await this._openDB();
      return new Promise((resolve, reject) => {
        const tx = db.transaction("states", "readwrite");
        tx.objectStore("states").put(state, this._stateKey);
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => { db.close(); reject(tx.error); };
      });
    } catch (err) { console.warn("Failed to save boot state:", err); } // Fix 6: log error instead of swallowing
  }

  // ── Keyboard helpers ──

  _sendText(emulator, text, delay) {
    return new Promise((resolve) => {
      setTimeout(() => {
        emulator.keyboard_send_text(text);
        resolve();
      }, delay);
    });
  }

  // Fix 8: helper that polls screen text for a marker string with a timeout
  _waitForPrompt(emulator, marker, timeoutMs = 15000) {
    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const poll = setInterval(() => {
        try {
          const text = emulator.screen_make_text();
          if (text && text.includes(marker)) {
            clearInterval(poll);
            resolve();
            return;
          }
        } catch (_) {}
        if (Date.now() >= deadline) {
          clearInterval(poll);
          resolve(); // resolve anyway so callers aren't blocked forever
        }
      }, 300);
    });
  }

  async _autoLoginAndConfigure(emulator, id) {
    // Generate a unique MAC address per VM: 00:22:15:XX:XX:id
    const mac = `00:22:15:00:00:${id.toString(16).padStart(2, "0")}`;

    // Fix 8: wait for login prompt before sending credentials
    await this._waitForPrompt(emulator, "login:");
    // Login as root
    await this._sendText(emulator, "root\n", 800);
    // Fix 8: wait for shell prompt before sending network commands
    await this._waitForPrompt(emulator, "#");
    // Set unique MAC + IP
    await this._sendText(emulator, "ip link set eth0 down\n", 2000);
    await this._sendText(emulator, `ip link set eth0 address ${mac}\n`, 500);
    await this._sendText(emulator, "ip link set eth0 up\n", 500);
    await this._sendText(emulator, "ip addr flush dev eth0\n", 500);
    await this._sendText(emulator, `ip addr add 10.0.0.${id}/24 dev eth0\n`, 500);
    // Install file transfer scripts
    await this._sendText(emulator, "cat > /usr/local/bin/sendfile << 'SCRIPT'\n", 500);
    await this._sendText(emulator, '#!/bin/sh\n', 200);
    await this._sendText(emulator, '[ -f "$1" ] || { echo "Usage: sendfile <file>"; exit 1; }\n', 200);
    await this._sendText(emulator, 'fname=$(basename "$1")\n', 200);
    await this._sendText(emulator, 'echo "===SHALLOWS_FILE_META===${fname}===" > /dev/ttyS0\n', 200);
    await this._sendText(emulator, 'echo "===SHALLOWS_FILE_START===" > /dev/ttyS0\n', 200);
    await this._sendText(emulator, 'base64 "$1" > /dev/ttyS0\n', 200);
    await this._sendText(emulator, 'echo "===SHALLOWS_FILE_END===" > /dev/ttyS0\n', 200);
    await this._sendText(emulator, 'echo "Sent: $fname"\n', 200);
    await this._sendText(emulator, "SCRIPT\n", 200);
    await this._sendText(emulator, "chmod +x /usr/local/bin/sendfile\n", 300);
    // Free up serial port for file transfers (kill any getty on ttyS0)
    await this._sendText(emulator, "pkill -f 'getty.*ttyS0' 2>/dev/null; stty -F /dev/ttyS0 raw -echo 2>/dev/null\n", 500);
    await this._sendText(emulator, "clear\n", 500);
  }

  // ── VM lifecycle ──

  async create(container) {
    if (!this.canCreate()) {
      return null;
    }

    // Fix 1: use ID pool instead of ever-incrementing counter
    const id = this._availableIds.shift();
    if (id === undefined) return null;

    // Build screen container for v86
    const screenContainer = document.createElement("div");
    screenContainer.className = "terminal__screen";
    container.appendChild(screenContainer);

    // Build loading overlay
    const loading = document.createElement("div");
    loading.className = "terminal__loading";
    loading.innerHTML = `
      <div class="spinner"></div>
      <div class="terminal__loading-text">Starting VM...</div>
      <div class="terminal__progress">
        <div class="terminal__progress-bar"></div>
      </div>
    `;
    container.appendChild(loading);

    const progressBar = loading.querySelector(".terminal__progress-bar");
    const loadingText = loading.querySelector(".terminal__loading-text");

    // Check for cached boot state
    const cachedState = await this._loadState();
    const useCache = !!cachedState;

    if (useCache) {
      loadingText.textContent = "Restoring snapshot...";
      progressBar.style.width = "100%";
    }

    // Register a pending socket for v86's async NetworkAdapter creation
    this._pendingSockets.set(id, this._switch.createSocket(id));

    // Build v86 config
    const config = {
      wasm_path: "js/v86.wasm",
      bios: { url: "assets/bios/seabios.bin" },
      vga_bios: { url: "assets/bios/vgabios.bin" },
      cdrom: { url: "assets/images/alpine-virt-3.20.3-x86.iso" },
      memory_size: 128 * 1024 * 1024,
      vga_memory_size: 8 * 1024 * 1024,
      autostart: true,
      screen_container: screenContainer,
      disable_mouse: true,
      disable_speaker: true,
      network_relay_url: "ws://virtual-switch",
    };

    if (useCache) {
      config.initial_state = { buffer: cachedState };
    }

    const emulator = new V86(config);

    // Simple indeterminate progress — just a label and animated bar
    let bootInterval = null;
    let currentPct = 0;

    // Fix 5: setProgress accepts an optional label parameter
    const setProgress = (pct, label) => {
      currentPct = Math.max(currentPct, pct);
      progressBar.style.width = currentPct + "%";
      if (label !== undefined) loadingText.textContent = label;
    };

    if (useCache) {
      loadingText.textContent = "Restoring snapshot...";
      setProgress(30);
      bootInterval = setInterval(() => {
        if (currentPct < 95) setProgress(currentPct + 5);
        else clearInterval(bootInterval);
      }, 200);
    } else {
      loadingText.textContent = "Starting VM...";
      // Slow steady animation over ~50s
      bootInterval = setInterval(() => {
        if (currentPct < 95) setProgress(currentPct + 1);
        else clearInterval(bootInterval);
      }, 600);
    }

    // Boot detection + state caching + auto-config
    let bootDetected = false;
    const onBootComplete = () => {
      if (bootDetected) return;
      bootDetected = true;
      clearInterval(bootPoll);
      clearTimeout(bootTimeout);
      if (bootInterval) clearInterval(bootInterval);
      setProgress(100, "Ready"); // Fix 5: second arg now sets the label
      // Fix 7: free serial buffer memory after boot
      emulator._serialBuf = "";
      // Brief pause to show 100% before hiding
      setTimeout(() => loading.classList.add("terminal__loading--hidden"), 300);

      // Auto-login and configure networking
      this._autoLoginAndConfigure(emulator, id).catch((err) => {
        console.warn(`Auto-configure failed for VM ${id}:`, err);
      });

      // Save state for future fast boots (only once, from first cold boot)
      if (!useCache && !this._stateReady && !this._savingState) {
        this._savingState = true;
        setTimeout(async () => {
          try {
            // v86 save_state returns a Promise in newer versions
            const result = emulator.save_state();
            let state;
            if (result && typeof result.then === "function") {
              state = await result;
            } else {
              state = result;
            }
            if (state) {
              await this._saveState(state);
              this._stateReady = true;
              showNotification("Boot snapshot cached — future terminals will load faster.", "success");
            }
          } catch (err) {
            console.warn("Failed to save VM state:", err);
          }
          this._savingState = false;
        }, 5000);
      }
    };

    if (useCache) {
      // For state restore, try emulator-ready event + a short timeout fallback
      emulator.add_listener("emulator-ready", () => {
        // Small delay to let screen render after state restore
        setTimeout(() => onBootComplete(), 1000);
      });
      // Fallback if emulator-ready doesn't fire for state restore
      setTimeout(() => onBootComplete(), 5000);
    }

    // Serial output listener for boot detection (cold boot)
    emulator.add_listener("serial0-output-byte", (byte) => {
      if (bootDetected) return;
      if (!emulator._serialBuf) emulator._serialBuf = "";
      emulator._serialBuf += String.fromCharCode(byte);
      if (emulator._serialBuf.length > 2000) {
        emulator._serialBuf = emulator._serialBuf.slice(-1000);
      }
      if (emulator._serialBuf.includes("login:")) {
        onBootComplete();
      }
    });

    // Screen text poll as fallback
    const bootPoll = setInterval(() => {
      if (bootDetected) { clearInterval(bootPoll); return; }
      try {
        const text = emulator.screen_make_text();
        if (text && text.includes("login:")) {
          onBootComplete();
        }
      } catch (_) {}
    }, 2000);

    // Fallback: hide overlay after 60s regardless
    const bootTimeout = setTimeout(() => {
      clearInterval(bootPoll);
      loading.classList.add("terminal__loading--hidden");
    }, 60000);

    // Fix 3: store bootInterval in the instance record for cleanup
    this.instances.set(id, {
      emulator,
      container,
      screenContainer,
      loading,
      bootPoll,
      bootTimeout,
      bootInterval,
    });

    // Start listening for file downloads from this VM
    if (this._fileTransfer) {
      this._fileTransfer.startListening(id);
    }

    return id;
  }

  // ── Clipboard helpers ──

  getActiveEmulator(id) {
    const instance = this.instances.get(id);
    return instance ? instance.emulator : null;
  }

  async copyScreen(id) {
    const emulator = this.getActiveEmulator(id);
    if (!emulator) return null;
    const text = emulator.screen_make_text();
    if (text) {
      await navigator.clipboard.writeText(text);
    }
    return text;
  }

  pasteText(id, text) {
    const emulator = this.getActiveEmulator(id);
    if (!emulator) return;
    emulator.keyboard_send_text(text);
  }

  focus(id) {
    for (const [vmId, instance] of this.instances) {
      try {
        instance.emulator.keyboard_set_status(vmId === id);
      } catch (_) {}
    }
  }

  destroy(id) {
    const instance = this.instances.get(id);
    if (!instance) return;

    clearInterval(instance.bootPoll);
    clearTimeout(instance.bootTimeout);
    // Fix 3: clear bootInterval stored in instance record
    clearInterval(instance.bootInterval);
    this._switch.disconnect(id);

    if (this._fileTransfer) {
      this._fileTransfer.stopListening(id);
    }

    try {
      instance.emulator.stop();
      instance.emulator.destroy();
    } catch (_) {}

    instance.container.remove();
    this.instances.delete(id);

    // Fix 1: return id to the pool and keep it sorted
    this._availableIds.push(id);
    this._availableIds.sort((a, b) => a - b);
  }

  destroyAll() {
    for (const id of [...this.instances.keys()]) {
      this.destroy(id);
    }
  }
}
