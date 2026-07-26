package main

import (
	"os"
	"strconv"
	"time"
)

// config holds the runtime knobs, all overridable from the environment so the
// systemd unit can point the binary at a staging API or a different port
// without a rebuild.
type config struct {
	// Zone is the delegated zone this server is authoritative for, as a
	// fully-qualified name (trailing dot), e.g. "dig.fluncle.com.".
	Zone string
	// NS is the nameserver hostname inside the zone, e.g. "ns1.dig.fluncle.com.".
	NS string
	// Mbox is the zone admin mailbox in SOA form (the "@" becomes a "."),
	// e.g. "hostmaster.fluncle.com.".
	Mbox string
	// Listen is the address both the UDP and TCP servers bind to.
	Listen string
	// APIBase is the Fluncle public API origin, no trailing slash.
	APIBase string
	// RecordTTL is the TTL (seconds) on the answer records.
	RecordTTL uint32
	// NegativeTTL is the SOA minimum / negative-cache TTL (seconds).
	NegativeTTL uint32
	// CacheTTL is how long a successful API response is held in memory.
	CacheTTL time.Duration
	// NegativeCacheTTL is how long a confirmed "no such finding" (the API
	// answered 404) is held in memory. Without it every distinct nonsense label
	// is one outbound API request, which makes an unauthenticated UDP packet an
	// amplifier pointed at our own Worker.
	NegativeCacheTTL time.Duration
	// ErrorCacheTTL is how long an upstream FAILURE (timeout, 5xx, garbage body)
	// is held. Shorter than NegativeCacheTTL on purpose: a 404 is a verdict, an
	// error is a transient condition we want to re-probe sooner.
	ErrorCacheTTL time.Duration
	// MaxUpstreamInflight bounds concurrent outbound API requests.
	MaxUpstreamInflight int
	// UpstreamPerSecond bounds how many outbound API requests may START per
	// second. Past the budget a lookup degrades to SERVFAIL instead of adding
	// load to the API.
	UpstreamPerSecond int
	// MaxUDPSize caps the UDP answer size we will emit, even when a client's
	// EDNS0 OPT advertises more. 1232 is the DNS-flag-day recommendation: it
	// stays under the common 1500-byte MTU (no IP fragmentation) and keeps the
	// reflection amplification factor small. Answers larger than this get TC set
	// so the client retries over TCP.
	MaxUDPSize uint16
	// APITimeout bounds an upstream API request.
	APITimeout time.Duration
}

func loadConfig() config {
	return config{
		Zone:        fqdn(env("FLUNCLE_DNS_ZONE", "dig.fluncle.com")),
		NS:          fqdn(env("FLUNCLE_DNS_NS", "ns1.dig.fluncle.com")),
		Mbox:        fqdn(env("FLUNCLE_DNS_MBOX", "hostmaster.fluncle.com")),
		Listen:      env("FLUNCLE_DNS_LISTEN", ":53"),
		APIBase:     trimSlash(env("FLUNCLE_DNS_API_BASE", "https://www.fluncle.com")),
		RecordTTL:   uint32(envInt("FLUNCLE_DNS_TTL", 300)),
		NegativeTTL: uint32(envInt("FLUNCLE_DNS_NEGATIVE_TTL", 60)),
		CacheTTL:    time.Duration(envInt("FLUNCLE_DNS_CACHE_TTL", 60)) * time.Second,
		NegativeCacheTTL: time.Duration(
			envInt("FLUNCLE_DNS_NEGATIVE_CACHE_TTL", 60),
		) * time.Second,
		ErrorCacheTTL: time.Duration(
			envInt("FLUNCLE_DNS_ERROR_CACHE_TTL", 10),
		) * time.Second,
		MaxUpstreamInflight: envInt("FLUNCLE_DNS_MAX_UPSTREAM_INFLIGHT", 4),
		UpstreamPerSecond:   envInt("FLUNCLE_DNS_UPSTREAM_QPS", 20),
		MaxUDPSize:          uint16(envInt("FLUNCLE_DNS_MAX_UDP_SIZE", 1232)),
		APITimeout:          time.Duration(envInt("FLUNCLE_DNS_API_TIMEOUT", 5)) * time.Second,
	}
}

func env(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		return v
	}
	return fallback
}

func envInt(key string, fallback int) int {
	if v, ok := os.LookupEnv(key); ok && v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func fqdn(name string) string {
	if name == "" {
		return name
	}
	if name[len(name)-1] == '.' {
		return name
	}
	return name + "."
}

func trimSlash(s string) string {
	for len(s) > 0 && s[len(s)-1] == '/' {
		s = s[:len(s)-1]
	}
	return s
}
