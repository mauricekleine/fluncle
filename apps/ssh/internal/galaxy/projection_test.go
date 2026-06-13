package galaxy

import (
	"math"
	"testing"
)

func TestProjectScopeCentersShipAndProjectsKinds(t *testing.T) {
	state := CreateSim(PlaceStars([]GameTrack{{
		Artists: []string{"DJ Test"},
		LogID:   "log-1",
		Title:   "Carrier",
		TrackID: "track-1",
	}}), SimOptions{
		Frontier: FrontierConfig{Asteroids: true, BlackHoles: true},
		Seed:     42,
	})
	state.Config.RadarRange = 1000
	state.Ship.X = 0
	state.Ship.Y = 240
	state.Ship.Heading = -math.Pi / 2
	state.Stars[0].X = 120
	state.Stars[0].Y = 240
	state.Entities = []FrontierEntity{{
		ID:   "asteroid-a",
		Kind: "asteroid",
		X:    160,
		Y:    240,
	}, {
		ID:   "blackhole-a",
		Kind: "blackhole",
		X:    -160,
		Y:    240,
	}}

	projection := ProjectScope(state, 21, 11)
	assertProjectedCell(t, projection, ProjectionShip, "", 10, 5)
	assertProjectedCell(t, projection, ProjectionStar, "", 11, 5)
	assertProjectedCell(t, projection, ProjectionEarth, "", 10, 4)
	assertProjectedCell(t, projection, ProjectionAsteroid, "asteroid-a", 11, 5)
	assertProjectedCell(t, projection, ProjectionBlackhole, "blackhole-a", 9, 5)
}

func TestProjectWorldScopeMatchesTerminalCamera(t *testing.T) {
	camera := ScopeCamera{
		X:          100,
		Y:          200,
		Heading:    0,
		CellWidth:  30,
		CellHeight: 60,
	}
	objects := []ScopeObject{{
		ID:   "front",
		Kind: ProjectionStar,
		X:    100,
		Y:    80,
	}, {
		ID:   "right",
		Kind: ProjectionStar,
		X:    160,
		Y:    200,
	}, {
		ID:   "behind",
		Kind: ProjectionStar,
		X:    100,
		Y:    320,
	}}

	projection := ProjectWorldScope(camera, objects, 21, 11)
	assertProjectedCell(t, projection, ProjectionStar, "front", 6, 5)
	assertProjectedCell(t, projection, ProjectionStar, "right", 10, 4)
	assertProjectedCell(t, projection, ProjectionStar, "behind", 14, 5)
}

func TestProjectWorldScopeRespectsHeadingAndCircularBounds(t *testing.T) {
	camera := ScopeCamera{
		Heading:    math.Pi / 2,
		CellWidth:  10,
		CellHeight: 10,
	}
	objects := []ScopeObject{{
		ID:   "forward",
		Kind: ProjectionStar,
		X:    0,
		Y:    20,
	}, {
		ID:   "outside",
		Kind: ProjectionStar,
		X:    1000,
		Y:    0,
	}}

	projection := ProjectWorldScope(camera, objects, 9, 9)
	assertProjectedCell(t, projection, ProjectionStar, "forward", 4, 2)
	if cell := findProjectedCell(projection, ProjectionStar, "outside"); cell != nil {
		t.Fatalf("outside object projected to %#v, want omitted", *cell)
	}
}

func assertProjectedCell(t *testing.T, projection ScopeProjection, kind ProjectionKind, id string, x, y int) {
	t.Helper()

	cell := findProjectedCell(projection, kind, id)
	if cell == nil {
		t.Fatalf("projection missing kind=%s id=%q in %#v", kind, id, projection.Cells)
	}
	if cell.X != x || cell.Y != y {
		t.Fatalf("projection kind=%s id=%q = (%d,%d), want (%d,%d)", kind, id, cell.X, cell.Y, x, y)
	}
}

func findProjectedCell(projection ScopeProjection, kind ProjectionKind, id string) *ScopeCell {
	for index := range projection.Cells {
		cell := &projection.Cells[index]
		if cell.Kind == kind && cell.ID == id {
			return cell
		}
	}
	return nil
}
