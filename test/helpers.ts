export async function until(fn: () => boolean, ms = 15000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Timed out: " + fn.toString());
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
