// OrbitFSBridge implementation for the ChatGPT Apps SDK host (window.openai).
// Only activates when window.openai is actually present, so this file is a
// no-op when concatenated into a widget served to a different host.
(function () {
  if (typeof window === "undefined" || !window.openai) return;

  window.OrbitFSBridge = {
    hostName: "chatgpt",
    ready: Promise.resolve(),

    callTool(name, args = {}) {
      return window.openai.callTool(name, args);
    },

    async sendChatPrompt(text) {
      if (!window.openai.sendFollowUpMessage) {
        throw new Error("Chat follow-up is unavailable. Type the command in chat instead.");
      }
      return window.openai.sendFollowUpMessage({ prompt: text });
    },

    async requestClose() {
      if (window.openai.requestClose) await window.openai.requestClose();
    },

    getInitialView() {
      const out = window.openai.toolOutput || {};
      return out.view || out.ui?.currentScreen || null;
    },

    onViewUpdate(callback) {
      window.addEventListener("openai:set_globals", () => callback(window.OrbitFSBridge.getInitialView()));
    },
  };
})();
