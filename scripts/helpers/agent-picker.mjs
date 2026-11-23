import { expect } from "@playwright/test";

/**
 * Chooses an option in an AgentPicker: opens its sheet from the trigger and
 * clicks the option whose value matches, or the nth agent for { index }.
 */
export async function chooseAgent(trigger, choice) {
  await trigger.click();
  const sheet = trigger.page().locator("dialog.agent-picker-sheet[open]");
  await expect(sheet).toHaveCount(1);
  const options = sheet.locator(".agent-picker-options button");
  await (
    typeof choice === "object"
      ? options.filter({ hasText: /^@/ }).nth(choice.index)
      : options.and(sheet.locator(`[value=${JSON.stringify(choice)}]`))
  ).click();
  await expect(sheet).toHaveCount(0);
}

/** The AgentPicker options' values, in the order the sheet lists them. */
export async function agentPickerValues(trigger) {
  await trigger.click();
  const sheet = trigger.page().locator("dialog.agent-picker-sheet[open]");
  await expect(sheet).toHaveCount(1);
  const values = await sheet
    .locator(".agent-picker-options button")
    .evaluateAll((buttons) => buttons.map((button) => button.value));
  await sheet.getByRole("searchbox", { name: "Search agents" }).press("Escape");
  await expect(sheet).toHaveCount(0);
  return values;
}
