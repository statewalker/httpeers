#!/usr/bin/env python3
"""A userland network emulator between two network namespaces (#56 step 2).

Not run in CI. Needs root, iproute2 and /dev/net/tun. Linux only.

WHY NOT `tc netem`: the kernel this was written on has no sch_netem (and no
loadable modules), so the link is emulated here instead, at the IP layer, which
keeps what matters about netem: real packets, real loss, the kernel's own TCP
(congestion control, retransmission timeouts, SACK) and real UDP for WebRTC.

    ns A (10.77.0.1, tun "nemA")  <-- this process -->  ns B (10.77.0.2, tun "nemB")

Every IP packet one namespace sends to the other is read from one TUN device
and written to the other after, per direction:

  1. a bandwidth limit: the packet occupies the "wire" for len*8/rate seconds,
     after whatever is queued ahead of it (a FIFO, the bottleneck queue);
  2. a queue limit (--queue-ms of wire time): a packet arriving at a fuller
     queue is dropped (tail drop -- the congestion loss a real bottleneck has);
  3. random loss: each packet independently with probability --loss;
  4. propagation delay: --delay-ms one way, plus jitter: a delay offset drawn
     uniformly from [-jitter, +jitter] every --jitter-slot-ms, applied to all
     packets in that slot. Packets are never reordered (a later packet is
     never delivered before an earlier one), unlike netem's default jitter;
     when the offset falls, packets bunch up instead.

Use: netem-tun.py --rate-mbit 50 --delay-ms 15 --loss 0.001 [--jitter-ms 0]
         [--queue-ms 100] [--mtu 1500] [--seed 1]
It creates namespaces `nemA` and `nemB`, prints "READY" on stdout once they
route, runs until SIGTERM/SIGINT or stdin closes, then deletes both
namespaces (which removes the TUN devices). Run commands in a namespace with
`ip netns exec nemA ...`. On exit it prints per-direction counters to stderr.
"""

import argparse
import collections
import fcntl
import os
import random
import select
import signal
import struct
import subprocess
import sys
import time

TUNSETIFF = 0x400454CA
IFF_TUN = 0x0001
IFF_NO_PI = 0x1000

NS = ("nemA", "nemB")
ADDR = ("10.77.0.1", "10.77.0.2")


def sh(*cmd, check=True):
    return subprocess.run(cmd, check=check, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)


def open_tun(name):
    fd = os.open("/dev/net/tun", os.O_RDWR | os.O_NONBLOCK)
    fcntl.ioctl(fd, TUNSETIFF, struct.pack("16sH", name.encode(), IFF_TUN | IFF_NO_PI))
    return fd


def teardown():
    for ns in NS:
        sh("ip", "netns", "del", ns, check=False)


class Direction:
    """One way of the link: bottleneck FIFO + loss + delay/jitter."""

    def __init__(self, name, out_fd, args, rng):
        self.name = name
        self.out_fd = out_fd
        self.bytes_per_s = args.rate_mbit * 1e6 / 8
        self.delay = args.delay_ms / 1000
        self.jitter = args.jitter_ms / 1000
        self.slot = args.jitter_slot_ms / 1000
        self.queue_s = args.queue_ms / 1000
        self.loss = args.loss
        self.rng = rng
        self.wire_free_at = 0.0  # when the bottleneck finishes what is queued
        self.last_deliver = 0.0
        self.slot_until = 0.0
        self.offset = 0.0
        self.pending = collections.deque()  # (deliver_at, packet), in order
        self.stats = collections.Counter()

    def admit(self, packet, now):
        self.stats["in"] += 1
        backlog = max(0.0, self.wire_free_at - now)
        if backlog > self.queue_s:
            self.stats["queue_drop"] += 1
            return
        self.wire_free_at = max(now, self.wire_free_at) + len(packet) / self.bytes_per_s
        if self.loss > 0 and self.rng.random() < self.loss:
            self.stats["random_drop"] += 1
            return
        if self.jitter > 0 and now >= self.slot_until:
            self.offset = self.rng.uniform(-self.jitter, self.jitter)
            self.slot_until = now + self.slot
        at = self.wire_free_at + self.delay + self.offset
        at = max(at, self.last_deliver)  # no reordering
        self.last_deliver = at
        self.pending.append((at, packet))

    def flush(self, now):
        q = self.pending
        while q and q[0][0] <= now:
            _, packet = q.popleft()
            try:
                os.write(self.out_fd, packet)
                self.stats["out"] += 1
            except BlockingIOError:
                self.stats["write_drop"] += 1

    def next_due(self):
        return self.pending[0][0] if self.pending else None


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--rate-mbit", type=float, required=True)
    p.add_argument("--delay-ms", type=float, required=True, help="one-way delay")
    p.add_argument("--jitter-ms", type=float, default=0.0)
    p.add_argument("--jitter-slot-ms", type=float, default=20.0)
    p.add_argument("--loss", type=float, default=0.0, help="per-packet probability, each way")
    p.add_argument("--queue-ms", type=float, default=100.0, help="bottleneck queue, in wire time")
    p.add_argument("--mtu", type=int, default=1500)
    p.add_argument("--cc", default="cubic", help="TCP congestion control in both namespaces")
    p.add_argument("--seed", type=int, default=1)
    args = p.parse_args()

    teardown()
    fds = []
    # A namespace may only pick an algorithm the root namespace allows; add
    # ours for the run and put the list back afterwards.
    allowed_path = "/proc/sys/net/ipv4/tcp_allowed_congestion_control"
    allowed = open(allowed_path).read().strip()
    if args.cc not in allowed.split():
        with open(allowed_path, "w") as f:
            f.write(f"{allowed} {args.cc}")
    try:
        for i, ns in enumerate(NS):
            sh("ip", "netns", "add", ns)
            fds.append(open_tun(ns))
            sh("ip", "link", "set", ns, "netns", ns)
            ex = ("ip", "netns", "exec", ns)
            sh(*ex, "ip", "link", "set", "lo", "up")
            sh(*ex, "ip", "link", "set", ns, "mtu", str(args.mtu), "up")
            sh(*ex, "ip", "addr", "add", ADDR[i], "peer", ADDR[1 - i], "dev", ns)
            sh(*ex, "sysctl", "-q", "-w", f"net.ipv4.tcp_congestion_control={args.cc}")
        rng = random.Random(args.seed)
        dirs = {
            fds[0]: Direction("A->B", fds[1], args, rng),
            fds[1]: Direction("B->A", fds[0], args, rng),
        }
        stop = []
        signal.signal(signal.SIGTERM, lambda *_: stop.append(1))
        signal.signal(signal.SIGINT, lambda *_: stop.append(1))
        print("READY", flush=True)
        watch = [fds[0], fds[1], sys.stdin.fileno()]
        while not stop:
            now = time.monotonic()
            dues = [d for d in (x.next_due() for x in dirs.values()) if d is not None]
            timeout = max(0.0, min(dues) - now) if dues else 0.5
            try:
                readable, _, _ = select.select(watch, [], [], timeout)
            except InterruptedError:
                continue
            now = time.monotonic()
            for fd in readable:
                if fd == watch[2]:
                    if not os.read(fd, 4096):
                        stop.append(1)
                    continue
                d = dirs[fd]
                for _ in range(256):
                    try:
                        packet = os.read(fd, 65536)
                    except BlockingIOError:
                        break
                    d.admit(packet, now)
            now = time.monotonic()
            for d in dirs.values():
                d.flush(now)
        for d in dirs.values():
            print(f"netem-tun {d.name}: {dict(d.stats)}", file=sys.stderr)
    finally:
        for fd in fds:
            os.close(fd)
        teardown()
        with open(allowed_path, "w") as f:
            f.write(allowed)


if __name__ == "__main__":
    main()
