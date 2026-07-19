# Custom Project Rules: Core Platform Freeze

The project has transitioned to a Production Baseline state. Architectural and business logic components are strictly frozen to prevent regressions, while the experience layer remains open for visual polish and refinement.

---

## 1. Component Boundaries

### Layer 1: Core Platform (FROZEN)
Do **NOT** modify the following components under any circumstances unless addressing a verified production defect:
*   **Scanner Engine & Decoders**: `libs/html5-qrcode.min.js`, custom formats, and resolution constraints.
*   **Camera Initialization & Lifecycle**: `CameraManager` startup, fallbacks, and permission handling.
*   **State Machine & Transitions**: `StateManager` flows, recovery intervals, and state structures.
*   **Lookup Pipeline**: Barcode scanning handlers, endpoint mapping, JSON parsing, API request/response handling.
*   **Backend & Data Services**: Upload logic, token authentication, product lookup routes, database schemas, and migration states.
*   **Infrastructure**: Service worker caching configurations, manifest definitions, and deployment build pipelines.

### Layer 2: Experience Layer (OPEN)
The following visual and interaction elements are open for refinement:
*   **Visual Styling**: Colors, gradients, borders, shadows, and layout layouts.
*   **Typography & Branding**: Font definitions, logo positioning, empty states, and mascot layouts.
*   **Motion & Micro-interactions**: Slide animations, loader designs, page transitions, and success/error status badges.
*   **UX Experience**: Customer journey layout flow, focus highlights, contrast and visual hierarchy, and screen responsiveness.

---

## 2. Acceptance Guidelines

Any visual modifications must satisfy:
1.  Camera stream initialization times are not degraded.
2.  Barcode decoding accuracy remains completely unaffected.
3.  StateManager triggers no unexpected transitions.
4.  No console errors or UI layout breakage across the supported cross-platform matrix.
