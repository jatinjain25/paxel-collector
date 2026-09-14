import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureBuilderDir,
  ensureConfig,
  loadConfig,
  saveConfig,
  writeSecret,
} from "../src/config.ts";

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "builder-config-"));
}

describe("device identity", () => {
  /**
   * The bug this exists to prevent: nothing called `saveConfig`, so every
   * invocation minted a new `device_id` and two `builder status` runs printed
   * two different ids. Upload idempotency keys on it, so an unstable value
   * would make one machine look like N devices to the leaderboard.
   */
  test("survives the process", async () => {
    const path = join(await tmp(), "config.json");
    const first = await ensureConfig(path);
    const second = await ensureConfig(path);
    expect(first.device_id).toBe(second.device_id);
    expect(first.device_id).toMatch(/^dev_[0-9a-f]{16}$/);
  });

  test("is written to disk, not just returned", async () => {
    const path = join(await tmp(), "config.json");
    const config = await ensureConfig(path);
    const onDisk = JSON.parse(await readFile(path, "utf8")) as { device_id: string };
    expect(onDisk.device_id).toBe(config.device_id);
  });

  test("a config file missing device_id does not overwrite the minted one", async () => {
    // `...raw` used to be spread AFTER `device_id`, so an existing file without
    // the key set it back to undefined.
    const path = join(await tmp(), "config.json");
    await writeFile(path, JSON.stringify({ repo_analysis_enabled: false }), "utf8");
    expect((await loadConfig(path)).device_id).toMatch(/^dev_/);
    expect((await ensureConfig(path)).device_id).toMatch(/^dev_/);
  });

  test("loadConfig stays a pure read and creates nothing", async () => {
    const dir = await tmp();
    const path = join(dir, "nested", "config.json");
    await loadConfig(path);
    await expect(stat(join(dir, "nested"))).rejects.toThrow();
  });
});

describe("permissions", () => {
  // mkdir and writeFile both honour the umask, which is why config.ts chmods
  // explicitly afterwards. These assert the chmod is still there.
  test("the directory is 0700", async () => {
    const dir = join(await tmp(), ".builder");
    await ensureBuilderDir(dir);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
  });

  test("secrets are 0600", async () => {
    const path = join(await tmp(), ".builder", "token");
    await writeSecret(path, "tok_secret");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("the config file holds no secrets", () => {
  test("no key or value looks like a credential", async () => {
    const path = join(await tmp(), "config.json");
    await saveConfig({ ...(await ensureConfig(path)), builder_id: "BLDR-8F42A" }, path);
    const raw = await readFile(path, "utf8");
    for (const key of Object.keys(JSON.parse(raw) as Record<string, unknown>)) {
      expect(key, `config.json must not carry "${key}"`).not.toMatch(/token|secret|^key$/i);
    }
  });
});

describe("api_base_url precedence", () => {
  const ENV = "BUILDER_API_URL";

  test("the environment beats a saved value", async () => {
    const path = join(await tmp(), "config.json");
    await writeFile(path, JSON.stringify({ device_id: "dev_1", api_base_url: "https://saved" }), "utf8");
    process.env[ENV] = "http://localhost:3241";
    try {
      expect((await ensureConfig(path)).api_base_url).toBe("http://localhost:3241");
    } finally {
      delete process.env[ENV];
    }
    // Without the override, the saved value is still what is used.
    expect((await ensureConfig(path)).api_base_url).toBe("https://saved");
  });

  test("an environment override is never written to disk", async () => {
    const path = join(await tmp(), "config.json");
    process.env[ENV] = "http://localhost:3241";
    try {
      const config = await ensureConfig(path);
      await saveConfig(config, path);
      const onDisk = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      // Otherwise a one-off dev override silently becomes permanent.
      expect(onDisk.api_base_url).toBeUndefined();
      expect(onDisk.device_id).toBe(config.device_id);
    } finally {
      delete process.env[ENV];
    }
  });

  test("an explicitly configured value still persists", async () => {
    const path = join(await tmp(), "config.json");
    const config = { ...(await ensureConfig(path)), api_base_url: "https://api.example.com" };
    await saveConfig(config, path);
    const onDisk = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(onDisk.api_base_url).toBe("https://api.example.com");
  });
});
