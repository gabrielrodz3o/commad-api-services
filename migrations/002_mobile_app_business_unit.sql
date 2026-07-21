ALTER TABLE human_resource.business_units
  ADD COLUMN IF NOT EXISTS mobile_app_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS mobile_app_slug varchar(80),
  ADD COLUMN IF NOT EXISTS mobile_app_config jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS uq_business_units_mobile_app_slug
  ON human_resource.business_units (lower(mobile_app_slug))
  WHERE mobile_app_slug IS NOT NULL;
