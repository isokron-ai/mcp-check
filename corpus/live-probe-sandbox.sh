#!/usr/bin/env bash
# The sandbox part of a live-probe shard (corpus/LIVE-PROBE.md), run by .github/workflows/live-probe.yml and
# live-probe-selftest.yml after `corpus/live-probe.mjs plan`:
#
#   corpus/live-probe-sandbox.sh <work> <mcp-surface-corpus checkout> <deadline, epoch seconds>
#
#   1. before it, the workflow ran mcp-surface-corpus's sandbox-guard action on this runner (gVisor installed and
#      registered as pinned, the host firewall, the hostile self test); this script runs no target unless that guard
#      said pass from the same sandbox commit as the checkout (GUARD_VERDICT, GUARD_SHA);
#   2. the self test's telemetry check (scripts/check-selftest.mjs) once more, from the checkout, before any target.
#      If it fails, nothing else runs.
#   3. the controls (our own server from npm, and the forgery server) through the sandbox driver;
#   4. the subjects through the sandbox driver, stopped at the deadline (the items left report a retryable skip),
#      then the subjects built in the sandbox (crates), then the OCI subjects one at a time, then one retry of each
#      subject whose first start failed on a cause a changed launch tests (R-LP-81);
#      the driver is mcp-surface-corpus's bin/run-shard.mjs, run by corpus/live-probe-driver.mjs, which adds the
#      oracle stage after each target's probe when ORACLE_CLIENTS names the clients corpus/oracles/install.mjs
#      installed (corpus/LIVE-PROBE.md, "Oracles");
#   5. a last sweep of every container, network and volume of the runs, and a check that none is left, so no
#      target process exists when the upload steps start.
#
# Every target runs in the driver's containers (bin/run-shard.mjs: gVisor, user 65534, no capabilities, read-only
# root, internal networks, an environment of names the harness sets); nothing of a target runs in this shell. The
# driver prints only "run finished, exit N" lines; everything else goes to files under <work>. GH_TOKEN (the job's
# read-only token) is read by the driver's own fetch of repository facts and never reaches a container.
#
# Writes <work>/sandbox.json with every exit status. Exits 1 when the sandbox could not be set up or did not pass its
# self test (then no target ran), else 0: a subject's failure never fails the job, `bundle` reads what happened.
set -uo pipefail
work="${1:?work folder}"
msc="$(cd "${2:?mcp-surface-corpus checkout}" && pwd)"
deadline="${3:?deadline}"
[[ "$deadline" =~ ^[0-9]{10}$ ]] || { echo "deadline must be epoch seconds"; exit 2; }
mkdir -p "$work"
umask 077

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
oracles="${ORACLE_CLIENTS:-none}"
# The fuzz stage (corpus/FUZZ.md) is on only when the plan says so (the plan step reads LIVE_PROBE_FUZZ): one decision
# for the targets' time limits and for the stage.
fuzz=off
if [ -f "$work/plan.json" ] && node -e 'process.exit(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).fuzz === true ? 0 : 1)' "$work/plan.json" 2>/dev/null; then fuzz=on; fi
oracles_installed=false
if [ "$oracles" != none ] && [ -f "$oracles" ] && node -e '
  const r = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const any = (r.conformance && r.conformance.ok) || Object.values(r.clients || {}).some((c) => c && c.ok);
  process.exit(any ? 0 : 1);
' "$oracles" 2>/dev/null; then oracles_installed=true; else oracles=none; fi
install_rc=-1; guard_rc=-1; selftest_rc=-1; check_rc=-1; controls_rc=-1; subjects_rc=-1; builds_rc=-1; retry_rc=-1; swept=false
left_labelled=-1; left_containers=-1; left_volumes=-1; uid_procs=-1; runsc_procs=-1
gvisor=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).release || ""))' "$msc/gvisor.json" 2>/dev/null || true)
msc_commit=$(git -C "$msc" rev-parse HEAD 2>/dev/null || true)

write_state() {
  node -e '
    const [file, ...v] = process.argv.slice(1);
    const n = (x) => (/^-?[0-9]{1,4}$/.test(x) ? Number(x) : null);
    const s = { oracles_installed: v[15] === "true", install_rc: n(v[0]), guard_rc: n(v[1]), selftest_rc: n(v[2]), selftest_check_rc: n(v[3]), controls_rc: n(v[4]), subjects_rc: n(v[5]), builds_rc: n(v[16]), retry_rc: n(v[17]), swept: v[6] === "true", msc_commit: /^[0-9a-f]{40}$/.test(v[7]) ? v[7] : null, gvisor_release: v[8] || null, worker_kit_ref: /^[0-9a-f]{40}$/.test(v[9]) ? v[9] : null, left: { labelled: n(v[10]), containers: n(v[11]), volumes: n(v[12]), uid_65534_processes: n(v[13]), runsc_processes: n(v[14]) }, finished_at: new Date().toISOString() };
    require("fs").writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
  ' "$work/sandbox.json" "$install_rc" "$guard_rc" "$selftest_rc" "$check_rc" "$controls_rc" "$subjects_rc" "$swept" "$msc_commit" "$gvisor" "${WORKER_KIT_REF:-}" \
    "$left_labelled" "$left_containers" "$left_volumes" "$uid_procs" "$runsc_procs" "$oracles_installed" "$builds_rc" "$retry_rc"
}

sweep() {
  local ids
  ids=$(docker ps -aq --filter label=isokron.surface.run); [ -z "$ids" ] || docker rm -f -v $ids
  ids=$(docker network ls -q --filter label=isokron.surface.run); [ -z "$ids" ] || docker network rm $ids
  ids=$(docker volume ls -q --filter label=isokron.surface.run); [ -z "$ids" ] || docker volume rm -f $ids
}

# The driver, with its public lines only; its exit status is returned.
drive() {
  local list="$1" out="$2" limit="$3"
  mkdir -p "$out/_shard"
  timeout --kill-after=30 "$limit" node "$here/live-probe-driver.mjs" --msc "$msc" --oracles "$oracles" --fuzz "$fuzz" -- --targets "$list" --out "$out" --lane ci \
    2>>"$out/_shard/driver-stderr.log" | grep --line-buffered -E '^run finished, exit [0-9]+$'
  return "${PIPESTATUS[0]}"
}

# 1. The sandbox guard ran on this runner, passed, and from the sandbox commit checked out here.
if [ "${GUARD_VERDICT:-}" != pass ] || ! [[ "${GUARD_SHA:-}" =~ ^[0-9a-f]{40}$ ]] || [ "$GUARD_SHA" != "$msc_commit" ]; then
  echo "::error title=live-probe::the sandbox guard did not pass on this runner, or ran another sandbox commit; no target ran"
  write_state; exit 1
fi
install_rc=0; guard_rc=0; selftest_rc=0

# 2. Its telemetry check once more, from this checkout; it alone decides.
node "$msc/scripts/check-selftest.mjs" "$work/selftest/telemetry.jsonl" >"$work/selftest-check.txt" 2>&1; check_rc=$?
cat "$work/selftest-check.txt"
if [ "$check_rc" -ne 0 ]; then
  echo "::error title=live-probe::the sandbox self test does not check out (check $check_rc); no target ran"
  sweep >/dev/null 2>&1 || true
  write_state; exit 1
fi

export SURFACE_PROBE_MS="${SURFACE_PROBE_MS:-45000}"
# 3. The controls.
echo "controls:"
drive "$work/targets-controls.json" "$work/driver-controls" 900; controls_rc=$?
sweep >>"$work/sweep.log" 2>&1 || true

# 4. The subjects, until the deadline.
runnable=$(node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).targets.length))' "$work/targets-subjects.json")
if [ "$runnable" -gt 0 ]; then
  left=$(( deadline - $(date +%s) ))
  if [ "$left" -gt 60 ]; then
    echo "subjects ($runnable, at most ${left}s):"
    drive "$work/targets-subjects.json" "$work/driver-subjects" "$left"; subjects_rc=$?
  else
    echo "::warning title=live-probe::no time left for the subjects"; subjects_rc=124
  fi
else
  subjects_rc=0
fi

# 4a. Subjects built in the sandbox (crates: corpus/live-probe.mjs isBuild), after the others, one after another,
#     each within its own longer limit, until the deadline (R-LP-55). Not run at all: builds_rc stays -1.
builds=$(node -e 'try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).targets.length)) } catch { process.stdout.write("0") }' "$work/targets-builds.json")
if [ "$builds" -gt 0 ]; then
  sweep >>"$work/sweep.log" 2>&1 || true
  left=$(( deadline - $(date +%s) ))
  if [ "$left" -gt 60 ]; then
    echo "builds ($builds, at most ${left}s):"
    drive "$work/targets-builds.json" "$work/driver-builds" "$left" </dev/null; builds_rc=$?
  else
    echo "::warning title=live-probe::no time left for the subjects built in the sandbox"
  fi
else
  builds_rc=0
fi

# 4b. OCI subjects, one at a time. An image's 2 GB cap counts compressed bytes, so each runs only when the Docker
#     disk has about four times its declared size free; otherwise this one and every later one stop here (a
#     retryable skip, disk_low). After each, its image is removed.
: >"$work/oci-runs.jsonl"
docker_root=$(docker info -f '{{.DockerRootDir}}' 2>/dev/null || echo /var/lib/docker)
oci_lines=$(node -e '
  const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  for (const o of l) if (/^s[0-9]{3}$/.test(o.id) && Number.isSafeInteger(o.bytes) && o.bytes >= 0) process.stdout.write(o.id + " " + o.bytes + "\n");
' "$work/oci.json" 2>/dev/null || true)
stop=""
while read -r id bytes; do
  [ -n "$id" ] || continue
  image=$(node -e 'const l = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); const o = l.find((x) => x.id === process.argv[2]); process.stdout.write(o ? o.image : "")' "$work/oci.json" "$id")
  left=$(( deadline - $(date +%s) ))
  if [ -n "$stop" ] || [ "$left" -le 60 ]; then
    echo "{\"id\":\"$id\",\"outcome\":\"${stop:-deadline}\"}" >>"$work/oci-runs.jsonl"; continue
  fi
  avail=$(df -B1 --output=avail "$docker_root" 2>/dev/null | tail -n 1 | tr -d ' ')
  [[ "$avail" =~ ^[0-9]+$ ]] || avail=$(sudo -n df -B1 --output=avail "$docker_root" 2>/dev/null | tail -n 1 | tr -d ' ')
  [[ "$avail" =~ ^[0-9]+$ ]] || avail=0
  need=$(( bytes * 4 ))
  if [ "$avail" -lt "$need" ]; then
    echo "::warning title=live-probe::not enough disk for the next image ($avail bytes free, $need needed); the OCI subjects left stop here"
    stop=disk_low
    echo "{\"id\":\"$id\",\"outcome\":\"disk_low\",\"avail\":$avail,\"need\":$need}" >>"$work/oci-runs.jsonl"; continue
  fi
  echo "subject (image, at most ${left}s):"
  drive "$work/oci/$id.json" "$work/driver-oci/$id" "$left" </dev/null; rc=$?
  echo "{\"id\":\"$id\",\"outcome\":\"ran\",\"rc\":$rc,\"avail\":$avail,\"need\":$need}" >>"$work/oci-runs.jsonl"
  sweep >>"$work/sweep.log" 2>&1 || true
  [ -z "$image" ] || docker image rm -f "$image" >>"$work/sweep.log" 2>&1 || true
done <<<"$oci_lines"

# 4c. One retry, with a changed launch, of each subject whose first start failed on a cause that change tests (R-LP-81:
#     an MCP SDK that floated to 2.x under a release built for 1.x runs again with mcp<2). Planned by
#     `corpus/live-probe.mjs retry` from the first runs' output, read as data, each target checked by the sandbox's own
#     target check; run like the subjects, until the deadline. Not run at all: retry_rc stays -1.
if node "$here/live-probe.mjs" retry "$work" --msc "$msc" >"$work/retry-plan.txt" 2>&1; then
  cat "$work/retry-plan.txt"
  retries=$(node -e 'try { process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).targets.length)) } catch { process.stdout.write("0") }' "$work/targets-retry.json")
  if [ "$retries" -gt 0 ]; then
    sweep >>"$work/sweep.log" 2>&1 || true
    left=$(( deadline - $(date +%s) ))
    if [ "$left" -gt 90 ]; then
      echo "retries ($retries, at most ${left}s):"
      drive "$work/targets-retry.json" "$work/driver-retry" "$left" </dev/null; retry_rc=$?
    else
      echo "::warning title=live-probe::no time left for the retries"
    fi
  else
    retry_rc=0
  fi
else
  echo "::warning title=live-probe::the retries could not be planned; the first runs stand"
fi

# 5. Nothing of a target may outlive this step: no container or volume at all (labelled or not), no labelled
#    network, no host process running as the sandbox user (65534), and no runsc or containerd-shim-runsc process.
#    A process that got out some other way (another user, another name) is not seen here: corpus/LIVE-PROBE.md.
sweep >>"$work/sweep.log" 2>&1 || true
for _ in 1 2 3 4 5 6 7 8 9 10; do
  pgrep -f 'runsc|containerd-shim-runsc' >/dev/null || break
  sleep 1
done
left_labelled=$(( $(docker ps -aq --filter label=isokron.surface.run | wc -l) + $(docker network ls -q --filter label=isokron.surface.run | wc -l) ))
left_containers=$(docker ps -aq | wc -l)
left_volumes=$(docker volume ls -q | wc -l)
uid_procs=$(pgrep -u 65534 | wc -l)
runsc_procs=$(pgrep -f 'runsc|containerd-shim-runsc' | wc -l)
if [ $(( left_labelled + left_containers + left_volumes + uid_procs + runsc_procs )) -eq 0 ]; then swept=true
else
  echo "::error title=live-probe::the sandbox is not gone: $left_labelled labelled, $left_containers containers, $left_volumes volumes, $uid_procs processes of uid 65534, $runsc_procs runsc processes"
  ps -eo pid,user,comm 2>/dev/null | awk '$2 == "nobody" || $2 == "65534" || $3 ~ /runsc|containerd-shim/' >>"$work/sweep.log" || true
fi
write_state
echo "sandbox: self test $check_rc, controls $controls_rc, subjects $subjects_rc, swept $swept"
exit 0
