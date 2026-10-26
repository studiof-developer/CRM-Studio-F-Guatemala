-- Migration 059: conversaciones por día ya calculadas para las Estadísticas del Pipeline.
-- Un día cerrado no cambia: se calcula una vez y se lee de aquí. `rules` guarda con qué regla de difusiones se calculó; si la regla cambia, el día se recalcula.
CREATE TABLE IF NOT EXISTS stats_days_done (
  day DATE PRIMARY KEY,
  rules TEXT NOT NULL DEFAULT '',
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stats_conv_days (
  day DATE NOT NULL,
  line INTEGER NOT NULL,
  channel TEXT NOT NULL,
  ref TEXT NOT NULL,
  ad BOOLEAN NOT NULL DEFAULT false,
  broadcast BOOLEAN NOT NULL DEFAULT false,
  is_new BOOLEAN NOT NULL DEFAULT false,
  msgs INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, line, channel, ref)
);

CREATE TABLE IF NOT EXISTS stats_hour_days (
  day DATE NOT NULL,
  line INTEGER NOT NULL,
  hour INTEGER NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, line, hour)
);
