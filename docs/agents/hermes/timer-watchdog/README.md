# fluncle-timer-watchdog

The host guard against a rave-02 systemd timer that reports `active` but will never fire again.

## The failure

Every sweep timer on this box is monotonic: it fires once on `OnBootSec` and then rides `OnUnitActiveSec=<period>`, which systemd measures from the **service's** last activation. Stop such a timer before its one-shot boot fire and start it again afterwards, and it can be left with no reference point at all — `NextElapse` becomes `infinity` and the sweep never runs again.

`Persistent=true` is the ingredient that makes this permanent, and it is worth being precise about because the intuition runs the other way. Persistent writes a stamp file (`/var/lib/systemd/timers/stamp-<unit>`). On a fresh `systemctl start`, systemd reads that stamp as the timer's last trigger and therefore treats the one-shot `OnBootSec` as already satisfied — so it does **not** re-fire it. `OnUnitActiveSec` then waits for a service activation that can only come from the timer firing. Deadlock.

Reproduced on the box 2026-07-29 (all three cases, same unit):

| Probe                                                                                             | Result                                                        |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `OnBootSec` elapsed, **no** stamp file                                                            | fires immediately, re-arms — healthy                          |
| `OnBootSec` elapsed, `Persistent=true`, **no** stamp                                              | fires immediately, re-arms — healthy                          |
| `OnBootSec` elapsed, `Persistent=true`, **stamp pre-dating the boot deadline**, service never run | `NEXT = -` — **stranded, exactly reproducing anchor's state** |

So `Persistent=true` on a purely monotonic timer buys nothing (it is designed for `OnCalendar`) and actively creates this trap. Dropping it from the sweep timers would remove the failure at its root; that is a 40-odd-unit change and has not been made.

This is invisible to every health signal the box had. `systemctl is-active` reports `active`. The service's last result is `success`. `systemctl list-units` shows the full roster healthy. The damage appears only in `NextElapse`, which nothing was reading.

**Observed 2026-07-28.** An unattended kernel-upgrade reboot (6.8.0-134 → 6.8.0-136) at 12:19 UTC landed inside a pin-watch rebake quiesce window — timers stopped 12:29, restored 12:35. Every timer whose boot fire was due in that gap came back active-but-dead:

| Stranded (boot fire inside the window)                                                                                    | Survived (fired before it)                                                |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `publish-advance` 9m, `studio-clip` 10m, `anchor` / `rank` / `cover-masters` / `recording-mbids` 11m, `label-lineage` 13m | `enrich` 1m, `capture` / `embed` / `note` 3m, `crawl` / `artist-sweep` 7m |

Seven sweeps sat dead for 13 hours with no alert. The catalogue anchor queue stalled at ~28k.

## The two layers

1. **Prevention** — `rearm_stalled_timer` in [`../pin-watch/rebuild-hermes.sh`](../pin-watch/rebuild-hermes.sh). The quiesce restore path now checks each timer it restarts and kicks the service once if it came back with no next elapse. This closes the exact hole the incident came through.
2. **Detection** — this unit. An independent net that catches the same stranding from **any** cause: an `install-host-timers.sh` re-run shortly after boot, a manual `systemctl stop`, a crash mid-quiesce. It re-arms what it finds and posts a Discord alert naming the timers, because a stranded timer means something stopped it outside the paths that know to restore it.

## The gap that is still open: nothing watches the watchdog

This unit runs on the host, outside the container, so it never sources [`../scripts/cron-output.sh`](../scripts/cron-output.sh) and writes no `/status` marker — and unlike `pin-watch` (which POSTs its own `self-deploy` row) it POSTs nothing either. So it appears on `/status` **not at all**. A clean pass is silent by design, which means a watchdog that has been dead for a week looks exactly like a watchdog with nothing to do: the blind-detector shape this whole unit exists to catch, turned on itself. `fluncle-secrets-sync` is in the same position.

It is recorded rather than papered over: both timers are declared in `NON_WRITER_TIMERS` in [`../scripts/cron-roster.ts`](../scripts/cron-roster.ts), whose guard fails the build if that declaration ever stops being true. Closing it properly means giving the pass a `/status` row of its own — a `checked` denominator, not a `healed` count, because a healthy watchdog legitimately heals nothing forever.

## Why `OnCalendar`

The watchdog runs on `OnCalendar=*:0/15`, deliberately. A calendar timer always carries a realtime next elapse, so the watchdog **cannot fall into the hole it exists to find**. It is also the one form `Persistent=true` actually applies to.

## What it does

Each pass: enumerate active `fluncle-*.timer` plus `pin-watch.timer` (outside the glob, and the one whose stranding would silently stop the box self-deploying), skip itself, and flag any whose monotonic elapse is `infinity` with no realtime elapse. A service that is currently running is **not** a suspect — a oneshot mid-tick parks its own timer at `infinity` until it finishes. Suspects are re-sampled after a short delay before any action, so a timer caught in the instant its service is reaped is never kicked.

Re-arming is one `systemctl start --no-block` of the service: that gives `OnUnitActiveSec` the reference point it is missing, and the normal cadence resumes from that moment.

A clean pass logs `ok — every active timer has a next elapse` and exits 0.

## Verifying it

The detector is unproven until a synthetic failure makes it fire. Use a scratch unit, never a real sweep.

Note what does **not** work: an elapsed `OnBootSec` with no stamp file fires immediately and re-arms itself, with or without `Persistent`. Both were tried on 2026-07-29 and neither strands. The shortest recipe that genuinely strands is a timer riding `OnUnitActiveSec` alone whose service has never run — no reference point exists, so nothing can be computed:

```bash
# on the box, as root
printf '[Unit]\nDescription=wd probe\n[Service]\nType=oneshot\nExecStart=/bin/true\n' \
  > /etc/systemd/system/fluncle-wdprobe.service
printf '[Timer]\nOnUnitActiveSec=1h\n[Install]\nWantedBy=timers.target\n' \
  > /etc/systemd/system/fluncle-wdprobe.timer
systemctl daemon-reload && systemctl start fluncle-wdprobe.timer
systemctl list-timers --all fluncle-wdprobe.timer   # NEXT is "-" → stranded

/opt/fluncle-timer-watchdog/timer-watchdog.sh       # re-arms it and says so
systemctl list-timers --all fluncle-wdprobe.timer   # NEXT now populated

systemctl stop fluncle-wdprobe.timer
rm -f /etc/systemd/system/fluncle-wdprobe.{service,timer} \
      /var/lib/systemd/timers/stamp-fluncle-wdprobe.timer
systemctl daemon-reload
```

To reproduce the **production** shape instead — the one the sweeps actually hit — keep `OnBootSec=1min`, `OnUnitActiveSec=1h`, `Persistent=true` and pre-date the stamp so it sits before this boot's deadline, leaving the service unrun:

```bash
touch -d "$(date -u -d '@'$(($(date +%s) - 86400)) '+%F %T')" \
  /var/lib/systemd/timers/stamp-fluncle-wdprobe.timer
systemctl daemon-reload && systemctl start fluncle-wdprobe.timer   # NEXT is "-"
```

## Install

Picked up automatically by [`../install-host-timers.sh`](../install-host-timers.sh) — it discovers any directory here holding a `.service`/`.timer` and lays down the host script named by the unit's `ExecStart` from the same directory.
