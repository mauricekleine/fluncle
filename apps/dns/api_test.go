package main

import (
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// The DNS surface is an open UDP port in front of the public API, so a MISS has
// to be as cheap to repeat as a HIT: without negative caching every distinct
// nonsense label is one outbound request, and one spoofed packet becomes one
// hit on the Worker. These tests pin both halves of the shield — the cached
// verdicts and the outbound budget — plus the allow path (real traffic still
// resolves, and a cached finding still answers when the budget is spent).

// apiStub is an httptest stand-in for the Fluncle public API that counts every
// request it receives, so a test can assert an absence of outbound traffic.
type apiStub struct {
	server   *httptest.Server
	requests atomic.Int64
}

// newAPIStub answers by coordinate: "OK" and "OK2" are findings, "MISSING" is a
// clean 404, "BOOM" is a 5xx, "GARBAGE" is an undecodable body. Any other
// coordinate 404s, so a flood of random labels behaves like the real thing.
func newAPIStub() *apiStub {
	stub := &apiStub{}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/v1/tracks/", func(w http.ResponseWriter, r *http.Request) {
		stub.requests.Add(1)
		id := strings.TrimPrefix(r.URL.Path, "/api/v1/tracks/")
		switch id {
		case "OK", "OK2":
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"ok":true,"track":{"logId":%q,"artists":["A"],"title":"T"}}`, id)
		case "BOOM":
			w.WriteHeader(http.StatusInternalServerError)
		case "GARBAGE":
			fmt.Fprint(w, "not json")
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	})
	stub.server = httptest.NewServer(mux)
	return stub
}

func (s *apiStub) close() { s.server.Close() }

func (s *apiStub) count() int64 { return s.requests.Load() }

// testConfig is the shape loadConfig() produces, with generous TTLs and budget
// so a test only exercises the knob it is about.
func testConfig(base string) config {
	return config{
		APIBase:             base,
		APITimeout:          2 * time.Second,
		CacheTTL:            time.Hour,
		NegativeCacheTTL:    time.Hour,
		ErrorCacheTTL:       time.Hour,
		MaxUpstreamInflight: 4,
		UpstreamPerSecond:   100,
		MaxUDPSize:          1232,
	}
}

func TestLookup_CachesEveryVerdict(t *testing.T) {
	cases := []struct {
		name    string
		label   string
		wantErr error
	}{
		{name: "hit", label: "OK", wantErr: nil},
		{name: "confirmed absence", label: "MISSING", wantErr: errNotFound},
		{name: "upstream 5xx", label: "BOOM"},
		{name: "undecodable body", label: "GARBAGE"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := newAPIStub()
			defer stub.close()
			api := newAPIClient(testConfig(stub.server.URL))

			// Three identical lookups must cost exactly ONE outbound request —
			// the amplification shield.
			for i := range 3 {
				got, err := api.lookup(tc.label)
				switch {
				case tc.wantErr != nil:
					if !errors.Is(err, tc.wantErr) {
						t.Fatalf("lookup %d: got err %v, want %v", i, err, tc.wantErr)
					}
				case tc.label == "OK":
					if err != nil {
						t.Fatalf("lookup %d: %v", i, err)
					}
					if got == nil || got.LogID != "OK" {
						t.Fatalf("lookup %d: got %v, want the OK finding", i, got)
					}
				default:
					// An upstream failure: any error, cached all the same.
					if err == nil {
						t.Fatalf("lookup %d: want an error, got %v", i, got)
					}
				}
			}

			if n := stub.count(); n != 1 {
				t.Fatalf("outbound requests = %d, want 1 (verdict not cached)", n)
			}
		})
	}
}

func TestLookup_CachedVerdictExpires(t *testing.T) {
	cases := []struct {
		name  string
		label string
		// tune shortens exactly one TTL so the test proves that TTL is the one
		// governing this verdict.
		tune func(*config)
	}{
		{
			name:  "absence expires on the negative TTL",
			label: "MISSING",
			tune:  func(c *config) { c.NegativeCacheTTL = time.Millisecond },
		},
		{
			name:  "upstream failure expires on the error TTL",
			label: "BOOM",
			tune:  func(c *config) { c.ErrorCacheTTL = time.Millisecond },
		},
		{
			name:  "hit expires on the cache TTL",
			label: "OK",
			tune:  func(c *config) { c.CacheTTL = time.Millisecond },
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			stub := newAPIStub()
			defer stub.close()
			cfg := testConfig(stub.server.URL)
			tc.tune(&cfg)
			api := newAPIClient(cfg)

			_, _ = api.lookup(tc.label)
			if n := stub.count(); n != 1 {
				t.Fatalf("first lookup made %d requests, want 1", n)
			}

			time.Sleep(10 * time.Millisecond)

			_, _ = api.lookup(tc.label)
			if n := stub.count(); n != 2 {
				t.Fatalf("after expiry: %d requests, want 2 (entry never expired)", n)
			}
		})
	}
}

// The two negative TTLs are separate knobs: an error must be re-probed sooner
// than a confirmed absence, and shortening one must not shorten the other.
func TestLookup_ErrorTTLIsIndependentOfNegativeTTL(t *testing.T) {
	stub := newAPIStub()
	defer stub.close()
	cfg := testConfig(stub.server.URL)
	cfg.NegativeCacheTTL = time.Hour
	cfg.ErrorCacheTTL = time.Millisecond
	api := newAPIClient(cfg)

	_, _ = api.lookup("MISSING")
	_, _ = api.lookup("BOOM")
	if n := stub.count(); n != 2 {
		t.Fatalf("priming made %d requests, want 2", n)
	}

	time.Sleep(10 * time.Millisecond)

	// The error re-probes…
	_, _ = api.lookup("BOOM")
	if n := stub.count(); n != 3 {
		t.Fatalf("error entry did not re-probe: %d requests, want 3", n)
	}
	// …while the confirmed absence stays cached.
	_, _ = api.lookup("MISSING")
	if n := stub.count(); n != 3 {
		t.Fatalf("negative entry expired early: %d requests, want 3", n)
	}
}

// A random-label flood past the budget must stop generating outbound traffic
// altogether — SERVFAIL from our own limiter, not load on the API.
func TestLookup_FloodStopsAtTheOutboundBudget(t *testing.T) {
	stub := newAPIStub()
	defer stub.close()
	cfg := testConfig(stub.server.URL)
	cfg.UpstreamPerSecond = 3
	api := newAPIClient(cfg)

	var busy int
	for i := range 25 {
		if _, err := api.lookup(fmt.Sprintf("RANDOM%d", i)); errors.Is(err, errUpstreamBusy) {
			busy++
		}
	}

	if n := stub.count(); n != 3 {
		t.Fatalf("outbound requests = %d, want 3 (the budget did not bind)", n)
	}
	if busy != 22 {
		t.Fatalf("busy verdicts = %d, want 22", busy)
	}
}

// The allow path: legitimate resolution must survive a flood. A coordinate
// already in the cache answers with no outbound request at all, so a hot
// finding keeps resolving while the budget is spent.
func TestLookup_CachedFindingSurvivesAnExhaustedBudget(t *testing.T) {
	stub := newAPIStub()
	defer stub.close()
	cfg := testConfig(stub.server.URL)
	cfg.UpstreamPerSecond = 1
	api := newAPIClient(cfg)

	if _, err := api.lookup("OK"); err != nil {
		t.Fatalf("priming the finding: %v", err)
	}
	// Budget now spent: a cold label is refused…
	if _, err := api.lookup("OK2"); !errors.Is(err, errUpstreamBusy) {
		t.Fatalf("cold lookup: got %v, want errUpstreamBusy", err)
	}
	// …and the cached finding still resolves.
	got, err := api.lookup("ok")
	if err != nil || got == nil || got.LogID != "OK" {
		t.Fatalf("cached lookup: got (%v, %v), want the OK finding", got, err)
	}
	if n := stub.count(); n != 1 {
		t.Fatalf("outbound requests = %d, want 1", n)
	}
}

// The journal is a resource too: a failure must be logged once per real
// upstream miss, never once per query, or a flood amplifies into the log.
func TestLookup_LogsOncePerUpstreamMissAndNeverForAbsence(t *testing.T) {
	stub := newAPIStub()
	defer stub.close()
	api := newAPIClient(testConfig(stub.server.URL))

	var logged strings.Builder
	log.SetOutput(&logged)
	log.SetFlags(0)
	defer func() {
		log.SetOutput(os.Stderr)
		log.SetFlags(log.LstdFlags)
	}()

	for range 5 {
		_, _ = api.lookup("BOOM")
		_, _ = api.lookup("MISSING")
	}

	lines := strings.Count(logged.String(), "\n")
	if lines != 1 {
		t.Fatalf("log lines = %d, want 1:\n%s", lines, logged.String())
	}
	if !strings.Contains(logged.String(), `lookup "BOOM"`) {
		t.Fatalf("the one line should name the failing lookup, got: %s", logged.String())
	}
	// A clean 404 is a normal answer, not an incident: it must not log at all.
	if strings.Contains(logged.String(), "MISSING") {
		t.Fatalf("a confirmed absence was logged: %s", logged.String())
	}
}

func TestUpstreamLimiter_BudgetRollsWithTheWindow(t *testing.T) {
	l := newUpstreamLimiter(2, 1)

	if err := l.acquire(); err != nil {
		t.Fatalf("first acquire: %v", err)
	}
	l.release()
	if err := l.acquire(); !errors.Is(err, errUpstreamBusy) {
		t.Fatalf("second acquire in the same window: got %v, want errUpstreamBusy", err)
	}

	// Roll the window rather than sleeping through it.
	l.mu.Lock()
	l.windowStart = time.Now().Add(-2 * upstreamBudgetWindow)
	l.mu.Unlock()

	if err := l.acquire(); err != nil {
		t.Fatalf("acquire after the window rolled: %v", err)
	}
	l.release()
}

// A misconfigured (zero/negative) knob must fall back to the defaults, never to
// "unbounded" — the guard fails closed.
func TestUpstreamLimiter_MisconfiguredFallsBackToDefaults(t *testing.T) {
	l := newUpstreamLimiter(0, -1)

	if got := cap(l.sem); got != 4 {
		t.Fatalf("inflight cap = %d, want the default 4", got)
	}
	if l.perSecond != 20 {
		t.Fatalf("perSecond = %d, want the default 20", l.perSecond)
	}
	if err := l.acquire(); err != nil {
		t.Fatalf("acquire on a defaulted limiter: %v", err)
	}
	l.release()
}

// Negative caching must not become a memory-growth vector of its own: a flood of
// distinct labels is bounded by maxCacheEntries.
func TestCache_IsBounded(t *testing.T) {
	c := cache{
		ttl:         time.Hour,
		negativeTTL: time.Hour,
		errorTTL:    time.Hour,
		entries:     make(map[string]cacheEntry),
	}

	for i := range maxCacheEntries + 500 {
		c.setErr(fmt.Sprintf("LABEL%d", i), errNotFound)
	}

	if got := len(c.entries); got > maxCacheEntries {
		t.Fatalf("cache grew to %d entries, want <= %d", got, maxCacheEntries)
	}
}

// A cache filled to the cap with junk must still admit a real finding, or a
// flood could lock legitimate coordinates out of the cache for a whole TTL.
func TestCache_RealFindingEvictsJunkAtTheCap(t *testing.T) {
	c := cache{
		ttl:         time.Hour,
		negativeTTL: time.Hour,
		errorTTL:    time.Hour,
		entries:     make(map[string]cacheEntry),
	}

	for i := range maxCacheEntries + 500 {
		c.setErr(fmt.Sprintf("LABEL%d", i), errNotFound)
	}

	c.set("011.1.6E", &track{LogID: "011.1.6E"})

	e, ok := c.get("011.1.6E")
	if !ok || e.track == nil || e.track.LogID != "011.1.6E" {
		t.Fatal("a real finding could not be cached while the cache was full of junk")
	}
	if got := len(c.entries); got > maxCacheEntries {
		t.Fatalf("cache grew to %d entries, want <= %d", got, maxCacheEntries)
	}
}

// An expired entry at the cap is reclaimed, so a quiet period after a flood
// leaves room for real coordinates again.
func TestCache_ReclaimsExpiredEntriesAtTheCap(t *testing.T) {
	c := cache{
		ttl:         time.Hour,
		negativeTTL: time.Millisecond,
		errorTTL:    time.Millisecond,
		entries:     make(map[string]cacheEntry),
	}

	for i := range maxCacheEntries {
		c.setErr(fmt.Sprintf("LABEL%d", i), errNotFound)
	}
	time.Sleep(10 * time.Millisecond)

	c.set("011.1.6E", &track{LogID: "011.1.6E"})

	if _, ok := c.get("011.1.6E"); !ok {
		t.Fatal("a real coordinate could not be cached after the flood expired")
	}
}

func TestLiveStatus_CachesBothVerdicts(t *testing.T) {
	cases := []struct {
		name    string
		status  int
		body    string
		wantOn  bool
		wantErr bool
	}{
		{name: "live", status: http.StatusOK, body: `{"live":{"on":true,"url":"u"}}`, wantOn: true},
		{name: "offline", status: http.StatusOK, body: `{}`},
		{name: "upstream failure", status: http.StatusBadGateway, body: "", wantErr: true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var requests atomic.Int64
			server := httptest.NewServer(http.HandlerFunc(
				func(w http.ResponseWriter, _ *http.Request) {
					requests.Add(1)
					w.WriteHeader(tc.status)
					fmt.Fprint(w, tc.body)
				}))
			defer server.Close()

			api := newAPIClient(testConfig(server.URL))

			for i := range 3 {
				info, err := api.liveStatus()
				if tc.wantErr && err == nil {
					t.Fatalf("call %d: want an error", i)
				}
				if !tc.wantErr {
					if err != nil {
						t.Fatalf("call %d: %v", i, err)
					}
					if info.On != tc.wantOn {
						t.Fatalf("call %d: on = %v, want %v", i, info.On, tc.wantOn)
					}
				}
			}

			if n := requests.Load(); n != 1 {
				t.Fatalf("outbound /api/v1/status requests = %d, want 1", n)
			}
		})
	}
}

func TestLiveStatus_RespectsTheOutboundBudget(t *testing.T) {
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer server.Close()

	cfg := testConfig(server.URL)
	cfg.UpstreamPerSecond = 1
	// A zero error TTL means every call is a cache miss, so only the budget can
	// hold the flood back.
	cfg.ErrorCacheTTL = 0
	api := newAPIClient(cfg)

	for range 5 {
		if _, err := api.liveStatus(); err == nil {
			t.Fatal("want an error while upstream is failing")
		}
	}

	if n := requests.Load(); n != 1 {
		t.Fatalf("outbound requests = %d, want 1 (the budget did not bind)", n)
	}
}
