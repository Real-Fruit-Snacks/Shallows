class FileTransfer {
  constructor(terminalManager) {
    this.tm = terminalManager;
    this.START_MARKER = "===SHALLOWS_FILE_START===";
    this.END_MARKER = "===SHALLOWS_FILE_END===";
    this.META_MARKER = "===SHALLOWS_FILE_META===";
  }

  // Upload: browser -> VM via serial
  async upload(vmId, file) {
    const instance = this.tm.instances.get(vmId);
    if (!instance) {
      showNotification("No VM instance found for upload", "error");
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      showNotification("File too large: maximum upload size is 2 MB", "error");
      return;
    }

    const emulator = instance.emulator;

    showNotification(`Uploading ${file.name}...`, "info");

    // Sanitize filename: strip path separators, protocol-breaking sequences, control chars
    let safeName = file.name.replace(/={3,}/g, "_");
    safeName = safeName.replace(/[\/\\]/g, "_").replace(/^\.+/, "").replace(/[\x00-\x1f]/g, "");
    safeName = safeName.replace(/['"` $(){};&|<>!#]/g, "_"); // shell-safe
    safeName = safeName || "upload";

    // Read file as ArrayBuffer then base64 encode using chunked processing
    const buffer = await file.arrayBuffer();
    const bytes = new Uint8Array(buffer);
    const chunkSize = 8192;
    let binary = "";
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    const b64 = btoa(binary);

    // Calculate exact byte count that will be sent via serial (data + newlines)
    const LINE_LEN = 76;
    const numLines = Math.ceil(b64.length / LINE_LEN);
    const totalBytes = b64.length + numLines; // each line gets a \n

    // Type a one-shot receive command into the terminal, then send data via serial.
    // head -c reads exactly totalBytes from ttyS0, base64 -d decodes, writes to /tmp/
    emulator.keyboard_send_text(
      `head -c ${totalBytes} /dev/ttyS0 | base64 -d > /tmp/${safeName} && echo "Received: /tmp/${safeName}"\n`
    );

    // Wait for the command to start reading from serial
    await new Promise((r) => setTimeout(r, 800));

    // Send base64 data in 76-char lines via serial port
    for (let i = 0; i < b64.length; i += LINE_LEN) {
      emulator.serial0_send(b64.slice(i, i + LINE_LEN) + "\n");
    }

    showNotification(`Uploaded ${file.name} to /tmp/${safeName} (${(file.size / 1024).toFixed(1)} KB)`, "success");
  }

  // Download: VM -> browser - hook into serial output for a given vmId
  startListening(vmId) {
    const instance = this.tm.instances.get(vmId);
    if (!instance) return;
    const emulator = instance.emulator;

    // Per-VM line buffer
    let lineBuffer = "";
    const state = { inTransfer: false, filename: "", dataLines: [] };

    emulator.add_listener("serial0-output-byte", (byte) => {
      const ch = String.fromCharCode(byte);
      if (ch === "\n") {
        const line = lineBuffer;
        lineBuffer = "";
        this._handleSerialLine(vmId, line, state);
      } else {
        lineBuffer += ch;
      }
    });
  }

  stopListening(vmId) {
    // Listener cleanup handled by emulator.destroy()
    // Clear any in-progress transfer state
  }

  _handleSerialLine(vmId, line, state) {
    if (line.startsWith(this.META_MARKER)) {
      // Extract filename from ===SHALLOWS_FILE_META===filename===
      let raw = line
        .slice(this.META_MARKER.length)
        .replace(/===$/, "");
      // Sanitize: strip path separators, leading dots, and control characters
      raw = raw.replace(/[\/\\]/g, "_");
      raw = raw.replace(/^\.+/, "");
      raw = raw.replace(/[\x00-\x1f]/g, "");
      state.filename = raw || "download";
      state.dataLines = [];
    } else if (line === this.START_MARKER) {
      state.inTransfer = true;
      state.dataLines = [];
    } else if (line === this.END_MARKER) {
      if (state.inTransfer && state.filename) {
        this._triggerDownload(state.filename, state.dataLines.join(""));
        showNotification(`Downloaded ${state.filename}`, "success");
      }
      state.inTransfer = false;
      state.filename = "";
      state.dataLines = [];
    } else if (state.inTransfer) {
      state.dataLines.push(line);
    }
  }

  _triggerDownload(filename, b64data) {
    let binary;
    try {
      binary = atob(b64data);
    } catch (e) {
      showNotification("File download failed: corrupted data for " + filename, "error");
      return;
    }
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes]);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }
}
