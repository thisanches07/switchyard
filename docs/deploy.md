# Deploying Switchyard (operator runbook)

This runbook takes you from an Oracle Cloud account to a public HTTPS demo of Switchyard on one
Always Free Ampere (ARM) VM, provisioned with Terraform ([ADR-0012](adr/0012-deploy-oracle-always-free.md),
[spec 013](specs/013-deploy/spec.md)). It also covers releases, upgrades, rollback and teardown.

> **Status of this runbook.** Everything up to the VM is verified in CI without a cloud
> account: the images build for amd64 and arm64, the production Compose file runs behind Caddy
> with HTTPS, the demo key's limits are enforced, Terraform passes `fmt`/`validate`/`test` with
> a mocked provider and the cloud-init passes `cloud-init schema`. Steps marked
> **⚠ Not yet run against a real account** have not been executed against Oracle Cloud yet.
> Whoever runs them first should remove the marker (or fix the step) in the same pull request.

## What gets deployed

```
Internet ──► 80/443 (security list) ──► VM ──► Caddy (TLS) ──► gateway ──► Postgres, Redis, Redpanda
                                         │                        └─► usage worker, otel-lgtm (Grafana)
operator_cidr ──► 22 (SSH, key only) ────┘   admin API and Grafana: SSH tunnel only
```

- **Terraform** (`deploy/terraform/`): VCN, internet gateway, route table, one public subnet, a
  security list allowing only TCP 80/443 from anywhere and TCP 22 from your `operator_cidr`, and
  one `VM.Standard.A1.Flex` instance (2 OCPUs, 12 GB, 50 GB boot volume by default).
- **cloud-init** (`deploy/terraform/cloud-init.yaml.tftpl`): Docker Engine + Compose plugin,
  automatic security updates, key-only SSH, the production Compose bundle in `/opt/switchyard`
  and a systemd unit that starts the stack once `/etc/switchyard/switchyard.env` exists.
- **Production Compose** (`deploy/compose/`): published images
  `ghcr.io/thisanches07/switchyard-{gateway,worker}:<version>`, Caddy terminating TLS, and the
  stack's dependencies. Only Caddy publishes host ports (80, 443).

No secret goes through Terraform variables, Terraform state or instance metadata: OCI
credentials stay in `~/.oci/config` on your machine, and the app's secrets live only in the env
file you copy to the VM over SSH.

## 1. Prerequisites

- **An Oracle Cloud account** (Free Tier). Caveats from ADR-0012:
  - Oracle asks for a **credit card at signup** (identity check). Always Free resources are not
    charged, but anything outside the allowance is, if you upgrade the account. Set a budget
    alert (step 11).
  - **Ampere A1 capacity is sometimes unavailable** in a region ("Out of host capacity"). See
    [step 13](#13-if-always-free-arm-capacity-is-unavailable).
  - Always Free compute must be created in your **home region**, chosen at signup.
  - Always Free allowance (Oracle docs, checked 2026-10-13): Ampere A1 1,500 OCPU hours and 9,000
    GB hours per month (2 OCPUs and 12 GB), 200 GB of block storage including boot volumes, 10 TB
    of outbound data per month. Oracle may reclaim Always Free instances that stay idle (CPU,
    network and memory under 20 % for 7 days). The Terraform validations keep the VM within
    2 OCPUs / 12 GB / 200 GB; re-check Oracle's page before changing them.
- **An OCI API key** for your user, in `~/.oci/config` (Console → *My profile* → *API keys* →
  *Add API key*, then paste the generated config snippet). Terraform's provider reads it; the
  profile name is `oci_config_profile` (default `DEFAULT`).
- **Terraform 1.16.x** (`terraform version`; `deploy/terraform/versions.tf` pins
  `>= 1.16.5, < 1.17.0` and the `oracle/oci` provider `9.8.0`).
- **An SSH key pair** (`ssh-keygen -t ed25519`). Only the public key goes to Terraform.
- **Node.js 24 and pnpm** on your machine, for `pnpm demo:key` (a clone of this repository with
  `pnpm install`).
- Your public IP (`curl -s https://ifconfig.me`), for `operator_cidr`.

## 2. Configure Terraform

```sh
cd deploy/terraform
cp terraform.tfvars.example terraform.tfvars   # git-ignored; never commit it
```

Edit `terraform.tfvars`: `region` (your home region), `compartment_ocid` (the tenancy OCID for
the root compartment, or a compartment you created), `operator_cidr` (your IP as a `/32`;
`0.0.0.0/0` is rejected), `ssh_public_key`. `switchyard_version` selects the Compose bundle the
VM downloads on first boot (default: the current release).

## 3. `terraform init`, `plan`, `apply`

**⚠ Not yet run against a real account.**

```sh
terraform init          # uses the committed .terraform.lock.hcl
terraform plan -out demo.tfplan
terraform apply demo.tfplan
terraform output        # public_ip, ssh_command, demo_hostname, tunnel_command
```

State stays local (`terraform.tfstate`, git-ignored). It holds no app secret, but it does hold
your OCIDs and IP: keep it private and back it up if you want to manage the VM later.

cloud-init takes a few minutes after `apply` (package upgrade, Docker install). Check progress:

```sh
ssh ubuntu@<public_ip> 'cloud-init status --wait && systemctl status switchyard.path --no-pager'
```

## 4. Hostname for TLS

Caddy obtains a Let's Encrypt certificate automatically for `SWITCHYARD_HOSTNAME`, which must
resolve to the VM's public IP and have ports 80 and 443 reachable.

- **Default, no domain needed:** `terraform output -raw demo_hostname`, e.g.
  `203-0-113-10.sslip.io` ([sslip.io](https://sslip.io) answers DNS for any IP embedded in the
  name). Let's Encrypt rate limits apply per registered domain, and `sslip.io` is shared with
  other users, so issuance can occasionally be delayed; a custom domain avoids that.
- **Custom domain:** create an `A` record pointing to the public IP and use that name.

## 5. Provide the environment file over SSH

**⚠ Not yet run against a real account.**

Create the env file on your machine from `deploy/compose/switchyard.env.example`, outside the
repository (or under a git-ignored name; `*.env` is ignored). Generate each secret with
`openssl rand -hex 32` and set `SWITCHYARD_HOSTNAME` and `SWITCHYARD_VERSION`:

```sh
cp deploy/compose/switchyard.env.example ~/switchyard.env
# edit ~/switchyard.env: replace every replace-me value, set the hostname

scp ~/switchyard.env ubuntu@<public_ip>:/tmp/switchyard.env
ssh ubuntu@<public_ip> 'sudo install -m 600 -o root -g root /tmp/switchyard.env /etc/switchyard/switchyard.env && rm /tmp/switchyard.env'
```

The `switchyard.path` unit notices the file and runs `docker compose up -d --wait` (first start
pulls the images, a few minutes). Missing secrets stop Compose; the dev defaults of
`docker-compose.yml` and the `replace-me` placeholders stop the gateway
(`SWITCHYARD_REQUIRE_SECRETS`). Back up `KEY_PEPPER` with the database: losing it invalidates
every API key.

```sh
ssh ubuntu@<public_ip> 'sudo systemctl status switchyard --no-pager; cd /opt/switchyard && sudo docker compose ps'
```

## 6. Check health

**⚠ Not yet run against a real account.**

```sh
curl -s https://<hostname>/healthz          # {"status":"ok"}
curl -sI http://<hostname>/healthz          # 308 redirect to https://
curl -s https://<hostname>/admin/teams      # 404: the admin API is not public
```

`/readyz` (Postgres and Redis checks) is public too: `curl -s https://<hostname>/readyz`.

## 7. Admin API and dashboards through an SSH tunnel

Only Caddy publishes host ports. The gateway and Grafana have fixed addresses on the Compose
network (`172.30.0.10:8080` and `172.30.0.20:3000`), reachable from the VM, so an SSH tunnel
exposes them on your machine only:

```sh
ssh -N -L 8080:172.30.0.10:8080 -L 3000:172.30.0.20:3000 ubuntu@<public_ip>
# admin API:  http://localhost:8080/admin/...   (Authorization: Bearer $ADMIN_TOKEN)
# Grafana:    http://localhost:3000             (dashboards from spec 011)
```

Grafana Cloud's free tier is an alternative for telemetry: point `OTEL_EXPORTER_OTLP_ENDPOINT`
at it in `compose.yml` and drop the `lgtm` service.

## 8. Create the demo key

**⚠ Not yet run against a real account** (the same script runs in CI against the production
Compose file).

With the tunnel from step 7 open, from your clone of the repository:

```sh
SWITCHYARD_ADMIN_URL=http://localhost:8080 ADMIN_TOKEN=<your admin token> pnpm demo:key
```

It creates the team `demo` and a key that may only use the `demo` alias, with a **hard** monthly
budget (`--budget-usd`, default `1`, spec 007), strict limits (`--rpm 10 --tpm 20000`, spec 005),
and prints the key **once** on stdout. Running it again keeps the key and updates its limits;
`--rotate` revokes it and prints a new one. The demo serves free models only: `demo` maps to
`mock/demo` by default (synthetic prices, so the budget visibly accrues).

### Serving a local model (optional)

```sh
ssh ubuntu@<public_ip>
cd /opt/switchyard
echo 'COMPOSE_PROFILES=ollama' | sudo tee -a /etc/switchyard/switchyard.env
sudo systemctl restart switchyard
sudo docker compose --env-file /etc/switchyard/switchyard.env exec ollama ollama pull llama3.2:1b
sudo sed -i 's#candidates: \[mock/demo\]#candidates: [ollama/llama3.2:1b, mock/demo]#' config/switchyard.yaml
```

The gateway hot-reloads the config (spec 008). CPU inference on 2 Ampere cores is slow; keep the
model small. Hosted free tiers (Groq, Gemini) need your own keys in the env file and
provider-side spending limits; never put a paid key on the public demo without a hard cap
(ADR-0012).

## 9. Upgrade to a new release

**⚠ Not yet run against a real account.**

```sh
ssh ubuntu@<public_ip>
sudo switchyard-fetch 0.2.0                                  # new compose.yml and Caddyfile
sudo sed -i 's/^SWITCHYARD_VERSION=.*/SWITCHYARD_VERSION=0.2.0/' /etc/switchyard/switchyard.env
sudo systemctl restart switchyard                            # pulls the new images, migrates
```

`switchyard-fetch` keeps your `config/` files; compare them with the new release's
`deploy/compose/config/` and the CHANGELOG. Changing `switchyard_version` in Terraform does
**not** touch a running VM (cloud-init only runs on first boot, and the instance ignores
`user_data` changes so it is never replaced by accident).

## 10. Roll back

**⚠ Not yet run against a real account.**

Run step 9 with the previous version. Database migrations only move forward: if the newer
version ran a migration the older one does not understand, restore the Postgres volume from a
backup taken before the upgrade
(`sudo docker compose --env-file /etc/switchyard/switchyard.env exec postgres pg_dump -U switchyard switchyard > backup.sql`).

## 11. Set a billing alert

**⚠ Not yet run against a real account.**

Console → *Billing & Cost Management* → *Budgets* → *Create budget* for the tenancy (for example
1 USD per month) with an alert rule at 1 % of actual spend to your email. Always Free resources
cost nothing, so any alert means something outside the allowance was created.

## 12. Tear down

**⚠ Not yet run against a real account.**

```sh
cd deploy/terraform
terraform destroy
```

This deletes the VM and its boot volume (all data) and the network. Revoke the OCI API key if
you no longer need it.

## 13. If Always Free ARM capacity is unavailable

`terraform apply` fails with `Out of host capacity` when the region has no free Ampere capacity.

1. Retry later (capacity frees up over hours or days), or try another availability domain
   (`availability_domain_number = 2` or `3`, where the region has them).
2. Temporarily use a smaller shape (`ocpus = 1`, `memory_in_gbs = 6`); the stack fits in about
   4 GB at idle.
3. If capacity stays unavailable, choose a fallback (another provider's VM or the managed free
   tiers of ADR-0012's option 2) and record it in **ADR-0022**, which supersedes ADR-0012. The
   production Compose file and the images are provider-agnostic: any Docker host with ports
   80/443 works.

## Releases (maintainers)

1. Update `CHANGELOG.md`: move the `Unreleased` entries into `## [X.Y.Z] - YYYY-MM-DD` (Keep a
   Changelog) and set `package.json#version` to `X.Y.Z`. CI's `release-preflight` job checks
   that the next tag would pass.
2. Optionally run the **Release** workflow by hand (*Actions → Release → Run workflow*): a dry
   run that checks and builds both images for amd64 and arm64 without pushing or releasing.
3. Tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`. The workflow fails before pushing
   anything if the tag does not match `package.json` or the changelog section is missing; then
   it pushes `ghcr.io/thisanches07/switchyard-{gateway,worker}` with tags `X.Y.Z`, `X.Y` and
   `latest` (only `X.Y.Z` for pre-releases such as `v0.2.0-rc.1`), with OCI labels and, when
   available, SBOM and provenance attestations, then creates the GitHub Release with the
   changelog section as notes.
4. First release only: GHCR packages start **private**. Make both packages public (*Package
   settings → Change visibility*) so the VM and other users can pull without logging in.

## Regenerating the Terraform lock file

After changing the provider version in `versions.tf`:

```sh
cd deploy/terraform
terraform providers lock -platform=linux_amd64 -platform=linux_arm64 \
  -platform=darwin_amd64 -platform=darwin_arm64 -platform=windows_amd64
```

Without a local Terraform, the same command runs in Docker:
`docker run --rm -v "$PWD:/work" -w /work hashicorp/terraform:1.16.5 providers lock -platform=...`.

## What CI checks (no credentials)

| Check | Workflow job |
|---|---|
| Both images build for `linux/amd64` and `linux/arm64` (no push) | `deploy.yml` › `images-multiarch` |
| amd64 images in the dev stack: `/healthz`, `/readyz`, worker started and topics created, usage counted | `deploy.yml` › `images-compose` |
| Production Compose: HTTPS on 443 through Caddy, 80 → HTTPS, no other host port, admin API not public, dev secrets refused, demo key limits and budget | `deploy.yml` › `prod-compose` |
| `terraform fmt -check`, `init -backend=false`, `validate`, `terraform test` (mocked provider) | `deploy.yml` › `terraform` |
| `cloud-init schema` on the rendered cloud-init | `deploy.yml` › `cloud-init` |
| The next tag would pass the release preflight | `deploy.yml` › `release-preflight` |
| No Terraform state, tfvars or env files tracked | `ci.yml` › `verify` |
