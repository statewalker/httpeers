import { describe, expect, it } from "vitest";
import { SERVICE_MARKER, type ServiceEntry, serviceTable } from "../src/service-table.js";

const answering = (body: string) => async () => new Response(body);

function table(services: ServiceEntry[]) {
  return serviceTable(() => services, { sharerName: "Dirk" });
}

describe("serviceTable", () => {
  const services: ServiceEntry[] = [
    { id: "wiki", name: "Team wiki", upstream: answering("wiki"), enabled: true, isDefault: false },
    { id: "foo", name: "fooService", upstream: answering("foo"), enabled: true, isDefault: true },
  ];

  it("lists the catalog at /s/, the Default Service first", async () => {
    const res = await table(services)(new Request("http://sharer/s/"));
    expect(await res.json()).toEqual([
      { id: "foo", name: "fooService", isDefault: true, paused: false },
      { id: "wiki", name: "Team wiki", isDefault: false, paused: false },
    ]);
  });

  it("routes /s/<id>/… to that Service", async () => {
    expect(await (await table(services)(new Request("http://sharer/s/wiki/page"))).text()).toBe(
      "wiki",
    );
  });

  it("answers a paused Service with Dirk's paused page, marked", async () => {
    const paused = services.map((s) => (s.id === "foo" ? { ...s, enabled: false } : s));
    const res = await table(paused)(new Request("http://sharer/s/foo/"));
    expect(res.status).toBe(503);
    expect(res.headers.get(SERVICE_MARKER)).toBe("paused");
    expect(await res.text()).toContain("Dirk paused fooService");
  });

  it("answers an unknown Service with a marked 404, and escapes the id it echoes", async () => {
    const res = await table(services)(new Request("http://sharer/s/%3Cb%3E/"));
    expect(res.status).toBe(404);
    expect(res.headers.get(SERVICE_MARKER)).toBe("unknown");
    expect(await res.text()).not.toContain("<b>");
  });
});

describe("serviceTable, the Sharer's name", () => {
  it("is read per request when given as a function", async () => {
    let name = "";
    const t = serviceTable(
      () => [{ id: "foo", name: "foo", upstream: answering("x"), enabled: false, isDefault: true }],
      { sharerName: () => name },
    );
    name = "Dirk";
    expect(await (await t(new Request("http://sharer/s/foo/"))).text()).toContain(
      "Dirk paused foo",
    );
  });
});
