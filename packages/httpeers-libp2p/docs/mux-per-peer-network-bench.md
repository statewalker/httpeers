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

| Profile (TCP) | Bulk Mbit/s: per-exchange / mux 256K / mux 4M | Ping p50 under bulk, ms: per-exchange / mux 256K / mux 4M | 256 B exchanges/s at K=100: per-exchange / mux 256K, at first → after the round-trip fixes → after gathering chunks |
|---|---|---|---|
| LAN, 1 Gbit, 1 ms | 956 / 688 / 953 | 43 / **6 → 4** / 47 | 1364 / 1153 → 1690 → **3060** |
| Broadband, 50 Mbit, 30 ms, no loss | 48 / 47 / 48 | 958 / **79 → 40** / 862 | 1006 / 519 → 1186 → **1928** |
| Broadband, 50 Mbit, 30 ms, 0.1% loss | 14 / 12 / 14 | 346 / **222** / 455 | 712 / 379 → 893 → **1380** |
| Mobile, 10 Mbit, 80±10 ms, no loss | 9.8 / 9.4 / 9.6 | 4845 / **394 → 196** / 1968 | 451 / 228 → 604 → **865** |
| Mobile, 10 Mbit, 80±10 ms, 1% loss | 1.3 / 1.4 / 1.5 | 1915 / 2447 / 3087 | 148 / 58 → 85 (109) → **241** |
| Long fat pipe, 100 Mbit, 100 ms, no loss | 96 / **18** / 96 | 485 / **205 → 103** / 516 | 451 / 305 → 693 → **829** |
| Bad, 2 Mbit, 200 ms, 3% loss | every run fails on both paths with the defaults (see "The connection dies"); with the monitor not aborting (all three columns): 0.4 / 0.3 / 0.4 | 7687 / 9117 / 10621 (n = 3–7 samples) | 38 / 16 → 20 (25) → **40** |

The three mux values are before the two fixes in "One round trip, and no
lock-step", after them, and after the two fixes in "Lossy links at K=100:
bytes per exchange, and batches decrypted whole" (both sections below);
in brackets, the mux after the round-trip fixes measured again in the same
session as "after gathering chunks". The per-exchange rates are from that
last session too (the per-exchange path did not change; the earlier sessions
gave 1016–1104, 801–805, 704–743, 449–452, 158–169, 435–439 and 36–38).
Pings under bulk were measured again after the fixes on the profiles without
loss only (mux 256 KiB); every other cell is from before them. Exchange rates are completed exchanges
over the elapsed time (see Method). Ping samples under bulk vary widely, from
3 to 200 per cell (3–7 on bad); each profile's table gives them in its
"Samples under bulk" row.

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
4. **An exchange on the mux now takes one round trip; on the per-exchange
   path it takes two.** Measured first: two on both paths, so the rate at
   K=1 was about 1/(2 RTT) on both. On a 100 ms link the mux's response
   head came after 104 ms and its body after 208 ms: the window handshake.
   Fixed in httpeers (see "One round trip, and no lock-step"): a ping on
   that link now takes 104 ms on the mux, head and body together, and a
   256 B POST as long; the K=1 rate doubled on every profile. On the
   per-exchange path the head itself arrives after 207 ms; libp2p's
   multistream negotiation is the likely second round trip, but passing
   `negotiateFully: false` through `dialProtocol` did not change it, so that
   is not established.
5. **At high concurrency the mux is now ahead on every profile.** Measured
   first: at K=100 the mux did 34–69% of the per-exchange rate on every
   profile with RTT ≥ 30 ms. Two causes, both fixed (see "One round trip,
   and no lock-step"): the handshake's extra round trip, and frames gathered
   until the end of a task, which kept the K exchanges in lock-step rounds.
   That made it 1.3–1.7× the per-exchange rate on the links without loss,
   but on the 1% and 3% loss links it still did only about half (85 vs 158,
   20 vs 36). Two more causes there, both fixed (see "Lossy links at
   K=100"): every piece the HTTP codec writes went as a message of its own,
   so a 256 B exchange took about 1.4 times the per-exchange path's bytes on
   the wire, which is what counts where TCP's window is the limit; and
   batches of up to 64 KB, which the far side can decrypt only once all of
   it is in, delivered the exchanges in bursts. Now the mux does 1.6× the
   per-exchange rate at K=100 with 1% loss (241 vs 148), the same with 3%
   (40 vs 38), and 1.8–2.2× on the other profiles.
6. **On a slow, lossy link the connection dies under a bulk download, on both
   paths**: libp2p's connection monitor pings every 10 s with a 5 s minimum
   timeout and aborts the whole connection when the ping is stuck behind the
   download. Details and a suggested change below.
7. **WebRTC**: the mux works over a Node↔Node data channel on every profile at
   256 KiB; the per-exchange path, which opens a data channel per exchange,
   failed in most runs. See the WebRTC section.

## One round trip, and no lock-step (after the measurements above)

Two mux costs from points 4 and 5, root-caused and fixed in httpeers. Both
were measured again with the same emulated link and script (`--cases
ping,small,blob`, all seven profiles, 3 runs each; and `--cases bulk` on the
three profiles without loss, 1 run, mux 256 KiB only).

**1. The window handshake cost a round trip in each direction.**
webrun-rpc's `multiplexPort` (0.10) agrees each port's window in three
steps: the caller's `open` (window, exact sizing, capabilities), the serving
side's zero-byte `credit` ack, and the caller's zero-byte `credit` answer to
the ack. Until an end has seen the other's step, `duplexOverPort` sends each
chunk as a call that the peer confirms only once its consumer has read past
it, and only then as plain ("pipelined") messages held back by the window.
So the serving side pipelined only 1.5 round trips after the port opened: a
GET's head went as a call and its body waited for the head's confirmation
(head at 1 RTT, body at 2). And the caller pipelined only once the ack came
back, one round trip in: a POST's end (`done`) waited for its first chunk's
confirmation, so a handler that reads the body to its end answered after
two round trips.

Fix (`src/mux-presumed-ack.ts`): when the caller posts an `open`, it hands
its own mux, in the same turn, the ack the serving side will send. The mux
then answers at once, right behind the `open`, and pipelines its own chunks
from the start; the serving side receives the answer before the request, so
it pipelines its response from the start too. Nothing new goes on the wire:
the answer is the same envelope, sent earlier, and a serving peer of either
version reads it as before, so old and new peers interoperate in both
directions. What the caller presumes (exact sizing; the `pipeline` and
`end` capabilities) is what every build that has served
`/httpeers/1.0.0/mux` acks, since all of them run webrun-rpc 0.10 with the
msgpack codec. It is checked: if the real ack says otherwise, the caller
closes the mux (its exchanges fail with `PeerStreamResetError`), and the
next mux on that connection presumes nothing and runs the full handshake.
One cost: a caller no longer waits for its first chunk's confirmation, so on
a port the serving side refuses it may send up to one window of request body
(256 KiB by default; about 246 KB measured) before the refusal reaches it,
which the serving side drops without buffering. Because the mux's keepalive counts anything it reads
as a sign of life, the presumed acks would keep it content with a frozen
peer as long as calls keep opening ports; the module runs the same check on
what really arrives and closes the mux after three silent intervals.

The clean fix belongs in webrun-rpc, and needs no presumption: a responder
may enforce the window as soon as an `open` lists `caps` (only a version
that reads credit lists them), which saves the serving side's round trip on
the wire alone; and an opener may pipeline before the ack where the
protocol is known to be windowed (an option of `multiplexPort`), which
saves the caller's. With both upstream, `mux-presumed-ack.ts` can go.

**2. A burst of answers left as one write after the last of them.**
`mux-target.ts` gathers the frames posted in one task into one
`stream.send()` (one yamux frame, one Noise message, one socket write; #85).
But a burst of exchanges whose requests arrive in one read is served in one
task, its handlers running in microtasks, so all their answers left in one
write after the last one was produced. The caller's next requests then came
back as one burst too, and the burst never broke up: K exchanges in
lock-step rounds, each a round trip plus the whole burst's CPU on both
sides, where the per-exchange path writes each stream as it goes and its
exchanges drift apart. Fix: a gathered frame waits at most 1 ms within a
task; the next frame posted after that sends it. Back-to-back posts (bulk,
the pump) are still gathered.

Each fix alone, on the mux at 256 KiB (1 run each, K = 100): with only the
handshake fixed, 474/s on the long fat pipe, 730/s on broadband without
loss, 319/s on mobile without loss and 1244/s on LAN; with both, 687, 1330,
644 and 1870 in the same session. A 0.25 ms bound gave the same as 1 ms
within noise.

| Profile | Ping p50 idle (ms): per-exchange / mux before / mux after | 256 B exchanges/s K = 1 / 10 / 100: per-exchange / mux before / mux after | 64 KiB GET idle, whole p50 (ms): per-exchange / mux before / mux after |
|---|---|---|---|
| LAN | 6.2 / 6.5 / **3.9** | 170/694/1016 · 157/693/1153 · **256/1008/1690** | 5.9 / 6.3 / **4.5** |
| Broadband, 0.1% loss | 66.1 / 65.9 / **33.7** | 11/63/704 · 15/120/379 · **28/188/893** | 98.4 / 97.0 / **93.1** |
| Broadband, no loss | 65.8 / 65.9 / **33.7** | 15/151/801 · 15/125/519 · **29/259/1186** | 75.7 / 76.6 / **44.1** |
| Mobile, 1% loss | 275.3 / 259.2 / **95.8** | 2/21/**158** · 3/22/58 · **6/38**/85 | 586.7 / 574.3 / 597.8 |
| Mobile, no loss | 166.0 / 169.5 / **84.7** | 6/54/449 · 6/49/228 · **12/100/604** | 214.6 / 232.2 / **139.0** |
| Long fat pipe | 206.7 / 206.8 / **104.1** | 5/47/435 · 5/45/305 · **9/90/693** | 211.3 / 213.1 / **109.4** |
| Bad (3% loss) | 1012.4 / 1070.7 / **609.7** | 1/8/**36** · 1/6/16 · **2/14**/20 | 2597.0 / 3139.8 / **2290.8** |

"Per-exchange" and "mux after" are from the same session, 3 runs each;
"mux before" is the mux 256 KiB column of the profile tables below (the bad
profile's idle ping from its `--keep-on-ping-failure` run). The mux at
4 MiB moved the same way (in the raw data).

Beside a bulk download on the mux at 256 KiB (1 run): ping p50 39.5 ms on
broadband without loss (was 78.5), 198 ms on mobile without loss (was 394)
and 104 ms on the long fat pipe (was 205), and a 64 KiB GET whole p50 50.7,
255 and 110 ms (was 91.7, 456 and 210): one round trip where there were
two. Bulk throughput did not change (47.0, 9.4 and 18.4 Mbit/s). On
loopback (`scripts/bench-mux.mjs`, 3 runs), the mux's idle ping went from
2.79 to 2.07 ms and its small exchanges from 385/997/1333 to 506/1343/1906
per second at K = 1/10/100; its bulk throughput stayed within run-to-run
noise (139 vs 131 MB/s, while the unchanged per-exchange path read 237 vs
226).

**What remained: the lossy links at K=100.** With 1% and 3% loss the mux
still did about half the per-exchange rate at K=100 (85 vs 158, 20 vs 36),
though it was ahead at K=1 and K=10 there. Root-caused and fixed in the next
section.

The per-profile tables below are from before the fixes: their mux idle
pings, 256 B exchange rates and 64 KiB GET times are superseded by the
table above and the next section's.

## Lossy links at K=100: bytes per exchange, and batches decrypted whole

**Measured with** the same link and script, the small-exchange case only
(`--cases small`; `--ks 100` runs K=100 alone), mux 256 KiB. Diagnostics, on
the mobile profile with 1% loss at K=100: `ss -tin` sampled every 250 ms in
both namespaces, each exchange's start and end, and counters on libp2p's
Noise and yamux streams (sizes of what is encrypted and decrypted, yamux send
windows), mux streams accepted and connections opened.

**What it was not.** Each hypothesis checked against the evidence:

| Hypothesis | Evidence | Verdict |
|---|---|---|
| Head-of-line blocking where the per-exchange path has none | `ss` lists exactly one established TCP connection in each namespace throughout, on both paths; libp2p opened one connection per run, and the per-exchange path's streams are yamux streams on it | both paths share one connection; a loss stalls both alike |
| More loss, or more retransmits, on the mux | 7–14 retransmitted segments per side per run on both paths (12–18 per 1000 exchanges per-exchange, 9–17 before and 4–11 after on the mux) | the same loss on both; not the cause |
| The mux's window or credit | a 256 B exchange puts under 1 KB per direction on its port, against a 256 KiB window | a port never waits for credit here |
| The keepalive, the silence check, the stall watchdog, `drainTimeout` | every run completed (any failed exchange fails the run); one mux stream accepted per run, before and after, and one connection: no port or mux closed, no redial | none fired |
| Serial processing on one side | on loopback the mux did 1906 exchanges/s at K=100 before (3082 after): 15–20 times the lossy rates | CPU is not the limit at 100–250/s |
| Nagle, delayed ACKs | `@libp2p/tcp` sets `noDelay` on dialled and accepted sockets (it defaults to `true`); `ss` shows the sockets' unsent data packed into full segments, one per exchange or fewer, on both paths | not the difference |
| yamux windows | no yamux stream's send window ran out, on either path (measured on the fixed build): zero sends found it at 0, and the smallest capacity seen at a send was about 256 KiB; with TCP's window at 6–18 segments (under 30 KB in flight), a window of 256 KiB cannot bind | not the cause |

**What it was: bytes per exchange, where the congestion window is the
limit.** With 1% loss CUBIC keeps the window at 6–18 segments (`ss`), so the
link carries about one window per round trip and the exchange rate is that
over the bytes per exchange. Per 256 B exchange (K=100, mobile 1% loss, 3
runs each; TCP payload bytes and data segments from `ss`, caller → serving
side and back):

| | bytes, caller → serving side | bytes, back | data segments, each way | exchanges/s | Noise messages over 16 KiB per run | 100 ms intervals with no exchange completed |
|---|---|---|---|---|---|---|
| per-exchange | 847–873 | 789–809 | 0.95–1.11 | 139–150 | 0 | 12–20% |
| mux before | 1111–1124 | 997–1034 | 1.09–1.23 | 113–136 | 21–24 | 56–63% |
| mux after | 708–719 | 599–610 | 0.60–0.79 | 190–303 | 0–2 | 4–19% |

Two causes, each in httpeers:

1. **Every piece of the HTTP message was a message of its own.** The
   HTTP/1.1 codec (webrun-http-streams) yields a message in pieces: the head,
   then for each body chunk its size line, the chunk and a CRLF, then the
   last-chunk marker. A 256 B POST is five pieces, and its echo five more. On
   the per-exchange path each piece is a yamux frame (12 bytes of header) in
   a Noise message (18 more). On the mux each was a windowed
   `duplexOverPort` message with about 85 bytes of msgpack envelope
   (`{type: "message", id, payload: {type: "webrun-rpc:chunk", channelName,
   chunk: {done, value}}}`). On loopback, through a counting proxy, an
   exchange took 1200–1280 bytes towards the serving side and 1140–1210
   back on the mux, 855 and 800 on the per-exchange path.

   Fix (`src/chunk-gather.ts`): each direction of a mux exchange (the
   caller's request, the serving side's response) joins the pieces its
   producer writes back to back into one chunk, up to the chunk size the
   mux splits to: after each piece it keeps reading while the next is
   already on its way, and the first piece that is not there by the next
   task is read ahead and starts the next chunk. Nothing waits for data not
   yet being produced (a chunk leaves at most one task after its last
   piece). Only chunk boundaries move, which neither `duplexOverPort` nor
   the HTTP codec sees, so it is wire-compatible with every peer, old or
   new, in either role. Now 820 and 730 bytes on loopback: fewer than the
   per-exchange path. A `return()` (an exchange torn down) frees the
   consumer at once and is passed to the producer at once, but a producer
   with a read ahead pending (an SSE stream between events) runs it, and
   its cleanup, only once that read settles, at its next event.

   The same saving upstream would be the codec yielding a small message (or
   a body chunk with its framing) as one piece; on the per-exchange path
   that would save it about 30 bytes per piece too.

2. **Batches up to 64 KB, which the far side decrypts only whole.**
   `mux-target.ts` gathered frames posted in one task into one
   `stream.send()` of up to one Noise message (65519 bytes): one yamux frame,
   one Noise message. A Noise message is decrypted, and any frame in it read,
   only once all of it has arrived; at a window of about 10 segments a 64 KB
   message (45 segments) takes several round trips, and every frame in it,
   the first exchange's answer as much as the last's, was read together at
   the end of them. The far side then answered them together, and the
   exchanges moved in bursts, one direction at a time: in `ss`, 40–100 KB
   queued on one side while the other's queue was empty, alternating, and
   in more than half of the 100 ms intervals no exchange completed. The
   per-exchange path writes each stream's pieces as they come, so its Noise
   messages stayed under 400 bytes.

   Fix: the gathering limit is 16 KiB, about a round trip's worth of
   segments at such a window. The cost is in bulk: at the old limit two
   frames of the default size (31837 bytes each with their envelopes) shared
   a send, now each goes alone, so bulk takes up to twice the sends, yamux
   frames and Noise messages. Its throughput did not change measurably
   (below). Frames of 8–16 KiB, which went four to six to a send, now go one
   per send; that cost was not measured.

Each change alone, mobile 1% loss, K=100 only (`--ks 100`), exchanges/s,
median and range:

| | runs | mux | per-exchange (6 runs) |
|---|---|---|---|
| neither (before) | 6 | 117 (99–155) | 155 (139–178), same session |
| batches of up to 16 KiB only | 10 | 159 (97–184) | |
| pieces joined only | 10 | 165 (147–196) | |
| both (after) | 10 | 235 (205–300) | 154 (127–199), just before the 10-run rows |

With the pieces joined, the gathering limit made little difference at or
under 16 KiB (6 runs each, measured before the 10-run rows): 243 (218–278)
at 1.4 KB, 214 (179–258) at 4 KiB, 261 (189–302) at 16 KiB, against 174
(121–222) at 64 KB. Every number in this table and paragraph is under
`k100Only` in `tcp-gathered-chunks.json`.

**After both, 256 B exchanges/s at K = 1 / 10 / 100** (the lossy profiles 5
runs each, the others 3; the mux "before" on the lossy profiles is from the
same session, on the others it is "mux after" of the table in the previous
section):

| Profile | per-exchange | mux before | mux after |
|---|---|---|---|
| Mobile, 1% loss | 3 / 21 / 148 | 7 / 42 / 109 | **8 / 45 / 241** |
| Bad, 3% loss | 1 / 7 / 38 | 2 / 13 / 25 | **2 / 13 / 40** |
| LAN | 166 / 763 / 1364 | 256 / 1008 / 1690 | **271 / 1338 / 3060** |
| Broadband, 0.1% loss | 14 / 79 / 712 | 28 / 188 / 893 | **29 / 218 / 1380** |
| Broadband, no loss | 15 / 154 / 1006 | 29 / 259 / 1186 | **30 / 291 / 1928** |
| Mobile, no loss | 6 / 55 / 451 | 12 / 100 / 604 | **12 / 111 / 865** |
| Long fat pipe | 5 / 47 / 451 | 9 / 90 / 693 | **10 / 95 / 829** |

On the bad link the per-run spread is wide (mux after 38–57, per-exchange
35–52, mux before 18–34): the mux is now level with the per-exchange path
there, not clearly ahead.

No regression elsewhere. Beside a bulk download on the mux at 256 KiB (1
run each, before → after): bulk 688 (first measurement) → 682 Mbit/s on LAN, 47.0 → 47.0 on
broadband without loss, 9.4 → 9.4 on mobile without loss, 18.4 → 18.3 on
the long fat pipe; ping p50 under bulk 39.5 → 39.4, 198 → 196 and 104 → 103
ms (LAN 3.6 ms, last measured at 6.1 before the round-trip fixes); 64 KiB
GET under bulk, whole p50, 50.7 → 50.9, 255 → 266 and 110 → 108 ms. On
loopback (`scripts/bench-mux.mjs`, 3 runs), the mux's small exchanges went
from 506 / 1343 / 1906 to 601 / 1746 / 3082 per second at K = 1 / 10 / 100
(the per-exchange path: 393 / 908 / 1307), its idle ping was 1.69 ms
(per-exchange 2.51), and its bulk 141 MB/s (139 before; per-exchange 237).

Tests: `tests/chunk-gather.test.ts` (the codec's pieces joined into one
chunk, a later piece not waited for, the size bound, errors, `return()`
with a read ahead pending), `tests/mux-wire-bytes.test.ts` (bytes on the
wire per 256 B exchange on the mux, end to end over Noise and yamux,
against the per-exchange path), and `tests/mux-target.test.ts` (sends of at
most 16 KiB).

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
# the bad link again after the connection-monitor fix (createNode's defaults);
# everything above it ran before that fix, which `--libp2p-monitor` reproduces
node packages/httpeers-libp2p/scripts/bench-mux-net.mjs --profiles bad --runs 3
# the exchange-rate rerun
node packages/httpeers-libp2p/scripts/bench-mux-net.mjs --cases small --profiles lan,broadband,mobile,bad,broadband-noloss,mobile-noloss,longfat
node packages/httpeers-libp2p/scripts/bench-mux-net.mjs --cases small --transport webrtc
# the lossy links at K=100 (after gathering chunks)
node packages/httpeers-libp2p/scripts/bench-mux-net.mjs --cases small --profiles mobile,bad --windows 262144 --runs 5
node packages/httpeers-libp2p/scripts/bench-mux-net.mjs --cases small --profiles lan,broadband,broadband-noloss,mobile-noloss,longfat --windows 262144 --runs 3
node packages/httpeers-libp2p/scripts/bench-mux-net.mjs --cases bulk --profiles lan,broadband-noloss,mobile-noloss,longfat --windows 262144 --paths mux --runs 1
node packages/httpeers-libp2p/scripts/bench-mux-net.mjs --cases small --ks 100 --profiles mobile --windows 262144 --paths mux --runs 10
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

With libp2p's connection monitor at its defaults (what `createNode` installed
until the fix in "The connection dies"), every run on both paths failed (3 of
3 each): the connection was aborted under the bulk download. With
`createNode`'s defaults since that fix, 3 runs:

| | per-exchange | mux 256 KiB | mux 4096 KiB |
|---|---|---|---|
| Bulk alone (Mbit/s) | 0.3 | 0.4 | 0.4 |
| Ping p50 / p99 idle (ms) | 1011.8 / 1710.6 | 607.4 / 1234.6 | 607.3 / 1091.5 |
| Ping p50 / p99 under bulk (ms) | 11064.8 / 11176.4 | 4197.1 / 6299.2 | 5378.0 / 7547.7 |
| 256 B exchanges/s, K = 1 / 10 / 100 | 1 / 8 / 38 | 2 / 14 / 52 | 2 / 15 / 52 |
| 64 KiB GET idle, first byte / whole p50 (ms) | 2720.4 / 2720.7 | 1273.9 / 2125.7 | 1081.2 / 1669.2 |
| 64 KiB GET under bulk, first byte p50 / p99 (ms) | 9664.0 / 11009.0 | 6753.6 / 8379.1 | 6846.4 / 9785.8 |
| 64 KiB GET under bulk, whole p50 / p99 (ms) | 32629.0 / 32629.0 | 8755.4 / 12287.4 | 8941.8 / 11390.0 |
| Samples under bulk: pings / 64 KiB GETs (median over runs) | 5 / 3 | 7 / 4 | 6 / 4 |
| Runs that completed | 2 of 3 | 3 of 3 | 3 of 3 |

No connection was aborted. The per-exchange run that failed hit the 8 s
`DEFAULT_REQUEST_TIMEOUT_MS` on a 64 KiB GET beside the download (its head
waits behind the download's queued bytes on the same connection), as one of
the three `--keep-on-ping-failure` runs below did; a separate 2-run check
with `DEBUG=httpeers:connection-liveness*` failed the same way once and
logged four failed pings, on both sides, all "keeping it (bytes arrived
meanwhile)", and no abort. With two runs the per-exchange cells are the
higher value (see Method); its "whole" GET of 32.6 s comes from a run that
completed a single 64 KiB GET beside the download (the other run: 12.0 /
16.9 s over 3). The rows are otherwise in line
with the earlier `--keep-on-ping-failure` measurement below (the 64 KiB and
small-exchange rows a little better on the mux, within what the run-to-run
spread of a 3% loss link allows).

Measured earlier with libp2p's connection monitor told not to abort the
connection (`--keep-on-ping-failure` at the time; 3 runs):

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

**Fixed in `createNode` since these measurements: see "The fix" below.**

On the bad profile every TCP run failed. With `DEBUG=libp2p:connection-monitor*`:

```
libp2p:connection-monitor:error error during heartbeat - TimeoutError: The operation was aborted due to timeout
libp2p:connection-monitor:error aborting connection due to ping failure
run failed in "64 KiB GETs under bulk": request to peer ... timed out after 8000ms
```

libp2p 3's connection monitor (on by default; `createNode` did not
configure it) pings every connection every 10 s with a timeout of
max(5 s, 1.2 × average ping time) and, by default
(`abortConnectionOnPingFailure: true`), aborts the whole connection when a
ping times out. Its ping is a new stream on the same TCP connection, so under
a bulk download it waits behind everything the serving side has already
buffered. Once that is more than ~5 s of data at the achieved rate, the
connection is torn down and every exchange on it fails, on either path. The
lossy mobile profile came within reach of it (p99 ping under bulk 4.5 s), and
so did the per-exchange path on mobile without loss (4.8–5.3 s).

### The fix: abort only a connection that went silent

`createNode` now turns libp2p's monitor off and installs `connectionLiveness()`
(`src/connection-liveness.ts`): the same ping (`/ipfs/ping/1.0.0`, every
10 s, the same adaptive 5–60 s timeout), but a failed ping aborts the
connection only when **nothing was received on it since that ping was
sent**. Bytes arriving prove the remote is alive and the path delivers; a
ping stuck behind them proves nothing. Both ends of a bulk transfer receive:
the reader gets the data, the sender gets the yamux window updates the
reader returns for every data frame (and the reader's pings), on the
uncongested direction.

- **Seeing bytes.** libp2p has no per-connection byte counter. On TCP,
  WebSockets and relayed circuits the service listens for `message` events on
  the connection's raw transport stream (`maConn`), the hook libp2p's own
  metrics use, records a timestamp and a byte count, and removes the listener
  on stop. WebRTC's `maConn` never emits `message` (data travels on data
  channels), so there it reads `bytesReceived` from
  `RTCPeerConnection.getStats()` (`transport` stats, else the candidate
  pairs; browsers and node-datachannel report them) when a ping starts and
  when it fails. A connection with neither is aborted on any failed ping, as
  libp2p does. Never a listener on a muxed stream, which would start delivery
  before its real reader attaches.
- **One timeout per connection, learned from answered pings only.** A shared
  estimator lets a busy connection's failures push every other connection's
  timeout toward 60 s (and their detection time with it); a failed ping is
  not a round-trip sample, and feeding it only lengthens the timeout of the
  connection most likely to be failing.
- **A congested shared link.** When the node as a whole received at least
  64 KiB during a silent connection's failed ping, the connection is aborted
  at its second silent failure in a row (`silentFailuresWhenBusy`, default 2)
  rather than its first.

`connectionMonitor` on `createNode` tunes it (`pingIntervalMs`, `pingTimeout`,
`abortOnPingFailure: "when-silent" | "always" | "never"`,
`silentFailuresWhenBusy`) or turns it off (`false`). The member nodes (`httpeers-member`), the hub app's
node and the conformance harness install it the same way.

The options considered:

| | Busy, healthy connection | Silent dead peer, idle connection |
|---|---|---|
| libp2p's default (abort on any failed ping) | killed once ~5 s of data queue ahead of the ping | aborted after 5–15 s |
| (a) `abortConnectionOnPingFailure: false` | kept | **not detected**: yamux's keepalive only logs a missed ping, TCP keeps retransmitting for many minutes, the 2-minute socket inactivity timeout never fires while pings are written, and the mux keepalive and request timeouts fail exchanges, not the connection. Measured: still open 150 s after the peer went silent. |
| (b) a higher minimum ping timeout (e.g. 30 s) | kept until the queue exceeds the new floor (the bad profile's pings under bulk already reach 11 s; a larger window or a slower link gets past any floor) | aborted after up to interval + floor (40 s with 30 s) |
| (c) abort only when nothing was received since the ping (chosen) | kept for as long as data arrives | aborted after 5–15 s, as before (up to 25 s while the node receives on other connections) |

Detection of a peer that vanishes silently (no FIN or RST), measured through
a loopback TCP proxy that stops forwarding without closing either socket,
idle connection, `createNode` defaults, peer gone 12 s after the dial, 3 runs
each: **before 12.9 / 13.0 / 13.0 s, after 13.0 / 13.0 / 13.0 s** (the next
ping at 20 s, plus its 5 s timeout). The same with the node receiving a bulk
stream from a third peer the whole time: **23.0 / 23.0 / 23.0 s** (the second
silent failure). The bounds, with I the interval and T that connection's
timeout: I + T (15 s) on a quiet node, 2 I + T (25 s) on a node busy
elsewhere. Both assume T ≤ I; once answered pings on a slow link have grown
T past I, a ping still out at the next tick holds the next one back and the
worst case approaches 2 I + 2 T. On WebRTC each check may also wait up to
1 s, twice, for a `getStats()` sample (one that never settles counts as
nothing received). On a connection that was itself busy the clock starts once the
last bytes the peer sent before it vanished have arrived, plus at most one
interval if they arrived while a ping was out. The package's tests
(`tests/connection-liveness.test.ts`, scaled down to a 200 ms interval) check
these bounds, including a silent connection beside three busy ones whose
pings all fail; that a connection whose pings are never answered stays up
while it receives a trickle, over TCP and over WebRTC, with its timeout at
its floor (and that libp2p's rule, `"always"`, kills it); that one
connection's slow answered pings leave another's timeout alone; that
`"never"` leaves a silent connection open; and that `createNode` runs no
libp2p monitor.

The bad-profile rerun above used the first revision of this service (one
timeout estimator for all connections, failed pings fed into it, no
congestion rule). None of the three differences applies to it: each process
holds one connection, a failing ping on it was always kept because bytes
arrived, and the congestion rule only acts on a connection that received
nothing.

The trade-offs:

- A remote whose process is wedged but whose socket still drains bytes it
  queued earlier is kept until those bytes stop arriving (on a slow link, as
  long as its queue takes to drain).
- **An idle connection that shares a congested access link with a busy one**
  (a member's hub or relay reservation while it downloads from another peer)
  waits as long for its pings and receives nothing meanwhile. The congestion
  rule gives it one more interval; a queue that delays its pings past about
  two intervals still aborts it, and the reservation is lost and made again.
  Counting bytes on other connections to the same peer would not help here
  (the reservation is to a different peer). `apps/relay` builds its node
  without this package and still runs libp2p's monitor, so the relay aborts
  such a connection after a single ping slower than 5 s.
- On a node busy elsewhere, a dead peer takes one interval longer to find
  (25 s rather than 15 s at the defaults).
- A connection whose bytes cannot be seen is treated as silent (libp2p's
  behaviour). The
request timeouts (`requestTimeoutMs`, 8 s to the response head on the
per-exchange path) and the mux's keepalive (nothing for 3 × 5 s closes the
mux) are unchanged: they fail exchanges, not the connection, and the
per-exchange path's request timeout is what still fails GETs beside a
download on the bad link (above).

## Recommendation for plan step 3 (for the maintainer to decide)

| Traffic class | Recommended path | Why |
|---|---|---|
| Sockets and tunnels (duplex, long-lived, often interactive beside other traffic) | mux, once the window adapts; until then mux at 256 KiB where the link's BDP is at most about 256 KiB (bulk is capped at about 2.1 Mbit ÷ RTT in seconds) | The isolation is the point: a request beside a download stays within a few round trips of idle on the mux (79 ms on broadband, 394 ms on mobile, no loss) and waits 1–5 s on the per-exchange path. (Measured with HTTP exchanges; duplex tunnels were not measured separately.) One stream per peer also removes the per-protocol stream caps a tunnel-heavy peer runs into. |
| Small HTTP (API calls, tokens, presence) | mux | Since the round-trip fixes the mux answers in one round trip, the per-exchange path in two, so the mux is 1.5–3× as fast at K=1 and K=10 on every profile (about 2× on most); since its chunks are gathered it is 1.6–2.2× as fast at K=100 too, except with 3% loss, where the two are level (see "One round trip, and no lock-step" and "Lossy links at K=100"). WebRTC was not measured again after the fixes. |
| Large bodies (downloads, uploads, media) | per-exchange today; mux only with an adaptive window | A fixed 256 KiB window caps bulk on LAN and fat pipes (72% and 19%); 4 MiB removes the cap but also most of the isolation, so no fixed window serves both. |
| WebRTC links | mux at 256 KiB | The per-exchange path failed in most WebRTC runs (a data channel per exchange); the mux at 256 KiB ran on every profile, while at 4 MiB it failed beside a download on the lossy mobile and bad links. |

Changes this suggests, independent of the decision:

1. Make the mux's per-port window adaptive (target about one BDP; see "Window
   sizing").
2. ~~Send the caller's window with the port open, so an exchange takes one
   round trip on the mux.~~ Done in httpeers by presuming the ack (see "One
   round trip, and no lock-step"); the clean fix, which would let that
   module go, is in webrun-rpc.
3. ~~Find why the mux falls behind at K=100 on long paths.~~ Done: on links
   without loss, lock-step rounds from end-of-task gathering, plus the
   handshake; with 1% or 3% loss, a message per HTTP codec piece (bytes per
   exchange) and 64 KB batches decrypted whole (see "Lossy links at
   K=100").
4. ~~Configure libp2p's connection monitor in `createNode`.~~ Done:
   `connectionLiveness` aborts only a connection that received nothing
   during a failed ping (see "The connection dies").

## Raw data

The `--out` JSON of the runs the tables come from is in [`bench-results/`](bench-results/)
(not part of the published package, which ships `dist` and `src` only):

| File | Tables |
|---|---|
| `tcp-requested-profiles.json` | LAN, broadband, mobile, bad (all runs failed) |
| `tcp-extra-profiles.json` | broadband and mobile without loss, long fat pipe |
| `tcp-bad-keep-on-ping-failure.json` | bad with `--keep-on-ping-failure` (libp2p's monitor told not to abort) |
| `tcp-bad-connection-liveness.json` | bad with `createNode`'s defaults after the connection-monitor fix (per-run values under `raw`) |
| `webrtc.json` | WebRTC, all four profiles |
| `tcp-exchange-rates-rerun.json`, `webrtc-exchange-rates-rerun.json` | the exchange-rate rows (rerun) |
| `tcp-one-round-trip.json` | after the round-trip fixes: idle pings, exchange rates, idle 64 KiB GETs, all seven profiles (per-run values under `raw`) |
| `tcp-one-round-trip-bulk.json` | after the fixes: bulk and what runs beside it, mux 256 KiB, the three profiles without loss |
| `tcp-gathered-chunks.json` | "Lossy links at K=100": exchange rates before (mux) and after (both paths), all seven profiles; bulk after; the K=100-only runs that separate the two changes (per-run values under `raw`) |

The first four hold per-profile medians only (per-run values were not kept
then; the rerun files have them under `raw`), and their exchange rates are
the overstated first-run ones the tables no longer use. The per-exchange
WebRTC follow-up (LAN and broadband without loss), the `DEBUG` confirmation
run, the round-trip diagnostics, the single-fix comparison of the round-trip
fixes, the `ss` and Noise-layer diagnostics of the lossy links and the
loopback runs were not saved as JSON; their numbers are only in this
document.

## What still needs a real network

- Real links (Wi-Fi, LTE/5G with their link-layer retransmission and
  variable rate, transcontinental paths) instead of a FIFO with independent
  loss; in particular whether the 1% / 3% loss cases are as bad as here.
- Browser WebRTC (its own SCTP and DTLS stacks) and NAT traversal; only
  Node ↔ Node with node-datachannel was measured.
- Machines that do not share CPUs: here both peers and the emulator shared
  four vCPUs, which mostly matters for the LAN numbers.
- BBR senders (many servers run BBR; this used CUBIC on both ends).
