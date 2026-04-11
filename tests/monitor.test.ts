import { describe, it, expect } from "bun:test";
import { app } from "../src/webapp.js";

describe("monitor dashboard", () => {
  describe("GET /monitor", () => {
    it("redirects to /monitor/", async () => {
      const res = await app.request("/monitor");
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/monitor/");
    });
  });

  describe("GET /monitor/", () => {
    it("returns 200 with HTML content", async () => {
      const res = await app.request("/monitor/");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      const text = await res.text();
      expect(text).toContain("Open SWE - Thread Monitor");
    });
  });

  describe("GET /monitor/app.js", () => {
    it("returns JavaScript content", async () => {
      const res = await app.request("/monitor/app.js");
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("javascript");
      const text = await res.text();
      expect(text).toContain("Open SWE Thread Monitor");
      expect(text).toContain("force=true");
      expect(text).toContain("canForceDelete");
    });
  });

});
