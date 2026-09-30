/** Current public theme interface fixture, with no DOM-derived state. */
export function createThemeClient() {
  let snapshot = { fontSize: 14, active: { colorScheme: 'light', tokens: {} } };
  const listeners = new Set();
  return {
    theme: { getTheme: () => snapshot },
    on(event, listener) { if (event !== 'theme/change') throw Error('Unexpected event: ' + event); listeners.add(listener); return () => listeners.delete(listener); },
    publish(next) { snapshot = next; for (const listener of listeners) listener(next); },
    listenerCount: () => listeners.size,
  };
}
