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
	// CacheTTL is how long an API response is held in memory.
	CacheTTL time.Duration
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
		APITimeout:  time.Duration(envInt("FLUNCLE_DNS_API_TIMEOUT", 5)) * time.Second,
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
