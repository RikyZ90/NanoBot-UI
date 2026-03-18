// ─── Settings Panel ─────────────────────────────────────────────
// Manages the config.json settings UI with tabbed interface,
// toggle switches, and dynamic form rendering.

const SettingsPanel = (() => {
  let config = null;
  let originalConfig = null;
  let activeTab = "agent";
  let isOpen = false;

  // Tab definitions with emoji icons and config path mappings
  const TABS = [
    { id: "agent",    icon: "🤖", label: "Agent",    path: "agents.defaults" },
    { id: "provider", icon: "🔌", label: "Provider",  path: "providers" },
    { id: "tools",    icon: "🛠️", label: "Tools",     path: "tools" },
    { id: "gateway",  icon: "🌐", label: "Gateway",   path: "gateway" },
    { id: "channels", icon: "📡", label: "Channels",  path: "channels" },
  ];

  // Fields that should use password input
  const SECRET_KEYS = ["apiKey", "token", "secret", "password", "appSecret", "encryptKey", "verificationToken", "botToken", "appToken", "accessToken", "clawToken", "bridgeToken", "imapPassword", "smtpPassword"];

  // Human-readable labels
  const LABELS = {
    workspace: "Workspace",
    model: "Model",
    provider: "Provider",
    maxTokens: "Max Tokens",
    temperature: "Temperature",
    maxToolIterations: "Max Tool Iterations",
    memoryWindow: "Memory Window",
    reasoningEffort: "Reasoning Effort",
    apiKey: "API Key",
    apiBase: "API Base URL",
    extraHeaders: "Extra Headers",
    host: "Host",
    port: "Port",
    enabled: "Enabled",
    intervalS: "Interval (seconds)",
    heartbeat: "Heartbeat",
    proxy: "Proxy",
    search: "Web Search",
    maxResults: "Max Results",
    exec: "Execution",
    timeout: "Timeout (seconds)",
    pathAppend: "Additional Path",
    restrictToWorkspace: "Restrict to Workspace",
    mcpServers: "MCP Servers",
    sendProgress: "Send Progress",
    sendToolHints: "Send Tool Hints",
    allowFrom: "Allow From",
    replyToMessage: "Reply to Message",
    groupPolicy: "Group Policy",
    intents: "Intents",
    gatewayUrl: "Gateway URL",
    appId: "App ID",
    appSecret: "App Secret",
    webhookPath: "Webhook Path",
    replyInThread: "Reply in Thread",
    reactEmoji: "Reaction Emoji",
    userTokenReadOnly: "Read Only User Token",
    mode: "Mode",
    baseUrl: "Base URL",
    socketUrl: "Socket URL",
    socketPath: "Socket Path",
    consentGranted: "Consent Granted",
    imapHost: "IMAP Host",
    imapPort: "IMAP Port",
    imapUsername: "IMAP Username",
    imapPassword: "IMAP Password",
    imapMailbox: "IMAP Mailbox",
    imapUseSsl: "IMAP SSL",
    smtpHost: "SMTP Host",
    smtpPort: "SMTP Port",
    smtpUsername: "SMTP Username",
    smtpPassword: "SMTP Password",
    smtpUseTls: "SMTP TLS",
    smtpUseSsl: "SMTP SSL",
    fromAddress: "From Address",
    autoReplyEnabled: "Auto Reply",
    pollIntervalSeconds: "Polling Interval (s)",
    markSeen: "Mark as Seen",
    maxBodyChars: "Max Body Chars",
    subjectPrefix: "Subject Prefix",
    homeserver: "Homeserver",
    deviceId: "Device ID",
    userId: "User ID",
    e2EeEnabled: "E2E Encryption",
    clientId: "Client ID",
    clientSecret: "Client Secret",
  };

  function getLabel(key) {
    return LABELS[key] || key.replace(/([A-Z])/g, " $1").replace(/^./, s => s.toUpperCase());
  }

  function isSecretField(key) {
    return SECRET_KEYS.some(sk => key.toLowerCase().includes(sk.toLowerCase()));
  }

  // ─── Deep get/set by dot path ──────────────────────

  function getByPath(obj, path) {
    return path.split(".").reduce((o, k) => (o && o[k] !== undefined ? o[k] : undefined), obj);
  }

  function setByPath(obj, path, value) {
    const keys = path.split(".");
    let current = obj;
    for (let i = 0; i < keys.length - 1; i++) {
      if (current[keys[i]] === undefined) current[keys[i]] = {};
      current = current[keys[i]];
    }
    current[keys[keys.length - 1]] = value;
  }

  // ─── API ───────────────────────────────────────────

  async function loadConfig() {
    try {
      const res = await fetch("/api/v1/config");
      const data = await res.json();
      if (data.ok) {
        config = data.config;
        originalConfig = JSON.parse(JSON.stringify(config));
        return true;
      } else {
        showToast("Error loading config: " + data.error, "error");
        return false;
      }
    } catch (e) {
      showToast("Unable to load configuration", "error");
      return false;
    }
  }

  async function saveConfig() {
    try {
      const res = await fetch("/api/v1/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ config }),
      });
      const data = await res.json();
      if (data.ok) {
        originalConfig = JSON.parse(JSON.stringify(config));
        showToast("Configuration saved successfully! ✅", "success");
      } else {
        showToast("Error saving: " + data.error, "error");
      }
    } catch (e) {
      showToast("Network error while saving", "error");
    }
  }

  // ─── UI Rendering ─────────────────────────────────

  function open() {
    const panel = document.getElementById("settings-overlay");
    if (!panel) return;
    
    loadConfig().then(ok => {
      if (ok) {
        isOpen = true;
        panel.classList.add("visible");
        renderTabs();
        renderActiveSection();
      }
    });
  }

  function close() {
    const panel = document.getElementById("settings-overlay");
    if (!panel) return;
    
    // Check for unsaved changes
    if (JSON.stringify(config) !== JSON.stringify(originalConfig)) {
      if (!confirm("Hai modifiche non salvate. Vuoi chiudere senza salvare?")) return;
    }
    
    isOpen = false;
    panel.classList.remove("visible");
  }

  function renderTabs() {
    const tabBar = document.getElementById("settings-tabs");
    if (!tabBar) return;
    
    tabBar.innerHTML = TABS.map(tab => `
      <button class="settings-tab ${tab.id === activeTab ? 'active' : ''}" 
              data-tab="${tab.id}" onclick="SettingsPanel.switchTab('${tab.id}')">
        <span class="tab-icon">${tab.icon}</span>
        <span class="tab-label">${tab.label}</span>
      </button>
    `).join("");
  }

  function switchTab(tabId) {
    activeTab = tabId;
    renderTabs();
    renderActiveSection();
  }

  function renderActiveSection() {
    const container = document.getElementById("settings-content");
    if (!container || !config) return;
    
    const tab = TABS.find(t => t.id === activeTab);
    if (!tab) return;
    
    const sectionData = getByPath(config, tab.path);
    if (sectionData === undefined) {
      container.innerHTML = '<div class="settings-empty">Section not found in configuration</div>';
      return;
    }
    
    container.innerHTML = "";
    
    if (tab.id === "provider") {
      // Provider tab: each provider is a collapsible sub-section
      renderProviders(container, sectionData, tab.path);
    } else if (tab.id === "channels") {
      // Channels: top-level booleans + sub-sections per channel
      renderChannels(container, sectionData, tab.path);
    } else {
      // Generic: render all fields flat or with sub-sections
      renderFields(container, sectionData, tab.path);
    }
    
    // Smooth scroll to top
    container.scrollTop = 0;
  }

  function renderProviders(container, providers, basePath) {
    for (const [name, providerConf] of Object.entries(providers)) {
      const section = createSection(name, getLabel(name));
      const hasKey = providerConf.apiKey && providerConf.apiKey.length > 0;
      section.querySelector(".section-header").innerHTML += 
        hasKey ? ' <span class="badge active">Active</span>' : ' <span class="badge inactive">Not configured</span>';
      
      renderFields(section.querySelector(".section-body"), providerConf, `${basePath}.${name}`);
      container.appendChild(section);
    }
  }

  function renderChannels(container, channels, basePath) {
    // Top-level channel settings
    for (const [key, value] of Object.entries(channels)) {
      if (typeof value !== "object") {
        const field = createField(key, value, `${basePath}.${key}`);
        container.appendChild(field);
      }
    }
    
    // Each channel as a collapsible section
    for (const [name, channelConf] of Object.entries(channels)) {
      if (typeof channelConf !== "object") continue;
      
      const section = createSection(name, getLabel(name));
      const isEnabled = channelConf.enabled === true;
      section.querySelector(".section-header").innerHTML += 
        isEnabled ? ' <span class="badge active">Active</span>' : ' <span class="badge inactive">Disabled</span>';
      
      renderFields(section.querySelector(".section-body"), channelConf, `${basePath}.${name}`);
      container.appendChild(section);
    }
  }

  function renderFields(container, obj, basePath) {
    if (!obj || typeof obj !== "object") return;
    
    for (const [key, value] of Object.entries(obj)) {
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        // Nested object → sub-section
        const section = createSection(key, getLabel(key));
        renderFields(section.querySelector(".section-body"), value, `${basePath}.${key}`);
        container.appendChild(section);
      } else {
        const field = createField(key, value, `${basePath}.${key}`);
        container.appendChild(field);
      }
    }
  }

  function createSection(id, title) {
    const div = document.createElement("div");
    div.className = "settings-section collapsed";
    div.innerHTML = `
      <div class="section-header" onclick="this.parentElement.classList.toggle('collapsed')">
        <span class="section-arrow">▶</span>
        <span class="section-title">${title}</span>
      </div>
      <div class="section-body"></div>
    `;
    return div;
  }

  function createField(key, value, configPath) {
    const wrapper = document.createElement("div");
    wrapper.className = "field";
    
    const label = document.createElement("div");
    label.className = "field-label";
    label.innerHTML = `<span class="field-title">${getLabel(key)}</span>`;
    
    const control = document.createElement("div");
    control.className = "field-control";
    
    if (typeof value === "boolean") {
      // Toggle switch
      const toggleId = `toggle-${configPath.replace(/\./g, "-")}`;
      control.innerHTML = `
        <label class="toggle" for="${toggleId}">
          <input type="checkbox" id="${toggleId}" ${value ? "checked" : ""}
                 onchange="SettingsPanel.updateValue('${configPath}', this.checked)">
          <span class="toggler"></span>
        </label>
      `;
    } else if (typeof value === "number") {
      control.innerHTML = `
        <input type="number" value="${value}" step="any"
               onchange="SettingsPanel.updateValue('${configPath}', parseFloat(this.value) || 0)">
      `;
    } else if (Array.isArray(value)) {
      // Array of strings → textarea
      control.innerHTML = `
        <textarea rows="3" placeholder="One value per line"
                  onchange="SettingsPanel.updateValue('${configPath}', this.value.split('\\n').filter(v => v.trim()))"
        >${value.join("\n")}</textarea>
      `;
    } else if (value === null) {
      control.innerHTML = `
        <input type="text" value="" placeholder="null (not set)"
               onchange="SettingsPanel.updateValue('${configPath}', this.value || null)">
      `;
    } else if (isSecretField(key)) {
      // Password field with toggle visibility
      const fieldId = `secret-${configPath.replace(/\./g, "-")}`;
      const masked = value ? "••••••••" : "";
      control.innerHTML = `
        <div class="secret-field">
          <input type="password" id="${fieldId}" value="${escapeHtml(String(value || ""))}"
                 placeholder="Enter key..."
                 onchange="SettingsPanel.updateValue('${configPath}', this.value)">
          <button type="button" class="toggle-secret" onclick="SettingsPanel.toggleSecret('${fieldId}')" title="Show/Hide">
            👁️
          </button>
        </div>
      `;
    } else {
      control.innerHTML = `
        <input type="text" value="${escapeHtml(String(value || ""))}"
               onchange="SettingsPanel.updateValue('${configPath}', this.value)">
      `;
    }
    
    wrapper.appendChild(label);
    wrapper.appendChild(control);
    return wrapper;
  }

  // ─── Value updates ─────────────────────────────────

  function updateValue(path, value) {
    setByPath(config, path, value);
  }

  function toggleSecret(fieldId) {
    const input = document.getElementById(fieldId);
    if (!input) return;
    input.type = input.type === "password" ? "text" : "password";
  }

  // ─── Toast Notifications ──────────────────────────

  function showToast(message, type = "info") {
    // Remove existing toasts
    document.querySelectorAll(".toast").forEach(t => t.remove());
    
    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);
    
    requestAnimationFrame(() => toast.classList.add("visible"));
    
    setTimeout(() => {
      toast.classList.remove("visible");
      setTimeout(() => toast.remove(), 300);
    }, 3000);
  }

  // ─── Helpers ──────────────────────────────────────

  function escapeHtml(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  // ─── Public API ───────────────────────────────────

  return {
    open,
    close,
    switchTab,
    updateValue,
    toggleSecret,
    saveConfig,
  };
})();
