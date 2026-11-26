# Dependency policy

What to do when a dependency has a known vulnerability, and the rules for
adding or changing one. It follows Adhal's
[DEPENDENCY-POLICY.md](https://github.com/khartig/adhal/blob/main/docs/DEPENDENCY-POLICY.md),
adapted to one package.

## What fails the build

Two jobs in `.github/workflows/ci.yml` check `pnpm-lock.yaml`. Both are
required:

| Job | Database | Fails on |
| --- | --- | --- |
| `audit` | GitHub Advisory Database, through `pnpm audit --audit-level moderate` | moderate, high, or critical |
| `osv-scanner` | OSV, which adds other sources to GitHub's advisories, among them reports of malicious packages | any finding, since the scanner has no threshold |

Both check the whole lockfile, dev dependencies included. Most of it is
the Holepunch tree under `hyperdht`, so most findings will be
transitive. Both were clean on 2026-11-25, when the jobs were added.

To run them locally:

```sh
pnpm audit --audit-level moderate
docker run --rm -v "$PWD":/src:ro ghcr.io/google/osv-scanner-action:v2.7.0 \
  scan source --config=/src/osv-scanner.toml --lockfile=/src/pnpm-lock.yaml
```

## When a scan finds something

Take the first response that applies.

1. **A fixed version exists. Upgrade to it.** For a direct dependency,
   change its exact pin in `package.json`. For a transitive one, first
   upgrade the direct dependency that pulls it in, if a release of it
   takes the fix. If none does yet, force the fixed version with an
   `overrides` entry in `pnpm-workspace.yaml`, with a comment naming the
   advisory, and remove it once the direct dependency catches up. Then
   run the full suite, since an override puts a version under the
   Holepunch stack that its authors did not test against.
2. **No fix exists, and sluice cannot reach the vulnerable code.** Add an
   exception (below).
3. **No fix exists, and sluice can reach the vulnerable code.** Then
   sluice has the vulnerability: fix or work around it in sluice's code,
   release, publish a GitHub security advisory, and `npm deprecate` the
   affected versions. An exception may hold the build open meanwhile,
   but its reason must name the advisory being prepared.

When it is not clear whether sluice can reach the vulnerable code, treat
it as case 3. A relay is a server on the open internet, and every client
can send it data.

**A report of a malicious package is never an exception.** OSV lists
these with `MAL-` IDs. Remove the package, regenerate the lockfile, and
find out whether any published version of `sluice-relay` resolved to it.
If one did, handle it like case 3.

## Exceptions

Each one needs:

- **The advisory's ID,** the GHSA ID where there is one. It goes in
  `osv-scanner.toml` as an `[[IgnoredVulns]]` entry with `ignoreUntil`
  and `reason`. If `pnpm audit` reports it too, it also goes in
  `auditConfig.ignoreGhsas` in `pnpm-workspace.yaml`, with the date in a
  comment beside it. Create that file the first time it is needed; pnpm
  reads its settings even in a single-package repository.
- **A reason that can be checked:** the vulnerable package and function,
  the path by which it is in the lockfile, why sluice never calls it,
  and how that was established. "Transitive" and "not used" are not
  reasons on their own.
- **An expiry no more than 90 days out.** `ignoreUntil` enforces it for
  OSV. `pnpm audit` has no expiry, so the two are renewed or removed
  together.
- **A commit of its own,** whose message names the advisory.

When the fixed version arrives, upgrade and remove the exception from
both files in the same commit.

## Adding or changing a dependency

- **Pin it exactly:** `1.2.3`, not `^1.2.3`.
- **Say why it is needed** in the commit message. Every runtime
  dependency ships to every operator.
- **Read the lockfile diff,** not only the `package.json` change.
- **Allow no install scripts.** pnpm blocks dependency install scripts by
  default, and this repository allows none.
- **Keep hyperdht and blind-relay at the versions Adhal and Pear use,**
  unless there is a reason to differ: wire compatibility with Pear's
  relay is the point (Adhal's RELAY-HOSTS.md §1). The lockfile should
  hold one blind-relay, the one hyperdht depends on.
- **Both scans pass** before it merges.

## Before a release

- Both scans pass on the commit being tagged.
- The release notes list every exception in force, each with its
  advisory, reason, and expiry.

## Not covered yet

- **Advisories published after a merge** go unseen until the next CI
  run. A scheduled run would close that gap.
- **What an operator's install resolves.** The package ships no
  lockfile, so `npm install --global sluice-relay` can resolve newer
  transitive versions than the ones locked, tested, and in the release's
  SBOM. Shipping an `npm-shrinkwrap.json` would lock them, at the cost
  of a second lockfile to keep in step with pnpm's.
