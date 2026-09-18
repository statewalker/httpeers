/**
 * The deployed pages, against the deployed relay. The post-deploy check.
 *
 *   node scripts/live-smoke.mjs
 *
 * Identical in shape to `join-smoke.mjs`, and deliberately so: that one serves
 * the BUILT pages from four local ports, this one opens the four real domains.
 * Keeping the flow the same is what makes a difference between them mean
 * something -- if this fails where that passed, the deployment is what changed,
 * not the code.
 *
 * It answers the question a byte-comparison cannot: `curl` proves the right
 * HTML was published, not that four browser tabs on four different ORIGINS can
 * find each other over a real WebRTC circuit. Each domain gets its own
 * ServiceWorker scope, which is the arrangement the edge exists for and the
 * one no local test fully reproduces.
 *
 * A FRESH BROWSER PROFILE EVERY RUN. Playwright's default context starts
 * empty, so no ServiceWorker registration, IndexedDB identity or stored route
 * survives from a previous run -- this always measures a FIRST visit. A
 * returning visitor carries the old deployment's worker until it updates;
 * `/reset.html` on each origin is the remedy, and testing that path needs a
 * persistent profile, which this does not use.
 */

import { chromium } from "playwright";
import { solidPng } from "./lib/png.mjs";

const SITES = {
  hub: "https://hub.httpeers.net/",
  images: "https://images.httpeers.net/",
  app: "https://app.httpeers.net/",
  proxy: "https://proxy.httpeers.net/",
};

const browser = await chromium.launch();
const problems = [];

/** Mint one invitation and return its blob, waiting until it differs from `previous`. */
async function mint(tab, previous) {
  await tab.click("#mint");
  await tab.waitForSelector("#invitation:not([hidden])", { timeout: 30_000 });
  // Invitations are single-use, and reading the blob straight after the click
  // races `invitations.create` -- handing the next page one already redeemed.
  await tab.waitForFunction(
    (before) => {
      const rows = [...document.querySelectorAll("#invitation-rows dt")];
      const dt = rows.find((el) => el.textContent === "blob");
      const value = dt?.nextElementSibling?.querySelector("span")?.textContent ?? "";
      return value !== "" && value !== before;
    },
    previous,
    { timeout: 30_000 },
  );
  return tab.evaluate(() => {
    const rows = [...document.querySelectorAll("#invitation-rows dt")];
    const dt = rows.find((el) => el.textContent === "blob");
    return dt?.nextElementSibling?.querySelector("span")?.textContent ?? "";
  });
}

function watch(tab, name) {
  tab.on("pageerror", (e) => problems.push(`${name} PAGEERROR ${e.message}`));
  tab.on("console", (m) => {
    if (m.type() === "error") problems.push(`${name} CONSOLE ${m.text()}`);
  });
}

/** Open a domain and wait for the page to reach one of `states`. */
async function open(name, states, timeout = 90_000) {
  const tab = await browser.newPage();
  watch(tab, name);
  await tab.goto(SITES[name]);
  await tab
    .waitForFunction(
      (want) => want.includes(document.querySelector("#state")?.textContent ?? ""),
      states,
      { timeout },
    )
    .catch(() => {});
  return tab;
}

const joined = async (tab, blob) => {
  await tab.fill(".hp-join-input", blob);
  await tab.click(".hp-join-submit");
  await tab
    .waitForFunction(
      () =>
        ["live", "failed", "blocked"].includes(document.querySelector("#state")?.textContent ?? ""),
      { timeout: 120_000 },
    )
    .catch(() => {});
  return (await tab.textContent("#state"))?.trim();
};

try {
  const hubTab = await open("hub", ["ready"]);
  const meshId = (await hubTab.textContent("#mesh-id"))?.trim();
  console.log(`hub      : ${(await hubTab.textContent("#state"))?.trim()} — ${meshId}`);

  const blob = await mint(hubTab, "");
  console.log(`invite   : ${blob.slice(0, 40)}… (${blob.length} chars)`);

  const imagesTab = await open("images", ["needs-invitation"], 60_000);
  const imagesState = await joined(imagesTab, blob);
  const imagesPeer = (await imagesTab.textContent("#peer-id"))?.trim();
  console.log(`images   : ${imagesState} — ${imagesPeer}`);

  if (imagesState === "live") {
    await hubTab
      .waitForFunction(
        (id) => document.querySelector("#members")?.textContent?.includes(id) === true,
        imagesPeer,
        { timeout: 30_000 },
      )
      .catch(() => {});
    const members = (await hubTab.textContent("#members"))?.trim() ?? "";
    console.log(`hub sees : ${members.includes(imagesPeer) ? "the member" : "NOBODY"}`);
  }

  const appTab = await open("app", ["needs-invitation"], 60_000);
  // Each mint waits for a blob that differs from the LAST ONE MINTED. Passing
  // anything else -- "" in particular -- hands over an invitation already
  // redeemed by the previous page, whose join is then correctly refused.
  const appBlob = await mint(hubTab, blob);
  const appState = await joined(appTab, appBlob);
  console.log(`app      : ${appState} — ${(await appTab.textContent("#peer-id"))?.trim()}`);

  // The provider arrives on this page's own heartbeat, not instantly.
  await appTab
    .waitForFunction(
      () => (document.querySelector("#images-provider")?.textContent ?? "").includes("—"),
      {
        timeout: 60_000,
      },
    )
    .catch(() => {});
  console.log(`discovers: ${(await appTab.textContent("#images-provider"))?.trim()}`);

  await appTab.click("#load-images");
  await appTab
    .waitForFunction(
      () => {
        const t = document.querySelector("#images-status")?.textContent ?? "";
        return t !== "" && t !== "loading…";
      },
      { timeout: 90_000 },
    )
    .catch(() => {});
  const rendered = await appTab.evaluate(() => document.querySelectorAll("#gallery img").length);
  console.log(
    `app calls: ${(await appTab.textContent("#images-status"))?.trim()} (${rendered} <img> rendered)`,
  );

  // COUNTING <img> ELEMENTS IS NOT PROOF. A broken src still renders an element,
  // so a provider serving HTML error pages as image/jpeg would read as success.
  // `naturalWidth` is non-zero only once the browser has actually DECODED the
  // bytes -- and these bytes came over the mesh, so it is the whole path.
  // Waits for EVERY picture, not the first: over a real WebRTC circuit they
  // arrive one after another, and sampling on the first decode reported 2/4
  // for images that were merely still in flight. A timeout here means a
  // picture genuinely did not arrive, which is what the count then says.
  await appTab
    .waitForFunction(
      () => {
        const imgs = [...document.querySelectorAll("#gallery img")];
        return imgs.length > 0 && imgs.every((i) => i.naturalWidth > 0);
      },
      { timeout: 60_000 },
    )
    .catch(() => {});
  const decoded = await appTab.evaluate(() =>
    [...document.querySelectorAll("#gallery img")].map(
      (i) => `${i.naturalWidth}x${i.naturalHeight}`,
    ),
  );
  const good = decoded.filter((d) => !d.startsWith("0x")).length;
  console.log(`decoded  : ${good}/${decoded.length} — ${decoded.join(" ") || "none"}`);

  await appTab.fill("#query", "relay");
  await appTab.click("#do-search");
  await appTab
    .waitForFunction(
      () => {
        const t = document.querySelector("#search-status")?.textContent ?? "";
        return t !== "" && t !== "searching…";
      },
      { timeout: 90_000 },
    )
    .catch(() => {});
  console.log(`app search: ${(await appTab.textContent("#search-status"))?.trim()}`);

  // --- a picture the person CHOSE, served to another peer ------------------
  // The strongest claim this demo makes: bytes that were never on the web,
  // handed to one browser through a file picker, fetched by another browser
  // over the mesh. Asserted by DIMENSION -- nothing else in the gallery is
  // 123x45 -- so a stale picture or a placeholder cannot pass for it.
  const CUSTOM = { w: 123, h: 45 };
  await imagesTab.setInputFiles("#pick-file", {
    name: "chosen-by-hand.png",
    mimeType: "image/png",
    buffer: solidPng(CUSTOM.w, CUSTOM.h),
  });
  await imagesTab
    .waitForFunction(
      () => (document.querySelector("#pick-status")?.textContent ?? "").startsWith("Added"),
      { timeout: 30_000 },
    )
    .catch(() => {});
  console.log(`picked   : ${(await imagesTab.textContent("#pick-status"))?.trim() || "NOTHING"}`);

  // Re-ask the provider. Its catalogue is resolved per REQUEST, so a picture
  // added mid-session is listable the moment its bytes are written -- no
  // rejoin, no reload, nothing restarted.
  await appTab.click("#load-images");
  const arrived = (want) =>
    [...document.querySelectorAll("#gallery img")].some(
      (i) => i.naturalWidth === want.w && i.naturalHeight === want.h,
    );
  await appTab.waitForFunction(arrived, CUSTOM, { timeout: 60_000 }).catch(() => {});
  const gotCustom = await appTab.evaluate(arrived, CUSTOM);
  console.log(
    `custom   : ${gotCustom ? `the chosen picture arrived (${CUSTOM.w}x${CUSTOM.h})` : "DID NOT ARRIVE"}`,
  );

  const proxyTab = await open("proxy", ["needs-invitation"], 60_000);
  const proxyState = await joined(proxyTab, await mint(hubTab, appBlob));
  console.log(`proxy    : ${proxyState}`);

  // The relay's own well-known document: a real, CORS-open origin that is
  // certainly up, since every page above just read it to get here.
  if (proxyState !== "live") {
    // The route form is hidden until the page joins, so filling it would throw
    // and lose every result above. Say what happened instead.
    console.log("proxied  : SKIPPED — the proxy page never joined");
  } else {
    await proxyTab.fill("#route-prefix", "/relay");
    await proxyTab.fill("#route-upstream", "https://relay.httpeers.net/.well-known");
    await proxyTab.click("#add-route");
    await proxyTab
      .waitForFunction(
        () => (document.querySelector("#route-status")?.textContent ?? "").startsWith("added"),
        {
          timeout: 20_000,
        },
      )
      .catch(() => {});
    await proxyTab.fill("#console-path", "/relay/httpeers-relay.json");
    await proxyTab.click("#console-send");
    await proxyTab
      .waitForFunction(
        () => (document.querySelector("#console-output")?.textContent ?? "") !== "",
        {
          timeout: 60_000,
        },
      )
      .catch(() => {});
    const out = ((await proxyTab.textContent("#console-output")) ?? "").trim();
    console.log(
      `proxied  : ${out.split("\n")[0]} — ${out.includes("relayAddrs") ? "got the upstream body" : "NO BODY"}`,
    );
  }

  if (problems.length > 0)
    console.log(`problems : ${problems.slice(0, 6).join(" | ").slice(0, 900)}`);
  process.exitCode =
    imagesState === "live" && appState === "live" && proxyState === "live" && gotCustom ? 0 : 1;
} finally {
  await browser.close();
}
