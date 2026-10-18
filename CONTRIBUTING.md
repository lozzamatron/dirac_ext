# Contributing to Dirac

We welcome contributions that improve Dirac for its users. Before opening a pull request, read the acceptance criteria below.

## Pull Request Acceptance Criteria

### Conflicts of Interest

Pull requests with conflicts of interest are unlikely to be accepted. This includes changes submitted primarily to promote or benefit a company, product, or service the contributor owns, represents, works for, or has a financial interest in—for example, adding a provider integration on behalf of that provider.

Disclose relevant affiliations and discuss the proposal with maintainers before investing in implementation. Disclosure does not guarantee acceptance.

### Human Ownership

Every pull request must have an actual person behind it who understands the changes, has personally reviewed and tested them, and takes responsibility for addressing review feedback. AI-assisted contributions are welcome when those requirements are met. Purely bot-generated submissions without accountable human ownership will be rejected.

### Real-World Verification

Build and exercise code changes in a real Dirac setup using the affected CLI or VS Code extension workflow. Automated tests, mocks, or a successful build alone are not sufficient. Describe your setup, exact verification steps, and results in the PR. For provider integrations, verify against the actual provider.

### Focused Changes

Keep changes focused. Avoid large speculative refactors, unrelated cleanup, and changes whose correctness you cannot demonstrate. Discuss substantial refactors with maintainers first; untested or poorly justified refactors will not be accepted.

## Reporting Bugs or Issues

Before reporting a bug, [search existing issues](https://github.com/dirac-run/dirac/issues) to avoid duplicates. Use the [issue templates](https://github.com/dirac-run/dirac/issues/new/choose) and include your environment, steps to reproduce, and expected and actual behavior.

Report security vulnerabilities privately through [GitHub security advisories](https://github.com/dirac-run/dirac/security/advisories/new), not in a public issue.

## Deciding What to Work On

Start with [existing issues](https://github.com/dirac-run/dirac/issues) or improvements to the [documentation](docs/). Before implementing a larger feature, a new provider integration, or a substantial refactor, open an issue using the [feature request template](https://github.com/dirac-run/dirac/issues/new?template=feature_request.md) to discuss its fit and scope with maintainers.

## Development Setup

### Shared Setup

Clone the repository, then install dependencies and generate bindings from the repository root:

```bash
git clone https://github.com/dirac-run/dirac.git
cd dirac
npm run install:all
npm run protos
```

Protocol Buffer bindings must be generated before building; the extension and CLI build scripts also run this step.

### VS Code Extension

```bash
npm run compile
npm run build:webview
```

Open the repository in VS Code and press `F5` (or choose `Run` → `Start Debugging`) to launch an Extension Development Host. The repository's recommended VS Code extensions are optional development aids.

### CLI

The CLI requires Node.js 22.13 through 24.x. Build and run it from the repository root:

```bash
npm run cli:build
node cli/dist/cli.mjs --help
```

See [CLI development guidance](cli/DEVELOPMENT.md) for architecture, interactive and standalone workflows, and verification. The [CLI PTY harness guide](tests/e2e/cli/README.md) covers terminal interaction and deterministic regressions; its default canned provider is not a substitute for live-provider verification.

## Writing and Submitting Code

### Code Quality

- Limit PRs to a single feature or bug fix and split larger changes into reviewable pieces.
- Maintain TypeScript type safety and respect the boundaries between the core, tools, provider integrations, and UI.
- Run `npm run lint` to check code style.
- Run `npm run format:fix` to apply formatting and review the resulting diff.
- Run `npm run check:arch` after code changes. Fix new violations; do not regenerate architecture baselines just to make the check pass.

### Testing

- Add regression tests for bug fixes and tests for new behavior; update existing tests when behavior changes.
- Run the relevant automated suites: `npm test` for backend/extension tests, `npm run cli:test -- --run` for CLI tests, and `npm run test:webview` for webview tests.
- Personally verify the affected workflow in a real setup as described above. If shared core behavior changes, verify it in both the CLI and extension.
- Record what you tested and disclose any unverified behavior. Do not present an untested change as ready to merge.

### Before Submitting

- Keep your branch up to date with `main`.
- Build the affected components and run the relevant checks and tests.
- Review the complete diff, including generated changes, and remove unrelated edits and debugging code.
- Use clear, descriptive commit messages in conventional commit format (for example, `feat:`, `fix:`, or `docs:`) and reference relevant issues.

### Pull Request Description

- Explain the problem, why the change is needed, and how it solves it.
- Disclose relevant affiliations or conflicts of interest.
- Include your real-world verification setup, exact steps, and results, plus automated checks run and any remaining gaps.
- List breaking changes and include screenshots or terminal recordings for UI changes.

## Contribution Agreement

By submitting a pull request, you agree that your contributions will be licensed under the same license as the project ([Apache 2.0](LICENSE)).
