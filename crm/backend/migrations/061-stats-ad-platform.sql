-- Migration 061: en qué plataforma se vio el anuncio que trajo al cliente (instagram | facebook), sacado del referral del chat.
ALTER TABLE stats_conv_days ADD COLUMN IF NOT EXISTS ad_platform TEXT;
