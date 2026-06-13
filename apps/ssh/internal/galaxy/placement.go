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

const (
	epochMS              = int64(1780099200000)
	dayMS                = int64(86400000)
	firstRing            = 620.0
	ringGap              = 240.0
	minArcSpacing        = 700.0
	frontierInner        = 900.0
	slotsPerSystem       = 5
	starsPerBlackhole    = 50
	minStarsForBlackhole = 12
	blackholeHorizon     = 34.0
	blackholeMinStarGap  = 220.0
	asteroidInner        = 1100.0
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

func PlaceStars(tracks []GameTrack) []Star {
	rings := map[int][]placedTrack{}
	for _, track := range tracks {
		sector := sectorOf(track)
		seed := track.LogID
		if seed == "" {
			seed = track.TrackID
		}
		angle := (float64(FNV1a(seed)) / 0xffffffff) * math.Pi * 2
		rings[sector] = append(rings[sector], placedTrack{angle: angle, track: track})
	}

	sectors := make([]int, 0, len(rings))
	for sector := range rings {
		sectors = append(sectors, sector)
	}
	sort.Ints(sectors)

	stars := make([]Star, 0, len(tracks))
	for _, sector := range sectors {
		radius := ringRadius(sector)
		for _, placed := range spreadRing(rings[sector], radius) {
			track := placed.track
			seed := track.LogID
			if seed == "" {
				seed = track.TrackID
			}
			logID := track.LogID
			if logID == "" {
				logID = seed
			}
			stars = append(stars, Star{
				Angle:      placed.angle,
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
				X:          math.Cos(placed.angle) * radius,
				Y:          math.Sin(placed.angle) * radius,
			})
		}
	}
	return stars
}

type placedTrack struct {
	angle float64
	track GameTrack
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

func ringRadius(sector int) float64 {
	return firstRing + float64(sector)*ringGap
}

func spreadRing(ring []placedTrack, radius float64) []placedTrack {
	if len(ring) < 2 {
		return ring
	}

	minGap := math.Min(minArcSpacing/radius, (math.Pi*2)/float64(len(ring)))
	sorted := append([]placedTrack(nil), ring...)
	sort.Slice(sorted, func(i, j int) bool {
		return trackSortKey(sorted[i].track) < trackSortKey(sorted[j].track)
	})
	sort.SliceStable(sorted, func(i, j int) bool {
		return sorted[i].angle < sorted[j].angle
	})

	for pass := 0; pass < 8; pass++ {
		moved := false
		for index := range sorted {
			current := &sorted[index]
			next := &sorted[(index+1)%len(sorted)]
			gap := next.angle - current.angle
			if index+1 == len(sorted) {
				gap = next.angle + math.Pi*2 - current.angle
			}
			if gap < minGap {
				push := (minGap - gap) / 2
				current.angle -= push
				next.angle += push
				moved = true
			}
		}
		if !moved {
			break
		}
	}

	return sorted
}

func trackSortKey(track GameTrack) string {
	if track.LogID != "" {
		return track.LogID
	}
	return track.TrackID
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
	angle := (float64(FNV1a(seedKey)) / 0xffffffff) * math.Pi * 2
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
			angle := (float64(FNV1a(key)) / 0xffffffff) * math.Pi * 2
			reach := float64(FNV1a(key+"#r")%1000) / 1000
			radius := frontierInner + span*(0.3+0.7*reach)
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
		baseAngle := (float64(FNV1a("asteroid:"+strconv.Itoa(wave))) / 0xffffffff) * math.Pi * 2
		baseRadius := asteroidInner + (span*float64(wave+1))/float64(waves+1)
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
