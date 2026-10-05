# Edge deploys from CI

`deploy.sh` is the only thing CI can run on the httpeers.net server for the edge stack: it puts one
commit's relay or sites image into service, checks it, and goes back to the previous image when the
check fails. The CI key reaches it as an SSH forced command, so the key can name a service and a
commit and nothing else.

## The shape

```
GitHub Actions (relay.yml / sites.yml, push to main)
  ci (shared CI) ─► publish (ghcr.io/statewalker/httpeers-<service>:sha-<commit>) ─► deploy
                                                                                      │ ssh "deploy relay <sha>"
                                                                                      ▼
server: <DEPLOY_PATH>/bin/deploy.sh   (forced command of the edge-deploy key)
  pull image ─► pin it in images.env ─► docker compose up -d <service> ─► verify
                                                                            │ failed
                                                                            ▼
                                                     pin the previous image, up, verify again
```

| Path on the server | What it holds |
|---|---|
| `<DEPLOY_PATH>/docker-compose.yml` | the edge stack (a copy of `deploy/docker-compose.yml`) |
| `<DEPLOY_PATH>/bin/deploy.sh` | this script |
| `<DEPLOY_PATH>/images.env` | `RELAY_IMAGE=…` / `SITES_IMAGE=…`: the image each service runs; absent means `:latest` |
| `<DEPLOY_PATH>/deploy.log` | one line per deploy: service, commit, ok or FAILED, the previous image |

## How to install it

Once, on the server, as the deploy user (the one in `DEPLOY_USER`, a member of the `docker` group):

1. Copy the compose file and the script, from a checkout of this repository:
   ```sh
   scp deploy/docker-compose.yml <user>@<host>:<DEPLOY_PATH>/docker-compose.yml.new
   scp deploy/server/deploy.sh <user>@<host>:<DEPLOY_PATH>/deploy.sh
   ```
   then on the server:
   ```sh
   cd <DEPLOY_PATH>
   diff docker-compose.yml docker-compose.yml.new   # only the relay and sites image lines differ
   mv docker-compose.yml.new docker-compose.yml
   install -m 755 -D deploy.sh bin/deploy.sh && rm deploy.sh
   ```
   The compose file reads `RELAY_IMAGE` and `SITES_IMAGE`; without `images.env` it runs `:latest`
   as before, so this step changes nothing yet.
2. Create the key, on any machine:
   ```sh
   ssh-keygen -t ed25519 -N '' -C edge-deploy@httpeers -f edge_deploy
   ```
3. Authorise it on the server, restricted to the script — one line in `~/.ssh/authorized_keys`:
   ```
   restrict,command="<DEPLOY_PATH>/bin/deploy.sh" ssh-ed25519 AAAA... edge-deploy@httpeers
   ```
4. Check it from your machine: `ssh -i edge_deploy <user>@<host> status` lists the services;
   `ssh -i edge_deploy <user>@<host> id` answers `DEPLOY FAILED: unknown command`.
5. Give it to CI and switch the workflows over:
   ```sh
   gh secret set EDGE_DEPLOY_SSH_KEY -R statewalker/httpeers < edge_deploy
   gh variable set EDGE_DEPLOY_FORCED -R statewalker/httpeers --body true
   rm edge_deploy edge_deploy.pub
   ```
   `DEPLOY_KNOWN_HOSTS` (already set for the LLM appliance) pins the server's host key.
6. Run `relay` and `sites` once by hand (Actions → the workflow → Run workflow) and check both
   deploy jobs end with `DEPLOYED`.
7. Remove the old unrestricted key: its line in `~/.ssh/authorized_keys`, and the
   `DEPLOY_SSH_KEY` secret (`gh secret delete DEPLOY_SSH_KEY -R statewalker/httpeers`).

## Why it is the way it is

- **A key that can only name a commit.** A plain SSH key for a `docker`-group user is root on the
  host. This key runs `deploy.sh` whatever the client sends, and the script accepts
  `deploy relay|sites <40-hex sha>` and `status` only. The worst a stolen key can do is put an
  image this repository's CI already built back into service.
- **Images pinned by commit, not `:latest`.** The server runs the exact image CI built for the
  commit it deployed, and "the previous image" is a definite thing to roll back to.
- **Deploys only after CI.** `relay.yml`, `sites.yml` and `llm-appliance.yml` run the shared CI
  first; a commit that fails it is neither published nor deployed.
- **Checks on the server, output without logs.** The relay must report the same peerId as before
  (it is in every address clients dial) and advertise a `/dns4/` address, never a container
  address; sites must answer HTTP. The script prints status lines only: the Actions log of this
  repository is public.
- **Caddy and rustfs are not deployed from here.** Restarting the TLS terminator or the storage is
  left to a person.

## What will surprise you

| You see | It means |
|---|---|
| `DEPLOY FAILED: the relay's peerId CHANGED: … (was the relay_key volume lost?)` | the relay started with a new identity; the script rolled back, but restore the `httpeers_relay_key` volume before anything else restarts the relay |
| `DEPLOY FAILED: cannot pull ghcr.io/statewalker/httpeers-relay:sha-…` | the image for that commit was not published (the publish job failed or was skipped) |
| `ROLLBACK ALSO FAILED -- relay needs a human` | the previous image does not verify either; look at `docker compose logs relay` on the server |
| `DEPLOY FAILED: another deploy holds the lock` | a deploy has run for 10 minutes; the lock is `<DEPLOY_PATH>/.deploy.lock` |
| `Permission denied (publickey)` in the deploy job | `EDGE_DEPLOY_FORCED` is `true` but the key is missing from `authorized_keys`, or the secret holds a different key |

## Reference

| Command (over SSH, or `bin/deploy.sh …` on the server) | Effect |
|---|---|
| `deploy relay <sha>` / `deploy sites <sha>` | run, verify, or roll back that commit's image |
| `status` | services, their images and states |

| GitHub setting | Purpose |
|---|---|
| secret `EDGE_DEPLOY_SSH_KEY` | the forced-command key |
| variable `EDGE_DEPLOY_FORCED=true` | deploy through `deploy.sh` (otherwise the workflows pull `:latest` with `DEPLOY_SSH_KEY`) |
| variable `DEPLOY_KNOWN_HOSTS` | the server's host key |
| secrets `DEPLOY_HOST`, `DEPLOY_USER` | where to connect |
