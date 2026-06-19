package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
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

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"charm.land/wish/v2"
	"charm.land/wish/v2/activeterm"
	"charm.land/wish/v2/bubbletea"
	"charm.land/wish/v2/logging"
	sshgalaxy "fluncle/apps/ssh/internal/galaxy"
	"github.com/charmbracelet/ssh"
	"github.com/oschwald/maxminddb-golang/v2"
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
			app.rejectCommandsMiddleware,
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

func (a *app) rejectCommandsMiddleware(next ssh.Handler) ssh.Handler {
	return func(sess ssh.Session) {
		if len(sess.Command()) > 0 {
			_, _ = io.WriteString(sess, "No shell here. Connect without a command: ssh rave.fluncle.com\n")
			return
		}
		next(sess)
	}
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
	model := newModel(a, pty.Window.Width, pty.Window.Height)
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
	screenMixtapes      screen = "mixtapes"
	screenMixtapeDetail screen = "mixtape-detail"
	screenSearchInput   screen = "search-input"
	screenSearch        screen = "search"
	screenNoteInput     screen = "note-input"
	screenContactInput  screen = "contact-input"
	screenConfirm       screen = "confirm"
	screenSubscribe     screen = "subscribe"
	screenSubscribed    screen = "subscribed"
	screenGalaxy        screen = "galaxy"
	screenInstall       screen = "install"
	screenAbout         screen = "about"
	screenMessage       screen = "message"
)

type galaxyTickMsg time.Time

type model struct {
	app            *app
	width          int
	height         int
	screen         screen
	selected       int
	tracks         []track
	mixtapes       []mixtape
	total          int
	footer         *track
	results        []searchResult
	current        *track
	currentMixtape *mixtape
	detailBack     screen
	pending        *searchResult
	input          string
	note           string
	contact        string
	message        string
	galaxy         galaxyState
	loading        bool
	err            string
	scroll         int
}

type galaxyState struct {
	boostUntil     time.Time
	cargoOpen      bool
	cargoRow       int
	input          sshgalaxy.SimInput
	lastTick       time.Time
	logIndex       int
	showLog        bool
	sim            sshgalaxy.SimState
	simAccumulator float64
	status         string
	statusUntil    time.Time
	steer          float64
	steerUntil     time.Time
	tracks         []track
	trail          []galaxyPoint
}

type galaxyPoint struct {
	x float64
	y float64
}

type galaxyCarrier struct {
	id        string
	collected bool
	track     track
	x         float64
	y         float64
}

type galaxyCarrierSignal struct {
	bearing  float64
	carrier  galaxyCarrier
	distance float64
	index    int
	locked   bool
	ok       bool
	strength int
}

type galaxyHazardSignal struct {
	id       string
	kind     sshgalaxy.ProjectionKind
	distance float64
	ok       bool
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

type tracksMsg struct {
	tracks []track
	total  int
	err    error
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

type galaxyTracksMsg struct {
	tracks []track
	err    error
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

func newModel(app *app, width, height int) model {
	return model{
		app:    app,
		width:  width,
		height: height,
		screen: screenMenu,
		galaxy: newGalaxyState(),
	}
}

func (m model) Init() tea.Cmd {
	return m.fetchFooter()
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
	case galaxyTracksMsg:
		if m.screen != screenGalaxy {
			return m, nil
		}
		m.loading = false
		if msg.err != nil {
			m.err = "Receiver fallback: " + msg.err.Error()
			return m, nil
		}
		m.err = ""
		m.galaxy = m.galaxy.withTracks(msg.tracks)
	case searchMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.results = msg.results
		m.selected = 0
		m.screen = screenSearch
	case galaxyTickMsg:
		if m.screen != screenGalaxy {
			return m, nil
		}
		m.galaxy = m.galaxy.step(time.Time(msg))
		return m, galaxyTick()
	case submitMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.message = "Logged. Fluncle will give it a listen before it goes live."
		m.screen = screenMessage
	case subscribeMsg:
		m.loading = false
		if msg.err != nil {
			m.err = msg.err.Error()
			return m, nil
		}
		m.input = ""
		m.screen = screenSubscribed
	case tea.MouseWheelMsg:
		return m.handleWheel(msg)
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
	if m.screen != screenAbout {
		return m, nil
	}
	switch msg.Button {
	case tea.MouseWheelUp:
		m.scroll = clamp(m.scroll-3, 0, m.aboutMaxScroll())
	case tea.MouseWheelDown:
		m.scroll = clamp(m.scroll+3, 0, m.aboutMaxScroll())
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
	case screenLatest, screenSearch, screenMixtapes:
		return m.handleListKey(key)
	case screenGalaxy:
		return m.handleGalaxyKey(key)
	case screenAbout:
		return m.handleAboutKey(key)
	case screenDetail, screenInstall, screenMessage, screenSubscribed, screenMixtapeDetail:
		if key == "q" || key == "esc" || key == "backspace" || key == "b" {
			if (m.screen == screenDetail || m.screen == screenMixtapeDetail) && m.detailBack != "" {
				m.screen = m.detailBack
				m.detailBack = ""
				if m.screen == screenGalaxy {
					return m, galaxyTick()
				}
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
		case "galaxy":
			m.screen = screenGalaxy
			m.galaxy = newGalaxyState()
			m.loading = true
			m.err = ""
			return m, tea.Batch(galaxyTick(), m.fetchGalaxyTracks())
		case "latest":
			m.screen = screenLatest
			m.loading = true
			m.err = ""
			return m, m.fetchLatest()
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
	if m.screen == screenSearch {
		length = len(m.results)
	} else if m.screen == screenMixtapes {
		length = len(m.mixtapes)
	}

	switch key {
	case "q", "esc", "backspace", "b":
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
		text := key
		if len(text) == 1 && text >= " " && text <= "~" {
			m.input += text
		}
	}

	return m, nil
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

func (m model) handleGalaxyKey(key string) (tea.Model, tea.Cmd) {
	now := time.Now()
	if m.galaxy.showLog || m.galaxy.sim.Phase == sshgalaxy.PhaseOrbiting {
		m.galaxy.showLog = false
		sshgalaxy.DepartOrbit(&m.galaxy.sim)
		return m, nil
	}
	if m.galaxy.cargoOpen {
		switch key {
		case "q", "esc", "backspace", "b":
			m.galaxy.cargoOpen = false
		case "tab", "c":
			m.galaxy.cargoOpen = false
		case "up", "k":
			m.galaxy.cargoRow = wrap(m.galaxy.cargoRow-1, len(m.galaxy.recoveredCarriers()))
		case "down", "j":
			m.galaxy.cargoRow = wrap(m.galaxy.cargoRow+1, len(m.galaxy.recoveredCarriers()))
		case "enter":
			carriers := m.galaxy.recoveredCarriers()
			if len(carriers) == 0 {
				return m, nil
			}
			m.galaxy.cargoRow = clamp(m.galaxy.cargoRow, 0, len(carriers)-1)
			track := carriers[m.galaxy.cargoRow].track
			m.current = &track
			m.detailBack = screenGalaxy
			m.screen = screenDetail
		}
		return m, nil
	}

	switch key {
	case "q", "esc", "backspace", "b":
		m.screen = screenMenu
		m.selected = 0
	case "tab", "c":
		m.galaxy.cargoOpen = true
		m.galaxy.cargoRow = clamp(m.galaxy.cargoRow, 0, max(0, len(m.galaxy.recoveredCarriers())-1))
	case "left", "a", "h":
		m.galaxy.steer = -1
		m.galaxy.steerUntil = now.Add(galaxyHoldWindow)
	case "right", "d", "l":
		m.galaxy.steer = 1
		m.galaxy.steerUntil = now.Add(galaxyHoldWindow)
	case "up", "w", "space":
		m.galaxy.boostUntil = now.Add(galaxyHoldWindow)
	case "down", "s":
		m.galaxy.boostUntil = time.Time{}
	case "enter":
		m.galaxy = m.galaxy.logNearestCarrier()
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
	case screenGalaxy:
		content = m.renderGalaxy()
	case screenInstall:
		content = m.renderInstall()
	case screenAbout:
		content = m.renderAbout()
	case screenMessage:
		content = m.renderMessage()
	}

	view := tea.NewView(pageStyle.Width(clamp(m.width-4, 48, 96)).Render(content))
	view.AltScreen = true
	if m.screen == screenGalaxy {
		view.KeyboardEnhancements.ReportEventTypes = true
	}
	// Capture the wheel only on the scrollable About surface, so the app drives
	// the scroll instead of the terminal scrolling its own scrollback (which
	// showed the page repeated). Other screens keep native text selection.
	if m.screen == screenAbout {
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
		lines = []string{rule, found}
	} else {
		lines = []string{rule, "", labelStyle.Render("Last found:")}
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
	if m.current == nil {
		return statusView("Track", "No track selected.")
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
	lines = append(lines, "", helpLine("q back", "ctrl+c quit"))
	return strings.Join(lines, "\n")
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

// mixtapeMeta renders the compact one-line summary for a list row: "N findings
// · 72m". Minutes (not M:SS) because the list is the compact scan; the detail
// carries the precise runtime.
func mixtapeMeta(mx mixtape) string {
	meta := fmt.Sprintf("%d findings", mx.MemberCount)
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
		lines = append(lines, labelStyle.Render("Members: ")+readingStyle.Render(fmt.Sprintf("%d", mx.MemberCount)))
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

	// Listen links. Unlike the galaxy (where the audio didn't survive the trip
	// out here), mixtapes carry their audio — surface every deck that has one.
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

func (m model) renderGalaxy() string {
	if m.height > 0 && m.height < 18 {
		return statusView("Galaxy", "Scope needs more room.")
	}
	if m.galaxy.showLog || m.galaxy.sim.Phase == sshgalaxy.PhaseOrbiting {
		return m.renderGalaxyLog()
	}
	if m.galaxy.cargoOpen {
		return m.renderGalaxyCargo()
	}

	contentWidth := clamp(m.width-4, 48, 96) - 4 // page width minus horizontal padding
	gridWidth := clamp(contentWidth-2, 32, 80)   // scope border adds two cells
	telemetry := m.renderGalaxyTelemetry()
	gridHeight := clamp(m.height-8-lipgloss.Height(telemetry), 8, 22)
	content := []string{
		m.renderGalaxyScope(gridWidth, gridHeight),
		"",
		telemetry,
	}
	help := helpLine("+ carrier", "a/d steer", "w/space boost", "fly to log", "c cargo")
	return scaffold("Galaxy", "Recovered flight log · instruments only", content, help)
}

func (m model) renderGalaxyLog() string {
	index := m.galaxy.logIndex
	if index < 0 {
		index = m.galaxy.sim.OrbitIndex
	}
	carrier, ok := m.galaxy.carrier(index)
	if !ok {
		return scaffold("Galaxy", "Recovered flight log", []string{readingStyle.Render("Carrier logged.")}, helpLine("any key depart"))
	}

	content := m.renderGalaxyCargoDetail(carrier.track)
	if carrier.track.SpotifyURL != "" {
		content = append(content, "", readingStyle.Render(terminalLink("Play back on Earth", carrier.track.SpotifyURL)))
	}
	content = append(content, "", labelStyle.Render("The audio didn't survive the trip out here. It's still playing back on Earth."))
	return scaffold("Galaxy", "Recovered flight log", content, helpLine("any key depart"))
}

func (m model) renderGalaxyCargo() string {
	carriers := m.galaxy.recoveredCarriers()
	if len(carriers) == 0 {
		content := []string{
			readingStyle.Render("Cargo hold empty."),
			labelStyle.Render("Recover a locked carrier from the scope first."),
		}
		help := helpLine("c scope", "q scope", "ctrl+c quit")
		return scaffold("Cargo", "Recovered flight log", content, help)
	}

	row := clamp(m.galaxy.cargoRow, 0, len(carriers)-1)
	visibleRows := clamp(m.height-13, 3, 8)
	start := 0
	if row >= visibleRows {
		start = row - visibleRows + 1
	}
	end := clamp(start+visibleRows, 0, len(carriers))

	content := make([]string, 0, visibleRows+6)
	for index := start; index < end; index++ {
		carrier := carriers[index]
		coord := carrier.id
		if carrier.track.LogID != "" {
			coord = carrier.track.LogID
		}
		content = append(content, selectableTrackRow(index == row, coord, carrier.track.Artists, carrier.track.Title))
	}

	selected := carriers[row]
	content = append(content, "")
	content = append(content, m.renderGalaxyCargoDetail(selected.track)...)

	help := helpLine("↑/↓ j/k move", "enter details", "c scope", "q scope")
	return scaffold("Cargo", "Recovered flight log", content, help)
}

func (m model) renderGalaxyCargoDetail(track track) []string {
	wrapWidth := clamp(m.width-4, 48, 96) - 4
	lines := []string{
		labelStyle.Render("Selected: ") + rowArtistStyle.Render(artistLine(track.Artists)) +
			rowDashStyle.Render(" — ") +
			rowTitleStyle.Render(track.Title),
	}
	if track.LogID != "" {
		lines = append(lines, labelStyle.Render("Coordinate: ")+readingStyle.Render("fluncle://"+track.LogID))
	}
	if track.AddedAt != "" {
		lines = append(lines, labelStyle.Render("Found: ")+readingStyle.Render(formatDate(track.AddedAt)))
	}
	if track.Label != "" {
		lines = append(lines, labelStyle.Render("Pressed by: ")+readingStyle.Render(track.Label))
	}
	if len(track.Tags) > 0 {
		lines = append(lines, labelStyle.Render("Reads as: ")+readingStyle.Width(wrapWidth).Render(strings.Join(track.Tags, ", ")))
	}
	return lines
}

func (m model) renderGalaxyScope(width, height int) string {
	if width < 1 || height < 1 {
		return ""
	}

	centerX := width / 2
	centerY := height / 2
	cells := m.galaxy.projectScopeCells(width, height)
	var lines []string
	for y := 0; y < height; y++ {
		var row strings.Builder
		for x := 0; x < width; x++ {
			nx := float64(x-centerX) / float64(centerX)
			ny := float64(y-centerY) / math.Max(1, float64(centerY))
			radius := math.Hypot(nx, ny)
			if radius > 1 {
				row.WriteByte(' ')
				continue
			}
			if x == centerX && y == centerY {
				row.WriteString(galaxyShipGlyph(m.galaxy.sim.Ship.Heading))
				continue
			}
			if cell, ok := cells[galaxyCellKey(x, y)]; ok {
				row.WriteString(galaxyScopeGlyph(cell))
				continue
			}
			if m.galaxy.trailAt(x, y, centerX, centerY) {
				row.WriteString(labelStyle.Render("."))
				continue
			}
			if ring := galaxyRingGlyph(radius); ring != "" {
				row.WriteString(ring)
				continue
			}
			wx, wy := m.galaxy.scopeWorldAt(x, y, centerX, centerY)
			row.WriteString(galaxySpaceGlyph(wx, wy))
		}
		lines = append(lines, row.String())
	}
	return strings.Join(lines, "\n")
}

func (m model) renderGalaxyTelemetry() string {
	boosting := m.galaxy.sim.Ship.Boosting || time.Now().Before(m.galaxy.boostUntil)
	throttle := "cruise"
	if boosting {
		throttle = "boost"
	}
	if m.galaxy.sim.Phase == sshgalaxy.PhaseAdrift {
		throttle = "adrift"
	}
	steer := "hold"
	if time.Now().Before(m.galaxy.steerUntil) {
		if m.galaxy.steer < 0 {
			steer = "port"
		} else if m.galaxy.steer > 0 {
			steer = "starboard"
		}
	}
	signal := m.galaxy.nearestCarrier()
	carrierLine := labelStyle.Render("Carrier +: ") + readingStyle.Render("none")
	targetLine := ""
	hazardLine := labelStyle.Render("Hazard o/0: ") + readingStyle.Render("none")
	if signal.ok {
		status := fmt.Sprintf("%02d%% · bearing %03.0f°", signal.strength, signal.bearing)
		if signal.locked {
			status = "LOCK"
		}
		carrierLine = labelStyle.Render("Carrier +: ") + readingStyle.Render(signal.carrier.id) + labelStyle.Render(" · "+status)
		targetLine = labelStyle.Render("Target: ") + rowArtistStyle.Render(artistLine(signal.carrier.track.Artists)) +
			rowDashStyle.Render(" — ") +
			rowTitleStyle.Render(signal.carrier.track.Title)
	}
	if hazard := m.galaxy.nearestHazard(); hazard.ok {
		hazardLine = labelStyle.Render("Hazard o/0: ") + readingStyle.Render(hazard.id) + labelStyle.Render(" · "+string(hazard.kind))
	}
	logged, total := m.galaxy.loggedCount()
	lines := []string{
		labelStyle.Render("Heading: ") + readingStyle.Render(fmt.Sprintf("%03.0f°", normalizeDegrees(m.galaxy.sim.Ship.Heading))),
		labelStyle.Render("Speed: ") + readingStyle.Render(fmt.Sprintf("%.1f", m.galaxy.sim.Ship.Speed)) + labelStyle.Render(" · "+throttle+" · "+steer),
		labelStyle.Render("Fuel: ") + readingStyle.Render(fmt.Sprintf("%03.0f%%", m.galaxy.sim.Ship.Fuel)),
		carrierLine,
		hazardLine,
	}
	if targetLine != "" {
		lines = append(lines, targetLine)
	}
	lines = append(lines, labelStyle.Render("Logged: ")+readingStyle.Render(fmt.Sprintf("%d/%d", logged, total)))
	if m.loading {
		lines = append(lines, labelStyle.Render("Receiver: ")+readingStyle.Render("syncing latest bangers"))
	}
	if m.err != "" {
		lines = append(lines, labelStyle.Render("Receiver: ")+readingStyle.Render(m.err))
	}
	lines = append(lines, labelStyle.Render("Coordinate: ")+readingStyle.Render(fmt.Sprintf("x %.0f · y %.0f", m.galaxy.sim.Ship.X, m.galaxy.sim.Ship.Y)))
	if status := m.galaxy.currentStatus(); status != "" {
		lines = append(lines, labelStyle.Render("Status: ")+readingStyle.Render(status))
	}
	return strings.Join(lines, "\n")
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
		readingStyle.Width(wrapWidth).Render("I'm Fluncle. Been digging since '90, only now I do it across the Galaxy — every banger I find gets logged and sent back. This terminal is one of the places it lands."),
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
		readingStyle.Width(wrapWidth).Render("Newsletter: fresh bangers, every Friday, from Fluncle — board it at the site."),
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

func (m model) fetchGalaxyTracks() tea.Cmd {
	return func() tea.Msg {
		tracks := []track{}
		cursor := ""
		for {
			path := "/api/tracks?limit=48"
			if cursor != "" {
				path += "&cursor=" + url.QueryEscape(cursor)
			}
			var response struct {
				Tracks     []track `json:"tracks"`
				NextCursor string  `json:"nextCursor,omitempty"`
			}
			if err := m.app.getJSON(path, &response); err != nil {
				return galaxyTracksMsg{tracks: tracks, err: err}
			}
			tracks = append(tracks, response.Tracks...)
			if response.NextCursor == "" {
				return galaxyTracksMsg{tracks: tracks}
			}
			cursor = response.NextCursor
		}
	}
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

func (m model) submit() tea.Cmd {
	pending := *m.pending
	body := map[string]any{
		"album":          pending.Album,
		"artists":        pending.Artists,
		"artworkUrl":     pending.ArtworkURL,
		"contact":        m.contact,
		"honeypot":       "",
		"note":           m.note,
		"source":         "ssh",
		"spotifyTrackId": pending.ID,
		"spotifyUrl":     pending.SpotifyURL,
		"title":          pending.Title,
	}
	return func() tea.Msg {
		err := m.app.postJSON("/api/submissions", body, nil)
		return submitMsg{err: err}
	}
}

func (m model) subscribe(email string) tea.Cmd {
	body := map[string]any{"email": email}
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
		{id: "galaxy", label: "Enter the Galaxy"},
		{id: "latest", label: "Latest bangers"},
		{id: "mixtapes", label: "Mixtape archive"},
		{id: "random", label: "Random banger"},
		{id: "submit", label: "Submit a track"},
		{id: "subscribe", label: "Subscribe"},
		{id: "install", label: "Install CLI"},
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

const (
	galaxyFrame       = time.Second / 15
	galaxyHoldWindow  = 575 * time.Millisecond
	galaxySimStep     = 1.0 / 60.0
	galaxyTrailLength = 28
)

func newGalaxyState() galaxyState {
	now := time.Now()
	tracks := galaxyFallbackTracks()
	return galaxyState{
		lastTick: now,
		logIndex: -1,
		sim:      createGalaxySim(tracks),
		tracks:   tracks,
	}
}

func (g galaxyState) withTracks(tracks []track) galaxyState {
	if len(tracks) == 0 {
		return g
	}
	if logged, _ := g.loggedCount(); logged > 0 {
		g.status = "receiver synced; keeping current cargo"
		g.statusUntil = time.Now().Add(2 * time.Second)
		return g
	}
	g.sim = createGalaxySim(tracks)
	g.tracks = tracks
	g.cargoOpen = false
	g.cargoRow = 0
	g.logIndex = -1
	g.showLog = false
	g.trail = nil
	g.status = "receiver synced latest bangers"
	g.statusUntil = time.Now().Add(2 * time.Second)
	return g
}

func createGalaxySim(tracks []track) sshgalaxy.SimState {
	return sshgalaxy.CreateSim(sshgalaxy.PlaceStars(galaxyGameTracks(tracks)), sshgalaxy.SimOptions{
		Frontier: sshgalaxy.FrontierConfig{Asteroids: true, BlackHoles: true},
		Seed:     uint32(time.Now().UnixNano()),
	})
}

func galaxyFallbackTracks() []track {
	tracks := make([]track, 0, 8)
	for index := 1; index <= 8; index++ {
		id := fmt.Sprintf("SIM-%02d", index)
		tracks = append(tracks, track{
			TrackID: id,
			LogID:   id,
			Title:   "Recovered carrier",
			Artists: []string{"Fluncle receiver"},
			AddedAt: time.Now().UTC().Format(time.RFC3339),
		})
	}
	return tracks
}

func galaxyGameTracks(tracks []track) []sshgalaxy.GameTrack {
	gameTracks := make([]sshgalaxy.GameTrack, 0, len(tracks))
	for _, track := range tracks {
		gameTracks = append(gameTracks, sshgalaxy.GameTrack{
			AddedAt:    track.AddedAt,
			Artists:    track.Artists,
			LogID:      track.LogID,
			SpotifyURL: track.SpotifyURL,
			Title:      track.Title,
			TrackID:    track.TrackID,
		})
	}
	return gameTracks
}

func galaxyTick() tea.Cmd {
	return tea.Tick(galaxyFrame, func(t time.Time) tea.Msg {
		return galaxyTickMsg(t)
	})
}

func (g galaxyState) step(now time.Time) galaxyState {
	if g.lastTick.IsZero() {
		g.lastTick = now
		return g
	}
	dt := now.Sub(g.lastTick).Seconds()
	if dt < 0 {
		dt = 0
	}
	if dt > 0.2 {
		dt = 0.2
	}
	g.lastTick = now
	g.trail = append(g.trail, galaxyPoint{x: g.sim.Ship.X, y: g.sim.Ship.Y})
	if len(g.trail) > galaxyTrailLength {
		g.trail = g.trail[len(g.trail)-galaxyTrailLength:]
	}

	input := sshgalaxy.SimInput{}
	if now.Before(g.steerUntil) {
		input.Steer = g.steer
	}
	if now.Before(g.boostUntil) {
		input.Boost = true
	}
	g.input = input
	g.simAccumulator += dt
	if g.simAccumulator > 0.25 {
		g.simAccumulator = 0.25
	}
	for g.simAccumulator >= galaxySimStep {
		sshgalaxy.StepSim(&g.sim, input, galaxySimStep)
		g = g.applyGalaxyEvents(sshgalaxy.DrainEvents(&g.sim))
		g.simAccumulator -= galaxySimStep
	}
	return g
}

func (g galaxyState) logNearestCarrier() galaxyState {
	signal := g.nearestCarrier()
	if !signal.ok {
		g.status = "No carrier in scan range."
		g.statusUntil = time.Now().Add(1200 * time.Millisecond)
		return g
	}
	if !signal.locked {
		g.status = fmt.Sprintf("No lock: %s bearing %03.0f.", signal.carrier.id, signal.bearing)
		g.statusUntil = time.Now().Add(1200 * time.Millisecond)
		return g
	}
	g.showLog = true
	g.logIndex = signal.index
	return g
}

func (g galaxyState) applyGalaxyEvents(events []sshgalaxy.SimEvent) galaxyState {
	for _, event := range events {
		switch event.Kind {
		case "logged":
			g.logIndex = event.StarIndex
			g.showLog = true
			g.status = "Logged " + g.carrierID(event.StarIndex) + "."
			g.statusUntil = time.Now().Add(2500 * time.Millisecond)
		case "refuelled":
			g.status = "Tank full."
			g.statusUntil = time.Now().Add(1800 * time.Millisecond)
		case "low-fuel":
			g.status = "Tank low."
			g.statusUntil = time.Now().Add(1800 * time.Millisecond)
		case "adrift":
			g.status = "Tank dry. Adrift."
			g.statusUntil = time.Now().Add(2200 * time.Millisecond)
		case "towed":
			g.status = "Recovered adrift. Towed home."
			g.statusUntil = time.Now().Add(2200 * time.Millisecond)
			g.showLog = false
			g.logIndex = -1
		case "warped":
			g.status = "Pulled under. Flung across the galaxy."
			g.statusUntil = time.Now().Add(2500 * time.Millisecond)
		case "asteroid-hit":
			g.status = "Hull hit. Fuel knocked loose."
			g.statusUntil = time.Now().Add(2200 * time.Millisecond)
		case "all-found":
			g.status = "No carriers left in the sector. Home, junglist."
			g.statusUntil = time.Now().Add(2800 * time.Millisecond)
		case "home":
			g.status = "Earth re-acquired. Welcome back, junglist."
			g.statusUntil = time.Now().Add(2800 * time.Millisecond)
		}
	}
	g.cargoRow = clamp(g.cargoRow, 0, max(0, len(g.recoveredCarriers())-1))
	return g
}

func (g galaxyState) currentStatus() string {
	if g.status == "" || time.Now().After(g.statusUntil) {
		return ""
	}
	return g.status
}

func (g galaxyState) nearestCarrier() galaxyCarrierSignal {
	best := galaxyCarrierSignal{index: -1}
	info, ok := sshgalaxy.NearestCarrier(g.sim)
	if !ok || info.Distance > g.sim.Config.RadarRange {
		return best
	}
	carrier, carrierOK := g.carrier(info.StarIndex)
	if !carrierOK {
		return best
	}
	strength := int(math.Round(math.Max(0, math.Min(1, info.Strength)) * 99))
	locked := info.Distance <= g.sim.Config.StarOrbitRadius || g.sim.Phase == sshgalaxy.PhaseOrbiting
	if locked {
		strength = 100
	}
	return galaxyCarrierSignal{
		bearing:  normalizeDegrees(g.sim.Ship.Heading + info.Bearing),
		carrier:  carrier,
		distance: info.Distance,
		index:    info.StarIndex,
		locked:   locked,
		ok:       true,
		strength: strength,
	}
}

func (g galaxyState) nearestHazard() galaxyHazardSignal {
	best := galaxyHazardSignal{}
	for _, contact := range sshgalaxy.ScopeContacts(g.sim) {
		if !best.ok || contact.Distance < best.distance {
			kind := sshgalaxy.ProjectionAsteroid
			if contact.Kind == "blackhole" {
				kind = sshgalaxy.ProjectionBlackhole
			}
			best = galaxyHazardSignal{
				id:       contact.ID,
				kind:     kind,
				distance: contact.Distance,
				ok:       true,
			}
		}
	}
	return best
}

func (g galaxyState) loggedCount() (int, int) {
	return g.sim.CollectedCount, len(g.sim.Stars)
}

func (g galaxyState) recoveredCarriers() []galaxyCarrier {
	carriers := make([]galaxyCarrier, 0, len(g.sim.Stars))
	for index, star := range g.sim.Stars {
		if !star.Collected {
			continue
		}
		if carrier, ok := g.carrier(index); ok {
			carriers = append(carriers, carrier)
		}
	}
	return carriers
}

func (g galaxyState) carrier(index int) (galaxyCarrier, bool) {
	if index < 0 || index >= len(g.sim.Stars) || index >= len(g.tracks) {
		return galaxyCarrier{}, false
	}
	star := g.sim.Stars[index]
	track := g.tracks[index]
	id := strings.TrimSpace(track.LogID)
	if id == "" {
		id = star.LogID
	}
	return galaxyCarrier{
		id:        id,
		collected: star.Collected,
		track:     track,
		x:         star.X,
		y:         star.Y,
	}, true
}

func (g galaxyState) carrierID(index int) string {
	if carrier, ok := g.carrier(index); ok {
		return "fluncle://" + carrier.id
	}
	return "carrier"
}

func (g galaxyState) projectScopeCells(width, height int) map[string]sshgalaxy.ScopeCell {
	projection := sshgalaxy.ProjectScope(g.sim, width, height)
	cells := make(map[string]sshgalaxy.ScopeCell, len(projection.Cells))
	for _, cell := range projection.Cells {
		if cell.Kind == sshgalaxy.ProjectionShip {
			continue
		}
		cells[galaxyCellKey(cell.X, cell.Y)] = cell
	}
	return cells
}

func (c galaxyCarrier) recoverySummary() string {
	parts := []string{artistLine(c.track.Artists), c.track.Title}
	summary := strings.TrimSpace(strings.Join(nonEmpty(parts), " — "))
	if summary == "" {
		summary = c.id
	}
	if c.track.LogID != "" {
		summary += " · fluncle://" + c.track.LogID
	}
	return summary
}

func (g galaxyState) scopeWorldAt(x, y, centerX, centerY int) (float64, float64) {
	cellWidth, cellHeight := g.scopeCellSize(centerX, centerY)
	dx := float64(x-centerX) * cellWidth
	dy := float64(y-centerY) * cellHeight
	rightX := math.Cos(g.sim.Ship.Heading + math.Pi/2)
	rightY := math.Sin(g.sim.Ship.Heading + math.Pi/2)
	forwardX := math.Cos(g.sim.Ship.Heading)
	forwardY := math.Sin(g.sim.Ship.Heading)
	return g.sim.Ship.X + rightX*dx - forwardX*dy, g.sim.Ship.Y + rightY*dx - forwardY*dy
}

func (g galaxyState) trailAt(x, y, centerX, centerY int) bool {
	for index, point := range g.trail {
		if index%2 != 0 {
			continue
		}
		tx, ty, ok := g.worldToScope(point.x, point.y, centerX, centerY)
		if ok && tx == x && ty == y {
			return true
		}
	}
	return false
}

func (g galaxyState) worldToScope(x, y float64, centerX, centerY int) (int, int, bool) {
	cellWidth, cellHeight := g.scopeCellSize(centerX, centerY)
	dx := x - g.sim.Ship.X
	dy := y - g.sim.Ship.Y
	rightX := math.Cos(g.sim.Ship.Heading + math.Pi/2)
	rightY := math.Sin(g.sim.Ship.Heading + math.Pi/2)
	forwardX := math.Cos(g.sim.Ship.Heading)
	forwardY := math.Sin(g.sim.Ship.Heading)
	screenX := (dx*rightX + dy*rightY) / cellWidth
	screenY := -(dx*forwardX + dy*forwardY) / cellHeight
	tx := centerX + int(math.Round(screenX))
	ty := centerY + int(math.Round(screenY))
	nx := float64(tx-centerX) / math.Max(1, float64(centerX))
	ny := float64(ty-centerY) / math.Max(1, float64(centerY))
	return tx, ty, math.Hypot(nx, ny) <= 1
}

func (g galaxyState) scopeCellSize(centerX, centerY int) (float64, float64) {
	cellWidth := g.sim.Config.RadarRange / math.Max(1, float64(centerX-1))
	cellHeight := g.sim.Config.RadarRange / math.Max(1, float64(centerY-1))
	return cellWidth, cellHeight
}

func galaxyCellKey(x, y int) string {
	return fmt.Sprintf("%d:%d", x, y)
}

func galaxyShipGlyph(heading float64) string {
	return readingStyle.Render("^")
}

func galaxyScopeGlyph(cell sshgalaxy.ScopeCell) string {
	switch cell.Kind {
	case sshgalaxy.ProjectionStar:
		return titleStyle.Render("+")
	case sshgalaxy.ProjectionEarth:
		return readingStyle.Render("E")
	case sshgalaxy.ProjectionBlackhole, sshgalaxy.ProjectionAsteroid:
		return galaxyHazardGlyph(cell.Kind)
	default:
		return labelStyle.Render("x")
	}
}

func galaxyHazardGlyph(kind sshgalaxy.ProjectionKind) string {
	switch kind {
	case sshgalaxy.ProjectionBlackhole:
		return readingStyle.Render("0")
	case sshgalaxy.ProjectionAsteroid:
		return labelStyle.Render("o")
	default:
		return labelStyle.Render("x")
	}
}

func galaxyRingGlyph(radius float64) string {
	for _, ring := range []float64{0.33, 0.66, 0.92} {
		if math.Abs(radius-ring) < 0.018 {
			return ruleStyle.Render(".")
		}
	}
	return ""
}

func galaxySpaceGlyph(x, y float64) string {
	cellX := int(math.Floor(x / 90))
	cellY := int(math.Floor(y / 90))
	hash := uint32(cellX*73856093) ^ uint32(cellY*19349663)
	hash ^= hash >> 13
	hash *= 0x5bd1e995
	if hash%53 == 0 {
		return ruleStyle.Render(".")
	}
	if hash%149 == 0 {
		return labelStyle.Render(".")
	}
	return " "
}

func normalizeDegrees(radians float64) float64 {
	degrees := math.Mod(radians*180/math.Pi+90, 360)
	if degrees < 0 {
		degrees += 360
	}
	return degrees
}

func nonEmpty(values []string) []string {
	filtered := make([]string, 0, len(values))
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" {
			filtered = append(filtered, value)
		}
	}
	return filtered
}

func dropLastRune(value string) string {
	runes := []rune(value)
	if len(runes) == 0 {
		return ""
	}
	return string(runes[:len(runes)-1])
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
