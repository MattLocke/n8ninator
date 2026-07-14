import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import test from "node:test";

test("local server exposes health, prompt, and settings without a login", async (t) => {
  const stateHome = await mkdtemp(resolve(tmpdir(), "n8ninator-state-"));
  process.env.NODE_ENV = "test";
  process.env.N8NINATOR_HOME = stateHome;
  const { app } = await import("../src/server.js");
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolveReady) => server.once("listening", resolveReady));
  t.after(async () => {
    await new Promise((resolveClosed) => server.close(resolveClosed));
    await rm(stateHome, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const health = await fetch(`${base}/api/health`).then((response) => response.json());
  assert.deepEqual(health, { ok: true, app: "n8ninator", version: "0.1.0" });

  const promptResponse = await fetch(`${base}/api/system-prompt`);
  assert.equal(promptResponse.status, 200);
  assert.match(await promptResponse.text(), /meticulous senior n8n engineer/);

  const settingsResponse = await fetch(`${base}/api/settings`);
  assert.equal(settingsResponse.status, 200);
  const settings = await settingsResponse.json() as { model: string; n8nMcp: { tokenConfigured: boolean; accessToken?: string } };
  assert.equal(settings.model, "gpt-oss:20b");
  assert.equal(settings.n8nMcp.tokenConfigured, false);
  assert.equal(settings.n8nMcp.accessToken, undefined);

  const page = await fetch(base).then((response) => response.text());
  assert.match(page, /What should we/);
  assert.match(page, /n8ninator/);
});
