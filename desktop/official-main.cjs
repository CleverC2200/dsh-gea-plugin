const { join } = require("node:path");
const { mkdirSync } = require("node:fs");
const { app, dialog } = require("electron");
const userData = join(app.getPath("appData"), "GEA Desktop");
mkdirSync(userData, { recursive: true });
app.setPath("userData", userData);
app.on("browser-window-created", (_event, window) => {
  window.on("page-title-updated", (event, title) => {
    if (title === "DeepSeek Harness" || title.endsWith(" — DeepSeek Harness")) {
      event.preventDefault();
      window.setTitle(title.slice(0, -"DeepSeek Harness".length) + "Synear GEA");
    }
  });
});
if (!app.requestSingleInstanceLock()) app.quit();
else {
  process.env.GEA_DESKTOP_VERSION = app.getVersion();
  const { startCompanyDesktop } = require("./company-desktop.mjs");
  void startCompanyDesktop({
    app,
    dialog,
    root: __dirname,
    resources: process.resourcesPath,
    loadOfficial: () => require("./lib/main.js"),
  }).catch((error) => {
    void app
      .whenReady()
      .then(() => dialog.showErrorBox("GEA 启动恢复失败", String(error.message).slice(-2000)));
  });
}
