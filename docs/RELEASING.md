# Releasing

sluice is published to npm as `sluice-relay`. The command it installs is
`sluice`. `.github/workflows/release.yml` publishes a version when a
GitHub Release is published, as Adhal's does.

A release is always a commit on `main`. Work reaches `main` through a
pull request, so CI runs on it before it lands: the workflow runs on pull
requests and on pushes to `main`, not on pushes to other branches. The
tag goes on `main` after the merge.

## Once: the first version, and trusted publishing

npm lets a package trust a GitHub workflow only after the package
exists, so the first version is published by hand.

1. **Merge to `main` and tag it.** Open a pull request from the branch
   that has `version` set to `0.1.0`, wait for CI to pass, and merge it.
   Then tag the merge result:

   ```sh
   git checkout main
   git pull --ff-only
   git tag -a v0.1.0 -m "sluice-relay 0.1.0"
   git push origin v0.1.0
   ```

2. **Publish 0.1.0 by hand, from the tag, in a clean tree.**

   ```sh
   git checkout v0.1.0
   git status            # must be clean
   pnpm install --frozen-lockfile
   pnpm typecheck && pnpm test
   npm login
   pnpm publish --access public
   git checkout main
   ```

   pnpm refuses to publish from a detached HEAD. If it does, add
   `--no-git-checks`; the tag is what makes this checkout the release.
   This version has no provenance attestation. Every version after it
   does.

3. **Make the repository's `npm` environment** (GitHub: Settings →
   Environments → New environment, named `npm`), and add yourself as a
   required reviewer. Then every publish waits for your approval.

4. **Add the trusted publisher on npm:** on npmjs.com, open the
   package's Settings → Trusted publishing → GitHub Actions, with:
   - organization or user: `khartig`
   - repository: `sluice`
   - workflow filename: `release.yml`
   - environment: `npm`

5. **Turn off token publishing** in the same settings ("Require two-factor
   authentication and disallow tokens"), so the workflow is the only way
   a version gets published.

6. **Optionally, publish a GitHub Release for v0.1.0, and reject its
   `publish` job.** The release starts `release.yml`. Its `sbom` job
   attaches the SBOM. Its `publish` job would find 0.1.0 already on npm
   and then fail its provenance check, because a version published by
   hand has none. So when it waits on the `npm` environment, reject it.
   This is the only version where you do. Step 3 has to come first, or
   nothing makes the job wait.

## Each version

1. On a branch, bump `version` in `package.json`, commit, and open a
   pull request.
2. Wait for CI to pass on it, both dependency scans included. Then merge.
3. Tag the merge result on `main` and push the tag:

   ```sh
   git checkout main
   git pull --ff-only
   git tag -a v<version> -m "sluice-relay <version>"
   git push origin v<version>
   ```

4. Publish a GitHub Release for the tag. The release notes list any
   dependency exceptions in force (DEPENDENCY-POLICY.md).
5. Approve the `publish` job when it waits on the `npm` environment.
   It checks the tag against `package.json`'s version, and fails if they
   differ.

The job packs the tarball once, attests it, publishes it, checks that
npm serves exactly those bytes with a provenance attestation, and
attaches the tarball, `SHA256SUMS`, and a CycloneDX SBOM to the release.
To check a downloaded tarball:

```sh
gh attestation verify sluice-relay-<version>.tgz --repo khartig/sluice
```
