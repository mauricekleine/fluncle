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

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"
	"charm.land/wish/v2"
	"charm.land/wish/v2/activeterm"
	"charm.land/wish/v2/bubbletea"
	"charm.land/wish/v2/logging"
	"github.com/charmbracelet/ssh"
	"github.com/oschwald/maxminddb-golang/v2"
)

const defaultAPIURL = "https://www.fluncle.com"
const spotifyPlaylistURL = "https://open.spotify.com/playlist/1m5LADqpLjiBERdtqrIiL0?si=054d3c6cbcf14a36"
const telegramURL = "https://t.me/fluncle"
const websiteURL = "https://www.fluncle.com"
const xURL = "https://x.com/mauricekleine"
const dbipURL = "https://db-ip.com"

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
	screenMenu         screen = "menu"
	screenLatest       screen = "latest"
	screenDetail       screen = "detail"
	screenSearchInput  screen = "search-input"
	screenSearch       screen = "search"
	screenNoteInput    screen = "note-input"
	screenContactInput screen = "contact-input"
	screenConfirm      screen = "confirm"
	screenInstall      screen = "install"
	screenAbout        screen = "about"
	screenMessage      screen = "message"
)

type model struct {
	app      *app
	width    int
	height   int
	screen   screen
	selected int
	tracks   []track
	total    int
	footer   *track
	results  []searchResult
	current  *track
	pending  *searchResult
	input    string
	note     string
	contact  string
	message  string
	loading  bool
	err      string
}

type track struct {
	TrackID          string   `json:"trackId"`
	SpotifyURL       string   `json:"spotifyUrl"`
	Title            string   `json:"title"`
	Artists          []string `json:"artists"`
	Album            string   `json:"album,omitempty"`
	AlbumImageURL    string   `json:"albumImageUrl,omitempty"`
	Note             string   `json:"note,omitempty"`
	AddedAt          string   `json:"addedAt"`
	AddedToSpotify   bool     `json:"addedToSpotify"`
	PostedToTelegram bool     `json:"postedToTelegram"`
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

type footerMsg struct {
	track *track
	err   error
}

type randomMsg struct {
	track track
	err   error
}

type searchMsg struct {
	results []searchResult
	err     error
}

type submitMsg struct {
	err error
}

func newModel(app *app, width, height int) model {
	return model{
		app:    app,
		width:  width,
		height: height,
		screen: screenMenu,
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
		m.screen = screenDetail
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
		m.message = "Received. Fluncle will give it a listen before it goes live."
		m.screen = screenMessage
	case tea.KeyPressMsg:
		return m.handleKey(msg)
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
	case screenLatest, screenSearch:
		return m.handleListKey(key)
	case screenDetail, screenInstall, screenAbout, screenMessage:
		if key == "q" || key == "esc" || key == "backspace" || key == "b" {
			m.screen = screenMenu
			m.selected = 0
			return m, nil
		}
	case screenSearchInput, screenNoteInput, screenContactInput:
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
		case "random":
			m.loading = true
			m.err = ""
			return m, m.fetchRandom()
		case "submit":
			m.screen = screenSearchInput
			m.input = ""
			m.err = ""
		case "install":
			m.screen = screenInstall
		case "about":
			m.screen = screenAbout
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
		m.current = &m.tracks[m.selected]
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
			m.input = m.input[:len(m.input)-1]
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

func (m model) View() tea.View {
	var content string
	switch m.screen {
	case screenMenu:
		content = m.renderMenu()
	case screenLatest:
		content = m.renderLatest()
	case screenDetail:
		content = m.renderDetail()
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
	case screenInstall:
		content = m.renderInstall()
	case screenAbout:
		content = m.renderAbout()
	case screenMessage:
		content = m.renderMessage()
	}

	view := tea.NewView(pageStyle.Width(clamp(m.width-4, 48, 96)).Render(content))
	view.AltScreen = true
	return view
}

func (m model) renderMenu() string {
	lines := []string{
		logoStyle.Render(asciiLogo()),
		plateStyle.Render("RAVE TERMINAL"),
		taglineStyle.Render("Drum & bass bangers from another dimension"),
		"",
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
	lines = append(lines, "", m.renderFooter())
	return strings.Join(lines, "\n")
}

func (m model) renderFooter() string {
	// Rule width matches the logo block, capped at the available content width.
	rule := ruleStyle.Render(strings.Repeat("─", m.menuRuleWidth()))
	lines := []string{rule, "", labelStyle.Render("Last discovered:")}
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
	ravers := readingStyle.Render(fmt.Sprintf("%d", m.app.connectedRaverCount()))
	raverLine := labelStyle.Render("Connected ravers: ") + ravers
	if countries := m.app.raverCountrySummary(); countries != "" {
		raverLine += labelStyle.Render(" (" + countries + ")")
	}
	lines = append(lines, "", raverLine)
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
		return statusView("Latest bangers", "No bangers discovered yet. Quiet night in this dimension.")
	}

	// Indices count down from the newest: use the API total count when available,
	// otherwise count down from the number of rows we have.
	top := m.total
	if top < len(m.tracks) {
		top = len(m.tracks)
	}
	content := make([]string, 0, len(m.tracks))
	for index, track := range m.tracks {
		number := top - index
		content = append(content, selectableTrackRow(index == m.selected, number, track.Artists, track.Title))
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
		content = append(content, selectableTrackRow(index == m.selected, index+1, result.Artists, result.Title))
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
		"",
		labelStyle.Render("Discovered: ") + readingStyle.Render(formatDate(t.AddedAt)),
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

func (m model) renderInstall() string {
	content := []string{
		readingStyle.Render("Browse the latest bangers, submit tracks, and dig through Fluncle's Finest from your terminal."),
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

func (m model) renderAbout() string {
	wrapWidth := clamp(m.width-4, 48, 96) - 4
	link := func(label, url string) string {
		return labelStyle.Render(label+": ") + readingStyle.Render(terminalLink(url, url))
	}
	content := []string{
		readingStyle.Width(wrapWidth).Render("Fluncle's Finest is a drum & bass collection from another dimension. This is the ecosystem you just ssh'd into."),
		"",
		labelStyle.Render("Bangers reach the archive through:"),
		readingStyle.Render("- Spotify"),
		readingStyle.Render("- Telegram"),
		readingStyle.Render("- Web"),
		readingStyle.Render("- CLI"),
		readingStyle.Render("- Raycast"),
		readingStyle.Render("- SSH, apparently"),
		"",
		readingStyle.Width(wrapWidth).Render("Built by Maurice because drum & bass deserves infrastructure."),
		"",
		labelStyle.Render("Links:"),
		link("Spotify playlist", spotifyPlaylistURL),
		link("Telegram channel", telegramURL),
		link("Website", websiteURL),
		link("DM me on X", xURL),
		link("IP geolocation by DB-IP", dbipURL),
	}
	help := helpLine("q back", "ctrl+c quit")
	return scaffold("About", "", content, help)
}

func (m model) renderMessage() string {
	wrapWidth := clamp(m.width-4, 48, 96) - 4
	content := []string{readingStyle.Width(wrapWidth).Render(m.message)}
	help := helpLine("q back", "ctrl+c quit")
	return scaffold("Received", "", content, help)
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
		{id: "random", label: "Random banger"},
		{id: "submit", label: "Submit a track"},
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

// trackRow renders the signature row grammar: "#NN  Artist — Title" with a
// muted padded index, muted artist, rule-color em dash, and a Cream bold title.
func trackRow(index int, artists []string, title string) string {
	idx := rowIndexStyle.Render(fmt.Sprintf("#%02d", index))
	artist := rowArtistStyle.Render(artistLine(artists))
	dash := rowDashStyle.Render(" — ")
	name := rowTitleStyle.Render(title)
	return idx + "  " + artist + dash + name
}

// selectableTrackRow renders a track row, inverting the whole line in gold when
// selected (readability beats per-segment color there). The index argument is
// the archive/candidate position already resolved by the caller.
func selectableTrackRow(selected bool, index int, artists []string, title string) string {
	if selected {
		label := fmt.Sprintf("#%02d  %s — %s", index, artistLine(artists), title)
		return selectedStyle.Render("> " + label)
	}
	return "  " + trackRow(index, artists, title)
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
