# Releasing

This is the step that keeps getting forgotten, and the drift is visible in the
repo: **0.2.1 is on npm with no git tag**, while `v0.1.1` was tagged before it
was published. "Bumped", "tagged" and "published" are three different states and
nothing here enforces the difference — so do all of it, in this order.

## 1. Verify on `main`, after the merge — not on the branch

The server-backed suites need a live server, and that has to be one shell
command:

```bash
(PORT=3200 STUN_PORT=3678 bun run server.ts > /tmp/s.log 2>&1 & echo $! > /tmp/p); \
  sleep 2; PORT=3200 STUN_PORT=3678 timeout 90 bun run test.ts; \
  PORT=3200 bun run bench/layout.ts; kill $(cat /tmp/p)
bun test
```

## 2. Bump

```bash
npm version <patch|minor|major> --no-git-tag-version
```

A merged feature is a **minor**, a fix is a patch. `--no-git-tag-version` because
the tag is created by hand in step 5, so the tag and the release commit point at
the same object instead of npm inventing a commit of its own.

## 3. Pack it and prove the tarball carries the change

There is no build step and no `dist/`; `files` ships 7 entries as written.

```bash
npm pack --pack-destination /tmp
rm -rf /tmp/rel && mkdir -p /tmp/rel && tar -xzf /tmp/thoth-dev-tailcast-<v>.tgz -C /tmp/rel
node /tmp/rel/package/bin/tailcast.mjs -p 3300 --stun-port 3778 &
PORT=3300 STUN_PORT=3778 bun run test.ts        # 100/100 against the packed copy
```

Running the packed launcher **from a foreign directory** is the only check that
exercises the `import.meta.dir` static-file resolution the way an installed
package does — a `"./public"` relative path passes every in-repo test and serves
nothing once installed.

**Pass the port as a flag, never as an env var.** `bin/cli.ts` defaults to
`{ port: 3000, stunPort: 3478 }` and writes `PORT: String(opts.port)` into the
child env unconditionally, so an inherited `PORT` is silently discarded:
`PORT=3300 tailcast` serves on **3000**. Only `server.ts` run directly honours
the environment. Flag > env > default would be the conventional order; this is
not fixed, just recorded — and it is why a release check that sets `PORT` looks
like it passed while testing the wrong process.

## 4. Commit

`release: <version>`, touching only `package.json`.

## 5. Tag and push

```bash
git tag v<version>
git push && git push --tags
```

Both. This is the step 0.2.1 missed.

## 6. Publish — the user's step, not an agent's

`npm publish` — never `bun publish`, which does not read `~/.npmrc` and fails
with "missing authentication" even after a successful `npm login`.
`publishConfig.access` is already `public`, so no `--access` flag.

The account has 2FA: the publish stops with `EOTP` and prints an auth URL that
the harness masks, so either the user runs it or they hand over the 6-digit code
for `npm publish --otp=<code>`. Afterwards the npm CDN takes ~100s to propagate;
a 404 in that window is normal and not a failed publish.

## The three names a release touches

The **npm** org is `thoth-dev`, the **GitHub** org is `thoth-id`, and the
installed command is `tailcast` (with `screen-share` as an alias). The
`repository` URL in `package.json` keeps `thoth-id` on purpose.
