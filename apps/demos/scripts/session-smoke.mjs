/**
 * A mesh app, opened in session origins, on the real domains.
 *
 *   node scripts/session-smoke.mjs [--browsers chromium,firefox] [--hub URL] [--app URL]
 *
 * The hub page serves a small app at `/spa` and advertises it; the app page
 * joins, finds it, and opens it TWICE -- two `<random>.p.httpeers.net`
 * origins, each fed over a MessagePort by the app page, each reaching the hub
 * through `pinnedPeer`. Then it checks what an origin of one's own is for:
 *
 *   - the app rendered, from the mesh, inside each session frame;
 *   - each session's worker served it (not the shell's static fallback);
 *   - a root-absolute `/api/hello` reached the hub;
 *   - a GET and a POST addressed to a peer EXPLICITLY, through the session's
 *     mesh mount -- `/peers/<peerId>/spa/api/...` -- reached that peer, and
 *     the POST arrived with its body. That last one is the whole reason this
 *     stage exists: in Firefox there is no `Request.prototype.body`, so a
 *     gateway that streamed the body forwarded an empty one and said nothing;
 *   - a path under `/peers/` naming something that is not a member is
 *     REFUSED, promptly, rather than hanging until the session's deadline;
 *   - localStorage, cookies, IndexedDB and the worker registration of one
 *     session are invisible to the other, and to the app page;
 *   - the app page's own storage is invisible to both sessions;
 *   - a session opened top-level, with no referrer, is refused by its worker.
 *
 * A FRESH PROFILE PER BROWSER, as in `live-smoke.mjs`: always a first visit.
 * It depends on relay.httpeers.net, the shell on p.httpeers.net, and the hub
 * and app pages being published from a build that has the `/spa` mount.
 */

import { chromium, firefox } from "playwright";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const wanted = opt("--browsers", "chromium,firefox").split(",");
const HUB = opt("--hub", "https://hub.httpeers.net/");
const APP = opt("--app", "https://app.httpeers.net/");

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` -- ${detail}` : ""}`);
}

async function waitState(tab, states, timeout) {
  await tab
    .waitForFunction(
      (want) => want.includes(document.querySelector("#state")?.textContent ?? ""),
      states,
      { timeout },
    )
    .catch(() => {});
  return (await tab.textContent("#state"))?.trim();
}

async function mint(hubTab) {
  await hubTab.click("#mint");
  await hubTab.waitForFunction(
    () => {
      const dt = [...document.querySelectorAll("#invitation-rows dt")].find(
        (el) => el.textContent === "blob",
      );
      return (dt?.nextElementSibling?.querySelector("span")?.textContent ?? "") !== "";
    },
    null,
    { timeout: 30_000 },
  );
  return hubTab.evaluate(() => {
    const dt = [...document.querySelectorAll("#invitation-rows dt")].find(
      (el) => el.textContent === "blob",
    );
    return dt?.nextElementSibling?.querySelector("span")?.textContent ?? "";
  });
}

/** What a session frame shows, once its `/api/hello` has answered. */
async function readSession(frame) {
  await frame.waitForFunction(
    () => {
      const api = document.querySelector("#api")?.textContent ?? "…";
      return api !== "…";
    },
    null,
    { timeout: 60_000 },
  );
  return frame.evaluate(() => {
    const t = (id) => document.getElementById(id)?.textContent ?? "";
    return {
      origin: t("origin"),
      visits: t("visits"),
      cookies: t("cookies"),
      worker: t("worker"),
      api: t("api"),
    };
  });
}

/**
 * The three mesh rows, once each has settled.
 *
 * SEPARATE FROM `readSession`, deliberately: these calls are two mesh
 * round-trips further out than `/api/hello`, and folding them into that wait
 * would make a mesh failure report itself as the pinned root failing -- the
 * regression net this smoke has been since 2026-09-18.
 *
 * Every row settles to something (`demo-spa.ts`'s `fail`), so a timeout here
 * means the page never ran, not that a call is slow.
 */
async function readMesh(frame) {
  await frame.waitForFunction(
    () =>
      ["mesh-get", "mesh-post", "mesh-missing"].every(
        (id) => (document.getElementById(id)?.textContent ?? "…") !== "…",
      ),
    null,
    { timeout: 60_000 },
  );
  return frame.evaluate(() => {
    const t = (id) => document.getElementById(id)?.textContent ?? "";
    return { get: t("mesh-get"), post: t("mesh-post"), missing: t("mesh-missing") };
  });
}

/** Everything one origin can see of its own storage, after writing a marker. */
async function probe(frame, marker) {
  return frame.evaluate(async (mark) => {
    localStorage.setItem("probe", mark);
    // biome-ignore lint/suspicious/noDocumentCookie: the probe IS about document.cookie, the API an app would use
    document.cookie = `probe=${mark}; path=/; SameSite=Lax; Secure`;
    await new Promise((resolve, reject) => {
      const open = indexedDB.open(`probe-${mark}`);
      open.onsuccess = () => {
        open.result.close();
        resolve();
      };
      open.onerror = () => reject(open.error);
    });
    return { origin: location.origin };
  }, marker);
}

async function observe(frame) {
  return frame.evaluate(async () => {
    const dbs = indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : ["?"];
    const reg = await navigator.serviceWorker?.getRegistration?.();
    return {
      origin: location.origin,
      probe: localStorage.getItem("probe"),
      cookie: document.cookie,
      dbs: dbs.filter((n) => n?.startsWith("probe-")),
      scope: reg?.scope ?? null,
    };
  });
}

for (const browserName of wanted) {
  console.log(`\n=== ${browserName}`);
  const browser = await { chromium, firefox }[browserName].launch();
  const problems = [];
  try {
    const context = await browser.newContext();
    const watch = (tab, name) => {
      tab.on("pageerror", (e) => problems.push(`${name} PAGEERROR ${e.message}`));
    };

    const hubTab = await context.newPage();
    watch(hubTab, "hub");
    await hubTab.goto(HUB);
    const hubState = await waitState(hubTab, ["ready"], 90_000);
    check(`[${browserName}] hub is ready`, hubState === "ready", hubState);

    const appTab = await context.newPage();
    watch(appTab, "app");
    await appTab.goto(APP);
    await waitState(appTab, ["needs-invitation"], 60_000);
    // The join form is the shared widget's (`@statewalker/httpeers-join`), not
    // this page's own -- `#invite`/`#join` went away with it.
    await appTab.fill(".hp-join-input", await mint(hubTab));
    await appTab.click(".hp-join-submit");
    const appState = await waitState(appTab, ["live", "failed", "blocked"], 120_000);
    check(`[${browserName}] app page joins the hub's mesh`, appState === "live", appState);

    await appTab
      .waitForFunction(() => !document.querySelector("#open-app")?.disabled, null, {
        timeout: 60_000,
      })
      .catch(() => {});
    const provider = (await appTab.textContent("#app-provider"))?.trim();
    check(
      `[${browserName}] the hub's app is discovered`,
      provider?.includes("—") === true,
      provider,
    );

    // Two sessions of the same app: two origins. A session counts as open once
    // its caption has a close button -- the hidden relay iframe lives in the
    // same box and appears before anything has connected.
    for (const n of [1, 2]) {
      await appTab.click("#open-app");
      await appTab
        .waitForFunction(
          (want) =>
            document.querySelectorAll("#sessions figcaption button").length >= want ||
            (document.querySelector("#app-status")?.textContent ?? "").startsWith("could not"),
          n,
          { timeout: 60_000 },
        )
        .catch(() => {});
    }
    await appTab
      .waitForFunction(
        () =>
          [...document.querySelectorAll("#sessions iframe:not([style*='-1000px'])")].length >= 2,
        null,
        { timeout: 30_000 },
      )
      .catch(() => {});
    await appTab.waitForTimeout(2_000);
    const status = (await appTab.textContent("#app-status"))?.trim();
    const frames = appTab.frames().filter((f) => /\.p\.httpeers\.net\/$/.test(f.url()));
    check(
      `[${browserName}] two sessions opened`,
      frames.length === 2,
      `${frames.length} -- ${status}`,
    );
    if (frames.length !== 2) continue;

    const [s1, s2] = await Promise.all(
      frames.map((f) => readSession(f).catch((e) => ({ error: String(e) }))),
    );
    for (const [n, s] of [
      [1, s1],
      [2, s2],
    ]) {
      console.log(`  session ${n}: ${JSON.stringify(s)}`);
      check(
        `[${browserName}] session ${n}: the mesh app renders in a *.p.httpeers.net origin`,
        /^https:\/\/[a-z2-7]{26}\.p\.httpeers\.net$/.test(s.origin ?? ""),
        s.origin ?? s.error,
      );
      check(
        `[${browserName}] session ${n}: served by the session's worker`,
        s.worker === "controlled by /relay-sw.js",
        s.worker,
      );
      check(
        `[${browserName}] session ${n}: root-absolute /api/hello reached the hub`,
        s.api?.startsWith("hello from the hub, over the mesh") === true,
        s.api,
      );
      check(`[${browserName}] session ${n}: its own first visit`, s.visits === "1", s.visits);
    }
    check(`[${browserName}] the two sessions are different origins`, s1.origin !== s2.origin);

    // THE SCENARIO STAGE B1 EXISTS FOR, minus the chat: the app addresses a
    // peer EXPLICITLY, in the path, through the session's `/peers/` mount --
    // not through the pinned root, which resolves to one peer and refuses to
    // be steered. `demo-spa.ts` reads the peer id out of `/api/hello`, so the
    // peer it names is the one that just answered.
    const mesh = await readMesh(frames[0]).catch((e) => ({ error: String(e) }));
    console.log(`  session 1 mesh: ${JSON.stringify(mesh)}`);
    check(
      `[${browserName}] session 1: an explicit /peers/<peer>/ GET reaches the peer`,
      mesh.get?.startsWith("hello from the hub, over the mesh") === true,
      mesh.get ?? mesh.error,
    );
    // IN FIREFOX THIS IS THE CHECK THAT WOULD HAVE FAILED BEFORE TASK 2: no
    // `Request.prototype.body`, so the body arrived empty and silent. Both
    // halves matter -- the echo carries this session's own hostname (so it is
    // this body, not a cached one) and its byte count equals what was sent (so
    // it is the whole body, not a truncated one).
    const host = s1.origin?.replace(/^https:\/\//, "") ?? "";
    const bytes = /(\d+) bytes of (\d+) sent/.exec(mesh.post ?? "");
    check(
      `[${browserName}] session 1: a POST through /peers/ arrives with its body`,
      host !== "" &&
        mesh.post?.includes(host) === true &&
        bytes != null &&
        bytes[1] === bytes[2] &&
        Number(bytes[1]) > 0,
      mesh.post ?? mesh.error,
    );
    // REFUSED, NOT HUNG. The status itself is the member's to choose -- its
    // access guard answers before its empty mount table does -- so what is
    // asserted is that there IS an answer, that it is an error, and that it
    // came back nowhere near the session's 20 s deadline. A hang would show up
    // here as `threw after …` or as `readMesh` timing out, never as a pass.
    const missing = /^(\d+) in (\d+) ms$/.exec(mesh.missing ?? "");
    check(
      `[${browserName}] session 1: a path under /peers/ naming a peer that is not in the mesh is refused, not hung`,
      missing != null && Number(missing[1]) >= 400 && Number(missing[2]) < 10_000,
      mesh.missing ?? mesh.error,
    );

    // Isolation: write a marker in session 1 and on the app page, look from everywhere.
    await probe(frames[0], "one");
    await appTab.evaluate(() => localStorage.setItem("probe", "viewer"));
    const seen1 = await observe(frames[0]);
    const seen2 = await observe(frames[1]);
    console.log(`  session 1 sees: ${JSON.stringify(seen1)}`);
    console.log(`  session 2 sees: ${JSON.stringify(seen2)}`);
    check(`[${browserName}] session 1 reads its own marker`, seen1.probe === "one");
    check(
      `[${browserName}] session 2 sees none of session 1's localStorage, cookies or IndexedDB`,
      seen2.probe === null && !seen2.cookie.includes("probe=one") && seen2.dbs.length === 0,
      JSON.stringify({ probe: seen2.probe, cookie: seen2.cookie, dbs: seen2.dbs }),
    );
    check(
      `[${browserName}] neither session sees the app page's localStorage`,
      seen1.probe !== "viewer" && seen2.probe !== "viewer",
    );
    check(
      `[${browserName}] each session has its own worker registration`,
      seen1.scope === `${s1.origin}/` && seen2.scope === `${s2.origin}/`,
      `${seen1.scope} | ${seen2.scope}`,
    );
    const viewer = await appTab.evaluate(async () => ({
      cookie: document.cookie,
      dbs: indexedDB.databases ? (await indexedDB.databases()).map((d) => d.name) : ["?"],
    }));
    check(
      `[${browserName}] the app page sees none of session 1's cookies or IndexedDB`,
      !viewer.cookie.includes("probe=one") && !viewer.dbs.includes("probe-one"),
      JSON.stringify(viewer),
    );

    // The two attacks the same-origin ghost frame lost to (2026-09-15 spike):
    // reading the viewer's DOM, and navigating the viewer's tab away.
    const hostile = await frames[0].evaluate(() => {
      let dom;
      try {
        dom = `read: ${window.parent.document.title}`;
      } catch (e) {
        dom = `blocked (${e.name})`;
      }
      let nav;
      try {
        window.top.location.href = "https://example.com/";
        nav = "attempted";
      } catch (e) {
        nav = `blocked (${e.name})`;
      }
      return { dom, nav };
    });
    await appTab.waitForTimeout(1_500);
    check(
      `[${browserName}] a session cannot read the app page's DOM`,
      hostile.dom.startsWith("blocked"),
      hostile.dom,
    );
    check(
      `[${browserName}] a session cannot navigate the app page away`,
      appTab.url() === APP,
      `${hostile.nav}; app tab now at ${appTab.url()}`,
    );

    // The same session, opened top-level: no referrer, so its worker refuses.
    const top = await context.newPage();
    const res = await top.goto(`${s1.origin}/`);
    const heading = (await top.textContent("h1").catch(() => ""))?.trim();
    check(
      `[${browserName}] a session opened top-level with no referrer is refused`,
      res?.status() === 403 && heading === "Open this session from its app",
      `${res?.status()} ${heading}`,
    );
    await top.close();

    for (const p of problems) console.log(`  ${p}`);
  } finally {
    await browser.close();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
