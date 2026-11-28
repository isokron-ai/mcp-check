# Corpus: grading the tool lists of public MCP servers (internal)

`.github/workflows/corpus.yml` grades the `tools/list` of pinned third-party open-source MCP servers.
It records the tool list only: each server is installed and started in a sandbox, sent `initialize`
and `tools/list`, and stopped. No tool is ever called.

The result is a dataset for IsoKron's own use: calibrating the checks against real servers and
measuring how the rubric lands. It is not a findings channel. **No grade of a named server is
published from this workflow or its dataset** until the public pages that such a publication needs
are live: a methodology page, a page explaining how a maintainer disputes or corrects a grade, and a
re-check path. Until then the dataset stays encrypted, and anything published from it is aggregate
only (for example, "N% of the servers graded have no `title` on any tool").

## How it works

The workflow does not have a sandbox of its own. It runs the corpus driver of
[isokron-ai/mcp-writecheck-action](https://github.com/isokron-ai/mcp-writecheck-action/tree/main/corpus)
at a commit on that repository's `main`, and reuses all of it as it stands:

| From the runner (`runner/corpus/`) | Used for |
|---|---|
| `targets.json.age` | The target list (format `isokron-corpus-targets/2`), encrypted. Decrypted at run time with the `CORPUS_TARGETS_KEY` secret by `decrypt-targets.sh`; the driver deletes the clear text before any target runs. This repository holds no copy and never names a target, only IDs such as `t13`. |
| `images.json` | The digest-pinned container images. The grader container uses its `runtime` image too. |
| `run-shard.mjs` and `sandbox/` | Install, backends, set-up and the server, in containers as user 10001 with every capability dropped, a read-only root, and an internal network after install. `sandbox/surface.mjs` sends `initialize` and `tools/list` and writes `surface.json`. |
| `net-guard.sh`, `install-age.sh`, `check-batch.sh` | The network guard, the pinned `age`, and the batch-input check (`t<NN>` IDs, at most 40, up to 16 shards). |
| `encrypt-results.sh`, `recipients.txt`, `summary.sh` | Everything the job wrote is encrypted to IsoKron's archive key before upload; the summary prints only the label and `run finished, exit N` lines. |

What this repository adds:

| File | What it does |
|---|---|
| `corpus/run-surface-shard.sh` | Runs the driver with `--surface-only` for one shard, then sweeps leftover containers, networks and volumes. |
| `corpus/grade-shard.sh` | Runs `corpus/grade.mjs` in the runner's digest-pinned runtime image with `--network none`, a read-only root, no capabilities, the run folder and this checkout mounted read-only. The dataset comes back on stdout into the run folder, before the encrypt step. |
| `corpus/grade.mjs` | One JSON line per target (format `isokron-mcp-check-corpus/1`); also `summarize` for aggregates. |

## The runner hook (`--surface-only`)

The workflow stops before anything is decrypted unless the checked-out driver accepts
`--surface-only`. That flag is a change to make in isokron-ai/mcp-writecheck-action; until it is on
that repository's `main`, set no `RUNNER_REF` and the workflow refuses to start. The change:

1. `run-shard.mjs` accepts `--surface-only`. With it, `--cli` and `--cli-commit` are optional; the
   driver still builds the tools volume it mounts read-only at `SANDBOX_TOOLS`, from `corpus/sandbox/`
   alone (no mcp-writecheck build), and records `cli: null` with a reason.
2. Per target, steps 1 to 5b run as today (artifact check, volumes and networks, install, backends,
   set-up, the surface probe). Steps 6 and 7 (manifests, `init`, `plan`, `catalog`, `full`) and the
   backend and target snapshots do not run; a target's `full` block is ignored, not refused.
3. Status: exit 0 when `meta.surface` is recorded; 124 on a time limit; 125 when the probe gave no
   `tools/list` answer or on any harness error, as today. `meta.json` and `shard.json` record
   `mode: "surface-only"`.
4. The runner's own tests cover: no CLI step and no `writecheck.yaml` in surface-only mode, the probe
   still runs inside the sandbox with the same isolation, and a target with `full.plan_hash` makes no
   write.

Nothing else changes: the list format, the images, the isolation, the encryption and the public log
stay as the runner's `corpus/README.md` describes them. Once merged, put that commit's SHA in
`RUNNER_REF` in `corpus.yml` (or pass it as `runner-ref` per dispatch).

## Grading earlier runs without starting anything

The runner's own corpus runs already record `surface.json` for every target, in their encrypted
bundles. On IsoKron's machine, with the archive key:

```sh
age -d -i ~/path/to/archive-key.txt corpus-shard-3.tgz.age | tar -xz -C shard-3
node corpus/grade.mjs shard-3 > shard-3.jsonl        # one line per target
cat shard-*.jsonl > dataset.jsonl
node corpus/grade.mjs summarize dataset.jsonl       # grade distribution, checks by number of targets
```

## Dataset record (`isokron-mcp-check-corpus/1`)

| Field | Meaning |
|---|---|
| `target` | The target ID from the list (`t13`). Never a name. |
| `graded_at`, `engine_version`, `rubric_version`, `spec_version`, `sources_read` | When and with what it was graded. Grades from different rubric versions are not comparable. |
| `surface` | `captured_at` from `surface.json`; `sha256_jcs`, `protocol_version`, `tools_pages` from the runner's `meta.json`. |
| `server_info` | `name` and `version` from the server's `initialize` answer (kept only inside the encrypted bundle). |
| `tool_count`, `catalog_hash`, `era` | As in a report. |
| `sections` | Per section: `grade`, `score`, `ready`, `counts`, `caps`. |
| `check_counts`, `findings` | Each check ID with its number of findings; each finding's `id`, `severity`, `tool`, `path`. |
| `error` | `{ code, message }` when the target could not be graded (`no_surface`, `too_large`, `too_deep`, `too_many_tools`, `not_json`, ...), with every other field null. |

## Owner set-up

1. Land the runner hook (above) in isokron-ai/mcp-writecheck-action and set `RUNNER_REF`.
2. In this repository: environment `corpus`, deployment branches limited to `main`, secret
   `CORPUS_TARGETS_KEY` (the same age identity the runner's corpus uses).
3. Dispatch from `main` with a short `only` list first.

## Loop worker: scan-static

`.github/workflows/scan-static.yml` is a worker of IsoKron's testing loop
([isokron-ai/tool-qa](https://github.com/isokron-ai/tool-qa)). The loop dispatches it with a shard of up to 25
public GitHub repositories. For each one, `corpus/scan-static.mjs` reads the tool list from source at the head of
the default branch and grades it with this repository's engine, the same way `mcp-check --repo` does. **Nothing
from a subject is installed, built or run**, so this worker needs no sandbox. It holds no secrets: the job's own
`GITHUB_TOKEN` reads the public repositories through `api.github.com`.

### Inputs

`workflow_dispatch` only, from `main`. The run name is `shard <shard_id>`.

| Input | Format |
|---|---|
| `shard_id` | 1 to 128 letters, digits, `.`, `_` or `-`, starting with a letter or digit. |
| `attempt_id` | Same format as `shard_id`. Every result quotes it. |
| `items` | One line of JSON, at most 60,000 characters: a list of 1 to 25 `{"subject": "owner/name", "run_key": "<64 lower-case hex>", "fence": <positive integer>}`, with no other keys and no repeated `run_key`. |

The workflow checks each input as a whole string before anything is checked out, and the script checks `items`
in full before anything is read. A malformed dispatch fails the run with a reason code and never repeats the
input. A `subject` that is not a GitHub `owner/name` does not fail the run: that item reports a skip
(`bad_subject`).

### Outputs

One bundle per item. Item `i` (0-based position in `items`) is sealed and uploaded by tool-qa's worker-kit as
`result-<attempt_id>-<i>.tar.age`, with that item's `run_key` and `fence`. A subject that could not be graded still
gets its bundle, with the skip recorded. A bundle holds:

| Path | What it holds |
|---|---|
| `results/scan-static.json` | Format `isokron-mcp-check-scan-static/1`: status (`graded` or `skipped`), the detail code of a skip and whether it is retryable, engine, rubric and spec versions, the commit, section grades, check counts and findings. Tools are named by position only. For a repository of several servers (`multiple_servers`), `servers` grades each one (see below); otherwise it is `null`. |
| `observations/static.ndjson` | Field records `commit_sha`, `commit_date` and `registration_provenance` (how the list was read: fidelity, language, counts of tools left out or unreadable, and `unreadable_kinds`: per unreadable part and for unresolved names, how many came from each kind of construct, in fixed words only, R-RD-45). A field that could not be read is `null` with a reason. |
| `controls/` | The outputs of the two controls below. |
| `logs/scan.log` | What was done, as codes and counts. |
| `raw/` | The subject's own text (tool list, file paths, findings with tool names), kept apart from everything above. Each file is compact JSON of at most 4 MiB: a list that does not fit keeps the entries that do (`{"truncated": true, "total", "kept", "items"}`), and `results/scan-static.json` lists every cut file in `raw_truncated`. |

**A repository of several servers** (R-SS-13) stays one subject and one result: its top-level status is still
`skipped` with `multiple_servers` (not retryable), so nothing that reads the top level changes. `servers` breaks it
down: one entry per server folder the reader found, in the reader's order (folders that construct a server first,
then by tool count), each `{index, status, detail, declared, list_error, list, tool_count, catalog_hash, era,
sections, check_counts, findings, skipped_checks}` with the same meanings as at the top level (`list` is that
server's `registration_provenance` value). A folder that cannot be graded gets the subject's skip code (`no_tools`,
`names_only`, `reader_limit`, `multiple_servers` for a server folder that holds several again or is the repository
root, `timeout` when 60% of the subject's time had gone before it was read). At most 24 folders are read; the rest
are `reader_limit`. `declared` is true when a `server.json` of the repository names that folder as its
`repository.subfolder`. Servers are named by position only: `raw/subject/servers.json` holds, for each `index`, the
folder, its tool list and its findings. Each folder is read from the listing and the files already fetched for the
repository, so a breakdown costs no API call; files not read yet come from `raw.githubusercontent.com`. The
breakdown has no field record of its own (`observations/` keeps `registration_provenance` null with the reason).

The meta file names the subject (`owner/name` and the commit read), the engine version, a digest of the run
settings, the start and finish times, the skips and the controls.

Skip codes in the meta file come from the loop's fixed list (tool-qa `worker-kit/contract.mjs`). Every skip
says whether it is `retryable`, and who it is down to (`fault`, R-SS-14): `tool` (our reader, grader or bundle
builder), `subject` (the repository itself) or `infra` (GitHub's limits and outages). Our own limits are never
recorded as the subject's, so tool-qa counts them as unassessed (our limit), never as excluded, and its due list
puts them first when a new mcp-check version moves the run_key.

| Detail (`results/scan-static.json`) | Skip reason | Fault | Retryable |
|---|---|---|---|
| `repo_unavailable` (gone, private or blocked), `repo_empty` | `no_runnable_artifact` | subject | no |
| `bad_subject` (not a GitHub owner/name; this lane reads GitHub only) | `no_runnable_artifact` | tool | no |
| `no_tools` (no tool registration found) | `no_tools_found` | tool | no |
| `unsupported_language` | `unsupported_language` | tool | no |
| `multiple_servers` | `unsupported_layout` | tool | no |
| `reader_limit`, `names_only` | `reader_limit` | tool | no |
| `listing_too_large`, `list_rejected` with `list_error: too_large` | `too_large` | tool | no |
| `list_rejected` (any other code), `reader_error`, `bundle_error` | `tool_error` | tool | no |
| `rate_limited` | `rate_limited` | infra | yes |
| `upstream_error`, `read_failed`, `timeout`, `shard_deadline` | `upstream_unavailable` | infra | yes |

- Not retryable: asking again will not help. `bundle_error` means the full bundle could not be built or written,
  for example over tool-qa's size caps; a minimal one was: results, observations, logs and controls, no subject
  `raw/`. A 403 on the repository itself counts as `repo_unavailable` unless GitHub marks it as a rate limit
  (`x-ratelimit-remaining: 0`, `retry-after`, or "rate limit" in the answer); a 403 while reading the tree or a
  file that GitHub does not explain is `upstream_error` (retryable, so tool-qa's bounded retries decide).
- `rate_limited`, retryable: a GitHub rate limit. After one, the rest of the shard is not read and reports it
  too. The shard also stops early, before a subject starts, when GitHub says fewer than 13 API calls are left
  (the three one subject takes, plus a reserve of ten).
- `upstream_unavailable`, retryable: the source could not be read this time. `upstream_error` (5xx or an
  unreadable answer), `read_failed`, `timeout` (90 seconds per subject) or `shard_deadline` (no subject is
  started after 32 minutes; slow upstream calls are what use the budget up).

The exact code is in `results/scan-static.json`. When every skip of an item is retryable, tool-qa records it as
`retry_later` and sends it out again after a backoff (at most three times; then it keeps the skip).

A subject that fails never fails the run. Each subject runs in its own worker thread, stopped after 90 seconds
plus 5 of grace whatever it is doing, with a 1,536 MB heap limit. The thread builds and caps its `raw/` texts
before handing them over, holds no token, and can reach only `api.github.com` and `raw.githubusercontent.com`:
its requests go through the main thread, which adds the token to API requests only. Each item's step outputs
(`has_<i>`, `fence_<i>`, `run_key_<i>`) are written as soon as its bundle is, after `controls_ok=true`; the scan
step has its own 37-minute limit, and the upload steps need `controls_ok` and no `controls_failed`, not the scan
step's success. So a scan step that is stopped still uploads every bundle it finished. The run fails only on a
malformed dispatch or a harness error (a control that fails says `controls_failed=true` first), and then
nothing more is uploaded.

### Controls

Both controls run before any subject is read, and their outputs go into every bundle. If either one does not
give its expected outcome, the run stops and reports nothing.

- **Known answer** (`known_bad`, expected `match`): `corpus/fixtures/known-answer/` is a small server whose tool
  list hides an instruction. Its tool count, catalog hash, section grades and check IDs must equal
  `corpus/fixtures/known-answer.json`. A broken reader or grader shows here first. After a deliberate rubric
  change, regenerate the file with `node corpus/scan-static.mjs known-answer > corpus/fixtures/known-answer.json`
  and review the diff. The fixture is read twice: from its folder, and served as a GitHub repository to the same
  reader the subjects go through (`fromGitHub`, with a stub fetch and no network). Both must give the answer.
- **Forgery** (`forgery`, expected `contained`): `corpus/fixtures/forgery/` is read with a fresh random marker
  written into it. Its tool texts pretend to be a result of another attempt and its tool names are identity
  keys. It is graded and reported like a subject, through the same result record and bundle builder. It is
  contained when the marker comes back in `raw/`, and no file the bundle would hold outside `raw/` (nor the control
  output) holds the marker, an identity key or claim, or a result envelope. `corpus/fixtures/forgery-servers/`
  (two such servers in folders whose names carry the marker) is read too, with the per-server breakdown: both
  servers must be graded, the marker must come back in `raw/subject/servers.json`, and nothing outside `raw/` of
  that bundle may hold it either. Each bundle gets its own marker.

### Kill switch

The first step checks the repository variable `LOOP_ENABLED`; anything but exactly `true` ends the run with a
notice, not a failure, before anything is checked out. `corpus/loop-guard.mjs` then applies `LOOP_PAUSE_UNTIL`
(an ISO 8601 time; the lane does nothing until then, and a value that cannot be read also stops it) and
`LANE_SCAN_STATIC_ENABLED` (set and not `true` turns this lane off). The scan job checks `LOOP_ENABLED` and
`LANE_SCAN_STATIC_ENABLED` again in its first step, since they may change after the guard job. The env value `WORKER_KIT_REF` in the
workflow must be the tool-qa commit that every worker-kit step uses. While it is the all-zero placeholder, a run
that would proceed fails at the guard, before anything is read.

### The ast-grep oracle (O3)

An independent reader of the same commit, for the differential checks. Off unless the repository variable
`LANE_SCAN_STATIC_AST_GREP` is exactly `true`; then the scan job installs the pinned ast-grep (`corpus/ast-grep/package.json` and its
lockfile, `npm ci --ignore-scripts`) and, for each subject the reader graded (or found no list in), fetches that commit's source files
with git (a fresh repository, no hooks, symlinks, LFS or submodules; tests, docs, examples and vendored code left out) and reads the
tool-registration idioms of TypeScript and JavaScript (`server.tool`, `registerTool`, FastMCP `addTool`, the `ListToolsRequestSchema`
handler), Python (`@mcp.tool`, `types.Tool(...)`, `add_tool`), Go (mcp-go `NewTool`, the go-sdk `mcp.Tool` literal, `AddTool`,
`RegisterTool`), Rust (rmcp `#[tool]`, `#[mcp_tool]`, `Tool::new`) and C# (`[McpServerTool]`) with the rules in
`corpus/ast-grep/packs/`. A name is taken only from a literal (or a same-package constant, or the function a decorator or attribute is
on); a computed, looped or table-driven registration is `unreadable`, which is never a disagreement and never a fault of the subject.

It adds, only when it ran: `oracle_ast_grep` in `results/scan-static.json` (status `read`, `none`, `unreadable` or `error`; confidence
`high`, `medium` or `low`; tool and unreadable counts; idioms; whether the reader's list was compared, and how many tools each side
lacks), `ast-grep` and its version in the manifest's `oracles`, `raw/subject/ast-grep.json` (names, descriptions, annotations, files:
raw only), and, when the reader and ast-grep differ, an `oracle_disagreements` field record: class D1 (the reader lacks a tool ast-grep
read) or D2 (the reader lists one ast-grep did not read; only when ast-grep read every registration), kind `tool_set`, attribution
`tool`, with counts and a fingerprint of the shape (class, idioms, layout, size), never a name. It does not change anything the
reader said. tool-qa's ingest sets these beside the live list (three-way agreement, `state/oracle.mjs`).

`corpus/ast-grep/harness.mjs` and `.github/workflows/ast-grep-validate.yml` score the oracle against ground truth (a repository at a pinned
commit and the tools its server registers): precision against every tool the server has, recall over its default tools, per language.
