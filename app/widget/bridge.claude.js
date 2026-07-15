// OrbitFSBridge implementation for the Claude MCP Apps host, via the official
// @modelcontextprotocol/ext-apps App class (globalThis.ExtApps, inlined by the
// server ahead of this script - see server.js). Only activates when no earlier
// bridge (e.g. bridge.chatgpt.js) has already claimed window.OrbitFSBridge and
// the ext-apps bundle actually loaded.
(function () {
  if (typeof window === "undefined" || window.OrbitFSBridge) return;
  if (!globalThis.ExtApps || !globalThis.ExtApps.App) return;

  const { App } = globalThis.ExtApps;
  const app = new App({ name: "OrbitFS", version: "1.0.0" }, {}, { autoResize: true });

  let latestResult = null;
  const viewListeners = [];

  function extractView(result) {
    const sc = result?.structuredContent || {};
    return sc.view || sc.ui?.currentScreen || null;
  }

  app.ontoolresult = (result) => {
    latestResult = result;
    for (const listener of viewListeners) listener(extractView(result));
  };

  const ready = app.connect().catch((err) => {
    console.error("OrbitFS Claude bridge failed to connect:", err);
  });

  window.OrbitFSBridge = {
    hostName: "claude",
    ready,

    async callTool(name, args = {}) {
      await ready;
      return app.callServerTool({ name, arguments: args });
    },

    async sendChatPrompt(text) {
      const result = await app.sendMessage({ role: "user", content: [{ type: "text", text }] });
      if (result?.isError) throw new Error("Host rejected the message");
      return result;
    },

    async requestClose() {
      // MCP Apps has no host-level "dismiss the widget" call today; the local
      // shell-hide in core.js is the only affordance available on this host.
    },

    getInitialView() {
      return extractView(latestResult);
    },

    onViewUpdate(callback) {
      viewListeners.push(callback);
    },
  };
})();
