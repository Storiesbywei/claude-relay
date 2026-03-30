# Claude Relay Dashboard Redesign

Apple HIG-inspired redesign for the claude-relay real-time collaboration dashboard.

---

## 1. Design Principles

### Clarity
Every element earns its place. Typography is legible at all sizes. Icons are precise and meaningful. Whitespace is structural, not decorative. The interface communicates instantly what is happening: who is talking, what kind of message it is, and what the system state is.

### Deference
The UI recedes behind the content. Messages — the core unit of work — dominate the viewport. Chrome is minimal: thin borders, muted backgrounds, translucent surfaces. Controls appear when needed and stay out of the way otherwise.

### Depth
Layered surfaces create hierarchy through subtle translucency and shadow. The navigation bar floats above the content with a frosted glass backdrop. Modals emerge from behind a gaussian-blurred overlay. Sidebars slide with physics-based easing. Each layer signals its position in the z-stack through material, not decoration.

### Dark Mode First
The primary palette is dark, matching the environments where developers work (Xcode, Terminal, VS Code). High-contrast text on deep backgrounds reduces eye strain during extended sessions. Light mode is available through `prefers-color-scheme` but dark is the default and primary design target.

### Accessibility
- WCAG AA contrast ratios on all text (4.5:1 minimum for body, 3:1 for large text)
- Full keyboard navigation with visible focus rings
- `prefers-reduced-motion` disables all animations and transitions
- `prefers-color-scheme: light` switches the entire palette
- ARIA labels on all interactive elements
- Semantic HTML throughout (nav, main, aside, article, section, footer)

### Responsive
- Desktop (1200px+): Full 3-column layout
- Tablet (768px-1199px): Collapsible sidebar, narrower panels
- Compact (below 768px): Stacked layout, sidebar becomes a drawer

---

## 2. Color System

### Background Layers

| Token | Dark | Light | Usage |
|-------|------|-------|-------|
| `--color-bg-primary` | `#1a1a1e` | `#f5f5f7` | App canvas, deepest layer |
| `--color-bg-secondary` | `#232328` | `#ffffff` | Cards, panels, elevated surfaces |
| `--color-bg-tertiary` | `#2c2c31` | `#f0f0f2` | Hover states, nested containers |
| `--color-bg-glass` | `rgba(35,35,40,0.72)` | `rgba(255,255,255,0.72)` | Frosted glass surfaces |

### Text Hierarchy

| Token | Dark | Light | Usage |
|-------|------|-------|-------|
| `--color-text-primary` | `#f5f5f7` | `#1d1d1f` | Headlines, body text |
| `--color-text-secondary` | `#a1a1a6` | `#6e6e73` | Labels, captions, metadata |
| `--color-text-tertiary` | `#6e6e73` | `#a1a1a6` | Placeholders, disabled text |
| `--color-text-inverse` | `#1d1d1f` | `#f5f5f7` | Text on accent backgrounds |

### Accent

| Token | Value | Usage |
|-------|-------|-------|
| `--color-accent` | `#0a84ff` | Primary actions, links, active states |
| `--color-accent-hover` | `#409cff` | Hover on accent elements |
| `--color-accent-dim` | `rgba(10,132,255,0.15)` | Accent backgrounds, tinted surfaces |

### Semantic Colors

| Token | Dark | Light | Usage |
|-------|------|-------|-------|
| `--color-success` | `#30d158` | `#28a745` | Connected, success, additions |
| `--color-success-dim` | `rgba(48,209,88,0.15)` | `rgba(40,167,69,0.12)` | Success backgrounds |
| `--color-warning` | `#ffd60a` | `#e8a317` | Pending, caution states |
| `--color-warning-dim` | `rgba(255,214,10,0.15)` | `rgba(232,163,23,0.12)` | Warning backgrounds |
| `--color-error` | `#ff453a` | `#dc3545` | Errors, disconnected, removals |
| `--color-error-dim` | `rgba(255,69,58,0.15)` | `rgba(220,53,69,0.12)` | Error backgrounds |
| `--color-info` | `#64d2ff` | `#17a2b8` | Informational badges |
| `--color-info-dim` | `rgba(100,210,255,0.15)` | `rgba(23,162,184,0.12)` | Info backgrounds |

### Participant Colors

Each participant in a session gets a distinct, accessible color. These are ordered by assignment.

| Token | Value | Label | Contrast (on dark bg) |
|-------|-------|-------|-----------------------|
| `--color-participant-1` | `#0a84ff` | Director / Creator (Blue) | 5.2:1 |
| `--color-participant-2` | `#30d158` | First agent (Green) | 5.8:1 |
| `--color-participant-3` | `#bf5af2` | Second agent (Purple) | 4.6:1 |
| `--color-participant-4` | `#ff9f0a` | Third agent (Orange) | 5.1:1 |

Each has a corresponding `--color-participant-N-dim` at 15% opacity for badge/bubble backgrounds.

### Borders and Separators

| Token | Dark | Light |
|-------|------|-------|
| `--color-separator` | `rgba(255,255,255,0.08)` | `rgba(0,0,0,0.08)` |
| `--color-separator-opaque` | `#38383d` | `#d2d2d7` |
| `--color-focus-ring` | `rgba(10,132,255,0.6)` | `rgba(10,132,255,0.6)` |

### CSS Custom Properties Block

```css
:root {
  /* Background layers */
  --color-bg-primary: #1a1a1e;
  --color-bg-secondary: #232328;
  --color-bg-tertiary: #2c2c31;
  --color-bg-glass: rgba(35, 35, 40, 0.72);
  --color-bg-glass-hover: rgba(45, 45, 50, 0.78);

  /* Text */
  --color-text-primary: #f5f5f7;
  --color-text-secondary: #a1a1a6;
  --color-text-tertiary: #6e6e73;
  --color-text-inverse: #1d1d1f;

  /* Accent */
  --color-accent: #0a84ff;
  --color-accent-hover: #409cff;
  --color-accent-dim: rgba(10, 132, 255, 0.15);

  /* Semantic */
  --color-success: #30d158;
  --color-success-dim: rgba(48, 209, 88, 0.15);
  --color-warning: #ffd60a;
  --color-warning-dim: rgba(255, 214, 10, 0.15);
  --color-error: #ff453a;
  --color-error-dim: rgba(255, 69, 58, 0.15);
  --color-info: #64d2ff;
  --color-info-dim: rgba(100, 210, 255, 0.15);

  /* Participants */
  --color-participant-1: #0a84ff;
  --color-participant-1-dim: rgba(10, 132, 255, 0.15);
  --color-participant-2: #30d158;
  --color-participant-2-dim: rgba(48, 209, 88, 0.15);
  --color-participant-3: #bf5af2;
  --color-participant-3-dim: rgba(191, 90, 242, 0.15);
  --color-participant-4: #ff9f0a;
  --color-participant-4-dim: rgba(255, 159, 10, 0.15);

  /* Borders */
  --color-separator: rgba(255, 255, 255, 0.08);
  --color-separator-opaque: #38383d;
  --color-focus-ring: rgba(10, 132, 255, 0.6);

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.5);
  --shadow-float: 0 12px 48px rgba(0, 0, 0, 0.6);
}

@media (prefers-color-scheme: light) {
  :root {
    --color-bg-primary: #f5f5f7;
    --color-bg-secondary: #ffffff;
    --color-bg-tertiary: #f0f0f2;
    --color-bg-glass: rgba(255, 255, 255, 0.72);
    --color-bg-glass-hover: rgba(255, 255, 255, 0.82);
    --color-text-primary: #1d1d1f;
    --color-text-secondary: #6e6e73;
    --color-text-tertiary: #a1a1a6;
    --color-text-inverse: #f5f5f7;
    --color-separator: rgba(0, 0, 0, 0.08);
    --color-separator-opaque: #d2d2d7;
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.08);
    --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.1);
    --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.14);
    --shadow-float: 0 12px 48px rgba(0, 0, 0, 0.18);
  }
}
```

---

## 3. Typography

### Font Stack

```css
:root {
  --font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display',
               'Helvetica Neue', 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'SF Mono', ui-monospace, 'Cascadia Code', 'JetBrains Mono',
               'Fira Code', 'Menlo', 'Consolas', monospace;
  --font-display: -apple-system, BlinkMacSystemFont, 'SF Pro Display',
                  'Helvetica Neue', system-ui, sans-serif;
}
```

### Size Scale

| Token | Size | Line Height | Usage |
|-------|------|-------------|-------|
| `--text-xs` | 11px | 1.35 | Badges, timestamps, metadata |
| `--text-sm` | 13px | 1.4 | Captions, secondary labels |
| `--text-base` | 15px | 1.5 | Body text, messages, inputs |
| `--text-lg` | 17px | 1.45 | Section headings |
| `--text-xl` | 20px | 1.35 | Panel titles |
| `--text-2xl` | 24px | 1.3 | Page titles |
| `--text-3xl` | 28px | 1.25 | Large titles (session setup) |
| `--text-code` | 13px | 1.6 | Code blocks, file viewer |

### Weight Scale

| Token | Weight | Usage |
|-------|--------|-------|
| `--font-regular` | 400 | Body text |
| `--font-medium` | 500 | Labels, buttons, interactive text |
| `--font-semibold` | 600 | Headings, panel titles |
| `--font-bold` | 700 | Emphasis, large titles |

### Letter Spacing

| Token | Value | Usage |
|-------|-------|-------|
| `--tracking-tight` | -0.02em | Large titles |
| `--tracking-normal` | 0em | Body text |
| `--tracking-wide` | 0.04em | Uppercase labels, badges |

---

## 4. Component Inventory

### A. Navigation Bar

The nav bar is a frosted glass surface pinned to the top, containing session identity, participant presence, and global actions.

**HTML Structure:**

```html
<nav class="nav-bar" role="navigation" aria-label="Session navigation">
  <div class="nav-bar__leading">
    <span class="nav-bar__logo" aria-hidden="true">
      <svg><!-- relay icon --></svg>
    </span>
    <h1 class="nav-bar__title">Claude Relay</h1>
    <button class="nav-bar__session-badge" aria-label="Copy session ID">
      <span class="status-indicator status-indicator--active"></span>
      <span class="nav-bar__session-name">Director Session</span>
    </button>
  </div>

  <div class="nav-bar__center">
    <div class="segmented-control" role="tablist">
      <button class="segmented-control__item segmented-control__item--active"
              role="tab" aria-selected="true">Director</button>
      <button class="segmented-control__item"
              role="tab" aria-selected="false">Peer</button>
    </div>
  </div>

  <div class="nav-bar__trailing">
    <div class="participant-stack" aria-label="Connected participants">
      <span class="avatar-circle avatar-circle--p1" title="Director">D</span>
      <span class="avatar-circle avatar-circle--p2" title="Claude Worker">W</span>
    </div>
    <div class="nav-bar__actions">
      <button class="btn-icon" aria-label="Export session" title="Export">
        <svg><!-- download icon --></svg>
      </button>
      <button class="btn-icon" aria-label="Session settings" title="Settings">
        <svg><!-- gear icon --></svg>
      </button>
      <button class="btn-icon btn-icon--danger" aria-label="End session" title="End Session">
        <svg><!-- xmark icon --></svg>
      </button>
    </div>
  </div>
</nav>
```

**Key CSS:**

```css
.nav-bar {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 52px;
  padding: 0 20px;
  background: var(--color-bg-glass);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 1px solid var(--color-separator);
}

.segmented-control {
  display: flex;
  background: var(--color-bg-tertiary);
  border-radius: 8px;
  padding: 2px;
  gap: 2px;
}

.segmented-control__item {
  padding: 5px 16px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font: var(--font-medium) var(--text-sm) / 1.2 var(--font-sans);
  cursor: pointer;
  transition: all 0.2s ease;
}

.segmented-control__item--active {
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  box-shadow: var(--shadow-sm);
}

.avatar-circle {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 600;
  border: 2px solid var(--color-bg-primary);
}

.avatar-circle--p1 { background: var(--color-participant-1-dim); color: var(--color-participant-1); }
.avatar-circle--p2 { background: var(--color-participant-2-dim); color: var(--color-participant-2); }
.avatar-circle--p3 { background: var(--color-participant-3-dim); color: var(--color-participant-3); }
.avatar-circle--p4 { background: var(--color-participant-4-dim); color: var(--color-participant-4); }

.participant-stack {
  display: flex;
  margin-right: 12px;
}
.participant-stack .avatar-circle + .avatar-circle {
  margin-left: -8px;
}
```

### B. Message Feed

Messages are the core content. Each message is a card with a participant badge, type indicator, content area, and timestamp.

**HTML Structure (single message):**

```html
<article class="message message--received" data-participant="2" aria-label="Message from Claude Worker">
  <div class="message__header">
    <span class="avatar-circle avatar-circle--p2 avatar-circle--sm">W</span>
    <span class="message__sender">Claude Worker</span>
    <span class="message-type-chip message-type-chip--insight">insight</span>
    <time class="message__time" datetime="2026-03-30T14:23:00Z">2m ago</time>
  </div>
  <div class="message__body">
    <p>The JWT refresh logic has a race condition. When two API calls fire
    simultaneously with an expired token, both trigger a refresh.</p>
  </div>
  <div class="message__footer">
    <button class="message__action" aria-label="Copy message">Copy</button>
    <button class="message__action" aria-label="Quote message">Quote</button>
  </div>
</article>
```

**Key CSS:**

```css
.message {
  max-width: 82%;
  padding: 12px 16px;
  border-radius: 16px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-separator);
  font-size: var(--text-base);
  line-height: 1.5;
  position: relative;
}

.message--sent {
  align-self: flex-end;
  background: var(--color-accent-dim);
  border-color: rgba(10, 132, 255, 0.2);
  border-bottom-right-radius: 6px;
}

.message--received {
  align-self: flex-start;
  border-bottom-left-radius: 6px;
}

.message__header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.message__sender {
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
  color: var(--color-text-secondary);
}

.message__time {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.message__body {
  color: var(--color-text-primary);
  word-break: break-word;
  white-space: pre-wrap;
}

.message__body code {
  font-family: var(--font-mono);
  font-size: var(--text-code);
  background: var(--color-bg-tertiary);
  padding: 2px 6px;
  border-radius: 4px;
}

.message__body pre {
  background: var(--color-bg-primary);
  border: 1px solid var(--color-separator);
  border-radius: 8px;
  padding: 12px 16px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: var(--text-code);
  line-height: 1.6;
  margin: 8px 0;
}

.message__footer {
  display: none;
  gap: 8px;
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid var(--color-separator);
}

.message:hover .message__footer {
  display: flex;
}

.message__action {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px 8px;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.message__action:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
}

.message-type-chip {
  font-size: 10px;
  font-weight: var(--font-medium);
  padding: 2px 8px;
  border-radius: 6px;
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
}

.message-type-chip--architecture { background: var(--color-participant-3-dim); color: var(--color-participant-3); }
.message-type-chip--question     { background: var(--color-participant-4-dim); color: var(--color-participant-4); }
.message-type-chip--answer       { background: var(--color-success-dim); color: var(--color-success); }
.message-type-chip--insight      { background: var(--color-participant-3-dim); color: var(--color-participant-3); }
.message-type-chip--context      { background: var(--color-accent-dim); color: var(--color-accent); }
.message-type-chip--task         { background: var(--color-info-dim); color: var(--color-info); }
.message-type-chip--patterns     { background: var(--color-participant-4-dim); color: var(--color-participant-4); }
.message-type-chip--file_change  { background: var(--color-success-dim); color: var(--color-success); }
.message-type-chip--file_tree    { background: var(--color-bg-tertiary); color: var(--color-text-secondary); }
.message-type-chip--terminal     { background: var(--color-bg-tertiary); color: var(--color-text-secondary); }
.message-type-chip--status_update { background: var(--color-accent-dim); color: var(--color-accent); }
```

### C. Input Area

A clean composition area with auto-resizing textarea, message type selector, and send button with keyboard shortcut hint.

**HTML Structure:**

```html
<div class="input-area">
  <div class="input-area__toolbar">
    <select class="input-area__type-select" aria-label="Message type">
      <option value="question">Question</option>
      <option value="context">Instruction</option>
      <option value="answer">Feedback</option>
    </select>
    <div class="input-area__indicators">
      <span class="approval-indicator" id="approval-count" style="display:none">
        <span class="approval-indicator__dot"></span>
        <span>3 pending</span>
      </span>
    </div>
  </div>
  <div class="input-area__compose">
    <textarea class="input-area__textarea"
              placeholder="Type an instruction for the worker..."
              rows="1"
              aria-label="Message input"></textarea>
    <button class="input-area__send" aria-label="Send message">
      <svg><!-- arrow.up.circle.fill icon --></svg>
      <span class="input-area__shortcut">&#8984;&#x23CE;</span>
    </button>
  </div>
</div>
```

**Key CSS:**

```css
.input-area {
  border-top: 1px solid var(--color-separator);
  background: var(--color-bg-glass);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  padding: 12px 20px 16px;
}

.input-area__toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.input-area__type-select {
  appearance: none;
  -webkit-appearance: none;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-separator);
  border-radius: 6px;
  padding: 4px 28px 4px 10px;
  font: var(--font-medium) var(--text-xs) / 1.2 var(--font-sans);
  color: var(--color-text-secondary);
  cursor: pointer;
  background-image: url("data:image/svg+xml,..."); /* chevron */
  background-repeat: no-repeat;
  background-position: right 8px center;
  background-size: 10px;
}

.input-area__compose {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-separator);
  border-radius: 12px;
  padding: 8px 12px;
  transition: border-color 0.2s ease;
}

.input-area__compose:focus-within {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}

.input-area__textarea {
  flex: 1;
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  font: var(--font-regular) var(--text-base) / 1.5 var(--font-sans);
  resize: none;
  outline: none;
  min-height: 24px;
  max-height: 160px;
}

.input-area__textarea::placeholder {
  color: var(--color-text-tertiary);
}

.input-area__send {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  border: none;
  background: var(--color-accent);
  color: white;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.input-area__send:hover {
  opacity: 0.85;
  transform: scale(1.05);
}

.input-area__send:disabled {
  opacity: 0.3;
  cursor: not-allowed;
  transform: none;
}

.input-area__shortcut {
  position: absolute;
  bottom: -18px;
  right: 0;
  font-size: 10px;
  color: var(--color-text-tertiary);
  pointer-events: none;
}

.approval-indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--color-warning-dim);
  color: var(--color-warning);
  font-size: var(--text-xs);
  font-weight: var(--font-medium);
}

.approval-indicator__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-warning);
}
```

### D. Sidebar

A collapsible sidebar containing file tree navigation, session info, participant list, and export options.

**HTML Structure:**

```html
<aside class="sidebar" id="sidebar" role="complementary" aria-label="Workspace sidebar">
  <div class="sidebar__header">
    <h2 class="sidebar__title">Workspace</h2>
    <button class="btn-icon btn-icon--sm" id="btn-toggle-sidebar"
            aria-label="Collapse sidebar">
      <svg><!-- sidebar.left icon --></svg>
    </button>
  </div>

  <!-- File Tree Section -->
  <section class="sidebar__section">
    <h3 class="sidebar__section-title">Files</h3>
    <div class="file-tree" id="file-tree" role="tree" aria-label="Project files">
      <div class="file-tree__empty">
        No workspace data yet.
      </div>
    </div>
  </section>

  <!-- Session Info Section -->
  <section class="sidebar__section">
    <h3 class="sidebar__section-title">Session</h3>
    <div class="sidebar__info-grid">
      <div class="sidebar__info-row">
        <span class="sidebar__info-label">ID</span>
        <code class="sidebar__info-value sidebar__info-value--copyable">a3f8c2d1</code>
      </div>
      <div class="sidebar__info-row">
        <span class="sidebar__info-label">TTL</span>
        <span class="sidebar__info-value">48m remaining</span>
      </div>
      <div class="sidebar__info-row">
        <span class="sidebar__info-label">Messages</span>
        <span class="sidebar__info-value">24 / 200</span>
      </div>
    </div>
  </section>

  <!-- Participants Section -->
  <section class="sidebar__section">
    <h3 class="sidebar__section-title">Participants</h3>
    <ul class="participant-list" aria-label="Session participants">
      <li class="participant-list__item">
        <span class="avatar-circle avatar-circle--p1 avatar-circle--sm">D</span>
        <span class="participant-list__name">Director</span>
        <span class="status-indicator status-indicator--active"></span>
      </li>
      <li class="participant-list__item">
        <span class="avatar-circle avatar-circle--p2 avatar-circle--sm">W</span>
        <span class="participant-list__name">Claude Worker</span>
        <span class="status-indicator status-indicator--active"></span>
      </li>
    </ul>
  </section>

  <!-- Export Section -->
  <section class="sidebar__section sidebar__section--footer">
    <h3 class="sidebar__section-title">Export</h3>
    <div class="sidebar__export-buttons">
      <button class="btn btn--ghost btn--sm btn--full-width">
        <svg><!-- doc icon --></svg> JSON
      </button>
      <button class="btn btn--ghost btn--sm btn--full-width">
        <svg><!-- doc.text icon --></svg> Markdown
      </button>
      <button class="btn btn--ghost btn--sm btn--full-width">
        <svg><!-- cloud icon --></svg> Solid Pod
      </button>
    </div>
  </section>
</aside>

<!-- Collapsed sidebar toggle -->
<button class="sidebar-tab" id="btn-expand-sidebar" aria-label="Expand sidebar"
        style="display:none">
  <svg><!-- sidebar.left icon --></svg>
</button>
```

**Key CSS:**

```css
.sidebar {
  width: 280px;
  min-width: 280px;
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-separator);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
              min-width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
              opacity 0.2s ease;
}

.sidebar--collapsed {
  width: 0;
  min-width: 0;
  border-right: none;
  opacity: 0;
}

.sidebar__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-separator);
  flex-shrink: 0;
}

.sidebar__title {
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
}

.sidebar__section {
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-separator);
}

.sidebar__section:last-child {
  border-bottom: none;
  margin-top: auto;
}

.sidebar__section-title {
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
  color: var(--color-text-tertiary);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  margin-bottom: 8px;
}

.file-tree {
  overflow-y: auto;
  max-height: 40vh;
  font-size: var(--text-sm);
}

.file-tree__item {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  border-radius: 6px;
  cursor: pointer;
  transition: background 0.1s ease;
  gap: 6px;
}

.file-tree__item:hover {
  background: var(--color-bg-tertiary);
}

.file-tree__item--active {
  background: var(--color-accent-dim);
  color: var(--color-accent);
}

.file-tree__item--modified {
  color: var(--color-success);
}

.file-tree__icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  opacity: 0.6;
}

.file-tree__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

.file-tree__badge {
  font-size: 9px;
  font-weight: var(--font-semibold);
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--color-success-dim);
  color: var(--color-success);
  flex-shrink: 0;
}

.sidebar-tab {
  display: none;
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  width: 20px;
  height: 44px;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-separator);
  border-left: none;
  border-radius: 0 8px 8px 0;
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.sidebar-tab:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  width: 24px;
}

.participant-list {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.participant-list__item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 0;
}

.participant-list__name {
  font-size: var(--text-sm);
  color: var(--color-text-primary);
  flex: 1;
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
}

.status-indicator--active {
  background: var(--color-success);
  box-shadow: 0 0 6px var(--color-success);
}

.status-indicator--idle {
  background: var(--color-warning);
}

.status-indicator--disconnected {
  background: var(--color-error);
}
```

### E. Session Setup

A centered card-based onboarding flow for creating or joining sessions.

**HTML Structure:**

```html
<div class="session-setup" id="session-setup">
  <div class="session-setup__container">
    <div class="session-setup__brand">
      <svg class="session-setup__logo"><!-- relay icon --></svg>
      <h1 class="session-setup__heading">Claude Relay</h1>
      <p class="session-setup__subheading">Real-time collaboration between human directors and AI agents</p>
    </div>

    <div class="session-setup__cards">
      <!-- Create Session -->
      <div class="card">
        <div class="card__header">
          <h2 class="card__title">New Session</h2>
          <p class="card__description">Start a collaboration workspace</p>
        </div>
        <div class="card__body">
          <label class="field">
            <span class="field__label">Session Name</span>
            <input type="text" class="field__input" placeholder="Director Session"
                   value="Director Session">
          </label>
          <label class="field">
            <span class="field__label">Time to Live</span>
            <select class="field__select">
              <option value="30">30 minutes</option>
              <option value="60" selected>1 hour</option>
              <option value="120">2 hours</option>
              <option value="480">8 hours</option>
              <option value="1440">24 hours</option>
            </select>
          </label>
        </div>
        <div class="card__footer">
          <button class="btn btn--primary btn--full-width" id="btn-new-session">
            Create Session
          </button>
        </div>
      </div>

      <div class="session-setup__divider">
        <span>or</span>
      </div>

      <!-- Join Session -->
      <div class="card">
        <div class="card__header">
          <h2 class="card__title">Join Session</h2>
          <p class="card__description">Connect to an existing workspace</p>
        </div>
        <div class="card__body">
          <label class="field">
            <span class="field__label">Session ID</span>
            <input type="text" class="field__input" placeholder="Paste session ID">
          </label>
          <label class="field">
            <span class="field__label">Invite Token</span>
            <input type="text" class="field__input" placeholder="Paste invite token">
          </label>
        </div>
        <div class="card__footer">
          <button class="btn btn--ghost btn--full-width" id="btn-join">
            Join Session
          </button>
        </div>
      </div>
    </div>
  </div>
</div>
```

**Key CSS:**

```css
.session-setup {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 40px 20px;
}

.session-setup__container {
  max-width: 640px;
  width: 100%;
}

.session-setup__brand {
  text-align: center;
  margin-bottom: 40px;
}

.session-setup__heading {
  font: var(--font-bold) var(--text-3xl) / 1.2 var(--font-display);
  letter-spacing: var(--tracking-tight);
  color: var(--color-text-primary);
  margin-top: 16px;
}

.session-setup__subheading {
  font-size: var(--text-base);
  color: var(--color-text-secondary);
  margin-top: 8px;
}

.session-setup__cards {
  display: flex;
  gap: 24px;
  align-items: stretch;
}

.session-setup__divider {
  display: flex;
  align-items: center;
  color: var(--color-text-tertiary);
  font-size: var(--text-sm);
}

.card {
  flex: 1;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-separator);
  border-radius: 16px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.card__header {
  padding: 20px 20px 0;
}

.card__title {
  font: var(--font-semibold) var(--text-lg) / 1.3 var(--font-sans);
  color: var(--color-text-primary);
}

.card__description {
  font-size: var(--text-sm);
  color: var(--color-text-secondary);
  margin-top: 4px;
}

.card__body {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex: 1;
}

.card__footer {
  padding: 0 20px 20px;
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field__label {
  font-size: var(--text-xs);
  font-weight: var(--font-medium);
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
}

.field__input,
.field__select {
  padding: 10px 12px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-separator-opaque);
  border-radius: 8px;
  color: var(--color-text-primary);
  font: var(--font-regular) var(--text-sm) / 1.4 var(--font-sans);
  outline: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.field__input:focus,
.field__select:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}

.field__input::placeholder {
  color: var(--color-text-tertiary);
}
```

### F. Status Bar

A thin bottom bar showing connection status, message count, and relay pool info.

**HTML Structure:**

```html
<footer class="status-bar" role="status" aria-live="polite">
  <div class="status-bar__left">
    <span class="status-bar__indicator">
      <span class="status-indicator status-indicator--active"></span>
      <span>Connected</span>
    </span>
    <span class="status-bar__separator"></span>
    <span>relay: localhost:4190</span>
  </div>
  <div class="status-bar__center">
    <span class="status-bar__nostr" id="nostr-badge">
      <span class="status-indicator" id="nostr-dot"></span>
      <span id="nostr-status">nostr: off</span>
    </span>
  </div>
  <div class="status-bar__right">
    <span>24 messages</span>
    <span class="status-bar__separator"></span>
    <span>Rate: 28/30 remaining</span>
  </div>
</footer>
```

**Key CSS:**

```css
.status-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  padding: 0 16px;
  background: var(--color-bg-secondary);
  border-top: 1px solid var(--color-separator);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

.status-bar__left,
.status-bar__center,
.status-bar__right {
  display: flex;
  align-items: center;
  gap: 8px;
}

.status-bar__separator {
  width: 1px;
  height: 12px;
  background: var(--color-separator-opaque);
}

.status-bar__indicator {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.status-bar__nostr {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 1px 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: background 0.15s ease;
}

.status-bar__nostr:hover {
  background: var(--color-bg-tertiary);
}

.status-bar__nostr.active {
  color: var(--color-participant-3);
}
```

---

## 5. Layout Variations

### Director Mode (3-column)

```
+-----------------------------------------------------------+
| [nav bar - frosted glass]                                 |
+--------+-----------------------------------+--------------+
|        |                                   |              |
| Side-  |  Message Feed                     | File Viewer  |
| bar    |  (scrollable)                     | (optional,   |
| 280px  |  flex: 1                          |  appears on  |
|        |                                   |  file click) |
|        |                                   |  40%         |
|        +-----------------------------------+              |
|        | [input area - frosted glass]      |              |
+--------+-----------------------------------+--------------+
| [status bar]                                              |
+-----------------------------------------------------------+
```

```css
.layout-director {
  display: grid;
  grid-template-columns: auto 1fr;
  grid-template-rows: auto 1fr auto;
  height: 100vh;
}

/* When file viewer is open */
.layout-director--with-viewer {
  grid-template-columns: auto 1fr 40%;
}
```

### Peer Mode (split-panel)

```
+-----------------------------------------------------------+
| [nav bar - frosted glass]                                 |
+-----------+-----------------+----+------------------------+
|           |                 |    |                        |
| Controls  | Claude Alpha    |    | Claude Beta            |
| (toolbar) | (scrollable)    |spine| (scrollable)          |
|           |                 |    |                        |
|           |                 |    |                        |
+-----------+-----------------+----+------------------------+
| [status bar]                                              |
+-----------------------------------------------------------+
```

```css
.layout-peer {
  display: grid;
  grid-template-columns: 1fr 4px 1fr;
  grid-template-rows: auto auto 1fr auto;
  height: 100vh;
}

.layout-peer__spine {
  background: linear-gradient(
    to bottom,
    var(--color-participant-3),
    var(--color-participant-4)
  );
  opacity: 0.3;
  border-radius: 2px;
  margin: 20px 0;
}
```

### Mobile / Compact (below 768px)

```
+---------------------------+
| [nav bar - compact]       |
+---------------------------+
|                           |
|  Message Feed             |
|  (full width, scrollable) |
|                           |
+---------------------------+
| [input area]              |
+---------------------------+
| [status bar - condensed]  |
+---------------------------+

Sidebar: slide-in drawer from left (overlay)
File Viewer: slide-in drawer from right (overlay)
```

```css
@media (max-width: 768px) {
  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 200;
    transform: translateX(-100%);
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .sidebar--open {
    transform: translateX(0);
  }

  .sidebar-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    z-index: 199;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.3s ease;
  }

  .sidebar-backdrop--visible {
    opacity: 1;
    pointer-events: auto;
  }

  .nav-bar__center {
    display: none; /* Move segmented control into a dropdown */
  }

  .message {
    max-width: 92%;
  }

  .layout-peer {
    grid-template-columns: 1fr;
  }

  .layout-peer__panel-b {
    display: none; /* Show one panel at a time with tab switching */
  }
}
```

---

## 6. Animations and Transitions

All animations respect `prefers-reduced-motion`. When reduced motion is preferred, transitions are instant (0ms duration) or use simple opacity fades.

### Message Entrance

```css
@keyframes message-enter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.message {
  animation: message-enter 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
```

### Sidebar Collapse/Expand

```css
.sidebar {
  transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
              min-width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}
```

### Modal Appearance

```css
@keyframes modal-backdrop-enter {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes modal-card-enter {
  from {
    opacity: 0;
    transform: scale(0.95) translateY(10px);
  }
  to {
    opacity: 1;
    transform: scale(1) translateY(0);
  }
}

.modal-overlay {
  animation: modal-backdrop-enter 0.2s ease;
}

.modal-overlay::before {
  content: '';
  position: fixed;
  inset: 0;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
}

.modal-card {
  animation: modal-card-enter 0.25s cubic-bezier(0.4, 0, 0.2, 1);
}
```

### Connection Status Pulse

```css
@keyframes status-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.status-indicator--active {
  animation: status-pulse 2s ease-in-out infinite;
}
```

### Typing Indicator

```css
@keyframes typing-bounce {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-4px); }
}

.typing-indicator__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
  animation: typing-bounce 1.2s ease infinite;
}

.typing-indicator__dot:nth-child(2) { animation-delay: 0.15s; }
.typing-indicator__dot:nth-child(3) { animation-delay: 0.3s; }
```

### Reduced Motion

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## 7. CSS Implementation

The complete stylesheet follows. This is a working CSS file that can replace `style.css` in the project.

```css
/* ============================================================
   Claude Relay Dashboard v3 — Apple HIG Redesign
   ============================================================
   Dark-first, frosted glass, SF Pro typography.
   Pure CSS — no dependencies.
   ============================================================ */

/* === Design Tokens === */
:root {
  /* Background layers */
  --color-bg-primary: #1a1a1e;
  --color-bg-secondary: #232328;
  --color-bg-tertiary: #2c2c31;
  --color-bg-glass: rgba(35, 35, 40, 0.72);
  --color-bg-glass-hover: rgba(45, 45, 50, 0.78);

  /* Text */
  --color-text-primary: #f5f5f7;
  --color-text-secondary: #a1a1a6;
  --color-text-tertiary: #6e6e73;
  --color-text-inverse: #1d1d1f;

  /* Accent */
  --color-accent: #0a84ff;
  --color-accent-hover: #409cff;
  --color-accent-dim: rgba(10, 132, 255, 0.15);

  /* Semantic */
  --color-success: #30d158;
  --color-success-dim: rgba(48, 209, 88, 0.15);
  --color-warning: #ffd60a;
  --color-warning-dim: rgba(255, 214, 10, 0.15);
  --color-error: #ff453a;
  --color-error-dim: rgba(255, 69, 58, 0.15);
  --color-info: #64d2ff;
  --color-info-dim: rgba(100, 210, 255, 0.15);

  /* Participants */
  --color-p1: #0a84ff;
  --color-p1-dim: rgba(10, 132, 255, 0.15);
  --color-p2: #30d158;
  --color-p2-dim: rgba(48, 209, 88, 0.15);
  --color-p3: #bf5af2;
  --color-p3-dim: rgba(191, 90, 242, 0.15);
  --color-p4: #ff9f0a;
  --color-p4-dim: rgba(255, 159, 10, 0.15);

  /* Borders */
  --color-separator: rgba(255, 255, 255, 0.08);
  --color-separator-opaque: #38383d;
  --color-focus-ring: rgba(10, 132, 255, 0.5);

  /* Shadows */
  --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.3);
  --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.4);
  --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.5);
  --shadow-float: 0 12px 48px rgba(0, 0, 0, 0.6);

  /* Typography */
  --font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display',
               'Helvetica Neue', 'Segoe UI', system-ui, sans-serif;
  --font-mono: 'SF Mono', ui-monospace, 'Cascadia Code', 'JetBrains Mono',
               'Fira Code', 'Menlo', 'Consolas', monospace;

  --text-xs: 11px;
  --text-sm: 13px;
  --text-base: 15px;
  --text-lg: 17px;
  --text-xl: 20px;
  --text-2xl: 24px;
  --text-3xl: 28px;
  --text-code: 13px;

  --font-regular: 400;
  --font-medium: 500;
  --font-semibold: 600;
  --font-bold: 700;

  --tracking-tight: -0.02em;
  --tracking-normal: 0em;
  --tracking-wide: 0.04em;

  /* Spacing */
  --radius-sm: 8px;
  --radius-md: 12px;
  --radius-lg: 16px;
  --radius-full: 999px;

  /* Sidebar */
  --sidebar-width: 280px;
}

/* === Light Mode Override === */
@media (prefers-color-scheme: light) {
  :root {
    --color-bg-primary: #f5f5f7;
    --color-bg-secondary: #ffffff;
    --color-bg-tertiary: #f0f0f2;
    --color-bg-glass: rgba(255, 255, 255, 0.72);
    --color-bg-glass-hover: rgba(255, 255, 255, 0.82);
    --color-text-primary: #1d1d1f;
    --color-text-secondary: #6e6e73;
    --color-text-tertiary: #a1a1a6;
    --color-text-inverse: #f5f5f7;
    --color-separator: rgba(0, 0, 0, 0.08);
    --color-separator-opaque: #d2d2d7;
    --shadow-sm: 0 1px 2px rgba(0, 0, 0, 0.06);
    --shadow-md: 0 4px 12px rgba(0, 0, 0, 0.08);
    --shadow-lg: 0 8px 32px rgba(0, 0, 0, 0.12);
    --shadow-float: 0 12px 48px rgba(0, 0, 0, 0.16);
  }
}

/* === Reset === */
*, *::before, *::after {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

/* === Base === */
html {
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  text-rendering: optimizeLegibility;
}

body {
  background: var(--color-bg-primary);
  color: var(--color-text-primary);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: 1.5;
  height: 100vh;
  overflow: hidden;
}

.app {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

/* Focus Styles */
:focus-visible {
  outline: 2px solid var(--color-accent);
  outline-offset: 2px;
  border-radius: 4px;
}

button:focus:not(:focus-visible) { outline: none; }

/* ============================================================
   NAV BAR
   ============================================================ */
.nav-bar {
  position: sticky;
  top: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 52px;
  padding: 0 20px;
  background: var(--color-bg-glass);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  border-bottom: 1px solid var(--color-separator);
  flex-shrink: 0;
}

.nav-bar__leading {
  display: flex;
  align-items: center;
  gap: 12px;
}

.nav-bar__logo {
  font-size: 18px;
  line-height: 1;
}

.nav-bar__title {
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
  letter-spacing: var(--tracking-tight);
  color: var(--color-text-primary);
}

.nav-bar__session-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 12px;
  border-radius: var(--radius-full);
  border: 1px solid var(--color-separator-opaque);
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  font: var(--font-medium) var(--text-xs) / 1.2 var(--font-sans);
  cursor: pointer;
  transition: all 0.2s ease;
}

.nav-bar__session-badge:hover {
  background: var(--color-bg-glass-hover);
  color: var(--color-text-primary);
}

.nav-bar__session-badge--active {
  background: var(--color-success-dim);
  border-color: rgba(48, 209, 88, 0.3);
  color: var(--color-success);
}

.nav-bar__center {
  display: flex;
  align-items: center;
}

.nav-bar__trailing {
  display: flex;
  align-items: center;
  gap: 12px;
}

.nav-bar__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* --- Segmented Control --- */
.segmented-control {
  display: flex;
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-sm);
  padding: 2px;
  gap: 2px;
}

.segmented-control__item {
  padding: 5px 18px;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  font: var(--font-medium) var(--text-sm) / 1.2 var(--font-sans);
  cursor: pointer;
  transition: all 0.2s ease;
  white-space: nowrap;
}

.segmented-control__item:hover {
  color: var(--color-text-primary);
}

.segmented-control__item--active {
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  box-shadow: var(--shadow-sm);
}

/* --- Participant Stack --- */
.participant-stack {
  display: flex;
  margin-right: 4px;
}

.participant-stack .avatar-circle + .avatar-circle {
  margin-left: -6px;
}

/* --- Avatar --- */
.avatar-circle {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: var(--font-semibold);
  letter-spacing: var(--tracking-normal);
  border: 2px solid var(--color-bg-primary);
  flex-shrink: 0;
}

.avatar-circle--sm {
  width: 24px;
  height: 24px;
  font-size: 10px;
}

.avatar-circle--p1 { background: var(--color-p1-dim); color: var(--color-p1); }
.avatar-circle--p2 { background: var(--color-p2-dim); color: var(--color-p2); }
.avatar-circle--p3 { background: var(--color-p3-dim); color: var(--color-p3); }
.avatar-circle--p4 { background: var(--color-p4-dim); color: var(--color-p4); }

/* ============================================================
   BUTTONS
   ============================================================ */
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  border: none;
  border-radius: var(--radius-sm);
  font: var(--font-medium) var(--text-sm) / 1.2 var(--font-sans);
  cursor: pointer;
  transition: all 0.15s ease;
  white-space: nowrap;
  text-decoration: none;
}

.btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.btn--primary {
  background: var(--color-accent);
  color: white;
}

.btn--primary:hover:not(:disabled) {
  background: var(--color-accent-hover);
}

.btn--ghost {
  background: transparent;
  color: var(--color-text-secondary);
  border: 1px solid var(--color-separator-opaque);
}

.btn--ghost:hover:not(:disabled) {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.btn--danger {
  background: var(--color-error-dim);
  color: var(--color-error);
}

.btn--danger:hover:not(:disabled) {
  background: rgba(255, 69, 58, 0.25);
}

.btn--sm {
  padding: 5px 10px;
  font-size: var(--text-xs);
}

.btn--full-width {
  width: 100%;
}

.btn-icon {
  width: 32px;
  height: 32px;
  border-radius: var(--radius-sm);
  border: none;
  background: transparent;
  color: var(--color-text-secondary);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s ease;
  font-size: 16px;
  flex-shrink: 0;
}

.btn-icon:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.btn-icon--sm {
  width: 26px;
  height: 26px;
  font-size: 14px;
}

.btn-icon--danger:hover {
  background: var(--color-error-dim);
  color: var(--color-error);
}

/* ============================================================
   LAYOUT — DIRECTOR MODE
   ============================================================ */
.director-view {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.director-main {
  flex: 1;
  display: flex;
  overflow: hidden;
  min-width: 0;
}

.director-chat {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

/* --- Sidebar --- */
.sidebar {
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  background: var(--color-bg-secondary);
  border-right: 1px solid var(--color-separator);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: width 0.3s cubic-bezier(0.4, 0, 0.2, 1),
              min-width 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

.sidebar.collapsed {
  width: 0;
  min-width: 0;
  border-right: none;
}

.sidebar__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--color-separator);
  flex-shrink: 0;
}

.sidebar__title {
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
  color: var(--color-text-tertiary);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
}

.sidebar__section {
  padding: 12px 16px;
  border-bottom: 1px solid var(--color-separator);
}

.sidebar__section:last-child {
  border-bottom: none;
  margin-top: auto;
}

.sidebar__section-title {
  font-size: 10px;
  font-weight: var(--font-semibold);
  color: var(--color-text-tertiary);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
  margin-bottom: 8px;
}

.sidebar__info-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.sidebar__info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: var(--text-xs);
}

.sidebar__info-label {
  color: var(--color-text-tertiary);
}

.sidebar__info-value {
  color: var(--color-text-secondary);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}

.sidebar__info-value--copyable {
  cursor: pointer;
  padding: 1px 6px;
  border-radius: 4px;
  transition: background 0.1s ease;
}

.sidebar__info-value--copyable:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-accent);
}

.sidebar__export-buttons {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* Sidebar expand tab */
.sidebar-expand-tab {
  display: none;
  position: absolute;
  left: 0;
  top: 50%;
  transform: translateY(-50%);
  z-index: 10;
  width: 20px;
  height: 44px;
  align-items: center;
  justify-content: center;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-separator);
  border-left: none;
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--color-text-tertiary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.sidebar-expand-tab:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  width: 24px;
}

.sidebar.collapsed + .sidebar-expand-tab {
  display: flex;
}

/* --- File Tree --- */
.file-tree {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0;
  font-size: var(--text-sm);
  font-family: var(--font-sans);
}

.file-tree-empty {
  padding: 24px 16px;
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
  line-height: 1.6;
  text-align: center;
}

.ft-item {
  display: flex;
  align-items: center;
  padding: 4px 12px;
  cursor: pointer;
  transition: background 0.1s ease;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  border-radius: 6px;
  margin: 0 4px;
  gap: 4px;
}

.ft-item:hover {
  background: var(--color-bg-tertiary);
}

.ft-item.active {
  background: var(--color-accent-dim);
  color: var(--color-accent);
}

.ft-item.changed {
  color: var(--color-success);
}

.ft-icon {
  width: 16px;
  text-align: center;
  font-size: var(--text-xs);
  flex-shrink: 0;
  opacity: 0.6;
}

.ft-folder .ft-icon { color: var(--color-p4); opacity: 1; }
.ft-file .ft-icon { color: var(--color-text-tertiary); }
.ft-file.changed .ft-icon { color: var(--color-success); }

.ft-name {
  overflow: hidden;
  text-overflow: ellipsis;
}

.ft-indent {
  display: inline-block;
  width: 16px;
  flex-shrink: 0;
}

.ft-badge {
  margin-left: auto;
  padding: 0 5px;
  font-size: 9px;
  font-weight: var(--font-semibold);
  border-radius: 4px;
  background: var(--color-success-dim);
  color: var(--color-success);
  flex-shrink: 0;
}

/* --- Director Header --- */
.director-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--color-separator);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.panel-info h2 {
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
  color: var(--color-text-primary);
}

.role-tag {
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
}

.msg-count {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  padding: 3px 10px;
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
  font-weight: var(--font-medium);
}

/* --- File Viewer --- */
.file-viewer {
  width: 45%;
  min-width: 300px;
  border-left: 1px solid var(--color-separator);
  display: flex;
  flex-direction: column;
  background: var(--color-bg-primary);
}

.file-viewer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 16px;
  border-bottom: 1px solid var(--color-separator);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.file-viewer-path {
  font-size: var(--text-sm);
  font-family: var(--font-mono);
  color: var(--color-accent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.file-viewer-content {
  flex: 1;
  overflow: auto;
  padding: 16px;
  font-family: var(--font-mono);
  font-size: var(--text-code);
  line-height: 1.65;
  color: var(--color-text-primary);
  white-space: pre;
  tab-size: 2;
}

.file-viewer-content .line-added {
  background: var(--color-success-dim);
  display: block;
}

.file-viewer-content .line-removed {
  background: var(--color-error-dim);
  display: block;
  text-decoration: line-through;
  opacity: 0.6;
}

/* ============================================================
   MESSAGES (shared between Director + Peer)
   ============================================================ */
.messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  scroll-behavior: smooth;
}

.message {
  max-width: 82%;
  padding: 12px 16px;
  border-radius: var(--radius-lg);
  font-size: var(--text-base);
  line-height: 1.5;
  animation: message-enter 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-separator);
}

.message.sent {
  align-self: flex-end;
  border-bottom-right-radius: 6px;
  background: var(--color-accent-dim);
  border-color: rgba(10, 132, 255, 0.2);
}

.message.received {
  align-self: flex-start;
  border-bottom-left-radius: 6px;
}

/* Director mode message coloring */
.director-view .message.received {
  background: var(--color-p2-dim);
  border-color: rgba(48, 209, 88, 0.2);
}

/* Peer mode message coloring */
.panel-a .message.sent { background: var(--color-p3-dim); border-color: rgba(191, 90, 242, 0.2); }
.panel-a .message.received { background: var(--color-p4-dim); border-color: rgba(255, 159, 10, 0.2); }
.panel-b .message.sent { background: var(--color-p4-dim); border-color: rgba(255, 159, 10, 0.2); }
.panel-b .message.received { background: var(--color-p3-dim); border-color: rgba(191, 90, 242, 0.2); }

.message .sender {
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
  margin-bottom: 4px;
  color: var(--color-text-secondary);
}

.message .content {
  word-break: break-word;
  white-space: pre-wrap;
  color: var(--color-text-primary);
}

.message .meta {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 8px;
  font-size: 10px;
  color: var(--color-text-tertiary);
}

/* File change messages */
.message.file-change {
  max-width: 92%;
  background: var(--color-success-dim);
  border: 1px solid rgba(48, 209, 88, 0.2);
}

.message.file-change .file-path {
  color: var(--color-success);
  font-weight: var(--font-semibold);
  font-family: var(--font-mono);
  font-size: var(--text-sm);
  cursor: pointer;
}

.message.file-change .file-path:hover {
  text-decoration: underline;
}

.message.file-change .diff-preview {
  margin-top: 8px;
  padding: 8px 10px;
  background: rgba(0, 0, 0, 0.25);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: 1.5;
  max-height: 120px;
  overflow: hidden;
}

/* Message type chips */
.message-type {
  font-size: 10px;
  font-weight: var(--font-medium);
  padding: 2px 8px;
  border-radius: 6px;
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
}

.message-type.insight       { background: var(--color-p3-dim); color: var(--color-p3); }
.message-type.question      { background: var(--color-p4-dim); color: var(--color-p4); }
.message-type.answer        { background: var(--color-success-dim); color: var(--color-success); }
.message-type.task          { background: var(--color-info-dim); color: var(--color-info); }
.message-type.context       { background: var(--color-accent-dim); color: var(--color-accent); }
.message-type.architecture  { background: var(--color-p3-dim); color: var(--color-p3); }
.message-type.patterns      { background: var(--color-p4-dim); color: var(--color-p4); }
.message-type.status_update { background: var(--color-accent-dim); color: var(--color-accent); }
.message-type.file_tree,
.message-type.file_change,
.message-type.file_read,
.message-type.terminal      { background: var(--color-bg-tertiary); color: var(--color-text-secondary); }

/* Sender & Participant Badges */
.sender-tag {
  font-size: 9px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: var(--font-semibold);
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-left: 4px;
}

.sender-tag.agent { background: var(--color-p3-dim); color: var(--color-p3); }
.sender-tag.human { background: var(--color-success-dim); color: var(--color-success); }

.participant-badge {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: var(--font-semibold);
  letter-spacing: 0.3px;
  margin-left: 4px;
  white-space: nowrap;
}

.participant-badge .role-icon {
  font-size: 10px;
}

.badge-creator       { background: var(--color-p1-dim); color: var(--color-p1); }
.badge-participant-1 { background: var(--color-p2-dim); color: var(--color-p2); }
.badge-participant-2 { background: var(--color-p4-dim); color: var(--color-p4); }
.badge-participant-3 { background: var(--color-p3-dim); color: var(--color-p3); }

/* System messages */
.system-msg {
  text-align: center;
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
  padding: 8px 16px;
  background: var(--color-bg-tertiary);
  border-radius: var(--radius-sm);
  align-self: center;
  max-width: 80%;
}

/* ============================================================
   INPUT AREA
   ============================================================ */
.director-input {
  display: flex;
  gap: 10px;
  padding: 12px 20px 16px;
  border-top: 1px solid var(--color-separator);
  background: var(--color-bg-glass);
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
  align-items: flex-end;
}

.director-input select {
  appearance: none;
  -webkit-appearance: none;
  background: var(--color-bg-tertiary);
  border: 1px solid var(--color-separator-opaque);
  border-radius: var(--radius-sm);
  padding: 8px 28px 8px 10px;
  font: var(--font-medium) var(--text-xs) / 1.2 var(--font-sans);
  color: var(--color-text-secondary);
  cursor: pointer;
  outline: none;
  align-self: flex-end;
}

.director-input select:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}

.director-input textarea {
  flex: 1;
  resize: none;
  padding: 10px 14px;
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-separator-opaque);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font: var(--font-regular) var(--text-base) / 1.5 var(--font-sans);
  outline: none;
  min-height: 44px;
  max-height: 160px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.director-input textarea:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}

.director-input textarea::placeholder {
  color: var(--color-text-tertiary);
}

.director-input .btn-primary {
  align-self: flex-end;
  padding: 10px 20px;
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
}

/* ============================================================
   SESSION BAR
   ============================================================ */
.session-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 20px;
  border-bottom: 1px solid var(--color-separator);
  background: var(--color-bg-secondary);
  font-size: var(--text-xs);
  flex-shrink: 0;
}

.invite-label {
  color: var(--color-text-tertiary);
}

.invite-token {
  padding: 3px 10px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-separator-opaque);
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--color-accent);
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.divider {
  color: var(--color-separator-opaque);
}

.input-sm {
  padding: 6px 12px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-separator-opaque);
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
  font: var(--font-regular) var(--text-sm) / 1.4 var(--font-sans);
  outline: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.input-sm:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}

/* Export button */
.btn-export {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: var(--radius-sm);
  background: transparent;
  border: 1px solid var(--color-separator-opaque);
  color: var(--color-text-secondary);
  font: var(--font-medium) var(--text-xs) / 1.2 var(--font-sans);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-export:hover {
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
}

.btn-export-icon {
  font-size: 14px;
}

/* ============================================================
   MODE TOGGLE (legacy — kept for JS compatibility)
   ============================================================ */
.topbar { display: none; }

/* If using the old topbar structure, these styles still apply: */
.mode-toggle {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
}

.mode-label {
  font-size: var(--text-sm);
  font-weight: var(--font-medium);
  color: var(--color-text-tertiary);
  transition: color 0.2s ease;
}

.mode-label.active {
  color: var(--color-text-primary);
}

.toggle-track {
  width: 44px;
  height: 24px;
  border-radius: 12px;
  background: var(--color-accent);
  position: relative;
  transition: background 0.3s ease;
}

.toggle-track.peer {
  background: var(--color-p3);
}

.toggle-thumb {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: white;
  position: absolute;
  top: 2px;
  left: 2px;
  transition: transform 0.3s cubic-bezier(0.34, 1.56, 0.64, 1);
  box-shadow: var(--shadow-sm);
}

.toggle-track.peer .toggle-thumb {
  transform: translateX(20px);
}

/* ============================================================
   PEER MODE
   ============================================================ */
.peer-view {
  flex: 1;
  display: flex;
  overflow: hidden;
}

.panel {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--color-separator);
  background: var(--color-bg-secondary);
  flex-shrink: 0;
}

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: var(--font-bold);
  font-size: 14px;
  flex-shrink: 0;
}

.avatar-a { background: var(--color-p3-dim); color: var(--color-p3); border: 1px solid var(--color-p3); }
.avatar-b { background: var(--color-p4-dim); color: var(--color-p4); border: 1px solid var(--color-p4); }
.avatar-worker { background: var(--color-p1-dim); color: var(--color-p1); border: 1px solid var(--color-p1); }

/* --- Spine --- */
.spine {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px 0;
  width: 48px;
  flex-shrink: 0;
}

.spine-line {
  flex: 1;
  width: 2px;
  background: linear-gradient(to bottom, var(--color-p3), var(--color-p4));
  border-radius: 1px;
  opacity: 0.3;
  transition: opacity 0.3s ease;
}

.spine-line.active {
  animation: status-pulse 2s ease-in-out infinite;
  opacity: 1;
}

.spine-label {
  writing-mode: vertical-rl;
  text-orientation: mixed;
  font-size: 10px;
  color: var(--color-text-tertiary);
  letter-spacing: 2px;
  text-transform: uppercase;
}

/* ============================================================
   TYPING INDICATOR
   ============================================================ */
.typing-indicator {
  padding: 8px 20px;
  display: none;
  gap: 4px;
  align-items: center;
}

.typing-indicator.active { display: flex; }

.typing-indicator span {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
  animation: typing-bounce 1.2s ease infinite;
}

.typing-indicator span:nth-child(2) { animation-delay: 0.15s; }
.typing-indicator span:nth-child(3) { animation-delay: 0.3s; }

/* ============================================================
   WORKER STATUS PILL
   ============================================================ */
.worker-status-pill {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
  font-size: var(--text-xs);
  margin-right: 8px;
}

.worker-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
  transition: background 0.3s ease;
}

.worker-status-dot.active {
  background: var(--color-success);
  box-shadow: 0 0 6px var(--color-success);
  animation: status-pulse 1.5s ease-in-out infinite;
}

.worker-status-dot.writing {
  background: var(--color-p4);
  box-shadow: 0 0 6px var(--color-p4);
  animation: status-pulse 0.8s ease-in-out infinite;
}

.worker-status-dot.testing {
  background: var(--color-p3);
  box-shadow: 0 0 6px var(--color-p3);
  animation: status-pulse 1s ease-in-out infinite;
}

/* ============================================================
   STATUS BAR (Bottom)
   ============================================================ */
.bottombar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 28px;
  padding: 0 20px;
  border-top: 1px solid var(--color-separator);
  background: var(--color-bg-secondary);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  flex-shrink: 0;
}

/* Nostr badge */
.nostr-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 8px;
  border-radius: 6px;
  background: var(--color-p3-dim);
  border: 1px solid rgba(191, 90, 242, 0.2);
  font-size: var(--text-xs);
  color: var(--color-text-tertiary);
  margin-right: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.nostr-badge:hover {
  background: rgba(191, 90, 242, 0.2);
}

.nostr-badge.active {
  border-color: var(--color-p3);
  color: var(--color-p3);
}

.nostr-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-text-tertiary);
  transition: background 0.3s ease;
}

.nostr-badge.active .nostr-dot {
  background: var(--color-p3);
  box-shadow: 0 0 6px var(--color-p3);
}

/* Connection status */
.status-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-error);
  transition: background 0.3s ease;
}

.status-dot.connected {
  background: var(--color-success);
  box-shadow: 0 0 8px var(--color-success);
}

.session-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: var(--radius-full);
  background: var(--color-bg-tertiary);
  color: var(--color-text-tertiary);
  font-size: var(--text-xs);
  transition: all 0.2s ease;
  cursor: default;
}

.session-badge.active {
  background: var(--color-success-dim);
  color: var(--color-success);
  cursor: pointer;
}

/* ============================================================
   TOAST
   ============================================================ */
.toast {
  position: fixed;
  bottom: 40px;
  left: 50%;
  transform: translateX(-50%) translateY(10px);
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  padding: 10px 20px;
  border-radius: var(--radius-md);
  font-size: var(--text-sm);
  font-weight: var(--font-medium);
  box-shadow: var(--shadow-lg);
  border: 1px solid var(--color-separator);
  opacity: 0;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  pointer-events: none;
  z-index: 300;
  backdrop-filter: blur(20px) saturate(180%);
  -webkit-backdrop-filter: blur(20px) saturate(180%);
}

.toast.show {
  opacity: 1;
  transform: translateX(-50%) translateY(0);
}

/* ============================================================
   MODAL
   ============================================================ */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 200;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fade-in 0.2s ease;
}

.modal-overlay::before {
  content: '';
  position: fixed;
  inset: 0;
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  z-index: -1;
}

.modal-card {
  background: var(--color-bg-secondary);
  border: 1px solid var(--color-separator);
  border-radius: var(--radius-lg);
  width: 440px;
  max-width: 90vw;
  box-shadow: var(--shadow-float);
  animation: modal-enter 0.25s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  z-index: 1;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--color-separator);
}

.modal-header h3 {
  font-size: var(--text-lg);
  font-weight: var(--font-semibold);
  color: var(--color-text-primary);
}

.modal-body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.modal-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--text-xs);
  font-weight: var(--font-medium);
  color: var(--color-text-secondary);
  text-transform: uppercase;
  letter-spacing: var(--tracking-wide);
}

.modal-hint {
  text-transform: none;
  letter-spacing: var(--tracking-normal);
  font-weight: var(--font-regular);
  opacity: 0.6;
}

.modal-input {
  padding: 10px 12px;
  background: var(--color-bg-primary);
  border: 1px solid var(--color-separator-opaque);
  border-radius: var(--radius-sm);
  color: var(--color-text-primary);
  font: var(--font-regular) var(--text-sm) / 1.4 var(--font-sans);
  outline: none;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.modal-input:focus {
  border-color: var(--color-accent);
  box-shadow: 0 0 0 3px var(--color-focus-ring);
}

.modal-input::placeholder {
  color: var(--color-text-tertiary);
}

.modal-status {
  font-size: var(--text-sm);
  min-height: 18px;
  line-height: 1.4;
}

.modal-status.error { color: var(--color-error); }
.modal-status.success { color: var(--color-success); }

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 14px 20px;
  border-top: 1px solid var(--color-separator);
}

/* ============================================================
   ANIMATIONS
   ============================================================ */
@keyframes message-enter {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}

@keyframes typing-bounce {
  0%, 60%, 100% { transform: translateY(0); }
  30% { transform: translateY(-4px); }
}

@keyframes status-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

@keyframes fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes modal-enter {
  from { opacity: 0; transform: scale(0.95) translateY(8px); }
  to { opacity: 1; transform: scale(1) translateY(0); }
}

/* ============================================================
   REDUCED MOTION
   ============================================================ */
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

/* ============================================================
   SCROLLBARS
   ============================================================ */
::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}

::-webkit-scrollbar-track {
  background: transparent;
}

::-webkit-scrollbar-thumb {
  background: var(--color-separator-opaque);
  border-radius: 3px;
}

::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-tertiary);
}

/* Firefox */
* {
  scrollbar-width: thin;
  scrollbar-color: var(--color-separator-opaque) transparent;
}

/* ============================================================
   RESPONSIVE — TABLET (768px - 1199px)
   ============================================================ */
@media (max-width: 1199px) {
  :root {
    --sidebar-width: 240px;
  }

  .file-viewer {
    width: 40%;
    min-width: 260px;
  }

  .message {
    max-width: 88%;
  }
}

/* ============================================================
   RESPONSIVE — COMPACT (below 768px)
   ============================================================ */
@media (max-width: 768px) {
  .sidebar {
    position: fixed;
    left: 0;
    top: 0;
    bottom: 0;
    z-index: 200;
    width: var(--sidebar-width);
    min-width: var(--sidebar-width);
    transform: translateX(-100%);
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
    box-shadow: var(--shadow-float);
  }

  .sidebar.open {
    transform: translateX(0);
  }

  .sidebar.collapsed {
    width: var(--sidebar-width);
    min-width: var(--sidebar-width);
    transform: translateX(-100%);
  }

  .sidebar-expand-tab {
    display: flex !important;
  }

  .file-viewer {
    position: fixed;
    right: 0;
    top: 52px; /* nav bar height */
    bottom: 28px; /* status bar height */
    width: 90%;
    min-width: 0;
    z-index: 150;
    box-shadow: var(--shadow-float);
    transform: translateX(100%);
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .file-viewer.open {
    transform: translateX(0);
  }

  .message {
    max-width: 92%;
  }

  .nav-bar {
    padding: 0 12px;
    height: 48px;
  }

  .nav-bar__title {
    font-size: var(--text-sm);
  }

  .nav-bar__center {
    display: none;
  }

  .session-bar {
    padding: 6px 12px;
    flex-wrap: wrap;
  }

  .director-input {
    padding: 10px 12px 14px;
  }

  .messages {
    padding: 12px;
  }

  .bottombar {
    padding: 0 12px;
    font-size: 10px;
  }

  /* Peer mode: stack panels vertically */
  .peer-view {
    flex-direction: column;
  }

  .spine {
    flex-direction: row;
    width: auto;
    height: 32px;
    padding: 0 16px;
  }

  .spine-line {
    height: 2px;
    width: auto;
    flex: 1;
  }

  .spine-label {
    writing-mode: horizontal-tb;
    text-orientation: initial;
  }
}

/* ============================================================
   UTILITY CLASSES
   ============================================================ */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.truncate {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
```

---

## 8. HTML Structure

Complete semantic HTML skeleton for the redesigned dashboard. JavaScript references (`id` attributes) are preserved for backward compatibility with the existing `app.js`.

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="dark light">
  <title>Claude Relay</title>
  <link rel="stylesheet" href="/style.css">
</head>
<body>
  <div class="app">

    <!-- ====== Navigation Bar ====== -->
    <nav class="nav-bar" role="navigation" aria-label="Session navigation">
      <div class="nav-bar__leading">
        <span class="nav-bar__logo" aria-hidden="true">&#x27e1;</span>
        <h1 class="nav-bar__title">Claude Relay</h1>
        <button class="nav-bar__session-badge" id="session-badge"
                aria-label="Session ID: none">
          no session
        </button>
      </div>

      <div class="nav-bar__center">
        <div class="segmented-control" id="mode-toggle" role="tablist">
          <button class="segmented-control__item segmented-control__item--active"
                  role="tab" aria-selected="true" data-mode="director">
            Director
          </button>
          <button class="segmented-control__item"
                  role="tab" aria-selected="false" data-mode="peer">
            Peer
          </button>
        </div>
      </div>

      <div class="nav-bar__trailing">
        <div class="worker-status-pill" id="worker-pill" style="display:none">
          <span class="worker-status-dot" id="worker-dot"></span>
          <span id="worker-activity">idle</span>
        </div>
        <span class="nostr-badge" id="nostr-badge" title="Nostr WebSocket status">
          <span class="nostr-dot" id="nostr-dot"></span>
          <span id="nostr-status">nostr: off</span>
        </span>
        <span class="status-dot" id="status-dot"></span>
        <span id="status-text" class="visually-hidden">disconnected</span>
      </div>
    </nav>

    <!-- ====== Session Bar ====== -->
    <div class="session-bar" id="session-bar" role="toolbar" aria-label="Session controls">
      <button id="btn-new-session" class="btn btn--primary btn--sm">+ New Session</button>

      <div class="session-controls" id="session-controls" style="display:none">
        <span class="invite-label">Invite token:</span>
        <code class="invite-token" id="invite-token"></code>
        <button class="btn btn--ghost btn--sm" id="btn-copy-invite">Copy</button>
        <span class="divider" aria-hidden="true">|</span>
        <button class="btn-export" id="btn-export"
                title="Click: JSON | Right-click: Markdown">
          <span class="btn-export-icon" aria-hidden="true">&#x2913;</span> Export
        </button>
        <button class="btn btn--ghost btn--sm" id="btn-export-pod"
                title="Export to Solid Pod">Pod</button>
        <span class="divider" aria-hidden="true">|</span>
        <button class="btn btn--ghost btn--sm btn-icon--danger" id="btn-end-session">End</button>
      </div>

      <div class="join-controls" id="join-controls" style="display:none">
        <input type="text" id="join-session-id" placeholder="Session ID"
               class="input-sm" aria-label="Session ID">
        <input type="text" id="join-invite-token" placeholder="Invite token"
               class="input-sm" aria-label="Invite token">
        <button class="btn btn--ghost btn--sm" id="btn-join">Join</button>
      </div>

      <div class="peer-controls" id="peer-controls" style="display:none">
        <select id="sim-picker" class="input-sm" aria-label="Simulation scenario">
          <option value="security">Security Audit Handoff</option>
          <option value="codereview">Code Review Handoff</option>
          <option value="bughunt">Bug Hunt Collab</option>
          <option value="workspace">Workspace Demo (with files)</option>
        </select>
        <button id="btn-simulate" class="btn btn--primary btn--sm">&#x25b6; Simulate</button>
        <button id="btn-clear" class="btn btn--ghost btn--sm">Clear</button>
      </div>
    </div>

    <!-- ====== DIRECTOR MODE ====== -->
    <main class="director-view" id="director-view" role="main">

      <!-- Sidebar -->
      <aside class="sidebar" id="sidebar" role="complementary" aria-label="Workspace">
        <div class="sidebar__header">
          <span class="sidebar__title">Workspace</span>
          <button class="btn-icon btn-icon--sm" id="btn-toggle-sidebar"
                  aria-label="Toggle sidebar">&#x25e8;</button>
        </div>
        <div class="file-tree" id="file-tree" role="tree" aria-label="Project files">
          <div class="file-tree-empty">
            No workspace data yet.<br>
            Worker will share file structure when connected.
          </div>
        </div>
      </aside>

      <!-- Sidebar expand tab -->
      <button class="sidebar-expand-tab" id="btn-expand-sidebar"
              aria-label="Show sidebar">&#x25e8;</button>

      <!-- Main content area -->
      <div class="director-main">
        <!-- Chat Panel -->
        <div class="director-chat" id="director-chat">
          <div class="director-header">
            <div class="avatar avatar-worker" aria-hidden="true">W</div>
            <div class="panel-info">
              <h2 id="worker-name">Waiting for worker...</h2>
              <span class="role-tag" id="worker-status">no one connected</span>
            </div>
            <div class="msg-count" id="director-count" aria-label="Message count">0 msgs</div>
          </div>

          <div class="messages" id="director-messages" role="log"
               aria-label="Message history" aria-live="polite"></div>

          <div class="typing-indicator" id="director-typing" aria-label="Typing">
            <span></span><span></span><span></span>
          </div>

          <div class="director-input">
            <select id="msg-type" class="input-sm" aria-label="Message type">
              <option value="question">Question</option>
              <option value="context">Instruction</option>
              <option value="answer">Feedback</option>
            </select>
            <textarea id="director-textarea"
                      placeholder="Type an instruction for the worker..."
                      rows="1"
                      aria-label="Message input"></textarea>
            <button id="btn-send" class="btn btn--primary"
                    aria-label="Send message">Send</button>
          </div>
        </div>

        <!-- File Viewer (hidden until file selected) -->
        <div class="file-viewer" id="file-viewer" style="display:none">
          <div class="file-viewer-header">
            <span class="file-viewer-path" id="file-viewer-path">No file selected</span>
            <button class="btn-icon btn-icon--sm" id="btn-close-viewer"
                    aria-label="Close file viewer">&#x2715;</button>
          </div>
          <pre class="file-viewer-content" id="file-viewer-content"
               role="document" aria-label="File contents"></pre>
        </div>
      </div>
    </main>

    <!-- ====== PEER MODE ====== -->
    <main class="peer-view" id="peer-view" style="display:none" role="main">
      <!-- Claude Alpha -->
      <section class="panel panel-a">
        <div class="panel-header">
          <div class="avatar avatar-a" aria-hidden="true">A</div>
          <div class="panel-info">
            <h2>Claude Alpha</h2>
            <span class="role-tag">researcher</span>
          </div>
          <div class="msg-count" id="count-a">0 msgs</div>
        </div>
        <div class="messages" id="messages-a" role="log" aria-label="Claude Alpha messages"></div>
        <div class="typing-indicator" id="typing-a" aria-label="Claude Alpha typing">
          <span></span><span></span><span></span>
        </div>
      </section>

      <!-- Relay Spine -->
      <div class="spine" aria-hidden="true">
        <div class="spine-line"></div>
        <div class="spine-label">relay</div>
        <div class="spine-line"></div>
      </div>

      <!-- Claude Beta -->
      <section class="panel panel-b">
        <div class="panel-header">
          <div class="avatar avatar-b" aria-hidden="true">B</div>
          <div class="panel-info">
            <h2>Claude Beta</h2>
            <span class="role-tag">implementer</span>
          </div>
          <div class="msg-count" id="count-b">0 msgs</div>
        </div>
        <div class="messages" id="messages-b" role="log" aria-label="Claude Beta messages"></div>
        <div class="typing-indicator" id="typing-b" aria-label="Claude Beta typing">
          <span></span><span></span><span></span>
        </div>
      </section>
    </main>

    <!-- ====== Status Bar ====== -->
    <footer class="bottombar" role="status" aria-live="polite">
      <span id="relay-info">relay server: connecting...</span>
      <span id="nostr-info"></span>
      <span id="msg-total">0 messages relayed</span>
    </footer>
  </div>

  <!-- ====== Solid Pod Export Modal ====== -->
  <div class="modal-overlay" id="solid-export-modal" style="display:none"
       role="dialog" aria-modal="true" aria-labelledby="solid-modal-title">
    <div class="modal-card">
      <div class="modal-header">
        <h3 id="solid-modal-title">Export to Solid Pod</h3>
        <button class="btn-icon btn-icon--sm" id="btn-solid-cancel-x"
                aria-label="Close">&#x2715;</button>
      </div>
      <div class="modal-body">
        <label class="modal-label">Pod URL
          <input type="text" id="solid-pod-url" class="modal-input"
                 placeholder="https://pod.example/alice/">
        </label>
        <label class="modal-label">OIDC Issuer
          <input type="text" id="solid-oidc-issuer" class="modal-input"
                 placeholder="https://login.example.com/">
        </label>
        <label class="modal-label">Client ID
          <input type="text" id="solid-client-id" class="modal-input"
                 placeholder="relay-dashboard">
        </label>
        <label class="modal-label">Client Secret
          <input type="password" id="solid-client-secret" class="modal-input"
                 placeholder="secret">
        </label>
        <label class="modal-label">Container Path
          <span class="modal-hint">(optional)</span>
          <input type="text" id="solid-container-path" class="modal-input"
                 placeholder="relay-sessions/">
        </label>
        <div class="modal-status" id="solid-export-status" aria-live="assertive"></div>
      </div>
      <div class="modal-footer">
        <button class="btn btn--ghost btn--sm" id="btn-solid-cancel">Cancel</button>
        <button class="btn btn--primary btn--sm" id="btn-solid-export">Export</button>
      </div>
    </div>
  </div>

  <script src="/app.js"></script>
</body>
</html>
```

---

## 9. Interaction Patterns

### Keyboard Shortcuts

| Shortcut | Action | Context |
|----------|--------|---------|
| `Enter` | Send message | Input area focused |
| `Shift+Enter` | New line in message | Input area focused |
| `Cmd+Enter` | Send message | Anywhere (when session active) |
| `Cmd+K` | Focus input area | Global |
| `Cmd+B` | Toggle sidebar | Director mode |
| `Cmd+\` | Toggle file viewer | Director mode, file selected |
| `Escape` | Close modal / Close file viewer / Deselect | Context-dependent |
| `Cmd+E` | Export session (JSON) | Session active |
| `Cmd+Shift+E` | Export session (Markdown) | Session active |
| `Cmd+N` | New session | No active session |
| `Tab` / `Shift+Tab` | Navigate between controls | Global |

### Drag-to-Resize Sidebar

The sidebar's right edge is a 4px-wide drag handle. On mousedown, the cursor changes to `col-resize`, and mousemove events update `--sidebar-width` in real-time. The minimum width is 200px, maximum is 400px. On mouseup, the final width is persisted to `localStorage`.

```
Drag handle: 4px invisible zone on the right edge of .sidebar
Cursor: col-resize
Min: 200px
Max: 400px
Persist: localStorage("relay-sidebar-width")
```

### Message Selection

- Click a message to select it (adds `.message--selected` class with a subtle highlight border).
- With a message selected, press `Q` to insert its content as a quote in the input area (prefixed with `> `).
- Multi-select with `Cmd+Click` for batch operations.
- Selected messages show a floating action bar: Copy, Quote, Reference.

### Context Menus

Right-click on a message to show a native-styled context menu (custom HTML positioned at cursor):

| Menu Item | Action |
|-----------|--------|
| Copy Text | Copy message content to clipboard |
| Copy as Markdown | Copy with sender, type, and timestamp |
| Quote in Reply | Insert quoted text into input |
| View Raw | Show raw JSON payload in a modal |
| Copy Message ID | Copy the message's unique ID |

The context menu is a positioned `<div>` that appears at the cursor position, dismisses on click-away or `Escape`.

### Toast Notifications

Toasts appear centered at the bottom of the viewport. They auto-dismiss after 3 seconds. Stack up to 3 simultaneously, with each new toast pushing older ones up.

| Event | Toast Text | Style |
|-------|-----------|-------|
| Export success | "Exported as JSON" | Default |
| Export failure | "Export failed: ..." | Error (red text) |
| Invite copied | "Invite token copied" | Success (green text) |
| Session created | "Session created" | Success |
| Connection lost | "Connection lost - reconnecting..." | Warning (yellow text) |
| Connection restored | "Reconnected" | Success |
| Message approved | "Message approved and sent" | Default |

### Drag-to-Resize File Viewer

The file viewer's left border is a 4px drag handle, allowing resize between 25%-60% of the main area width. Same behavior pattern as the sidebar handle.

---

## Summary of Changes from v2

| Area | v2 (current) | v3 (redesign) |
|------|-------------|---------------|
| Font | SF Mono (monospace primary) | SF Pro (sans-serif primary, mono for code) |
| Background | `#0d1117` (GitHub dark) | `#1a1a1e` (Apple dark) |
| Nav bar | Opaque surface | Frosted glass with `backdrop-filter` |
| Mode toggle | Custom track + thumb | Apple-style segmented control |
| Avatars | Rounded square (10px) | Circle (50%) with overlap stacking |
| Messages | `var(--radius)` 12px | 16px with 6px on pointer side |
| Input area | Monospace textarea | Sans-serif, rounded compose box with focus ring |
| Sidebar | 260px fixed | 280px resizable, with sections |
| Session setup | Inline session bar only | Centered card-based onboarding |
| Color palette | GitHub-inspired (purple/orange/blue) | Apple system colors (SF Blue, Green, Purple, Orange) |
| Accessibility | Minimal | WCAG AA, ARIA labels, focus-visible, reduced-motion |
| Light mode | None | `prefers-color-scheme` media query |
| Status bar | Basic footer | Structured 3-section bar |
| Toasts | Green-tinted only | Semantic colors, stacking |
| Modals | Opaque backdrop | Blurred backdrop, scale+fade animation |
