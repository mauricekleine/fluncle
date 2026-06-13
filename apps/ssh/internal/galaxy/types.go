package galaxy

type GameTrack struct {
	AddedAt    string   `json:"addedAt"`
	Artists    []string `json:"artists"`
	LogID      string   `json:"logId,omitempty"`
	SpotifyURL string   `json:"spotifyUrl"`
	Title      string   `json:"title"`
	TrackID    string   `json:"trackId"`
}

type Star struct {
	Angle      float64 `json:"angle"`
	ArtistLine string  `json:"artistLine"`
	Collected  bool    `json:"collected"`
	ID         string  `json:"id"`
	Kind       string  `json:"kind"`
	LogID      string  `json:"logId"`
	Radius     float64 `json:"radius"`
	Sector     int     `json:"sector"`
	SpotifyURL string  `json:"spotifyUrl"`
	Title      string  `json:"title"`
	TrackID    string  `json:"trackId"`
	VOffset    float64 `json:"vOffset"`
	VX         float64 `json:"vx"`
	VY         float64 `json:"vy"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
}

type Vec2 struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}

type FrontierEntity struct {
	BodyRadius float64 `json:"bodyRadius,omitempty"`
	Exits      []Vec2  `json:"exits,omitempty"`
	ID         string  `json:"id"`
	Kind       string  `json:"kind"`
	Radius     float64 `json:"radius"`
	SpawnedAt  float64 `json:"spawnedAt,omitempty"`
	Spin       float64 `json:"spin,omitempty"`
	VOffset    float64 `json:"vOffset"`
	VX         float64 `json:"vx"`
	VY         float64 `json:"vy"`
	X          float64 `json:"x"`
	Y          float64 `json:"y"`
}

type FrontierConfig struct {
	Asteroids   bool `json:"asteroids,omitempty"`
	BlackHoles  bool `json:"blackHoles,omitempty"`
	SetDressing bool `json:"setDressing,omitempty"`
}
