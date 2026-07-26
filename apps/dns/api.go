package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// errNotFound means the API answered cleanly that no such finding exists; the
// DNS handler turns this into NXDOMAIN.
var errNotFound = errors.New("finding not found")

// errUpstreamBusy means we declined to make an outbound API request because our
// own outbound budget is spent (see upstreamLimiter). The DNS handler turns this
// into SERVFAIL — deliberately our failure, not the API's, and never logged
// per-query so a flood cannot amplify into the journal either.
var errUpstreamBusy = errors.New("upstream budget exhausted")

// track is the subset of a Fluncle finding the DNS surface exposes. Field names
// match the public /api/v1/tracks JSON.
type track struct {
	LogID       string   `json:"logId"`
	Artists     []string `json:"artists"`
	Title       string   `json:"title"`
	Album       string   `json:"album"`
	BPM         float64  `json:"bpm"`
	Key         string   `json:"key"`
	ReleaseDate string   `json:"releaseDate"`
	AddedAt     string   `json:"addedAt"`
	LogPageURL  string   `json:"logPageUrl"`
	SpotifyURL  string   `json:"spotifyUrl"`
	Type        string   `json:"type"`
}

// trackResponse is the envelope returned by GET /api/v1/tracks/<id>.
type trackResponse struct {
	OK    bool   `json:"ok"`
	Track *track `json:"track"`
}

// listResponse is the envelope returned by GET /api/v1/findings (newest found first).
type listResponse struct {
	Tracks []track `json:"tracks"`
}

// liveInfo is the cross-surface live-set callout the DNS surface exposes (the
// `live` label). Whether Fluncle is on the decks right now, plus the public title
// and the Twitch url. Read off /api/v1/status `.live` (staleness already applied).
type liveInfo struct {
	On    bool
	Title string
	URL   string
}

// statusResponse is the subset of GET /api/v1/status the DNS surface reads — only the
// live-set callout block. `Live` is absent/nil on older payloads ⇒ treated offline.
type statusResponse struct {
	Live *struct {
		On    bool   `json:"on"`
		Title string `json:"title"`
		URL   string `json:"url"`
	} `json:"live"`
}

// apiClient fetches findings from the Fluncle public API, with a small
// in-memory TTL cache so a hot coordinate (or a `dig` retry storm) does not
// hammer the API.
//
// The cache holds VERDICTS, not just hits: a 404 and an upstream error are
// cached too (on their own shorter TTLs). An open UDP port that turns one
// nonsense label into one outbound API request is an amplifier, so a miss must
// be as cheap to repeat as a hit.
type apiClient struct {
	base    string
	http    *http.Client
	limiter *upstreamLimiter
	cache

	// A tiny separate TTL slot for the live-set callout (one global value, not
	// keyed like findings), so a `dig live` retry storm does not hammer /api/v1/status.
	liveMu  sync.Mutex
	liveVal liveInfo
	liveErr error
	liveExp time.Time
}

func newAPIClient(cfg config) *apiClient {
	return &apiClient{
		base:    cfg.APIBase,
		http:    &http.Client{Timeout: cfg.APITimeout},
		limiter: newUpstreamLimiter(cfg.MaxUpstreamInflight, cfg.UpstreamPerSecond),
		cache: cache{
			ttl:         cfg.CacheTTL,
			negativeTTL: cfg.NegativeCacheTTL,
			errorTTL:    cfg.ErrorCacheTTL,
			entries:     make(map[string]cacheEntry),
		},
	}
}

// lookup resolves a label (a coordinate, "random", or "latest") to a finding.
//
// DNS names are case-insensitive, but the Fluncle API treats a coordinate's
// trailing letter as case-significant (it wants the canonical uppercase form).
// So we canonicalise here: the reserved keywords match case-insensitively and
// route to their endpoints; everything else is treated as a coordinate and
// uppercased before hitting /api/v1/tracks/<id>.
func (c *apiClient) lookup(label string) (*track, error) {
	lower := strings.ToLower(label)

	var key string
	switch lower {
	case "random", "latest":
		key = lower
	default:
		key = strings.ToUpper(label)
	}

	// A cached verdict answers without an outbound request — including a cached
	// "no such finding" and a cached upstream error.
	if e, ok := c.get(key); ok {
		return e.track, e.err
	}

	// No cached verdict: this query wants an outbound request, so it has to fit
	// inside the outbound budget.
	t, err := c.fetchLimited(key)
	if err != nil {
		if errors.Is(err, errUpstreamBusy) {
			// A spent budget is NOT cached — it is our own back-pressure, not a
			// verdict about this label, and re-checking it is free.
			return nil, err
		}
		if !errors.Is(err, errNotFound) {
			// One line per REAL upstream failure. Logging here (at the cache
			// miss) rather than at the answer is deliberate: a cached failure
			// re-answers silently, so a query flood cannot amplify into the
			// journal, and the outbound budget bounds this line's rate too.
			log.Printf("lookup %q: %v", key, err)
		}
		// Cache the miss/error so a flood of distinct labels costs one request
		// per label per TTL window instead of one request per packet.
		c.setErr(key, err)
		return nil, err
	}
	// The short default CacheTTL keeps "random" lively while still shielding a
	// hot coordinate from a `dig` retry storm.
	c.set(key, t)
	return t, nil
}

// fetchLimited is the ONLY outbound path for a finding lookup: it reserves a
// slot in the outbound budget, releases it whatever happens, and returns
// errUpstreamBusy when there is nothing left to spend.
func (c *apiClient) fetchLimited(key string) (*track, error) {
	if err := c.limiter.acquire(); err != nil {
		return nil, err
	}
	defer c.limiter.release()
	return c.fetch(key)
}

func (c *apiClient) fetch(key string) (*track, error) {
	switch key {
	case "latest":
		return c.fetchLatest()
	default:
		// "random" and any coordinate are served by /api/v1/tracks/<id>.
		return c.fetchByID(key)
	}
}

func (c *apiClient) fetchByID(id string) (*track, error) {
	u := fmt.Sprintf("%s/api/v1/tracks/%s", c.base, url.PathEscape(id))
	body, status, err := c.do(u)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNotFound {
		return nil, errNotFound
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("api status %d for %s", status, id)
	}
	var resp trackResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("decode %s: %w", id, err)
	}
	if !resp.OK || resp.Track == nil {
		return nil, errNotFound
	}
	return resp.Track, nil
}

// fetchLatest returns the newest finding. The API has no /latest alias, so we
// read the default list (newest first) and take the head.
func (c *apiClient) fetchLatest() (*track, error) {
	u := fmt.Sprintf("%s/api/v1/findings?limit=1", c.base)
	body, status, err := c.do(u)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK {
		return nil, fmt.Errorf("api status %d for latest", status)
	}
	var resp listResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return nil, fmt.Errorf("decode latest: %w", err)
	}
	if len(resp.Tracks) == 0 {
		return nil, errNotFound
	}
	t := resp.Tracks[0]
	return &t, nil
}

// liveStatus returns the current live-set callout, reading /api/v1/status `.live`
// behind the small TTL cache. Offline (On=false) on any absent `live` block.
// Failures are cached on the short error TTL for the same reason findings misses
// are: a `dig live` storm during an API blip must not become a request storm.
func (c *apiClient) liveStatus() (liveInfo, error) {
	c.liveMu.Lock()
	if time.Now().Before(c.liveExp) {
		v, err := c.liveVal, c.liveErr
		c.liveMu.Unlock()
		return v, err
	}
	c.liveMu.Unlock()

	info, err := c.fetchLiveLimited()
	if errors.Is(err, errUpstreamBusy) {
		// Back-pressure, not a verdict: leave the slot's TTL alone so the next
		// query re-probes as soon as the budget allows.
		return liveInfo{}, err
	}
	if err != nil {
		log.Printf("live lookup: %v", err)
	}

	c.liveMu.Lock()
	c.liveVal, c.liveErr = info, err
	if err != nil {
		c.liveExp = time.Now().Add(c.errorTTL)
	} else {
		c.liveExp = time.Now().Add(c.ttl)
	}
	c.liveMu.Unlock()
	return info, err
}

func (c *apiClient) fetchLiveLimited() (liveInfo, error) {
	if err := c.limiter.acquire(); err != nil {
		return liveInfo{}, err
	}
	defer c.limiter.release()
	return c.fetchLive()
}

func (c *apiClient) fetchLive() (liveInfo, error) {
	u := fmt.Sprintf("%s/api/v1/status", c.base)
	body, status, err := c.do(u)
	if err != nil {
		return liveInfo{}, err
	}
	if status != http.StatusOK {
		return liveInfo{}, fmt.Errorf("api status %d for live", status)
	}
	var resp statusResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return liveInfo{}, fmt.Errorf("decode live: %w", err)
	}

	info := liveInfo{}
	if resp.Live != nil {
		info = liveInfo{On: resp.Live.On, Title: resp.Live.Title, URL: resp.Live.URL}
	}
	return info, nil
}

func (c *apiClient) do(u string) ([]byte, int, error) {
	req, err := http.NewRequest(http.MethodGet, u, nil)
	if err != nil {
		return nil, 0, err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "fluncle-dns/1 (+https://www.fluncle.com)")
	res, err := c.http.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return nil, res.StatusCode, err
	}
	return body, res.StatusCode, nil
}

// maxCacheEntries bounds the cache so negative caching cannot be turned around
// into a memory-growth vector: a flood of distinct nonsense labels would
// otherwise mint an entry each. At the cap we drop expired entries first, then
// let a real finding evict one junk verdict; a junk verdict that finds no room is
// simply not cached, which only means the label is re-fetched later — and the
// outbound budget already bounds that.
const maxCacheEntries = 4096

// cache is a tiny TTL map of lookup VERDICTS — a finding, a confirmed absence,
// or an upstream failure — each on its own TTL. The DNS server is low-QPS and
// single-zone, so a coarse global lock is plenty.
type cache struct {
	// ttl holds a successful lookup.
	ttl time.Duration
	// negativeTTL holds a confirmed "no such finding" (errNotFound).
	negativeTTL time.Duration
	// errorTTL holds an upstream failure; shorter, so a blip clears fast.
	errorTTL time.Duration
	mu       sync.Mutex
	entries  map[string]cacheEntry
}

// cacheEntry is one cached verdict: exactly one of track/err is meaningful.
// err == nil is a hit; err == errNotFound is a confirmed absence (NXDOMAIN);
// any other err is a cached upstream failure (SERVFAIL).
type cacheEntry struct {
	track   *track
	err     error
	expires time.Time
}

func (c *cache) get(key string) (cacheEntry, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || time.Now().After(e.expires) {
		if ok {
			delete(c.entries, key)
		}
		return cacheEntry{}, false
	}
	return e, true
}

func (c *cache) set(key string, t *track) {
	c.store(key, cacheEntry{track: t, expires: time.Now().Add(c.ttl)})
}

// setErr caches a failed lookup. A clean 404 gets the negative TTL; anything
// else (timeout, 5xx, undecodable body) gets the shorter error TTL. Never called
// with errUpstreamBusy — that is our own back-pressure, not a verdict.
func (c *cache) setErr(key string, err error) {
	ttl := c.errorTTL
	if errors.Is(err, errNotFound) {
		ttl = c.negativeTTL
	}
	c.store(key, cacheEntry{err: err, expires: time.Now().Add(ttl)})
}

func (c *cache) store(key string, e cacheEntry) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if _, exists := c.entries[key]; !exists && len(c.entries) >= maxCacheEntries {
		c.purgeExpiredLocked()
		if len(c.entries) >= maxCacheEntries {
			// Still full: a real finding may evict one junk verdict, so a flood
			// of nonsense labels cannot lock the cache against real traffic. A
			// junk verdict itself is simply not cached.
			if e.err != nil || !c.evictOneNegativeLocked() {
				return
			}
		}
	}
	c.entries[key] = e
}

// evictOneNegativeLocked drops a single negative/error entry, reporting whether
// it found one. Map iteration order is random, which is the eviction policy: any
// junk verdict is as good to lose as another.
func (c *cache) evictOneNegativeLocked() bool {
	for k, e := range c.entries {
		if e.err != nil {
			delete(c.entries, k)
			return true
		}
	}
	return false
}

func (c *cache) purgeExpiredLocked() {
	now := time.Now()
	for k, e := range c.entries {
		if now.After(e.expires) {
			delete(c.entries, k)
		}
	}
}

// upstreamBudgetWindow is the span the per-second outbound budget resets over.
const upstreamBudgetWindow = time.Second

// upstreamWaitTimeout bounds how long a query waits for an in-flight slot before
// giving up with errUpstreamBusy. Well under a stub resolver's own timeout, so a
// busy server answers SERVFAIL rather than leaving the client hanging.
const upstreamWaitTimeout = 2 * time.Second

// upstreamLimiter bounds outbound Fluncle API requests two ways: a semaphore on
// how many may be in flight at once, and a budget on how many may START per
// second. Together they cap the amplification an unauthenticated UDP flood can
// aim at the Worker: past the budget, lookups degrade to SERVFAIL (and cached
// NXDOMAIN for labels already ruled on) with no outbound traffic at all.
type upstreamLimiter struct {
	sem chan struct{}

	mu          sync.Mutex
	perSecond   int
	windowStart time.Time
	spent       int
}

func newUpstreamLimiter(maxInflight, perSecond int) *upstreamLimiter {
	// A non-positive configured value would mean "unbounded", which is the very
	// thing this exists to prevent — fall back to the defaults instead.
	if maxInflight <= 0 {
		maxInflight = 4
	}
	if perSecond <= 0 {
		perSecond = 20
	}
	return &upstreamLimiter{
		sem:       make(chan struct{}, maxInflight),
		perSecond: perSecond,
	}
}

// acquire reserves one outbound request. It returns errUpstreamBusy instead of
// queueing without bound, so back-pressure surfaces as a fast SERVFAIL rather
// than as a pile of parked goroutines. Every successful acquire must be paired
// with a release.
func (l *upstreamLimiter) acquire() error {
	l.mu.Lock()
	now := time.Now()
	if now.Sub(l.windowStart) >= upstreamBudgetWindow {
		l.windowStart = now
		l.spent = 0
	}
	if l.spent >= l.perSecond {
		l.mu.Unlock()
		return errUpstreamBusy
	}
	l.spent++
	l.mu.Unlock()

	select {
	case l.sem <- struct{}{}:
		return nil
	case <-time.After(upstreamWaitTimeout):
		// Budget already counted: a saturated server should stay conservative
		// until the window rolls, not immediately try again.
		return errUpstreamBusy
	}
}

func (l *upstreamLimiter) release() {
	<-l.sem
}
