---
name: playwright-cli
description: Automates browser interactions for web testing, form filling, screenshots, and data extraction
---

## Playwright CLI Skill

Use this skill when the user needs to:
- Navigate websites and interact with web pages
- Fill forms and click buttons
- Take screenshots or generate PDFs
- Test web applications
- Extract information from web pages

### Prerequisites

Playwright CLI must be installed in the sandbox. If not available, install it via:
```bash
npm install -g @playwright/cli@latest
# or
npx @playwright/cli
```

### Core Commands

```bash
# Open a browser (starts a session)
playwright-cli open [url] [--browser=chrome|firefox|webkit|msedge]

# Navigate to a URL
playwright-cli goto <url>

# Interact with elements
playwright-cli click <selector>
playwright-cli dblclick <selector>
playwright-cli fill <selector> <text>
playwright-cli type <selector> <text>
playwright-cli select <selector> <option>
playwright-cli check <selector>
playwright-cli uncheck <selector>

# Keyboard and mouse
playwright-cli press <key>
playwright-cli hover <selector>

# Capture
playwright-cli screenshot [--filename=<path>]
playwright-cli pdf --filename=<path>

# Session management
playwright-cli -s=<name> <command>  # Named session
playwright-cli close                # Close current session
playwright-cli close-all            # Close all sessions
playwright-cli list                 # List active sessions

# Page information
playwright-cli snapshot             # Get page DOM snapshot (useful for debugging)
playwright-cli eval <js>            # Evaluate JavaScript on the page

# Navigation
playwright-cli go-back
playwright-cli go-forward
playwright-cli reload

# Tabs
playwright-cli tab-list             # List all tabs
playwright-cli tab-new              # Open new tab
playwright-cli tab-select <index>   # Switch to tab by index
playwright-cli tab-close            # Close current tab

# Storage
playwright-cli cookie-list          # List all cookies
playwright-cli cookie-get <name>    # Get specific cookie
playwright-cli cookie-set <name> <value>
playwright-cli cookie-delete <name>
playwright-cli localstorage-list
playwright-cli localstorage-get <key>
playwright-cli localstorage-set <key> <value>
```

### Examples

**Take a screenshot of a website:**
```bash
playwright-cli open https://example.com
playwright-cli screenshot --filename=example.png
playwright-cli close
```

**Fill and submit a form:**
```bash
playwright-cli open https://example.com/form
playwright-cli fill "input[name=email]" "user@example.com"
playwright-cli fill "input[name=password]" "secret"
playwright-cli click "button[type=submit]"
playwright-cli screenshot --filename=form-submitted.png
playwright-cli close
```

**Use a named session (for multiple concurrent browsers):**
```bash
playwright-cli -s=session1 open https://example.com
playwright-cli -s=session2 open https://another.com
playwright-cli -s=session1 screenshot --filename=site1.png
playwright-cli -s=session2 screenshot --filename=site2.png
playwright-cli close-all
```

**Extract page content:**
```bash
playwright-cli open https://example.com
playwright-cli eval "document.title"
playwright-cli eval "document.body.innerText"
playwright-cli snapshot
playwright-cli close
```

**Wait for element and interact:**
```bash
playwright-cli open https://example.com
playwright-cli click "button#load-more"
playwright-cli press Enter
playwright-cli screenshot --filename=result.png
playwright-cli close
```

### Best Practices

1. **Always close sessions**: Use `playwright-cli close` when done to clean up browser resources
2. **Use session names**: When working with multiple browsers simultaneously, use `-s=<name>`
3. **Prefer CSS selectors**: Use standard CSS selectors for element targeting
4. **Debug with snapshot**: Use `playwright-cli snapshot` to see the page structure when selectors fail
5. **Screenshots**: Saved to the current working directory by default
6. **Check exit codes**: Commands return non-zero exit codes on failure - handle appropriately

### Common Selectors

```bash
# By ID
playwright-cli click "#submit-button"

# By class
playwright-cli click ".btn-primary"

# By attribute
playwright-cli fill "input[name='username']" "myuser"
playwright-cli fill "input[type='email']" "test@example.com"

# By text (partial match)
playwright-cli click "text=Submit"

# Combined selectors
playwright-cli click "nav button.menu-toggle"
```

### Troubleshooting

- **Element not found**: Use `playwright-cli snapshot` to see available elements
- **Timeout**: Page may be slow; retry the command or check network
- **Permission denied**: Some sites block automation; try different user agent
- **Session conflicts**: Use named sessions (`-s=`) to isolate browsers
