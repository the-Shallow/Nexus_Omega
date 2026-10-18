#!/usr/bin/env bash
# Record the host environment (GPU, driver, Docker, CUDA) before bring-up.
set -uo pipefail
cd "$(dirname "$0")/.."
mkdir -p artifacts/env
out="artifacts/env/host-$(date +%Y%m%dT%H%M%S).txt"
{
  echo "## nvidia-smi";        nvidia-smi
  echo "## nvidia-smi topo";   nvidia-smi topo -m
  echo "## docker version";    docker version
  echo "## docker gpu test";   docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi -L
  echo "## uname";             uname -a
  echo "## cpu / mem / disk";  nproc; free -g; df -h /
  echo "## sudo";              sudo -n true 2>/dev/null && echo "SUDO_OK" || echo "NO_PASSWORDLESS_SUDO"
} 2>&1 | tee "$out"
echo "saved to $out"
