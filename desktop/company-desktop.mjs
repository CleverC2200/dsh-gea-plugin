import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { CompanyInstallation } from "./company-installation.mjs";

export async function startCompanyDesktop({
  app,
  dialog,
  root,
  resources,
  loadOfficial,
  runBootstrap,
  trialTimeoutMs = 90_000,
}) {
  const retryInstallation = process.env.GEA_RETRY_INSTALLATION === "1";
  delete process.env.GEA_RETRY_INSTALLATION;
  const bootstrap =
    runBootstrap ??
    ((recover) => {
      const result = spawnSync(
        process.execPath,
        [
          "--expose-internals",
          join(root, "company-bootstrap.mjs"),
          root,
          join(resources, "runtime"),
          join(resources, "company-seed"),
          ...(recover ? ["--recover-installation"] : []),
          ...(!recover && retryInstallation ? ["--retry-installation"] : []),
        ],
        {
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
          maxBuffer: 256_000,
          timeout: recover ? 20_000 : 150_000,
        },
      );
      if (result.error || result.status !== 0)
        throw Error(
          result.error?.code === "ETIMEDOUT"
            ? "GEA_BOOTSTRAP_TIMEOUT"
            : result.stderr?.slice(-2000) || "GEA_BOOTSTRAP_FAILED",
        );
      const line = result.stdout
        .split(/\r?\n/)
        .findLast((value) => value.startsWith("GEA_INSTALLATION_BOOT "));
      const boot = JSON.parse(line?.slice("GEA_INSTALLATION_BOOT ".length) ?? "null");
      if (
        boot?.schema !== 1 ||
        typeof boot.profile !== "string" ||
        typeof boot.coreHead !== "string" ||
        typeof boot.graphId !== "string" ||
        typeof boot.trial !== "boolean"
      )
        throw Error("GEA_BOOTSTRAP_RECEIPT_INVALID");
      return boot;
    });
  let boot;
  try {
    boot = bootstrap(false);
  } catch (error) {
    try {
      boot = bootstrap(true);
    } catch {
      await app.whenReady();
      const result = await dialog.showMessageBox({
        type: "error",
        title: "GEA 启动恢复",
        message: "暂时无法启动可用版本，用户数据和失败记录已保留。",
        detail: String(error.message).slice(-2000),
        buttons: ["重新检查", "退出"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      });
      if (result.response === 0) app.relaunch();
      app.quit();
      return { status: "recovery-required" };
    }
  }
  const installation = new CompanyInstallation(boot.profile, boot.coreHead);
  let timer,
    polling = false,
    finished = false;
  const finish = () => {
    finished = true;
    clearInterval(timer);
  };
  const fail = async (reason) => {
    if (finished) return;
    finish();
    try {
      const result = await installation.rollback(reason);
      if (result.changed) {
        app.relaunch();
        app.quit();
      }
    } catch (error) {
      await app.whenReady();
      await dialog.showMessageBox({
        type: "error",
        title: "GEA 启动恢复",
        message: "恢复记录暂时无法读取，用户数据已保留。",
        detail: String(error.message).slice(-2000),
        buttons: ["退出"],
        noLink: true,
      });
      app.quit();
    }
  };
  if (boot.trial) {
    const deadline = Date.now() + trialTimeoutMs;
    timer = setInterval(async () => {
      if (polling || finished) return;
      polling = true;
      try {
        const state = await installation.store.status();
        if (state.active === boot.graphId && state.verified === boot.graphId && !state.booting)
          finish();
        else if (Date.now() >= deadline) await fail("GEA_TRIAL_STARTUP_TIMEOUT");
      } catch {
        await fail("GEA_TRIAL_STATE_UNREADABLE");
      } finally {
        polling = false;
      }
    }, 250);
    app.on("browser-window-created", (_event, window) => {
      window.webContents.on("did-fail-load", (_event, code, _description, _url, mainFrame) => {
        if (mainFrame && code !== -3) void fail("GEA_TRIAL_PAGE_FAILED");
      });
      window.webContents.on("render-process-gone", () => {
        void fail("GEA_TRIAL_RENDERER_EXITED");
      });
    });
  }
  app.on("before-quit", finish);
  process.env.GEA_COMPANY_CLIENT = "1";
  try {
    loadOfficial();
  } catch (error) {
    await fail("GEA_TRIAL_MAIN_FAILED");
    if (!boot.trial) throw error;
  }
  return { status: "started", boot };
}
