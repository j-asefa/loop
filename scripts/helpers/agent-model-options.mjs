export async function openAgentModelOptions(scope) {
  const options = scope.locator(".create-agent-model-options");
  if ((await options.getAttribute("open")) === null)
    await options.locator("summary").first().click();
  return options;
}

export async function chooseAgentConnection(scope, { provider, id, source }) {
  const options = await openAgentModelOptions(scope);
  let selector = 'input[type="radio"]';
  if (provider) selector += `[data-provider=${JSON.stringify(provider)}]`;
  if (id) selector += `[data-connection-id=${JSON.stringify(id)}]`;
  if (source !== undefined)
    selector += `[data-source-id=${JSON.stringify(source)}]`;
  const choice = options
    .getByRole("radiogroup", { name: "Connection", exact: true })
    .locator(selector)
    .first();
  await choice.check();
  return choice;
}

export async function chooseAgentModel(scope, model) {
  const options = await openAgentModelOptions(scope);
  const choice = options
    .getByRole("radiogroup", { name: "Model", exact: true })
    .locator(`input[value=${JSON.stringify(model)}]`);
  await choice.check();
  return choice;
}
