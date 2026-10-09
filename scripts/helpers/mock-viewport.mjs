// When a fixture changes offsetTop, keep pageTop consistent with it as a real
// viewport normally does. Physical Safari regressions override pageTop again
// to reproduce the device's inconsistent measurements explicitly.
export async function mockViewportCoordinates(page) {
  const install = () =>
    Object.defineProperty(visualViewport, "pageTop", {
      configurable: true,
      get: () => scrollY + visualViewport.offsetTop,
    });
  await page.addInitScript(install);
  await page.evaluate(install);
}
