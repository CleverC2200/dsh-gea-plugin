if (process.channel && process.platform !== "win32") {
  process.once("disconnect", () => process.kill(-process.pid, "SIGTERM"));

  process.channel.unref();
}
