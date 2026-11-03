---
name: Desktop Workbench Safe
colors:
  surface: '#f8f9ff'
  surface-dim: '#cbdbf5'
  surface-bright: '#f8f9ff'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#eff4ff'
  surface-container: '#e5eeff'
  surface-container-high: '#dce9ff'
  surface-container-highest: '#d3e4fe'
  on-surface: '#0b1c30'
  on-surface-variant: '#3c4a42'
  inverse-surface: '#213145'
  inverse-on-surface: '#eaf1ff'
  outline: '#6c7a71'
  outline-variant: '#bbcabf'
  surface-tint: '#006c49'
  primary: '#006c49'
  on-primary: '#ffffff'
  primary-container: '#10b981'
  on-primary-container: '#00422b'
  inverse-primary: '#4edea3'
  secondary: '#00687a'
  on-secondary: '#ffffff'
  secondary-container: '#57dffe'
  on-secondary-container: '#006172'
  tertiary: '#9d4300'
  on-tertiary: '#ffffff'
  tertiary-container: '#ff7e2d'
  on-tertiary-container: '#622700'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#6ffbbe'
  primary-fixed-dim: '#4edea3'
  on-primary-fixed: '#002113'
  on-primary-fixed-variant: '#005236'
  secondary-fixed: '#acedff'
  secondary-fixed-dim: '#4cd7f6'
  on-secondary-fixed: '#001f26'
  on-secondary-fixed-variant: '#004e5c'
  tertiary-fixed: '#ffdbca'
  tertiary-fixed-dim: '#ffb690'
  on-tertiary-fixed: '#341100'
  on-tertiary-fixed-variant: '#783200'
  background: '#f8f9ff'
  on-background: '#0b1c30'
  surface-variant: '#d3e4fe'
typography:
  headline-xl:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 32px
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: '600'
    lineHeight: 24px
    letterSpacing: -0.015em
  headline-sm:
    fontFamily: Inter
    fontSize: 15px
    fontWeight: '600'
    lineHeight: 20px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: -0.005em
  body-md:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: '400'
    lineHeight: 18px
    letterSpacing: 0em
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0em
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: '500'
    lineHeight: 16px
    letterSpacing: 0.01em
  label-sm:
    fontFamily: Inter
    fontSize: 11px
    fontWeight: '600'
    lineHeight: 14px
    letterSpacing: 0.02em
  code-sm:
    fontFamily: JetBrains Mono, monospace
    fontSize: 12px
    fontWeight: '400'
    lineHeight: 16px
    letterSpacing: 0em
rounded:
  sm: 0.25rem
  DEFAULT: 0.5rem
  md: 0.75rem
  lg: 1rem
  xl: 1.5rem
  full: 9999px
spacing:
  gutter: 1rem
  gutter-dense: 0.5rem
  margin: 1.5rem
  margin-dense: 1rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 0.75rem
  space-lg: 1rem
  space-xl: 1.5rem
  space-2xl: 2rem
---

## Brand & Style

This design system establishes a high-density, dependable desktop workbench interface tailored for configuration-heavy developer workflows, model switches, and provider credential management. The emotional tone is focused, robust, and zero-friction—instilling absolute confidence when handling sensitive API tokens, switching routing engines, or monitoring active latency metrics.

The visual style blends modern utilitarian software architecture with high-precision engineering surfaces. Drawing from native macOS and desktop utility patterns (such as system managers and native settings panels), the interface emphasizes:
- Structural framing over excessive ornamental elevation.
- Clear structural zoning separating navigation, master lists, detail inspectors, and metric outputs.
- Laser-sharp emerald signals that communicate online provider health, authenticated state, and operational readiness.

## Colors

The color palette is built around high-legibility cool slate foundations accented with distinct, purposeful status hues:

- **Primary (`#10B981`)**: The primary emerald green serves as the foundational validation color. Used for active provider indicators, healthy endpoint pings, toggled states, and primary confirmational actions.
- **Secondary (`#06B6D4`)**: A crisp cyan utilized strictly for secondary system cues—such as active token usage pills, real-time routing badges, and diagnostic telemetry tags.
- **Tertiary (`#F97316`)**: An amber-orange accent allocated specifically for high-priority operational interactions, reconnect calls, sync triggers, and warning states.
- **Neutrals**:
  - `Canvas Base`: `#F8FAFC` (Slate 50) for outer frame borders and utility sidebars.
  - `Panel Base`: `#FFFFFF` for primary content cards, workspace panels, and inspector fields.
  - `Muted Surfaces`: `#F1F5F9` (Slate 100) for nested groups, code blocks, and inactive control rails.
  - `Dividers & Outlines`: `#E2E8F0` (Slate 200) for crisp, structural segment boundaries.
  - `Text Hierarchy`: Primary text sits at `#0F172A` (Slate 900) for absolute contrast, with secondary metadata at `#334155` (Slate 700) and tertiary hints at `#64748B` (Slate 500).

## Typography

The typography leverages `Inter` across all structural layers to maximize visual density and native operational ergonomics. 

- **Typographic Scale**: Scaled conservatively for dense desktop layouts. The maximum headline size does not exceed `24px`, ensuring multiple inspectable tiers remain visible above the fold.
- **Tabular Figures**: Numeric data, latency trackers, token counts, and API response gauges must enable OpenType tabular numbers (`font-variant-numeric: tabular-nums`) to avoid layout jitter during live telemetry updates.
- **Monospace Code Elements**: Technical strings, environment variable keys, endpoint URLs, and secret tokens fallback cleanly to monospaced variants at `12px` to prevent ambiguity between special characters.

## Layout & Spacing

The layout utilizes a multi-pane workbench arrangement:
- **Left Navigation Rail**: Fixed width (240px–280px) for switching core configurations (Providers, Key Vault, Routing Tables, Logs).
- **Master-Detail Canvas**: A split-view structural container with 16px (`gutter`) separation. The master panel lists providers and models; the detail surface inspects connection strings, parameters, and health parameters.
- **Rhythm & Grid**: An 8pt base grid with a 4pt sub-grid for compact desktop density. Component internal paddings default to 8px (`space-sm`) vertical by 12px horizontal, conserving vertical screen real estate.
- **Adaptive Breakpoints**:
  - `Desktop Expanded` (>1280px): Persistent three-pane layout (Navigation, Provider List, Inspector Pane).
  - `Desktop Standard` (1024px–1279px): Collapsible left rail with persistent master-detail view.
  - `Compact Window` (<1023px): Tabbed panel navigation replacing simultaneous multi-pane inspectors.

## Elevation & Depth

Depth is established primarily through structural borders and subtle ambient micro-shadows rather than high-elevation z-axis shifts:

- **Flat Border Baseline**: Panels, cards, and inputs share a persistent `1px solid #E2E8F0` border.
- **Surface Layering**:
  - Canvas window: `#F8FAFC`
  - Active workspace container: `#FFFFFF`
  - Inactive or read-only segment: `#F1F5F9`
- **Subtle Ambient Shadows**:
  - `Elevation 0`: Pure flat surface with 1px hairline border.
  - `Elevation 1 (Card / Hover)`: `0px 1px 2px 0px rgba(15, 23, 42, 0.05)`.
  - `Elevation 2 (Flyout / Dropdown / Modal)`: `0px 4px 6px -1px rgba(15, 23, 42, 0.08), 0px 2px 4px -2px rgba(15, 23, 42, 0.04)`.
- **Focus Rings**: Sharp, clean focus outlines using `0 0 0 2px rgba(16, 185, 129, 0.25)` anchored tightly around active controls.

## Shapes

The design system employs a roundedness index of `2` (medium-soft architecture):
- Standard interactive elements (buttons, inputs, select fields) use an outer border radius of `0.5rem` (8px).
- Embedded sub-controls, inner tags, and small status pills scale down to `0.25rem`–`0.375rem` (4px–6px) to maintain nested proportional curvature.
- Large container panels, settings cards, and workbench inspectors feature an outer corner radius of `0.75rem` (12px).
- Full capsule rounding (`9999px`) is reserved exclusively for status indicators, live badge pills, and model version chips.

## Components

### Buttons
- **Primary Action (Emerald)**: `#10B981` background, `#FFFFFF` text, `0.5rem` radius. Subtle hover state to `#059669`. Used for "Save Provider", "Apply Changes", and primary confirmations.
- **Accent Action (Orange)**: `#F97316` background, `#FFFFFF` text. Used for imperative operational triggers such as "Rotate API Key", "Sync Remote Models", or "Re-index Endpoints".
- **Secondary Neutral**: `#FFFFFF` background, `1px solid #E2E8F0` border, `#0F172A` text. Hover shifts to `#F8FAFC`.
- **Ghost Utility**: Transparent background, `#334155` text, subtle `#F1F5F9` hover fill for toolbars and quick copy-paste icon actions.

### Provider Status Chips & Badges
- **Status Capsules**: Full capsule radius (`9999px`), `11px` typography with `font-weight: 600`.
  - *Active / Ready*: Background `#ECFDF5`, text `#065F46`, paired with a `6px` solid `#10B981` pulsing dot.
  - *Telemetry / Routing*: Background `#ECFEFF`, text `#155E75`, border `1px solid #CFFAFE`.
  - *Degraded / High Latency*: Background `#FFF7ED`, text `#9A3412`, border `1px solid #FFEDD5`.

### Input Fields & Key Obfuscation
- Height constrained to `36px` for dense utility.
- Background `#FFFFFF`, border `1px solid #E2E8F0`, typography `#0F172A`.
- Suffix icon slots for visibility toggles (`Show/Hide Secret`) and one-click clipboard copying.
- Focus state applies a border color of `#10B981` with a `2px` emerald glow ring.

### Provider Management Cards & List Items
- Stacked list layout with `1px solid #E2E8F0` dividing lines.
- Hover state applies `#F8FAFC` transition.
- Selected state applies a `2px` left border highlight in `#10B981` alongside an active background of `#F0FDF4`.
- Right-aligned metadata cluster displaying provider model latency (e.g., `124ms`), status badge, and switch toggle.

### Switches & Checkboxes
- **Toggle Switches**: Compact `36px x 20px` track. Inactive track is `#E2E8F0`; active state transitions to `#10B981`. Pure white handle with slight `1px` shadow.
- **Checkboxes**: `16px x 16px` box with `4px` corner radius. Crisp white checkmark over an emerald background when selected.