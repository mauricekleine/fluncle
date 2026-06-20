// Command fluncle-dns is a tiny authoritative DNS server for the delegated
// zone dig.fluncle.com. It answers TXT queries for a finding's coordinate
// (e.g. 004.7.2I.dig.fluncle.com), plus the special labels random and latest,
// by reading the Fluncle public API and rendering the finding as a TXT record.
//
// It is authoritative for exactly one zone, holds a short in-memory cache, and
// is entirely env-configurable (see config.go). It is not a recursive
// resolver: anything outside the zone is REFUSED.
package main

import "log"

func main() {
	cfg := loadConfig()
	if err := run(cfg); err != nil {
		log.Fatalf("fluncle-dns: %v", err)
	}
}
