---
name: backend-dev
description: Enforce test-driven development for backend features and bug fixes using strict Red-Green-Refactor cycle
allowed-tools: read_file write_file edit_file glob grep commit_and_open_pr
compatibility: Project must have a test runner configured and test commands documented in CLAUDE.md or AGENTS.md
---

## Backend Development Skill

Use this skill when the task involves:

- Implementing new backend features (APIs, services, models, utilities)
- Fixing backend bugs (logic errors, regressions, edge cases)
- Refactoring existing backend code with safety guarantees
- Adding or modifying database models, business logic, or integration layers

**This skill enforces Test-Driven Development (TDD) as the primary approach.** You must write tests before implementation code. No exceptions for features or bug fixes.

### Prerequisites

Before using this skill, verify the following:

**1. Test Framework Discovery**

The project MUST have test commands documented. Check in this priority order:

1. **`CLAUDE.md` or `AGENTS.md`** in the repository root — look for "Testing" or "Test Commands" sections
2. **`Makefile`** — look for `test`, `tests`, or `test-*` targets
3. **Package configuration** — `package.json` scripts, `pyproject.toml` [tool.pytest], `go.mod`, etc.
4. **CI configuration** — `.github/workflows/`, `.gitlab-ci.yml` for how tests are run

**Required information:**
- Test runner command (e.g., `pytest`, `npm test`, `go test`)
- How to run a single test file
- How to run a specific test by name
- Any required flags for CI-friendly output (no colors, no coverage)

**2. Test Location and Naming**

Check the project conventions for:
- Test directory structure (`tests/`, `__tests__/`, `*_test.go`, etc.)
- Test file naming patterns
- Test function naming conventions

**3. Sandbox Environment**

All test execution happens in the remote sandbox. Default timeout is 300 seconds.

### TDD Workflow Overview

TDD follows a strict **Red-Green-Refactor** cycle. Complete each phase before moving to the next:

```
1. RED      - Write a failing test that defines the desired behavior
2. GREEN    - Write the minimum implementation code to make the test pass
3. REFACTOR - Clean up the code while keeping all tests green
```

**Critical rules:**

- NEVER write implementation code before a failing test exists
- NEVER skip the RED phase — the test MUST fail first
- NEVER skip running the test to confirm it fails (RED) or passes (GREEN)
- After each cycle, run ALL related tests to confirm nothing is broken
- Repeat the cycle for each new behavior or requirement

### Feature Implementation Process

#### Step 1: Understand Requirements

Before writing code:

1. Read the task description carefully
2. Identify specific behaviors the feature must exhibit
3. Break the feature into small, testable behavior slices
4. For each slice, define: given (setup), when (action), then (assertion)
5. Check project documentation for conventions

#### Step 2: RED — Write a Failing Test

Write a test that defines the next behavior slice. The test must:

1. Be placed in the project's test directory following its naming convention
2. Test ONE behavior slice per test function
3. Follow the project's existing test style and patterns
4. Use descriptive test names that read as specifications

**Example test names:**

- `test_returns_404_when_user_not_found` (Python)
- `returns 404 when user not found` (JavaScript describe/it)
- `TestReturns404WhenUserNotFound` (Go)

**Run the test using the sandbox execute capability** with the project's test command and confirm it FAILS for the right reason (missing implementation, not syntax errors).

#### Step 3: GREEN — Write Minimum Implementation

Write the simplest code that makes the failing test pass:

1. Open the relevant source file(s)
2. Write ONLY enough code to make the test pass — no more
3. Hard-code values if that makes the test pass; generalize in the refactor phase
4. Do not add features, edge cases, or optimizations not covered by the test

Run the test again using the project's test command and confirm it PASSES.

Then run all related tests to confirm nothing is broken.

#### Step 4: REFACTOR — Clean Up

With all tests passing, clean up the code:

1. Remove duplication between test and implementation
2. Improve naming and structure
3. Replace hard-coded values with proper logic
4. Remove unnecessary code or comments

After each refactor, run the related tests to confirm nothing broke.

#### Step 5: Repeat

Return to Step 2 for the next behavior slice. Continue until the feature is complete.

#### Step 6: Final Verification

When all behavior slices are implemented:

1. Run all tests related to your changes (NOT the full test suite)
2. Run linters and formatters per project conventions
3. Call `commit_and_open_pr` to submit

### Bug Fix Process

When fixing a bug, the failing test IS the fix specification. Reproduce the bug with a test BEFORE writing any fix code.

#### Step 1: Reproduce the Bug

1. Read the bug report carefully
2. Understand expected vs actual behavior
3. Identify minimal steps to reproduce
4. If possible, run existing code to confirm the bug

#### Step 2: RED — Write a Failing Test

Write a test that demonstrates the bug — the test should PASS for correct behavior but currently FAILS:

1. Place the test in the project's test directory
2. Isolate the specific buggy behavior
3. Use exact inputs/scenario from the bug report
4. Name the test to describe the bug

Run the test and confirm it FAILS (reproducing the bug).

**If the test does not fail, you have not reproduced the bug. Rethink the test.**

#### Step 3: GREEN — Fix the Bug

Write the minimum fix that makes the failing test pass:

1. Locate the root cause in the source code
2. Make the smallest possible change that fixes the bug
3. Do not refactor or improve unrelated code

Run the failing test and confirm it PASSES.

Then run all related tests to confirm no regression.

#### Step 4: REFACTOR — Clean Up

If the fix introduced duplication or can be improved:

1. Clean up the fix while keeping tests green
2. Run related tests after each change

#### Step 5: Verify and Submit

1. Run all tests related to your changes
2. Run linters and formatters
3. Call `commit_and_open_pr`

### Examples

**Example 1: New API endpoint (Feature TDD)**

```
Task: Add GET /api/users/:id endpoint

Cycle 1 — User found case:
  RED:    Write test: GET /api/users/123 returns user with id 123
          Run test -> FAILS (endpoint does not exist)
  GREEN:  Implement endpoint returning user data
          Run test -> PASSES
  REFACTOR: Clean up variable names
          Run test -> PASSES

Cycle 2 — User not found case:
  RED:    Write test: GET /api/users/999 returns 404
          Run test -> FAILS (returns 500 or wrong status)
  GREEN:  Add not-found handling
          Run test -> PASSES
  REFACTOR: Extract user lookup into helper
          Run related tests -> ALL PASS

Final:   Run all user API tests, lint, commit_and_open_pr
```

**Example 2: Bug fix (Bug TDD)**

```
Bug: Order service accepts negative quantities

Step 1:  Understand the issue
Step 2:  RED — Write test: rejects negative quantity
         Run test -> FAILS (negative accepted)
Step 3:  GREEN — Add validation check for quantity > 0
         Run test -> PASSES
         Run related tests -> ALL PASS
Step 4:  REFACTOR — Extract validation helper if duplicated
         Run related tests -> ALL PASS
Step 5:  Run all order tests, lint, commit_and_open_pr
```

**Example 3: Database model validation (Feature TDD)**

```
Task: Add User model with email validation

Cycle 1 — Create valid user:
  RED:    Write test: creates user with valid email
          Run test -> FAILS
  GREEN:  Create User model with email field
          Run test -> PASSES

Cycle 2 — Reject invalid email:
  RED:    Write test: rejects user with invalid email
          Run test -> FAILS
  GREEN:  Add email format validation
          Run test -> PASSES

Cycle 3 — Reject duplicate:
  RED:    Write test: rejects duplicate email
          Run test -> FAILS
  GREEN:  Add unique constraint
          Run test -> PASSES

REFACTOR: Extract email validation utility
          Run all user model tests -> ALL PASS

Final:   Run all model tests, lint, commit_and_open_pr
```

### Best Practices

1. **Test one thing per test**: Each test function should verify a single behavior.

2. **Use descriptive test names**: Test names are documentation. Name tests to describe expected behavior:
   - Good: `returns_404_for_missing_user`
   - Bad: `test_user_api_1`

3. **Run tests after every change**: After writing (RED), after implementing (GREEN), after refactoring.

4. **Disable color output**: Use flags for clean sandbox output:
   - `--no-header` or `NO_COLOR=1` for pytest
   - `--no-colors` for Jest
   - `--no-color` for Vitest

5. **Never run the full test suite**: Only run test files directly related to your changes. The full suite runs in CI.

6. **Keep tests independent**: Tests should not depend on execution order. Use setup/teardown for isolation.

7. **Mock external dependencies**: In unit tests, mock database calls, API requests, file system. Integration tests use real dependencies.

8. **When TDD seems impossible**: If you genuinely cannot write a test first (configuration files, runtime-only bugs), document why, implement, then write a test retroactively. This should be rare.

9. **Behavior slices should be small**: Each Red-Green-Refactor cycle should take minutes, not hours.

10. **Resist over-implementing**: In GREEN phase, write minimum code to pass. Extra logic goes in future cycles.

### Troubleshooting

**Test fails for wrong reason (RED phase):**
- Check for syntax errors, wrong imports, incorrect assertions
- Fix the test first, then confirm it fails for the right reason
- Ensure the test would pass if the feature existed

**Test still fails after implementation (GREEN phase):**
- Re-read the test assertion carefully
- Add logging to understand actual behavior
- Run the single test with verbose output

**Previously passing tests break:**
- You likely introduced a regression
- Use `git diff` to see what changed
- Revert and try a different approach

**Cannot determine test runner command:**
- Check `CLAUDE.md`, `AGENTS.md`, `Makefile`, `package.json`, CI config
- Ask for clarification if not documented

**No test directory exists:**
- Create following the language/framework convention
- Add necessary init files (e.g., `__init__.py` for Python)
- Document setup in PR description

### Reference: TDD Cycle

| Phase | Action | Verify |
|-------|--------|--------|
| **RED** | Write failing test for desired behavior | Test FAILS (right reason) |
| **GREEN** | Write minimum code to make test pass | Test PASSES |
| **REFACTOR** | Clean code without changing behavior | Tests still PASS |

**Rules:**

1. No implementation code without a failing test
2. No new test without running it to confirm it fails
3. No refactoring without running tests to confirm they pass
4. Only run tests related to your changes

### Related Skills

- `playwright-cli` — Browser automation for integration/end-to-end testing
- `frontend-dev` — For full-stack features requiring frontend/backend integration
