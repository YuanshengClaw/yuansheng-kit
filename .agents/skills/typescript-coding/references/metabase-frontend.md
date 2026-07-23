# Metabase Frontend

Apply these rules only in the Metabase frontend repository. Check current
package scripts, lint rules, test configuration, and nearby code before relying
on a convention that may have changed.

## Contents

- [Commands](#commands)
- [TypeScript Rules](#typescript-rules)
- [State And Data Fetching](#state-and-data-fetching)
- [Components, UI, And Styling](#components-ui-and-styling)
- [Testing Standards](#testing-standards)
- [Readability And Maintainability](#readability-and-maintainability)
- [Review Checklist](#review-checklist)
- [References](#references)

## Commands

### Linting And Formatting

- Run ESLint on the frontend codebase with:

  ```sh
  bun run lint-eslint-pure
  ```

- Format code with Prettier:

  ```sh
  bun run prettier
  ```

- Run TypeScript type checking with:

  ```sh
  bun run type-check-pure
  ```

### JavaScript And TypeScript Tests

- Test a specific file:

  ```sh
  bun run test-unit-keep-cljs path/to/file.unit.spec.js
  ```

- Test by pattern:

  ```sh
  bun run test-unit-keep-cljs -t "pattern"
  ```

### ClojureScript Tests

- Run ClojureScript tests with:

  ```sh
  bun run test-cljs
  ```

### Command Selection

- Start with the narrowest command that covers the touched code.
- Use `test-unit-keep-cljs` for focused JavaScript or TypeScript unit tests when
  ClojureScript output is already current.
- Run `bun run test-cljs` when the change touches ClojureScript interop or
  generated CLJS output, or when failures indicate stale CLJS artifacts.
- Run `bun run type-check-pure` after TypeScript signature, API type, Redux
  state, or component prop changes.
- Run `bun run lint-eslint-pure` after non-trivial implementation changes and
  before handoff.

## TypeScript Rules

- Prefer TypeScript for touched frontend code. Convert a JavaScript file only
  when the conversion is small, directly supports the requested change, and
  remains within scope.
- Prefer functional React components over class components when touching legacy
  component code.
- Avoid `any`, broad type casts, and non-null assertions. Inspect nearby
  examples and shared Metabase types before weakening type safety.
- Use shared types from `metabase-types` when modeling backend API responses or
  Redux store state.
- Define local-only component types in a nearby `types.ts` file when those types
  are not broadly reused.
- Keep API types aligned with data received from backend endpoints. Do not add
  UI-only assumptions to API response types.
- Keep store types aligned with the Redux state shape. Do not reuse store types
  as general domain models when a narrower local type is clearer.

## State And Data Fetching

- Use Redux only for global state. Prefer local component state or narrow React
  context when state does not need to be global.
- Keep domain-specific Redux actions, reducers, selectors, and related
  components grouped near the feature area that uses them.
- Avoid separate `Container` and `Components` directory hierarchies by default.
  Split data-loading and presentation components only when it improves clarity.
- Prefer RTK Query for data fetching and caching.
- Define API endpoints in `metabase/api`.
- Keep endpoint definitions typed, independent from application code, and free
  of business logic except cache-tag invalidation.
- Treat legacy `metabase/entities` loaders as deprecated. Do not add new usage
  when RTK Query is viable.

## Components, UI, And Styling

- Prefer Mantine components, especially those exposed through `metabase/ui`, for
  UI building blocks.
- Keep `metabase/ui` display-level only. Do not put feature business logic in
  the UI library.
- Add or update Storybook coverage for components added to the UI library.
- Prefer Mantine style props for simple styling.
- Use CSS Modules for more complex styling.
- Do not introduce new Emotion styled components or global utility CSS classes.
  Treat those patterns as deprecated unless maintaining nearby legacy code.
- Use colors through Mantine color props such as `c` and `bg`, or CSS module
  variables such as `var(--mb-color-text-primary)`.
- Do not use literal color values such as `black`, `#FFF`, or ad hoc `color-mix`
  adjustments for Metabase theme colors.

## Testing Standards

- Cover all changed behavior with tests.
- Prefer unit tests over end-to-end tests for frontend logic and components.
- Place unit tests next to the components or modules they test.
- Follow the local Metabase unit-test setup style:
  - create a local `setup` helper;
  - use `renderWithProviders` and `screen` from `__support__/ui`;
  - use `userEvent` for user interactions;
  - use helpers from `metabase-types/api/mocks` for API-shaped mock data;
  - return mocks and callbacks from `setup` so assertions remain explicit.
- Follow the filename pattern enforced by the current repository configuration.
  Existing conventions use `.unit.spec.js` for Jest unit tests and `.cy.spec.js`
  for Cypress end-to-end tests.
- Use Cypress only when behavior needs full application integration.
- Keep Cypress scenarios under `e2e/test/scenarios` and mirror the relevant URL
  or feature structure.
- Prefer existing Metabase mocking and provider helpers over ad hoc global setup
  when tests depend on backend API state.

## Readability And Maintainability

- Avoid nested ternaries. Use an object map for trivial string-to-value
  branches, a `switch` for clear branching, or `ts-pattern` for complex
  structural matching.
- Keep comments rare and focused on why the code exists. First try to make code
  self-explanatory.
- Avoid breaking JSX into separate render helper methods inside a component.
  Inline JSX where it makes state and prop relationships easier to see.
- Extract complex conditions into well-named boolean variables before an `if`.
- Use `ALL_CAPS` for constants.
- Avoid magic strings and numbers. Move meaningful values to named constants.
- Prefer declarative array and object transformations over imperative loops when
  the declarative form is clearer.
- Extract a component when it has a clear responsibility, not merely to hide a
  few lines of JSX.
- Avoid broad refactors that are unnecessary for the requested behavior or test
  coverage.

## Review Checklist

- Confirm that no new `any`, unnecessary cast, or non-null assertion was
  introduced.
- Confirm that changed API, Redux, and component types match actual data flow.
- Prefer RTK Query over legacy entity loaders for new data fetching.
- Avoid global Redux state for local UI state.
- Follow Metabase conventions for Mantine, `metabase/ui`, CSS Modules, and theme
  color variables.
- Add Storybook coverage for new UI library components.
- Colocate unit tests and follow the currently enforced unit-test filename
  pattern.
- Reserve Cypress for true end-to-end behavior and follow its enforced filename
  pattern.
- Run targeted tests, `bun run type-check-pure`, and relevant lint and format
  commands, or explain omissions.

## References

Use current official Metabase documentation or source when behavior is
version-sensitive:

- [Metabase frontend guide](https://www.metabase.com/docs/latest/developers-guide/frontend)
- [Metabase development environment](https://www.metabase.com/docs/latest/developers-guide/devenv)
- [Metabase end-to-end tests](https://www.metabase.com/docs/latest/developers-guide/e2e-tests)
- [Metabase package scripts](https://github.com/metabase/metabase/blob/master/package.json)
