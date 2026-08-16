# Project Context for Claude Code

> Fill in the `<!-- TODO -->` bits with your real project details. Everything
> else is a solid default for a modern React/Next.js + Tailwind frontend.
> Keep this file under ~300 lines — Claude reads it every session, and a
> bloated file gets skimmed, not followed.

## Stack

<!-- TODO: confirm/adjust -->
- Framework: Next.js (App Router)
- Language: TypeScript
- Styling: Tailwind CSS
- Component primitives: shadcn/ui (built on Radix/Base UI)
- Package manager: pnpm

## Commands

<!-- TODO: fill in your actual scripts -->
- Dev server: `pnpm dev`
- Build: `pnpm build`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Test: `pnpm test`

Run lint + typecheck before considering a task done.

## Conventions

- Functional components only, no class components.
- Co-locate component + styles + tests in the same folder.
- Prefer server components by default; mark `"use client"` only when needed
  (state, effects, browser APIs, event handlers).
- Use Tailwind utility classes directly; avoid inline `style={}` unless a
  value is truly dynamic (e.g. computed from data).
- Spacing scale: stick to Tailwind's default 4px increments — don't invent
  arbitrary values like `mt-[13px]`.
- Colors: pull from the Tailwind theme/CSS variables, not one-off hex codes.
- Accessibility is not optional: semantic HTML, proper labels, keyboard
  navigation, visible focus states, sufficient contrast (WCAG 2.2 AA).
- No `any` in TypeScript unless there's a documented reason.

## Design approach

Before writing UI code, briefly establish: purpose, audience, and a specific
aesthetic direction (e.g. "calm and editorial" or "bold, high-contrast,
dashboard-dense") — not just "make it look nice." Avoid the generic AI
defaults (Inter font, purple gradient, rounded card grid) unless that
genuinely fits the brief. Give direction, not pixel-level specs — let Claude
make the detailed calls inside that frame.

## Workflow

1. For any nontrivial UI change, take a screenshot (via browser tooling) of
   the current state before and after.
2. Build one component/section at a time, not the whole page at once.
3. Verify in-browser (click through states: hover, loading, error, empty)
   before calling a task done — don't just trust that it compiles.
4. Run lint/typecheck as a final step.

---

## Open-source UI component libraries

| Library | Best for | Notes |
|---|---|---|
| **[shadcn/ui](https://ui.shadcn.com)** | Default choice for new React/Tailwind projects | Copy-paste components you own (not an npm dependency); built on Radix, moving toward Base UI |
| **[Base UI](https://base-ui.com)** | Headless primitives | From the MUI team; the actively-maintained successor to Radix's role as unstyled a11y-correct primitives |
| **[Radix UI](https://radix-ui.com)** | Headless primitives | Still solid, but development has slowed since the WorkOS acquisition |
| **[Ark UI](https://ark-ui.com)** | Headless, framework-agnostic | Works across React/Vue/Solid from one core |
| **[Chakra UI](https://chakra-ui.com)** | Prop-based styling instead of Tailwind | Good if the team prefers component props over utility classes |
| **[Mantine](https://mantine.dev)** | Full-featured app UI, lots of built-in hooks | Batteries-included alternative to assembling shadcn from parts |
| **[Ant Design](https://ant.design)** | Data-heavy dashboards/enterprise admin | Deep component set (tables, forms) out of the box |

## Open-source animated component libraries (pair with shadcn/ui)

| Library | Style | Notes |
|---|---|---|
| **[Magic UI](https://magicui.design)** | Utility animations: marquees, bento grids, shimmer, text effects | 150+ components, built on Motion + Tailwind, installs via shadcn CLI |
| **[Aceternity UI](https://ui.aceternity.com)** | Bold hero-section spectacle: 3D cards, spotlight, mesh gradients | Best for landing pages/marketing, not general app UI |
| **[Motion Primitives](https://motion-primitives.com)** | Subtle, production-appropriate motion | Sits between Aceternity's flash and shadcn's static defaults — closer to a Linear/Vercel feel |
| **[Animate UI](https://animate-ui.com)** | Animates shadcn's own primitives (accordion, dialog, sheet) | Keeps Radix accessibility intact while adding motion |
| **[Cult UI](https://cult-ui.com)** | Animated components + AI/agentic UI patterns | Good if you're building chat/agent interfaces |

## Animation engines (underneath the component libraries)

| Library | Use case |
|---|---|
| **[Motion](https://motion.dev)** (formerly Framer Motion) | Default choice for React component animation — gestures, layout animation, springs |
| **[GSAP](https://gsap.com)** | Complex timelines, scroll-driven animation, non-React projects |
| **[Lenis](https://lenis.darkroom.engineering)** | Smooth scroll |
| **[Vaul](https://vaul.emilkowal.ski)** | Drawer/bottom-sheet component with native-feeling motion |
| **[tailwindcss-animate](https://github.com/jamiebuilds/tailwindcss-animate)** | Lightweight CSS-only keyframe utilities for simple transitions |

**Rule of thumb:** use Motion Primitives or Animate UI for restrained, functional
product UI; reach for Magic UI or Aceternity UI when a landing page needs
visual "wow." Don't animate everything — apply motion selectively so it
reads as intentional, not decorative noise.
