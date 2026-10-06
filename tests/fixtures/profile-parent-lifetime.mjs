/** Only profile.mjs preloads this in its detached POSIX process-group leader. */
if (process.channel && process.platform !== "win32") {
  // Owner disappearance bypasses t.after; use the group's existing normal stop path.
  process.once("disconnect", () => process.kill(-process.pid, "SIGTERM"));
  // The ownership channel must not keep a normally completed wrapper alive.
  process.channel.unref();
}
