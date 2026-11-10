const { spawnSync } = require("node:child_process");
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
  const result = spawnSync(
    process.execPath,
    [
      "--expose-internals",
      join(__dirname, "company-bootstrap.mjs"),
      __dirname,
      join(process.resourcesPath, "runtime"),
      join(process.resourcesPath, "company-seed"),
      join(app.getPath("appData"), "dsh-gea-desktop"),
    ],
    {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      windowsHide: true,
    },
  );
  if (result.status === 0) {
    process.env.GEA_COMPANY_CLIENT = "1";
    require("./lib/main.js");
  } else
    app.whenReady().then(() => {
      dialog.showErrorBox(
        "GEA 安装或升级未完成",
        "公司插件安装或升级未完成，已保留配置和恢复材料。请将错误信息交给维护者，并保留用户数据目录。\n" +
          (result.stderr ?? "").slice(-2000),
      );
      app.exit(1);
    });
}
