const API_BASE = ""; // Relative path — works on any host

const elements = {
  chatContainer: document.getElementById("chat-window"),
  sessionList: document.getElementById("session-list"),
  chatForm: document.getElementById("chat-form"),
  chatInput: document.getElementById("chat-input"),
  sendBtn: document.getElementById("send-btn"),
  newChatBtn: document.getElementById("new-chat-btn"),
  currentSessionTitle: document.getElementById("current-session-title"),
  statusIndicator: document.querySelector(".status-indicator"),
  statusText: document.querySelector(".status-text"),
};

let sessions = [];
let currentSessionId = null;
let isGenerating = false;

// Configure DOMPurify to allow classes (needed for syntax highlighting)
const purifyConfig = {
  ADD_ATTR: ['class'],
  ALLOWED_TAGS: [
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'p', 'a', 'ul', 'ol',
    'nl', 'li', 'b', 'i', 'strong', 'em', 'strike', 'code', 'hr', 'br', 'div',
    'table', 'thead', 'caption', 'tbody', 'tr', 'th', 'td', 'pre', 'span', 'img'
  ]
};

function renderMarkdown(content) {
  try {
    const rawHtml = marked.parse(content);
    return DOMPurify.sanitize(rawHtml, purifyConfig);
  } catch (err) {
    console.error("Markdown parse error:", err);
    return content;
  }
}

// ─── Initialize ──────────────────────────────────────────────
async function init() {
  // CRITICAL: Set up event listeners FIRST so UI is always interactive
  setupEventListeners();

  try {
    await loadSessions();
    
    if (sessions.length > 0) {
      await loadSession(sessions[0].id);
    } else {
      await createNewSession();
    }
  } catch (e) {
    console.error("Init error:", e);
    // Fallback: create a local-only session so UI is usable
    const fallback = { id: `session_${Date.now()}`, title: "New Session", updatedAt: Date.now(), messages: [] };
    sessions = [fallback];
    currentSessionId = fallback.id;
    renderSessionList();
    renderChat([]);
  }
}

function setupEventListeners() {
  elements.chatForm.addEventListener("submit", handleSubmit);
  
  elements.chatInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = elements.chatInput.value.trim();
      if (text && !isGenerating) {
        elements.chatForm.requestSubmit();
      }
    }
  });

  const updateButtonState = () => {
    const text = elements.chatInput.value.trim();
    elements.sendBtn.disabled = text.length === 0 || isGenerating;
  };

  elements.chatInput.addEventListener("input", function() {
    this.style.height = "auto";
    this.style.height = (this.scrollHeight) + "px";
    updateButtonState();
  });

  elements.newChatBtn.addEventListener("click", createNewSession);
  
  const restartBtn = document.getElementById("restart-btn");
  if (restartBtn) {
    restartBtn.addEventListener("click", () => {
      if (confirm("Are you sure you want to restart the system? This will interrupt the current generation.")) {
        handleSystemRestart();
      }
    });
  }

  const stopBtn = document.getElementById("stop-btn");
  if (stopBtn) stopBtn.addEventListener("click", handleStop);

  const contextBtn = document.getElementById("context-btn");
  if (contextBtn) contextBtn.addEventListener("click", handleContext);

  const closeContextBtn = document.getElementById("close-context-btn");
  if (closeContextBtn) closeContextBtn.addEventListener("click", () => {
      document.getElementById("context-overlay").classList.remove("visible");
  });
} // setupEventListeners

// ─── Session Management (Server-Backed) ─────────────────────
async function loadSessions() {
  try {
    const res = await fetch(`${API_BASE}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "list" })
    });
    const data = await res.json();
    // Server returns { sessions: [...] }
    sessions = (data.sessions || []).map(s => ({
      id: s.id,
      title: s.title || s.id,
      updatedAt: s.updatedAt || 0,
      messages: [] // Messages are loaded on demand
    }));
  } catch (e) {
    console.error("Failed to load sessions from server", e);
    sessions = [];
  }
  renderSessionList();
}

async function saveSessionToServer(session) {
  if (!session || !session.id) return;
  try {
    await fetch(`${API_BASE}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "save", id: session.id, messages: session.messages, title: session.title })
    });
  } catch (e) {
    console.error("Failed to save session to server", e);
  }
}

async function createNewSession() {
  let newSession;
  try {
    const res = await fetch(`${API_BASE}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "create" })
    });
    const data = await res.json();
    newSession = {
      id: data.id || `webui_${Date.now()}`,
      title: data.title || "New Session",
      updatedAt: data.updatedAt || Date.now(),
      messages: []
    };
  } catch (e) {
    console.error("Failed to create session on server, using local fallback", e);
    newSession = {
      id: `webui_${Date.now()}`,
      title: "New Session",
      updatedAt: Date.now(),
      messages: []
    };
  }
  sessions.unshift(newSession);
  currentSessionId = newSession.id;
  elements.currentSessionTitle.textContent = newSession.title;
  renderSessionList();
  renderChat([]);
  elements.chatInput.focus();
}

async function loadSession(id) {
  currentSessionId = id;
  const session = sessions.find(s => s.id === id);
  if (!session) return;

  // Fetch messages from server
  try {
    const res = await fetch(`${API_BASE}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "load", id: id })
    });
    if (res.ok) {
      const data = await res.json();
      session.messages = data.messages || [];
    }
  } catch (e) {
    console.error("Failed to load session messages from server", e);
  }
  // Fallback: keep whatever messages we already have in memory
  session.messages = session.messages || [];
  
  elements.currentSessionTitle.textContent = session.title;
  renderSessionList();
  renderChat(session.messages);
}

function updateSessionTitle(session, text) {
  if (session.messages.length <= 2 && (session.title === "New Session" || session.title === "New chat")) {
    const title = text.length > 30 ? text.substring(0, 30) + "..." : text;
    session.title = title;
    if (elements.currentSessionTitle) elements.currentSessionTitle.textContent = title;
  }
}

// ─── Utility ─────────────────────────────────────────────────
function escapeHtml(unsafe) {
  return (unsafe || "").replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
}

// ─── Custom UI Modal ──────────────────────────────────────────
const Modal = {
  getElements() {
    return {
      overlay: document.getElementById('custom-modal-overlay'),
      title: document.getElementById('modal-title'),
      message: document.getElementById('modal-message'),
      input: document.getElementById('modal-input'),
      cancelBtn: document.getElementById('modal-cancel-btn'),
      confirmBtn: document.getElementById('modal-confirm-btn')
    };
  },
  
  show(options) {
    return new Promise((resolve) => {
      const els = this.getElements();
      if (!els.overlay) {
        console.error("Modal overlay not found in DOM");
        resolve(false);
        return;
      }
      
      // Configure elements
      els.title.textContent = options.title || 'Notification';
      els.message.textContent = options.message || '';
      
      if (options.type === 'prompt') {
        els.input.style.display = 'block';
        els.input.value = options.inputValue || '';
        setTimeout(() => els.input.focus(), 100);
      } else {
        els.input.style.display = 'none';
      }

      els.confirmBtn.textContent = options.confirmText || 'OK';
      
      if (options.danger) {
        els.confirmBtn.classList.add('danger');
      } else {
        els.confirmBtn.classList.remove('danger');
      }

      // Cleanup function to remove event listeners
      const cleanup = () => {
        els.cancelBtn.removeEventListener('click', onCancel);
        els.confirmBtn.removeEventListener('click', onConfirm);
        els.input.removeEventListener('keydown', onInputKeydown);
        els.overlay.classList.remove('visible');
      };

      // Event handlers
      const onCancel = () => {
        cleanup();
        resolve(false);
      };

      const onConfirm = () => {
        cleanup();
        if (options.type === 'prompt') {
          resolve(els.input.value);
        } else {
          resolve(true);
        }
      };

      const onInputKeydown = (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          onConfirm();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      };

      // Attach listeners
      els.cancelBtn.addEventListener('click', onCancel);
      els.confirmBtn.addEventListener('click', onConfirm);
      els.input.addEventListener('keydown', onInputKeydown);

      // Show modal
      els.overlay.classList.add('visible');
    });
  }
};

// ─── Startup ─────────────────────────────────────────────────

// ─── UI Rendering ───────────────────────────────────────────
function renderSessionList() {
  elements.sessionList.innerHTML = "";
  
  if (sessions.length === 0) {
    elements.sessionList.innerHTML = '<div class="no-sessions">No previous sessions</div>';
    return;
  }
  
  sessions.forEach(session => {
    const el = document.createElement("div");
    el.className = `session-item ${session.id === currentSessionId ? 'active' : ''}`;
    el.dataset.sessionId = session.id;

    // FIX: click listener on the whole div, not just the title span
    el.addEventListener("click", () => loadSession(session.id));
    
    const titleSpan = document.createElement("span");
    titleSpan.className = "session-title-text";
    titleSpan.textContent = session.title;
    
    const spinner = document.createElement("span");
    spinner.className = "session-spinner";
    spinner.innerHTML = `<span class="session-spinner-icon" aria-hidden="true"></span>`;

    const menuTrigger = document.createElement("div");
    menuTrigger.className = "session-menu-trigger";
    menuTrigger.innerHTML = "⋮";
    menuTrigger.addEventListener("click", (e) => {
      e.stopPropagation();
      showSessionMenu(e, session.id);
    });

    el.appendChild(titleSpan);
    el.appendChild(spinner);
    el.appendChild(menuTrigger);
    elements.sessionList.appendChild(el);
  });
}

function showSessionMenu(e, sessionId) {
  let dropdown = document.getElementById("session-dropdown");
  if (!dropdown) {
    dropdown = document.createElement("div");
    dropdown.id = "session-dropdown";
    dropdown.className = "session-dropdown";
    document.body.appendChild(dropdown);
  }

  dropdown.innerHTML = `
    <div class="dropdown-item" onclick="handleSessionRename('${sessionId}')">
      <span>✎</span> Rename
    </div>
    <div class="dropdown-item" onclick="handleSessionCompact('${sessionId}')">
      <span>📦</span> Compact
    </div>
    <div class="dropdown-item danger" onclick="handleSessionDelete('${sessionId}')">
      <span>🗑️</span> Delete
    </div>
  `;

  const rect = e.target.getBoundingClientRect();
  dropdown.style.top = `${rect.bottom + 5}px`;
  dropdown.style.left = `${rect.left - 100}px`;
  dropdown.classList.add("visible");

  const closeMenu = (ev) => {
    if (!dropdown.contains(ev.target)) {
      dropdown.classList.remove("visible");
      document.removeEventListener("click", closeMenu);
    }
  };
  setTimeout(() => document.addEventListener("click", closeMenu), 10);
}

async function handleSessionRename(id) {
  const session = sessions.find(s => s.id === id);
  if (!session) return;
  
  const newName = await Modal.show({
    title: 'Rename Session',
    message: 'Enter new session name:',
    type: 'prompt',
    inputValue: session.title,
    confirmText: 'Rename'
  });

  if (newName !== false && newName.trim() !== "") {
    session.title = newName.trim();
    if (id === currentSessionId) {
      elements.currentSessionTitle.textContent = session.title;
    }
    renderSessionList();
    await saveSessionToServer(session);
  }
}

async function handleSessionDelete(id) {
  const confirmed = await Modal.show({
    title: 'Delete Session',
    message: 'Are you sure you want to delete this session? This action cannot be undone.',
    type: 'confirm',
    confirmText: 'Delete',
    danger: true
  });

  if (!confirmed) return;
  
  try {
    const response = await fetch(`${API_BASE}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", id: id })
    });

    if (response.ok) {
      sessions = sessions.filter(s => s.id !== id);
      renderSessionList();
      if (id === currentSessionId) {
        if (sessions.length > 0) await loadSession(sessions[0].id);
        else await createNewSession();
      }
    } else {
      const err = await response.json();
      Modal.show({ title: 'Error', message: "Delete failed: " + (err.error || "Unknown error"), type: 'confirm' });
    }
  } catch (e) {
    console.error("Delete failed", e);
    Modal.show({ title: 'Error', message: "Delete failed: " + e.message, type: 'confirm' });
  }
}

async function handleSessionCompact(id) {
  const confirmed = await Modal.show({
    title: 'Archive Session',
    message: 'This will archive the entire session into HISTORY.md and delete it from here. Proceed?',
    type: 'confirm',
    confirmText: 'Archive'
  });

  if (!confirmed) return;

  // Indicate activity on the session item
  const sessionEl = document.querySelector(`.session-item[data-session-id="${id}"]`);
  if (sessionEl) sessionEl.classList.add('compactting');

  const session = sessions.find(s => s.id === id);
  const messages = session ? session.messages : [];

  try {
    const response = await fetch(`${API_BASE}/api/v1/sessions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "compact", id: id, messages })
    });

    if (response.ok) {
      sessions = sessions.filter(s => s.id !== id);
      renderSessionList();
      await createNewSession();
      showToast("Session compacted into local history!");
    } else {
      const err = await response.json();
      Modal.show({ title: 'Error', message: "Compact failed: " + (err.error || "Unknown error"), type: 'confirm' });
    }
  } catch (e) {
    console.error("Compact failed", e);
    Modal.show({ title: 'Error', message: "Compact failed: " + e.message, type: 'confirm' });
  } finally {
    if (sessionEl) sessionEl.classList.remove('compactting');
  }
}


function showToast(message) {
    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = "0";
        toast.style.transition = "opacity 0.5s";
        setTimeout(() => toast.remove(), 500);
    }, 3000);
}

// Expose globally so settings.js can use it (settings.js is loaded before app.js in index.html)
window.showToast = showToast;

function renderChat(messages) {
  elements.chatContainer.innerHTML = "";
  
  if (messages.length === 0) {
    elements.chatContainer.innerHTML = `
      <div class="welcome-screen">
        <div class="welcome-icon">⚡</div>
        <h2>How can I help you today?</h2>
        <p>I am your local AI agent. I can write code, run commands, and assist you with your tasks.</p>
      </div>
    `;
    return;
  }
  
  messages.forEach(msg => {
    appendMessageToUI(msg.role, msg.content, false, msg.steps);
  });
}

function appendMessageToUI(role, content, animate = false, steps = null) {
  const wrapper = document.createElement("div");
  wrapper.className = `message-wrapper ${role}`;
  
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  if (role === "user") {
    avatar.textContent = "U";
  } else {
    avatar.innerHTML = `<img src="assets/logo_cat.png" alt="Agent">`;
  }
  
  const msgBody = document.createElement("div");
  msgBody.className = "message-body markdown-body";
  
  if (role === "user") {
    msgBody.innerHTML = renderMarkdown(content);
  } else {
    if (steps && steps.length > 0) {
        // Use skipInitial=true because the steps array already contains our initial step
        const reasonId = ProcessManager.createGroup(msgBody, true);
        steps.forEach(step => ProcessManager.addStep(reasonId, step));
        ProcessManager.finish(reasonId, true);
    }

    const contentDiv = document.createElement("div");
    contentDiv.className = "message-content";
    contentDiv.innerHTML = renderMarkdown(content);
    msgBody.appendChild(contentDiv);
  }
  
  wrapper.appendChild(avatar);
  wrapper.appendChild(msgBody);
  
  elements.chatContainer.appendChild(wrapper);
  elements.chatContainer.scrollTop = elements.chatContainer.scrollHeight;
  
  if (role === "assistant") {
    // We don't need hljs.highlightElement(block) because Marked.js already does it,
    // but we DO need to add our headers and copy buttons.
    addCopyButtonsToCodeBlocks(wrapper);
  }
  
  return wrapper;
}

function addCopyButtonsToCodeBlocks(container) {
  if (!container) return;

  container.querySelectorAll('pre code').forEach((code) => {
    const pre = code.parentElement;
    if (!pre) return;
    if (pre.dataset.copyButtonAdded) return;
    pre.dataset.copyButtonAdded = "true";

    // Apply highlighting manually since we removed the marked highlight option
    hljs.highlightElement(code);

    // Extract language gracefully
    let lang = 'code';
    code.classList.forEach(cls => {
      if (cls.startsWith('language-')) {
        lang = cls.replace('language-', '');
      }
    });

    const wrapper = document.createElement('div');
    wrapper.className = 'code-block-wrapper';
    pre.parentNode.insertBefore(wrapper, pre);
    
    // Create header
    const header = document.createElement('div');
    header.className = 'code-block-header';
    
    const langSpan = document.createElement('span');
    langSpan.className = 'code-block-lang';
    langSpan.textContent = lang;
    
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'copy-code-btn';
    btn.title = 'Copy code';
    btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="css-i6dzq1"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> <span>Copy</span>`;

    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(code.textContent || '');
        btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="css-i6dzq1"><polyline points="20 6 9 17 4 12"></polyline></svg> <span>Copied!</span>`;
        btn.classList.add('copied');
        setTimeout(() => {
          btn.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="css-i6dzq1"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg> <span>Copy</span>`;
          btn.classList.remove('copied');
        }, 2000);
      } catch (e) {
        console.error('Copy failed', e);
        showToast('Copy failed: ' + (e.message || 'Unknown error'));
      }
    });

    header.appendChild(langSpan);
    header.appendChild(btn);
    
    wrapper.appendChild(header);
    wrapper.appendChild(pre);
  });
}


// ─── Process / Reasoning Manager ────────────────────────────
const ProcessManager = {
  activeGroups: new Map(),

  createGroup(container, skipInitial = false) {
    const groupId = `process-${Date.now()}`;
    const groupEl = document.createElement("div");
    groupEl.className = "process-group";
    groupEl.id = groupId;
    
    groupEl.innerHTML = `
      <div class="process-header" onclick="ProcessManager.toggle('${groupId}')">
        <div class="process-icon spinning">🌀</div>
        <div class="process-title">Reasoning</div>
        <div class="process-arrow">▼</div>
      </div>
      <div class="process-content">
        <ul class="process-steps"></ul>
      </div>
    `;
    
    container.appendChild(groupEl);
    this.activeGroups.set(groupId, groupEl);
    if (!skipInitial) {
        this.addStep(groupId, "Analyzing request...");
    }
    
    return groupId;
  },

  addStep(groupId, content) {
    if (!content || !content.trim()) return;
    const group = this.activeGroups.get(groupId);
    if (!group) return;
    
    const stepsList = group.querySelector(".process-steps");
    const step = document.createElement("li");
    
    const isTool = content.includes("(") && content.endsWith(")");
    step.className = `process-step ${isTool ? 'tool-call' : ''}`;
    step.innerHTML = renderMarkdown(content);
    
    stepsList.appendChild(step);
    elements.chatContainer.scrollTop = elements.chatContainer.scrollHeight;
  },

  finish(groupId, success = true) {
    const group = this.activeGroups.get(groupId);
    if (!group) return;
    
    const icon = group.querySelector(".process-icon");
    const title = group.querySelector(".process-title");
    
    icon.classList.remove("spinning");
    icon.textContent = success ? "✅" : "❌";
    title.textContent = success ? "Thought Process" : "Reasoning interrupted";
  },

  toggle(groupId) {
    const group = document.getElementById(groupId);
    if (group) {
        group.classList.toggle("collapsed");
    }
  }
};

// ─── API Communication ──────────────────────────────────────
async function handleSubmit(e) {
  if (e) e.preventDefault();
  
  const text = elements.chatInput.value.trim();
  if (!text || isGenerating) return;
  
  const session = sessions.find(s => s.id === currentSessionId);
  if (!session) return;
  
  // 1. Add user message
  session.messages.push({ role: "user", content: text });
  session.updatedAt = Date.now();
  updateSessionTitle(session, text);
  
  // 2. Update UI
  elements.chatInput.value = "";
  elements.chatInput.style.height = "auto";
  appendMessageToUI("user", text);
  
  setStatus(true, "Thinking...");
  
  // 3. Remove welcome screen
  const welcome = elements.chatContainer.querySelector(".welcome-screen");
  if (welcome) welcome.remove();
  
  // 4. Create Agent Message Wrapper for streaming
  const wrapper = document.createElement("div");
  wrapper.className = `message-wrapper assistant`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.innerHTML = `<img src="assets/logo_cat.png" alt="Agent">`;
  const msgBody = document.createElement("div");
  msgBody.className = "message-body markdown-body";
  
  wrapper.appendChild(avatar);
  wrapper.appendChild(msgBody);
  elements.chatContainer.appendChild(wrapper);

  // 5. Create Reasoning Block
  const reasonId = ProcessManager.createGroup(msgBody);
  let currentAgentMsgSteps = ["Analyzing request..."];
  let reasonFinished = false;
  
  try {
    const response = await fetch(`${API_BASE}/api/v1/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: text,
        session: currentSessionId
      })
    });
    
    if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
    
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult = "";

    function processLines(chunk) {
      const lines = chunk.split("\n");
      let currentEvent = null;
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        if (trimmed.startsWith("event: ")) {
          currentEvent = trimmed.replace("event: ", "").trim();
        } else if (trimmed.startsWith("data: ") && currentEvent) {
          try {
            const data = JSON.parse(trimmed.replace("data: ", "").trim());
            if (currentEvent === "progress") {
              const content = data.content;
              // Avoid duplicates in the steps array
              if (!currentAgentMsgSteps.includes(content)) {
                currentAgentMsgSteps.push(content);
                ProcessManager.addStep(reasonId, content);
              }
            } else if (currentEvent === "chunk") {
              if (data.content) {
                finalResult += data.content;
                let chunkDiv = msgBody.querySelector(".streaming-chunk-container");
                if (!chunkDiv) {
                    chunkDiv = document.createElement("div");
                    chunkDiv.className = "streaming-chunk-container";
                    const pre = document.createElement("pre");
                    pre.style.whiteSpace = "pre-wrap";
                    pre.style.wordBreak = "break-word";
                    chunkDiv.appendChild(pre);
                    msgBody.appendChild(chunkDiv);
                }
                const pre = chunkDiv.querySelector("pre");
                if (pre) pre.textContent = finalResult;
                elements.chatContainer.scrollTop = elements.chatContainer.scrollHeight;
              }
            } else if (currentEvent === "final") {
                finalResult = data.result;
                reasonFinished = true;
                ProcessManager.finish(reasonId);
                
                const chunkDiv = msgBody.querySelector(".streaming-chunk-container");
                if (chunkDiv) chunkDiv.remove();
 
                const mdHtml = renderMarkdown(finalResult);
                const finalDiv = document.createElement('div');
                finalDiv.className = "message-content";
                finalDiv.innerHTML = mdHtml;
                msgBody.appendChild(finalDiv);
                
                // Apply syntax highlighting and our custom code block headers
                addCopyButtonsToCodeBlocks(wrapper);
              } else if (currentEvent === "error") {
                reasonFinished = true;
                ProcessManager.finish(reasonId, false);
                const errDiv = document.createElement("div");
                errDiv.className = "error-text";
                errDiv.innerHTML = `<strong>Error:</strong> ${data.message}`;
                msgBody.appendChild(errDiv);
              }

          } catch (e) { 
            console.error("SSE Parse Error:", e, "Line:", trimmed); 
          }
        }
      }
    }

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      for (const part of parts) {
        processLines(part);
      }
    }
    // Always process any remaining buffer, even if it does not contain newlines
    if (buffer) processLines(buffer);

    // 6. Save to session (server-backed)
    if (finalResult) {
      session.messages.push({ role: "assistant", content: finalResult, steps: currentAgentMsgSteps });
      session.updatedAt = Date.now();
      await saveSessionToServer(session);
      renderSessionList();
    }
    // Ensure the process group is finalized even if we never received a final event
    if (!reasonFinished) {
      ProcessManager.finish(reasonId, false);
    }
    
  } catch (error) {
    console.error("Streaming Error:", error);
    ProcessManager.finish(reasonId, false);
    const errorMsg = `**Connection error:** Unable to reach server.\n\n\`${error.message}\``;
    const errDiv = document.createElement("div");
    errDiv.innerHTML = DOMPurify.sanitize(marked.parse(errorMsg), purifyConfig);
    msgBody.appendChild(errDiv);
    session.messages.push({ role: "assistant", content: errorMsg, steps: currentAgentMsgSteps });
    await saveSessionToServer(session);
  } finally {
    setStatus(false, "Ready");
    elements.chatInput.focus();
    elements.chatContainer.scrollTop = elements.chatContainer.scrollHeight;
  }
}

function setStatus(loading, text) {
  isGenerating = loading;
  elements.statusIndicator.className = `status-indicator ${loading ? 'busy' : 'active'}`;
  elements.statusText.textContent = text;
  
  const inputVal = elements.chatInput.value.trim();
  elements.sendBtn.disabled = loading || inputVal.length === 0;
  elements.chatForm.classList.toggle("is-loading", loading);

  const stopBtn = document.getElementById("stop-btn");
  if (stopBtn) stopBtn.style.display = loading ? "flex" : "none";
}

// Legacy placeholder (unused) - removed to avoid confusion.

function removeElement(id) {
  const el = document.getElementById(id);
  if (el) el.remove();
}

async function handleSystemRestart() {
  const overlay = document.getElementById("restart-overlay");
  if (overlay) overlay.classList.add("active");
  
  try {
    const response = await fetch(`${API_BASE}/api/v1/restart`, { method: "POST" });
    console.log("Restart request sent:", await response.json());
  } catch (e) {
    console.error("Restart req failed (expected if server dies):", e);
  }

  setTimeout(() => {
    window.location.reload();
  }, 8000);
}

// ─── Toolbar Handlers ───────────────────────────────────────
async function handleStop() {
  if (!isGenerating) return;
  try {
    const res = await fetch(`${API_BASE}/api/v1/stop`, { method: "POST" });
    if (res.ok) {
        setStatus(false, "Stopped");
        showToast("Generation stopped");
    }
  } catch (e) {
    console.error("Stop failed", e);
  }
}

async function handleContext() {
  const contextBtn = document.getElementById("context-btn");
  if (!contextBtn || contextBtn.classList.contains("loading")) return;
  
  contextBtn.classList.add("loading");
  const originalText = contextBtn.lastChild.textContent;
  contextBtn.lastChild.textContent = " Loading...";
  
  try {
    const res = await fetch(`${API_BASE}/api/v1/context`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: currentSessionId })
    });
    
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    
    const data = await res.json();
    if (data.ok) {
        document.getElementById("context-raw-textarea").value = data.raw_context;
        const overlay = document.getElementById("context-overlay");
        overlay.classList.add("visible");
        
        // Show approx tokens as toast
        showToast(`~${(data.approx_tokens || 0).toLocaleString()} tokens in context`);
    } else {
        throw new Error(data.error || "Failed to fetch context");
    }
  } catch (e) {
    console.error("Context failed:", e);
    showToast("Error loading context: " + e.message);
  } finally {
    contextBtn.classList.remove("loading");
    contextBtn.lastChild.textContent = originalText;
  }
}

// Boot
init();
