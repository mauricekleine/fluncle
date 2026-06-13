package galaxy

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

type placementFixture struct {
	FNV1a   map[string]uint32 `json:"fnv1a"`
	RNG1234 []float64         `json:"rng1234"`
	Tracks  []GameTrack       `json:"tracks"`
	Stars   []Star            `json:"stars"`
}

func TestPlacementParityFixture(t *testing.T) {
	fixture := loadPlacementFixture(t)

	for input, expected := range fixture.FNV1a {
		if actual := FNV1a(input); actual != expected {
			t.Fatalf("FNV1a(%q) = %d, want %d", input, actual, expected)
		}
	}

	rng := MakeRNG(1234)
	for index, expected := range fixture.RNG1234 {
		assertClose(t, "rng", index, rng(), expected, 0)
	}

	actual := PlaceStars(fixture.Tracks)
	if len(actual) != len(fixture.Stars) {
		t.Fatalf("PlaceStars returned %d stars, want %d", len(actual), len(fixture.Stars))
	}

	for index := range actual {
		assertStar(t, index, actual[index], fixture.Stars[index])
	}
}

func loadPlacementFixture(t *testing.T) placementFixture {
	t.Helper()

	data, err := os.ReadFile("testdata/placement.json")
	if err != nil {
		t.Fatal(err)
	}

	var fixture placementFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func assertStar(t *testing.T, index int, actual, expected Star) {
	t.Helper()

	if actual.ID != expected.ID ||
		actual.LogID != expected.LogID ||
		actual.TrackID != expected.TrackID ||
		actual.Title != expected.Title ||
		actual.ArtistLine != expected.ArtistLine ||
		actual.Sector != expected.Sector ||
		actual.Collected != expected.Collected ||
		actual.Kind != expected.Kind ||
		actual.SpotifyURL != expected.SpotifyURL {
		t.Fatalf("star[%d] metadata = %#v, want %#v", index, actual, expected)
	}

	assertClose(t, "angle", index, actual.Angle, expected.Angle, 1e-12)
	assertClose(t, "radius", index, actual.Radius, expected.Radius, 1e-12)
	assertClose(t, "x", index, actual.X, expected.X, 1e-9)
	assertClose(t, "y", index, actual.Y, expected.Y, 1e-9)
	assertClose(t, "vOffset", index, actual.VOffset, expected.VOffset, 0)
}

func assertClose(t *testing.T, field string, index int, actual, expected, tolerance float64) {
	t.Helper()

	if math.Abs(actual-expected) > tolerance {
		t.Fatalf("%s[%d] = %.17g, want %.17g", field, index, actual, expected)
	}
}
