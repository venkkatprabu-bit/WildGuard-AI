
CREATE EXTENSION IF NOT EXISTS postgis;

CREATE TABLE IF NOT EXISTS fire_hotspots (
    id BIGSERIAL PRIMARY KEY,

    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,

    acquisition_time TIMESTAMPTZ NOT NULL,

    satellite VARCHAR(50),
    instrument VARCHAR(50),
    confidence VARCHAR(20),
    frp DOUBLE PRECISION,
    brightness DOUBLE PRECISION,

    source VARCHAR(50) DEFAULT 'NASA FIRMS',

    location GEOGRAPHY(POINT, 4326),

    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fire_hotspots_location
ON fire_hotspots USING GIST(location);

CREATE INDEX IF NOT EXISTS idx_fire_hotspots_time
ON fire_hotspots(acquisition_time);



CREATE TABLE IF NOT EXISTS weather_observations (
    id BIGSERIAL PRIMARY KEY,

    latitude DOUBLE PRECISION NOT NULL,
    longitude DOUBLE PRECISION NOT NULL,

    observation_time TIMESTAMPTZ NOT NULL,

    temperature DOUBLE PRECISION,
    humidity DOUBLE PRECISION,

    wind_speed DOUBLE PRECISION,
    wind_direction DOUBLE PRECISION,

    precipitation DOUBLE PRECISION,
    vapour_pressure_deficit DOUBLE PRECISION,

    source VARCHAR(50) DEFAULT 'Open-Meteo',

    location GEOGRAPHY(POINT, 4326),

    created_at TIMESTAMPTZ DEFAULT NOW(),

    UNIQUE(latitude, longitude, observation_time, source)
);

CREATE INDEX IF NOT EXISTS idx_weather_location
ON weather_observations USING GIST(location);

CREATE INDEX IF NOT EXISTS idx_weather_time
ON weather_observations(observation_time);
