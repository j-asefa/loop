export async function until(fn: () => boolean | Promise<boolean>, ms = 15000) {
  const end = Date.now() + ms;
  while (!(await fn())) {
    if (Date.now() > end) throw new Error("Timed out: " + fn.toString());
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
