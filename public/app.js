(function () {
  "use strict";

  const STORAGE_KEY = "n8ninator.sessions.v1";
  const CURRENT_KEY = "n8ninator.current.v1";
  const $ = (selector) => document.querySelector(selector);
  const elements = {
    sidebar: $("#sidebar"),
    mobileMenu: $("#mobile-menu"),
    newChat: $("#new-chat"),
    history: $("#history-list"),
    welcome: $("#welcome"),
    messages: $("#messages"),
    chatScroll: $("#chat-scroll"),
    composer: $("#composer"),
    prompt: $("#prompt"),
    send: $("#send"),
    stop: $("#stop"),
    composerStatus: $("#composer-status"),
    modelSelect: $("#model-select"),
    workspaceName: $("#workspace-name"),
    workspacePill: $("#workspace-pill"),
    workspaceContext: $("#workspace-context"),
    mcpContext: $("#mcp-context"),
    ollamaDot: $("#ollama-dot"),
    ollamaLabel: $("#ollama-label"),
    mcpDot: $("#mcp-dot"),
    mcpLabel: $("#mcp-label"),
    ollamaCard: $("#ollama-card"),
    mcpCard: $("#mcp-card"),
    settingsOpen: $("#settings-open"),
    settingsModal: $("#settings-modal"),
    settingsClose: $("#settings-close"),
    settingsCancel: $("#settings-cancel"),
    settingsSave: $("#settings-save"),
    settingsMessage: $("#settings-message"),
    settingWorkspace: $("#setting-workspace"),
    settingOllama: $("#setting-ollama"),
    settingContext: $("#setting-context"),
    settingReasoning: $("#setting-reasoning"),
    settingApproval: $("#setting-approval"),
    settingMcpEnabled: $("#setting-mcp-enabled"),
    settingMcpUrl: $("#setting-mcp-url"),
    settingMcpToken: $("#setting-mcp-token"),
    tokenState: $("#token-state"),
    modelCards: $("#model-cards"),
    pullModel: $("#pull-model"),
    pullProgress: $("#pull-progress"),
    testMcp: $("#test-mcp"),
    testMcpResult: $("#test-mcp-result"),
    viewPrompt: $("#view-prompt"),
    promptPreview: $("#prompt-preview"),
    toasts: $("#toasts"),
  };

  const state = {
    sessions: loadSessions(),
    currentId: localStorage.getItem(CURRENT_KEY),
    status: null,
    settings: null,
    selectedModel: "gpt-oss:20b",
    streaming: false,
    controller: null,
    streamRenderFrame: null,
    streamRenderKinds: new Set(),
  };

  if (window.marked) window.marked.setOptions({ gfm: true, breaks: false });

  function loadSessions() {
    try {
      const value = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(value) ? value.filter((session) => session && Array.isArray(session.messages)) : [];
    } catch { return []; }
  }

  function saveSessions() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.sessions.slice(0, 40)));
    if (state.currentId) localStorage.setItem(CURRENT_KEY, state.currentId);
  }

  function newSession(activate = true) {
    const session = {
      id: crypto.randomUUID(),
      title: "New task",
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
    };
    state.sessions.unshift(session);
    if (activate) state.currentId = session.id;
    saveSessions();
    return session;
  }

  function currentSession() {
    let session = state.sessions.find((item) => item.id === state.currentId);
    if (!session) session = state.sessions[0] || newSession();
    state.currentId = session.id;
    return session;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[character]);
  }

  function renderMarkdown(value) {
    if (!value) return "";
    if (!window.marked || !window.DOMPurify) return `<p>${escapeHtml(value).replace(/\n/g, "<br>")}</p>`;
    const html = window.marked.parse(value);
    return window.DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
  }

  function relativeTime(timestamp) {
    const minutes = Math.round((Date.now() - timestamp) / 60000);
    if (minutes < 2) return "now";
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.round(hours / 24)}d`;
  }

  function renderHistory() {
    const sessions = state.sessions.filter((session) => session.messages.length).slice(0, 18);
    elements.history.innerHTML = sessions.length
      ? sessions.map((session) => `<button class="history-item ${session.id === state.currentId ? "active" : ""}" data-session="${escapeHtml(session.id)}" title="${escapeHtml(session.title)}">${escapeHtml(session.title)}</button>`).join("")
      : '<div class="history-empty">Your local task history will appear here.</div>';
  }

  function toolEventsHtml(events) {
    if (!Array.isArray(events) || !events.length) return "";
    return `<div class="tool-stack">${events.map((event) => {
      if (event.kind === "goal") {
        const status = event.blocked ? "blocked" : event.complete ? "complete" : "continuing";
        const title = event.blocked ? "Goal check: blocked" : event.complete ? "Goal check passed" : "Goal check: continuing";
        const missing = Array.isArray(event.missing) && event.missing.length
          ? `<ul>${event.missing.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
          : "";
        return `<div class="goal-event ${status}"><div class="goal-event-head"><span>${event.complete ? "✓" : event.blocked ? "!" : "↻"}</span><strong>${title}</strong><small>check ${escapeHtml(event.check || 1)}</small></div><p>${escapeHtml(event.summary || "")}</p>${missing}</div>`;
      }
      if (event.kind === "approval") {
        const pending = event.status === "pending";
        return `<div class="tool-event approval-event ${pending ? "" : event.status === "approved" ? "ok" : "error"}">
          <div class="approval-copy"><span>◆</span><div><strong>${pending ? "Approval needed" : event.status === "approved" ? "Approved" : "Denied"}: ${escapeHtml(event.tool)}</strong><small>${pending ? "This action can change files, run a command, or mutate n8n." : "The agent has received your decision."}</small></div></div>
          <pre class="tool-detail">${escapeHtml(JSON.stringify(event.arguments || {}, null, 2))}</pre>
          ${pending ? `<div class="approval-actions"><button class="approve" data-approval="${escapeHtml(event.id)}" data-decision="approve">Approve once</button><button data-approval="${escapeHtml(event.id)}" data-decision="deny">Deny</button></div>` : ""}
        </div>`;
      }
      const status = event.status || "running";
      const icon = status === "ok" ? "✓" : status === "error" ? "!" : "⋯";
      const detail = event.result || (event.arguments ? JSON.stringify(event.arguments, null, 2) : "");
      return `<div class="tool-event ${escapeHtml(status)}"><div class="tool-event-header"><span class="tool-icon">${icon}</span><strong>${escapeHtml(event.tool)}</strong><small>${status === "running" ? "running" : status}</small></div>${detail ? `<pre class="tool-detail">${escapeHtml(detail)}</pre>` : ""}</div>`;
    }).join("")}</div>`;
  }

  function assistantMessageHtml(message, index) {
    const reasoning = message.thinking ? `<details class="reasoning"><summary>Local reasoning trace</summary><pre>${escapeHtml(message.thinking)}</pre></details>` : "";
    return `<article class="message assistant" data-message-index="${index}">
      <div class="assistant-avatar">n</div>
      <div class="assistant-body">
        <div class="assistant-label">n8ninator</div>
        <div data-message-reasoning>${reasoning}</div>
        <div data-message-events>${toolEventsHtml(message.events)}</div>
        <div class="message-content" data-message-content>${renderMarkdown(message.content)}</div>
        <div data-message-actions>${message.content ? `<div class="message-actions"><button data-copy-message="${index}">Copy response</button></div>` : ""}</div>
      </div>
    </article>`;
  }

  function renderMessages(keepBottom = true) {
    const session = currentSession();
    elements.welcome.classList.toggle("hidden", session.messages.length > 0);
    elements.messages.innerHTML = session.messages.map((message, index) => {
      if (message.role === "user") return `<article class="message user"><div class="user-bubble">${escapeHtml(message.content)}</div></article>`;
      return assistantMessageHtml(message, index);
    }).join("");
    elements.messages.querySelectorAll("a").forEach((link) => { link.target = "_blank"; link.rel = "noreferrer noopener"; });
    renderHistory();
    if (keepBottom) requestAnimationFrame(() => { elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight; });
  }

  function updateStreamingAssistant(assistant, kinds) {
    const index = currentSession().messages.indexOf(assistant);
    const article = elements.messages.querySelector(`[data-message-index="${index}"]`);
    if (!article) return renderMessages();
    const wasNearBottom = elements.chatScroll.scrollHeight - elements.chatScroll.scrollTop - elements.chatScroll.clientHeight < 120;

    if (kinds.has("thinking")) {
      const slot = article.querySelector("[data-message-reasoning]");
      let reasoning = slot.querySelector(".reasoning");
      if (assistant.thinking && !reasoning) {
        slot.innerHTML = '<details class="reasoning"><summary>Local reasoning trace</summary><pre></pre></details>';
        reasoning = slot.querySelector(".reasoning");
      }
      const trace = reasoning?.querySelector("pre");
      if (trace) trace.textContent = assistant.thinking || "";
    }

    if (kinds.has("events")) {
      article.querySelector("[data-message-events]").innerHTML = toolEventsHtml(assistant.events);
    }

    if (kinds.has("content")) {
      const content = article.querySelector("[data-message-content]");
      content.innerHTML = renderMarkdown(assistant.content);
      content.querySelectorAll("a").forEach((link) => { link.target = "_blank"; link.rel = "noreferrer noopener"; });
    }

    if (wasNearBottom) elements.chatScroll.scrollTop = elements.chatScroll.scrollHeight;
  }

  function queueStreamingRender(assistant, ...kinds) {
    kinds.forEach((kind) => state.streamRenderKinds.add(kind));
    if (state.streamRenderFrame !== null) return;
    state.streamRenderFrame = requestAnimationFrame(() => {
      state.streamRenderFrame = null;
      const pendingKinds = new Set(state.streamRenderKinds);
      state.streamRenderKinds.clear();
      updateStreamingAssistant(assistant, pendingKinds);
    });
  }

  function cancelStreamingRender() {
    if (state.streamRenderFrame !== null) cancelAnimationFrame(state.streamRenderFrame);
    state.streamRenderFrame = null;
    state.streamRenderKinds.clear();
  }

  function titleFromPrompt(prompt) {
    return prompt.replace(/\s+/g, " ").trim().slice(0, 52) || "New task";
  }

  function toast(message, type = "") {
    const node = document.createElement("div");
    node.className = `toast ${type}`;
    node.textContent = message;
    elements.toasts.appendChild(node);
    setTimeout(() => node.remove(), 4800);
  }

  function setComposerStatus(message, busy = false) {
    elements.composerStatus.textContent = message || "";
    elements.composerStatus.classList.toggle("busy", busy);
  }

  function autoGrow() {
    elements.prompt.style.height = "auto";
    elements.prompt.style.height = `${Math.min(elements.prompt.scrollHeight, 180)}px`;
    elements.send.disabled = !elements.prompt.value.trim() || state.streaming;
  }

  async function apiJson(url, options) {
    const response = await fetch(url, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `${response.status} ${response.statusText}`);
    return body;
  }

  async function readNdjson(response, onEvent) {
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `${response.status} ${response.statusText}`);
    }
    if (!response.body) throw new Error("The server did not return a stream.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) if (line.trim()) onEvent(JSON.parse(line));
      if (done) break;
    }
    if (buffer.trim()) onEvent(JSON.parse(buffer));
  }

  function installedModelNames() {
    return new Set((state.status?.ollama?.models || []).flatMap((model) => [model.name, model.model].filter(Boolean)));
  }

  function modelInstalled(model) {
    const names = installedModelNames();
    return names.has(model) || names.has(`${model}:latest`) || names.has(model.replace(/:latest$/, ""));
  }

  function populateModelSelect() {
    if (!state.status) return;
    const presets = state.status.presets || [];
    const included = new Set();
    const options = [];
    for (const preset of presets) {
      included.add(preset.id);
      const marker = modelInstalled(preset.id) ? "" : " · not downloaded";
      options.push(`<option value="${escapeHtml(preset.id)}">${escapeHtml(preset.label)}${marker}</option>`);
    }
    for (const model of state.status.ollama?.models || []) {
      const name = model.name || model.model;
      if (name && !included.has(name)) options.push(`<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`);
    }
    elements.modelSelect.innerHTML = options.join("");
    elements.modelSelect.value = state.settings?.model || state.selectedModel;
  }

  function shortPath(path) {
    if (!path) return "Workspace";
    const parts = path.replace(/\/$/, "").split("/");
    return parts[parts.length - 1] || path;
  }

  function renderStatus() {
    if (!state.status || !state.settings) return;
    const ollama = state.status.ollama;
    elements.ollamaDot.className = `status-dot ${ollama.connected ? "good" : "bad"}`;
    elements.ollamaLabel.textContent = ollama.connected ? `Local · v${ollama.version || "ready"}` : "Offline — setup needed";
    const mcp = state.status.mcp;
    elements.mcpDot.className = `status-dot ${mcp.connected ? "good" : state.settings.n8nMcp.enabled ? "warn" : ""}`;
    elements.mcpLabel.textContent = mcp.connected ? `${mcp.toolCount} tools ready` : state.settings.n8nMcp.enabled ? "Configured · test connection" : "Not connected";
    elements.workspaceName.textContent = shortPath(state.settings.workspace);
    elements.workspacePill.title = state.settings.workspace;
    elements.workspaceContext.title = state.settings.workspace;
    elements.mcpContext.classList.toggle("connected", mcp.connected);
    elements.mcpContext.classList.toggle("muted", !mcp.connected);
    elements.mcpContext.innerHTML = `<span>●</span> ${mcp.connected ? `${mcp.toolCount} MCP tools` : "n8n MCP"}`;
    if (!state.streaming) {
      if (!ollama.connected) setComposerStatus("Ollama is offline. Open Settings for setup.");
      else if (!modelInstalled(state.settings.model)) setComposerStatus(`${state.settings.model} is not downloaded yet.`);
      else setComposerStatus("");
    }
    populateModelSelect();
  }

  async function refreshStatus(quiet = false) {
    try {
      state.status = await apiJson("/api/status");
      state.settings = state.status.settings;
      state.selectedModel = state.settings.model;
      renderStatus();
    } catch (error) {
      if (!quiet) toast(`Could not load local status: ${error.message}`, "error");
    }
  }

  function handleAgentEvent(event, assistant) {
    assistant.events ||= [];
    const renderKinds = [];
    if (event.type === "status") setComposerStatus(event.message || "Working…", true);
    if (event.type === "thinking") { assistant.thinking = (assistant.thinking || "") + (event.delta || ""); renderKinds.push("thinking"); }
    if (event.type === "delta") { assistant.content += event.delta || ""; renderKinds.push("content"); }
    if (event.type === "content_reset") { assistant.content = ""; renderKinds.push("content"); }
    if (event.type === "goal_review") {
      assistant.events.push({ kind: "goal", complete: event.complete, blocked: event.blocked, summary: event.summary, missing: event.missing, check: event.check });
      renderKinds.push("events");
      if (event.complete) setComposerStatus("Goal check passed.");
      else if (event.blocked) setComposerStatus("Goal check found a blocker.");
      else setComposerStatus(event.nextAction || "Goal check found unfinished work. Continuing…", true);
    }
    if (event.type === "tool_start") { assistant.events.push({ kind: "tool", tool: event.tool, arguments: event.arguments, status: "running" }); renderKinds.push("events"); }
    if (event.type === "tool_result") {
      const match = [...assistant.events].reverse().find((item) => item.kind === "tool" && item.tool === event.tool && item.status === "running");
      if (match) { match.status = event.ok ? "ok" : "error"; match.result = event.result; }
      else assistant.events.push({ kind: "tool", tool: event.tool, result: event.result, status: event.ok ? "ok" : "error" });
      renderKinds.push("events");
    }
    if (event.type === "approval_required") { assistant.events.push({ kind: "approval", id: event.id, tool: event.tool, arguments: event.arguments, status: "pending" }); renderKinds.push("events"); }
    if (event.type === "approval_resolved") {
      const item = assistant.events.find((candidate) => candidate.kind === "approval" && candidate.id === event.id);
      if (item) item.status = event.approved ? "approved" : "denied";
      renderKinds.push("events");
    }
    if (event.type === "done") {
      assistant.content = event.content || assistant.content;
      assistant.metrics = event.metrics;
      renderKinds.push("content");
      setComposerStatus("");
    }
    if (event.type === "error") {
      assistant.content += `${assistant.content ? "\n\n" : ""}**Stopped:** ${event.error || "Unknown local agent error"}`;
      renderKinds.push("content");
      setComposerStatus("");
    }
    currentSession().updatedAt = Date.now();
    if (renderKinds.length) queueStreamingRender(assistant, ...renderKinds);
  }

  async function sendPrompt(text) {
    const prompt = (text || elements.prompt.value).trim();
    if (!prompt || state.streaming) return;
    if (!state.status?.ollama?.connected) {
      toast("Ollama is not reachable. Start Ollama, then open Settings to recheck.", "error");
      openSettings();
      return;
    }
    if (!modelInstalled(state.settings.model)) {
      toast(`${state.settings.model} is not downloaded. Use Download selected model in Settings.`, "error");
      openSettings();
      return;
    }
    const session = currentSession();
    const userMessage = { role: "user", content: prompt };
    session.messages.push(userMessage);
    if (session.title === "New task") session.title = titleFromPrompt(prompt);
    const history = session.messages.map(({ role, content }) => ({ role, content }));
    const assistant = { role: "assistant", content: "", thinking: "", events: [] };
    session.messages.push(assistant);
    session.updatedAt = Date.now();
    elements.prompt.value = "";
    autoGrow();
    state.streaming = true;
    state.controller = new AbortController();
    elements.send.classList.add("hidden");
    elements.stop.classList.remove("hidden");
    setComposerStatus(`Starting ${state.settings.model}…`, true);
    saveSessions();
    renderMessages();
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: history }),
        signal: state.controller.signal,
      });
      await readNdjson(response, (event) => handleAgentEvent(event, assistant));
    } catch (error) {
      if (error.name === "AbortError") {
        assistant.content += `${assistant.content ? "\n\n" : ""}_Generation stopped._`;
      } else {
        assistant.content += `${assistant.content ? "\n\n" : ""}**Local agent error:** ${error.message}`;
        toast(error.message, "error");
      }
    } finally {
      cancelStreamingRender();
      state.streaming = false;
      state.controller = null;
      elements.send.classList.remove("hidden");
      elements.stop.classList.add("hidden");
      autoGrow();
      setComposerStatus("");
      session.updatedAt = Date.now();
      saveSessions();
      renderMessages();
      await refreshStatus(true);
    }
  }

  function renderModelCards() {
    const presets = state.status?.presets || [];
    elements.modelCards.innerHTML = presets.map((preset) => {
      const tierLabel = preset.tier === "not-recommended" ? "too large" : preset.tier;
      return `<button class="model-card ${preset.id === state.selectedModel ? "selected" : ""}" data-model-card="${escapeHtml(preset.id)}">
        <div class="model-card-head"><strong>${escapeHtml(preset.label)}</strong><span class="tier ${escapeHtml(preset.tier)}">${escapeHtml(tierLabel)}</span><span class="size">${escapeHtml(preset.size)}</span></div>
        <p>${escapeHtml(preset.description)}</p>
      </button>`;
    }).join("");
  }

  function fillSettings() {
    const settings = state.settings;
    if (!settings) return;
    state.selectedModel = settings.model;
    elements.settingWorkspace.value = settings.workspace;
    elements.settingOllama.value = settings.ollamaUrl;
    elements.settingContext.value = String(settings.contextLength);
    elements.settingReasoning.value = settings.reasoningEffort;
    elements.settingApproval.value = settings.approvalMode;
    elements.settingMcpEnabled.checked = settings.n8nMcp.enabled;
    elements.settingMcpUrl.value = settings.n8nMcp.url;
    elements.settingMcpToken.value = "";
    elements.tokenState.textContent = settings.n8nMcp.tokenConfigured ? "saved locally" : "";
    elements.settingsMessage.textContent = "";
    elements.pullProgress.textContent = modelInstalled(settings.model) ? "Already downloaded" : "";
    elements.testMcpResult.textContent = "";
    renderModelCards();
  }

  function openSettings() {
    fillSettings();
    elements.settingsModal.classList.remove("hidden");
  }

  function closeSettings() { elements.settingsModal.classList.add("hidden"); }

  function settingsPayload() {
    const mcp = {
      enabled: elements.settingMcpEnabled.checked,
      url: elements.settingMcpUrl.value.trim(),
    };
    if (elements.settingMcpToken.value.trim()) mcp.accessToken = elements.settingMcpToken.value.trim();
    return {
      workspace: elements.settingWorkspace.value.trim(),
      ollamaUrl: elements.settingOllama.value.trim(),
      model: state.selectedModel,
      contextLength: Number(elements.settingContext.value),
      reasoningEffort: elements.settingReasoning.value,
      approvalMode: elements.settingApproval.value,
      n8nMcp: mcp,
    };
  }

  async function saveSettings(close = true, notify = true) {
    elements.settingsSave.disabled = true;
    elements.settingsMessage.textContent = "Saving…";
    try {
      state.settings = await apiJson("/api/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settingsPayload()),
      });
      state.selectedModel = state.settings.model;
      elements.settingsMessage.textContent = "Saved locally";
      await refreshStatus(true);
      if (notify) toast("Settings saved on this Mac.");
      if (close) setTimeout(closeSettings, 180);
      return true;
    } catch (error) {
      elements.settingsMessage.textContent = error.message;
      toast(error.message, "error");
      return false;
    } finally { elements.settingsSave.disabled = false; }
  }

  async function pullSelectedModel() {
    if (!state.status?.ollama?.connected) {
      toast("Start the Ollama app first, then try again.", "error");
      return;
    }
    elements.pullModel.disabled = true;
    elements.pullProgress.textContent = `Starting ${state.selectedModel}…`;
    const controller = new AbortController();
    try {
      const response = await fetch("/api/models/pull", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: state.selectedModel }),
        signal: controller.signal,
      });
      await readNdjson(response, (event) => {
        if (event.type === "error") throw new Error(event.error);
        if (event.type === "done") elements.pullProgress.textContent = "Download complete";
        else if (event.total && event.completed) elements.pullProgress.textContent = `${event.status || "Downloading"} · ${Math.round(event.completed / event.total * 100)}%`;
        else if (event.status) elements.pullProgress.textContent = event.status;
      });
      toast(`${state.selectedModel} is ready.`);
      await refreshStatus(true);
      fillSettings();
    } catch (error) {
      elements.pullProgress.textContent = error.message;
      toast(`Model download failed: ${error.message}`, "error");
    } finally { elements.pullModel.disabled = false; }
  }

  async function testMcp() {
    elements.testMcp.disabled = true;
    elements.testMcpResult.textContent = "Saving and connecting…";
    try {
      if (!await saveSettings(false, false)) return;
      const result = await apiJson("/api/mcp/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      elements.testMcpResult.textContent = `Connected · ${result.status.toolCount} tools discovered`;
      toast("n8n MCP is connected.");
      await refreshStatus(true);
    } catch (error) {
      elements.testMcpResult.textContent = error.message;
      toast(error.message, "error");
    } finally { elements.testMcp.disabled = false; }
  }

  elements.composer.addEventListener("submit", (event) => { event.preventDefault(); void sendPrompt(); });
  elements.prompt.addEventListener("input", autoGrow);
  elements.prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void sendPrompt(); }
  });
  elements.stop.addEventListener("click", () => state.controller?.abort());
  elements.newChat.addEventListener("click", () => {
    if (state.streaming) return toast("Stop the current response before starting a new task.");
    newSession(); renderMessages(); elements.prompt.focus(); elements.sidebar.classList.remove("open");
  });
  elements.history.addEventListener("click", (event) => {
    const button = event.target.closest("[data-session]");
    if (!button || state.streaming) return;
    state.currentId = button.dataset.session;
    saveSessions(); renderMessages(); elements.sidebar.classList.remove("open");
  });
  elements.messages.addEventListener("click", async (event) => {
    const approval = event.target.closest("[data-approval]");
    if (approval) {
      approval.disabled = true;
      try {
        await apiJson(`/api/approvals/${approval.dataset.approval}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ approved: approval.dataset.decision === "approve" }),
        });
      } catch (error) { toast(error.message, "error"); }
      return;
    }
    const copy = event.target.closest("[data-copy-message]");
    if (copy) {
      const message = currentSession().messages[Number(copy.dataset.copyMessage)];
      if (message?.content) { await navigator.clipboard.writeText(message.content); toast("Response copied."); }
    }
  });
  document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => void sendPrompt(button.dataset.prompt)));
  elements.modelSelect.addEventListener("change", async () => {
    state.selectedModel = elements.modelSelect.value;
    const preset = state.status?.presets?.find((item) => item.id === state.selectedModel);
    try {
      state.settings = await apiJson("/api/settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: state.selectedModel, ...(preset ? { contextLength: preset.defaultContext } : {}) }),
      });
      await refreshStatus(true);
      toast(`Using ${state.selectedModel}.`);
    } catch (error) { toast(error.message, "error"); }
  });
  elements.settingsOpen.addEventListener("click", openSettings);
  elements.workspacePill.addEventListener("click", openSettings);
  elements.workspaceContext.addEventListener("click", openSettings);
  elements.ollamaCard.addEventListener("click", openSettings);
  elements.mcpCard.addEventListener("click", openSettings);
  elements.mcpContext.addEventListener("click", openSettings);
  elements.settingsClose.addEventListener("click", closeSettings);
  elements.settingsCancel.addEventListener("click", closeSettings);
  elements.settingsSave.addEventListener("click", () => void saveSettings());
  elements.settingsModal.addEventListener("click", (event) => { if (event.target === elements.settingsModal) closeSettings(); });
  elements.modelCards.addEventListener("click", (event) => {
    const card = event.target.closest("[data-model-card]");
    if (!card) return;
    state.selectedModel = card.dataset.modelCard;
    const preset = state.status.presets.find((item) => item.id === state.selectedModel);
    if (preset) elements.settingContext.value = String(preset.defaultContext);
    renderModelCards();
    elements.pullProgress.textContent = modelInstalled(state.selectedModel) ? "Already downloaded" : "";
  });
  elements.pullModel.addEventListener("click", () => void pullSelectedModel());
  elements.testMcp.addEventListener("click", () => void testMcp());
  elements.viewPrompt.addEventListener("click", async () => {
    if (!elements.promptPreview.classList.contains("hidden")) return elements.promptPreview.classList.add("hidden");
    try {
      elements.promptPreview.textContent = await fetch("/api/system-prompt").then((response) => response.text());
      elements.promptPreview.classList.remove("hidden");
    } catch (error) { toast(error.message, "error"); }
  });
  elements.mobileMenu.addEventListener("click", () => elements.sidebar.classList.toggle("open"));
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { closeSettings(); elements.sidebar.classList.remove("open"); }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); elements.prompt.focus(); }
  });

  currentSession();
  renderMessages(false);
  autoGrow();
  void refreshStatus();
  setInterval(() => { if (!state.streaming && elements.settingsModal.classList.contains("hidden")) void refreshStatus(true); }, 30_000);
})();
