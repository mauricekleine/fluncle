package galaxy

import "math"

type ProjectionKind string

const (
	ProjectionAsteroid  ProjectionKind = "asteroid"
	ProjectionBlackhole ProjectionKind = "blackhole"
	ProjectionEarth     ProjectionKind = "earth"
	ProjectionShip      ProjectionKind = "ship"
	ProjectionStar      ProjectionKind = "star"
)

type ScopeProjection struct {
	Cells  []ScopeCell
	Width  int
	Height int
}

type ScopeCell struct {
	ID        string
	Kind      ProjectionKind
	StarIndex int
	X         int
	Y         int
}

type ScopeCamera struct {
	X          float64
	Y          float64
	Heading    float64
	CellWidth  float64
	CellHeight float64
}

type ScopeObject struct {
	ID        string
	Kind      ProjectionKind
	StarIndex int
	X         float64
	Y         float64
}

func ProjectScope(state SimState, width, height int) ScopeProjection {
	projection := ScopeProjection{Width: width, Height: height}
	if width < 1 || height < 1 {
		return projection
	}

	centerX := width / 2
	centerY := height / 2
	projection.Cells = append(projection.Cells, ScopeCell{
		Kind:      ProjectionShip,
		StarIndex: -1,
		X:         centerX,
		Y:         centerY,
	})

	for _, blip := range RadarBlips(state) {
		if x, y, ok := projectPolar(blip.Bearing, blip.Distance, state.Config.RadarRange, width, height); ok {
			kind := ProjectionStar
			if blip.Kind == "earth" {
				kind = ProjectionEarth
			}
			projection.Cells = append(projection.Cells, ScopeCell{
				Kind:      kind,
				StarIndex: blip.StarIndex,
				X:         x,
				Y:         y,
			})
		}
	}

	for _, contact := range ScopeContacts(state) {
		if x, y, ok := projectPolar(contact.Bearing, contact.Distance, state.Config.RadarRange, width, height); ok {
			kind := ProjectionAsteroid
			if contact.Kind == "blackhole" {
				kind = ProjectionBlackhole
			}
			projection.Cells = append(projection.Cells, ScopeCell{
				ID:        contact.ID,
				Kind:      kind,
				StarIndex: -1,
				X:         x,
				Y:         y,
			})
		}
	}

	return projection
}

func ProjectWorldScope(camera ScopeCamera, objects []ScopeObject, width, height int) ScopeProjection {
	projection := ScopeProjection{Width: width, Height: height}
	if width < 1 || height < 1 || camera.CellWidth <= 0 || camera.CellHeight <= 0 {
		return projection
	}

	centerX := width / 2
	centerY := height / 2
	for _, object := range objects {
		if x, y, ok := projectWorldObject(camera, object.X, object.Y, centerX, centerY); ok {
			projection.Cells = append(projection.Cells, ScopeCell{
				ID:        object.ID,
				Kind:      object.Kind,
				StarIndex: object.StarIndex,
				X:         x,
				Y:         y,
			})
		}
	}
	return projection
}

func projectPolar(bearing, distance, radarRange float64, width, height int) (int, int, bool) {
	if radarRange <= 0 || width < 1 || height < 1 {
		return 0, 0, false
	}

	centerX := width / 2
	centerY := height / 2
	radiusX := math.Max(1, float64(centerX-1))
	radiusY := math.Max(1, float64(centerY-1))
	rangeFraction := math.Min(1, math.Max(0, distance/radarRange))
	x := centerX + int(math.Round(math.Sin(bearing)*rangeFraction*radiusX))
	y := centerY - int(math.Round(math.Cos(bearing)*rangeFraction*radiusY))
	if x < 0 || x >= width || y < 0 || y >= height {
		return 0, 0, false
	}
	return x, y, true
}

func projectWorldObject(camera ScopeCamera, x, y float64, centerX, centerY int) (int, int, bool) {
	dx := x - camera.X
	dy := y - camera.Y
	rightX := math.Cos(camera.Heading + math.Pi/2)
	rightY := math.Sin(camera.Heading + math.Pi/2)
	forwardX := math.Cos(camera.Heading)
	forwardY := math.Sin(camera.Heading)
	screenX := (dx*rightX + dy*rightY) / camera.CellWidth
	screenY := -(dx*forwardX + dy*forwardY) / camera.CellHeight
	tx := centerX + int(math.Round(screenX))
	ty := centerY + int(math.Round(screenY))
	nx := float64(tx-centerX) / math.Max(1, float64(centerX))
	ny := float64(ty-centerY) / math.Max(1, float64(centerY))
	return tx, ty, math.Hypot(nx, ny) <= 1
}
