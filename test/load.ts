import assert from "node:assert/strict"
import { mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const root = fileURLToPath(new URL("..", import.meta.url))
const home = mkdtempSync(join(tmpdir(), "agents-load-"))
process.env.HOME = home
process.env.PI_OFFLINE = "1"
process.env.PI_TELEMETRY = "0"

// Imported after HOME is set, so Pi resolves its directories under it.
const { DefaultResourceLoader, SessionManager, SettingsManager, createAgentSession } = await import(
  "@earendil-works/pi-coding-agent"
)

test("load: the package's extensions and skills load into a real session", async () => {
  const settingsManager = SettingsManager.inMemory({ packages: [root] })
  const resourceLoader = new DefaultResourceLoader({
    cwd: home,
    agentDir: join(home, ".pi/agent"),
    settingsManager,
    noContextFiles: true,
  })
  await resourceLoader.reload()

  const { session, extensionsResult } = await createAgentSession({
    cwd: home,
    resourceLoader,
    settingsManager,
    sessionManager: SessionManager.inMemory(),
  })
  try {
    assert.deepEqual(extensionsResult.errors, [])
    const loaded = extensionsResult.extensions.map((e) => e.path.split("/").at(-2)).sort()
    const expected = readdirSync(join(root, "extensions"), { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name !== "lib")
      .map((d) => d.name)
      .sort()
    assert.deepEqual(loaded, expected)
    const skills = resourceLoader.getSkills().skills.map((s) => s.name).sort()
    assert.deepEqual(skills, readdirSync(join(root, "skills")).sort())
  } finally {
    session.dispose()
  }
})
