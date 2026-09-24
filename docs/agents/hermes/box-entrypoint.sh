#!/bin/sh
# The sweep container's main process. It does no work of its own: every sweep is a host
# systemd timer that `docker exec`s into this container, so the main process only has to stay
# alive until the container is stopped. tini (PID 1) forwards SIGTERM, which ends the sleep.
#
# Arguments are accepted and ignored so a `docker run … <image> <args>` line written for an
# earlier image (pin-watch's rollback path re-runs the previous image with the same line) still
# starts this one.
set -eu
exec sleep infinity
