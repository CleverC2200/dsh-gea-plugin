/** Read the current public presentation record; this helper never writes Session or identity state. */
export function nativeAssociation(page, id) {
  return page.evaluate((id) => {
    const presentation = JSON.parse(
      localStorage.getItem("agent-workbench.presentation.v2") ?? "null",
    );
    if (presentation?.version !== 2) return;
    return presentation.selections.find((selection) => selection.page === id && selection.active);
  }, id);
}
