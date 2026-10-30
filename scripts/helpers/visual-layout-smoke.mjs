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
  const personal = page.getByRole("region", {
    name: "Your profile",
    exact: true,
  });
  const personalArtwork = async () => {
    await expect(personal).toBeVisible();
    await imagesLoaded();
    const portrait = personal.locator(".my-profile-avatar");
    const cover = personal.locator(".profile-cover img");
    await expect
      .poll(() =>
        cover.evaluate((image) => image.complete && image.naturalWidth > 0),
      )
      .toBe(true);
    const avatar = await portrait.locator("img").getAttribute("src");
    for (const nav of await page.locator(".nav-avatar").all()) {
      await expect(nav.locator("img")).toHaveAttribute("src", avatar);
      await expect(nav).toHaveAttribute(
        "style",
        await portrait.getAttribute("style"),
      );
    }
    return { avatar, cover: await cover.getAttribute("src") };
  };
  await page.goto(fixture.base + "/?page=profile", {
    waitUntil: "networkidle",
  });
  const accountName = await personal.locator("h1").textContent();
  const accountArtwork = await personalArtwork();
  await fixture.api("/later", {
    kind: "artifact",
    targetId: fixture.artifacts[0],
    condition: "time",
    dueAt: Date.now() + 24 * 3600000,
  });
  await page.route("**/api/social/unread", (route) =>
    route.fulfill({ json: { unread: 99 } }),
  );
  // An already-open pre-upgrade tab must receive the new robot at its old URL.
  assert(accountArtwork.avatar.startsWith("/avatars/robots/"));
  const legacyAvatar = accountArtwork.avatar.replace(
    "/avatars/robots/",
    "/avatars/",
  );
  const [currentImage, legacyImage] = await Promise.all([
    page.request.get(fixture.base + accountArtwork.avatar),
    page.request.get(fixture.base + legacyAvatar),
  ]);
  for (const response of [currentImage, legacyImage]) {
    assert.equal(response.status(), 200);
    assert.match(response.headers()["content-type"], /^image\/webp/);
  }
  assert.deepEqual(await legacyImage.body(), await currentImage.body());
  assert.deepEqual(
    await page.evaluate(async (source) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }, legacyAvatar),
    [384, 384],
  );
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
      await expect(page.locator(".drawer-account .avatar img")).toHaveAttribute(
        "src",
        accountArtwork.avatar,
      );
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
      assert.deepEqual(await personalArtwork(), accountArtwork);
      const status = page.locator(".workspace-connection");
      await expect(status).toHaveText("Connected to workspace");
      const connectionBox = await status.boundingBox();
      const personalCover = await page
        .locator(".my-profile .profile-cover")
        .boundingBox();
      assert(
        connectionBox.y + connectionBox.height <= personalCover.y,
        "The profile cover must stay below the entire connection status",
      );
      const personalAvatar = await personal
        .locator(".my-profile-avatar")
        .boundingBox();
      const edit = await personal
        .getByRole("button", { name: "Edit profile", exact: true })
        .boundingBox();
      assert(
        personalAvatar.y < personalCover.y + personalCover.height &&
          personalAvatar.y + personalAvatar.height >
            personalCover.y + personalCover.height,
        "Your avatar overlaps the banner",
      );
      assert(
        edit.x >= personalAvatar.x + personalAvatar.width && edit.height >= 44,
        "Edit profile stays clear of your avatar and keeps a touch-sized target",
      );
      const compose = await personal
        .getByRole("button", { name: "Compose a message", exact: true })
        .boundingBox();
      assert(
        compose.x >= edit.x + edit.width + 8 &&
          compose.width >= 44 &&
          compose.height >= 44,
        "Compose stays beside Edit profile with a separate touch-sized target",
      );
      await expect(
        page.locator(".main-column > .composer-dock .composer-launch"),
      ).toBeHidden();
      const tabs = personal.getByRole("tablist", { name: "Show" });
      const social = tabs.getByRole("tab", { name: /^Social/ });
      await expect(social.locator(".chip-count")).toHaveText("99");
      await social.scrollIntoViewIfNeeded();
      const label = await social.locator("span").first().boundingBox();
      const badge = await social.locator(".chip-count").boundingBox();
      assert(
        badge.x >= label.x + label.width + 6,
        "The Social count must have space after its label",
      );
      for (const name of ["Scheduled", "Reminders"]) {
        await tabs.getByRole("tab", { name, exact: true }).click();
        const hint = personal.locator(".later-page > .section-hint");
        await expect(hint).toBeVisible();
        const tabBar = await tabs.boundingBox();
        const description = await hint.boundingBox();
        assert(
          description.y >= tabBar.y + tabBar.height + 16,
          `${name} description stays below the tab divider with room to read`,
        );
      }
      await expect(personal.locator(".later-card")).toBeVisible();
      await fits();
      await page.evaluate(() => window.scrollTo(0, 0));
      await capture(`personal-reminders-${theme}-${width}`);
    }
  }
  // Moving the entrypoint must retain the same unsent composer draft.
  await page.setViewportSize({ width: 390, height: 844 });
  const compose = personal.getByRole("button", {
    name: "Compose a message",
    exact: true,
  });
  await page.evaluate(
    ({ owner, agentId }) =>
      localStorage.setItem(
        `loop55-last-recipient:${JSON.stringify([owner, "laptop"])}`,
        agentId,
      ),
    { owner: fixture.owner, agentId: fixture.agents[0].id },
  );
  await compose.click();
  const draft = page.locator(".main-column #composer");
  await expect(draft).toBeFocused();
  await expect(page.getByLabel("Agent recipient", { exact: true })).toHaveValue(
    fixture.agents[0].id,
  );
  await draft.fill("Keep this draft while I read reminders.");
  await page
    .getByRole("button", { name: "Collapse composer", exact: true })
    .click();
  await expect(compose).toHaveClass(/has-draft/);
  await compose.click();
  await expect(draft).toHaveValue("Keep this draft while I read reminders.");
  await draft.fill("");
  await page
    .getByRole("button", { name: "Collapse composer", exact: true })
    .click();
  await expect(compose).not.toHaveClass(/has-draft/);
  // Saving a display name updates all personal artwork; clearing it restores
  // the account identity, including after a reload.
  const editName = async (name) => {
    await personal
      .getByRole("button", { name: "Edit profile", exact: true })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Edit profile",
      exact: true,
    });
    await editor.getByRole("textbox", { name: "Name", exact: true }).fill(name);
    await editor
      .getByRole("button", { name: "Save profile", exact: true })
      .click();
    await expect(editor).toBeHidden();
  };
  fixture.db
    .prepare("DELETE FROM request_limits WHERE owner_id=?")
    .run(fixture.owner);
  await editName("Iris");
  await expect(personal.locator("h1")).toHaveText("Iris");
  const savedArtwork = {
    avatar: "/avatars/robots/iris.webp",
    cover: "/profile-covers/iris-scene.webp",
  };
  assert.deepEqual(await personalArtwork(), savedArtwork);
  await openSettings(page);
  await expect(page.locator(".drawer-account .avatar img")).toHaveAttribute(
    "src",
    savedArtwork.avatar,
  );
  await closeSheets(page);
  await page.reload({ waitUntil: "networkidle" });
  await expect(personal.locator("h1")).toHaveText("Iris");
  assert.deepEqual(await personalArtwork(), savedArtwork);
  await editName("");
  await expect(personal.locator("h1")).toHaveText(accountName);
  assert.deepEqual(await personalArtwork(), accountArtwork);
  await page.reload({ waitUntil: "networkidle" });
  assert.deepEqual(await personalArtwork(), accountArtwork);
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
  await page.route("**/avatars/robots/*.webp", (route) => route.abort());
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
  await page.goto(fixture.base + "/?page=profile");
  await expect(personal.locator(".my-profile-avatar img")).toBeHidden();
  await expect(
    personal.locator(".my-profile-avatar .avatar-fallback"),
  ).not.toBeEmpty();
  await expect(personal.locator(".profile-cover img")).toBeHidden();
  await expect(personal.locator(".profile-cover")).toBeVisible();
  await expect(
    personal.getByRole("button", { name: "Edit profile", exact: true }),
  ).toBeVisible();
  await capture("personal-profile-fallback");
  await fits();
}
