package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"charm.land/wish/v2"
	"charm.land/wish/v2/activeterm"
	"charm.land/wish/v2/bubbletea"
	"charm.land/wish/v2/logging"
	"github.com/charmbracelet/ssh"
	"github.com/mdp/qrterminal/v3"
	"github.com/oschwald/maxminddb-golang/v2"
	"rsc.io/qr"
)

const defaultAPIURL = "https://www.fluncle.com"

// The Galaxy's link map (docs/socials/). URLs are verbatim; the handle is
// lowercase fluncle everywhere (VOICE.md §6). Surfaced on the About screen.
const (
	websiteURL         = "https://www.fluncle.com"
	galaxyURL          = "https://galaxy.fluncle.com"
	sshConnect         = "ssh rave.fluncle.com"
	spotifyPlaylistURL = "https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0"
	mixcloudURL        = "https://www.mixcloud.com/fluncle/"
	youtubeURL         = "https://www.youtube.com/@fluncle"
	tiktokURL          = "https://www.tiktok.com/@fluncle"
	instagramURL       = "https://www.instagram.com/fluncle/"
	telegramURL        = "https://t.me/fluncle"
	rssURL             = "https://www.fluncle.com/rss.xml"
	sourceURL          = "https://github.com/mauricekleine/fluncle"
	dbipURL            = "https://db-ip.com"
)

type config struct {
	apiURL      string
	host        string
	port        string
	dataDir     string
	geoIPDBPath string
}

type app struct {
	cfg        config
	nextID     atomic.Int64
	client     *http.Client
	geoIP      *maxminddb.Reader
	raversMu   sync.RWMutex
	raverCodes map[int64]string
}

func main() {
	cfg := loadConfig()
	if err := ensureDataDir(cfg.dataDir); err != nil {
		fatal("could not prepare data directory", err)
	}
	geoIP, err := openGeoIP(cfg.geoIPDBPath)
	if err != nil {
		fatal("could not open GeoIP database", err)
	}
	if geoIP != nil {
		defer geoIP.Close()
	}

	app := &app{
		cfg:   cfg,
		geoIP: geoIP,
		client: &http.Client{
			Timeout: 12 * time.Second,
		},
		raverCodes: make(map[int64]string),
	}

	server, err := wish.NewServer(
		wish.WithAddress(net.JoinHostPort(cfg.host, cfg.port)),
		wish.WithHostKeyPath(hostKeyPath(cfg.dataDir)),
		wish.WithMiddleware(
			logging.Middleware(),
			activeterm.Middleware(),
			bubbletea.Middleware(app.teaHandler),
			app.sessionCountMiddleware,
			app.routeCommandMiddleware,
		),
	)
	if err != nil {
		fatal("could not create SSH server", err)
	}

	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		fmt.Printf("fluncle-ssh listening on %s\n", net.JoinHostPort(cfg.host, cfg.port))
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, ssh.ErrServerClosed) {
			fmt.Fprintf(os.Stderr, "server error: %v\n", err)
			done <- syscall.SIGTERM
		}
	}()

	<-done
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = server.Shutdown(ctx)
}

func loadConfig() config {
	return config{
		apiURL:      strings.TrimRight(env("FLUNCLE_API_URL", defaultAPIURL), "/"),
		host:        env("FLUNCLE_SSH_HOST", "127.0.0.1"),
		port:        env("FLUNCLE_SSH_PORT", "2222"),
		dataDir:     env("FLUNCLE_SSH_DATA_DIR", ".local"),
		geoIPDBPath: strings.TrimSpace(os.Getenv("FLUNCLE_GEOIP_DB")),
	}
}

func env(key, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}

// bootKind is the deep-link the SSH command argument resolves to: which opening
// screen the terminal lands on instead of the menu.
type bootKind int

const (
	bootMenu    bootKind = iota // no command: the interactive menu (unchanged)
	bootLatest                  // `latest`: the latest finding's detail
	bootRandom                  // `random`: a random finding's detail
	bootCoord                   // `<coord>`: a Log ID's finding (or mixtape) detail
	bootUnknown                 // anything else: a deep-register line, then the menu
)

// bootCommand is the parsed boot target carried from the SSH command args to the
// model. coord holds the requested Log ID for bootCoord; raw is the original
// argument, surfaced in the unknown-command line.
type bootCommand struct {
	kind  bootKind
	coord string
	raw   string
}

// parseBootCommand reads the SSH command args (everything after the host) and
// resolves the opening screen. The deep links are `latest`, `random`, and a bare
// Log ID coordinate (e.g. 004.7.2I, or the F-marked 019.F.1A). Empty args keep
// the menu; anything else is unknown.
func parseBootCommand(args []string) bootCommand {
	raw := strings.TrimSpace(strings.Join(args, " "))
	if raw == "" {
		return bootCommand{kind: bootMenu}
	}
	switch strings.ToLower(raw) {
	case "latest":
		return bootCommand{kind: bootLatest, raw: raw}
	case "random":
		return bootCommand{kind: bootRandom, raw: raw}
	}
	if looksLikeLogID(raw) {
		return bootCommand{kind: bootCoord, coord: raw, raw: raw}
	}
	return bootCommand{kind: bootUnknown, raw: raw}
}

// looksLikeLogID is the on-sight test for a Log ID coordinate: the XXX.Y.ZZ
// shape (three dot-separated parts, alphanumerics only). The middle slot may be
// the literal F marker of a mixtape; the resolver decides finding vs mixtape.
func looksLikeLogID(s string) bool {
	parts := strings.Split(s, ".")
	if len(parts) != 3 {
		return false
	}
	for _, part := range parts {
		if part == "" {
			return false
		}
		for _, r := range part {
			isDigit := r >= '0' && r <= '9'
			isUpper := r >= 'A' && r <= 'Z'
			isLower := r >= 'a' && r <= 'z'
			if !isDigit && !isUpper && !isLower {
				return false
			}
		}
	}
	return true
}

// routeCommandMiddleware turns the SSH command argument into a deep link. With a
// PTY (ssh -t host latest) the args ride into teaHandler and boot the interactive
// TUI on the requested screen. Without a PTY (bare ssh host latest) the TUI has no
// terminal to draw on, so the same page renders once as a clean printed view and
// the session closes. A bare connection with no args falls through to the menu.
func (a *app) routeCommandMiddleware(next ssh.Handler) ssh.Handler {
	return func(sess ssh.Session) {
		boot := parseBootCommand(sess.Command())
		_, _, hasPTY := sess.Pty()
		if boot.kind != bootMenu && !hasPTY {
			a.renderNonInteractive(sess, boot)
			return
		}
		next(sess)
	}
}

// renderNonInteractive prints one clean page for a deep link when there's no PTY
// to run the TUI on (bare ssh host latest). It fetches the same finding/mixtape
// the interactive boot would and writes the printed detail, then returns so the
// session closes. Recovered-terminal register, no exclamation marks (VOICE.md).
func (a *app) renderNonInteractive(sess ssh.Session, boot bootCommand) {
	width := 80
	if pty, _, ok := sess.Pty(); ok && pty.Window.Width > 0 {
		width = pty.Window.Width
	}
	m := newModelWithBoot(a, width, 0, boot)
	_, _ = io.WriteString(sess, m.renderPrinted()+"\n")
}

func (a *app) sessionCountMiddleware(next ssh.Handler) ssh.Handler {
	return func(sess ssh.Session) {
		sessionID := a.addRaver(a.countryCodeForSession(sess))
		defer a.removeRaver(sessionID)
		next(sess)
	}
}

func (a *app) teaHandler(sess ssh.Session) (tea.Model, []tea.ProgramOption) {
	pty, _, _ := sess.Pty()
	boot := parseBootCommand(sess.Command())
	model := newModelWithBoot(a, pty.Window.Width, pty.Window.Height, boot)
	return model, []tea.ProgramOption{}
}

func ensureDataDir(dataDir string) error {
	return os.MkdirAll(dataDir, 0700)
}

func hostKeyPath(dataDir string) string {
	return filepath.Join(dataDir, "ssh_host_ed25519_key")
}

func openGeoIP(path string) (*maxminddb.Reader, error) {
	if path == "" {
		return nil, nil
	}
	return maxminddb.Open(path)
}

func (a *app) addRaver(countryCode string) int64 {
	sessionID := a.nextID.Add(1)
	a.raversMu.Lock()
	defer a.raversMu.Unlock()
	a.raverCodes[sessionID] = countryCode
	return sessionID
}

func (a *app) removeRaver(sessionID int64) {
	a.raversMu.Lock()
	defer a.raversMu.Unlock()
	delete(a.raverCodes, sessionID)
}

func (a *app) connectedRaverCount() int {
	a.raversMu.RLock()
	defer a.raversMu.RUnlock()
	return len(a.raverCodes)
}

func (a *app) raverCountrySummary() string {
	a.raversMu.RLock()
	defer a.raversMu.RUnlock()

	counts := make(map[string]int)
	for _, code := range a.raverCodes {
		counts[code]++
	}

	if len(counts) == 0 {
		return ""
	}

	codes := make([]string, 0, len(counts))
	for code := range counts {
		codes = append(codes, code)
	}
	sort.Slice(codes, func(i, j int) bool {
		if codes[i] == "VOID" {
			return false
		}
		if codes[j] == "VOID" {
			return true
		}
		return codes[i] < codes[j]
	})

	parts := make([]string, 0, len(codes))
	for _, code := range codes {
		count := counts[code]
		if count > 1 {
			parts = append(parts, fmt.Sprintf("%s (%d)", code, count))
			continue
		}
		parts = append(parts, code)
	}

	return strings.Join(parts, "  ")
}

func (a *app) countryCodeForSession(sess ssh.Session) string {
	host, _, err := net.SplitHostPort(sess.RemoteAddr().String())
	if err != nil {
		host = sess.RemoteAddr().String()
	}

	addr, err := netip.ParseAddr(host)
	if err != nil || !isPublicAddr(addr) || a.geoIP == nil {
		return "VOID"
	}

	var result struct {
		Country struct {
			ISOCode string `maxminddb:"iso_code"`
		} `maxminddb:"country"`
		RegisteredCountry struct {
			ISOCode string `maxminddb:"iso_code"`
		} `maxminddb:"registered_country"`
	}

	if err := a.geoIP.Lookup(addr).Decode(&result); err != nil {
		return "VOID"
	}

	code := result.Country.ISOCode
	if code == "" {
		code = result.RegisteredCountry.ISOCode
	}

	return normalizeCountryCode(code)
}

func isPublicAddr(addr netip.Addr) bool {
	return addr.IsGlobalUnicast() &&
		!addr.IsPrivate() &&
		!addr.IsLoopback() &&
		!addr.IsLinkLocalUnicast() &&
		!addr.IsLinkLocalMulticast()
}

func normalizeCountryCode(code string) string {
	code = strings.ToUpper(strings.TrimSpace(code))
	if code == "" {
		return "VOID"
	}
	if code == "GB" {
		return "UK"
	}
	return code
}

type screen string

const (
	screenMenu          screen = "menu"
	screenLatest        screen = "latest"
	screenDetail        screen = "detail"
	screenArtists       screen = "artists"
	screenGalaxies      screen = "galaxies"
	screenGalaxyDetail  screen = "galaxy-detail"
	screenMixtapes      screen = "mixtapes"
	screenMixtapeDetail screen = "mixtape-detail"
	screenSearchInput   screen = "search-input"
	screenSearch        screen = "search"
	screenNoteInput     screen = "note-input"
	screenContactInput  screen = "contact-input"
	screenConfirm       screen = "confirm"
	screenSubscribe     screen = "subscribe"
	screenSubscribed    screen = "subscribed"
	screenStatus        screen = "status"
	screenInstall       screen = "install"
	screenAbout         screen = "about"
	screenMessage       screen = "message"
)

type model struct {
	app            *app
	boot           bootCommand
	width          int
	height         int
	screen         screen
	selected       int
	tracks         []track
	artists        []artist
	galaxies       []galaxyItem
	galaxyTracks   []track
	mixtapes       []mixtape
	total          int
	footer         *track
	results        []searchResult
	current        *track
	currentGalaxy  *galaxyItem
	currentMixtape *mixtape
	detailBack     screen
	pending        *searchResult
	input          string
	note           string
	contact        string
	message        string
	status         *statusReport
	live           *liveState
	loading        bool
	err            string
	scroll         int
}

type track struct {
	TrackID          string   `json:"trackId"`
	LogID            string   `json:"logId,omitempty"`
	SpotifyURL       string   `json:"spotifyUrl"`
	Title            string   `json:"title"`
	Artists          []string `json:"artists"`
	Album            string   `json:"album,omitempty"`
	AlbumImageURL    string   `json:"albumImageUrl,omitempty"`
	Label            string   `json:"label,omitempty"`
	ISRC             string   `json:"isrc,omitempty"`
	Tags             []string `json:"tags,omitempty"`
	DurationMs       int      `json:"durationMs,omitempty"`
	Popularity       int      `json:"popularity,omitempty"`
	PreviewURL       string   `json:"previewUrl,omitempty"`
	Note             string   `json:"note,omitempty"`
	AddedAt          string   `json:"addedAt"`
	AddedToSpotify   bool     `json:"addedToSpotify"`
	PostedToTelegram bool     `json:"postedToTelegram"`
}

type artist struct {
	Name         string `json:"name"`
	Slug         string `json:"slug"`
	FindingCount int    `json:"findingCount"`
	SpotifyURL   string `json:"spotifyUrl,omitempty"`
}

// galaxyItem is one operator-named sonic galaxy off the public /api/v1/galaxies
// read (browse-by-feel): the display name, its slug, and the derived member count.
// The launch gate means this list is empty until the operator has named the whole
// map, so the screen simply shows "no galaxies charted yet" until then.
type galaxyItem struct {
	Name        string `json:"name"`
	Slug        string `json:"slug"`
	MemberCount int    `json:"memberCount"`
}

type mixtape struct {
	LogID         string `json:"logId,omitempty"`
	Title         string `json:"title"`
	Note          string `json:"note,omitempty"`
	CoverImageURL string `json:"coverImageUrl,omitempty"`
	DurationMs    int    `json:"durationMs,omitempty"`
	MemberCount   int    `json:"memberCount"`
	RecordedAt    string `json:"recordedAt,omitempty"`
	AddedAt       string `json:"addedAt,omitempty"`
	ExternalUrls  struct {
		Mixcloud   string `json:"mixcloud,omitempty"`
		Soundcloud string `json:"soundcloud,omitempty"`
		Youtube    string `json:"youtube,omitempty"`
	} `json:"externalUrls"`
}

type searchResult struct {
	ID         string   `json:"id"`
	SpotifyURL string   `json:"spotifyUrl"`
	Title      string   `json:"title"`
	Artists    []string `json:"artists"`
	Album      string   `json:"album,omitempty"`
	ArtworkURL string   `json:"artworkUrl,omitempty"`
}

// statusReport is the /api/v1/status payload — the machine-readable sibling of
// the /status dashboard. The terminal reads it straight off the public API (no
// CLI shim); only the already-public service name / status / short message /
// since timestamp ever flow through, the same fields the web page shows.
type statusReport struct {
	GeneratedAt string          `json:"generatedAt"`
	Live        *liveState      `json:"live,omitempty"`
	Services    []serviceStatus `json:"services"`
}

// liveState is the cross-surface live-set callout off /api/v1/status: whether
// Fluncle is on the decks right now (staleness already applied server-side), the
// public stream title, and the Twitch url. The footer renders one line when On.
type liveState struct {
	On        bool   `json:"on"`
	Title     string `json:"title,omitempty"`
	StartedAt string `json:"startedAt,omitempty"`
	URL       string `json:"url"`
}

// serviceStatus is one probed service in the report. `Status` is the three-state
// health enum ("ok"/"degraded"/"down"); `Since` is when the current state began.
type serviceStatus struct {
	CheckedAt string `json:"checkedAt"`
	LatencyMs *int   `json:"latencyMs"`
	Message   string `json:"message,omitempty"`
	Service   string `json:"service"`
	Since     string `json:"since"`
	Status    string `json:"status"`
}

type tracksMsg struct {
	tracks []track
	total  int
	err    error
}

type artistsMsg struct {
	artists []artist
	err     error
}

type galaxiesMsg struct {
	galaxies []galaxyItem
	err      error
}

// galaxyDetailMsg carries one galaxy plus its findings (core-first), opened when
// the operator selects a galaxy on the browse screen.
type galaxyDetailMsg struct {
	galaxy   galaxyItem
	findings []track
	err      error
}

type mixtapesMsg struct {
	mixtapes []mixtape
	err      error
}

type footerMsg struct {
	track *track
	err   error
}

type randomMsg struct {
	track track
	err   error
}

// detailMsg opens a finding's detail on boot (the `latest` deep link, and a
// `<coord>` that resolves to a finding).
type detailMsg struct {
	track track
	err   error
}

// mixtapeDetailMsg opens a mixtape's detail on boot (a `<coord>` whose middle
// slot is the F marker, resolved by the API to a mixtape).
type mixtapeDetailMsg struct {
	mixtape mixtape
	err     error
}

type searchMsg struct {
	results []searchResult
	err     error
}

type submitMsg struct {
	err error
}

type subscribeMsg struct {
	err error
}

type statusMsg struct {
	report *statusReport
	err    error
}

// liveMsg carries the live-set callout state for the menu footer — SEPARATE from
// statusMsg so it never touches m.loading/m.err (the status screen's state). It is
// best-effort: a failed read just carries a nil live (the footer shows nothing).
type liveMsg struct {
	live *liveState
}

// liveTickMsg re-arms the periodic live refresh so a long-lived session's footer
// clears within ~a minute of a set ending (mirrors the read-side staleness guard).
type liveTickMsg time.Time

func newModel(app *app, width, height int) model {
	return newModelWithBoot(app, width, height, bootCommand{kind: bootMenu})
}

// newModelWithBoot builds the model with an opening deep link. The boot kind
// decides the opening screen and the fetch Init fires; bootMenu is the plain
// interactive menu.
func newModelWithBoot(app *app, width, height int, boot bootCommand) model {
	m := model{
		app:    app,
		width:  width,
		height: height,
		screen: screenMenu,
		boot:   boot,
	}
	switch boot.kind {
	case bootLatest, bootRandom, bootCoord:
		m.screen = screenDetail
		m.loading = true
	case bootUnknown:
		m.err = unknownCommandLine(boot.raw)
	}
	return m
}

// unknownCommandLine is the deep-register line for a command the terminal can't
// place. Names the bad coordinate, points home, no exclamation marks (VOICE.md).
func unknownCommandLine(raw string) string {
	return "No coordinate reads " + raw + ". Try latest, random, or a Log ID like 004.7.2I."
}

func (m model) Init() tea.Cmd {
	// fetchLive rides every boot path so the menu footer carries the live-set callout
	// from the first paint (and starts the periodic refresh loop). It is best-effort
	// and side-effect-free, so it never disturbs the boot screen's own load.
	switch m.boot.kind {
	case bootLatest:
		return tea.Batch(m.fetchLatestDetail(), m.fetchLive())
	case bootRandom:
		return tea.Batch(m.fetchRandom(), m.fetchLive())
	case bootCoord:
		return tea.Batch(m.fetchByCoord(m.boot.coord), m.fetchLive())
	case bootUnknown:
		// The deep-register line is already set; the menu still wants its footer.
		return tea.Batch(m.fetchFooter(), m.fetchLive())
	}
	return tea.Batch(m.fetchFooter(), m.fetchLive())
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
	case tracksMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.tracks = msg.tracks
		m.total = msg.total
		m.selected = 0
		if len(msg.tracks) > 0 {
			m.footer = &msg.tracks[0]
		}
	case artistsMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.artists = msg.artists
		m.selected = 0
	case galaxiesMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.galaxies = msg.galaxies
		m.selected = 0
	case galaxyDetailMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.currentGalaxy = &msg.galaxy
		m.galaxyTracks = msg.findings
		m.selected = 0
	case mixtapesMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.mixtapes = msg.mixtapes
		m.selected = 0
	case footerMsg:
		if msg.err != nil {
			return m, nil
		}
		m.footer = msg.track
	case randomMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.current = &msg.track
		m.detailBack = ""
		m.screen = screenDetail
	case detailMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.current = &msg.track
		m.detailBack = ""
		m.screen = screenDetail
	case mixtapeDetailMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.currentMixtape = &msg.mixtape
		m.detailBack = ""
		m.screen = screenMixtapeDetail
	case searchMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.results = msg.results
		m.selected = 0
		m.screen = screenSearch
	case submitMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.message = "Logged. I'll give it a listen before it goes live."
		m.screen = screenMessage
	case subscribeMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.input = ""
		m.screen = screenSubscribed
	case statusMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.status = msg.report
	case liveMsg:
		// Best-effort footer state; re-arm the periodic refresh so the line clears
		// when a set ends without the user navigating.
		m.live = msg.live
		return m, liveTick()
	case liveTickMsg:
		return m, m.fetchLive()
	case tea.MouseWheelMsg:
		return m.handleWheel(msg)
	case tea.PasteMsg:
		return m.handlePaste(msg.Content)
	case tea.KeyPressMsg:
		return m.handleKey(msg)
	}

	return m, nil
}

// handleWheel lets the mouse/trackpad scroll the same surfaces the keyboard
// does. Mouse capture is enabled per-screen in View() (only where content can
// run past the viewport), so the terminal no longer owns the wheel there — which
// is what made the page repeat in the terminal's own scrollback.
func (m model) handleWheel(msg tea.MouseWheelMsg) (tea.Model, tea.Cmd) {
	var maxScroll int
	switch m.screen {
	case screenAbout:
		maxScroll = m.aboutMaxScroll()
	case screenStatus:
		maxScroll = m.statusMaxScroll()
	default:
		return m, nil
	}
	switch msg.Button {
	case tea.MouseWheelUp:
		m.scroll = clamp(m.scroll-3, 0, maxScroll)
	case tea.MouseWheelDown:
		m.scroll = clamp(m.scroll+3, 0, maxScroll)
	}
	return m, nil
}

func (m model) handleKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()

	if key == "ctrl+c" {
		return m, tea.Quit
	}

	switch m.screen {
	case screenMenu:
		return m.handleMenuKey(key)
	case screenLatest, screenSearch, screenArtists, screenGalaxies, screenGalaxyDetail, screenMixtapes:
		return m.handleListKey(key)
	case screenAbout:
		return m.handleAboutKey(key)
	case screenStatus:
		return m.handleStatusKey(key)
	case screenDetail, screenInstall, screenMessage, screenSubscribed, screenMixtapeDetail:
		if key == "q" || key == "esc" || key == "backspace" || key == "b" {
			if (m.screen == screenDetail || m.screen == screenMixtapeDetail) && m.detailBack != "" {
				m.screen = m.detailBack
				m.detailBack = ""
				return m, nil
			}
			m.screen = screenMenu
			m.selected = 0
			return m, nil
		}
	case screenSearchInput, screenNoteInput, screenContactInput, screenSubscribe:
		return m.handleInputKey(msg)
	case screenConfirm:
		return m.handleConfirmKey(key)
	}

	return m, nil
}

func (m model) handleMenuKey(key string) (tea.Model, tea.Cmd) {
	items := menuItems()
	switch key {
	case "q":
		return m, tea.Quit
	case "up", "k":
		m.selected = wrap(m.selected-1, len(items))
	case "down", "j":
		m.selected = wrap(m.selected+1, len(items))
	case "enter":
		switch items[m.selected].id {
		case "latest":
			m.screen = screenLatest
			m.loading = true
			m.err = ""
			return m, m.fetchLatest()
		case "artists":
			m.screen = screenArtists
			m.loading = true
			m.err = ""
			return m, m.fetchArtists()
		case "galaxies":
			m.screen = screenGalaxies
			m.loading = true
			m.err = ""
			return m, m.fetchGalaxies()
		case "mixtapes":
			m.screen = screenMixtapes
			m.loading = true
			m.err = ""
			return m, m.fetchMixtapes()
		case "random":
			m.loading = true
			m.err = ""
			return m, m.fetchRandom()
		case "submit":
			m.screen = screenSearchInput
			m.input = ""
			m.err = ""
		case "subscribe":
			m.screen = screenSubscribe
			m.input = ""
			m.err = ""
		case "install":
			m.screen = screenInstall
		case "status":
			m.screen = screenStatus
			m.loading = true
			m.err = ""
			m.status = nil
			m.scroll = 0
			return m, m.fetchStatus()
		case "about":
			m.screen = screenAbout
			m.scroll = 0
		case "quit":
			return m, tea.Quit
		}
	}
	return m, nil
}

func (m model) handleListKey(key string) (tea.Model, tea.Cmd) {
	length := len(m.tracks)
	switch m.screen {
	case screenSearch:
		length = len(m.results)
	case screenMixtapes:
		length = len(m.mixtapes)
	case screenArtists:
		length = len(m.artists)
	case screenGalaxies:
		length = len(m.galaxies)
	case screenGalaxyDetail:
		length = len(m.galaxyTracks)
	}

	switch key {
	case "q", "esc", "backspace", "b":
		// A galaxy's findings sit UNDER the galaxies map — backing out returns to
		// the map, not all the way to the menu (the one nested list screen).
		if m.screen == screenGalaxyDetail {
			m.screen = screenGalaxies
			m.selected = 0
			return m, nil
		}
		m.screen = screenMenu
		m.selected = 0
	case "up", "k":
		m.selected = wrap(m.selected-1, length)
	case "down", "j":
		m.selected = wrap(m.selected+1, length)
	case "enter":
		if length == 0 {
			return m, nil
		}
		if m.screen == screenGalaxies {
			// Wander INTO a galaxy: open its findings (core-first) on the detail
			// screen. The public read is the same /api/v1/galaxies/{slug} the CLI
			// uses; the launch gate 404s an unnamed map, so this only ever opens
			// a named galaxy.
			g := m.galaxies[m.selected]
			m.currentGalaxy = &g
			m.screen = screenGalaxyDetail
			m.loading = true
			m.err = ""
			m.selected = 0
			return m, m.fetchGalaxy(g.Slug)
		}
		if m.screen == screenGalaxyDetail {
			// A finding inside a galaxy opens the standard finding detail; backing
			// out of it returns HERE (detailBack), not to the menu.
			m.current = &m.galaxyTracks[m.selected]
			m.detailBack = screenGalaxyDetail
			m.screen = screenDetail
			return m, nil
		}
		if m.screen == screenSearch {
			m.pending = &m.results[m.selected]
			m.screen = screenNoteInput
			m.input = ""
			return m, nil
		}
		if m.screen == screenMixtapes {
			m.currentMixtape = &m.mixtapes[m.selected]
			m.detailBack = screenMixtapes
			m.screen = screenMixtapeDetail
			return m, nil
		}
		m.current = &m.tracks[m.selected]
		m.detailBack = ""
		m.screen = screenDetail
	}

	return m, nil
}

func (m model) handleInputKey(msg tea.KeyPressMsg) (tea.Model, tea.Cmd) {
	key := msg.String()
	switch key {
	case "esc":
		m.screen = screenMenu
		m.input = ""
	case "backspace":
		if len(m.input) > 0 {
			m.input = dropLastRune(m.input)
		}
	case "enter":
		value := strings.TrimSpace(m.input)
		switch m.screen {
		case screenSearchInput:
			if len(value) < 2 {
				m.err = "Enter at least two characters or a Spotify track URL."
				return m, nil
			}
			m.screen = screenSearch
			m.loading = true
			m.err = ""
			return m, m.search(value)
		case screenNoteInput:
			m.note = truncateInput(value, 500)
			m.input = ""
			m.screen = screenContactInput
		case screenContactInput:
			m.contact = truncateInput(value, 120)
			m.input = ""
			m.screen = screenConfirm
		case screenSubscribe:
			if value == "" || !strings.Contains(value, "@") {
				m.err = "Enter a valid email address."
				return m, nil
			}
			m.loading = true
			m.err = ""
			return m, m.subscribe(value)
		}
	case "space":
		m.input += " "
	default:
		// A printable keypress carries its rune(s) in msg.Text; control keys
		// (arrows, function keys) leave it empty and are dropped.
		m.input += sanitizeInput(msg.Text)
	}

	return m, nil
}

// handlePaste appends bracketed-paste text to the active input field, so a
// junglist can paste a Spotify URL (or an email) instead of typing it. Pastes
// outside an input screen are ignored.
func (m model) handlePaste(content string) (tea.Model, tea.Cmd) {
	switch m.screen {
	case screenSearchInput, screenNoteInput, screenContactInput, screenSubscribe:
		m.input += sanitizeInput(content)
	}
	return m, nil
}

// sanitizeInput keeps the printable, single-line characters a typed or pasted
// field can hold and drops control characters (newlines from a multi-line paste,
// stray escape bytes), so a pasted URL lands clean.
func sanitizeInput(text string) string {
	var b strings.Builder
	for _, r := range text {
		if unicode.IsControl(r) {
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

func (m model) handleConfirmKey(key string) (tea.Model, tea.Cmd) {
	switch strings.ToLower(key) {
	case "q", "esc", "n":
		m.screen = screenMenu
		m.pending = nil
		m.note = ""
		m.contact = ""
	case "enter", "y":
		if m.pending == nil {
			m.screen = screenMenu
			return m, nil
		}
		m.loading = true
		m.err = ""
		return m, m.submit()
	}
	return m, nil
}

func (m model) View() tea.View {
	var content string
	switch m.screen {
	case screenMenu:
		content = m.renderMenu()
	case screenLatest:
		content = m.renderLatest()
	case screenDetail:
		content = m.renderDetail()
	case screenArtists:
		content = m.renderArtists()
	case screenGalaxies:
		content = m.renderGalaxies()
	case screenGalaxyDetail:
		content = m.renderGalaxyDetail()
	case screenMixtapes:
		content = m.renderMixtapes()
	case screenMixtapeDetail:
		content = m.renderMixtapeDetail()
	case screenSearchInput:
		content = m.renderInput("Search Spotify", "Spotify URL or track search")
	case screenSearch:
		content = m.renderSearch()
	case screenNoteInput:
		content = m.renderInput("Note", "optional")
	case screenContactInput:
		content = m.renderInput("Contact", "email or X handle, optional")
	case screenConfirm:
		content = m.renderConfirm()
	case screenSubscribe:
		content = m.renderSubscribe()
	case screenSubscribed:
		content = m.renderSubscribed()
	case screenStatus:
		content = m.renderStatus()
	case screenInstall:
		content = m.renderInstall()
	case screenAbout:
		content = m.renderAbout()
	case screenMessage:
		content = m.renderMessage()
	}

	view := tea.NewView(pageStyle.Width(clamp(m.width-4, 48, 96)).Render(content))
	view.AltScreen = true
	// Capture the wheel only on the scrollable surfaces (About, System status),
	// so the app drives the scroll instead of the terminal scrolling its own
	// scrollback (which showed the page repeated). Other screens keep native
	// text selection.
	if m.screen == screenAbout || m.screen == screenStatus {
		view.MouseMode = tea.MouseModeCellMotion
	}
	return view
}

func (m model) renderMenu() string {
	// The full menu stands ~28 rows with padding; classic terminals open at
	// 80x24. Below 30 rows the footer compacts to single lines, and below 21
	// the figlet yields to a one-line plate, so "Crew aboard" never falls
	// under the fold. Height 0 means no WindowSizeMsg yet; render full.
	compact := m.height > 0 && m.height < 30
	tiny := m.height > 0 && m.height < 21

	var lines []string
	if tiny {
		lines = []string{
			plateStyle.Render("FLUNCLE · RAVE TERMINAL"),
			taglineStyle.Render("Drum & bass bangers from another dimension"),
			"",
		}
	} else {
		lines = []string{
			logoStyle.Render(asciiLogo()),
			plateStyle.Render("RAVE TERMINAL"),
			taglineStyle.Render("Drum & bass bangers from another dimension"),
			"",
		}
	}
	if m.err != "" {
		lines = append(lines, labelStyle.Render(m.err), "")
	}
	for index, item := range menuItems() {
		prefix := "  "
		style := menuStyle
		if index == m.selected {
			prefix = "> "
			style = selectedStyle
		}
		lines = append(lines, style.Render(prefix+item.label))
	}
	help := helpLine("↑/↓ j/k move", "enter select", "q quit")
	lines = append(lines, "", help)
	lines = append(lines, "", m.renderFooter(compact))
	return strings.Join(lines, "\n")
}

func (m model) renderFooter(compact bool) string {
	// Rule width matches the logo block, capped at the available content width.
	rule := ruleStyle.Render(strings.Repeat("─", m.menuRuleWidth()))
	var lines []string

	// The live-set callout, directly under the rule when Fluncle is on the decks
	// (Nebula Violet, the one sanctioned second light — DESIGN.md "The Live
	// Exception"). Renders nothing otherwise; staleness is already applied server-side.
	lines = append(lines, rule)
	if m.live != nil && m.live.On {
		liveLine := liveStyle.Render("● On the decks, live now") +
			labelStyle.Render(" · "+liveDisplayURL(m.live.URL))
		if compact {
			lines = append(lines, liveLine)
		} else {
			lines = append(lines, "", liveLine)
		}
	}

	if compact {
		// One line for the finding, time inline, no breathing rows.
		found := labelStyle.Render("Last found: ")
		if m.footer == nil {
			found += labelStyle.Render("scanning the archive...")
		} else {
			found += rowArtistStyle.Render(artistLine(m.footer.Artists)) +
				rowDashStyle.Render(" — ") +
				rowTitleStyle.Render(m.footer.Title) +
				labelStyle.Render(" · "+relativeTime(m.footer.AddedAt))
		}
		lines = append(lines, found)
	} else {
		lines = append(lines, "", labelStyle.Render("Last found:"))
		if m.footer == nil {
			lines = append(lines, labelStyle.Render("Scanning the archive..."))
		} else {
			// Footer grammar: artist Stardust, em dash rule-color, title Cream bold.
			line := rowArtistStyle.Render(artistLine(m.footer.Artists)) +
				rowDashStyle.Render(" — ") +
				rowTitleStyle.Render(m.footer.Title)
			lines = append(
				lines,
				line,
				labelStyle.Render(relativeTime(m.footer.AddedAt)),
			)
		}
	}

	crew := readingStyle.Render(fmt.Sprintf("%d", m.app.connectedRaverCount()))
	crewLine := crew + labelStyle.Render(" crew aboard")
	if countries := m.app.raverCountrySummary(); countries != "" {
		crewLine += labelStyle.Render(" (" + countries + ")")
	}

	if compact {
		lines = append(lines, crewLine)
	} else {
		lines = append(lines, "", crewLine)
	}

	return strings.Join(lines, "\n")
}

// liveDisplayURL strips the scheme and leading www. from the live url for a clean
// terminal readout (https://www.twitch.tv/flunclelive → twitch.tv/flunclelive).
func liveDisplayURL(url string) string {
	url = strings.TrimPrefix(url, "https://")
	url = strings.TrimPrefix(url, "http://")
	return strings.TrimPrefix(url, "www.")
}

// menuRuleWidth returns the logo block width, capped at the content width so the
// horizontal rule never overflows the page.
func (m model) menuRuleWidth() int {
	logoWidth := 0
	for _, line := range strings.Split(asciiLogo(), "\n") {
		if w := lipgloss.Width(line); w > logoWidth {
			logoWidth = w
		}
	}
	contentWidth := clamp(m.width-4, 48, 96) - 4 // minus page padding (2 each side)
	if contentWidth > 0 && logoWidth > contentWidth {
		return contentWidth
	}
	return logoWidth
}

func (m model) renderLatest() string {
	if m.loading {
		return statusView("Latest bangers", "Scanning the archive...")
	}
	if m.err != "" {
		return errorView("Latest bangers", m.err)
	}
	if len(m.tracks) == 0 {
		return statusView("Latest bangers", "No findings logged yet. Quiet sector tonight.")
	}

	// Indices count down from the newest: use the API total count when available,
	// otherwise count down from the number of rows we have.
	top := m.total
	if top < len(m.tracks) {
		top = len(m.tracks)
	}
	content := make([]string, 0, len(m.tracks))
	for index, track := range m.tracks {
		coord := track.LogID
		if coord == "" {
			// No coordinate recovered for this entry: fall back to the archive
			// ordinal so the column never blanks out.
			coord = fmt.Sprintf("#%02d", top-index)
		}
		content = append(content, selectableTrackRow(index == m.selected, coord, track.Artists, track.Title))
	}
	help := helpLine("↑/↓ j/k move", "enter select", "q back", "ctrl+c quit")
	return scaffold("Latest bangers", "", content, help)
}

func (m model) renderSearch() string {
	if m.loading {
		return statusView("Search Spotify", "Scanning...")
	}
	if m.err != "" {
		return errorView("Search Spotify", m.err)
	}
	if len(m.results) == 0 {
		return statusView("Search Spotify", "Nothing matched in this dimension. Try another search.")
	}

	// Candidates count up #01.. (positions in the result set, not archive slots).
	content := make([]string, 0, len(m.results))
	for index, result := range m.results {
		// Search candidates are Spotify rows, not findings: no Log ID yet, so
		// they keep the plain candidate position.
		coord := fmt.Sprintf("#%02d", index+1)
		content = append(content, selectableTrackRow(index == m.selected, coord, result.Artists, result.Title))
	}
	help := helpLine("↑/↓ j/k move", "enter select", "q back", "ctrl+c quit")
	return scaffold("Select track", "", content, help)
}

func (m model) renderDetail() string {
	if m.loading {
		return statusView("Finding", "Pulling the coordinate...")
	}
	if m.current == nil {
		if m.err != "" {
			return errorView("Finding", m.err)
		}
		return statusView("Finding", "No track selected.")
	}
	t := *m.current
	wrapWidth := clamp(m.width-4, 48, 96) - 4
	// Detail title is Cream bold (the track is the subject here, not the screen),
	// so this screen sets its own header rather than the gold scaffold title.
	lines := []string{
		rowTitleStyle.Render(t.Title),
		labelStyle.Render(artistLine(t.Artists)),
	}

	// Recovered-telemetry block. SSH is the deepest surface (VOICE.md's Depth
	// Gradient): the Log ID coordinate, record label, sub-genre tags, and
	// duration read like fields off a recovered log entry. Each line is its
	// own field; absent fields drop out so the block never shows blanks.
	if coord := strings.TrimSpace(t.LogID); coord != "" {
		lines = append(lines,
			"",
			labelStyle.Render("Log ID: ")+readingStyle.Render(coord),
			labelStyle.Render("Coordinate: ")+readingStyle.Render("fluncle://"+coord),
		)
	} else {
		lines = append(lines, "")
	}
	lines = append(lines, labelStyle.Render("Found: ")+readingStyle.Render(formatDate(t.AddedAt)))
	if label := strings.TrimSpace(t.Label); label != "" {
		lines = append(lines, labelStyle.Render("Pressed by: ")+readingStyle.Render(label))
	}
	if duration := formatDuration(t.DurationMs); duration != "" {
		lines = append(lines, labelStyle.Render("Runtime: ")+readingStyle.Render(duration))
	}
	if len(t.Tags) > 0 {
		lines = append(lines, labelStyle.Render("Reads as: ")+readingStyle.Width(wrapWidth).Render(strings.Join(t.Tags, ", ")))
	}

	if note := strings.TrimSpace(t.Note); note != "" {
		lines = append(lines,
			"",
			labelStyle.Render("Why I'm playing it:"),
			readingStyle.Width(wrapWidth).Render(note),
		)
	}
	lines = append(lines, "", readingStyle.Render(terminalLink(t.SpotifyURL, t.SpotifyURL)))
	if coord := strings.TrimSpace(t.LogID); coord != "" {
		lines = append(lines, readingStyle.Render(terminalLink("Read the log", logPageURL(coord))))
	}
	lines = append(lines, "", helpLine("q back", "ctrl+c quit"))
	return strings.Join(lines, "\n")
}

func (m model) renderArtists() string {
	if m.loading {
		return statusView("Artist archive", "Scanning the archive...")
	}
	if m.err != "" {
		return errorView("Artist archive", m.err)
	}
	if len(m.artists) == 0 {
		return statusView("Artist archive", "No artists in the archive yet.")
	}

	content := make([]string, 0, len(m.artists))
	for index, a := range m.artists {
		count := fmt.Sprintf("%d finding%s", a.FindingCount, func() string {
			if a.FindingCount == 1 {
				return ""
			}
			return "s"
		}())
		if index == m.selected {
			label := fmt.Sprintf("%-40s  %s", a.Name, count)
			content = append(content, selectedStyle.Render("> "+label))
		} else {
			name := rowArtistStyle.Render(fmt.Sprintf("%-40s", a.Name))
			info := labelStyle.Render(count)
			content = append(content, fmt.Sprintf("  %s  %s", name, info))
		}
	}
	help := helpLine("↑/↓ j/k move", "q back", "ctrl+c quit")
	return scaffold("Artist archive", "", content, help)
}

func (m model) renderGalaxies() string {
	if m.loading {
		return statusView("Sonic galaxies", "Charting the map...")
	}
	if m.err != "" {
		return errorView("Sonic galaxies", m.err)
	}
	if len(m.galaxies) == 0 {
		// The launch gate keeps this empty until the whole map is named.
		return statusView("Sonic galaxies", "No galaxies charted yet. Quiet map tonight.")
	}

	content := make([]string, 0, len(m.galaxies))
	for index, g := range m.galaxies {
		count := fmt.Sprintf("%d finding%s", g.MemberCount, func() string {
			if g.MemberCount == 1 {
				return ""
			}
			return "s"
		}())
		if index == m.selected {
			label := fmt.Sprintf("%-40s  %s", g.Name, count)
			content = append(content, selectedStyle.Render("> "+label))
		} else {
			name := rowArtistStyle.Render(fmt.Sprintf("%-40s", g.Name))
			info := labelStyle.Render(count)
			content = append(content, fmt.Sprintf("  %s  %s", name, info))
		}
	}
	help := helpLine("↑/↓ j/k move", "enter open", "q back", "ctrl+c quit")
	return scaffold("Sonic galaxies", "", content, help)
}

func (m model) renderGalaxyDetail() string {
	name := "Galaxy"
	if m.currentGalaxy != nil {
		name = m.currentGalaxy.Name
	}
	if m.loading {
		return statusView(name, "Pulling the galaxy...")
	}
	if m.err != "" {
		return errorView(name, m.err)
	}
	if len(m.galaxyTracks) == 0 {
		return statusView(name, "No findings logged yet. Quiet sector tonight.")
	}

	content := make([]string, 0, len(m.galaxyTracks))
	for index, t := range m.galaxyTracks {
		coord := t.LogID
		if coord == "" {
			coord = fmt.Sprintf("#%02d", index+1)
		}
		content = append(content, selectableTrackRow(index == m.selected, coord, t.Artists, t.Title))
	}
	help := helpLine("↑/↓ j/k move", "enter select", "q back", "ctrl+c quit")
	return scaffold(name, "", content, help)
}

func (m model) renderMixtapes() string {
	if m.loading {
		return statusView("Mixtape archive", "Scanning the archive...")
	}
	if m.err != "" {
		return errorView("Mixtape archive", m.err)
	}
	if len(m.mixtapes) == 0 {
		return statusView("Mixtape archive", "No checkpoints logged yet.")
	}

	content := make([]string, 0, len(m.mixtapes))
	for index, mx := range m.mixtapes {
		coord := padRight(mx.LogID, coordWidth)
		meta := mixtapeMeta(mx)
		if index == m.selected {
			label := fmt.Sprintf("%s  %s  %s", coord, mx.Title, meta)
			content = append(content, selectedStyle.Render("> "+label))
		} else {
			idx := rowIndexStyle.Render(coord)
			title := rowTitleStyle.Render(mx.Title)
			info := labelStyle.Render(meta)
			content = append(content, fmt.Sprintf("  %s  %s  %s", idx, title, info))
		}
	}
	help := helpLine("↑/↓ j/k move", "enter select", "q back", "ctrl+c quit")
	return scaffold("Mixtape archive", "", content, help)
}

// mixtapeMeta renders the compact one-line summary for a list row: "N bangers
// · 72m". Minutes (not M:SS) because the list is the compact scan; the detail
// carries the precise runtime.
func mixtapeMeta(mx mixtape) string {
	meta := fmt.Sprintf("%d bangers", mx.MemberCount)
	if mx.DurationMs > 0 {
		minutes := mx.DurationMs / 60000
		if minutes > 0 {
			meta += fmt.Sprintf(" · %dm", minutes)
		}
	}
	return meta
}

func (m model) renderMixtapeDetail() string {
	if m.currentMixtape == nil {
		return statusView("Mixtape archive", "No checkpoint selected.")
	}
	mx := *m.currentMixtape
	wrapWidth := clamp(m.width-4, 48, 96) - 4
	// Same Cream-bold header as a finding's detail: the mixtape is the subject,
	// not the screen. "Fluncle" stands in for the artist line.
	lines := []string{
		rowTitleStyle.Render(mx.Title),
		labelStyle.Render("Fluncle"),
	}

	// Recovered-telemetry block — the checkpoint's log entry. Each field on its
	// own line; absent fields drop out so the block never shows blanks.
	if coord := strings.TrimSpace(mx.LogID); coord != "" {
		lines = append(lines,
			"",
			labelStyle.Render("Log ID: ")+readingStyle.Render(coord),
			labelStyle.Render("Coordinate: ")+readingStyle.Render("fluncle://"+coord),
		)
	} else {
		lines = append(lines, "")
	}
	if mx.RecordedAt != "" {
		lines = append(lines, labelStyle.Render("Recorded: ")+readingStyle.Render(formatDate(mx.RecordedAt)))
	}
	if mx.MemberCount > 0 {
		lines = append(lines, labelStyle.Render("Bangers: ")+readingStyle.Render(fmt.Sprintf("%d", mx.MemberCount)))
	}
	if duration := formatDuration(mx.DurationMs); duration != "" {
		lines = append(lines, labelStyle.Render("Duration: ")+readingStyle.Render(duration))
	}

	if note := strings.TrimSpace(mx.Note); note != "" {
		lines = append(lines,
			"",
			labelStyle.Render("The dream:"),
			readingStyle.Width(wrapWidth).Render(note),
		)
	}

	// Listen links. Mixtapes carry their audio — surface every deck that has one.
	if mx.ExternalUrls.Mixcloud != "" {
		lines = append(lines, "", readingStyle.Render(terminalLink("Hear it on Mixcloud", mx.ExternalUrls.Mixcloud)))
	}
	if mx.ExternalUrls.Youtube != "" {
		lines = append(lines, "", readingStyle.Render(terminalLink("Watch on YouTube", mx.ExternalUrls.Youtube)))
	}
	if mx.ExternalUrls.Soundcloud != "" {
		lines = append(lines, "", readingStyle.Render(terminalLink("Hear it on SoundCloud", mx.ExternalUrls.Soundcloud)))
	}

	lines = append(lines, "", helpLine("q back", "ctrl+c quit"))
	return strings.Join(lines, "\n")
}

func (m model) renderInput(title, placeholder string) string {
	cursor := " "
	if time.Now().Unix()%2 == 0 {
		cursor = "█"
	}
	content := []string{
		inputStyle.Render("> " + m.input + cursor),
	}
	if m.err != "" {
		content = append(content, "", errorStyle.Render(m.err))
	}
	help := helpLine("enter continue", "esc cancel", "ctrl+c quit")
	return scaffold(title, placeholder, content, help)
}

func (m model) renderConfirm() string {
	if m.loading {
		return statusView("Submit this track to Fluncle?", "Sending...")
	}
	if m.pending == nil {
		return statusView("Submit this track to Fluncle?", "No track selected.")
	}
	row := rowArtistStyle.Render(artistLine(m.pending.Artists)) +
		rowDashStyle.Render(" — ") +
		rowTitleStyle.Render(m.pending.Title)
	content := []string{
		row,
		"",
		labelStyle.Render("Note: ") + readingStyle.Render(fallback(m.note, "none")),
		labelStyle.Render("Contact: ") + readingStyle.Render(fallback(m.contact, "unknown")),
	}
	if m.err != "" {
		content = append(content, "", errorStyle.Render(m.err))
	}
	help := helpLine("enter/y submit", "q/esc/n cancel", "ctrl+c quit")
	return scaffold("Submit this track to Fluncle?", "", content, help)
}

func (m model) renderSubscribe() string {
	if m.loading {
		return statusView("Subscribe", "Subscribing...")
	}
	cursor := " "
	if time.Now().Unix()%2 == 0 {
		cursor = "█"
	}
	field := m.input + cursor
	if m.input == "" {
		field = labelStyle.Render("you@example.com")
	}
	content := []string{
		inputStyle.Render("> " + field),
	}
	if m.err != "" {
		content = append(content, "", errorStyle.Render(m.err))
	}
	help := helpLine("enter subscribe", "esc cancel")
	return scaffold("Subscribe", "Fresh bangers, every Friday, from Fluncle.", content, help)
}

func (m model) renderSubscribed() string {
	wrapWidth := clamp(m.width-4, 48, 96) - 4
	content := []string{readingStyle.Width(wrapWidth).Render("You're aboard the mothership. It departs every Friday with fresh bangers, junglist.")}
	help := helpLine("q back", "ctrl+c quit")
	return scaffold("Subscribe", "", content, help)
}

// renderStatus draws the recovered service-health board: one row per probed
// service, its state read as a recovered telemetry field. Deep instrument
// register — no exclamation marks (VOICE.md §6), the cosmos modifies but the
// fields stay honestly plain. The order mirrors the web /status dashboard
// (known services lead in SERVICE_ORDER; an unknown one falls in after).
func (m model) renderStatus() string {
	if m.loading {
		return statusView("System status", "Reading the service telemetry...")
	}
	if m.err != "" {
		return errorView("System status", m.err)
	}
	if m.status == nil || len(m.status.Services) == 0 {
		return statusView("System status", "Nothing's reported in from the services yet. Quiet sector.")
	}

	services := sortServiceStatuses(m.status.Services)
	body := m.statusBodyLines()
	vp := m.statusViewport()
	scroll := clamp(m.scroll, 0, m.statusMaxScroll())

	end := scroll + vp
	if end > len(body) {
		end = len(body)
	}
	visible := append([]string{}, body[scroll:end]...)

	// Show a scroll cue only when the board is taller than one screenful, in the
	// deep instrument register (no exclamation marks, VOICE.md §6). Mirrors the
	// About screen's cue exactly.
	if len(body) > vp {
		more := len(body) - end
		var hint string
		switch {
		case scroll == 0:
			hint = fmt.Sprintf("↓ %d more lines · j/k to scroll", more)
		case end >= len(body):
			hint = "↑ scroll up with k · q back"
		default:
			hint = fmt.Sprintf("↑/↓ scroll · %d more below", more)
		}
		visible = append(visible, "", labelStyle.Render(hint))
	}

	help := helpLine("↑/↓ j/k scroll", "q back", "ctrl+c quit")
	return scaffold("System status", overallStatusHeadline(services), visible, help)
}

// handleStatusKey scrolls the System status service board (its full cron.*
// list runs past a default 24-row terminal) and handles the back-to-menu keys.
// Scroll is clamped against the live content height so it can never run past the
// ends. Mirrors handleAboutKey.
func (m model) handleStatusKey(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "q", "esc", "backspace", "b":
		m.screen = screenMenu
		m.selected = 0
		m.scroll = 0
	case "up", "k":
		m.scroll = clamp(m.scroll-1, 0, m.statusMaxScroll())
	case "down", "j":
		m.scroll = clamp(m.scroll+1, 0, m.statusMaxScroll())
	case "pgup":
		m.scroll = clamp(m.scroll-m.statusViewport(), 0, m.statusMaxScroll())
	case "pgdown", " ", "f":
		m.scroll = clamp(m.scroll+m.statusViewport(), 0, m.statusMaxScroll())
	case "g", "home":
		m.scroll = 0
	case "G", "end":
		m.scroll = m.statusMaxScroll()
	}
	return m, nil
}

// statusBodyLines is the service board as visual rows — one block per probed
// service (a "Web · up 3d" header, an optional detail line, a blank between
// blocks), the unit the scroll window operates on. Empty until the report lands,
// so the scroll math reads zero-extent while loading. Mirrors aboutBodyLines.
func (m model) statusBodyLines() []string {
	if m.status == nil || len(m.status.Services) == 0 {
		return nil
	}
	services := sortServiceStatuses(m.status.Services)
	body := make([]string, 0, len(services)*3)
	for index, service := range services {
		if index > 0 {
			body = append(body, "")
		}
		// "Web · up 3d" — the service's voice label, its current state as a
		// recovered field, and how long it's held there.
		header := rowTitleStyle.Render(serviceStatusLabel(service.Service)) +
			labelStyle.Render(" · ") +
			statusWordStyle(service.Status).Render(serviceStatusWord(service.Status)) +
			labelStyle.Render(" · "+humanizeServiceSince(service.Since, m.status.GeneratedAt, service.Status))
		body = append(body, header)
		// The probe's short message (already public-safe at the write); the
		// subtitle names what the service is, in plain words.
		detail := serviceStatusSubtitle(service.Service)
		if message := strings.TrimSpace(service.Message); message != "" {
			if detail != "" {
				detail += " · "
			}
			detail += message
		}
		if detail != "" {
			body = append(body, labelStyle.Render(detail))
		}
	}
	return body
}

// statusViewport is how many service-board rows fit: the terminal height minus
// the page padding (2), the pinned title + subtitle + their blank (3), the blank
// + help (2), and the scroll-hint block — a blank + the hint line (2). A
// non-positive height (no size yet) shows the whole board. Mirrors aboutViewport
// (one row taller of chrome, since status carries a subtitle headline).
func (m model) statusViewport() int {
	if m.height <= 0 {
		return len(m.statusBodyLines())
	}
	h := m.height - 9
	if h < 4 {
		h = 4
	}
	return h
}

func (m model) statusMaxScroll() int {
	return clamp(len(m.statusBodyLines())-m.statusViewport(), 0, len(m.statusBodyLines()))
}

func (m model) renderInstall() string {
	content := []string{
		readingStyle.Render("Browse the latest bangers, submit tracks, and dig through Fluncle's Findings from your terminal."),
		"",
		codeFocalStyle.Render("curl -fsSL https://www.fluncle.com/cli/latest.sh | sh"),
		"",
		labelStyle.Render("Then run:"),
		codeStyle.Render("fluncle --help"),
		"",
		codeStyle.Render(strings.Join([]string{
			"fluncle recent",
			"fluncle open",
			"fluncle random",
			"fluncle submit",
			"fluncle submit \"https://open.spotify.com/track/...\"",
		}, "\n")),
	}
	help := helpLine("q back", "ctrl+c quit")
	return scaffold("Install CLI", "", content, help)
}

// handleAboutKey scrolls the About surface (its full link map runs past a
// default 24-row terminal) and handles the back-to-menu keys. Scroll is clamped
// against the live content height so it can never run past the ends.
func (m model) handleAboutKey(key string) (tea.Model, tea.Cmd) {
	switch key {
	case "q", "esc", "backspace", "b":
		m.screen = screenMenu
		m.selected = 0
		m.scroll = 0
	case "up", "k":
		m.scroll = clamp(m.scroll-1, 0, m.aboutMaxScroll())
	case "down", "j":
		m.scroll = clamp(m.scroll+1, 0, m.aboutMaxScroll())
	case "pgup":
		m.scroll = clamp(m.scroll-m.aboutViewport(), 0, m.aboutMaxScroll())
	case "pgdown", " ", "f":
		m.scroll = clamp(m.scroll+m.aboutViewport(), 0, m.aboutMaxScroll())
	case "g", "home":
		m.scroll = 0
	case "G", "end":
		m.scroll = m.aboutMaxScroll()
	}
	return m, nil
}

// aboutContent is the About body as logical entries (some wrap to several
// rows). Shared by the renderer and the scroll-extent math so they agree.
//
// Warm-uncle register: Fluncle introducing himself, not the deep telemetry.
// This is a long-form surface, so the cosmos may drive the verb (the Garnish
// Rule's carve-out for testimony). Still no exclamation marks.
func (m model) aboutContent() []string {
	wrapWidth := clamp(m.width-4, 48, 96) - 4

	// One link line: muted label, then the URL as an OSC-8 hyperlink. The label
	// holds a fixed column so the URLs line up like a logbook's index.
	link := func(label, url string) string {
		return labelStyle.Render(padRight(label, 13)) + readingStyle.Render(terminalLink(url, url))
	}

	return []string{
		readingStyle.Width(wrapWidth).Render("I'm Fluncle. Been digging since '90, only now I do it across the Galaxy. I log every banger I find and send it back. This terminal is one of the places it lands."),
		"",
		labelStyle.Render("Where to listen"),
		link("Spotify", spotifyPlaylistURL),
		link("Mixcloud", mixcloudURL),
		link("YouTube", youtubeURL),
		"",
		labelStyle.Render("Follow the crew"),
		link("TikTok", tiktokURL),
		link("Instagram", instagramURL),
		link("Telegram", telegramURL),
		"",
		labelStyle.Render("The mothership"),
		link("Web", websiteURL),
		link("RSS", rssURL),
		readingStyle.Width(wrapWidth).Render("Newsletter: fresh bangers, every Friday, from Fluncle. Board it at the site."),
		"",
		labelStyle.Render("For the nerds"),
		link("The Galaxy", galaxyURL),
		labelStyle.Render(padRight("SSH", 13)) + readingStyle.Render(sshConnect),
		link("Source", sourceURL),
		"",
		labelStyle.Render("IP geolocation by ") + readingStyle.Render(terminalLink(dbipURL, dbipURL)),
	}
}

// aboutBodyLines expands the content to actual visual rows (a wrapped paragraph
// becomes several lines), the unit the scroll window operates on.
func (m model) aboutBodyLines() []string {
	return strings.Split(strings.Join(m.aboutContent(), "\n"), "\n")
}

// aboutViewport is how many body rows fit: the terminal height minus the page
// padding (2), the pinned title + its blank (2), the blank + help (2), and the
// scroll-hint block — a blank + the hint line (2). A non-positive height (no
// size yet) shows the whole body.
func (m model) aboutViewport() int {
	if m.height <= 0 {
		return len(m.aboutBodyLines())
	}
	h := m.height - 8
	if h < 4 {
		h = 4
	}
	return h
}

func (m model) aboutMaxScroll() int {
	return clamp(len(m.aboutBodyLines())-m.aboutViewport(), 0, len(m.aboutBodyLines()))
}

func (m model) renderAbout() string {
	body := m.aboutBodyLines()
	vp := m.aboutViewport()
	scroll := clamp(m.scroll, 0, m.aboutMaxScroll())

	end := scroll + vp
	if end > len(body) {
		end = len(body)
	}
	visible := append([]string{}, body[scroll:end]...)

	// Show a scroll cue only when the body is taller than one screenful, in the
	// deep instrument register (no exclamation marks, VOICE.md §6).
	if len(body) > vp {
		more := len(body) - end
		var hint string
		switch {
		case scroll == 0:
			hint = fmt.Sprintf("↓ %d more lines · j/k to scroll", more)
		case end >= len(body):
			hint = "↑ scroll up with k · q back"
		default:
			hint = fmt.Sprintf("↑/↓ scroll · %d more below", more)
		}
		visible = append(visible, "", labelStyle.Render(hint))
	}

	help := helpLine("↑/↓ j/k scroll", "q back", "ctrl+c quit")
	return scaffold("About", "", visible, help)
}

// renderPrinted is the clean, non-interactive view of a deep link for sessions
// with no PTY (bare ssh host latest). It runs the same boot fetch the TUI would,
// folds the result into the model with Update, then renders the resulting detail
// once with the help line stripped (there's no keyboard out here). The page style
// frames it the same way the interactive surface does.
func (m model) renderPrinted() string {
	// Only the detail deep links need a fetch out here; an unknown command is just
	// the printed line, so it skips the network entirely.
	if m.boot.kind != bootUnknown {
		if cmd := m.Init(); cmd != nil {
			if msg := cmd(); msg != nil {
				updated, _ := m.Update(msg)
				m = updated.(model)
			}
		}
	}

	var body string
	switch m.screen {
	case screenMixtapeDetail:
		body = m.renderMixtapeDetail()
	case screenMenu:
		// Unknown command with no PTY: the deep-register line alone, no menu (a
		// menu needs a keyboard). Points back to the interactive way in.
		line := m.err
		if line == "" {
			line = unknownCommandLine(m.boot.raw)
		}
		body = scaffold("Rave terminal", "", []string{
			labelStyle.Render(line),
			"",
			readingStyle.Render("Open the terminal: " + sshConnect),
		}, "")
	default:
		body = m.renderDetail()
	}

	// Strip the interactive help line (the last two rows: a blank then the keys).
	body = stripHelpLine(body)
	return pageStyle.Width(clamp(m.width-4, 48, 96)).Render(body)
}

// stripHelpLine drops the trailing help row (and the blank above it) that the
// interactive scaffolds end with — meaningless on a one-shot printed page.
func stripHelpLine(body string) string {
	lines := strings.Split(body, "\n")
	for len(lines) > 0 {
		last := strings.TrimSpace(lines[len(lines)-1])
		if last == "" {
			lines = lines[:len(lines)-1]
			continue
		}
		if strings.Contains(last, "ctrl+c") || strings.Contains(last, "q back") || strings.Contains(last, "any key") {
			lines = lines[:len(lines)-1]
			continue
		}
		break
	}
	return strings.Join(lines, "\n")
}

func (m model) renderMessage() string {
	wrapWidth := clamp(m.width-4, 48, 96) - 4
	content := []string{readingStyle.Width(wrapWidth).Render(m.message)}
	help := helpLine("q back", "ctrl+c quit")
	return scaffold("Logged", "", content, help)
}

func statusView(title, message string) string {
	content := []string{labelStyle.Render(message)}
	help := helpLine("q back", "ctrl+c quit")
	return scaffold(title, "", content, help)
}

func errorView(title, message string) string {
	content := []string{errorStyle.Render(message)}
	help := helpLine("q back", "ctrl+c quit")
	return scaffold(title, "", content, help)
}

func (m model) fetchLatest() tea.Cmd {
	return func() tea.Msg {
		var response struct {
			Tracks     []track `json:"tracks"`
			TotalCount int     `json:"totalCount"`
		}
		err := m.app.getJSON("/api/tracks?limit=16", &response)
		return tracksMsg{tracks: response.Tracks, total: response.TotalCount, err: err}
	}
}

func (m model) fetchArtists() tea.Cmd {
	return func() tea.Msg {
		var response struct {
			Artists []artist `json:"artists"`
			OK      bool     `json:"ok"`
		}
		err := m.app.getJSON("/api/artists", &response)
		return artistsMsg{artists: response.Artists, err: err}
	}
}

func (m model) fetchGalaxies() tea.Cmd {
	return func() tea.Msg {
		var response struct {
			Galaxies []galaxyItem `json:"galaxies"`
			OK       bool         `json:"ok"`
		}
		err := m.app.getJSON("/api/v1/galaxies", &response)
		return galaxiesMsg{galaxies: response.Galaxies, err: err}
	}
}

func (m model) fetchGalaxy(slug string) tea.Cmd {
	return func() tea.Msg {
		var response struct {
			Findings []track    `json:"findings"`
			Galaxy   galaxyItem `json:"galaxy"`
			OK       bool       `json:"ok"`
		}
		err := m.app.getJSON("/api/v1/galaxies/"+url.PathEscape(slug), &response)
		return galaxyDetailMsg{findings: response.Findings, galaxy: response.Galaxy, err: err}
	}
}

func (m model) fetchMixtapes() tea.Cmd {
	return func() tea.Msg {
		var response struct {
			Mixtapes []mixtape `json:"mixtapes"`
			OK       bool      `json:"ok"`
		}
		err := m.app.getJSON("/api/mixtapes", &response)
		return mixtapesMsg{mixtapes: response.Mixtapes, err: err}
	}
}

func (m model) fetchFooter() tea.Cmd {
	return func() tea.Msg {
		var response struct {
			Tracks []track `json:"tracks"`
		}
		err := m.app.getJSON("/api/tracks?limit=1", &response)
		if err != nil || len(response.Tracks) == 0 {
			return footerMsg{err: err}
		}
		return footerMsg{track: &response.Tracks[0]}
	}
}

func (m model) fetchRandom() tea.Cmd {
	return func() tea.Msg {
		var response struct {
			Track track `json:"track"`
		}
		err := m.app.getJSON("/api/tracks/random", &response)
		return randomMsg{track: response.Track, err: err}
	}
}

// fetchLatestDetail pulls the single newest finding and opens its detail — the
// `latest` deep link. Distinct from fetchLatest (the scrollable list).
func (m model) fetchLatestDetail() tea.Cmd {
	return func() tea.Msg {
		var response struct {
			Tracks []track `json:"tracks"`
		}
		if err := m.app.getJSON("/api/tracks?limit=1", &response); err != nil {
			return detailMsg{err: err}
		}
		if len(response.Tracks) == 0 {
			return detailMsg{err: errors.New("No findings logged yet. Quiet sector tonight.")}
		}
		return detailMsg{track: response.Tracks[0]}
	}
}

// fetchByCoord resolves a Log ID to its finding (or mixtape) detail — the
// `<coord>` deep link. The public endpoint resolves both shapes off one
// coordinate, returning a mixtape for an F-marked ID and a finding otherwise.
func (m model) fetchByCoord(coord string) tea.Cmd {
	return func() tea.Msg {
		var response struct {
			Track   *track   `json:"track"`
			Mixtape *mixtape `json:"mixtape"`
		}
		if err := m.app.getJSON("/api/tracks/"+url.PathEscape(coord), &response); err != nil {
			return detailMsg{err: errors.New("No coordinate reads " + coord + ". " + err.Error())}
		}
		if response.Mixtape != nil {
			return mixtapeDetailMsg{mixtape: *response.Mixtape}
		}
		if response.Track != nil {
			return detailMsg{track: *response.Track}
		}
		return detailMsg{err: errors.New("No coordinate reads " + coord + " in the archive.")}
	}
}

// fetchStatus pulls the public service-health report — the machine-readable
// /api/v1/status payload, read straight off the API (no CLI shim). The terminal
// renders the same already-public fields the /status dashboard shows.
func (m model) fetchStatus() tea.Cmd {
	return func() tea.Msg {
		var report statusReport
		if err := m.app.getJSON("/api/v1/status", &report); err != nil {
			return statusMsg{err: err}
		}
		return statusMsg{report: &report}
	}
}

// liveRefreshInterval re-reads the live-set callout this often so the menu footer
// clears within ~a minute of a set ending, even on a session that never leaves it.
const liveRefreshInterval = 60 * time.Second

// fetchLive reads ONLY the live-set callout off /api/v1/status for the menu footer.
// Best-effort: a failed read carries a nil live (footer shows nothing) and never
// surfaces an error or touches the loading state, so it is safe to run at boot.
func (m model) fetchLive() tea.Cmd {
	return func() tea.Msg {
		var report statusReport
		if err := m.app.getJSON("/api/v1/status", &report); err != nil {
			return liveMsg{live: nil}
		}
		return liveMsg{live: report.Live}
	}
}

// liveTick schedules the next live refresh.
func liveTick() tea.Cmd {
	return tea.Tick(liveRefreshInterval, func(t time.Time) tea.Msg {
		return liveTickMsg(t)
	})
}

func (m model) search(query string) tea.Cmd {
	return func() tea.Msg {
		var response struct {
			Results []searchResult `json:"results"`
		}
		err := m.app.getJSON("/api/search?q="+url.QueryEscape(query), &response)
		return searchMsg{results: response.Results, err: err}
	}
}

type submissionRequest struct {
	Album          string   `json:"album"`
	Artists        []string `json:"artists"`
	ArtworkURL     string   `json:"artworkUrl"`
	Contact        string   `json:"contact"`
	Honeypot       string   `json:"honeypot"`
	Note           string   `json:"note"`
	Source         string   `json:"source"`
	SpotifyTrackID string   `json:"spotifyTrackId"`
	SpotifyURL     string   `json:"spotifyUrl"`
	Title          string   `json:"title"`
}

func (m model) submit() tea.Cmd {
	pending := *m.pending
	body := submissionRequest{
		Album:          pending.Album,
		Artists:        pending.Artists,
		ArtworkURL:     pending.ArtworkURL,
		Contact:        m.contact,
		Honeypot:       "",
		Note:           m.note,
		Source:         "ssh",
		SpotifyTrackID: pending.ID,
		SpotifyURL:     pending.SpotifyURL,
		Title:          pending.Title,
	}
	return func() tea.Msg {
		err := m.app.postJSON("/api/submissions", body, nil)
		return submitMsg{err: err}
	}
}

type newsletterRequest struct {
	Email string `json:"email"`
}

func (m model) subscribe(email string) tea.Cmd {
	body := newsletterRequest{Email: email}
	return func() tea.Msg {
		err := m.app.postJSON("/api/newsletter", body, nil)
		return subscribeMsg{err: err}
	}
}

func (a *app) getJSON(path string, target any) error {
	req, err := http.NewRequest(http.MethodGet, a.cfg.apiURL+path, nil)
	if err != nil {
		return err
	}
	return a.doJSON(req, target)
}

func (a *app) postJSON(path string, body any, target any) error {
	payload, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequest(http.MethodPost, a.cfg.apiURL+path, bytes.NewReader(payload))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	return a.doJSON(req, target)
}

func (a *app) doJSON(req *http.Request, target any) error {
	req.Header.Set("User-Agent", "fluncle-ssh")
	response, err := a.client.Do(req)
	if err != nil {
		return err
	}
	defer response.Body.Close()

	data, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		var failure struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(data, &failure)
		if failure.Message != "" {
			return errors.New(failure.Message)
		}
		return fmt.Errorf("%d %s", response.StatusCode, response.Status)
	}
	if target == nil {
		return nil
	}
	return json.Unmarshal(data, target)
}

type menuItem struct {
	id    string
	label string
}

func menuItems() []menuItem {
	return []menuItem{
		{id: "latest", label: "Latest bangers"},
		{id: "artists", label: "Artist archive"},
		{id: "galaxies", label: "Sonic galaxies"},
		{id: "mixtapes", label: "Mixtape archive"},
		{id: "random", label: "Random banger"},
		{id: "submit", label: "Submit a track"},
		{id: "subscribe", label: "Subscribe"},
		{id: "install", label: "Install CLI"},
		{id: "status", label: "System status"},
		{id: "about", label: "About"},
		{id: "quit", label: "Quit"},
	}
}

func asciiLogo() string {
	return `███████╗██╗     ██╗   ██╗███╗   ██╗ ██████╗██╗     ███████╗
██╔════╝██║     ██║   ██║████╗  ██║██╔════╝██║     ██╔════╝
█████╗  ██║     ██║   ██║██╔██╗ ██║██║     ██║     █████╗
██╔══╝  ██║     ██║   ██║██║╚██╗██║██║     ██║     ██╔══╝
██║     ███████╗╚██████╔╝██║ ╚████║╚██████╗███████╗███████╗
╚═╝     ╚══════╝ ╚═════╝ ╚═╝  ╚═══╝ ╚═════╝╚══════╝╚══════╝`
}

// scaffold renders the shared screen skeleton: gold title, optional Stardust
// subtitle directly beneath, one blank line, content, one blank line, help.
func scaffold(title, subtitle string, content []string, help string) string {
	lines := []string{titleStyle.Render(title)}
	if subtitle != "" {
		lines = append(lines, labelStyle.Render(subtitle))
	}
	lines = append(lines, "")
	lines = append(lines, content...)
	lines = append(lines, "", help)
	return strings.Join(lines, "\n")
}

// helpLine joins key/verb segments with " · " (middle dot) in the rule color.
// Each segment renders its key tokens in Stardust; verbs stay lowercase.
func helpLine(segments ...string) string {
	rendered := make([]string, 0, len(segments))
	for _, segment := range segments {
		rendered = append(rendered, helpStyle.Render(segment))
	}
	return strings.Join(rendered, helpSepStyle.Render(" · "))
}

// coordWidth is the fixed column width of the leading coordinate cell, sized to
// hold a Log ID (e.g. "007.8.1B") with headroom for a two-digit middle segment,
// so the artist column starts at a fixed offset. Tabular feel per DESIGN.md's
// Tabular Rule.
const coordWidth = 9

// trackRow renders the signature row grammar: "COORD  Artist — Title" with a
// muted left-aligned coordinate (the Log ID for findings, "#NN" for search
// candidates), muted artist, rule-color em dash, and a Cream bold title.
func trackRow(coord string, artists []string, title string) string {
	idx := rowIndexStyle.Render(padRight(coord, coordWidth))
	artist := rowArtistStyle.Render(artistLine(artists))
	dash := rowDashStyle.Render(" — ")
	name := rowTitleStyle.Render(title)
	return idx + "  " + artist + dash + name
}

// selectableTrackRow renders a track row, inverting the whole line in gold when
// selected (readability beats per-segment color there). The coord argument is
// the finding's Log ID (or a "#NN" candidate position) already resolved by the
// caller.
func selectableTrackRow(selected bool, coord string, artists []string, title string) string {
	if selected {
		label := fmt.Sprintf("%s  %s — %s", padRight(coord, coordWidth), artistLine(artists), title)
		return selectedStyle.Render("> " + label)
	}
	return "  " + trackRow(coord, artists, title)
}

// padRight left-aligns s in a field of width w (counted in display cells),
// padding with spaces. Coordinates render left-aligned so the artist column
// holds a fixed start, the way a logbook lists its entries.
func padRight(s string, w int) string {
	gap := w - lipgloss.Width(s)
	if gap <= 0 {
		return s
	}
	return s + strings.Repeat(" ", gap)
}

func artistLine(artists []string) string {
	if len(artists) == 0 {
		return "Unknown artist"
	}
	return strings.Join(artists, ", ")
}

func terminalLink(label, url string) string {
	escapedURL := strings.ReplaceAll(url, "\x1b", "")
	escapedLabel := strings.ReplaceAll(label, "\x1b", "")
	return "\x1b]8;;" + escapedURL + "\x1b\\" + escapedLabel + "\x1b]8;;\x1b\\"
}

// logPageURL is a finding's permanent home on the web, derived from its Log ID
// coordinate. Mirrors logPageUrl() on the web (apps/web/src/lib/fluncle-links.ts);
// Log IDs are URL-safe (alphanumerics and dots), so no escaping is needed.
func logPageURL(logID string) string {
	return websiteURL + "/log/" + url.PathEscape(logID)
}

// logQR etches the finding's /log page into a half-block QR — a beam you can
// lift off the recovered terminal and carry back to a real screen. It is a
// physical-layer companion to the OSC-8 "Read the log" hyperlink: the link is
// for a terminal that can click, the QR is for a junglist holding up a phone.
//
// In qrterminal's half-block mode the dark data modules render as bare spaces
// and the light field renders as block glyphs (█/▀/▄). Painting those glyphs in
// muted Stardust ink over the Deep Field leaves a light-on-dark code: the camera
// reads the Stardust field as light and the unpainted Deep Field as the dark
// data, so it scans while staying inside the audio-less, instruments-only
// register. Returns "" if encoding fails, so the card simply omits the beam.
func logQR(targetURL string) string {
	var buf bytes.Buffer
	qrterminal.GenerateWithConfig(targetURL, qrterminal.Config{
		HalfBlocks: true,
		Level:      qr.L,
		QuietZone:  1,
		Writer:     &buf,
	})
	rendered := strings.TrimRight(buf.String(), "\n")
	if rendered == "" {
		return ""
	}
	lines := strings.Split(rendered, "\n")
	for index, line := range lines {
		lines[index] = qrStyle.Render(line)
	}
	return strings.Join(lines, "\n")
}

func dropLastRune(value string) string {
	runes := []rune(value)
	if len(runes) == 0 {
		return ""
	}
	return string(runes[:len(runes)-1])
}

// statusServiceOrder is the fixed display order, mirroring the web /status
// dashboard's SERVICE_ORDER. Known services lead in this sequence; any service
// the report carries that isn't named here is appended (alphabetically), so a
// newly-probed service surfaces without a code change.
var statusServiceOrder = []string{
	"web",
	"db",
	"r2",
	"dns",
	"ssh",
	"onion",
	"hermes",
	"render-box",
}

// statusServiceLabels carries the voice label per known service id (mirrors the
// web dashboard's SERVICE_LABELS), falling back to the raw id for an unknown one.
// `render-box` (the scale-to-zero box's reachability) reads distinctly from the
// `cron.render` row (the render cron's last-run freshness), so the two never read as
// the video-render agent listed twice.
var statusServiceLabels = map[string]string{
	"db":         "Database",
	"dns":        "DNS",
	"hermes":     "Hermes agent",
	"onion":      "Tor onion",
	"r2":         "Media storage",
	"render-box": "Render box",
	"ssh":        "SSH terminal",
	"web":        "Web",
}

// statusServiceSubtitles is the quiet one-line description per service — the
// public domain it lives at, or what it does (mirrors the web dashboard's
// SERVICE_SUBTITLES). Public-safe: every domain here is already public.
var statusServiceSubtitles = map[string]string{
	"dns":        "dig.fluncle.com",
	"hermes":     "the Discord chat agent",
	"onion":      "the archive over Tor",
	"r2":         "found.fluncle.com",
	"render-box": "the scale-to-zero box's reachability",
	"ssh":        "rave.fluncle.com",
	"web":        "www.fluncle.com",
}

func serviceStatusLabel(service string) string {
	if label, ok := statusServiceLabels[service]; ok {
		return label
	}
	return service
}

func serviceStatusSubtitle(service string) string {
	return statusServiceSubtitles[service]
}

// serviceStatusWord is the recovered field's reading of the three-state health
// enum: "operational" / "degraded" / "down" (mirrors the web STATUS_LABEL,
// lowercased for the terminal's quieter telemetry register). An unknown enum
// value falls through verbatim.
func serviceStatusWord(status string) string {
	switch status {
	case "ok":
		return "operational"
	case "degraded":
		return "degraded"
	case "down":
		return "down"
	default:
		return status
	}
}

// statusWordStyle escalates by loudness, mirroring the web dashboard's badge
// mapping (DESIGN.md — The One Sun Rule keeps gold reserved): an ok service
// reads in the calm Stardust label color (healthy is the baseline), degraded in
// Eclipse Glow heat, down in Re-entry Red.
func statusWordStyle(status string) lipgloss.Style {
	switch status {
	case "down":
		return errorStyle
	case "degraded":
		return taglineStyle
	default:
		return labelStyle
	}
}

// humanizeServiceSince reads "up 3d" / "down 12m" / "degraded 5h" — the elapsed
// time since the CURRENT status began, the verb tuned to the status (mirrors the
// web humanizeSince). Whole-unit and terse; a fresh transition reads "just now".
func humanizeServiceSince(sinceISO, nowISO, status string) string {
	verb := "up"
	switch status {
	case "down":
		verb = "down"
	case "degraded":
		verb = "degraded"
	}

	since, sinceErr := time.Parse(time.RFC3339, sinceISO)
	now, nowErr := time.Parse(time.RFC3339, nowISO)
	if sinceErr != nil || nowErr != nil {
		return verb
	}

	elapsed := now.Sub(since)
	if elapsed < time.Minute {
		return verb + " just now"
	}
	if elapsed < time.Hour {
		return fmt.Sprintf("%s %dm", verb, int(elapsed/time.Minute))
	}
	if elapsed < 24*time.Hour {
		return fmt.Sprintf("%s %dh", verb, int(elapsed/time.Hour))
	}
	return fmt.Sprintf("%s %dd", verb, int(elapsed/(24*time.Hour)))
}

// overallStatusHeadline is the board's one-line summary: down beats degraded
// beats all-operational (mirrors the web overallHeadline), in the terminal's
// recovered-instrument register.
func overallStatusHeadline(services []serviceStatus) string {
	hasDown := false
	hasDegraded := false
	for _, service := range services {
		switch service.Status {
		case "down":
			hasDown = true
		case "degraded":
			hasDegraded = true
		}
	}
	if hasDown {
		return "Some services are down"
	}
	if hasDegraded {
		return "Some services are degraded"
	}
	return "All systems nominal"
}

// sortServiceStatuses orders the services by statusServiceOrder; an unknown
// (unranked) service sorts after every ranked one, then alphabetically among
// themselves. Stable mirror of the web dashboard's sortServices.
func sortServiceStatuses(services []serviceStatus) []serviceStatus {
	ordered := append([]serviceStatus{}, services...)
	rank := func(service string) int {
		for index, name := range statusServiceOrder {
			if name == service {
				return index
			}
		}
		return len(statusServiceOrder)
	}
	sort.SliceStable(ordered, func(i, j int) bool {
		ri := rank(ordered[i].Service)
		rj := rank(ordered[j].Service)
		if ri == rj {
			return ordered[i].Service < ordered[j].Service
		}
		return ri < rj
	})
	return ordered
}

// formatDuration renders a millisecond duration as "M:SS", the runtime form a
// logbook would carry. Zero or negative input yields "" so the field drops out.
func formatDuration(ms int) string {
	if ms <= 0 {
		return ""
	}
	totalSeconds := ms / 1000
	minutes := totalSeconds / 60
	seconds := totalSeconds % 60
	return fmt.Sprintf("%d:%02d", minutes, seconds)
}

func formatDate(value string) string {
	timestamp, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return value
	}
	return timestamp.Format("Jan 2, 2006")
}

func relativeTime(value string) string {
	timestamp, err := time.Parse(time.RFC3339, value)
	if err != nil {
		return value
	}
	diff := time.Since(timestamp)
	if diff < time.Minute {
		return "just now"
	}
	if diff < time.Hour {
		minutes := int(diff / time.Minute)
		return pluralize(minutes, "minute") + " ago"
	}
	if diff < 24*time.Hour {
		hours := int(diff / time.Hour)
		return pluralize(hours, "hour") + " ago"
	}
	days := int(diff / (24 * time.Hour))
	if days < 30 {
		return pluralize(days, "day") + " ago"
	}
	return formatDate(value)
}

func pluralize(value int, unit string) string {
	if value == 1 {
		return fmt.Sprintf("%d %s", value, unit)
	}
	return fmt.Sprintf("%d %ss", value, unit)
}

func fallback(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}

func truncateInput(value string, max int) string {
	if len(value) <= max {
		return value
	}
	return value[:max]
}

func wrap(index, length int) int {
	if length <= 0 {
		return 0
	}
	if index < 0 {
		return length - 1
	}
	if index >= length {
		return 0
	}
	return index
}

func clamp(value, min, max int) int {
	if value < min {
		return min
	}
	if value > max {
		return max
	}
	return value
}

func fatal(message string, err error) {
	fmt.Fprintf(os.Stderr, "%s: %v\n", message, err)
	os.Exit(1)
}

// Token hexes from DESIGN.md. ruleColor (#3a342a) is Dust Line over Deep
// Field precomputed without alpha, since terminals have no alpha channel.
const (
	colorEclipseGold    = "#f5b800" // identity, action, focus
	colorEclipseGlow    = "#ffd057" // heat
	colorInkOnGold      = "#151006" // text on gold
	colorDeepField      = "#090a0b" // page background
	colorTapeBlack      = "#171611" // code/input surfaces
	colorStarlightCream = "#f4ead7" // primary reading ink
	colorStardust       = "#b7ab95" // muted ink: labels, captions, artist
	colorReentryRed     = "#ff6b57" // errors
	colorRule           = "#3a342a" // separators, non-focus borders
	colorNebulaViolet   = "#ab7bff" // the live-set callout (DESIGN.md "The Live Exception")
)

var (
	pageStyle = lipgloss.NewStyle().
			Padding(1, 2).
			Foreground(lipgloss.Color(colorStarlightCream)).
			Background(lipgloss.Color(colorDeepField))
	logoStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorEclipseGold)).
			Bold(true)
	// taglineStyle keeps Eclipse Glow as an identity "heat" moment under the plate.
	taglineStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorEclipseGlow)).
			Bold(true)
	// plateStyle is the RAVE TERMINAL nameplate (cover-art territory, gold bold).
	plateStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorEclipseGold)).
			Bold(true)
	titleStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorEclipseGold)).
			Bold(true)
	// readingStyle is primary reading ink (paragraphs, intros, detail content).
	readingStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorStarlightCream))
	// labelStyle is secondary ink: field labels, subtitles, captions, times.
	labelStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorStardust))
	// qrStyle paints the recovered /log QR beam: Stardust block glyphs (the light
	// field) over the Deep Field page (the dark data), a light-on-dark code that
	// still scans. Stardust over Deep Field keeps it in the quiet, instruments-only
	// register, never louder than the gold links above it.
	qrStyle = lipgloss.NewStyle().
		Foreground(lipgloss.Color(colorStardust)).
		Background(lipgloss.Color(colorDeepField))
	// rowIndexStyle and rowArtistStyle are the muted segments of a track row.
	rowIndexStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorStardust))
	rowArtistStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorStardust))
	// rowDashStyle is the em dash separator, rendered in the rule color.
	rowDashStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorRule))
	// rowTitleStyle is the loudest reading text in a row: Cream bold.
	rowTitleStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorStarlightCream)).
			Bold(true)
	menuStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorStarlightCream))
	selectedStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorInkOnGold)).
			Background(lipgloss.Color(colorEclipseGold)).
			Bold(true)
	// helpStyle: key tokens in Stardust; separators are rule color (see helpLine).
	helpStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorStardust))
	helpSepStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorRule))
	errorStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorReentryRed))
	// liveStyle paints the live-set callout in Nebula Violet, the one sanctioned
	// second light, shown only while Fluncle is on the decks (DESIGN.md "The Live
	// Exception").
	liveStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorNebulaViolet)).
			Bold(true)
	// ruleStyle draws horizontal separators in the rule color.
	ruleStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorRule))
	inputStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorStarlightCream)).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(colorEclipseGold)).
			Padding(0, 1)
	// codeStyle keeps the Tape Black surface; border uses the rule color.
	codeStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorStarlightCream)).
			Background(lipgloss.Color(colorTapeBlack)).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(colorRule)).
			Padding(0, 1)
	// codeFocalStyle is for a single focal command box (gold border).
	codeFocalStyle = lipgloss.NewStyle().
			Foreground(lipgloss.Color(colorStarlightCream)).
			Background(lipgloss.Color(colorTapeBlack)).
			Border(lipgloss.RoundedBorder()).
			BorderForeground(lipgloss.Color(colorEclipseGold)).
			Padding(0, 1)
)
