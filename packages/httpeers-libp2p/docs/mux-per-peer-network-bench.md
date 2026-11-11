# Mux per peer on an emulated network (#56, plan step 2)

Two exchange paths, measured across an emulated link with latency, a bandwidth
limit, a bottleneck queue and packet loss, over TCP and over WebRTC:

- **per-exchange**: one libp2p stream per HTTP exchange (the default);
- **mux**: `muxPerPeer`, every exchange a windowed port of one stream per
  peer, with the default 256 KiB window and with a 4 MiB window.

**This is an emulation on one machine, not a real network.** It is the best
measurement available without one. It says how the paths react to latency,
rate limits, queueing and loss. It does not say how a particular real
network, a browser's WebRTC stack or a NAT behaves. The last section lists
what still needs a real network, and the recommendation is for the
maintainer to decide.

## Summary

| Profile (TCP) | Bulk Mbit/s: per-exchange / mux 256K / mux 4M | Ping p50 under bulk, ms: per-exchange / mux 256K / mux 4M | 256 B exchanges/s at K=100: per-exchange / mux 256K |
|---|---|---|---|
| LAN, 1 Gbit, 1 ms | 956 / 688 / 953 | 43 / **6** / 47 | 1104 / 1153 |
| Broadband, 50 Mbit, 30 ms, no loss | 48 / 47 / 48 | 958 / **79** / 862 | 805 / 519 |
| Broadband, 50 Mbit, 30 ms, 0.1% loss | 14 / 12 / 14 | 346 / **222** / 455 | 743 / 379 |
| Mobile, 10 Mbit, 80±10 ms, no loss | 9.8 / 9.4 / 9.6 | 4845 / **394** / 1968 | 452 / 228 |
| Mobile, 10 Mbit, 80±10 ms, 1% loss | 1.3 / 1.4 / 1.5 | 1915 / 2447 / 3087 | 169 / 58 |
| Long fat pipe, 100 Mbit, 100 ms, no loss | 96 / **18** / 96 | 485 / **205** / 516 | 439 / 305 |
| Bad, 2 Mbit, 200 ms, 3% loss | every run fails on both paths with the defaults (see "The connection dies"); with the monitor not aborting (all three columns): 0.4 / 0.3 / 0.4 | 7687 / 9117 / 10621 (n = 3–7 samples) | 38 / 16 |

Exchange rates are from the corrected rerun (see Method). Ping samples under
bulk: 42–200 per cell on the faster profiles, 5–13 on mobile, 3–7 on bad.

What the numbers say:

1. **The mux's latency isolation holds on a real-shaped link, but only while
   its window is about one bandwidth-delay product (BDP).** With the default
   256 KiB window, a ping (or a 64 KiB GET) beside a bulk download answers
   within a few round trips of its idle time on LAN, broadband and mobile
   links without loss (6, 79 and 394 ms), where the per-exchange path waits
   0.04 s, 1 s and 4.8 s behind the download. A 4 MiB window loses most of
   that isolation: with that many bytes in flight the bottleneck queue and
   the sender's buffers fill just as on the per-exchange path.
2. **A fixed window in bytes is the wrong unit.** 256 KiB is 2 ms of a 1 Gbit
   link (LAN: bulk capped at 72%) and 21 ms at 100 Mbit (long fat pipe: 18 of
   96 Mbit/s), but 1.5 s at the 1.4 Mbit/s TCP manages on the lossy mobile
   link, where the mux's pings wait 2.4 s, longer than the per-exchange
   path's 1.9 s (and on the bad link 9.1 s at 256 KiB and 10.6 s at 4 MiB,
   against 7.7 s).
   A window that tracks the BDP would get full throughput where 256 KiB caps
   it and keep the isolation where 256 KiB is already too much. Recommended
   below.
3. **Random loss decides throughput on both paths alike.** With CUBIC, 0.1%
   loss caps a 30 ms path near 14 Mbit/s and 1% caps an 80 ms path near
   1.4 Mbit/s, whichever path carries the bytes (both ride one TCP
   connection). Neither path can do anything about it.
4. **Each exchange costs two round trips on both paths**, so small-exchange
   rate at K=1 is about 1/(2 RTT) on both. A diagnostic on a 100 ms RTT link
   without loss: on the mux the response head arrives after 104 ms and the
   body after 208 ms (the window handshake: until the caller has answered it,
   the serving side sends each piece as a call the caller must confirm). On
   the per-exchange path the head itself arrives after 207 ms; libp2p's
   multistream negotiation is the likely second round trip, but passing
   `negotiateFully: false` through `dialProtocol` did not change it, so that
   is not established. A 1-RTT exchange looks available to the mux if the
   caller's window travels with the port open. Not changed here.
5. **At high concurrency on a long path the mux is slower for small
   exchanges**: at K=100 it does 34–69% of the per-exchange rate on every
   profile with RTT ≥ 30 ms, i.e. the per-exchange path is 1.4–2.9× faster
   (worst on the lossy links: 2.9× on lossy mobile, 2.4× on bad). On LAN
   the two are within noise. At K=1 and K=10 they are about equal. A lead,
   not a root cause: the mux completes the K=100 exchanges in lock-step
   rounds. In a diagnostic on a 100 ms link (100 exchanges started at once,
   3 rounds), the heads arrived over 290–322 ms but every body arrived
   together at 335–336 ms, after the last head; on the per-exchange path
   heads and bodies arrived together, spread over 224–297 ms. So on the mux
   a round is as slow as its slowest exchange plus a further step, which
   fits the per-exchange window handshake (point 4) or serialised delivery
   on the serving side, and a loss that stalls one exchange holds back the
   whole round.
6. **On a slow, lossy link the connection dies under a bulk download, on both
   paths**: libp2p's connection monitor pings every 10 s with a 5 s minimum
   timeout and aborts the whole connection when the ping is stuck behind the
   download. Details and a suggested change below.
7. **WebRTC**: the mux works over a Node↔Node data channel on every profile at
   256 KiB; the per-exchange path, which opens a data channel per exchange,
   failed in most runs. See the WebRTC section.

## Method

### The link

The VM's kernel has no `sch_netem` (no `CONFIG_NET_SCH_NETEM`, no loadable
modules), so `tc qdisc ... netem` is unavailable. TUN devices and network
namespaces are available, so the link is emulated in userland at the IP layer
by [`scripts/netem-tun.py`](../scripts/netem-tun.py):

```
ns nemA (10.77.0.1, TUN)  <--  netem-tun.py  -->  ns nemB (10.77.0.2, TUN)
```

Every IP packet between the two namespaces passes the emulator, which applies
per direction: a rate limit (a FIFO bottleneck, serialisation at
`len × 8 / rate`), a bottleneck queue of fixed depth in milliseconds of wire
time with tail drop, independent random loss per packet, and a one-way delay
with jitter. Because these are real packets, the kernel's own TCP (CUBIC,
SACK, retransmission timeouts) sees real loss and real queueing, and
WebRTC's UDP sees real drops: no "loss as stall" approximation was needed.

Differences from netem worth knowing:

- Jitter is a delay offset drawn uniformly from ±jitter every 20 ms and
  applied to all packets in that slot. Packets are never reordered (netem's
  default jitter reorders).
- The emulator adds about 0.2 ms each way (a raw TCP echo across the LAN
  profile measured 1.44 ms instead of 1.0 ms). Negligible except on LAN.
- It is a Python process, and on this 4-vCPU VM it shares the CPUs with both
  benchmark processes. It forwarded 965 Mbit/s of raw TCP in calibration, so
  it is not the bottleneck on any profile; the LAN profile's numbers carry
  more CPU contention than the others.
- Both namespaces use CUBIC (the VM's default is BBR; CUBIC is what most
  clients run). `netem-tun.py` adds `cubic` to the root namespace's
  `tcp_allowed_congestion_control` for the run and restores it afterwards,
  and deletes both namespaces on exit.
- Offloads are off on TUN and the MTU is 1500, so TCP sees ordinary segments.

Calibration, raw Python TCP: on 50 Mbit / 30 ms / 0.1% loss, RTT 30.8 ms and
15.1 Mbit/s, which is the Mathis estimate for CUBIC at that loss
(MSS / RTT × 1.22 / √p ≈ 14.9 Mbit/s). On 1 Gbit / 1 ms, 965 Mbit/s.

### The benchmark

[`scripts/bench-mux-net.mjs`](../scripts/bench-mux-net.mjs) starts the link,
runs the caller in `nemA` and the serving process in `nemB` (Noise, yamux,
as httpeers runs them), with a fresh process pair and connection per run.
Per run:

- ping p50/p99 idle: sequential 64 B GETs;
- 256 B POST exchanges/s with K = 1, 10, 100 concurrent callers;
- a 64 KiB GET idle: time to first body byte and to the whole body;
- bulk alone: one endless response read as fast as it arrives, measured after
  a warm-up;
- with that bulk download still running: ping p50/p99, and 64 KiB GET time to
  first byte and to the whole body (p50/p99).

Durations and sample counts shrink on slow profiles (e.g. 4 s of bulk on LAN,
15 s on the bad profile). Each cell is the median over runs: 3 runs for the
four requested profiles, 2 for the three added ones (`broadband-noloss`,
`mobile-noloss`, `longfat`; with two runs the cell is the higher of the
two values, since the median takes the upper middle one: the worse for a
latency, the better for a rate). The per-exchange path is measured once per
profile (the mux window does not apply to it).

Percentiles: "p99" is the sample at index ⌊0.99 n⌋, so with n ≤ 100 samples
it is the slowest sample (the maximum). Each TCP table gives the number of
samples taken under bulk (pings are sent one after another until a count or
a time cap is reached, so slow cases have few: 3–7 on the bad link).

**The 256 B exchange rates (K = 1 / 10 / 100) come from a rerun.** The
first run counted exchanges still in flight at the deadline, which complete
after it, but divided by the nominal duration: an upward bias of up to one
round of K, largest for the mux at K = 100, whose 100 exchanges complete in
lock-step rounds (its first-run cells were exact multiples of 100 ÷
seconds). The rate is now completed exchanges over the actual elapsed time,
and the rows marked "rerun" were measured again with only that case
(`--cases small`), 3 runs each on all seven profiles. Every other row is from
the first run. The WebRTC rates were rerun the same way.

For WebRTC the serving process also runs a circuit relay (signalling only);
the caller dials `/p2p-circuit/webrtc` through it, checks the resulting
connection is `/webrtc` and closes the relayed one, so the data channel runs
directly between 10.77.0.1 and 10.77.0.2 over UDP through the emulator. No
STUN/TURN servers (host candidates suffice).

Rerun (root, Linux, iproute2, python3):

```
pnpm --filter @statewalker/httpeers-libp2p build
node packages/httpeers-libp2p/scripts/bench-mux-net.mjs --profiles lan,broadband,mobile,bad --runs 3
node packages/httpeers-libp2p/scripts/bench-mux-net.mjs --profiles longfat,broadband-noloss,mobile-noloss --runs 2
node packages/httpeers-libp2p/scripts/bench-mux-net.mjs --transport webrtc --runs 3
node packages/httpeers-libp2p/scripts/bench-mux-net.mjs --profiles bad --keep-on-ping-failure
# the exchange-rate rerun
node packages/httpeers-libp2p/scripts/bench-mux-net.mjs --cases small --profiles lan,broadband,mobile,bad,broadband-noloss,mobile-noloss,longfat
node packages/httpeers-libp2p/scripts/bench-mux-net.mjs --cases small --transport webrtc
```

The full set here took about four hours (including the exchange-rate rerun), most of it the slow profiles.

## Results: TCP

Profiles: rate, round-trip time, random loss per packet each way, bottleneck
queue depth. "Under bulk" means while one other exchange on the same
connection downloads as fast as it can.

### LAN: 1 Gbit/s, RTT 1 ms, no loss, 5 ms queue (3 runs)

| | per-exchange | mux 256 KiB | mux 4096 KiB |
|---|---|---|---|
| Bulk alone (Mbit/s) | 956.2 | 688.0 | 953.4 |
| Ping p50 / p99 idle (ms) | 6.2 / 10.8 | 6.5 / 14.5 | 5.9 / 12.6 |
| Ping p50 / p99 under bulk (ms) | 43.0 / 58.9 | 6.1 / 10.7 | 46.5 / 68.1 |
| 256 B exchanges/s, K = 1 / 10 / 100 (rerun, see note) | 158 / 682 / 1104 | 157 / 693 / 1153 | 160 / 668 / 1128 |
| 64 KiB GET idle, first byte / whole p50 (ms) | 6.2 / 6.2 | 5.9 / 6.3 | 5.7 / 6.2 |
| 64 KiB GET under bulk, first byte p50 / p99 (ms) | 42.5 / 53.0 | 6.0 / 10.5 | 44.8 / 58.4 |
| 64 KiB GET under bulk, whole p50 / p99 (ms) | 42.9 / 53.7 | 6.2 / 11.3 | 45.8 / 59.3 |
| Samples under bulk: pings / 64 KiB GETs (median over runs) | 186 / 40 | 200 / 40 | 174 / 40 |

The idle ping (6 ms) is mostly software: the same ping on loopback takes
3.3 ms; the link adds two round trips.

### Broadband without loss: 50 Mbit/s, RTT 30 ms, 100 ms queue (2 runs)

| | per-exchange | mux 256 KiB | mux 4096 KiB |
|---|---|---|---|
| Bulk alone (Mbit/s) | 48.1 | 47.0 | 47.8 |
| Ping p50 / p99 idle (ms) | 66.3 / 72.7 | 65.9 / 630.6 | 65.8 / 70.7 |
| Ping p50 / p99 under bulk (ms) | 958.3 / 1067.8 | 78.5 / 83.9 | 862.3 / 910.3 |
| 256 B exchanges/s, K = 1 / 10 / 100 (rerun, see note) | 15 / 151 / 805 | 15 / 125 / 519 | 15 / 125 / 521 |
| 64 KiB GET idle, first byte / whole p50 (ms) | 76.0 / 76.0 | 75.5 / 76.6 | 75.2 / 76.0 |
| 64 KiB GET under bulk, first byte p50 / p99 (ms) | 947.4 / 1176.3 | 89.6 / 130.9 | 860.4 / 986.7 |
| 64 KiB GET under bulk, whole p50 / p99 (ms) | 958.6 / 1187.4 | 91.7 / 131.3 | 893.2 / 998.1 |
| Samples under bulk: pings / 64 KiB GETs (median over runs) | 17 / 17 | 100 / 20 | 20 / 19 |

The clearest case for the mux at the default window: the same throughput,
and a request beside the download answers in 79–92 ms instead of about a
second. The per-exchange path's second is more than the 100 ms bottleneck
queue: the rest is the serving side's socket buffer and yamux windows (which
grow to 16 MiB) holding data ahead of the ping. (The mux 256 KiB idle p99 of
630 ms is one slow sample in one of the two runs, reported because two-run
cells take the higher value.)

### Broadband: 50 Mbit/s, RTT 30 ms, 0.1% loss, 100 ms queue (3 runs)

| | per-exchange | mux 256 KiB | mux 4096 KiB |
|---|---|---|---|
| Bulk alone (Mbit/s) | 13.8 | 11.9 | 13.6 |
| Ping p50 / p99 idle (ms) | 66.4 / 139.2 | 65.9 / 97.4 | 66.0 / 125.0 |
| Ping p50 / p99 under bulk (ms) | 345.7 / 674.7 | 222.2 / 522.2 | 454.7 / 1009.7 |
| 256 B exchanges/s, K = 1 / 10 / 100 (rerun, see note) | 13 / 79 / 743 | 15 / 120 / 379 | 15 / 113 / 386 |
| 64 KiB GET idle, first byte / whole p50 (ms) | 125.8 / 125.9 | 96.1 / 97.0 | 98.6 / 99.3 |
| 64 KiB GET under bulk, first byte p50 / p99 (ms) | 282.6 / 555.3 | 311.8 / 462.4 | 484.7 / 1000.8 |
| 64 KiB GET under bulk, whole p50 / p99 (ms) | 322.6 / 592.4 | 325.7 / 475.6 | 527.0 / 1095.2 |
| Samples under bulk: pings / 64 KiB GETs (median over runs) | 55 / 20 | 82 / 20 | 42 / 20 |

Loss holds TCP near 14 Mbit/s and makes every number noisier. A lost segment
stalls the whole connection until it is retransmitted (head-of-line blocking
in TCP itself), which the mux cannot avoid any more than the per-exchange
path: the isolation shrinks to 222 vs 346 ms for pings and disappears for the
64 KiB GET.

### Mobile without loss: 10 Mbit/s, RTT 80 ms ± 10 ms, 200 ms queue (2 runs)

| | per-exchange | mux 256 KiB | mux 4096 KiB |
|---|---|---|---|
| Bulk alone (Mbit/s) | 9.8 | 9.4 | 9.6 |
| Ping p50 / p99 idle (ms) | 168.3 / 191.3 | 169.5 / 195.9 | 168.3 / 190.4 |
| Ping p50 / p99 under bulk (ms) | 4845.4 / 5315.8 | 393.5 / 443.5 | 1968.1 / 2177.7 |
| 256 B exchanges/s, K = 1 / 10 / 100 (rerun, see note) | 6 / 53 / 452 | 6 / 49 / 228 | 6 / 50 / 225 |
| 64 KiB GET idle, first byte / whole p50 (ms) | 230.0 / 230.1 | 228.4 / 232.2 | 226.6 / 230.5 |
| 64 KiB GET under bulk, first byte p50 / p99 (ms) | 5847.7 / 5866.2 | 452.4 / 523.5 | 1887.2 / 2160.2 |
| 64 KiB GET under bulk, whole p50 / p99 (ms) | 5866.3 / 5903.3 | 455.9 / 667.3 | 1984.9 / 2160.9 |
| Samples under bulk: pings / 64 KiB GETs (median over runs) | 5 / 5 | 52 / 12 | 11 / 11 |

On the per-exchange path a request beside a download waits about 5 s: close
to the connection monitor's 5 s ping timeout and to the 8 s
`DEFAULT_REQUEST_TIMEOUT_MS` (see "The connection dies"). The mux at 256 KiB
keeps it under 0.5 s; even at 4 MiB it is 2 s, because 4 MiB is 3.4 s of
this link and only part of it is in flight at once.

### Mobile: 10 Mbit/s, RTT 80 ms ± 10 ms, 1% loss, 200 ms queue (3 runs)

| | per-exchange | mux 256 KiB | mux 4096 KiB |
|---|---|---|---|
| Bulk alone (Mbit/s) | 1.3 | 1.4 | 1.5 |
| Ping p50 / p99 idle (ms) | 272.7 / 680.5 | 259.2 / 496.4 | 248.5 / 635.0 |
| Ping p50 / p99 under bulk (ms) | 1914.6 / 3282.6 | 2447.1 / 3727.4 | 3086.9 / 4472.4 |
| 256 B exchanges/s, K = 1 / 10 / 100 (rerun, see note) | 3 / 20 / 169 | 3 / 22 / 58 | 3 / 22 / 61 |
| 64 KiB GET idle, first byte / whole p50 (ms) | 769.8 / 769.8 | 573.9 / 574.3 | 396.1 / 399.5 |
| 64 KiB GET under bulk, first byte p50 / p99 (ms) | 1735.7 / 3339.0 | 2389.9 / 3500.3 | 2767.4 / 3890.6 |
| 64 KiB GET under bulk, whole p50 / p99 (ms) | 2421.8 / 4085.3 | 2745.6 / 3829.6 | 3150.4 / 4293.4 |
| Samples under bulk: pings / 64 KiB GETs (median over runs) | 13 / 11 | 11 / 9 | 8 / 8 |

1% random loss is harsh for TCP (real cellular links hide most radio loss
with link-layer retransmission, so this is closer to a poor Wi-Fi or a
congested path): TCP gets 1.4 of 10 Mbit/s. At that rate the 256 KiB window is
1.5 s of data, so the mux's pings wait behind it longer than the
per-exchange path's do (2.4 s against 1.9 s). This is the case for sizing the window in time rather than bytes.

### Long fat pipe: 100 Mbit/s, RTT 100 ms, no loss, 50 ms queue (2 runs)

| | per-exchange | mux 256 KiB | mux 4096 KiB |
|---|---|---|---|
| Bulk alone (Mbit/s) | 96.3 | 18.3 | 95.6 |
| Ping p50 / p99 idle (ms) | 207.1 / 215.4 | 206.8 / 216.3 | 207.0 / 212.9 |
| Ping p50 / p99 under bulk (ms) | 484.7 / 625.5 | 205.1 / 215.7 | 515.5 / 716.6 |
| 256 B exchanges/s, K = 1 / 10 / 100 (rerun, see note) | 5 / 46 / 439 | 5 / 45 / 305 | 5 / 45 / 298 |
| 64 KiB GET idle, first byte / whole p50 (ms) | 211.6 / 211.7 | 212.2 / 213.1 | 210.9 / 211.8 |
| 64 KiB GET under bulk, first byte p50 / p99 (ms) | 479.1 / 696.7 | 209.3 / 211.3 | 594.9 / 686.5 |
| 64 KiB GET under bulk, whole p50 / p99 (ms) | 484.9 / 702.4 | 209.9 / 212.6 | 603.2 / 690.1 |
| Samples under bulk: pings / 64 KiB GETs (median over runs) | 42 / 16 | 60 / 16 | 38 / 16 |

BDP 1.25 MB: one 256 KiB window per RTT is 21 Mbit/s, and the mux delivers
18. A 4 MiB window fills the link.

### Bad: 2 Mbit/s, RTT 200 ms, 3% loss, 500 ms queue

With httpeers' defaults, every run on both paths failed (3 of 3 each): the
connection was aborted under the bulk download (see "The connection dies").
Measured again with libp2p's connection monitor told not to abort the
connection (`--keep-on-ping-failure`; 3 runs):

| | per-exchange | mux 256 KiB | mux 4096 KiB |
|---|---|---|---|
| Bulk alone (Mbit/s) | 0.4 | 0.3 | 0.4 |
| Ping p50 / p99 idle (ms) | 1216.1 / 2204.4 | 1070.7 / 1627.0 | 1065.8 / 1903.2 |
| Ping p50 / p99 under bulk (ms) | 7686.6 / 10699.7 | 9117.0 / 10197.1 | 10620.8 / 11274.0 |
| 256 B exchanges/s, K = 1 / 10 / 100 (rerun with default settings, see note) | 1 / 7 / 38 | 1 / 6 / 16 | 1 / 6 / 13 |
| 64 KiB GET idle, first byte / whole p50 (ms) | 3164.7 / 3164.8 | 2759.1 / 3139.8 | 2994.9 / 3146.3 |
| 64 KiB GET under bulk, first byte p50 / p99 (ms) | 6493.4 / 10909.7 | 8016.9 / 9420.0 | 8334.7 / 10018.4 |
| 64 KiB GET under bulk, whole p50 / p99 (ms) | 13253.0 / 14568.5 | 11329.9 / 12876.3 | 10152.1 / 12935.3 |
| Samples under bulk: pings / 64 KiB GETs (median over runs) | 7 / 3 | 4 / 3 | 3 / 3 |
| Runs that completed | 2 of 3 | 3 of 3 | 3 of 3 |

The per-exchange column comes from the 2 runs that completed. The third
hit the 8 s `DEFAULT_REQUEST_TIMEOUT_MS` on a 64 KiB GET beside the download
and is excluded, and with two runs each cell is the higher value (see
Method), so its latencies are the worse of the two and its rates the better.
All three columns used `--keep-on-ping-failure` except the exchange-rate
row, which was rerun with httpeers' defaults (no download runs during that
phase, so the connection monitor does not come into it). At 3% loss TCP gets 0.3–0.4 of 2 Mbit/s and
everything beside a download waits 7–13 s on every path. Neither path is
usable for interactive traffic beside a bulk transfer on a link like this;
256 KiB is about 6 s of data at this rate. Only a window sized in time would
help the mux here.

## Window sizing

| Profile | BDP (rate × RTT) | 256 KiB in time at the achieved rate | Does 256 KiB cap bulk? |
|---|---|---|---|
| LAN 1 Gbit, 1 ms | 125 KB (≈ 375 KB at the ~3 ms the software adds) | 2 ms | yes: 688 of 956 Mbit/s |
| Broadband 50 Mbit, 30 ms | 188 KB | 42 ms | no (47 of 48 without loss; loss-bound with it) |
| Mobile 10 Mbit, 80 ms | 100 KB | 0.2 s (no loss), 1.5 s (1% loss) | no; it is too large instead |
| Long fat 100 Mbit, 100 ms | 1.25 MB | 21 ms | yes: 18 of 96 Mbit/s |
| Bad 2 Mbit, 200 ms | 50 KB | 1 s at 2 Mbit, ~7 s at 0.3 Mbit | no; far too large |

The mux's isolation comes from data that is NOT yet in flight: it schedules
fairly between ports what it has not handed to the stream, and a port can have
at most one window in flight. Everything in flight (the sender's socket
buffer, the bottleneck queue) is FIFO for every port alike. So the window is
a direct trade: one window per RTT is the bulk ceiling, and one window of
queue at the achieved rate is roughly the delay it can add to everyone else.
The right window is about one BDP: large enough to fill the path, no larger.
256 KiB is about right for 50 Mbit × 30 ms and 10 Mbit × 80 ms, too small for
anything above about 1 Gbit × 2 ms or 100 Mbit × 20 ms, and too large once
loss or a slow link brings the achieved rate under ~2 Mbit/s.

**Recommendation (for the maintainer): an adaptive per-port window rather
than a larger fixed default.** A larger fixed default (4 MiB) restores
throughput on fat pipes but gives back most of the latency isolation
everywhere (4 MiB rows above), which is the reason to have the mux at all.
An adaptive window could follow yamux's own scheme (the per-exchange path
already gets it: a stream window starts at 256 KiB and doubles when a full
window is consumed within 4 RTTs, up to 16 MiB), with two changes: grow only
while the delivery rate still rises (stop when a bigger window only adds
delay, as BBR does), and shrink when the RTT measured under load climbs well
above the idle RTT. The mux already measures round trips (keepalive), and
`maxReassembledBytes` would have to follow the window. Until then the
current 256 KiB default is the better fixed choice for the traffic httpeers
mostly carries (small HTTP beside occasional large bodies) wherever the BDP
is at most about 256 KiB: one window per round trip caps a bulk transfer at
about 2.1 Mbit ÷ RTT in seconds (e.g. 70 Mbit/s at 30 ms, 21 Mbit/s at
100 ms). `window` remains a per-deployment override above that.

## WebRTC (Node ↔ Node, node-datachannel)

Feasible with the same emulation: the data channel's UDP crosses the
emulator, with real drops. Same measurements, 3 runs each. The exchange
rates are from the rerun with only that case (see Method); there, the
per-exchange path completed more often than in the full runs, because no
other phase could fail first: every one of its failed rerun runs failed at
K=10 (data channel error events, a reset, 8 s request timeouts).

| Profile | | per-exchange | mux 256 KiB | mux 4096 KiB |
|---|---|---|---|---|
| LAN | Bulk alone (Mbit/s) | 634 (1 of 3 runs) | 361 | 615 |
| | Ping p50 under bulk (ms) | 108 | 11 | 74 |
| | 256 B exchanges/s K = 1 / 10 / 100 (rerun) | 117 / 357 / 402 (1 of 3 runs) | 136 / 611 / 1105 | 133 / 594 / 1040 |
| | 64 KiB GET under bulk, whole p50 (ms) | 112 | 12 | 76 |
| Broadband (0.1% loss) | Bulk alone (Mbit/s) | all runs failed | 10.5 | 9.8 |
| | Ping p50 / p99 under bulk (ms) | | 338 / 747 | 3826 / 5462 |
| | 256 B exchanges/s K = 1 / 10 / 100 (rerun) | 10 / 72 / 278 (2 of 3 runs) | 15 / 90 / 333 | 14 / 71 / 353 |
| Mobile (1% loss) | Bulk alone (Mbit/s) | all runs failed | 1.5 | all runs failed |
| | Ping p50 / p99 under bulk (ms) | | 2583 / 3788 | |
| | 256 B exchanges/s K = 1 / 10 / 100 (rerun) | 4 / 24 / 65 (2 of 3 runs) | 5 / 26 / 74 | 5 / 27 / 88 |
| Bad (3% loss) | Bulk alone (Mbit/s) | all runs failed | 0.3 | all runs failed |
| | Ping p50 under bulk (ms) | | 13136 | |
| | 256 B exchanges/s K = 1 / 10 / 100 (rerun) | 1 / 8 / 21 (2 of 3 runs) | 2 / 6 / 16 | 2 / 6 / 18 |

A follow-up of the per-exchange path alone, with the failing phase recorded
(3 runs each):

| | LAN | Broadband without loss |
|---|---|---|
| Runs that completed | 1 of 3 | 3 of 3 |
| Failures | `call to peer ... failed: [object Event]` (a data channel's error event) during the K=10 and the K=100 small-exchange phases | none |
| Bulk alone (Mbit/s) | 611 | 45.9 |
| Ping p50 idle / under bulk (ms) | 8.1 / 101 | 97 / 1108 |
| 256 B exchanges/s K = 1 / 10 / 100 | 117 / 357 / 402 (rerun) | 10 / 77 / 362 (first-run counting, overstated by up to one round of K) |
| 64 KiB GET idle, whole p50 (ms) | 10.9 | 163 |

So without loss the per-exchange path over WebRTC can complete, but at an
idle-ping cost of about three round trips instead of two (opening a data
channel per exchange adds one) and it still fails when many channels open
at once on a fast link.

What this shows:

- **The mux path works over WebRTC on every profile at 256 KiB**, including
  the bad one, where the TCP connection dies (the libp2p ping runs on its own
  data channel, which SCTP probably schedules beside the mux's rather than
  behind it, so the connection monitor's ping gets through; not verified).
- With 4 MiB the mux fails under bulk on the lossy mobile and bad links
  (`stream ended before the call finished` while fetching beside the
  download): with seconds of data queued ahead, requests probably hit the
  8 s request timeout or the serving side's 15 s drain timeout (the error
  does not say which).
- **The per-exchange path over WebRTC is fragile**: it opens one data channel
  per exchange, and runs failed with data-channel errors (`[object Event]`
  from the channel's error event) on LAN, streams reset on lossy broadband,
  and on lossy mobile `sniff: stream ended before any bytes arrived` while
  10 exchanges ran at once and 8 s request timeouts on idle pings. Without
  loss it completed on broadband (3 of 3), but at about three round trips
  per exchange; at K=100 its small-exchange rate was 36% of the mux's on
  LAN and 83–88% on lossy broadband and mobile (ahead of the mux only on
  the bad link, 21 vs 16). Not root-caused here; it looks like per-channel setup
  cost and failure under loss in libp2p's WebRTC transport or
  node-datachannel rather than anything in httpeers.
- WebRTC bulk is slower than TCP at the same link (per-exchange on LAN 634
  vs 956 Mbit/s; mux 256 KiB on LAN 361 vs 688, on lossy broadband 10.5 vs
  11.9), as expected from SCTP over userland DTLS.

Browser WebRTC (Chrome/Firefox's own SCTP stacks) and NAT traversal are not
covered: they need a browser on a real network.

## The connection dies under bulk on slow links (both paths)

On the bad profile every TCP run failed. With `DEBUG=libp2p:connection-monitor*`:

```
libp2p:connection-monitor:error error during heartbeat - TimeoutError: The operation was aborted due to timeout
libp2p:connection-monitor:error aborting connection due to ping failure
run failed in "64 KiB GETs under bulk": request to peer ... timed out after 8000ms
```

libp2p 3's connection monitor (on by default; `createNode` does not
configure it) pings every connection every 10 s with a timeout of
max(5 s, 1.2 × average ping time) and, by default
(`abortConnectionOnPingFailure: true`), aborts the whole connection when a
ping times out. Its ping is a new stream on the same TCP connection, so under
a bulk download it waits behind everything the serving side has already
buffered. Once that is more than ~5 s of data at the achieved rate, the
connection is torn down and every exchange on it fails, on either path. The
lossy mobile profile came within reach of it (p99 ping under bulk 4.5 s), and
so did the per-exchange path on mobile without loss (4.8–5.3 s).

Measured with the monitor told not to abort (`--keep-on-ping-failure`, which
builds the same node with `connectionMonitor: { abortConnectionOnPingFailure:
false }`), the bad profile's numbers are in its section above.

**Suggested change (not made here; a library behaviour decision):** pass a
`connectionMonitor` option from `createNode`: either
`abortConnectionOnPingFailure: false` (httpeers already bounds requests with
`requestTimeoutMs`, and the mux has its own keepalive), or a ping timeout
floor well above the worst queueing delay expected (e.g.
`pingTimeout: { minTimeout: 30_000 }`). On the mux path an adaptive window
also removes most of the cause (less data queued ahead of the ping).

## Recommendation for plan step 3 (for the maintainer to decide)

| Traffic class | Recommended path | Why |
|---|---|---|
| Sockets and tunnels (duplex, long-lived, often interactive beside other traffic) | mux, once the window adapts; until then mux at 256 KiB where the link's BDP is at most about 256 KiB (bulk is capped at about 2.1 Mbit ÷ RTT in seconds) | The isolation is the point: a request beside a download stays within a few round trips of idle on the mux (79 ms on broadband, 394 ms on mobile, no loss) and waits 1–5 s on the per-exchange path. (Measured with HTTP exchanges; duplex tunnels were not measured separately.) One stream per peer also removes the per-protocol stream caps a tunnel-heavy peer runs into. |
| Small HTTP (API calls, tokens, presence) | either; mux preferred when the same peer also moves large bodies | Equal at K=1 and about equal at K=10 (2 RTT each on both paths). The per-exchange path is 1.4–2.9× faster at K=100 on links with RTT ≥ 30 ms (worst with loss; a mux issue worth fixing); on LAN the two are within noise, and on WebRTC the mux is ahead except on the bad link. What decides it in practice is the 2nd point: small requests beside a large body. |
| Large bodies (downloads, uploads, media) | per-exchange today; mux only with an adaptive window | A fixed 256 KiB window caps bulk on LAN and fat pipes (72% and 19%); 4 MiB removes the cap but also most of the isolation, so no fixed window serves both. |
| WebRTC links | mux at 256 KiB | The per-exchange path failed in most WebRTC runs (a data channel per exchange); the mux at 256 KiB ran on every profile, while at 4 MiB it failed beside a download on the lossy mobile and bad links. |

Changes this suggests, independent of the decision:

1. Make the mux's per-port window adaptive (target about one BDP; see "Window
   sizing").
2. Send the caller's window with the port open, so the serving side can
   pipeline at once and an exchange takes one round trip instead of two on
   the mux.
3. Find why the mux falls behind at K=100 on long paths (start from the
   lock-step rounds in summary point 5).
4. Configure libp2p's connection monitor in `createNode` (see above): today a
   single large download over a slow, lossy link kills the connection on
   both paths.

## Raw data

The `--out` JSON of the runs the tables come from is in [`data/`](data/)
(not part of the published package, which ships `dist` and `src` only):

| File | Tables |
|---|---|
| `tcp-requested-profiles.json` | LAN, broadband, mobile, bad (all runs failed) |
| `tcp-extra-profiles.json` | broadband and mobile without loss, long fat pipe |
| `tcp-bad-keep-on-ping-failure.json` | bad with `--keep-on-ping-failure` |
| `webrtc.json` | WebRTC, all four profiles |
| `tcp-exchange-rates-rerun.json`, `webrtc-exchange-rates-rerun.json` | the exchange-rate rows (rerun) |

The first four hold per-profile medians only (per-run values were not kept
then; the rerun files have them under `raw`), and their exchange rates are
the overstated first-run ones the tables no longer use. The per-exchange
WebRTC follow-up (LAN and broadband without loss), the `DEBUG` confirmation
run and the round-trip diagnostics were not saved as JSON; their numbers are
only in this document.

## What still needs a real network

- Real links (Wi-Fi, LTE/5G with their link-layer retransmission and
  variable rate, transcontinental paths) instead of a FIFO with independent
  loss; in particular whether the 1% / 3% loss cases are as bad as here.
- Browser WebRTC (its own SCTP and DTLS stacks) and NAT traversal; only
  Node ↔ Node with node-datachannel was measured.
- Machines that do not share CPUs: here both peers and the emulator shared
  four vCPUs, which mostly matters for the LAN numbers.
- BBR senders (many servers run BBR; this used CUBIC on both ends).
