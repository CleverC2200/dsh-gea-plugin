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

/** Observe the natural Host receipt after the current Core Session owns the loaded Native frame. */
export async function waitForNativeOwner(page, id, resourceId) {
  return page.waitForResponse(async (response) => {
    if (new URL(response.url()).pathname !== "/api/agent-workbench/page") return false;
    const input = response.request().postDataJSON();
    if (input?.operation !== "open" || input.pageId !== id || input.resourceId !== resourceId)
      return false;
    const association = await nativeAssociation(page, id);
    if (association?.sessionId !== input.sessionId || association.preset !== resourceId)
      return false;
    const receipt = await response.json();
    if (!response.ok())
      throw Error(receipt?.error ?? "NATIVE_PAGE_OWNER_FAILED: " + response.status());
    if (typeof receipt?.owner !== "string" || !receipt.owner)
      throw Error("NATIVE_PAGE_OWNER_UNAVAILABLE");
    if (
      typeof receipt.binding?.surface !== "string" ||
      !receipt.binding.surface ||
      typeof receipt.binding.tool !== "string" ||
      !receipt.binding.tool
    )
      throw Error("NATIVE_PAGE_BINDING_UNAVAILABLE");
    return true;
  });
}
