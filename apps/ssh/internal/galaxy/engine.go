package galaxy

import (
	"math"
	"strconv"
)

const (
	turnRate              = 1.9
	accel                 = 2.2
	cruiseSpeed           = 70.0
	boostSpeed            = 170.0
	orbitSpeed            = 16.0
	tankCapacity          = 100.0
	refuelRate            = 8.5
	boostBurnFactor       = 3.5
	rangeFactor           = 1.8
	minRange              = 3600.0
	starOrbitRadius       = 64.0
	earthOrbitRadius      = 110.0
	adriftSeconds         = 4.0
	lowFuelFraction       = 0.25
	externalDecay         = 1.6
	defaultSeed           = uint32(0x9e3779b9)
	blackholeInfluence    = 260.0
	blackholePull         = 340.0
	slingshotFuelFraction = 0.6
	shipHitRadius         = 10.0
	asteroidFuelCost      = 12.0
)

type SimConfig struct {
	AudioRange       float64
	BoostBurn        float64
	CruiseBurn       float64
	EarthOrbitRadius float64
	RadarRange       float64
	RefuelRate       float64
	StarOrbitRadius  float64
	TankCapacity     float64
}

type SimPhase string

const (
	PhaseAdrift   SimPhase = "adrift"
	PhaseFlying   SimPhase = "flying"
	PhaseHome     SimPhase = "home"
	PhaseOrbiting SimPhase = "orbiting"
)

type SimEvent struct {
	Kind      string `json:"kind"`
	StarIndex int    `json:"starIndex,omitempty"`
}

type ShipState struct {
	Boosting bool
	Fuel     float64
	Heading  float64
	Speed    float64
	VX       float64
	VY       float64
	X        float64
	Y        float64
}

type SimState struct {
	AdriftT        float64
	AtEarth        bool
	CollectedCount int
	Config         SimConfig
	Deaths         int
	Entities       []FrontierEntity
	Events         []SimEvent
	Frontier       FrontierConfig
	LowFuelWarned  bool
	OrbitFresh     bool
	OrbitIndex     int
	Phase          SimPhase
	Seed           uint32
	Ship           ShipState
	Stars          []Star
	Time           float64
}

type SimInput struct {
	Boost bool
	Fire  bool
	Steer float64
}

type SimOptions struct {
	Frontier FrontierConfig
	Seed     uint32
}

type CarrierInfo struct {
	Bearing   float64 `json:"bearing"`
	Distance  float64 `json:"distance"`
	StarIndex int     `json:"starIndex"`
	Strength  float64 `json:"strength"`
}

type RadarBlip struct {
	Bearing   float64 `json:"bearing"`
	Distance  float64 `json:"distance"`
	Kind      string  `json:"kind"`
	StarIndex int     `json:"starIndex"`
}

type ScopeContact struct {
	Bearing         float64 `json:"bearing"`
	BodyRadius      float64 `json:"bodyRadius"`
	Distance        float64 `json:"distance"`
	ID              string  `json:"id"`
	InfluenceRadius float64 `json:"influenceRadius,omitempty"`
	Kind            string  `json:"kind"`
}

func CreateSim(stars []Star, options SimOptions) SimState {
	config := tuneConfig(stars)
	seed := options.Seed
	if seed == 0 {
		seed = defaultSeed
	}
	return SimState{
		Config:     config,
		Entities:   PlaceFrontier(stars, options.Frontier, seed),
		Events:     []SimEvent{},
		Frontier:   options.Frontier,
		OrbitIndex: -1,
		Phase:      PhaseFlying,
		Seed:       seed,
		Ship:       launchShip(config),
		Stars:      stars,
	}
}

func ResetSim(state *SimState, countDeath bool) {
	state.AdriftT = 0
	state.AtEarth = false
	state.CollectedCount = 0
	for index := range state.Stars {
		state.Stars[index].Collected = false
	}
	if countDeath {
		state.Deaths += 1
	}
	state.Entities = PlaceFrontier(state.Stars, state.Frontier, state.Seed)
	state.LowFuelWarned = false
	state.OrbitFresh = false
	state.OrbitIndex = -1
	state.Phase = PhaseFlying
	state.Ship = launchShip(state.Config)
}

func StepSim(state *SimState, input SimInput, dt float64) {
	state.Time += dt
	ship := &state.Ship

	if state.Phase == PhaseAdrift {
		ship.Speed = ease(ship.Speed, 0, dt*0.9)
		ship.X += math.Cos(ship.Heading) * ship.Speed * dt
		ship.Y += math.Sin(ship.Heading) * ship.Speed * dt
		state.AdriftT += dt
		if state.AdriftT >= adriftSeconds {
			state.Events = append(state.Events, SimEvent{Kind: "towed"})
			ResetSim(state, true)
		}
		return
	}

	if state.Phase == PhaseHome {
		ship.Speed = ease(ship.Speed, 0, dt*1.4)
		return
	}

	if state.Phase == PhaseOrbiting {
		ship.Speed = 0
		ship.Boosting = false
		if state.OrbitFresh {
			wasFull := ship.Fuel >= state.Config.TankCapacity
			ship.Fuel = math.Min(state.Config.TankCapacity, ship.Fuel+state.Config.RefuelRate*dt)
			if !wasFull && ship.Fuel >= state.Config.TankCapacity {
				state.Events = append(state.Events, SimEvent{Kind: "refuelled"})
			}
			if ship.Fuel > state.Config.TankCapacity*0.5 {
				state.LowFuelWarned = false
			}
		}
		return
	}

	boosting := input.Boost && ship.Fuel > 0
	ship.Boosting = boosting
	turn := input.Steer * turnRate
	if boosting {
		turn *= 0.75
	}
	ship.Heading += turn * dt

	inOrbit := state.OrbitIndex >= 0 || state.AtEarth
	targetSpeed := cruiseSpeed
	if boosting {
		targetSpeed = boostSpeed
	} else if inOrbit {
		targetSpeed = orbitSpeed
	}

	ship.Speed = ease(ship.Speed, targetSpeed, dt*accel)
	ship.X += (math.Cos(ship.Heading)*ship.Speed + ship.VX) * dt
	ship.Y += (math.Sin(ship.Heading)*ship.Speed + ship.VY) * dt
	ship.VX = ease(ship.VX, 0, dt*externalDecay)
	ship.VY = ease(ship.VY, 0, dt*externalDecay)

	stepEntities(state, dt)
	resolveAsteroidHits(state)
	updateOrbit(state)
	updateFuel(state, boosting, dt)
	updateWin(state)
}

func DepartOrbit(state *SimState) {
	if state.Phase != PhaseOrbiting || state.OrbitIndex < 0 {
		return
	}
	star := state.Stars[state.OrbitIndex]
	ship := &state.Ship
	away := math.Atan2(ship.Y-star.Y, ship.X-star.X)
	heading := ship.Heading + math.Pi
	if !math.IsNaN(away) && !math.IsInf(away, 0) && math.Hypot(ship.X-star.X, ship.Y-star.Y) > 1 {
		heading = away
	}

	ship.Heading = heading
	ship.X = star.X + math.Cos(heading)*(state.Config.StarOrbitRadius+24)
	ship.Y = star.Y + math.Sin(heading)*(state.Config.StarOrbitRadius+24)
	ship.Speed = cruiseSpeed
	state.OrbitFresh = false
	state.OrbitIndex = -1
	state.Phase = PhaseFlying
}

func DrainEvents(state *SimState) []SimEvent {
	events := state.Events
	state.Events = []SimEvent{}
	return events
}

func NearestCarrier(state SimState) (CarrierInfo, bool) {
	best := CarrierInfo{}
	ok := false
	for index, star := range state.Stars {
		if star.Collected {
			continue
		}
		distance := math.Hypot(star.X-state.Ship.X, star.Y-state.Ship.Y)
		if !ok || distance < best.Distance {
			best = CarrierInfo{
				Bearing:   bearingTo(state.Ship, star.X, star.Y),
				Distance:  distance,
				StarIndex: index,
				Strength:  math.Max(0, 1-distance/state.Config.AudioRange),
			}
			ok = true
		}
	}
	return best, ok
}

func RadarBlips(state SimState) []RadarBlip {
	blips := []RadarBlip{}
	done := state.CollectedCount == len(state.Stars)
	if !done {
		for index, star := range state.Stars {
			if star.Collected {
				continue
			}
			distance := math.Hypot(star.X-state.Ship.X, star.Y-state.Ship.Y)
			if distance <= state.Config.RadarRange {
				blips = append(blips, RadarBlip{
					Bearing:   bearingTo(state.Ship, star.X, star.Y),
					Distance:  distance,
					Kind:      "star",
					StarIndex: index,
				})
			}
		}
	}

	earthDistance := math.Hypot(state.Ship.X, state.Ship.Y)
	if done || earthDistance <= state.Config.RadarRange {
		blips = append(blips, RadarBlip{
			Bearing:   bearingTo(state.Ship, 0, 0),
			Distance:  math.Min(earthDistance, state.Config.RadarRange),
			Kind:      "earth",
			StarIndex: -1,
		})
	}
	return blips
}

func ScopeContacts(state SimState) []ScopeContact {
	contacts := []ScopeContact{}
	for _, entity := range state.Entities {
		if entity.Kind != "asteroid" && entity.Kind != "blackhole" {
			continue
		}
		distance := math.Hypot(entity.X-state.Ship.X, entity.Y-state.Ship.Y)
		if distance > state.Config.RadarRange {
			continue
		}
		bodyRadius := entity.BodyRadius
		if bodyRadius == 0 {
			if entity.Kind == "blackhole" {
				bodyRadius = blackholeHorizon
			} else {
				bodyRadius = 16
			}
		}
		contact := ScopeContact{
			Bearing:    bearingTo(state.Ship, entity.X, entity.Y),
			BodyRadius: bodyRadius,
			Distance:   distance,
			ID:         entity.ID,
			Kind:       entity.Kind,
		}
		if entity.Kind == "blackhole" {
			contact.InfluenceRadius = blackholeInfluence
		}
		contacts = append(contacts, contact)
	}
	return contacts
}

func stepEntities(state *SimState, dt float64) {
	if len(state.Entities) == 0 {
		return
	}
	for index := range state.Entities {
		entity := &state.Entities[index]
		entity.X += entity.VX * dt
		entity.Y += entity.VY * dt
		if entity.Kind == "blackhole" {
			stepBlackhole(entity, state, dt)
		}
	}
}

func resolveAsteroidHits(state *SimState) {
	if !state.Frontier.Asteroids {
		return
	}

	entities := state.Entities[:0]
	for _, entity := range state.Entities {
		if entity.Kind != "asteroid" {
			entities = append(entities, entity)
			continue
		}

		bodyRadius := entity.BodyRadius
		if bodyRadius == 0 {
			bodyRadius = 16
		}
		reach := bodyRadius + shipHitRadius
		if math.Hypot(state.Ship.X-entity.X, state.Ship.Y-entity.Y) <= reach {
			state.Ship.Fuel = math.Max(0, state.Ship.Fuel-asteroidFuelCost)
			state.Events = append(state.Events, SimEvent{Kind: "asteroid-hit"})
			continue
		}
		entities = append(entities, entity)
	}
	state.Entities = entities
}

func stepBlackhole(entity *FrontierEntity, state *SimState, dt float64) {
	ship := &state.Ship
	dx := entity.X - ship.X
	dy := entity.Y - ship.Y
	distance := math.Max(1e-6, math.Hypot(dx, dy))
	horizon := entity.BodyRadius
	if horizon == 0 {
		horizon = blackholeHorizon
	}
	if distance <= horizon {
		warpShip(entity, state)
		return
	}
	if distance < blackholeInfluence {
		falloff := 1 - distance/blackholeInfluence
		acceleration := blackholePull * falloff * falloff
		ship.VX += (dx / distance) * acceleration * dt
		ship.VY += (dy / distance) * acceleration * dt
	}
}

func warpShip(entity *FrontierEntity, state *SimState) {
	exits := entity.Exits
	if len(exits) > 0 {
		exit := exits[FNV1a(entity.ID+":"+strconv.FormatUint(uint64(state.Seed), 10))%uint32(len(exits))]
		state.Ship.X = exit.X
		state.Ship.Y = exit.Y
	}
	state.Ship.VX = 0
	state.Ship.VY = 0
	state.Ship.Speed = cruiseSpeed
	state.Ship.Fuel = math.Max(state.Ship.Fuel, state.Config.TankCapacity*slingshotFuelFraction)
	state.Events = append(state.Events, SimEvent{Kind: "warped"})
}

func tuneConfig(stars []Star) SimConfig {
	rangeDistance := math.Max(minRange, FrontierRadius(stars)*rangeFactor)
	cruiseBurn := (cruiseSpeed * tankCapacity) / rangeDistance
	return SimConfig{
		AudioRange:       680,
		BoostBurn:        cruiseBurn * boostBurnFactor,
		CruiseBurn:       cruiseBurn,
		EarthOrbitRadius: earthOrbitRadius,
		RadarRange:       1320,
		RefuelRate:       refuelRate,
		StarOrbitRadius:  starOrbitRadius,
		TankCapacity:     tankCapacity,
	}
}

func FrontierRadius(stars []Star) float64 {
	maxRadius := ringRadius(0)
	for _, star := range stars {
		maxRadius = math.Max(maxRadius, star.Radius)
	}
	return maxRadius
}

func launchShip(config SimConfig) ShipState {
	return ShipState{
		Fuel:    tankCapacity,
		Heading: -math.Pi / 2,
		Speed:   cruiseSpeed,
		X:       0,
		Y:       -(config.EarthOrbitRadius + 30),
	}
}

func updateOrbit(state *SimState) {
	config := state.Config
	ship := state.Ship
	state.AtEarth = math.Hypot(ship.X, ship.Y) <= config.EarthOrbitRadius

	nearestIndex := -1
	nearestDistance := math.Inf(1)
	for index, star := range state.Stars {
		distance := math.Hypot(star.X-ship.X, star.Y-ship.Y)
		if distance <= config.StarOrbitRadius && distance < nearestDistance {
			nearestDistance = distance
			nearestIndex = index
		}
	}
	if nearestIndex < 0 {
		return
	}

	state.OrbitIndex = nearestIndex
	state.OrbitFresh = false
	state.Phase = PhaseOrbiting
	if !state.Stars[nearestIndex].Collected {
		state.Stars[nearestIndex].Collected = true
		state.CollectedCount += 1
		state.OrbitFresh = true
		state.Events = append(state.Events, SimEvent{Kind: "logged", StarIndex: nearestIndex})
		if state.CollectedCount == len(state.Stars) {
			state.Events = append(state.Events, SimEvent{Kind: "all-found"})
		}
	}
}

func updateFuel(state *SimState, boosting bool, dt float64) {
	config := state.Config
	ship := &state.Ship
	if state.AtEarth {
		wasFull := ship.Fuel >= config.TankCapacity
		ship.Fuel = math.Min(config.TankCapacity, ship.Fuel+config.RefuelRate*dt)
		if !wasFull && ship.Fuel >= config.TankCapacity {
			state.Events = append(state.Events, SimEvent{Kind: "refuelled"})
		}
		if ship.Fuel > config.TankCapacity*0.5 {
			state.LowFuelWarned = false
		}
		return
	}

	burn := config.CruiseBurn
	if boosting {
		burn = config.BoostBurn
	}
	ship.Fuel -= burn * dt
	if ship.Fuel <= config.TankCapacity*lowFuelFraction && !state.LowFuelWarned {
		state.LowFuelWarned = true
		state.Events = append(state.Events, SimEvent{Kind: "low-fuel"})
	}
	if ship.Fuel <= 0 {
		ship.Fuel = 0
		state.AdriftT = 0
		state.Phase = PhaseAdrift
		state.Events = append(state.Events, SimEvent{Kind: "adrift"})
	}
}

func updateWin(state *SimState) {
	if state.Phase == PhaseFlying && state.AtEarth && state.CollectedCount == len(state.Stars) {
		state.Phase = PhaseHome
		state.Events = append(state.Events, SimEvent{Kind: "home"})
	}
}

func bearingTo(ship ShipState, x, y float64) float64 {
	absolute := math.Atan2(y-ship.Y, x-ship.X)
	return WrapAngle(absolute - ship.Heading)
}

func WrapAngle(angle float64) float64 {
	wrapped := math.Mod(angle, math.Pi*2)
	if wrapped > math.Pi {
		wrapped -= math.Pi * 2
	}
	if wrapped < -math.Pi {
		wrapped += math.Pi * 2
	}
	return wrapped
}

func ease(current, target, t float64) float64 {
	return current + (target-current)*math.Min(1, t)
}
