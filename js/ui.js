class UIManager {
  constructor(terminalManager) {
    this.tm = terminalManager;
    this.tabBar = document.getElementById("tab-bar");
    this.viewport = document.getElementById("viewport");
    this.counter = document.getElementById("instance-counter");
    this.layoutBtn = document.getElementById("btn-layout");
    this.emptyState = this.viewport.querySelector(".empty-state");

    this.tabs = new Map();
    this.activeId = null;
    this.gridMode = false;
    this._creating = false;
  }

  async addTab() {
    if (this._creating) return;

    if (!this.tm.canCreate()) {
      showNotification("Terminal limit reached.", "error");
      return;
    }

    if (this.tm.isAtSoftLimit()) {
      showNotification(
        `${this.tm.count} terminals active. Performance may degrade.`,
        "warning"
      );
    }

    this._creating = true;
    try {
      const id = await this._createTerminal();
      if (id === null) {
        this._showEmptyIfNeeded();
        return;
      }

      // Hide empty state only after successful creation
      if (this.emptyState) {
        this.emptyState.style.display = "none";
      }

      this._createTabElement(id);
      this.switchTab(id);
      this._updateCounter();
    } finally {
      this._creating = false;
    }
  }

  removeTab(id) {
    const entry = this.tabs.get(id);
    if (!entry) return;

    const keys = [...this.tabs.keys()];
    const closedIndex = keys.indexOf(id);

    entry.tab.remove();
    this.tm.destroy(id);
    this.tabs.delete(id);

    if (this.activeId === id) {
      const remaining = [...this.tabs.keys()];
      if (remaining.length > 0) {
        const preferred = remaining[Math.min(closedIndex, remaining.length - 1)] ?? remaining[0];
        this.switchTab(preferred);
      } else {
        this.activeId = null;
      }
    }

    this._updateCounter();
    this._showEmptyIfNeeded();
  }

  switchTab(id) {
    if (!this.tabs.has(id)) return;
    this.tm.focus(id);
    if (this.activeId === id) return;

    this.activeId = id;

    for (const [tid, entry] of this.tabs) {
      entry.tab.classList.toggle("tab--active", tid === id);
      entry.tab.setAttribute("aria-selected", String(tid === id));
    }

    if (!this.gridMode) {
      for (const [tid, entry] of this.tabs) {
        entry.container.classList.toggle("terminal--hidden", tid !== id);
      }
    }
  }

  toggleLayout() {
    this.gridMode = !this.gridMode;

    this.viewport.classList.toggle("viewport--grid", this.gridMode);

    // Update button text and icon
    if (this.gridMode) {
      this.layoutBtn.innerHTML = `
        <svg id="layout-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
        Tabs`;
      this.layoutBtn.setAttribute("aria-label", "Switch to tab view");
      for (const entry of this.tabs.values()) {
        entry.container.classList.remove("terminal--hidden");
      }
    } else {
      this.layoutBtn.innerHTML = `
        <svg id="layout-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
        Grid`;
      this.layoutBtn.setAttribute("aria-label", "Switch to grid view");
      for (const [tid, entry] of this.tabs) {
        entry.container.classList.toggle("terminal--hidden", tid !== this.activeId);
      }
    }
  }

  async _createTerminal() {
    const container = document.createElement("div");
    container.className = "terminal";

    const label = document.createElement("div");
    label.className = "terminal__label";
    container.appendChild(label);

    const id = await this.tm.create(container);
    if (id === null) {
      return null;
    }

    this.viewport.appendChild(container);

    label.textContent = `Terminal ${id}`;

    container.addEventListener("click", () => {
      this.switchTab(id);
    });

    // Drag-and-drop file upload
    container.addEventListener("dragover", (e) => {
      e.preventDefault();
      container.classList.add("terminal--dragover");
    });
    container.addEventListener("dragleave", () => {
      container.classList.remove("terminal--dragover");
    });
    container.addEventListener("drop", (e) => {
      e.preventDefault();
      container.classList.remove("terminal--dragover");
      if (e.dataTransfer.files.length > 0 && this.tm._fileTransfer) {
        const file = e.dataTransfer.files[0];
        this.tm._fileTransfer.upload(id, file);
      }
    });

    this.tabs.set(id, { tab: null, container });
    return id;
  }

  _createTabElement(id) {
    const tab = document.createElement("div");
    tab.className = "tab";
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", "false");

    const name = document.createElement("span");
    name.className = "tab__name";
    name.textContent = `Terminal ${id}`;

    const closeBtn = document.createElement("button");
    closeBtn.className = "tab__close";
    closeBtn.title = "Close";
    closeBtn.setAttribute("aria-label", "Close tab");
    closeBtn.textContent = "\u00d7";

    tab.appendChild(name);
    tab.appendChild(closeBtn);

    tab.addEventListener("click", (e) => {
      if (!e.target.classList.contains("tab__close")) {
        this.switchTab(id);
      }
    });

    closeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.removeTab(id);
    });

    this.tabBar.appendChild(tab);

    const entry = this.tabs.get(id);
    if (entry) entry.tab = tab;
  }

  _updateCounter() {
    this.counter.textContent = `${this.tm.count} / ${this.tm.HARD_LIMIT}`;
  }

  _showEmptyIfNeeded() {
    if (this.emptyState && this.tabs.size === 0) {
      this.emptyState.style.display = "flex";
    }
  }
}
