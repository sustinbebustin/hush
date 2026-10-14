import { configDefaults, defineConfig } from "vitest/config"

// Tests run the real CLI as subprocesses; a single test may spawn a dozen.
// `.claude/` holds agent worktrees, each a full copy of the test suite.
export default defineConfig({
  test: { testTimeout: 60_000, exclude: [...configDefaults.exclude, ".claude/**"] },
})
