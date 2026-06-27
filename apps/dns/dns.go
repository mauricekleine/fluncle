package main

import (
	"errors"
	"log"
	"strings"
	"time"

	"github.com/miekg/dns"
)

// soaSerial is bumped per build; a static value is fine for a leaf zone whose
// data is dynamic and short-TTL (resolvers do not AXFR us).
const soaSerial = 1

// liveLabel is the reserved name (e.g. live.dig.fluncle.com) that answers the
// cross-surface live-set callout instead of a finding lookup.
const liveLabel = "live"

// liveRecordTTL keeps the live TXT short so resolvers re-query within a minute of
// the set ending (the callout must clear promptly), shorter than a finding's TTL.
const liveRecordTTL = 60

// handler answers queries for the delegated zone.
type handler struct {
	cfg config
	api *apiClient
}

func newHandler(cfg config, api *apiClient) *handler {
	return &handler{cfg: cfg, api: api}
}

func (h *handler) ServeDNS(w dns.ResponseWriter, r *dns.Msg) {
	m := new(dns.Msg)
	m.SetReply(r)
	m.Authoritative = true

	if len(r.Question) != 1 || r.Question[0].Qclass != dns.ClassINET {
		m.SetRcode(r, dns.RcodeRefused)
		_ = w.WriteMsg(m)
		return
	}

	q := r.Question[0]
	name := strings.ToLower(dns.Fqdn(q.Name))
	zone := strings.ToLower(h.cfg.Zone)

	// Outside our zone: we are not recursive.
	if name != zone && !strings.HasSuffix(name, "."+zone) {
		m.SetRcode(r, dns.RcodeRefused)
		_ = w.WriteMsg(m)
		return
	}

	// Zone apex: SOA / NS / (ANY) answered authoritatively.
	if name == zone {
		h.answerApex(m, q)
		_ = w.WriteMsg(m)
		return
	}

	// Everything left of the zone is the lookup label. A coordinate is itself
	// dotted (e.g. "011.1.6e"), so we do not reject multi-label names; the API
	// lookup decides whether the finding exists (NXDOMAIN if it does not).
	label := strings.TrimSuffix(name, "."+zone)

	// The reserved `live` label answers the live-set callout off /api/status, not a
	// finding lookup. It always exists (NODATA, never NXDOMAIN, for non-TXT types).
	if label == liveLabel {
		h.answerLive(m, q)
		_ = w.WriteMsg(m)
		return
	}

	switch q.Qtype {
	case dns.TypeTXT, dns.TypeANY:
		h.answerTXT(m, q, label)
	case dns.TypeNS, dns.TypeSOA, dns.TypeA, dns.TypeAAAA:
		// A child name with no record of this type: NODATA (empty + SOA),
		// only if the finding actually exists, else NXDOMAIN.
		if _, err := h.api.lookup(label); err != nil {
			if errors.Is(err, errNotFound) {
				h.nxdomain(m)
			} else {
				log.Printf("lookup %q: %v", label, err)
				m.Rcode = dns.RcodeServerFailure
			}
		} else {
			h.nodata(m)
		}
	default:
		h.nodata(m)
	}
	_ = w.WriteMsg(m)
}

func (h *handler) answerTXT(m *dns.Msg, q dns.Question, label string) {
	t, err := h.api.lookup(label)
	if err != nil {
		if errors.Is(err, errNotFound) {
			h.nxdomain(m)
			return
		}
		log.Printf("lookup %q: %v", label, err)
		m.Rcode = dns.RcodeServerFailure
		return
	}
	m.Answer = append(m.Answer, &dns.TXT{
		Hdr: dns.RR_Header{
			Name:   q.Name,
			Rrtype: dns.TypeTXT,
			Class:  dns.ClassINET,
			Ttl:    h.cfg.RecordTTL,
		},
		Txt: buildTXT(t, h.cfg),
	})
}

// answerLive answers the reserved `live` label: a TXT carrying the live-set
// callout (v=fluncle1; live=0|1; …) on a short TTL, NODATA for other types.
func (h *handler) answerLive(m *dns.Msg, q dns.Question) {
	switch q.Qtype {
	case dns.TypeTXT, dns.TypeANY:
		info, err := h.api.liveStatus()
		if err != nil {
			log.Printf("live lookup: %v", err)
			m.Rcode = dns.RcodeServerFailure
			return
		}
		m.Answer = append(m.Answer, &dns.TXT{
			Hdr: dns.RR_Header{
				Name:   q.Name,
				Rrtype: dns.TypeTXT,
				Class:  dns.ClassINET,
				Ttl:    liveRecordTTL,
			},
			Txt: buildLiveTXT(info),
		})
	default:
		h.nodata(m)
	}
}

func (h *handler) answerApex(m *dns.Msg, q dns.Question) {
	switch q.Qtype {
	case dns.TypeSOA, dns.TypeANY:
		m.Answer = append(m.Answer, h.soa())
		if q.Qtype == dns.TypeANY {
			m.Answer = append(m.Answer, h.ns())
		}
	case dns.TypeNS:
		m.Answer = append(m.Answer, h.ns())
	default:
		// Apex exists but has no record of this type: NODATA.
		h.nodata(m)
	}
}

func (h *handler) ns() *dns.NS {
	return &dns.NS{
		Hdr: dns.RR_Header{
			Name:   h.cfg.Zone,
			Rrtype: dns.TypeNS,
			Class:  dns.ClassINET,
			Ttl:    h.cfg.RecordTTL,
		},
		Ns: h.cfg.NS,
	}
}

func (h *handler) soa() *dns.SOA {
	return &dns.SOA{
		Hdr: dns.RR_Header{
			Name:   h.cfg.Zone,
			Rrtype: dns.TypeSOA,
			Class:  dns.ClassINET,
			Ttl:    h.cfg.RecordTTL,
		},
		Ns:      h.cfg.NS,
		Mbox:    h.cfg.Mbox,
		Serial:  soaSerial,
		Refresh: 7200,
		Retry:   3600,
		Expire:  1209600,
		Minttl:  h.cfg.NegativeTTL,
	}
}

// nxdomain marks the name as nonexistent and attaches the SOA in AUTHORITY so
// resolvers cache the negative answer per the SOA minimum.
func (h *handler) nxdomain(m *dns.Msg) {
	m.Rcode = dns.RcodeNameError
	m.Ns = append(m.Ns, h.soa())
}

// nodata is the name-exists-but-no-such-type answer: NOERROR, empty ANSWER,
// SOA in AUTHORITY.
func (h *handler) nodata(m *dns.Msg) {
	m.Ns = append(m.Ns, h.soa())
}

// run starts the UDP and TCP listeners and blocks until one errors.
func run(cfg config) error {
	api := newAPIClient(cfg.APIBase, cfg.APITimeout, cfg.CacheTTL)
	h := newHandler(cfg, api)

	mux := dns.NewServeMux()
	mux.Handle(cfg.Zone, h)

	errc := make(chan error, 2)
	for _, net := range []string{"udp", "tcp"} {
		srv := &dns.Server{Addr: cfg.Listen, Net: net, Handler: mux}
		go func(s *dns.Server) {
			log.Printf("fluncle-dns listening %s/%s, zone %s, api %s",
				s.Addr, s.Net, cfg.Zone, cfg.APIBase)
			errc <- s.ListenAndServe()
		}(srv)
	}

	// Give the listeners a beat to bind so a bind error surfaces promptly.
	select {
	case err := <-errc:
		return err
	case <-time.After(250 * time.Millisecond):
	}
	return <-errc
}
