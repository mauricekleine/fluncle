package main

import (
	"errors"
	"log"
	"net"
	"strings"
	"time"

	"github.com/miekg/dns"
)

// soaSerial is deliberately static — nothing bumps it, and nothing needs to. The
// serial exists so a secondary knows when to re-transfer, and this is a leaf zone
// with no secondaries: every answer is minted per query from the live API and
// carries a short TTL, so resolvers re-ask rather than AXFR us.
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

	// EDNS0 first: it decides how big a UDP answer may be, and every reply below
	// is written through h.reply, which truncates to that ceiling.
	udpSize, ok := h.applyEdns0(m, r)
	if !ok {
		// Unsupported EDNS version: BADVERS, per RFC 6891 §6.1.3.
		m.SetRcode(r, dns.RcodeBadVers)
		h.reply(w, m, udpSize)
		return
	}

	if len(r.Question) != 1 || r.Question[0].Qclass != dns.ClassINET {
		m.SetRcode(r, dns.RcodeRefused)
		h.reply(w, m, udpSize)
		return
	}

	q := r.Question[0]
	name := strings.ToLower(dns.Fqdn(q.Name))
	zone := strings.ToLower(h.cfg.Zone)

	// Outside our zone: we are not recursive.
	if name != zone && !strings.HasSuffix(name, "."+zone) {
		m.SetRcode(r, dns.RcodeRefused)
		h.reply(w, m, udpSize)
		return
	}

	// Zone apex: SOA / NS / (ANY) answered authoritatively.
	if name == zone {
		h.answerApex(m, q)
		h.reply(w, m, udpSize)
		return
	}

	// Everything left of the zone is the lookup label. A coordinate is itself
	// dotted (e.g. "011.1.6e"), so we do not reject multi-label names; the API
	// lookup decides whether the finding exists (NXDOMAIN if it does not).
	label := strings.TrimSuffix(name, "."+zone)

	// The reserved `live` label answers the live-set callout off /api/v1/status, not a
	// finding lookup. It always exists (NODATA, never NXDOMAIN, for non-TXT types).
	if label == liveLabel {
		h.answerLive(m, q)
		h.reply(w, m, udpSize)
		return
	}

	switch q.Qtype {
	case dns.TypeTXT, dns.TypeANY:
		h.answerTXT(m, q, label)
	case dns.TypeNS, dns.TypeSOA, dns.TypeA, dns.TypeAAAA:
		// A child name with no record of this type: NODATA (empty + SOA),
		// only if the finding actually exists, else NXDOMAIN.
		if _, err := h.api.lookup(label); err != nil {
			h.answerLookupError(m, err)
		} else {
			h.nodata(m)
		}
	default:
		h.nodata(m)
	}
	h.reply(w, m, udpSize)
}

// applyEdns0 reads the request's OPT record, echoes one on the reply, and
// returns the ceiling a UDP answer must fit inside. `ok` is false when the
// client speaks an EDNS version we do not (caller answers BADVERS).
//
// A client with no OPT record gets the plain-DNS 512-byte ceiling; a client that
// advertises more gets what it asked for, clamped to cfg.MaxUDPSize so we never
// emit a fragmenting jumbo packet (nor a fat reflection payload).
func (h *handler) applyEdns0(m, r *dns.Msg) (int, bool) {
	ceiling := int(h.cfg.MaxUDPSize)
	if ceiling < dns.MinMsgSize {
		ceiling = dns.MinMsgSize
	}

	opt := r.IsEdns0()
	if opt == nil {
		return dns.MinMsgSize, true
	}

	// Advertise our own ceiling back, and mirror DO so a DNSSEC-aware resolver
	// sees a well-formed OPT (the zone is unsigned, so there is nothing to add).
	m.SetEdns0(uint16(ceiling), opt.Do())

	if opt.Version() != 0 {
		return ceiling, false
	}

	size := int(opt.UDPSize())
	if size < dns.MinMsgSize {
		// RFC 6891 §6.2.3: an advertised size below 512 is treated as 512.
		size = dns.MinMsgSize
	}
	if size > ceiling {
		size = ceiling
	}
	return size, true
}

// reply writes the answer, setting TC and shedding records when a UDP answer
// does not fit the client's buffer so the client retries over TCP. miekg/dns
// does not do this for us: without it an oversized TXT is written as an
// over-long UDP datagram that the client silently fails to read.
func (h *handler) reply(w dns.ResponseWriter, m *dns.Msg, udpSize int) {
	if isUDP(w) {
		m.Truncate(udpSize)
	}
	_ = w.WriteMsg(m)
}

// isUDP reports whether this query arrived over UDP (the TCP listener shares the
// same handler, and a TCP answer needs no truncation).
func isUDP(w dns.ResponseWriter) bool {
	_, ok := w.RemoteAddr().(*net.UDPAddr)
	return ok
}

// answerLookupError maps a failed lookup onto an rcode: a confirmed absence is
// NXDOMAIN, anything else (an upstream failure, or our own spent outbound
// budget) is SERVFAIL. Nothing is logged here on purpose — a cached failure
// answers from memory, and logging per ANSWER would let a query flood amplify
// into the journal. The api client logs once per real upstream failure instead.
func (h *handler) answerLookupError(m *dns.Msg, err error) {
	if errors.Is(err, errNotFound) {
		h.nxdomain(m)
		return
	}
	m.Rcode = dns.RcodeServerFailure
}

func (h *handler) answerTXT(m *dns.Msg, q dns.Question, label string) {
	t, err := h.api.lookup(label)
	if err != nil {
		h.answerLookupError(m, err)
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
			// Logged once per real failure by the api client, not per answer.
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
	api := newAPIClient(cfg)
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
