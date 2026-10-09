/** The registered authoritative task-ticket rule, shared by target and prerequisite observations. */
const statuses = new Set(["ready-for-agent", "in-progress", "blocked", "done"]);
export function observeTaskTicket(input, taskId) {
  const text = input?.bytes?.toString("utf8") ?? "";
  const headers = [...text.matchAll(/^#\s+([a-zA-Z0-9._-]+):/gm)];
  const states = [...text.matchAll(/^\*\*Status:\*\*\s*([a-z-]+)\s*$/gm)];
  const reason =
    input?.error ??
    (headers.length !== 1 || headers[0][1] !== taskId
      ? headers.length > 1
        ? "TASK_TICKET_CONFLICT"
        : "TASK_TICKET_MISMATCH"
      : states.length !== 1 || !statuses.has(states[0][1])
        ? "TASK_STATUS_REQUIRED"
        : null);
  return { status: reason ? "unknown" : states[0][1], reason };
}
