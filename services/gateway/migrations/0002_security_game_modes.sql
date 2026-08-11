ALTER TABLE route_configs
  DROP CONSTRAINT IF EXISTS route_configs_mode_check;

ALTER TABLE route_configs
  ADD CONSTRAINT route_configs_mode_check
  CHECK (mode IN ('chat','work','design','data','agent','code','security','game'));
