# Brev host

The whole stack runs on one Brev GPU machine. This page says what's on it, where things live, and what not to break. Last checked 2026-10-17.

## The machine

| | |
|---|---|
| Instance name | `nexus-omega` (Brev ID `3xqkvp16i`) |
| Hardware | 1× NVIDIA H100 PCIe 80 GB, 28 CPUs, 180 GB RAM, x86_64 |
| Provider | Hyperstack, Montreal, $3.00/hr while running |
| Login user | `shadeform` (home is `/home/shadeform`) |

## Getting in

You need to be in Samarth's Brev org; ask to be invited. Then:

```bash
brev login
brev refresh                      # writes the nexus-omega entry into ~/.ssh/config
ssh nexus-omega                   # or: brev shell nexus-omega
brev exec nexus-omega "nvidia-smi"   # one-off command without opening a shell
```

If `ssh nexus-omega` hangs or is refused, the instance is probably stopped or still booting (check `brev ls`), or your SSH config is stale (`brev refresh` fixes it).

None of the service ports are open to the internet. To use them from your laptop, tunnel them over SSH:

```bash
ssh -N -L 8100:localhost:8100 -L 8101:localhost:8101 -L 9090:localhost:9090 nexus-omega
```

Then `http://localhost:8100` on your laptop is the gateway, and so on.

## Two disks, and where things go

The machine has two disks. Brev's UI shows "850 GB", but that's the two added together, not one big space.

| Mount | Size | Survives a Stop? | Use it for |
|---|---|---|---|
| `/` | 97 GB | Yes | The OS. Don't put data here. |
| `/ephemeral` | 738 GB | **No, assume it's wiped** | Models, caches, checkouts, run logs |

Where things live:

| Path | What it is |
|---|---|
| `/ephemeral/work/Nexus_Omega/` | **The checkout the running stack uses.** Compose, profiles and scripts are run from here. |
| `/ephemeral/work/*.log` | Bring-up and gate logs (`bringup.log`, `gate1-noauto.log`, `lightning.log`, `qwen.log`, `pull.log`) |
| `/ephemeral/hf/hub/` | Hugging Face model cache (~28 GB): Qwen3-4B and Nemotron-3.5-Lightning-30B-A3B-NVFP4 |
| `~/.cache` | A link to `/ephemeral/cache` (pip and uv caches) |
| `~/workspace/Nexus_Omega/` | A second, older clone. It isn't used by anything running. |
| `~/.venv/` | The Python environment Brev set up |

Because `/ephemeral` may be wiped, **push anything you change on the box**. A checkout that exists only there can disappear.

### Why the root disk is half full

About 57 GB of the 97 GB is used, and most of it is not ours:

- **~33 GB of Docker images** in `/var/lib/containerd`. Docker's config points its data at `/ephemeral/docker`, but this Docker hands image storage to containerd, and containerd keeps its own store on the root disk. The vLLM image alone is 30.8 GB. This is a one-time cost per image.
- **~14 GB** of OS, CUDA and drivers in `/usr`, plus a few GB in `/opt` and Brev's monitoring.
- **~5 GB of system logs.** Brev's `grafana-agent` logs at debug level and writes about 3 MB a minute. The journal is already at its 4 GB cap and syslog rotates daily, so this should level off around 13 GB at most.

So it's fine for now, with ~41 GB free. Pulling another large image (a second vLLM version, a Red Hat build) will eat into that. If space gets tight:

```bash
sudo journalctl --vacuum-size=200M     # frees ~4 GB, no downtime
docker image prune                     # removes images no container uses
```

## What's running

| Container | Port | What it is | Started by |
|---|---|---|---|
| `nexus-a` | 8101 | vLLM v0.27.1 target worker serving `Qwen/Qwen3-4B` as `qwen3-4b` (15% of GPU memory, 8k context, hermes tool parser) | `python3 -m nexus.target.manager up a qwen3-4b.healthy --port 8101` |
| `nexus-gateway-1` | 8100 | Team gateway (`apps/gateway`) in front of the workers | `runtime/compose/docker-compose.yml` |
| `nexus-prometheus-1` | 9090 | Prometheus | same compose file |
| `nexus-dcgm-exporter-1` | 9400 | GPU telemetry | same compose file |

Grafana, grafana-agent and telegraf also run directly on the host. Those belong to Brev, not to us.

The Nemotron Lightning model has been downloaded, but **nothing is serving it right now**. Only the Qwen target is up, using ~14 GB of the 80 GB of GPU memory.

## Bringing it up and running Gate 1

> The runtime code below (`runtime/`, `scripts/bring_up.sh`, `scripts/gate1.sh`, `nexus/target/`, `apps/gateway/`) is not on `main` yet. It lives on Samarth's `samE2` branch and in the Brev checkout.

From the checkout the stack runs out of:

```bash
cd /ephemeral/work/Nexus_Omega
scripts/bring_up.sh                    # compose infra + one healthy worker "a" on :8101
python3 -m nexus.target.manager status
scripts/gate1.sh                       # healthy canary → inject fault → canary fails → rollback → passes
```

The target manager also does `apply`, `rollback`, `down`, and `command`, which prints the `docker run` line without running it. Start workers one at a time, because vLLM can misjudge free GPU memory when two start together.

## Please don't

- **Press Stop or Delete in Brev without telling the team.** Stopping takes everything offline and can wipe `/ephemeral`, which means every model and checkout listed above.
- **Restart Docker or containerd while someone is running a gate.** It drops every container.
- **Pull large images casually.** They land on the 97 GB root disk, not on `/ephemeral`.
