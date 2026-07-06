package galaxy

import (
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
)

// Deterministic star placement from the Log ID: the voyage as ONE traceable
// thread. Earth at the center; findings lay out along a single Archimedean
// spiral winding outward. A finding's day-sector maps to a thread angle (linear
// in the day since the catalogue's first sector), so the radius rises strictly
// with the sector. This mirrors game/placement.ts (the TypeScript authority);
// the parity fixtures in testdata/ pin the two together.

const (
	epochMS              = int64(1780099200000)
	dayMS                = int64(86400000)
	clearSpace           = 620.0
	sectorsPerTurn       = 9.0
	armGap               = 560.0
	minArcSpacing        = 700.0
	frontierInner        = 900.0
	frontierArc          = 1.0
	slotsPerSystem       = 5
	starsPerBlackhole    = 50
	minStarsForBlackhole = 12
	blackholeHorizon     = 34.0
	blackholeMinStarGap  = 220.0
	asteroidInner        = 1100.0
)

var (
	anglePerSector = (math.Pi * 2) / sectorsPerTurn
	spiralPitch    = armGap / (math.Pi * 2)
)

var logIDPattern = regexp.MustCompile(`^(\d+)\.\d\.\d[A-Z]$`)

func FNV1a(value string) uint32 {
	hash := uint32(0x811c9dc5)
	for _, codeUnit := range utf16.Encode([]rune(value)) {
		hash ^= uint32(codeUnit)
		hash *= 0x01000193
	}
	return hash
}

func MakeRNG(seed uint32) func() float64 {
	a := seed
	return func() float64 {
		a += 0x6d2b79f5
		t := (a ^ (a >> 15)) * (1 | a)
		t = (t + ((t ^ (t >> 7)) * (61 | t))) ^ t
		return float64(t^(t>>14)) / 4294967296
	}
}

// spiralRadius is the radius on the thread at a thread angle (Archimedean).
func spiralRadius(theta float64) float64 {
	return clearSpace + spiralPitch*theta
}

// spiralAngleAt is the inverse of spiralRadius: where the arm passes at a radius.
func spiralAngleAt(radius float64) float64 {
	return (radius - clearSpace) / spiralPitch
}

func PlaceStars(tracks []GameTrack) []Star {
	if len(tracks) == 0 {
		return []Star{}
	}

	bySector := map[int][]GameTrack{}
	for _, track := range tracks {
		sector := sectorOf(track)
		bySector[sector] = append(bySector[sector], track)
	}

	sectors := make([]int, 0, len(bySector))
	for sector := range bySector {
		sectors = append(sectors, sector)
	}
	sort.Ints(sectors)
	firstSector := sectors[0]

	stars := make([]Star, 0, len(tracks))
	// The thread head: theta never rewinds. Quiet days show as empty arc (the
	// nominal angle jumps ahead); a heavy day stretches its own allocation
	// forward, pushing the next sector further out — radius strictly monotonic.
	thetaRunning := 0.0

	for _, sector := range sectors {
		group := append([]GameTrack(nil), bySector[sector]...)
		sort.SliceStable(group, func(i, j int) bool {
			return intraDayLess(group[i], group[j])
		})

		thetaNominal := float64(sector-firstSector) * anglePerSector
		theta := math.Max(thetaNominal, thetaRunning)

		for _, track := range group {
			seed := seedOf(track)
			radius := spiralRadius(theta)
			logID := track.LogID
			if logID == "" {
				logID = seed
			}
			stars = append(stars, Star{
				Angle:      theta,
				ArtistLine: strings.Join(track.Artists, ", "),
				Collected:  false,
				ID:         logID,
				Kind:       "star",
				LogID:      logID,
				Radius:     radius,
				Sector:     sector,
				SpotifyURL: track.SpotifyURL,
				Title:      track.Title,
				TrackID:    track.TrackID,
				VOffset:    float64(FNV1a(seed+"#v")%440) - 220,
				VX:         0,
				VY:         0,
				X:          math.Cos(theta) * radius,
				Y:          math.Sin(theta) * radius,
			})

			// Advance along the curve by >= MIN_ARC_SPACING of arc length.
			theta += minArcSpacing / radius
		}

		thetaRunning = theta
	}
	return stars
}

func seedOf(track GameTrack) string {
	if track.LogID != "" {
		return track.LogID
	}
	return track.TrackID
}

// intraDayLess orders same-day findings along their arc: primarily by the
// identity hash, tie-broken by a plain lexicographic compare (mirrors the TS).
func intraDayLess(a, b GameTrack) bool {
	ha := FNV1a(seedOf(a))
	hb := FNV1a(seedOf(b))
	if ha != hb {
		return ha < hb
	}
	return seedOf(a) < seedOf(b)
}

func sectorOf(track GameTrack) int {
	if match := logIDPattern.FindStringSubmatch(track.LogID); match != nil {
		sector, err := strconv.Atoi(match[1])
		if err == nil {
			return sector
		}
	}

	found, err := time.Parse(time.RFC3339, track.AddedAt)
	if err != nil {
		return 0
	}
	days := (found.UnixMilli() - epochMS) / dayMS
	if days < 0 {
		return 0
	}
	return int(days)
}

func PlaceFrontier(stars []Star, config FrontierConfig, seed uint32) []FrontierEntity {
	entities := []FrontierEntity{}
	if config.SetDressing {
		entities = append(entities, placeSetDressing(stars)...)
	}
	if config.BlackHoles {
		entities = append(entities, PlaceBlackHoles(stars, seed)...)
	}
	if config.Asteroids {
		entities = append(entities, PlaceAsteroids(stars)...)
	}
	return entities
}

// frontierAngle rides the emptiest water: a half-turn offset from the local
// thread angle drops debris into the inter-arm valley (farthest from any
// banger), with a hash jitter fanning it along the valley near the thread's tip.
func frontierAngle(radius float64, key string) float64 {
	jitter := ((float64(FNV1a(key))/0xffffffff)*2 - 1) * frontierArc
	return spiralAngleAt(radius) + math.Pi + jitter
}

func placeSetDressing(stars []Star) []FrontierEntity {
	frontier := FrontierRadius(stars)
	if frontier <= frontierInner {
		return []FrontierEntity{}
	}

	span := frontier - frontierInner
	entities := []FrontierEntity{
		makeDressing("roadster", "roadster", frontierInner+span*0.45, 30),
	}
	ufoCount := min(6, int(math.Floor(span/1400)))
	for index := 0; index < ufoCount; index++ {
		fraction := float64(index+1) / float64(ufoCount+1)
		entities = append(entities, makeDressing("ufo", "ufo:"+strconv.Itoa(index), frontierInner+span*(0.5+0.5*fraction), 26))
	}
	return entities
}

func makeDressing(kind, seedKey string, radius, bodyRadius float64) FrontierEntity {
	angle := frontierAngle(radius, seedKey)
	return FrontierEntity{
		BodyRadius: bodyRadius,
		ID:         kind + ":" + seedKey,
		Kind:       kind,
		Radius:     radius,
		Spin:       float64(FNV1a(seedKey+"#spin")%628) / 100,
		VOffset:    float64(FNV1a(seedKey+"#v")%360) - 180,
		VX:         0,
		VY:         0,
		X:          math.Cos(angle) * radius,
		Y:          math.Sin(angle) * radius,
	}
}

func PlaceBlackHoles(stars []Star, seed uint32) []FrontierEntity {
	if len(stars) < minStarsForBlackhole {
		return []FrontierEntity{}
	}

	systems := max(1, len(stars)/starsPerBlackhole)
	frontier := FrontierRadius(stars)
	if frontier <= frontierInner {
		return []FrontierEntity{}
	}

	span := frontier - frontierInner
	rng := MakeRNG(seed ^ 0x5bd1e995)
	entities := []FrontierEntity{}

	for system := 0; system < systems; system++ {
		slots := []Vec2{}
		for attempt := 0; attempt < 200 && len(slots) < slotsPerSystem; attempt++ {
			key := "blackhole:" + strconv.Itoa(system) + ":" + strconv.Itoa(attempt)
			reach := float64(FNV1a(key+"#r")%1000) / 1000
			radius := frontierInner + span*(0.3+0.7*reach)
			angle := frontierAngle(radius, key)
			x := math.Cos(angle) * radius
			y := math.Sin(angle) * radius
			if !tooCloseToStar(x, y, stars, blackholeMinStarGap) {
				slots = append(slots, Vec2{X: x, Y: y})
			}
		}

		if len(slots) < slotsPerSystem {
			continue
		}

		liveIndex := int(math.Floor(rng() * float64(len(slots))))
		live := slots[liveIndex]
		exits := make([]Vec2, 0, len(slots)-1)
		for index, slot := range slots {
			if index != liveIndex {
				exits = append(exits, slot)
			}
		}

		entities = append(entities, FrontierEntity{
			BodyRadius: blackholeHorizon,
			Exits:      exits,
			ID:         "blackhole:" + strconv.Itoa(system),
			Kind:       "blackhole",
			Radius:     math.Hypot(live.X, live.Y),
			VOffset:    0,
			VX:         0,
			VY:         0,
			X:          live.X,
			Y:          live.Y,
		})
	}
	return entities
}

func PlaceAsteroids(stars []Star) []FrontierEntity {
	frontier := FrontierRadius(stars)
	if frontier <= asteroidInner {
		return []FrontierEntity{}
	}

	span := frontier - asteroidInner
	waves := min(5, 1+int(math.Floor(span/1600)))
	entities := []FrontierEntity{}

	for wave := 0; wave < waves; wave++ {
		baseRadius := asteroidInner + (span*float64(wave+1))/float64(waves+1)
		baseAngle := frontierAngle(baseRadius, "asteroid:"+strconv.Itoa(wave))
		count := 3 + int(FNV1a("asteroid:"+strconv.Itoa(wave)+"#n")%4)

		for index := 0; index < count; index++ {
			key := "asteroid:" + strconv.Itoa(wave) + ":" + strconv.Itoa(index)
			angle := baseAngle + (float64(FNV1a(key)%200)/1000 - 0.1)
			radius := baseRadius + (float64(FNV1a(key+"#r")%400) - 200)
			driftAngle := (float64(FNV1a(key+"#d")) / 0xffffffff) * math.Pi * 2
			driftSpeed := 6 + float64(FNV1a(key+"#s")%10)
			entities = append(entities, FrontierEntity{
				BodyRadius: 12 + float64(FNV1a(key+"#b")%10),
				ID:         key,
				Kind:       "asteroid",
				Radius:     radius,
				Spin:       float64(FNV1a(key+"#spin")%628) / 100,
				VOffset:    float64(FNV1a(key+"#v")%300) - 150,
				VX:         math.Cos(driftAngle) * driftSpeed,
				VY:         math.Sin(driftAngle) * driftSpeed,
				X:          math.Cos(angle) * radius,
				Y:          math.Sin(angle) * radius,
			})
		}
	}
	return entities
}

func tooCloseToStar(x, y float64, stars []Star, gap float64) bool {
	for _, star := range stars {
		if math.Hypot(star.X-x, star.Y-y) < gap {
			return true
		}
	}
	return false
}
