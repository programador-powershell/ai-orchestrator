-- Office e Tune entram no contrato de wire; Game sai do produto.
--
-- A 0002 é imutável (checksum do sqlx::migrate!), então o CHECK é trocado
-- aqui. As linhas de 'game' são removidas ANTES de recriar a constraint:
-- ADD CONSTRAINT valida as linhas existentes, e uma rota órfã de game
-- derrubaria a migração inteira.

DELETE FROM route_configs WHERE mode = 'game';

ALTER TABLE route_configs
  DROP CONSTRAINT IF EXISTS route_configs_mode_check;

ALTER TABLE route_configs
  ADD CONSTRAINT route_configs_mode_check
  CHECK (mode IN ('chat','work','design','data','agent','code','security','office','tune'));
