package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// errNotFound means the API answered cleanly that no such finding exists; the
// DNS handler turns this into NXDOMAIN.
var errNotFound = errors.New("finding not found")

// track is the subset of a Fluncle finding the DNS surface exposes. Field names
// match the public /api/tracks JSON.
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

// trackResponse is the envelope returned by GET /api/tracks/<id>.
type trackResponse struct {
	OK    bool   `json:"ok"`
	Track *track `json:"track"`
}

// listResponse is the envelope returned by GET /api/tracks (newest first).
type listResponse struct {
	Tracks []track `json:"tracks"`
}

// apiClient fetches findings from the Fluncle public API, with a small
// in-memory TTL cache so a hot coordinate (or a `dig` retry storm) does not
// hammer the API.
type apiClient struct {
	base string
	http *http.Client
	cache
}

func newAPIClient(base string, timeout, cacheTTL time.Duration) *apiClient {
	return &apiClient{
		base:  base,
		http:  &http.Client{Timeout: timeout},
		cache: cache{ttl: cacheTTL, entries: make(map[string]cacheEntry)},
	}
}

// lookup resolves a label (a coordinate, "random", or "latest") to a finding.
//
// DNS names are case-insensitive, but the Fluncle API treats a coordinate's
// trailing letter as case-significant (it wants the canonical uppercase form).
// So we canonicalise here: the reserved keywords match case-insensitively and
// route to their endpoints; everything else is treated as a coordinate and
// uppercased before hitting /api/tracks/<id>.
func (c *apiClient) lookup(label string) (*track, error) {
	lower := strings.ToLower(label)

	var key string
	switch lower {
	case "random", "latest":
		key = lower
	default:
		key = strings.ToUpper(label)
	}

	if t, ok := c.get(key); ok {
		return t, nil
	}

	t, err := c.fetch(key)
	if err != nil {
		return nil, err
	}
	// The short default CacheTTL keeps "random" lively while still shielding a
	// hot coordinate from a `dig` retry storm.
	c.set(key, t)
	return t, nil
}

func (c *apiClient) fetch(key string) (*track, error) {
	switch key {
	case "latest":
		return c.fetchLatest()
	default:
		// "random" and any coordinate are served by /api/tracks/<id>.
		return c.fetchByID(key)
	}
}

func (c *apiClient) fetchByID(id string) (*track, error) {
	u := fmt.Sprintf("%s/api/tracks/%s", c.base, url.PathEscape(id))
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
	u := fmt.Sprintf("%s/api/tracks?limit=1", c.base)
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

// cache is a tiny TTL map. The DNS server is low-QPS and single-zone, so a
// coarse global lock is plenty.
type cache struct {
	ttl     time.Duration
	mu      sync.Mutex
	entries map[string]cacheEntry
}

type cacheEntry struct {
	track   *track
	expires time.Time
}

func (c *cache) get(key string) (*track, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	e, ok := c.entries[key]
	if !ok || time.Now().After(e.expires) {
		if ok {
			delete(c.entries, key)
		}
		return nil, false
	}
	return e.track, true
}

func (c *cache) set(key string, t *track) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = cacheEntry{track: t, expires: time.Now().Add(c.ttl)}
}
