# Fluncle's Hermes agent image: the pinned Nous Research Hermes gateway plus the
# Fluncle CLI behind the command gate. Architecture, build, and run details live
# in docs/agents/hermes-agent.md. Rebuild this image after editing `fluncle-gate`.
FROM nousresearch/hermes-agent:v2026.6.19

# Install the Fluncle CLI (the agent's only path to read/write the archive) and
# move the real binary aside so the gate wrapper can own the `fluncle` name on PATH.
RUN npm install -g fluncle \
 && mv "$(command -v fluncle)" /usr/local/bin/fluncle-real

# The command gate: deny-by-default within `admin`; public/read commands pass through.
COPY fluncle-gate /usr/local/bin/fluncle
RUN chmod 0755 /usr/local/bin/fluncle /usr/local/bin/fluncle-real
