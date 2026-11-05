# ExperienceQuality SDLC

Lightweight Scrum for every product in the org. Keep this short and follow it.

## Cadence

- **Sprints:** 2 weeks per product.
- **Releases:** weekly per product (can ship multiple times in a sprint).
- Each product lead runs its own cadence.
- Status to David only when something changed.
- One review per product with David (not a standing multi-product meeting).

## Roles and handoffs

| Role | Artifact | Paired test (V) |
| --- | --- | --- |
| Product Analyst | Acceptance criteria | Acceptance tests |
| Product Designer | User flow | Flow check at the demo |
| Solution Designer | Spec | System and API tests |
| Software Architect | Architecture decisions | Integration and contract tests |
| Coding agents | Code | Unit tests |

- Bots send **one complete brief** and get **one consolidated reply**. No back-and-forth between bots.
- **David approves all AI-written code** before it merges.
- **Every acceptance criterion has a test.**
- **Feature flags** are optional and only for services.
- Bug fixes may skip the spec; features take the full V (artifact + paired test).

## Templates

Copy from [`sdlc-templates/`](./sdlc-templates/). Each template has a built-in **Paired test** section.

## Done

See [`DEFINITION_OF_DONE.md`](./DEFINITION_OF_DONE.md).
