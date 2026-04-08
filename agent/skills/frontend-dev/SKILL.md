---
name: frontend-dev
description: Implement frontend components from Figma designs and verify with Playwright testing
allowed-tools: figma_get_file figma_get_component figma_export_image playwright-cli
compatibility: Figma MCP configured, Playwright installed via npm, dev server available
---

## Frontend Development Skill

Use this skill when the user needs to:

- Implement UI components or pages from Figma designs
- Extract design assets (images, icons) from Figma files
- Translate Figma specifications into working frontend code
- Verify frontend implementation matches the original design
- Perform visual regression testing against design baselines

### Prerequisites

**1. Figma Integration**
Figma tools are already configured. Just use `figma_get_file`, `figma_get_component`, and `figma_export_image` directly.

**2. Playwright CLI**
Must be installed in the sandbox:
```bash
npm init playwright@latest
npm install -g @playwright/cli@latest
npx playwright install chromium
```

**3. Development Server**
The target repository must have a way to start a local dev server (e.g., `npm run dev`, `npm start`)

### Workflow Overview

The frontend development workflow combines Figma design extraction with Playwright-based verification:

```
Figma Design → Extract Specs → Implement Code → Start Dev Server → Screenshot Verify → Iterate
```

### Step-by-Step Process

#### Step 1: Extract Design from Figma

Use `figma_get_file` to retrieve layout, colors, typography, and component structure:

```python
# Get full file structure
figma_get_file(
    file_key="ABC123",  # From figma.com/file/ABC123/file-name
    depth=2             # Limit nesting for focused extraction
)

# Or get specific component
figma_get_component(
    file_key="ABC123",
    component_id="1:456"  # Node ID from Figma URL (node-id=1-456)
)
```

**Extract from URL:**
- File key: `https://figma.com/file/{file_key}/...` → `file_key`
- Node ID: `?node-id=1-456` → `component_id="1:456"` (convert `-` to `:`)

#### Step 2: Export Design Assets

Export images, icons, and visual assets from Figma:

```python
# Export a specific frame/component as image
figma_export_image(
    file_key="ABC123",
    node_id="1:456",
    local_path="/tmp/figma_assets",
    file_name="hero-image.png"
)

# Export SVG for icons
figma_export_image(
    file_key="ABC123",
    node_id="1:789",
    local_path="/tmp/figma_assets",
    file_name="icon-menu.svg"
)
```

#### Step 3: Implement Frontend Code

Create components/pages based on the extracted design specifications:

- Colors → CSS variables or Tailwind config
- Typography → Font families, sizes, weights
- Spacing → Margins, padding, gaps
- Layout → Flexbox/Grid structures
- Assets → Reference exported images

#### Step 4: Start Development Server

Start the local dev server (command varies by project):

```bash
# Common commands
npm run dev
npm start
yarn dev
pnpm dev
```

**Note:** The server must be accessible on a local port (e.g., `http://localhost:3000` or `http://localhost:5173`)

#### Step 5: Verify with Playwright

Use Playwright CLI to capture screenshots and verify against the design:

```bash
# Open the dev server
playwright-cli open http://localhost:3000 --headless

# Take screenshot of full page
playwright-cli screenshot --filename=/tmp/screenshots/implementation.png

# Or screenshot specific element
playwright-cli screenshot --filename=/tmp/screenshots/component.png --selector=".my-component"

# Close session
playwright-cli close
```

#### Step 6: Compare and Iterate

1. Compare Playwright screenshot with Figma export
2. Identify visual discrepancies (spacing, colors, fonts)
3. Adjust implementation
4. Repeat Steps 5-6 until visual match is achieved

### Examples

**Complete Workflow: Implement a Component from Figma**

```python
# 1. Get component specs from Figma
component = figma_get_component(
    file_key="ABC123",
    component_id="10:456"
)
# Extract: width=320px, height=48px, bg=#3B82F6, border-radius=8px

# 2. Export the component image for reference
figma_export_image(
    file_key="ABC123",
    node_id="10:456",
    local_path="/tmp/design_refs",
    file_name="button-primary.png"
)

# 3. Implement the component (example: React + Tailwind)
# write_file: src/components/Button.tsx
"""
export function Button({ children, onClick }) {
  return (
    <button
      onClick={onClick}
      className="w-[320px] h-[48px] bg-blue-500 rounded-lg text-white font-medium"
    >
      {children}
    </button>
  );
}
"""

# 4. Start dev server (via sandbox execute)
# Command: npm run dev

# 5. Verify with Playwright CLI
# playwright-cli open http://localhost:5173 --headless
# playwright-cli screenshot --filename=/tmp/screenshots/button.png
# playwright-cli close
```

**Design-to-Code: Full Page Implementation**

```python
# 1. Get full page design
page_design = figma_get_file(
    file_key="ABC123",
    node_id="5:100",  # Page frame
    depth=3
)

# 2. Export all required assets
assets = ["5:101", "5:102", "5:103"]  # Hero, logo, icons
for node_id in assets:
    figma_export_image(
        file_key="ABC123",
        node_id=node_id,
        local_path="/tmp/assets",
        file_name=f"asset-{node_id.replace(':', '-')}.png"
    )

# 3. Implement page sections based on design hierarchy
# 4. Start dev server
# 5. Capture screenshots at multiple breakpoints
# 6. Verify responsive behavior
```

**Visual Regression Testing**

```bash
# 1. Export baseline from Figma
# Already done via figma_export_image

# 2. Take implementation screenshot
playwright-cli open http://localhost:3000 --headless
playwright-cli screenshot --filename=/tmp/screenshots/current.png
playwright-cli close

# 3. Compare (via image diff tool or visual inspection)
# Compare /tmp/design_refs/baseline.png vs /tmp/screenshots/current.png
```

### Best Practices

1. **Asset Naming**: Use descriptive file names when exporting
   ```python
   file_name="header-logo.svg"  # Good
   file_name="image1.png"        # Avoid
   ```

2. **Headless Mode**: Always use `--headless` in sandbox environments
   ```bash
   playwright-cli open http://localhost:3000 --headless
   ```

3. **Screenshot Comparison**: Export the same viewport size from Figma and Playwright
   - Figma: Check frame dimensions
   - Playwright: Default viewport is 1280x720

4. **Incremental Verification**: Test components individually before full pages

5. **Session Cleanup**: Always close Playwright sessions when done
   ```bash
   playwright-cli close        # Close current session
   playwright-cli close-all    # Close all sessions (cleanup)
   ```

6. **Design Tokens**: Extract and document design tokens from Figma:
   - Colors → `colors.primary = "#3B82F6"`
   - Spacing → `spacing.md = "16px"`
   - Typography → `typography.heading.fontSize = "24px"`

### Troubleshooting

**Figma Issues:**
- "Invalid file key" → Check URL format, extract only the key portion
- "Node not found" → Verify node ID format (use `:` not `-`)

**Playwright Screenshot Issues:**
- "No display server" → Add `--headless` flag
- Blank screenshots → Wait for page to load: `playwright-cli eval "document.readyState"`
- Element not found → Use `playwright-cli snapshot` to see available selectors

**Dev Server Issues:**
- Port conflicts → Try different port: `npm run dev -- --port 3001`
- Server not accessible → Ensure binding to `0.0.0.0` not just `localhost`

### Reference: Figma Tools

| Tool | Purpose |
|------|---------|
| `figma_get_file` | Get layout, colors, typography from a Figma file |
| `figma_get_component` | Get detailed specs for a specific component/node |
| `figma_export_image` | Download node as PNG/SVG to local path |

### Reference: Playwright CLI Commands

| Command | Purpose |
|---------|---------|
| `open <url> --headless` | Open browser in headless mode |
| `screenshot --filename=<path>` | Capture screenshot |
| `screenshot --selector=<css>` | Screenshot specific element |
| `snapshot` | Get page DOM for debugging |
| `eval "<js>"` | Execute JavaScript on page |
| `close` / `close-all` | Cleanup sessions |

### Related Skills

- `playwright-cli` - Browser automation and testing (this skill builds on it)
- See also: `agent/skills/playwright-cli/SKILL.md`
