const { spawnSync } = require("node:child_process");
const { join } = require("node:path");
const { app, dialog } = require("electron");
const result = spawnSync(
  process.execPath,
  [
    "--expose-internals",
    join(__dirname, "company-bootstrap.mjs"),
    __dirname,
    join(process.resourcesPath, "runtime"),
    join(process.resourcesPath, "company-seed"),
  ],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    encoding: "utf8",
    windowsHide: true,
  },
);
if (result.status === 0) require("./lib/main.js");
else
  app.whenReady().then(() => {
    dialog.showErrorBox(
      "GEA 首次安装未完成",
      "公司插件未能完成安装。请保留现有配置和回执后重新打开。\n" +
        (result.stderr ?? "").slice(-2000),
    );
    app.exit(1);
  });
