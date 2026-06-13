package galaxy

import (
	"encoding/json"
	"os"
	"testing"
)

type simFixture struct {
	Tracks    []GameTrack   `json:"tracks"`
	Seed      uint32        `json:"seed"`
	Step      float64       `json:"step"`
	Snapshots []simSnapshot `json:"snapshots"`
}

type simSnapshot struct {
	Label          string         `json:"label"`
	Phase          SimPhase       `json:"phase"`
	Time           float64        `json:"time"`
	CollectedCount int            `json:"collectedCount"`
	OrbitIndex     int            `json:"orbitIndex"`
	OrbitFresh     bool           `json:"orbitFresh"`
	AtEarth        bool           `json:"atEarth"`
	Deaths         int            `json:"deaths"`
	Events         []SimEvent     `json:"events"`
	Ship           ShipState      `json:"ship"`
	NearestCarrier *CarrierInfo   `json:"nearestCarrier"`
	RadarBlips     []RadarBlip    `json:"radarBlips"`
	Contacts       []ScopeContact `json:"contacts"`
	Collected      []bool         `json:"collected"`
}

type frontierFixture struct {
	Seed      uint32           `json:"seed"`
	Frontier  FrontierConfig   `json:"frontier"`
	Tracks    []GameTrack      `json:"tracks"`
	Entities  []FrontierEntity `json:"entities"`
	Snapshots []simSnapshot    `json:"snapshots"`
}

func TestStarFlightParityFixture(t *testing.T) {
	fixture := loadSimFixture(t)
	state := CreateSim(PlaceStars(fixture.Tracks), SimOptions{Seed: fixture.Seed})
	snapshots := fixture.Snapshots

	assertSimSnapshot(t, snapshots[0], state)
	stepFrames(&state, 60, SimInput{}, fixture.Step)
	assertSimSnapshot(t, snapshots[1], state)
	stepFrames(&state, 30, SimInput{Boost: true, Steer: 1}, fixture.Step)
	assertSimSnapshot(t, snapshots[2], state)

	state.Ship.X = state.Stars[0].X
	state.Ship.Y = state.Stars[0].Y
	state.Ship.Fuel = 20
	StepSim(&state, SimInput{}, fixture.Step)
	assertSimSnapshot(t, snapshots[3], state)
	DrainEvents(&state)

	stepFrames(&state, 120, SimInput{}, fixture.Step)
	assertSimSnapshot(t, snapshots[4], state)
	DepartOrbit(&state)
	assertSimSnapshot(t, snapshots[5], state)
	ResetSim(&state, false)
	assertSimSnapshot(t, snapshots[6], state)
}

func TestFrontierContactsParityFixture(t *testing.T) {
	fixture := loadFrontierFixture(t)
	state := CreateSim(PlaceStars(fixture.Tracks), SimOptions{Frontier: fixture.Frontier, Seed: fixture.Seed})

	assertEntities(t, state.Entities, fixture.Entities)
	assertScopeSnapshot(t, fixture.Snapshots[0], state)

	blackhole := findEntity(t, state.Entities, "blackhole")
	state.Ship.X = blackhole.X - 120
	state.Ship.Y = blackhole.Y
	state.Ship.Heading = 0
	assertScopeSnapshot(t, fixture.Snapshots[1], state)

	StepSim(&state, SimInput{}, 1.0/60.0)
	assertScopeSnapshot(t, fixture.Snapshots[2], state)

	state.Ship.X = blackhole.X
	state.Ship.Y = blackhole.Y
	StepSim(&state, SimInput{}, 1.0/60.0)
	assertScopeSnapshot(t, fixture.Snapshots[3], state)
	DrainEvents(&state)

	asteroid := findEntity(t, state.Entities, "asteroid")
	state.Ship.X = asteroid.X - 100
	state.Ship.Y = asteroid.Y
	state.Ship.Heading = 0
	assertScopeSnapshot(t, fixture.Snapshots[4], state)
}

func TestAsteroidHitCostsFuelAndClearsRock(t *testing.T) {
	state := CreateSim(PlaceStars([]GameTrack{{
		Artists: []string{"DJ Test"},
		LogID:   "001.1.1A",
		Title:   "Carrier",
		TrackID: "track-1",
	}}), SimOptions{Frontier: FrontierConfig{Asteroids: true}, Seed: 42})
	state.Entities = []FrontierEntity{{
		BodyRadius: 12,
		ID:         "asteroid:test",
		Kind:       "asteroid",
		X:          state.Ship.X,
		Y:          state.Ship.Y,
	}}

	fuel := state.Ship.Fuel
	StepSim(&state, SimInput{}, 1.0/60.0)

	if len(state.Entities) != 0 {
		t.Fatalf("entities len = %d, want asteroid cleared", len(state.Entities))
	}
	expectedFuel := fuel - asteroidFuelCost - state.Config.CruiseBurn/60.0
	if state.Ship.Fuel != expectedFuel {
		t.Fatalf("fuel = %f, want %f", state.Ship.Fuel, expectedFuel)
	}
	assertEvents(t, "asteroid-hit", state.Events, []SimEvent{{Kind: "asteroid-hit"}})
}

func stepFrames(state *SimState, frames int, input SimInput, dt float64) {
	for i := 0; i < frames; i++ {
		StepSim(state, input, dt)
	}
}

func loadSimFixture(t *testing.T) simFixture {
	t.Helper()

	data, err := os.ReadFile("testdata/sim_stars.json")
	if err != nil {
		t.Fatal(err)
	}

	var fixture simFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Snapshots) != 7 {
		t.Fatalf("fixture has %d snapshots, want 7", len(fixture.Snapshots))
	}
	return fixture
}

func loadFrontierFixture(t *testing.T) frontierFixture {
	t.Helper()

	data, err := os.ReadFile("testdata/frontier_contacts.json")
	if err != nil {
		t.Fatal(err)
	}

	var fixture frontierFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Snapshots) != 5 {
		t.Fatalf("frontier fixture has %d snapshots, want 5", len(fixture.Snapshots))
	}
	return fixture
}

func assertSimSnapshot(t *testing.T, expected simSnapshot, actual SimState) {
	t.Helper()

	if actual.Phase != expected.Phase ||
		actual.CollectedCount != expected.CollectedCount ||
		actual.OrbitIndex != expected.OrbitIndex ||
		actual.OrbitFresh != expected.OrbitFresh ||
		actual.AtEarth != expected.AtEarth ||
		actual.Deaths != expected.Deaths {
		t.Fatalf("%s state = %#v, want phase=%s collected=%d orbit=%d fresh=%v earth=%v deaths=%d", expected.Label, actual, expected.Phase, expected.CollectedCount, expected.OrbitIndex, expected.OrbitFresh, expected.AtEarth, expected.Deaths)
	}
	assertClose(t, expected.Label+" time", 0, actual.Time, expected.Time, 1e-12)
	assertShip(t, expected.Label, actual.Ship, expected.Ship)
	assertEvents(t, expected.Label, actual.Events, expected.Events)
	assertCollected(t, expected.Label, actual.Stars, expected.Collected)
	assertNearestCarrier(t, expected.Label, actual, expected.NearestCarrier)
	assertRadarBlips(t, expected.Label, RadarBlips(actual), expected.RadarBlips)
}

func assertShip(t *testing.T, label string, actual, expected ShipState) {
	t.Helper()

	if actual.Boosting != expected.Boosting {
		t.Fatalf("%s ship boosting = %v, want %v", label, actual.Boosting, expected.Boosting)
	}
	assertClose(t, label+" ship.x", 0, actual.X, expected.X, 1e-9)
	assertClose(t, label+" ship.y", 0, actual.Y, expected.Y, 1e-9)
	assertClose(t, label+" ship.heading", 0, actual.Heading, expected.Heading, 1e-12)
	assertClose(t, label+" ship.speed", 0, actual.Speed, expected.Speed, 1e-9)
	assertClose(t, label+" ship.fuel", 0, actual.Fuel, expected.Fuel, 1e-9)
	assertClose(t, label+" ship.vx", 0, actual.VX, expected.VX, 1e-12)
	assertClose(t, label+" ship.vy", 0, actual.VY, expected.VY, 1e-12)
}

func assertEvents(t *testing.T, label string, actual, expected []SimEvent) {
	t.Helper()

	if len(actual) != len(expected) {
		t.Fatalf("%s events len = %d, want %d (%#v)", label, len(actual), len(expected), actual)
	}
	for index := range actual {
		if actual[index] != expected[index] {
			t.Fatalf("%s event[%d] = %#v, want %#v", label, index, actual[index], expected[index])
		}
	}
}

func assertCollected(t *testing.T, label string, stars []Star, expected []bool) {
	t.Helper()

	if len(stars) != len(expected) {
		t.Fatalf("%s collected len = %d, want %d", label, len(stars), len(expected))
	}
	for index, star := range stars {
		if star.Collected != expected[index] {
			t.Fatalf("%s collected[%d] = %v, want %v", label, index, star.Collected, expected[index])
		}
	}
}

func assertNearestCarrier(t *testing.T, label string, state SimState, expected *CarrierInfo) {
	t.Helper()

	actual, ok := NearestCarrier(state)
	if expected == nil {
		if ok {
			t.Fatalf("%s nearest = %#v, want none", label, actual)
		}
		return
	}
	if !ok {
		t.Fatalf("%s nearest = none, want %#v", label, *expected)
	}
	if actual.StarIndex != expected.StarIndex {
		t.Fatalf("%s nearest index = %d, want %d", label, actual.StarIndex, expected.StarIndex)
	}
	assertClose(t, label+" nearest.bearing", 0, actual.Bearing, expected.Bearing, 1e-12)
	assertClose(t, label+" nearest.distance", 0, actual.Distance, expected.Distance, 1e-9)
	assertClose(t, label+" nearest.strength", 0, actual.Strength, expected.Strength, 1e-12)
}

func assertRadarBlips(t *testing.T, label string, actual, expected []RadarBlip) {
	t.Helper()

	if len(actual) != len(expected) {
		t.Fatalf("%s radar len = %d, want %d (%#v)", label, len(actual), len(expected), actual)
	}
	for index := range actual {
		if actual[index].Kind != expected[index].Kind || actual[index].StarIndex != expected[index].StarIndex {
			t.Fatalf("%s radar[%d] = %#v, want %#v", label, index, actual[index], expected[index])
		}
		assertClose(t, label+" radar.bearing", index, actual[index].Bearing, expected[index].Bearing, 1e-12)
		assertClose(t, label+" radar.distance", index, actual[index].Distance, expected[index].Distance, 1e-9)
	}
}

func assertScopeSnapshot(t *testing.T, expected simSnapshot, actual SimState) {
	t.Helper()

	assertShip(t, expected.Label, actual.Ship, expected.Ship)
	assertEvents(t, expected.Label, actual.Events, expected.Events)
	assertScopeContacts(t, expected.Label, ScopeContacts(actual), expected.Contacts)
}

func assertEntities(t *testing.T, actual, expected []FrontierEntity) {
	t.Helper()

	if len(actual) != len(expected) {
		t.Fatalf("entities len = %d, want %d", len(actual), len(expected))
	}
	for index := range actual {
		assertEntity(t, index, actual[index], expected[index])
	}
}

func assertEntity(t *testing.T, index int, actual, expected FrontierEntity) {
	t.Helper()

	if actual.ID != expected.ID || actual.Kind != expected.Kind {
		t.Fatalf("entity[%d] = %#v, want %#v", index, actual, expected)
	}
	assertClose(t, "entity.bodyRadius", index, actual.BodyRadius, expected.BodyRadius, 1e-12)
	assertClose(t, "entity.radius", index, actual.Radius, expected.Radius, 1e-9)
	assertClose(t, "entity.spin", index, actual.Spin, expected.Spin, 1e-12)
	assertClose(t, "entity.vOffset", index, actual.VOffset, expected.VOffset, 1e-12)
	assertClose(t, "entity.vx", index, actual.VX, expected.VX, 1e-12)
	assertClose(t, "entity.vy", index, actual.VY, expected.VY, 1e-12)
	assertClose(t, "entity.x", index, actual.X, expected.X, 1e-9)
	assertClose(t, "entity.y", index, actual.Y, expected.Y, 1e-9)
	if len(actual.Exits) != len(expected.Exits) {
		t.Fatalf("entity[%d] exits len = %d, want %d", index, len(actual.Exits), len(expected.Exits))
	}
	for exitIndex := range actual.Exits {
		assertClose(t, "entity.exit.x", exitIndex, actual.Exits[exitIndex].X, expected.Exits[exitIndex].X, 1e-9)
		assertClose(t, "entity.exit.y", exitIndex, actual.Exits[exitIndex].Y, expected.Exits[exitIndex].Y, 1e-9)
	}
}

func assertScopeContacts(t *testing.T, label string, actual, expected []ScopeContact) {
	t.Helper()

	if len(actual) != len(expected) {
		t.Fatalf("%s contacts len = %d, want %d (%#v)", label, len(actual), len(expected), actual)
	}
	for index := range actual {
		if actual[index].ID != expected[index].ID || actual[index].Kind != expected[index].Kind {
			t.Fatalf("%s contact[%d] = %#v, want %#v", label, index, actual[index], expected[index])
		}
		assertClose(t, label+" contact.bearing", index, actual[index].Bearing, expected[index].Bearing, 1e-12)
		assertClose(t, label+" contact.bodyRadius", index, actual[index].BodyRadius, expected[index].BodyRadius, 1e-12)
		assertClose(t, label+" contact.distance", index, actual[index].Distance, expected[index].Distance, 1e-9)
		assertClose(t, label+" contact.influenceRadius", index, actual[index].InfluenceRadius, expected[index].InfluenceRadius, 1e-12)
	}
}

func findEntity(t *testing.T, entities []FrontierEntity, kind string) FrontierEntity {
	t.Helper()

	for _, entity := range entities {
		if entity.Kind == kind {
			return entity
		}
	}
	t.Fatalf("no %s entity found", kind)
	return FrontierEntity{}
}
