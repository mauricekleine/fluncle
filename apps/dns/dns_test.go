package main

import (
	"net"
	"strings"
	"testing"
	"time"

	"github.com/miekg/dns"
)

// A finding's TXT payload routinely outgrows the 512-byte plain-DNS ceiling once
// it carries an album, two URLs and a few artists. miekg/dns does not set TC for
// us, so without the handling below an oversized answer goes out as an over-long
// UDP datagram the client silently fails to read. These tests pin the contract:
// truncate + TC on UDP so the client retries over TCP, honour a client's
// advertised EDNS0 buffer, and never truncate over TCP.

// captureWriter is a dns.ResponseWriter that records the reply and reports the
// transport (the UDP/TCP distinction is what decides truncation).
type captureWriter struct {
	remote net.Addr
	msg    *dns.Msg
}

func udpWriter() *captureWriter {
	return &captureWriter{remote: &net.UDPAddr{IP: net.IPv4(203, 0, 113, 7), Port: 40000}}
}

func tcpWriter() *captureWriter {
	return &captureWriter{remote: &net.TCPAddr{IP: net.IPv4(203, 0, 113, 7), Port: 40000}}
}

func (w *captureWriter) LocalAddr() net.Addr  { return w.remote }
func (w *captureWriter) RemoteAddr() net.Addr { return w.remote }
func (w *captureWriter) WriteMsg(m *dns.Msg) error {
	w.msg = m
	return nil
}
func (w *captureWriter) Write(b []byte) (int, error) { return len(b), nil }
func (w *captureWriter) Close() error                { return nil }
func (w *captureWriter) TsigStatus() error           { return nil }
func (w *captureWriter) TsigTimersOnly(bool)         {}
func (w *captureWriter) Hijack()                     {}

const testZone = "dig.fluncle.com."

func handlerConfig(base string) config {
	cfg := testConfig(base)
	cfg.Zone = testZone
	cfg.NS = "ns1." + testZone
	cfg.Mbox = "hostmaster.fluncle.com."
	cfg.RecordTTL = 300
	cfg.NegativeTTL = 60
	return cfg
}

// mediumTrack renders a payload that clears 512 bytes but stays under the
// 1232-byte UDP ceiling: the everyday "needs EDNS0 or TC" answer.
func mediumTrack() *track {
	return &track{
		LogID:      "011.1.6E",
		Artists:    []string{"Netsky", "Bev Lee Harling", "Hybrid Minds", "Whiney"},
		Title:      "I See The Future In Your Eyes " + strings.Repeat("x", 120),
		Album:      "Second Nature " + strings.Repeat("y", 180),
		BPM:        171.09,
		Key:        "C minor",
		AddedAt:    "2026-06-10T14:17:41.737Z",
		LogPageURL: "https://www.fluncle.com/log/011.1.6E",
		SpotifyURL: "https://open.spotify.com/track/1rgIJkGSUqB3EgidQbEbxy",
	}
}

// jumboTrack renders the worst case the TXT builder can produce: ten 255-byte
// strings, two of them URLs — well past even an EDNS0 client's usable buffer.
func jumboTrack() *track {
	return &track{
		LogID:      "012.4.4D",
		Artists:    []string{strings.Repeat("a", 600)},
		Title:      strings.Repeat("t", 600),
		Album:      strings.Repeat("b", 600),
		BPM:        174,
		Key:        "F minor",
		AddedAt:    "2026-06-10T14:17:41.737Z",
		LogPageURL: "https://www.fluncle.com/log/012.4.4D",
		SpotifyURL: "https://open.spotify.com/track/1rgIJkGSUqB3EgidQbEbxy",
	}
}

func TestJumboTrackIsTenTXTStrings(t *testing.T) {
	strs := buildTXT(jumboTrack(), handlerConfig("https://www.fluncle.com"))
	if len(strs) != 10 {
		t.Fatalf("jumbo payload split into %d strings, want 10", len(strs))
	}
	for i, s := range strs {
		if len(s) > maxTXTString {
			t.Fatalf("string %d exceeds %d bytes: %d", i, maxTXTString, len(s))
		}
	}
	joinedPayload := joined(strs)
	for _, want := range []string{
		"url=https://www.fluncle.com/log/012.4.4D",
		"spotify=https://open.spotify.com/track/1rgIJkGSUqB3EgidQbEbxy",
	} {
		if !strings.Contains(joinedPayload, want) {
			t.Fatalf("jumbo payload missing %q", want)
		}
	}
}

// newTestHandler primes the API cache with the given findings so no lookup in
// these tests can reach the network; anything unprimed 404s at the stub.
func newTestHandler(t *testing.T, tracks map[string]*track) (*handler, *apiStub) {
	t.Helper()
	stub := newAPIStub()
	t.Cleanup(stub.close)

	cfg := handlerConfig(stub.server.URL)
	api := newAPIClient(cfg)
	for key, tr := range tracks {
		api.set(key, tr)
	}
	return newHandler(cfg, api), stub
}

func query(name string, qtype uint16, ednsSize uint16, ednsVersion uint8) *dns.Msg {
	m := new(dns.Msg)
	m.SetQuestion(dns.Fqdn(name), qtype)
	if ednsSize > 0 {
		m.SetEdns0(ednsSize, false)
		if opt := m.IsEdns0(); opt != nil {
			opt.Hdr.Ttl |= uint32(ednsVersion) << 16
		}
	}
	return m
}

func TestServeDNS_TruncatesOversizedUDPAnswers(t *testing.T) {
	cases := []struct {
		name          string
		label         string
		tcp           bool
		ednsSize      uint16
		wantTruncated bool
		wantAnswers   int
	}{
		{
			name:        "small answer over plain UDP fits",
			label:       "004.7.2i",
			wantAnswers: 1,
		},
		{
			name:          "oversized answer over plain UDP sets TC",
			label:         "011.1.6e",
			wantTruncated: true,
		},
		{
			name:        "oversized answer fits an EDNS0 client",
			label:       "011.1.6e",
			ednsSize:    4096,
			wantAnswers: 1,
		},
		{
			name:          "EDNS0 client advertising 512 still gets TC",
			label:         "011.1.6e",
			ednsSize:      512,
			wantTruncated: true,
		},
		{
			name:        "oversized answer over TCP is whole",
			label:       "011.1.6e",
			tcp:         true,
			wantAnswers: 1,
		},
		{
			name:          "jumbo answer exceeds even the clamped EDNS0 ceiling",
			label:         "012.4.4d",
			ednsSize:      4096,
			wantTruncated: true,
		},
		{
			name:        "jumbo answer over TCP is whole",
			label:       "012.4.4d",
			tcp:         true,
			wantAnswers: 1,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, stub := newTestHandler(t, map[string]*track{
				"004.7.2I": {LogID: "004.7.2I", Artists: []string{"A"}, Title: "T"},
				"011.1.6E": mediumTrack(),
				"012.4.4D": jumboTrack(),
			})

			w := udpWriter()
			if tc.tcp {
				w = tcpWriter()
			}
			h.ServeDNS(w, query(tc.label+"."+testZone, dns.TypeTXT, tc.ednsSize, 0))

			m := w.msg
			if m == nil {
				t.Fatal("no reply written")
			}
			if m.Truncated != tc.wantTruncated {
				t.Fatalf("TC = %v, want %v (answers: %d)", m.Truncated, tc.wantTruncated, len(m.Answer))
			}
			if len(m.Answer) != tc.wantAnswers {
				t.Fatalf("answers = %d, want %d", len(m.Answer), tc.wantAnswers)
			}
			if m.Rcode != dns.RcodeSuccess {
				t.Fatalf("rcode = %s, want NOERROR", dns.RcodeToString[m.Rcode])
			}

			// A UDP reply must actually FIT the ceiling it was measured against,
			// otherwise TC is cosmetic and the datagram is still unreadable.
			if !tc.tcp {
				limit := dns.MinMsgSize
				if tc.ednsSize > 0 {
					limit = min(int(tc.ednsSize), int(h.cfg.MaxUDPSize))
				}
				if got := m.Len(); got > limit {
					t.Fatalf("reply is %d bytes, over the %d-byte ceiling", got, limit)
				}
			}

			if n := stub.count(); n != 0 {
				t.Fatalf("primed lookups made %d outbound requests, want 0", n)
			}
		})
	}
}

// The allow path in full: an EDNS0 client gets the complete payload back, byte
// for byte, and the reply carries our own advertised buffer size.
func TestServeDNS_EDNS0ClientGetsTheWholePayload(t *testing.T) {
	tr := mediumTrack()
	h, _ := newTestHandler(t, map[string]*track{"011.1.6E": tr})

	w := udpWriter()
	h.ServeDNS(w, query("011.1.6e."+testZone, dns.TypeTXT, 4096, 0))

	txt, ok := w.msg.Answer[0].(*dns.TXT)
	if !ok {
		t.Fatalf("answer is %T, want *dns.TXT", w.msg.Answer[0])
	}
	if got, want := joined(txt.Txt), joined(buildTXT(tr, h.cfg)); got != want {
		t.Fatalf("payload mismatch\n got: %q\nwant: %q", got, want)
	}

	opt := w.msg.IsEdns0()
	if opt == nil {
		t.Fatal("reply carries no OPT record for an EDNS0 query")
	}
	if got := opt.UDPSize(); got != h.cfg.MaxUDPSize {
		t.Fatalf("advertised UDP size = %d, want %d", got, h.cfg.MaxUDPSize)
	}
}

// A plain-DNS client must not be handed an OPT record it never asked for.
func TestServeDNS_NoOptForAPlainQuery(t *testing.T) {
	h, _ := newTestHandler(t, map[string]*track{
		"004.7.2I": {LogID: "004.7.2I", Artists: []string{"A"}, Title: "T"},
	})

	w := udpWriter()
	h.ServeDNS(w, query("004.7.2i."+testZone, dns.TypeTXT, 0, 0))

	if w.msg.IsEdns0() != nil {
		t.Fatal("reply carries an OPT record for a non-EDNS0 query")
	}
	if len(w.msg.Answer) != 1 {
		t.Fatalf("answers = %d, want 1", len(w.msg.Answer))
	}
}

func TestServeDNS_UnsupportedEDNSVersionIsBadVers(t *testing.T) {
	h, _ := newTestHandler(t, map[string]*track{
		"004.7.2I": {LogID: "004.7.2I", Artists: []string{"A"}, Title: "T"},
	})

	w := udpWriter()
	h.ServeDNS(w, query("004.7.2i."+testZone, dns.TypeTXT, 4096, 1))

	if w.msg.Rcode != dns.RcodeBadVers {
		t.Fatalf("rcode = %s, want BADVERS", dns.RcodeToString[w.msg.Rcode])
	}
	if w.msg.IsEdns0() == nil {
		t.Fatal("a BADVERS reply must carry an OPT record")
	}
}

// The DNS-facing half of negative caching: a nonsense label answers NXDOMAIN
// every time, but only the FIRST one costs an outbound request.
func TestServeDNS_NonsenseLabelsAreCachedNXDOMAIN(t *testing.T) {
	h, stub := newTestHandler(t, nil)

	for range 5 {
		w := udpWriter()
		h.ServeDNS(w, query("no-such-label."+testZone, dns.TypeTXT, 0, 0))
		if w.msg.Rcode != dns.RcodeNameError {
			t.Fatalf("rcode = %s, want NXDOMAIN", dns.RcodeToString[w.msg.Rcode])
		}
		if len(w.msg.Ns) != 1 {
			t.Fatalf("NXDOMAIN must carry the SOA in AUTHORITY, got %d records", len(w.msg.Ns))
		}
	}

	if n := stub.count(); n != 1 {
		t.Fatalf("outbound requests = %d, want 1", n)
	}
}

// Past the outbound budget a cold label degrades to SERVFAIL with no outbound
// traffic — the flood shield, seen from the wire.
func TestServeDNS_ExhaustedBudgetIsServfail(t *testing.T) {
	stub := newAPIStub()
	t.Cleanup(stub.close)
	cfg := handlerConfig(stub.server.URL)
	cfg.UpstreamPerSecond = 1
	h := newHandler(cfg, newAPIClient(cfg))

	first := udpWriter()
	h.ServeDNS(first, query("cold-one."+testZone, dns.TypeTXT, 0, 0))
	if first.msg.Rcode != dns.RcodeNameError {
		t.Fatalf("first rcode = %s, want NXDOMAIN", dns.RcodeToString[first.msg.Rcode])
	}

	for i := range 10 {
		w := udpWriter()
		h.ServeDNS(w, query("cold-"+strings.Repeat("x", i+1)+"."+testZone, dns.TypeTXT, 0, 0))
		if w.msg.Rcode != dns.RcodeServerFailure {
			t.Fatalf("flood %d rcode = %s, want SERVFAIL", i, dns.RcodeToString[w.msg.Rcode])
		}
	}

	if n := stub.count(); n != 1 {
		t.Fatalf("outbound requests = %d, want 1", n)
	}
}

// Regression guard on the shared write path: the non-answer replies still go out.
func TestServeDNS_RefusalsAndApexStillAnswer(t *testing.T) {
	h, _ := newTestHandler(t, nil)

	out := udpWriter()
	h.ServeDNS(out, query("example.com.", dns.TypeTXT, 0, 0))
	if out.msg.Rcode != dns.RcodeRefused {
		t.Fatalf("out-of-zone rcode = %s, want REFUSED", dns.RcodeToString[out.msg.Rcode])
	}

	apex := udpWriter()
	h.ServeDNS(apex, query(testZone, dns.TypeSOA, 0, 0))
	if apex.msg.Rcode != dns.RcodeSuccess || len(apex.msg.Answer) != 1 {
		t.Fatalf("apex SOA: rcode %s, %d answers", dns.RcodeToString[apex.msg.Rcode], len(apex.msg.Answer))
	}
	if _, ok := apex.msg.Answer[0].(*dns.SOA); !ok {
		t.Fatalf("apex answer is %T, want *dns.SOA", apex.msg.Answer[0])
	}
}

func TestServeDNS_LiveLabelStillAnswers(t *testing.T) {
	stub := newAPIStub()
	t.Cleanup(stub.close)
	cfg := handlerConfig(stub.server.URL)
	api := newAPIClient(cfg)
	// Prime the live slot so the label answers without an outbound request.
	api.liveVal = liveInfo{On: true, Title: "Sector 12", URL: "https://twitch.tv/fluncle"}
	api.liveExp = time.Now().Add(time.Hour)
	h := newHandler(cfg, api)

	w := udpWriter()
	h.ServeDNS(w, query(liveLabel+"."+testZone, dns.TypeTXT, 0, 0))

	if w.msg.Rcode != dns.RcodeSuccess || len(w.msg.Answer) != 1 {
		t.Fatalf("live: rcode %s, %d answers", dns.RcodeToString[w.msg.Rcode], len(w.msg.Answer))
	}
	txt, ok := w.msg.Answer[0].(*dns.TXT)
	if !ok {
		t.Fatalf("live answer is %T, want *dns.TXT", w.msg.Answer[0])
	}
	if !strings.Contains(joined(txt.Txt), "live=1") {
		t.Fatalf("live payload = %q", joined(txt.Txt))
	}
	if w.msg.Truncated {
		t.Fatal("the live callout should fit a plain-UDP answer")
	}
}
