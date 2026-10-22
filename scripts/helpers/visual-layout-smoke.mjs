import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { closeSheets, openSettings } from "./browser-ui.mjs";

// Exercise the production layout with real fixture data, including narrow
// phones, both themes, image loading, and the profile's existing entrypoints.
export async function visualLayoutSmoke(page, fixture, engine, capture) {
  const agent = fixture.agents[1];
  const fits = async () =>
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      "The page must not scroll horizontally",
    );
  const imagesLoaded = async () => {
    await expect
      .poll(() =>
        page
          .locator(".avatar-3d img")
          .evaluateAll(
            (images) =>
              images.length > 0 &&
              images.every((image) => image.complete && image.naturalWidth > 0),
          ),
      )
      .toBe(true);
  };
  const covers = new Set();
  for (const candidate of fixture.agents.slice(0, 6)) {
    await page.goto(fixture.base, { waitUntil: "networkidle" });
    await page
      .locator(".agent-strip button")
      .filter({ hasText: candidate.name })
      .click();
    const cover = page.locator(".profile-head .profile-cover img");
    await expect
      .poll(() =>
        cover.evaluate((image) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    const source = await cover.getAttribute("src");
    covers.add(source);
    await page.reload({ waitUntil: "networkidle" });
    await page
      .locator(".agent-strip button")
      .filter({ hasText: candidate.name })
      .click();
    await expect(cover).toHaveAttribute("src", source);
    await capture(`agent-cover-${candidate.name}`);
  }
  assert(
    covers.size > 1,
    "Different agents receive varied, stable profile covers",
  );
  for (const width of [320, 390, 768, 1280, 1440, 1600, 1920]) {
    // These independent layout cases share one fixture owner and run much
    // faster than manual navigation; keep its API request budget per case.
    fixture.db
      .prepare("DELETE FROM request_limits WHERE owner_id=?")
      .run(fixture.owner);
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["light", "dark"]) {
      await page.goto(fixture.base, { waitUntil: "networkidle" });
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await imagesLoaded();
      await fits();
      await expect(page.getByLabel("Filter by project")).toBeInViewport({
        ratio: 1,
      });
      if (width > 650) {
        const sidebar = await page.locator(".sidebar").boundingBox();
        const main = await page.locator(".main-column").boundingBox();
        const dock = await page
          .locator(".main-column > .composer-dock")
          .boundingBox();
        assert(
          Math.abs(sidebar.x + sidebar.width - main.x) < 1,
          "Sidebar stays adjacent to the main column",
        );
        assert(
          Math.abs(dock.x - main.x) < 1 &&
            Math.abs(dock.x + dock.width - main.x - main.width) < 1,
          "Composer follows the centered main column at wide widths",
        );
      }
      const shortcut = page
        .locator(".agent-strip button")
        .filter({ hasText: agent.name });
      const avatarSource = await shortcut
        .locator(".avatar img")
        .getAttribute("src");
      const avatarColor = await shortcut
        .locator(".avatar")
        .getAttribute("style");
      await shortcut.click();
      const profile = page.locator(".profile-head");
      await expect(profile.locator("h1")).toHaveText(agent.name);
      await expect(profile.locator(".profile-handle")).toHaveText(
        "@" + agent.name,
      );
      await imagesLoaded();
      await expect(profile.locator(".avatar img")).toHaveAttribute(
        "src",
        avatarSource,
      );
      await expect(profile.locator(".avatar")).toHaveAttribute(
        "style",
        avatarColor,
      );
      await expect
        .poll(() =>
          profile
            .locator(".profile-cover img")
            .evaluate((image) => image.complete && image.naturalWidth > 0),
        )
        .toBe(true);
      const cover = await profile.locator(".profile-cover").boundingBox();
      const avatar = await profile.locator(":scope > .avatar").boundingBox();
      const message = profile.getByRole("button", {
        name: "Message",
        exact: true,
      });
      const button = await message.boundingBox();
      assert(
        avatar.y < cover.y + cover.height &&
          avatar.y + avatar.height > cover.y + cover.height,
        "Avatar overlaps the cover",
      );
      assert(
        button.x >= avatar.x + avatar.width,
        "Message action must not overlap the avatar",
      );
      assert(
        button.height >= 44,
        "Message action retains a touch-sized target",
      );
      await fits();
      await capture(`profile-layout-${theme}-${width}`);
      for (const name of [
        "Threads",
        "Messages",
        "Agent mail",
        "Files",
        "Traces",
        "Results",
      ]) {
        const tab = page
          .locator(".profile-tabs")
          .getByRole("tab", { name, exact: true });
        await tab.click();
        await expect(tab).toHaveAttribute("aria-selected", "true");
        await fits();
      }
      await message.click();
      await expect(
        page.getByLabel("Agent recipient", { exact: true }),
      ).toHaveValue(agent.id);
      await page
        .getByRole("button", { name: "Collapse composer", exact: true })
        .click();
      await openSettings(page);
      await page
        .getByRole("button", { name: "Manage agents", exact: true })
        .click();
      const directory = page.getByRole("dialog", {
        name: "Your agents",
        exact: true,
      });
      await directory
        .getByRole("searchbox", { name: "Search agents", exact: true })
        .fill(agent.name);
      const row = directory
        .locator(".project-agent")
        .filter({ hasText: agent.name });
      await expect(row).toHaveCount(1);
      await expect(row.locator(".avatar img")).toHaveAttribute(
        "src",
        avatarSource,
      );
      await capture(`agent-directory-${theme}-${width}`);
      await closeSheets(page);
      await page.goto(fixture.base + "/?page=profile", {
        waitUntil: "networkidle",
      });
      await page.evaluate(
        (theme) => (document.documentElement.dataset.theme = theme),
        theme,
      );
      await expect(
        page.getByRole("region", { name: "Your profile", exact: true }),
      ).toBeVisible();
      await expect(
        page.locator(".my-profile .profile-cover img"),
      ).toHaveAttribute("src", "/profile-cover.webp");
      await fits();
      await capture(`personal-profile-${theme}-${width}`);
    }
  }
  if (engine === "chromium") {
    // Exercise the real CSS env() values at the mobile/tablet breakpoints.
    const session = await page.context().newCDPSession(page);
    const top = 47;
    try {
      await session.send("Emulation.setSafeAreaInsetsOverride", {
        insets: { top },
      });
      await page.goto(fixture.base, { waitUntil: "networkidle" });
      for (const width of [390, 650, 651, 680, 700]) {
        await page.setViewportSize({ width, height: 900 });
        const toolbar = page.locator(".topbar");
        const settings = toolbar.getByRole("button", {
          name: "Open settings",
          exact: true,
        });
        await expect(settings).toBeInViewport({ ratio: 1 });
        const bar = await toolbar.boundingBox();
        const control = await settings.boundingBox();
        assert(
          control.y >= top && control.y + control.height <= bar.y + bar.height,
          "Header actions stay below the safe area and inside the toolbar",
        );
        await fits();
        await capture(`header-safe-area-${width}`);
      }
    } finally {
      await session.send("Emulation.setSafeAreaInsetsOverride", { insets: {} });
      await session.detach();
    }
  }
  // A missing image leaves a readable local fallback, without an external request.
  await page.route("**/avatars/*.webp", (route) => route.abort());
  await page.goto(fixture.base);
  await expect(page.locator(".your-agents .avatar-3d").first()).toBeVisible();
  await expect(
    page.locator(".your-agents .avatar-3d img").first(),
  ).toBeHidden();
  await expect(
    page.locator(".your-agents .avatar-fallback").first(),
  ).not.toBeEmpty();
  await page.route(/\/profile-cover(?:s\/[^/]+)?\.webp$/, (route) =>
    route.abort(),
  );
  await page
    .locator(".agent-strip button")
    .filter({ hasText: agent.name })
    .click();
  const profile = page.locator(".profile-head");
  await expect(profile.locator(".profile-cover img")).toBeHidden();
  await expect(profile.locator(".profile-cover")).toBeVisible();
  await expect(
    profile.getByRole("button", { name: "Message", exact: true }),
  ).toBeVisible();
  await capture("profile-cover-fallback");
  await fits();
}
