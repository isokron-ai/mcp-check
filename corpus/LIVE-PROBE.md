# Loop worker: live-probe (internal)

`.github/workflows/live-probe.yml` is the live-probe lane of IsoKron's testing loop
([isokron-ai/tool-qa](https://github.com/isokron-ai/tool-qa)). For each subject it installs the server from its
published package, starts it in a sandbox, asks for its tool list, and grades that list with this repository's
engine, exactly as `mcp-check -- <server>` grades a live list. No tool is ever called.

## Inputs

The tool-qa pump dispatches the workflow with the three inputs every worker takes (tool-qa `docs/INTERFACES.md`,
"Worker dispatch"):

| Input | Format |
|---|---|
| `shard_id` | 1 to 128 letters, digits, `.`, `_`, `-` |
| `attempt_id` | the same |
| `items` | one line of JSON: 1 to 10 `{"subject": "owner/name", "run_key": "<64 hex>", "fence": <n>}` |

Each input is checked as a whole string before anything runs; `corpus/live-probe.mjs` then checks the items in full.
The run is named `shard <shard_id>`.

## What happens

1. **Kill switch** (job `guard`). Nothing runs unless the repository variable `LOOP_ENABLED` is exactly `true`,
   `LOOP_PAUSE_UNTIL` (optional) has passed, and `LANE_LIVE_PROBE_ENABLED` is unset or `true`
   (`corpus/loop-guard.mjs`). Off ends the run with a notice, never a failure.
2. **Install method** (`corpus/live-probe.mjs plan`). For each subject: the official MCP Registry entries whose
   repository is the subject, or whose packages are the seed list's packages for it (tool-qa
   `history/seed-v1.json`, at the worker-kit commit), latest versions only. The first package that can run here
   wins: packages named in the seed list first, then stdio before streamable HTTP, then npm, PyPI, OCI. Arguments and
   env come from the entry's declared values and defaults; a required env value is a dummy, never a credential. An
   optional env name gets its declared default (an image that defaults to HTTP declares `MCP_TRANSPORT` default
   `stdio`), never a value we invent: no default, a secret's or a placeholder one (`{name}`, `$HOME`, `<your-key>`) leaves
   it out (R-LP-80); `config_state` is then `defaults`.
   Building from source is the build-probe lane's work, not this one.
   - **Which command runs a PyPI package.** The planner reads the release's wheel (pure-Python first, at most 30 MiB,
     files.pythonhosted.org only) and launches the console script it declares in `*.dist-info/entry_points.txt`: the
     one the registry's first package argument names (the publisher's `<script> <rest>`; the argument is taken by the
     entry, R-LP-82), else the one named like the package, else the only `<package>-mcp`-style name, else the only one with mcp in its name,
     else the only script if its name or target says mcp or server. A wheel with no console script but a top-level
     `<module>/__main__.py` named like the package (or a lone one whose name says mcp or server; never tests, docs,
     examples or scripts) runs as `python -m <module>`. A picked entry is no longer a guess, so it needs that signal. Otherwise (ambiguous, no wheel, unreadable, lookup failed) the run keeps the old
     `venv/bin/<package name>` guess, which a failure never blames on the server. A package's only script with no
     such signal is run too (`lone_script`). Both picks are our reading, not the publisher's word (a `uvx <package>
     <args>` launch passes the args to the package's own script), so like the guess their failure is never evidence
     against the server.
     `install.entry_source` says which.
     The wheel is parsed as untrusted data (bounds-checked, inflation capped); no package code runs on the planner.
   - **Whose entry it is.** Anyone can publish a registry entry whose repository URL names someone else's repository,
     and the package behind it too, so what a package says about itself (npm `repository`, PyPI `project_urls`)
     proves nothing. An entry counts as the subject's only when one of these holds, and `results/live-probe.json`
     records which (`install.matched_by`, `install.verified_by`):
     - `seed`: it carries a package of the seed list;
     - `namespace`: its name is in the owner's namespace, `io.github.<owner>/...`, which the registry verifies;
     - `ghcr_owner`: the image is under `ghcr.io/<owner>/`;
     - `npm_provenance`: the npm registry serves a build provenance attestation for that exact version (SLSA v1 in
       a Sigstore bundle, `dist.attestations`) whose statement names the package, version and the tarball's own
       sha512 (`dist.integrity`), and whose signed workflow repository is the subject;
     - `pypi_provenance`: PyPI's integrity API serves a PEP 740 attestation for a file of that release, from a
       GitHub Trusted Publisher whose repository is the subject, naming the file and its sha256.

     For both provenance kinds the lane itself checks the signature: the leaf certificate chains to Sigstore's
     public Fulcio authority (pinned in `corpus/fixtures/live-probe/sigstore-fulcio.json`), was issued to GitHub
     Actions (OIDC issuer extension) for the subject's repository (Source Repository URI extension and the SAN), and
     the DSSE signature over the statement verifies with it. The extensions are read from the certificate's own
     `tbsCertificate.extensions` (a certificate that is not well-formed DER, or names an extension twice, is
     refused). A package signed by a shared reusable workflow has that workflow in its SAN, not the subject: it is
     accepted only when the Source Repository URI is still the subject, the Build Signer URI (extension 9) is the SAN
     and is a release tag of a workflow on this allowlist (`TRUSTED_REUSABLE_SIGNERS`):
     - `https://github.com/slsa-framework/slsa-github-generator/.github/workflows/` (the SLSA GitHub generator)

     `results/live-probe.json` says which (`install.provenance_signer`: `repository_workflow` or
     `trusted_reusable_workflow`). The install is pinned to the version whose provenance was checked (the attested
     document's own version), so a `latest` that moves in between cannot swap the package. Not checked here: the transparency log (Rekor) entry,
     that the signing time fell inside the certificate's ten-minute validity, and the freshness of the pinned root
     (no TUF update); the registry checked the first two when it accepted the attestation. Anything else is
     skipped as `unverified_registry_entry`, with the reason in `results/live-probe.json` (`unverified`).
   - **OCI images** come only from docker.io, ghcr.io, quay.io, public.ecr.aws, mcr.microsoft.com and
     registry.gitlab.com, and their token services only from those hosts (auth.docker.io and gitlab.com included);
     never an IP literal. The tag is pinned to its digest, and the linux/amd64 image's manifest is read: one whose
     config and layers add up to more than 2 GB is not pulled (`image_too_large`). Those are compressed bytes, so
     OCI subjects run one at a time after the others, each only when the Docker disk has about four times its
     declared size free, and its image is removed after it; when there is not enough, that subject and every later
     one are a retryable skip (`disk_low`).
   - **Crates** (registry type `cargo`, R-LP-54..56) are built in the sandbox (mcp-surface-corpus launchPlan, kind
     `cargo`): `cargo install --locked` in its pinned Rust image, through index.crates.io and static.crates.io only, at
     most 15 minutes, the binary cargo recorded (the only one, else the one named for the crate, else the only one named
     for MCP; never a guess), the build's folders removed before the server starts in the same image. The same path and
     rules as mcp-writecheck-action's crate path (its `cargoPlan` and `cargo-entry.mjs`, now in the sandbox itself). A
     crate comes after npm, PyPI and an image of the same entry. Crates run after the other subjects, in a list of their
     own (`targets-builds.json`), one after another, each with `BUILD_ALLOWANCE_S` (17 minutes: the build cap and the
     image's first pull) on top of its share; a shard with a crate gives its other subjects `BUILD_RESERVE_S` less of
     the budget. A crate the deadline stops is `shard_deadline` (retryable). Its failed install is the crate's own only on
     cargo's word before anything compiled and with no sign of trouble reaching crates.io ("could not find `<crate>` in
     registry `crates-io`": `install_failed`; "nothing to install ... because it has no binaries": `package_not_runnable`),
     and only when its registry entry is in the subject's own namespace (else `package_error_unowned`, ours). What the
     entry helper cannot find after a successful install is `entry_unresolved` (ours); everything else, npm's and pip's
     error words included, is ours.
   - **.NET tools** (registry type `nuget`, R-LP-57, R-LP-58) are installed in the sandbox (mcp-surface-corpus
     launchPlan, kind `nuget`): `dotnet tool install --tool-path` in its pinned .NET 10 SDK image with a NuGet config
     that names nuget.org alone, through api.nuget.org and globalcdn.nuget.org only; the command is the one the
     package's `DotnetToolSettings.xml` declares and the install made a launcher for (the linux-x64 build of a
     RID-specific tool), run as `dotnet <entry point>` on the image's runtime with `DOTNET_ROLL_FORWARD=Major` (a tool
     built for .NET 8 or 9 runs on 10). After npm, PyPI and an image, before a crate; it runs among the subjects with
     `PACKAGE_ALLOWANCE_S.nuget` (180 s, the SDK image's first pull) on top of its share. Its failed install is the
     package's own only on the .NET CLI's word about this package id with no sign of trouble reaching NuGet (NU1101 or
     NU1102: `install_failed`; not a .NET tool: `package_not_runnable`), and only when its registry entry is in the
     subject's own namespace (else `package_error_unowned`); a NuGet install runs no code of the package, so nothing it
     ships can print those words. What the entry helper cannot find after a successful install is `entry_unresolved`
     (ours); a tool built for other platforms only, or for a newer .NET, is `platform_unsupported` (tool); several
     commands is `entry_ambiguous` (tool). A tool built for an older .NET runs rolled forward, so its crash is no evidence
     against it (`start_env_limited`).
   - **Go from source** (no registry type; R-LP-91..95, `corpus/go-entry.mjs`). A subject with no package we can run
     (`no_package` or `unsupported_package`) whose repository has a `go.mod` at its root is built at its commit in the
     sandbox (mcp-surface-corpus launchPlan, kind `go`, R-SBX-62): `go install <package path>@<full commit>` in its pinned
     official Go image with `-mod=readonly -buildvcs=false`, `GOTOOLCHAIN=local` and `CGO_ENABLED=0`, through
     `proxy.golang.org` and `sum.golang.org` only (nothing else; `storage.googleapis.com` only if the proof run shows a
     build needs it), at most 15 minutes, run in the node image as a static binary. The commit is the item's `sha`, else
     the repository's head read once and then pinned as the target's commit; never `@latest`. The package path is chosen
     from the repository at that commit, read as data from api.github.com only (the root tree, `go.mod`, the first bytes
     of at most six `.go` files a folder, never a build): the module root when it is `package main`, else the one main
     package under `cmd/`, else the one named for the repository or for its registry or `server.json` name; several
     and none named is `entry_ambiguous` (ours: we would have to guess), none at all `no_main_package` (a library:
     nothing to start). A `go.mod` with a `replace` or `exclude` directive is `go_install_refused` (the go command will
     not install it by version; ours). A tree GitHub will not list whole, or a file we could not read, is
     `go_source_unreadable` (ours). Arguments, environment names and transport come from the `server.json` the
     repository itself ships, when it ships one; never a value we invent, so a server that needs an argument ends
     `start_needs_config` (ours). The build runs after the other subjects with a time limit of its own, as a crate
     does. Every failure of the build is ours (`install_build_failed`, `install_blocked`, `install_resource_limit`,
     `install_timeout`): the subject's install is never judged by Go's own words. The token of the plan step (the job's
     read-only one) goes to api.github.com only; a rate limit or outage there is a retryable skip.
   - **MCP bundles** (registry type `mcpb`, R-LP-72..74, `corpus/mcpb.mjs`). The planner downloads the bundle from the
     GitHub release asset the registry or seed list names (github.com, then its release-asset hosts only; every
     redirect checked; at most 200 MiB, read as a stream), checks its sha256 against the registry's `fileSha256` when
     there is one, and reads it as data: the zip's central directory (every entry name checked as the sandbox checks
     it), `manifest.json` (at most 1 MiB) and the first bytes of a binary; nothing of it runs on the planner. From the
     manifest it builds the launch a client would: `server.type` node, python, binary or uv; `mcp_config` with the
     `linux` platform override; `${__dirname}` (the bundle's folder), `${HOME}`, `${DESKTOP}`, `${DOCUMENTS}`,
     `${DOWNLOADS}`, `${pathSeparator}` and `${user_config.*}` put in. A user_config value with a default uses it; an
     optional one with none is left out with the flag before it; a required one with none is `start_needs_config`
     (ours), never guessed. Names the sandbox owns are never set; a `PYTHONPATH` must stay inside the bundle. A binary
     runs only when the manifest lists linux (or no platforms) and the file is a linux/amd64 ELF; a shell launcher is
     not started. `uv run` is read as uv reads it (`--directory`/`--project` the bundle, `--extra`, then a script,
     `python ...` or a console script). The sandbox (mcp-surface-corpus launchPlan, kind `mcpb`) downloads the same URL
     through its proxy (GitHub's three hosts only, PyPI as well for uv), unpacks only bytes with the pinned sha256, with
     its own path, link, size, count and CRC guards, and starts the server from the read-only folder: node in the node
     image, python in the Python image with the manifest's PYTHONPATH, uv's requirements installed with pip into a venv
     (PyPI only), a binary in the full Debian node image. A bundle whose manifest does not list linux still runs (many
     list only the platform their author tried), but its crash here is never its fault (`start_env_limited`); nor is the
     crash of a python or uv bundle, which runs on an environment we rebuilt (our Python, our pip install of what we
     read from its pyproject; uv would also read a script's inline metadata). A failure that
     would be the bundle's own (`bundle_unavailable` after one more try, `bundle_hash_mismatch`, `bundle_invalid`,
     `package_not_runnable`) counts against the subject only for an entry in its namespace: anyone can publish an entry
     naming someone else's repository with a dead bundle URL (repository-only: `unverified_registry_entry`; seed-only or
     seed-matched: `bundle_unowned`, ours). A bare launcher (npx, sh, bun, docker ...) is never a file of the bundle
     (`bundle_runtime_unsupported`; so is `uv run <command>` with no pyproject, and a node or python script outside the
     bundle: an absolute path of the author's machine, one that climbs out, a relative one the bundle does not hold, and
     the same for a file a node option loads first: `-r`, `--import`, `--loader`, `--env-file`; a package name is allowed,
     a module from `~`, another scheme than `node:`/`data:` or a `file:` URL with a host is not; a run of slashes is one), and only a name that leaves the bundle
     makes it invalid. A path the manifest names is the bundle's missing file only when it names nothing the bundle
     holds: not one a runtime resolves (node's `.js`, a folder's index or `__main__.py`, a Windows `.exe`), nor a name
     in another case (it runs on macOS and Windows: `platform_unsupported`). Links the sandbox left out when it
     unpacked the bundle make its crash no evidence either, and a bundle whose crash is no evidence is no more at fault
     for a quiet exit with a declared variable (never `needs_credentials`). What goes wrong in the sandbox is ours: the
     planner already judged those very bytes. After npm, PyPI and an image, before a
     .NET tool or a crate; `PACKAGE_ALLOWANCE_S.mcpb` (120 s) on top of its share.
   - **npm install scripts run**, inside the sandbox's install container: gVisor with syscall tracing, egress only
     through the allowlist proxy to the npm registry. What they did is in the bundle (the install container's trace
     summary and every proxy request in `raw/telemetry.jsonl`, the counts in `install_phase_behaviour`). A native
     module is built from source in the sandbox's build image (below, "Native modules").
3. **Sandbox** (`corpus/live-probe-sandbox.sh`), the one in
   [isokron-ai/mcp-surface-corpus](https://github.com/isokron-ai/mcp-surface-corpus) at `SURFACE_CORPUS_REF`, used as
   it is: gVisor (`runsc`) with syscall tracing, user 65534, no capabilities, a read-only root, an install network
   whose only way out is an allowlist proxy to the package registry, a run network with no way out, a DNS logger
   that answers every name with itself, and the host firewall. The driver runs with its `writableWork` option on
   (since mcp-surface-corpus 3738f2c, #17; R-ORC-15): each probe of a package kind's server (npm, PyPI, Go, crates,
   NuGet, MCP bundles) gets a writable layer of its own, an overlay over the read-only work volume at `/work` and a
   32 MiB `/data` tmpfs, removed after the probe, so a server that writes into its own install or to `/data` starts.
   The work volume is never written; a layer that cannot be made is recorded and that probe runs read-only, which is
   our failure, never the server's. Before any target, at that same commit:
   - its reusable `sandbox-conformance.yml` runs as the job `sandbox`, on a runner of its own; the probe job starts
     only when its verdict is `pass`;
   - in the probe job, on the runner that will run the targets, its `sandbox-guard` action installs gVisor and the
     firewall and runs the eleven escape attempts of the self test, and fails the job unless the telemetry
     recomputes a pass; the sandbox script then runs no target unless that guard passed from the same commit as
     the checkout, and checks the telemetry once more itself.

   Then the controls, then the subjects, each with its own time limit, all stopped at minute 34 of the job. After
   every first run, one retry with a changed launch for a subject whose start failed on a cause that change tests
   (R-LP-81; `corpus/live-probe.mjs retry` plans it from the first runs' output, read as data, and the sandbox's own
   target check passes each one): a PyPI server that failed on an import the MCP SDK's 2.x line removed
   (`mcp.server.fastmcp`, a name or attribute of `mcp`, or the SDK's own "This is mcp 2.x"), while its release declares
   `mcp` with no upper bound, runs again with `mcp<2` (a resolve to the release date needs the sandbox to take
   `--uploaded-prior-to`; until then the known cap is the change). A retry that lists tools is the item's run; one that
   does not leaves the first run's cause as it was, and its fault is never the server's once a retry was planned
   (a detail that alone would be is kept as `retry.first_detail`); the SDK's own "This is mcp 2.x" is drift on any run. Both runs are in the bundle (`raw/first/` or
   `raw/retry/`), and `retry` in the result says what was changed and what came of it. A PyPI or npm entry that is a
   command line with subcommands, which printed its own usage banner and exited by itself, runs again once with the
   subcommand that banner lists for serving (`mcp`, `stdio`, `serve`, `server`, `run`, `start`, in that order;
   R-LP-83), never one it does not list. Last,
   every container, network and volume is removed, and the upload steps start only when there is no container or
   volume left at all (labelled or not), no labelled network, no host process running as the sandbox user (uid
   65534), and no `runsc` or `containerd-shim-runsc` process.
4. **Grade and bundle** (`corpus/live-probe.mjs bundle`). The controls are checked first; then each item's bundle is
   written, and tool-qa's worker-kit (pinned to `WORKER_KIT_REF`) seals and uploads it as
   `result-<attempt_id>-<i>.tar.age`. Every item gets a bundle.

## Oracles

After the driver's own probe of a target, the oracle stage (`corpus/live-probe-driver.mjs`, which runs the sandbox's
`bin/run-shard.mjs` unchanged and adds the stage through its probe option; `corpus/oracles/`) asks independent
oracles the same questions, on the same `docker run` of the target (same image, mounts, env, network, limits): each
server process is a sandbox container with a name and cidfile of its own, one at a time, removed after use, its
syscall trace summarised and removed. Nothing of a target runs on the runner. No tool is ever called.

1. **SDK clients**, each the official SDK used the way its documentation shows, pinned (`corpus/oracles/pins.json`):
   TypeScript 1.x (`@modelcontextprotocol/sdk` 1.32.2) and 2.x (`@modelcontextprotocol/client` 2.4.0), Python
   (`mcp` 2.3.0) and Go (`github.com/modelcontextprotocol/go-sdk` v1.8.0). Each connects with its own default
   negotiation (the Python and Go clients try `server/discover` first) and lists every page of tools/list. The Go
   client reports each `tools/list` result as the server sent it, read off the wire under the SDK (R-ORC-11): go-sdk's
   typed `mcp.Tool` cannot hold `execution`, annotation keys it does not know or an empty annotations title, and writes
   `readOnlyHint` and `idempotentHint` out, so a list re-marshalled from it is the SDK's view, not the catalog. Its
   typed parse still decides the outcome (`typed_tool_count`); a list it could report only from the typed structs
   (`tools_source: typed`) is compared on names, never on its catalog (`catalog_vs_reader: sdk_typed_only`).
   **The MCP Inspector** (`@modelcontextprotocol/inspector` 2.16.0, in the same npm lockfile), in its documented
   CLI mode, `--cli --method tools/list -- <server command>`, is a fifth client beside the SDKs (R-ORC-13, owner
   decision of 27 Nov): its result has the clients' format (`client: inspector`, in `sdk_client_results`), and its
   disagreements are fed to `oracle_disagreements` as the SDK clients' are. Its answer has no stage and no protocol,
   so the server command runs behind our pass-through (`corpus/oracles/inspector-client.mjs --pipe`), which matches
   our initialize and tools/list ids to the answers (bytes unchanged) to tell a refused initialize from a refused
   list. The Inspector starts its server with a default environment of its own, so the pass-through starts the server
   command with the client's environment (the DOCKER_* variables `oracleEnv` forwards), read from a file of its own in
   the session folder (R-ORC-14). The Inspector is never the reference client. The Inspector reports the tools its own parse keeps, so its catalog is compared on the specification's Tool
   and ToolAnnotations keys only (`catalog_vs_reader: same_spec_fields`, pins.json `catalog: spec_fields`). Like every
   oracle, an Inspector-only failure is a lead about our tools or the oracles, never a finding against the server:
   the oracle stage adds no skip and no fault.
2. **The official conformance suite** (`@modelcontextprotocol/conformance` 0.2.0-alpha.12, built from git commit
   f44482b, pinned by npm integrity), against both frozen requirement sets it ships: 2025-11-25 (the stateful wire)
   and 2026-07-28 (stateless). The stage refuses to run when the installed sets do not hash as pinned. Of each set's
   server scenarios only the read-only ones run, each on its own revision's wire: `server-initialize`, `ping`,
   `tools-list`, `prompts-list`, `resources-list` (2025-11-25) and `tools-list`, `prompts-list`, `resources-list`
   (2026-07-28). Every other scenario of the set is recorded as not run, with why: `calls_tool`, `gets_prompt`,
   `reads_resource`, `subscribes`, `changes_server_state`, `needs_fixture_server` or `transport_only`.

   The suite speaks Streamable HTTP only, so a stdio server is reached through our bridge
   (`corpus/oracles/bridge.mjs`, on 127.0.0.1 at a port the system picks): each POSTed message becomes one line on
   the server's stdin and the server's answer line is the response body, byte for byte, so the suite's wire-schema
   checks see the server's own bytes. Each scenario gets fresh server processes. Following the design's bridge
   discipline, the results are payload-level only: transport scenarios are not run, and a check about the bridge
   itself (the session id) is `bridge_excluded`, never scored against the server. The bridge's byte-level transcript
   is kept in `raw/oracles.json`.

The stage runs at most once in full per target, after the first probe that got a tool list, and at most once with the
clients only, after the first probe that got none (a client that lists where our probe did not is the lead for a
reader bug), and then only when the server answered that probe (an initialize result, or a 2026-07-28 refusal of it):
for a server that never started every client fails initialize too, so the record is a skip with `why: not_started`
and the clients do not run (R-ORC-12). A server that declared no tools capability and answered `tools/list` "method
not found" (live-probe R-LP-75) agrees with every client that was refused the list or listed none
(`catalog_vs_reader: no_tools_capability`): no disagreement. It never runs past the target's time limit less 75 s (kept for the driver's second probe and its
analysis), at most 150 s; each target's limit grows by 150 s for it (`ORACLE_ALLOWANCE_S`). Streamable HTTP targets
are probed inside the sandbox by a helper container, so the stage does not run for them (`oracle_stage.why`:
`http_transport`). The stage runs inside the driver's probe call: `step_telemetry` gives `oracle_ms` and `probe_ms`
without it (R-ORC-02), but the driver's own container record of that probe (in `raw/telemetry.jsonl`) spans both.

**Install** (`corpus/oracles/install.mjs`, a step before the sandbox guard and before any target): `npm ci
--ignore-scripts` from `corpus/oracles/package-lock.json`, `pip install --require-hashes --only-binary=:all:
--no-deps` from `requirements.txt`, `go build -mod=readonly` from `go/go.mod` and `go.sum`, into the runner's temp
folder. Every download goes through the sandbox's own allowlist proxy (`sandbox/egress-proxy.mjs`, on 127.0.0.1) to
registry.npmjs.org, pypi.org, files.pythonhosted.org, proxy.golang.org, sum.golang.org and storage.googleapis.com (the
Go module proxy redirects module zips there; go.sum decides what is accepted); `clients.json` records what installed
and the proxy's requests. A client that does not install is `unavailable` (our fault, never the server's); with
nothing installed the stage is off and each item says `not_installed`. The clients and the suite run with PATH, a
home of their own and the Docker variables only: no token. Each client and each suite run is a process group of its own, stopped whole at its
limit, and its session's container is removed at once. The clients run on the runner, outside the container's memory
limit, so each one's server command goes through a byte cap (`corpus/oracles/relay.mjs`: 24 MiB in all, 4 MiB a
line, as our own probe reads at most). A protocol version a client reports reaches the fields only when it is one of
the specification's revisions; anything else is `other`.

**Judging** (`corpus/oracles/judge.mjs`, in the bundle step): each client's tools are hashed with this repository's
engine exactly as our reader's list is, and by tool names alone. Each conformance check is `pass`, `fail`, `warning`,
`info`, `skipped`, `bridge_excluded`, `not_applicable` (a list method the server never declared answered "method not
found") or `expected_fail` (listed in the subject's baseline). Disagreements carry the design's classes: D6
`live_client` (one oracle lists and another does not, or the tool names differ), D4 `schema_mismatch` (same names,
other definitions), D12 crash/timeout, D7 `lint_vs_conformance` (the suite's tool-name check against our engine's
`spec-name-charset` / `spec-name-length`). They are leads for triage, never a verdict.

**Baselines** (`corpus/fixtures/live-probe/oracle-baseline.json`): the expected oracle results of our own servers, the
known-answer control and the T0 subjects of the self test (mcp-check, kronicle-lite, sea-lite): each client's
outcome and negotiated protocol (and, for the pinned version, its catalog hash), the scenarios run per revision, the
expected failures and the expected disagreements (none). Any other failure, a baselined failure that passes (stale),
or a disagreement not listed fails the self test. In every bundle of a baselined subject, `results/live-probe.json`
`oracles.baseline_problems` lists the differences.

## Fuzz stage

An optional stage after the oracle stage, off unless the repository variable `LANE_LIVE_PROBE_FUZZ` is `on`: read-only protocol sessions
that check catalog stability, pagination and cursor handling and Unicode in identifiers. Design, invariants, fault rules
and how a reproducer becomes a regression test are in [FUZZ.md](FUZZ.md).

## Bundle

| Path | Holds |
|---|---|
| `results/live-probe.json` | Status (`graded` or `skipped`), our detail code, the tool-qa skip reason; the install method; the live grade (tool count, catalog hash, `tool_names_sha256` (`sha256(JSON.stringify([...new Set(names)].sort()))` of the wire names: the ast-grep oracle's `tool_set_sha256`, R-LP-87; also an observation next to `tool_list_sha256` once `EMIT_TOOL_NAMES_FIELD` is on), era, per-section grades, scores and caps, check counts, findings by check id and tool position); the comparison with the list read from source when the sandbox read one (counts, letters, checks that differ); timings; the sandbox's exit statuses. |
| `observations/live.ndjson` | Field records from the mcp-results field registry (below). |
| `controls/` | The three control outputs (below). |
| `raw/` | Captured target bytes, each file at most 6 MiB (a cut is recorded in `raw_truncated`): `tools-list.json` (the tools/list answers), `probe-bare.json` and `probe-env.json` (each probe whole, with its JSON-RPC transcript), `record.json` (the sandbox's record), `registry.json`, `static.json`, `analysis.json`, `steps.txt` (install and run log), `telemetry.jsonl` (the sandbox telemetry of this subject and of the run: settings, containers, syscall trace summaries, DNS queries, connections, egress, firewall drops), `report.json` (findings with tool names and messages), `static-compare.json`, `resolution.json`, `oracles.json` (the oracle stage's record: each client's output, each scenario's checks, the bridge's transcript and counts, the sessions' trace summaries). |
| `logs/live-probe.log` | One line: the item's outcome. |

The list read from source (`static_vs_live`, and the `static_vs_live_agreement` record) is mcp-check's own reader at
this commit, never the sandbox's vendored engine (R-LP-77). `corpus/live-probe-driver.mjs` copies
`src/inputs/repo-source.cjs`, the modules it requires and `corpus/static-read.cjs` into a folder the sandbox puts in its
read-only tools volume; the sandbox's static step runs it in its container (no network) over every file of the source
archive, through `fromGitHub` as scan-static calls it, and `static.json` carries the answer as `reader` with the
bundle's sha256. live-probe grades it as scan-static grades a subject (`usableList`, then `gradeCandidate`), so the two
lanes give the same static grade for the same commit. A names-only, several-server, incomplete or empty read is not
graded: `static_graded: false` with `static_skip` (`names_only`, `multiple_servers`, `reader_limit`, `no_tools`). An
answer from a bundle whose sha256 is not this checkout's is not used (`reader_mismatch`, R-LP-78), nor a missing one
(`reader_missing`). `static_reader` gives the first 12 hex digits of the bundle id. The id is reported by the bundle itself, inside a container we trust: the check catches drift and a missing bundle, not tampering.

Subject text (tool names and descriptions, server info, package names, host names a server looked up) is kept under
`raw/`. Outside it, a subject's string appears only when a strict pattern shows it is plain and holds no word ingest
reads as an attempt identity; otherwise only its hash.

Field records (all `stage: live`): `subject_id`, `registry_name`, `registry_version`, `registry_package_register_type`,
`registry_package_identifier`, `registry_package_version`, `registry_package_transport`,
`registry_package_runtime_hint`, `package_purl`, `oci_digest`, `transports_offered`, `commit_sha`, `commit_date`,
`protocol_era`, `protocol_negotiated`, `client_version`, `server_info`, `capabilities_flags`,
`capabilities_jcs_sha256`, `instructions_len_chars`, `instructions_sha256`, `startup_ms`, `latency_cold_ms`,
`startup_without_config`, `config_state`, `catalog_per_config_state` (tool count and catalog hash with no env and with
dummy env), `stdout_noise_lines`, `stderr_counts`, `list_changed_notifications`, `pagination_behaviour`,
`install_phase_behaviour`, `network_event`, `static_vs_live_agreement`, `observation_coverage`, `step_telemetry`,
`sandbox_tier`, `runner_env`, `our_tool_versions`, and for a skip `error_taxonomy_code`. The oracle stage adds
`oracle_stage`, `sdk_client_results`, `conformance_suite`, `conformance_summary`, `conformance_checks` and
`oracle_disagreements` (`EMIT_ORACLE_FIELDS`; tool-qa's ingest pins a registry with them). The meta file's `oracles`
lists the suite and each SDK client that ran, with its version.

## Skips

A subject that cannot be installed, started or listed is a skip, never a failed job:

Every skip names its fault side (tool-qa's `SKIP_FAULTS`; R-LP-24..38). Our own limits and errors have reasons of
their own and fault `tool`: they count as unassessed on our side, never as an exclusion and never as the server's or
an upstream's failure. The rule: a server is recorded as at fault (`subject`) only with evidence our own environment
cannot explain. Anything our environment could have caused is `tool`, and `infra` is only for a passing outside
condition (a rate limit, an outage).

`oci_host_not_allowed` is a deliberate safety choice, but it says nothing about the server, so it is recorded as our
gap rather than as `policy_excluded`, which would take the subject out of the coverage denominator and hide the gap.
The allowlist (six OCI hosts) does not stand between the sandbox and the network: the image is pulled by the runner's
Docker daemon, outside the sandbox. It guards the planner's own manifest and token fetches (no SSRF, no IP literal, no
token realm of the registry's choosing), limits what the host daemon is asked to pull, and enforces the 2 GiB size cap
and the 4x free-disk rule. An image on another host is unassessed until the list grows.

| Detail | Skip reason | Fault | Retryable |
|---|---|---|---|
| `bad_subject` (not a GitHub owner/name), `unsupported_package` (a package type we do not run), `unverified_registry_entry`, `launch_invalid` | `no_runnable_artifact` | tool | no |
| `oci_host_not_allowed` (the image is not on one of our six registries) | `no_runnable_artifact` | tool | no |
| `no_package` (no registry search page came back full; having no registry package is no defect: Go and Rust binaries, other npm names and own-registry images exist) | `no_runnable_artifact` | tool | no |
| `registry_lookup_truncated` (a registry search page came back full, 100 results with no paging: the entry may not have been fetched) | `no_runnable_artifact` | tool | no |
| `private_registry` | `no_runnable_artifact` | tool (we reach only the default registries, as with `unsupported_package`) | no |
| `image_too_large` (over our 2 GB cap) | `too_large` | tool | no |
| `remote_only` | `remote_only` | subject | no |
| `unsupported_transport` (SSE, or streamable HTTP with no URL, not on loopback, with no port or one under 1024, or naming a variable the package does not declare; a `{variable}` the package declares (an env name's default, a named argument's value or default), such as `{port}`, is filled; `raw/resolution.json` `transport_refused` says which and why, R-LP-86) | `unsupported_transport` | tool | no |
| `image_unavailable` (the registry's own 404, or 401 or 403 after a good token exchange, or a digest mismatch) | `install_failed_registry` | subject | no |
| `image_registry_unreadable` (no Bearer challenge, a bad realm, no token, bad JSON, no linux/amd64 entry, no layers, bad sizes, or a 401 or 403 with no token exchanged) | `install_failed_registry` | tool | no |
| `image_pull_failed` (the run-stage pull failed on a digest the planner already read; the pull records no stderr, so a rate limit, a timeout and the runner's disk look alike) | `install_failed_registry` | tool | no |
| `install_failed` (non-zero exit, no proxy refusal, not 137 or 124, an entry in the subject's namespace, no sign of trouble reaching the index, and the installer's word about the package itself (R-LP-90): npm E404 for its own registry URL or ETARGET for its own name; pip "No matching distribution found for" its own name (PEP 503) while the planner's PyPI JSON showed the release missing or with no file. A release for other Pythons or platforms only is an unsupported platform; a dependency's, a retry's or our entry helper's word ("declares no bin", an unresolved entry) is ours) | `install_failed_registry` | subject | no |
| `install_blocked` (our egress proxy refused something the install asked for) | `install_failed_registry` | tool | no |
| `install_resource_limit` (exit 137 or 124, or out of memory) | `install_failed_registry` | tool | no |
| `install_build_failed` (a native build, a missing compiler or library, an engine mismatch, or any other install failure with no package error) | `install_failed_registry` | tool | no |
| `install_timeout` (our install time limit) | `install_failed_registry` | tool | no |
| `package_not_runnable` (the package declares nothing we could start, in the package manager's or its own manifest's words: cargo's "nothing to install ... because it has no binaries", a NuGet package that is no tool, a bundle with no manifest, no server or no command, or whose manifest names a file it does not hold; only for a registry entry in the subject's own namespace) | `install_failed_registry` | subject | no |
| `package_error_unowned` (a package-level error (not in the registry, nothing to install) for a package whose registry entry is not shown to be the subject's: seed-only, seed-matched or repository-only) | `install_failed_registry` | tool | no |
| `entry_unresolved` (the install succeeded but our entry helper found nothing it may start: its name pattern, regular-file or record checks) | `install_failed_registry` | tool | no |
| `no_main_package` (a Go repository with no `package main` at its module root or under `cmd/`: a library, nothing to start) | `no_runnable_artifact` | tool | no |
| `go_install_refused` (its `go.mod` has a `replace` or `exclude` directive, which `go install <package>@<commit>` refuses) | `no_runnable_artifact` | tool | no |
| `go_source_unreadable` (GitHub would not list the root tree whole, or `go.mod` or a source folder could not be read) | `no_runnable_artifact` | tool | no |
| `entry_ambiguous` (several binaries, or several tool commands, and none named for the package: we would have to guess) | `install_failed_registry` | tool | no |
| `platform_unsupported` (the package builds for other platforms only: a .NET tool for Windows runtimes, a bundle's binary that is not linux/amd64 or whose manifest does not list linux; our platform is linux/amd64) | `no_runnable_artifact` | tool | no |
| `needs_credentials` (the registry entry declares a required env var, no cause of ours above applies, no crash signature unless it asks for configuration, the server exited non-zero by itself (not 125, 126, 127 or 137; no signal or time limit), with every argument filled and no guessed PyPI entry, and it made no network attempt) | `start_requires_credentials` | subject | no |
| `start_needs_network` (the server tried the network, which the run does not have: a lookup or connection in its role, a connect, looked-up name or network call in its trace, or its stderr shows a failed lookup or connection; with or without a declared env var) | `timeout_start` | tool (the contract allows only subject for `start_requires_credentials`) | no |
| `start_needs_config` (the server exited with its own code (not 125, 126, 127 or 137; no signal) and its stderr asks for configuration: a config file not found or unreadable, a kubeconfig or current-context, `--config`, a `Usage:` block, a missing or required argument, option, flag or environment variable, "please create/set/provide/specify", a missing required setting, credential or parameter, a configuration error, "not configured", "no ... credentials configured", "pass --x", "run ... first", invalid configuration, `KeyError: 'GITHUB_TOKEN'` (an unset variable read), pydantic settings validation (`validation error for Settings`, `Field required`); checked before the crash signature, so a configuration request raised with a traceback is still this) | `timeout_start` | tool | no |
| `missing_own_module` (the server's own package lacks a submodule its code imports: `No module named 'stratevo.cli.commands'` while `stratevo` is the wheel's own top-level package; only with the wheel read) | `timeout_start` | subject | no |
| `undeclared_dependency` (the server's own code (its last frame is in its own package or console script) imports a top-level module that is not installed, that its wheel does not ship, that no distribution its `requires_dist` declares provides (every declared distribution must be one whose import names we know, `DIST_IMPORTS`, none of them this one: `jose` comes from `python-jose`), and that is not Python's own or the venv's; e.g. `httpx` never declared, or a `utils` the wheel left out; only with the release's facts read) | `timeout_start` | subject | no |
| `unsupported_platform` (an OCI image with no linux/amd64 platform, which the sandbox does not run; an npm package whose `os`, `cpu` or `libc` leaves Linux on amd64 out (npm's `EBADPLATFORM`/`notsup`, R-LP-86); or the server says it runs on macOS or Windows only, or needs an executable only they have, such as `xcrun` or `powershell.exe`; the sandbox is Linux) | `timeout_start` | tool | no |
| `start_needs_extra` (a module only an extra of the package brings is missing (the planner installs an extra named `mcp`, `server` or `cli` with the package: `EMIT_PYPI_EXTRAS`, on since the pinned sandbox takes `launch.extras`, R-LP-84) (`requires_dist` with `extra == "..."`, read by the planner), or the server names the extra to install, `pip install 'pkg[mcp]'`; we installed the base package) | `timeout_start` | tool | no |
| `start_dependency_drift` (an import into a dependency the release declares with no upper bound failed for a submodule, name or attribute the installed version no longer has, e.g. `mcp.server.fastmcp` under mcp 2.x; a Node import of an export a dependency no longer has. Whether drift counts against the server is an open owner decision; until then it is ours) | `timeout_start` | tool | no |
| `start_failed` (install ok, every argument filled, the server's own non-zero exit (not 125, 126, 127 or 137; for an HTTP-mode server, its container's exit as the sandbox recorded it, only when its output was read back; an exit of 128+n is signal n, ours: 130, 137, 139, 143), the failing probe itself inside half the probe window, no network attempt, no unresolved PyPI console-script guess, none of the causes above (another platform, the network, our sandbox's limits, an extra, a changed dependency, an import we cannot place), AND stderr shows a crash signature: a panic, a traceback, an uncaught or unhandled exception or rejection, a segmentation fault, a missing module of the server's own (its wheel's top-level modules, or one named like the package), an import, syntax, reference or type error, a fatal error, a stack overflow; and no configuration text) | `timeout_start` | subject | no |
| `start_env_limited` (any other start failure: a signal, 137, exit 0, a late exit, an unfilled argument, a guessed PyPI entry, an early exit with no crash signature on stderr, which is no evidence against the server; or stderr that shows our sandbox stopped it: a read-only file system or refused write, `unable to open database file`, a missing shared library, a binary for another CPU (`Exec format error`), a missing executable (also GitPython's `Bad git executable` and an unbuilt native addon), matched in any case (Go prints them in lower case), a file under `/tmp` (the working directory we force) the image expected under its own WORKDIR; or a failed import we cannot place: a module that is not the server's own (a namespace folder such as `google/` is not) and is neither an extra nor a dependency declared with no upper bound, or a bare npm dependency that is not installed; a missing file at an absolute path, a full disk (`[Errno 28]`), `KeyboardInterrupt` (our stop); or a Python crash whose last frame is inside an installed dependency, not the server's own package) | `timeout_start` | tool | no |
| `bundle_host_not_allowed` (an MCP bundle that is not a GitHub release asset, or a redirect off GitHub's release-asset hosts) | `no_runnable_artifact` | tool | no |
| `bundle_runtime_unsupported` (a bundle launched by something we do not start: a launcher on the user's machine (npx, sh, bash, bun, deno, docker, uvx ...), a shell script, a server type the spec does not name, a uv project in a subfolder) | `no_runnable_artifact` | tool | no |
| `bundle_unreadable` (a zip we do not read: zip64, a manifest over 1 MiB, an entry name our rules do not take though it stays inside: a backslash, a colon, a control character, our length and depth limits) | `install_failed_registry` | tool | no |
| `bundle_too_large` (over our 200 MiB bundle cap) | `too_large` | tool | no |
| `bundle_unavailable` (the release page's own 404 for the bundle's URL, twice, for an entry in the subject's namespace) | `install_failed_registry` | subject | no |
| `bundle_hash_mismatch` (the bytes at the URL are not the ones the registry entry names in fileSha256) | `install_failed_registry` | subject | no |
| `bundle_unowned` (one of the four bundle failures above, or `package_not_runnable`, for a bundle whose registry entry is not shown to be the subject's: seed-only or seed-matched; a repository-only entry is `unverified_registry_entry`) | `install_failed_registry` | tool | no |
| `bundle_fetch_refused` (the release host's 4xx other than github.com's 404, 403, 408, 425 and 429 for a bundle download: its answer to our request, the same on a retry; 5xx, 403, 408 and 425 stay retryable, R-LP-89) | `tool_error` | tool | no |
| `bundle_invalid` (the file is no zip archive at all, or names a path that leaves it: absolute or with a `..` segment; only for an entry in the subject's namespace, else `bundle_unowned`) | `install_failed_registry` | subject | no |
| `list_failed` (a JSON-RPC error the server sent, or a malformed result; not "method not found" from a server that declared no tools capability) | `timeout_start` | subject | no |
| `no_tools_capability` (the server declared no `tools` capability at initialize and answered `tools/list` with -32601 "method not found", as the specification lets it: a prompts-only or resources-only server. `buildItem` records it as status `no_tools` with no skip, so it is assessed with nothing to grade and nobody's fault; the row is the fallback if a caller still skips it, R-LP-75) | `no_tools_found` | tool | no |
| `list_probe_limited` (our time limit, the page cap, the read cap, or an HTTP transport failure while listing) | `timeout_start` | tool | no |
| `start_timeout` | `timeout_start` | tool (the subject's time budget also pays for the install, so a slow runner or sandbox start can run it out; it is no evidence the server hung) | no |
| `list_rejected` (the engine refused the list) | `tool_error` | tool | no |
| `harness_error` (our driver or bundle step failed) | `tool_error` | tool | yes |
| `rate_limited` | `rate_limited` | infra | yes |
| `upstream_error` (a 5xx, 408, 425 or a 403 with no rate-limit headers, a network failure, a read cut at our cap), `shard_deadline`, `disk_low` | `upstream_unavailable` | infra | yes |
| `registry_query_refused` (a registry's 4xx other than 403, 404, 408, 425 and 429: its answer to our request, the same on a retry; a 403 without rate-limit headers stays `upstream_error`, since a CDN or firewall may send it for a while; one candidate's provenance answer refused leaves that candidate unverified and the next one is tried; a search shorter than 3 characters, which the MCP registry answers 422, is never sent, R-LP-76) | `tool_error` | tool | no |
| `image_access_denied` (the registry's token service refused a pull token, 401 or 403: ghcr's `DENIED` for a private or missing package; private and gone look alike and the request is ours, R-LP-76) | `install_failed_registry` | tool | no |
| `resolver_error` (an exception in our resolver with no detail code: a bug of ours, never an outage; its class name is kept in `raw/resolution.json`, R-LP-76) | `tool_error` | tool | no |
| `sandbox_evidence_missing` (no syscall trace or firewall log for it) | `trace_unavailable` | tool | yes |

## Controls

Every bundle carries all of them (four when the oracle stage is installed, else three); if any one does not give its
expected outcome the bundle step stops and nothing is uploaded.

| Kind | Expected | What it is |
|---|---|---|
| `known_good` | `match` | Our own server, `@isokron/mcp-check@1.3.1`, installed from npm and started in the sandbox like a subject. Its live list must have the tool count, catalog hash, grades and checks in `corpus/fixtures/live-probe/known-answer.json`, which `node corpus/live-probe.mjs known-answer` computes from the saved capture `test/fixtures/live-probe/known-answer-tools.json` (the tests check they agree). |
| `known_good` | `match` | The oracle stage on the same server (`controls/oracle-known-answer.json`): every SDK client that installed, and the conformance suite, give the answers in `corpus/fixtures/live-probe/oracle-baseline.json` (`controls.known_good`). Present only when the oracles were installed. |
| `forgery` | `contained` | `corpus/fixtures/live-probe/forgery-server.js`, run in the sandbox's pinned node image with a fresh marker. Every text it returns (tool names, descriptions, server info, capabilities, errors) poses as a result of another attempt. It goes through the same grading and field code as a subject; the marker must come back in `raw/` and nothing outside `raw/` may hold the marker, an identity key or an envelope. |
| `malicious` | `blocked` | The sandbox self test of this run: every escape attempt blocked and logged, and its telemetry check passed. |

## Proof on GitHub

`live-probe.yml` runs only on dispatch from `main`. `.github/workflows/live-probe-selftest.yml` runs the same steps on
every pull request that touches the lane, on a fixture shard of our own repositories
(`corpus/fixtures/live-probe/selftest-shard.json`: our T0 servers mcp-check, kronicle-lite and sea-lite, each with its oracle baseline, and one with no
package), builds each bundle with the worker-kit in dry-run mode, and judges it with tool-qa's own ingest code at
`WORKER_KIT_REF`: the manifest schema, identity and file checks, identity claims outside `raw/`, the controls, the
field registry and the secret scan, plus each item's expected outcome.

## Version pins

tool-qa files each result under the commits its lane pins (R-PIN-01). `live-probe.yml` and `scan-static.yml` take an
optional `tool_sha` input (empty, or a full 40-character commit): the job checks out `tool_sha`, else the dispatched
commit, and stops unless `git rev-parse HEAD` is exactly that. Each bundle's manifest `tools` then says what ran:
`@isokron/mcp-check` at that commit, `isokron-ai/mcp-surface-corpus` at the sandbox commit used and, only when the
fuzz stage ran, `fuzz` at that commit (scan-static: `mcp-check` at that commit). The workflow file itself always runs
from `main`; a pinned commit older than the reporting code reports the package version, which tool-qa counts as
unproven, so a pin is bumped to a commit that has it.

## Residual risk

The upload steps run in the same job as the sandbox, after it. The checks before them see containers, volumes,
labelled networks, processes of uid 65534 and runsc processes. A target that escaped gVisor (a gVisor bug, then a host
kernel bug) and ran on the host under another user or another name would not be seen, and could reach the job's
artifact upload token in the steps after it. The runner is discarded after the job and holds no secret; ingest's
identity, file and claim checks still apply to anything uploaded.

## Native modules

An npm subject installs with its install scripts on. Since mcp-surface-corpus 73a2669 (`SURFACE_CORPUS_REF`), such an
install runs in the full Debian image of the same Node release as the run image (`node24-build`: compilers, make,
python3 and the Node headers), with `npm_config_nodedir=/usr/local` and `npm_config_build_from_source=true`, so a
native module (better-sqlite3 in kronicle-lite, for example) builds from source against those headers; the server then
runs in the slim image as before. The install network still reaches only the npm registry: prebuilt binaries are not
fetched.
