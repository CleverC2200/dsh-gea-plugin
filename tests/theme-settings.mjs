/** Click a theme control and wait for the Host's durable settings acknowledgement. */
import assert from "node:assert/strict";
export async function changeThemeSetting(page, label, field) {
  const accepted = page.waitForResponse(response => {
    const body = response.request().postData() ?? "";
    return body.includes('"ui-theme"') && body.includes(`"${field}"`) && response.request().method() === "POST";
  });
  await page.getByRole("button", { name: label, exact: true }).click();
  const response = await accepted;
  assert.equal(response.ok(), true);
  const reply = await response.json();
  assert.equal(reply.result.ok, true, JSON.stringify(reply));
}
