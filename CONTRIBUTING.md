# Contributing

Issues and pull requests are welcome: false positives and false negatives (with the tool definition that shows them), new checks backed by a published rule, fixes to the CLI, the MCP server or the Action, and documentation.

## Reporting a wrong grade

Open an issue with:

1. the tool definition (or a minimal one that shows the same thing),
2. the check ID and the finding you got,
3. what you expected, and the rule or source that supports it.

A false positive in a blocking check is treated as a bug with priority: a wrong grade does more harm than a missed one.

## Changing a check or the rubric

- **Every check cites its source.** A new or changed check names its source URL and quotes the rule verbatim (`quote` in `engine/core.js`), and the quote must appear in that source. Checks without a published rule behind them go in the quality section as advice.
- **Every check has tests.** A trigger test with the expected severity in `test/checks.test.cjs`, and near-miss negatives wherever a false positive is plausible. A test fails if a check has no trigger test.
- **IDs are stable.** Do not rename or reuse a check ID. A retired check keeps its ID out of use.
- **The rubric is versioned.** A change to a weight, band, cap, severity or the set of checks bumps `RUBRIC_VERSION` in `engine/core.js` and the version line in `RUBRIC.md` (patch for wording, minor for a new check, major for weights, bands or caps), with a `CHANGELOG.md` entry. A test checks that `RUBRIC.md` and the engine agree.
- **The engine is one file.** `engine/core.js` is the same file as the web checker at isokron.ai/mcp-check. After editing it, update `engine/VENDORED.json` (`node scripts/vendor.mjs <folder>` records the hashes) so `npm run vendor:verify` passes; maintainers keep the web checker in step.
- **No network, no storage in the engine.** A test fails if `engine/core.js` uses a network or storage API.

Run `npm test` before opening a pull request. CI runs it on Node.js 20, 22 and 24 and runs the Action against this package's own server.

## Sign-off (DCO)

Contributions are accepted under the [Developer Certificate of Origin 1.1](https://developercertificate.org/). There is no contributor licence agreement. Every commit needs a line

```
Signed-off-by: Your Name <your.email@example.com>
```

which `git commit -s` adds. The DCO applies to the maintainers' own commits as well. By signing off you state that you have the right to submit the work under the MIT licence of this repository.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Conduct

Be direct and courteous. Criticize code and rules, not people or projects.

## Checking that a test fails when its guard is removed (mutation probes)

Do not clone the repository to check this by hand: run the `mutation-probe` workflow (Actions, or
`gh workflow run mutation-probe.yml -R isokron-ai/mcp-check -f ref=<branch-or-sha> -f test='node --test test/live-probe-install-evidence.test.mjs' -f mutations='[...]'`).
It calls isokron-ai/tool-qa's reusable workflow. Each mutation is `{"id", "file", "find", "replace"}`
(and optionally its own `test` and `pattern`): `find` must be exact text that occurs exactly once in `file`, for example
a guard in `corpus/live-probe.mjs` (for example the `(?:\\s|$)` anchor in `packageInstallEvidence`). Every mutation runs in a fresh checkout of `ref`: the test must pass first, then it
runs again with the edit applied. The job summary lists each mutation as `killed` (the test failed, as it must),
`survived` or `stale` (`find` is not there exactly once), and the `mutation-probe-results` artifact holds the same as
JSON. The run fails if any mutation survived or is stale. At most 20 mutations per run; read-only, no secrets.
